-- NCT Appointment Alerts — Supabase schema
--
-- Run this once in your Supabase project's SQL Editor (see SETUP.md).
--
-- Design notes:
--   * The `subscribers` table has NO row-level-security policies granting
--     anon/authenticated access at all — it's fully locked down.
--   * The public website only ever talks to the three functions below
--     (signup_subscriber, verify_subscriber, unsubscribe_subscriber), which
--     are SECURITY DEFINER and each do exactly one narrow, safe thing. This
--     is what makes it safe to embed the "anon" API key directly in the
--     website's JavaScript — that key literally cannot read or freely edit
--     the table, only call these functions.
--   * The GitHub Actions workflows use the separate SERVICE ROLE key, which
--     bypasses RLS entirely — that key must stay a secret and never appear
--     in the website.

create extension if not exists pgcrypto;

create table if not exists subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  centres text[] not null,
  days_ahead int not null default 28 check (days_ahead between 1 and 90),
  verified boolean not null default false,
  verify_token text not null default encode(gen_random_bytes(16), 'hex'),
  verification_sent boolean not null default false,
  unsubscribe_token text not null default encode(gen_random_bytes(16), 'hex'),
  notified jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Migrate installs from before the switch to day-level windows: the column
-- used to be called weeks_ahead and held a value of 1-12 (meaning weeks).
-- Rename it and convert existing values to their equivalent in days so
-- nobody's existing signup silently changes meaning.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'subscribers' and column_name = 'weeks_ahead'
  ) then
    alter table subscribers rename column weeks_ahead to days_ahead;
    update subscribers set days_ahead = days_ahead * 7 where days_ahead <= 12;
    alter table subscribers alter column days_ahead set default 28;
    alter table subscribers drop constraint if exists subscribers_weeks_ahead_check;
    alter table subscribers add constraint subscribers_days_ahead_check check (days_ahead between 1 and 90);
  end if;
end $$;

create unique index if not exists subscribers_verify_token_idx on subscribers (verify_token);
create unique index if not exists subscribers_unsubscribe_token_idx on subscribers (unsubscribe_token);
create index if not exists subscribers_verified_idx on subscribers (verified);
create index if not exists subscribers_verification_sent_idx on subscribers (verification_sent);

-- ---------------------------------------------------------------------------
-- Groundwork for a future paid tier — added ahead of actually building
-- billing, so the data model doesn't need to change later. Nothing reads or
-- enforces these columns yet; they just sit at 'free' until you wire up
-- Stripe/Paddle/etc. See SETUP.md "Future: paid tiers".
--   plan                - 'free' or 'paid'
--   external_customer_id - the customer/subscription id from whichever
--                          payment provider you eventually pick (Stripe,
--                          Paddle, Lemon Squeezy...) — kept generic on purpose
--   plan_updated_at      - when `plan` last changed, set by your future
--                          payment webhook handler
-- ---------------------------------------------------------------------------
alter table subscribers add column if not exists plan text not null default 'free';
alter table subscribers drop constraint if exists subscribers_plan_check;
alter table subscribers add constraint subscribers_plan_check check (plan in ('free', 'paid'));
alter table subscribers add column if not exists external_customer_id text;
alter table subscribers add column if not exists plan_updated_at timestamptz;
create index if not exists subscribers_plan_idx on subscribers (plan);

-- Optional WhatsApp number, collected at signup so it's on file before any
-- billing exists. Only used by the checker for subscribers on plan='paid' —
-- see SETUP.md "Set up WhatsApp alerts". Expected format: E.164, e.g.
-- +353871234567 (validated loosely below).
alter table subscribers add column if not exists whatsapp_number text;

alter table subscribers enable row level security;
-- Intentionally no policies here — see design notes above.

-- ---------------------------------------------------------------------------
-- signup_subscriber: called by the website when someone submits the form.
-- Drop older versions first: Postgres allows `create or replace` to change a
-- function's body, but not to rename one of its parameters (which is what
-- happened when weeks_ahead became days_ahead) — so the old signature has to
-- go first, the same as the original 3-arg version before it.
-- ---------------------------------------------------------------------------
drop function if exists signup_subscriber(text, text[], int);
drop function if exists signup_subscriber(text, text[], int, text);

create or replace function signup_subscriber(
  p_email text,
  p_centres text[],
  p_days_ahead int,
  p_whatsapp_number text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Please enter a valid email address';
  end if;
  if p_centres is null or array_length(p_centres, 1) is null then
    raise exception 'Please choose at least one test centre';
  end if;
  if p_days_ahead is null or p_days_ahead < 1 or p_days_ahead > 90 then
    raise exception 'days_ahead must be between 1 and 90';
  end if;
  if p_whatsapp_number is not null and p_whatsapp_number !~ '^\+[1-9]\d{6,14}$' then
    raise exception 'WhatsApp number must be in international format, e.g. +353871234567';
  end if;

  -- If this email already has a signup — confirmed or not (e.g. they made a
  -- typo and resubmitted, or a friend forgot they'd already signed up and
  -- filled the form in again) — replace it rather than ending up with two
  -- active rows for the same address, which would double up every
  -- confirmation and availability email they get from here on.
  delete from subscribers where email = lower(p_email);

  insert into subscribers (email, centres, days_ahead, whatsapp_number)
  values (lower(p_email), p_centres, p_days_ahead, p_whatsapp_number);
end;
$$;

revoke all on function signup_subscriber(text, text[], int, text) from public;
grant execute on function signup_subscriber(text, text[], int, text) to anon;

-- ---------------------------------------------------------------------------
-- verify_subscriber: called by verify.html when someone clicks their email link.
-- ---------------------------------------------------------------------------
create or replace function verify_subscriber(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
begin
  update subscribers
  set verified = true
  where verify_token = p_token and verified = false;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function verify_subscriber(text) from public;
grant execute on function verify_subscriber(text) to anon;

-- ---------------------------------------------------------------------------
-- unsubscribe_subscriber: called by unsubscribe.html.
-- ---------------------------------------------------------------------------
create or replace function unsubscribe_subscriber(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
begin
  delete from subscribers where unsubscribe_token = p_token;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function unsubscribe_subscriber(text) from public;
grant execute on function unsubscribe_subscriber(text) to anon;

-- ---------------------------------------------------------------------------
-- get_subscriber_prefs / update_subscriber_prefs: power manage.html, so
-- someone can change their centres/window/WhatsApp number without having to
-- unsubscribe and sign up again. Both are keyed off the same unsubscribe
-- token already in every alert email — same capability-based-security
-- pattern as unsubscribe_subscriber above (the token itself is the secret;
-- nothing else identifies the row). Only ever returns/touches the one row
-- matching that exact token.
-- ---------------------------------------------------------------------------
create or replace function get_subscriber_prefs(p_token text)
returns table(email text, centres text[], days_ahead int, whatsapp_number text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select s.email, s.centres, s.days_ahead, s.whatsapp_number
    from subscribers s
    where s.unsubscribe_token = p_token and s.verified = true;
end;
$$;

revoke all on function get_subscriber_prefs(text) from public;
grant execute on function get_subscriber_prefs(text) to anon;

create or replace function update_subscriber_prefs(
  p_token text,
  p_centres text[],
  p_days_ahead int,
  p_whatsapp_number text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
begin
  if p_centres is null or array_length(p_centres, 1) is null then
    raise exception 'Please choose at least one test centre';
  end if;
  if p_days_ahead is null or p_days_ahead < 1 or p_days_ahead > 90 then
    raise exception 'days_ahead must be between 1 and 90';
  end if;
  if p_whatsapp_number is not null and p_whatsapp_number !~ '^\+[1-9]\d{6,14}$' then
    raise exception 'WhatsApp number must be in international format, e.g. +353871234567';
  end if;

  -- Reset the dedupe state: switching centres/window means old "already
  -- notified" entries no longer mean anything, and it's fine (arguably
  -- good) if they get a fresh email about something already open under
  -- their new choices.
  update subscribers
  set centres = p_centres,
      days_ahead = p_days_ahead,
      whatsapp_number = p_whatsapp_number,
      notified = '{}'::jsonb
  where unsubscribe_token = p_token and verified = true;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function update_subscriber_prefs(text, text[], int, text) from public;
grant execute on function update_subscriber_prefs(text, text[], int, text) to anon;

-- ---------------------------------------------------------------------------
-- get_subscriber_count: powers a small "N people already getting alerts"
-- trust line on the homepage. Aggregate only — no rows, no emails, nothing
-- identifying, so it's safe through the public anon key.
-- ---------------------------------------------------------------------------
create or replace function get_subscriber_count()
returns int
language sql
security definer
set search_path = public
as $$
  select count(*)::int from subscribers where verified = true;
$$;

revoke all on function get_subscriber_count() from public;
grant execute on function get_subscriber_count() to anon;

-- ---------------------------------------------------------------------------
-- availability_log: one row per centre, per hourly check — "did this centre
-- have anything available, and if so, how soon". Powers the stats page.
-- No RLS policies granting anon access, same as subscribers — the public
-- site only ever reads it through the aggregate get_stats() function below,
-- never the raw rows. Written by the checker using the service role key.
--
-- Rough size: ~50 centres x 96 checks/day (checker now runs every 15
-- minutes, not hourly) ~= 4,800 rows/day, still comfortably under Supabase's
-- free-tier database limit for years even before considering pruning.
-- ---------------------------------------------------------------------------
create table if not exists availability_log (
  id bigint generated always as identity primary key,
  checked_at timestamptz not null default now(),
  centre text not null,
  has_availability boolean not null,
  soonest_days int
);

create index if not exists availability_log_checked_at_idx on availability_log (checked_at);
create index if not exists availability_log_centre_idx on availability_log (centre);

alter table availability_log enable row level security;
-- Intentionally no policies here — see design notes above.

-- ---------------------------------------------------------------------------
-- get_stats: aggregates availability_log into what the stats page needs —
-- per-centre "how often is it actually free" and a headline "how often
-- could you get in within a week" figure — in one call. Returns json
-- rather than a table since the shape (a scalar plus a nested per-centre
-- list) doesn't map cleanly to a flat row set.
-- ---------------------------------------------------------------------------
create or replace function get_stats(p_lookback_days int default 30)
returns json
language sql
security definer
set search_path = public
as $$
  with window_rows as (
    select *
    from availability_log
    where checked_at >= now() - (p_lookback_days || ' days')::interval
  ),
  runs as (
    select checked_at, bool_or(has_availability and soonest_days <= 7) as had_short_notice
    from window_rows
    group by checked_at
  ),
  per_centre as (
    select
      centre,
      count(*) as checks,
      count(*) filter (where has_availability) as checks_with_availability,
      round(100.0 * count(*) filter (where has_availability) / count(*), 1) as availability_rate,
      round(avg(soonest_days) filter (where has_availability), 1) as avg_soonest_days
    from window_rows
    group by centre
  )
  select json_build_object(
    'lookback_days', p_lookback_days,
    'total_runs', (select count(*) from runs),
    'tracking_since', (select min(checked_at) from availability_log),
    'short_notice_rate_7d', (
      select round(100.0 * count(*) filter (where had_short_notice) / nullif(count(*), 0), 1)
      from runs
    ),
    'centres', (
      select coalesce(json_agg(row_to_json(per_centre) order by availability_rate desc nulls last), '[]'::json)
      from per_centre
    )
  );
$$;

revoke all on function get_stats(int) from public;
grant execute on function get_stats(int) to anon;

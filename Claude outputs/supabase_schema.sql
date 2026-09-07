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

  -- If this email already has an unconfirmed signup (e.g. they made a typo
  -- and resubmitted), replace it rather than piling up duplicate rows.
  delete from subscribers where email = lower(p_email) and verified = false;

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

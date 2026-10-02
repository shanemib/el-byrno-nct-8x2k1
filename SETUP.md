# Setup guide — NCT Appointment Alerts website

This turns your personal NCT checker into a public website: anyone can sign
up, choose which test centres to watch and how far ahead to look, and get
emailed (or WhatsApped, on a future paid plan) when a matching slot opens
up. The hourly check now scans **every** NCT centre (not just your original
four) and matches results against every confirmed subscriber.

The guide is split in two on purpose:

- **Phase 1** gets the whole thing working end to end for **€0** — just you
  as the only subscriber, testing on your own email (and optionally
  WhatsApp), so you can see it actually work in practice before spending
  anything.
- **Phase 2** is what you do once you're happy with it and ready to open it
  up publicly — which is the point where a domain (the one real cost here)
  and everything that needs it (public email sending, ads, a real WhatsApp
  sender) comes in.

Nothing in Phase 1 commits you to Phase 2 — it's entirely fine to stop
there for as long as you like.

## Phase 1 — try it for free, just for yourself

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and sign up (free).
2. Create a new project (pick any name/region; save the database password
   somewhere safe, though you won't need it again for this).
3. Once it's ready, open the **SQL Editor** and paste in the entire contents
   of `supabase_schema.sql` from this repo, then run it. This creates the
   `subscribers` table and the functions the website uses.
4. Go to **Project Settings → API**. You'll need three values from here:
   - **Project URL** (e.g. `https://abcd1234.supabase.co`)
   - **anon public** key (safe to be public — put it in the website)
   - **service_role** key (⚠️ secret — only goes into GitHub Actions secrets, never the website)

### 2. Set up email sending — Gmail (free, and actually reaches subscribers)

You need something to send the verification and availability-alert emails.
There are two options; use Gmail unless you already have a domain.

**Option A — Gmail (recommended to start):** free, no domain needed, and
unlike Resend's free tier it can actually deliver to *any* subscriber, not
just yourself.

1. Turn on **2-Step Verification** on the Google account you want to send
   from, if it isn't already (Google Account → Security → 2-Step
   Verification) — Gmail won't let you create an App Password without it.
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords),
   sign in again if asked, type a name like "NCT Alerts" and click **Create**.
   Google shows you a 16-character password (four groups of four letters) —
   copy it now, you won't be able to see it again.
3. That's it — no separate "API key" step. You'll add this as
   `GMAIL_APP_PASSWORD` in step 5 below, alongside `GMAIL_USER` (your full
   Gmail address). A plain Gmail account can send roughly 500 emails/day for
   free, which is far more than this project needs unless it gets very big.

**Option B — Resend (skip for now unless you already own a domain):**
Resend's free tier (3,000 emails/month, 100/day) works too, but *without a
verified domain* it will only send from `onboarding@resend.dev` and only
*to the email address you signed up to Resend with* — everyone else's
emails silently never arrive. If you go this route anyway: sign up at
[resend.com](https://resend.com), go to **API Keys**, create one with
"Sending" permission, and save it. See step 10 (Phase 2) for verifying a
domain so it can email real subscribers. If both Gmail and Resend secrets
are set, Gmail is used and Resend is ignored.

### 3. Enable GitHub Pages (default URL is fine for now)

1. In your GitHub repo, go to **Settings → Pages**.
2. Under "Build and deployment", set **Source** to "Deploy from a branch".
3. Set **Branch** to `main` and folder to **/docs**, then save.
4. GitHub will show your site's URL, something like
   `https://yourusername.github.io/el-byrno-nct-8x2k1/`. Copy it (no
   trailing slash) — you'll use this as `SITE_BASE_URL` for now.

### 4. Fill in the website's config

Edit `docs/config.js` in this repo:

```js
window.NCT_CONFIG = {
  SUPABASE_URL: "https://abcd1234.supabase.co",       // your Project URL
  SUPABASE_ANON_KEY: "eyJhbGciOi...",                  // your anon public key
};
```

Leave `ADSENSE_CLIENT_ID` / `ADSENSE_SLOT_ID` blank — that's Phase 2.
Commit and push this change.

### 5. Set repository variables and secrets

In your GitHub repo, go to **Settings → Secrets and variables → Actions**.

**Variables tab** — add one:

| Name | Value |
|---|---|
| `SITE_BASE_URL` | Your GitHub Pages URL from step 3, no trailing slash |

**Secrets tab** — add these (skip the Twilio ones for now, they're optional even in Phase 1):

| Name | Value |
|---|---|
| `NCT_REG` | Your vehicle registration, e.g. `191D12345` (already set) |
| `SUPABASE_URL` | Same Project URL as above |
| `SUPABASE_SERVICE_ROLE_KEY` | The **service_role** key (not the anon key!) |
| `GMAIL_USER` | Your full Gmail address, e.g. `you@gmail.com` |
| `GMAIL_APP_PASSWORD` | The 16-character App Password from step 2 |
| `RESEND_API_KEY` | *(only if using Resend instead — see step 2, Option B)* |
| `RESEND_FROM` | *(only if using Resend instead)* `NCT Alerts <onboarding@resend.dev>` |

### 6. First run: populate the centre list

The website's centre checklist comes from `docs/centres.json`, which starts
empty — the checker fills it in from the live site the first time it runs.

1. Go to **Actions → NCT Appointment Check → Run workflow** to trigger it
   manually.
2. Once it finishes, check that `docs/centres.json` in your repo now lists
   real centre names (the workflow auto-commits it if it changed).
3. Visit your website — the centre checklist should now be populated.

If this step fails, check the workflow's logs first — the existing
selectors were working before, so a failure here most likely means the
NCTS site's markup changed slightly, or GitHub's IP got rate-limited. Re-run
with `HEADLESS=false` locally on your own machine to debug, same as before.

### 7. Test the whole flow — on yourself

If you're using Gmail (Option A above), sign up with any email address you
can check — Gmail will actually deliver to it. If you went with Resend
without a verified domain instead, you must sign up using the *exact same
email address* you used to create your Resend account, since it will
silently refuse to deliver to anyone else.

1. Sign up on your website with that email.
2. Within ~10 minutes, the **Process New Signups** workflow should email you
   a confirmation link (it runs every 10 minutes).
3. Click it — `verify.html` should say you're confirmed.
4. Wait for the next hourly run (or trigger **NCT Appointment Check**
   manually) — if any of your chosen centres have availability in your
   chosen window, you'll get an email.
5. Try the unsubscribe link in that email to confirm it removes you.

### 8. (Optional) Test WhatsApp too — also free

The Twilio Sandbox lets you test the WhatsApp path without paying anything
or waiting on Meta's business verification.

1. Go to [twilio.com](https://www.twilio.com), create a free account, and
   note your **Account SID** and **Auth Token**.
2. Under Messaging → **Try it out → Send a WhatsApp message**, join the
   sandbox from your own phone by sending the join code shown there to the
   sandbox's WhatsApp number. This step is only needed in sandbox mode —
   it's how Twilio limits the free sandbox to numbers that opted in.
3. Under **Content Template Builder**, create a template with a single body
   variable (just `{{1}}` as the whole body — the real text is filled in by
   `whatsapp_utils.py`). Submit for approval — usually under a day.
   Copy its **Content SID** (`HX...`) once approved.
4. Add these secrets: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `TWILIO_WHATSAPP_FROM` (`whatsapp:+14155238886` for the sandbox),
   `TWILIO_CONTENT_SID`.
5. In Supabase's SQL Editor, flip yourself to paid and add your WhatsApp
   number so the checker actually messages you:
   ```sql
   update subscribers
   set plan = 'paid', whatsapp_number = '+353871234567', plan_updated_at = now()
   where email = 'you@example.com';
   ```
6. Trigger the checker again — if you have a matching slot, you should get
   both the email and a WhatsApp message.

At this point you have the entire system — signup, verification, hourly
checking across every centre, email alerts, and WhatsApp alerts — running
and provably working, for €0. Everything below is only for when you decide
to open this up beyond yourself.

---

## Phase 2 — going public (this is where cost starts)

### 9. Buy a domain

This is the one real recurring cost in the whole project (~€8–15/year from
Namecheap, Cloudflare Registrar, or similar). If you're already sending via
Gmail, you don't strictly need a domain for email anymore — this step is
now mainly about the site's own address instead of a raw `github.io` URL,
which reads more trustworthy to visitors and matters for AdSense approval.

### 10. (Optional) Verify a domain with Resend instead of Gmail

Skip this if Gmail is working fine — a plain Gmail account's ~500/day limit
covers a large number of subscribers already. Only bother with this if you'd
rather send from your own branded address (e.g. `alerts@yourdomain.com`) or
expect to outgrow Gmail's daily limit:

1. In Resend, go to **Domains → Add Domain**, enter your domain, and add the
   DNS records it shows you at your registrar (usually 2–3 TXT/MX/CNAME
   records). Verification can take a few minutes to a few hours.
2. Decide on a sender address at your domain, e.g. `alerts@yourdomain.com`
   (no inbox needed there — Resend just sends *from* it).
3. Update the `RESEND_FROM` secret to use it, e.g.
   `NCT Alerts <alerts@yourdomain.com>`, and **remove the `GMAIL_USER` /
   `GMAIL_APP_PASSWORD` secrets** (Gmail is preferred whenever both are set,
   so Resend won't be used until you do). From this point on, Resend can
   email anyone who signs up.

### 11. Point your custom domain at GitHub Pages

1. **Settings → Pages → Custom domain**, enter your domain (e.g.
   `ncttracker.ie` or a subdomain like `alerts.yourdomain.com`) and save.
   GitHub will show "DNS check unsuccessful" until you add:
   - Apex domain (`yourdomain.com`): four **A** records to GitHub's IPs
     (`185.199.108.153`, `.109.153`, `.110.153`, `.111.153`).
   - Subdomain (`alerts.yourdomain.com`): one **CNAME** to
     `yourusername.github.io`.
2. Once the DNS check passes, tick **Enforce HTTPS**.
3. Update the `SITE_BASE_URL` repo variable to `https://yourdomain.com` (or
   your subdomain), no trailing slash.

### 12. Set up ads

The site is already wired for AdSense — it just won't show anything until
you fill in your details, so there's no broken ad box in the meantime.

1. Go to [adsense.google.com](https://adsense.google.com) and sign up with
   your domain.
2. Google will ask you to verify site ownership — usually one more TXT
   record, or it can detect the AdSense script once added (step 4 below).
3. **Approval isn't guaranteed or fast.** It can take a day to a few weeks,
   and a very small, single-purpose utility site sometimes gets rejected
   the first time (the "How it works" / FAQ section already on the
   homepage helps, but don't be surprised if you need more content or
   another attempt).
4. Once approved, go to **Ads → By ad unit**, create a display ad unit, and
   note your **publisher ID** (`ca-pub-...`) and the unit's **slot ID**.
5. Fill both into `docs/config.js`:
   ```js
   ADSENSE_CLIENT_ID: "ca-pub-1234567890123456",
   ADSENSE_SLOT_ID: "1234567890",
   ```
6. Replace the placeholder line in `docs/ads.txt` with the real one from
   **Sites → yourdomain.com → View ads.txt**.
7. In your AdSense account, find **Privacy & messaging** and enable an EEA
   consent message — this is what actually shows Irish/EU visitors the
   GDPR cookie-consent banner before personalized ads load. It's a
   dashboard toggle, not something the ad script does automatically, so
   it's easy to miss.
8. Commit and push the `config.js` and `ads.txt` changes.

### 13. Move WhatsApp from sandbox to production

Once you're ready to message people who haven't manually joined a sandbox:

1. Apply for your own WhatsApp Business sender under **Messaging →
   Senders** — this requires Meta Business verification, which can take a
   few days.
2. Update `TWILIO_WHATSAPP_FROM` to your new approved number.
3. You'll still need to flip subscribers to `plan = 'paid'` by hand (see
   Phase 1, step 8) until real billing exists — see below.

## Paid tiers (Stripe Managed Payments)

The site now charges for access via **Stripe Managed Payments** — Stripe
itself acts as merchant of record for tax/VAT purposes, which keeps this a
one-person operation without having to register for VAT OSS separately (see
the note at the end of this section). Two plans, both covering email +
instant WhatsApp alerts:

- **Individual — €2.99 one-off.** Covers one search window; access expires
  when that window's `days_ahead` is up (`plan = 'individual'`).
- **Garage — €19/week, €49/month, or €499/year, recurring.** Unlimited
  simultaneous watches while the subscription stays active
  (`plan = 'garage'`). Several watches for the same garage share one Stripe
  customer id (`external_customer_id`) so a renewal extends all of them at
  once.

See the `plan` column comments at the top of `supabase_schema.sql` for the
full state machine (`free`/`paid` are legacy/manual, `comp` is a one-time
code — see "Comp codes" below — `individual`/`garage` are the real paid
tiers).

### How it fits together

Unlike the rest of this project, billing needs one always-on piece that can
react to events in real time — GitHub Actions' schedule-based cron can't
receive a webhook. That piece is a small **Cloudflare Worker**
(`cloudflare-worker/stripe-worker.js`), free on Cloudflare's tier, with two
jobs:

1. **`POST /create-checkout-session`** — called by the website
   (`docs/app.js`) when someone picks a plan and clicks "Continue to
   payment". Creates a Stripe Checkout Session (with `managed_payments`
   enabled) and returns its URL for the browser to redirect to.
2. **`POST /webhook`** — called by Stripe itself after a successful
   payment. Verifies the request genuinely came from Stripe, then calls
   `create_individual_subscriber` / `create_garage_watch` (on
   `checkout.session.completed`) or `update_garage_subscription_expiry` (on
   `invoice.paid`, which fires for the first invoice and every renewal) —
   the same three service-role-only functions defined in
   `supabase_schema.sql`. A cancelled subscription isn't specially
   handled — access just lapses naturally once `plan_expires_at` passes.

The Worker is a single plain-JavaScript file with no npm dependencies (it
calls both Stripe's and Supabase's REST APIs directly with `fetch`), so it
can be pasted straight into Cloudflare's dashboard editor — no build step,
no `wrangler` CLI required.

### Deploying the Worker

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Create
   Worker**, give it a name (e.g. `nct-stripe-worker`), and deploy the
   default "Hello World" template.
2. Open it, go to its **Quick edit** / code editor, delete the placeholder
   code, and paste in the entire contents of
   `cloudflare-worker/stripe-worker.js`. Save and deploy.
3. Go to the Worker's **Settings → Variables and Secrets** and add:
   | Name | Value | Type |
   |---|---|---|
   | `STRIPE_SECRET_KEY` | your live `sk_live_...` key | Secret |
   | `STRIPE_WEBHOOK_SECRET` | from step 4 below | Secret |
   | `SUPABASE_URL` | `https://xxxx.supabase.co` | Text |
   | `SUPABASE_SERVICE_ROLE_KEY` | from Supabase project settings → API | Secret |
   | `PRICE_INDIVIDUAL` | the Individual plan's Stripe Price ID | Text |
   | `PRICE_GARAGE_WEEK` | the Garage weekly Price ID | Text |
   | `PRICE_GARAGE_MONTH` | the Garage monthly Price ID | Text |
   | `PRICE_GARAGE_YEAR` | the Garage yearly Price ID | Text |
   | `SITE_URL` | `https://nctsalerts.ie` (no trailing slash) | Text |
   | `ALLOWED_ORIGIN` | `https://nctsalerts.ie` | Text |

   Mark the four marked **Secret** as encrypted — Cloudflare's "Secret"
   variable type does this for you. These values are never entered by an AI
   assistant on your behalf; type them in yourself.
4. In the Stripe dashboard (live mode), go to **Developers → Webhooks → Add
   endpoint**. Set the URL to `https://<your-worker>.workers.dev/webhook`
   (copy the exact `*.workers.dev` URL Cloudflare gave the Worker in step
   1–2), and subscribe it to exactly two events: `checkout.session.completed`
   and `invoice.paid`. Save, then open the new endpoint's details and reveal
   its **Signing secret** (`whsec_...`) — paste that into the Worker's
   `STRIPE_WEBHOOK_SECRET` from step 3.
5. In `docs/config.js`, set `CHECKOUT_WORKER_URL` to the same
   `https://<your-worker>.workers.dev` base URL (no trailing path).
6. Test with a real small payment (or Stripe's test mode first, pointing a
   second webhook endpoint at a sandbox Worker/price set) before relying on
   it — check the Worker's **Logs** tab in Cloudflare and the event's
   delivery attempts under the Stripe webhook endpoint's page if something
   doesn't create a subscriber row as expected.

### Comp codes

For friends & family (permanent free access) or a garage trial, insert a
row into `comp_codes` yourself in the Supabase SQL Editor:

```sql
insert into comp_codes (code, label) values ('FAMILY2026', 'cousin Dave');
-- or, for a code several people can redeem:
insert into comp_codes (code, label, max_redemptions) values ('GARAGE-TRIAL', 'Joe''s Garage trial', 5);
```

Anyone who enters that code in the "Have a code?" field on the signup form
gets `plan = 'comp'` (never expires) via `redeem_comp_code`, skipping
payment entirely — same validation and Turnstile bot-check as a normal
signup, still requires clicking the email confirmation link.

I'm not an accountant or solicitor, so treat the above as a starting point,
not advice — worth a short conversation with one before real money starts
moving, especially around registering with Revenue as self-employed once
this becomes a real income source. Managed Payments handling the merchant-
of-record role is what currently avoids a separate EU VAT OSS registration,
but that's Stripe's framing of the product, not a legal guarantee — worth
confirming it still matches your situation as volume grows.

## How it all fits together

- **`docs/`** — the static website (GitHub Pages). Talks directly to
  Supabase using the public anon key, but only through three tightly-scoped
  functions — it can never read other people's data.
- **`supabase_schema.sql`** — run once, sets up the `subscribers` table and
  those functions.
- **`process_signups.py`** — runs every ~10 minutes, emails a confirmation
  link to anyone who just signed up.
- **`nct_checker.py`** — runs every 15 minutes: reads the live centre list, checks
  every centre for availability, matches results against every *confirmed*
  subscriber's chosen centres and time window, and emails anyone with active
  access (see the `plan`/`plan_expires_at` eligibility logic near the top of
  the file) — plus WhatsApps anyone eligible with a number on file, via
  `whatsapp_utils.py`. Also updates `docs/centres.json` if the site's centre
  list changes.
- **`cloudflare-worker/stripe-worker.js`** — the always-on piece GitHub
  Actions' schedule-based cron can't be: creates Stripe Checkout Sessions
  and handles Stripe's payment webhook in real time. See "Paid tiers" above.
- **Ads (once configured)** — `docs/config.js`'s `ADSENSE_CLIENT_ID` /
  `ADSENSE_SLOT_ID` control whether `app.js` loads the AdSense script at
  all; blank means no ad code runs.
- **`plan` / `external_customer_id` / `plan_expires_at` / `plan_updated_at` /
  `whatsapp_number`** on `subscribers` — see the `plan` comments in
  `supabase_schema.sql` for the full picture. `plan`/`plan_expires_at` are
  set automatically by the Stripe webhook for `individual`/`garage` rows;
  `'free'`/`'paid'` are legacy/manual rows kept grandfathered in, and
  `'comp'` comes from a redeemed comp code.

## Ongoing costs

**Phase 1 is entirely free** — Supabase, Resend, GitHub Actions/Pages, and
the Twilio Sandbox all have zero-cost tiers that comfortably cover testing
this on yourself.

**Phase 2** stays free too, as long as you stay within: GitHub Actions free
minutes (2,000/month — this uses a small fraction), Supabase's free tier
(500MB database, pauses only after 7 days of zero activity — the hourly
checker keeps it awake), and Resend's free tier (3,000 emails/month). The
domain renewal (~€8–15/year) is the one real recurring cost, doing double
duty for email and the site itself.

**WhatsApp is the one piece that isn't free once actually used in
production** — the sandbox is free, but a real utility-template message to
an EU number typically runs around €0.015–€0.03 each once you move off the
sandbox, on top of whatever Twilio charges beyond its free trial credit.
With `plan` staying `'free'` for everyone until you manually flip it, this
costs nothing until you have an actual paying WhatsApp user.

Ads bring in revenue rather than cost, once approved; a future paid tier
would add whatever cut your payment provider takes per transaction.

## Fixing unreliable hourly runs

GitHub's own `schedule:` trigger (the `cron: "..."` line in
`.github/workflows/nct-check.yml`) is not reliable on shared/public
runners — GitHub openly documents that scheduled runs can be delayed
during busy periods, but in practice a large fraction of them get dropped
entirely with no error anywhere, especially for an exact `0 * * * *`
(top-of-the-hour) schedule. If the checker is only running every few hours
instead of every hour, this is almost always why.

The reliable fix is to stop depending on GitHub's `schedule` event and
instead have an outside service call the workflow's `workflow_dispatch`
API endpoint once an hour — that's a different trigger that fires
immediately, not the deprioritized queue `schedule` events sit in.

### 1. Create a GitHub personal access token

This has to be done from your own GitHub account — it's a credential, so
no one else can create it for you.

1. Go to **github.com → your profile photo (top right) → Settings →
   Developer settings → Personal access tokens → Fine-grained tokens**.
2. Click **Generate new token**.
3. **Token name**: something like `nct-check-dispatch`.
4. **Expiration**: pick the longest option available (or set a calendar
   reminder to regenerate it before it expires — a fine-grained token
   maxes out at 1 year).
5. **Repository access**: choose **Only select repositories** and pick
   `el-byrno-nct-8x2k1`. Don't grant access to any other repo.
6. **Permissions → Repository permissions**: find **Actions** and set it
   to **Read and write**. Leave everything else as **No access**.
7. Click **Generate token**, then **copy the token immediately** — GitHub
   only shows it once. Paste it somewhere temporary (a text file you'll
   delete after the next step) — never commit it into the repo.

### 2. Set up the hourly ping

Any scheduler that can make an HTTP request with custom headers on a
schedule works. **cron-job.org** is free, reliable, and simple:

1. Create a free account at cron-job.org.
2. Create a new cronjob with these settings:
   - **Title**: `NCT checker dispatch`
   - **URL**:
     `https://api.github.com/repos/shanemib/el-byrno-nct-8x2k1/actions/workflows/nct-check.yml/dispatches`
   - **Schedule**: every hour (pick a specific minute, e.g. `:10`, rather
     than the top of the hour)
   - **Request method**: `POST`
   - **Headers** (add each as a name/value pair):
     - `Authorization` → `Bearer <paste your token here>`
     - `Accept` → `application/vnd.github+json`
     - `X-GitHub-Api-Version` → `2022-11-28`
     - `Content-Type` → `application/json`
   - **Body** (raw JSON): `{"ref": "main"}`
3. Save, then use the service's "Run now" / "Test" button to fire it once
   immediately. A **success is HTTP 204 No Content** with an empty body —
   that's normal for this endpoint, not an error. Then check the repo's
   **Actions** tab: a new "NCT Appointment Check" run should appear
   within a few seconds, triggered by `workflow_dispatch` rather than
   `schedule`.

Leave the existing `cron:` schedule line in `nct-check.yml` in place as a
harmless backup — if it happens to fire too, the checker runs twice in
close succession, which costs a few extra Actions minutes but changes
nothing else (it's idempotent either way).

### Note on the token

Treat that token like a password — anyone who has it could trigger this
one workflow (nothing else, since it's scoped to just this repo and just
Actions). If you ever need to revoke it, delete it from **Settings →
Developer settings → Personal access tokens** and generate a new one to
paste into cron-job.org.

## Bot protection (Cloudflare Turnstile)

The signup form already has a honeypot field, which stops unsophisticated
bots. Cloudflare Turnstile adds a proper, free, mostly-invisible bot check
on top of that for when the site is public and gets bot traffic worth
stopping. It's entirely optional — until you set it up, the code just skips
it and the form works exactly as before.

The code for this (the widget on the form, and server-side verification in
`signup_subscriber`) is already in place. All that's left is creating a
free Cloudflare account and generating your own site key and secret key —
that's an account-creation step only you can do, so here's exactly what to
click:

1. Go to [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
   and create a free account (just an email + password — no domain or
   credit card needed for Turnstile).
2. Once logged in, find **Turnstile** in the left sidebar (under "Security"
   or via the search bar).
3. Click **Add a site**, give it any label (e.g. "NCT Alerts"), and for
   **Domain** enter the domain your site is actually hosted on (your
   `github.io` address, or your custom domain from Phase 2). Leave the
   widget mode as the default ("Managed").
4. Click **Create**. Cloudflare shows you two values:
   - **Site Key** — safe to be public.
   - **Secret Key** — keep this one private.
5. In `docs/index.html`, find the line:
   ```html
   <div class="cf-turnstile" data-sitekey="YOUR_TURNSTILE_SITE_KEY"></div>
   ```
   and replace `YOUR_TURNSTILE_SITE_KEY` with your real Site Key.
6. In your Supabase project's **SQL Editor**, run this once (with your real
   Secret Key in place of the placeholder) — **never** put the secret key in
   `supabase_schema.sql` or anywhere else in the repo, since that file is
   public on GitHub. This uses Supabase Vault, its built-in secret store —
   an earlier version of this guide suggested `alter database ... set`
   instead, but Supabase's hosted SQL Editor doesn't have permission to set
   database-level config that way ("permission denied to set parameter"),
   so Vault is the supported route:
   ```sql
   select vault.create_secret('YOUR_TURNSTILE_SECRET_KEY', 'turnstile_secret_key');
   ```
7. Re-run the rest of `supabase_schema.sql` in the SQL Editor too (the whole
   file, not just the line above) so the updated `signup_subscriber`
   function — the one that actually checks the Turnstile token — replaces
   the old one.
8. That's it. One important nuance: verification isn't instant. Postgres
   can't synchronously wait for Cloudflare's response inside the same
   database transaction that handles the signup (a `pg_net` limitation —
   see the comments in `signup_subscriber` and `get_turnstile_verification`
   in `supabase_schema.sql` if you want the full story), so a signup is
   always accepted immediately, and the actual Turnstile result is checked
   afterwards by `process_signups.py` (the same job that already sends
   confirmation emails, running every ~10 minutes) right before it would
   send the confirmation email. If verification failed, that job deletes
   the signup instead of emailing it — so a bot's row can sit in the
   `subscribers` table for up to ~10 minutes, but it never gets an email
   and never becomes a real subscriber.

If you ever want to turn it back off, find the secret's id and clear it:
```sql
select vault.update_secret(
  (select id from vault.decrypted_secrets where name = 'turnstile_secret_key'),
  ''
);
```
The function treats an empty/missing secret as "verification not
configured" and skips it, so signups keep working normally either way. To
change the secret to a new value later, use the same `vault.update_secret`
call with the new value instead of `''`.

## Site analytics and all-time subscriber count

Two small, unrelated additions that both answer "how's the site doing":

**Page views — Cloudflare Web Analytics.** Free, cookieless, no account
needed beyond the free Cloudflare account from the Turnstile section above
(or a new one, if you skipped that). A beacon script is already added to
every page in `docs/`, and `privacy.html`'s "Cookies and ads" section
already describes it to visitors — nothing left to do in the code. If you
ever need to recreate the beacon token (e.g. a new site or a rotated
token):

1. In the Cloudflare dashboard, go to **Analytics & Logs → Web Analytics →
   Add a site**, and enter your site's hostname (e.g.
   `shanemib.github.io` for the default GitHub Pages URL, or your custom
   domain from Phase 2).
2. Cloudflare shows a `<script>` snippet with a `data-cf-beacon` token in
   it. Copy the token value.
3. Replace the token in the existing `data-cf-beacon='{"token": "..."}'`
   script tag near the bottom of each file in `docs/` (`index.html`,
   `availability.html`, `stats.html`, `manage.html`, `verify.html`,
   `unsubscribe.html`, `privacy.html`) with the new one.
4. Give it a little while after publishing before checking the dashboard —
   view counts don't appear instantly.

**All-time subscriber count.** The `subscribers` table only ever shows
*current* subscribers — `unsubscribe_subscriber` deletes a row outright, so
anyone who ever unsubscribed disappears from that count with no trace. A
separate `subscriber_history` table (append-only, never deleted from) now
records every email the moment it's first confirmed, so there's a real
lifetime total to point to. This needs the current `supabase_schema.sql`
run once in the SQL Editor to take effect (it creates the table, backfills
everyone already confirmed so far, and adds the
`get_all_time_subscriber_count()` function) — after that it looks after
itself, since `verify_subscriber` records into it automatically on every
future confirmation. There's no UI for it yet; call
`select get_all_time_subscriber_count();` in the SQL Editor whenever you
want the number.

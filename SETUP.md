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

## Future: paid tiers (self-serve billing)

The database already has what a paid tier needs to hook into later — a
`plan` column (`free`/`paid`) and an `external_customer_id` column — so
adding billing later won't reshape the data. The WhatsApp channel already
reads `plan`, so once real payments exist, billing just has to flip that
column — nothing about the notification logic changes.

When you're ready to stop doing that flip by hand and let people pay for it
themselves, you'll need to decide between two shapes:

- **Stripe directly** — lower fees (~1.5–2.9%), but you register for EU VAT
  (via Revenue's VAT OSS scheme) and file it yourself as sales grow.
- **A merchant of record** (Paddle, Lemon Squeezy) — they legally sell the
  subscription as themselves and handle EU VAT for you, for a higher fee
  (~5%+). Usually the simpler choice for a solo project.

Either way, you'll need one new always-on piece this static-site setup
doesn't have: a webhook endpoint the payment provider calls the moment
someone pays or cancels, which updates that subscriber's `plan` in Supabase
using the service-role key. GitHub Actions' schedule-based cron can't
receive a webhook in real time, so a small serverless function (a free
Cloudflare Worker is a good fit) is the piece to add at that point. None of
that is built yet — it's intentionally left until you've decided on a
provider and pricing.

I'm not an accountant or solicitor, so treat the above as a starting point,
not advice — worth a short conversation with one before real money starts
moving, especially around VAT registration and (separately) registering
with Revenue as self-employed once this becomes a real income source.

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
  subscriber's chosen centres and time window, and emails anyone with a new
  match (plus WhatsApps `plan = 'paid'` subscribers via `whatsapp_utils.py`).
  Also updates `docs/centres.json` if the site's centre list changes.
- **Ads (once configured)** — `docs/config.js`'s `ADSENSE_CLIENT_ID` /
  `ADSENSE_SLOT_ID` control whether `app.js` loads the AdSense script at
  all; blank means no ad code runs.
- **`plan` / `external_customer_id` / `plan_updated_at` / `whatsapp_number`**
  on `subscribers` — `whatsapp_number` is collected from everyone at
  signup; the rest is groundwork for a future paid tier. Nothing sets
  `plan` to `'paid'` except you, by hand, in the SQL Editor — that's the
  interim process until real billing exists.

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

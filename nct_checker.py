"""
NCT appointment checker for ncts.ie

Walks the booking flow for a single "probe" registration, reads the LIVE list
of every test centre from the site's own dropdown, and checks all of them for
availability. Results are then matched against every verified subscriber in
Supabase (their chosen centres + how many days ahead they care about), and
anyone with a new match gets an email via Resend — plus an instant WhatsApp
message too, for subscribers on the paid plan with a WhatsApp number on file.

The probe registration is only used to get into the booking flow — availability
itself isn't tied to whose car it is, so one shared registration (yours) is
enough to check appointments on behalf of every subscriber on the website.

ENVIRONMENT VARIABLES (set as GitHub Actions secrets, see SETUP.md):
    NCT_REG                    - vehicle registration used to open the booking flow, e.g. "191D12345"
    SUPABASE_URL               - e.g. https://xxxx.supabase.co
    SUPABASE_SERVICE_ROLE_KEY  - Supabase service_role secret key
    RESEND_API_KEY             - Resend API key
    RESEND_FROM                - verified sender, e.g. "NCT Alerts <alerts@yourdomain.com>"
    SITE_BASE_URL              - e.g. https://yourusername.github.io/el-byrno-nct-8x2k1
    NTFY_TOPIC                 - optional: your own personal ntfy.sh topic (legacy, see README)
    TWILIO_ACCOUNT_SID         - optional: needed for WhatsApp alerts to paid subscribers
    TWILIO_AUTH_TOKEN          - optional: see above
    TWILIO_WHATSAPP_FROM       - optional: e.g. "whatsapp:+14155238886"
    TWILIO_CONTENT_SID         - optional: approved template id, e.g. "HX..."

Run locally first with HEADLESS=false to verify selectors still work:
    HEADLESS=false python nct_checker.py
"""

import os
import re
import json
import asyncio
from datetime import datetime, timedelta

import requests
from playwright.async_api import async_playwright

from supabase_utils import get_rows, patch_row
from resend_utils import send_email
from whatsapp_utils import send_whatsapp_alert

REG = os.environ.get("NCT_REG", "")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")
SITE_BASE_URL = os.environ.get("SITE_BASE_URL", "").rstrip("/")
HEADLESS = os.environ.get("HEADLESS", "true").lower() != "false"

DEFAULT_DAYS_AHEAD = 28
MAX_DAYS_AHEAD_CAP = 90

BASE_URL = "https://www.ncts.ie/"
CENTRES_JSON_PATH = os.path.join(os.path.dirname(__file__), "docs", "centres.json")
LAST_CHECKED_JSON_PATH = os.path.join(os.path.dirname(__file__), "docs", "last_checked.json")
AVAILABILITY_JSON_PATH = os.path.join(os.path.dirname(__file__), "docs", "availability.json")

# Always scan at least this far ahead, regardless of what current subscribers
# asked for — otherwise the public "live availability" page would only see
# as far as the shortest/tightest subscriber window in the database.
MIN_PUBLIC_SCAN_DAYS = 28


async def run_flow(page):
    """Step 1-2: enter reg, confirm vehicle, accept terms. (selectors verified via playwright codegen)"""
    await page.goto(BASE_URL)

    # Fresh browser profiles (e.g. GitHub Actions) show a GDPR cookie modal
    # that blocks everything underneath it — dismiss it if present.
    cookie_btn = page.locator("#bs-gdpr-cookies-modal-accept-btn")
    if await cookie_btn.count():
        await cookie_btn.click()
        await page.wait_for_timeout(300)

    reg_box = page.get_by_role("textbox", name="Enter Registration")
    await reg_box.click()
    await reg_box.fill(REG)
    await page.get_by_role("button", name="Search Vehicle").click()
    await page.wait_for_load_state("networkidle")

    await page.get_by_role("checkbox", name="I agree to the Terms and").check()
    await page.get_by_role("checkbox", name="I confirm that I have read").check()
    await page.get_by_role("button", name="Continue").click()
    await page.wait_for_load_state("networkidle")


async def expand_all_centres(page):
    """Click 'SEE MORE SUGGESTED CENTRES' until every centre is listed."""
    for _ in range(5):  # safety cap
        btn = page.locator('button[aria-controls="moreSuggestedCentres"]')
        if await btn.count() == 0:
            break
        try:
            await btn.first.scroll_into_view_if_needed()
            await btn.first.click(timeout=5000)
        except Exception:
            break
        await page.wait_for_timeout(800)


async def get_all_centre_names(page) -> list[str]:
    """Read every option out of the 'Select Station' dropdown — this is the
    live, authoritative list of centre names the site currently offers, so we
    never have to hand-maintain a list of centres ourselves."""
    toggle = page.locator("#showMoreStations").get_by_role("emphasis")
    if await toggle.count():
        await toggle.first.click()
        await page.wait_for_timeout(300)

    select = page.get_by_label("Select Station")
    if await select.count() == 0:
        print("[centres] could not find the 'Select Station' dropdown")
        return []

    options = await select.locator("option").all_inner_texts()
    names = [o.strip() for o in options if o.strip()]
    # Drop an obvious placeholder option like "-- Select a station --"
    names = [n for n in names if "select" not in n.lower() or len(n) > 40]
    return names


MONTH_MAP = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}


def parse_site_date(label: str):
    """Parse labels like 'Tuesday 8th Sept' (site uses non-standard 'Sept')."""
    match = re.match(r"^[A-Za-z]+\s+(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+)$", label)
    if not match:
        return None
    day = int(match.group(1))
    month = MONTH_MAP.get(match.group(2).lower())
    if not month:
        return None
    today = datetime.now()
    candidate = datetime(today.year, month, day)
    if candidate < today - timedelta(days=1):
        candidate = datetime(today.year + 1, month, day)
    return candidate


async def select_centre(page, centre_name):
    """Open the station dropdown and pick centre_name by its visible label."""
    toggle = page.locator("#showMoreStations").get_by_role("emphasis")
    if await toggle.count():
        await toggle.first.click()
        await page.wait_for_timeout(300)

    select = page.get_by_label("Select Station")
    if await select.count():
        await select.select_option(label=centre_name)
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(500)
        return True
    return False


async def get_available_dates_and_times(page, centre_name, cutoff_date):
    """
    Select a centre via the 'Select Station' dropdown, then walk each
    date shown within cutoff_date and read the time labels underneath
    it. We only click dates to reveal times — never a time slot itself,
    since that starts the real booking flow.
    """
    selected = await select_centre(page, centre_name)
    print(f"[{centre_name}] selected via dropdown: {selected}")
    if not selected:
        return []

    dates_found = []
    date_locator = page.get_by_text(re.compile(r"^[A-Za-z]+\s+\d{1,2}(st|nd|rd|th)\s+[A-Za-z]+$"))
    count = await date_locator.count()
    print(f"[{centre_name}] date elements found: {count}")

    for i in range(count):
        try:
            label_text = (await date_locator.nth(i).inner_text()).strip().replace("\n", " ")
            parsed = parse_site_date(label_text)
            if parsed is None:
                print(f"[{centre_name}] could not parse date label: {label_text!r}")
                continue
            if parsed > cutoff_date:
                continue

            await date_locator.nth(i).evaluate("el => el.click()")
            await page.wait_for_timeout(1000)

            # Times live in a specific owl-carousel: #bookingAvailableSlotsTimes,
            # each one a <label class="booking-available-slot"> around a hidden radio.
            time_labels = page.locator("#bookingAvailableSlotsTimes label.booking-available-slot")
            raw_times = await time_labels.all_inner_texts()
            times = [t.strip() for t in raw_times if t.strip()]
            print(f"[{centre_name}] {label_text}: {len(times)} time slots")
            if times:
                dates_found.append({"date": label_text, "parsed": parsed, "times": times})
        except Exception as e:
            print(f"[{centre_name}] stopped early after an unexpected page change: {e}")
            break

    return dates_found


NTFY_MAX_LINES = 10  # keep this a real push notification, not a wall of text


def send_ntfy(lines: list[str]):
    if not NTFY_TOPIC:
        return
    message = "\n".join(lines[:NTFY_MAX_LINES])
    if len(lines) > NTFY_MAX_LINES:
        message += f"\n...and {len(lines) - NTFY_MAX_LINES} more — check the website for the full list."
    requests.post(
        f"https://ntfy.sh/{NTFY_TOPIC}",
        data=message.encode("utf-8"),
        headers={"Title": "NCT slot available!", "Priority": "high"},
    )


def fetch_verified_subscribers() -> list[dict]:
    rows = get_rows(
        "subscribers",
        {
            "verified": "eq.true",
            "select": "id,email,centres,days_ahead,notified,unsubscribe_token,plan,whatsapp_number",
        },
    )
    print(f"[subscribers] {len(rows)} verified subscriber(s)")
    return rows


def build_email_body(matches: list[dict], unsubscribe_link: str) -> tuple[str, str]:
    lines_html = "".join(
        f"<li><strong>{m['centre']}</strong> — {m['date']}: {', '.join(m['times'])}</li>"
        for m in matches
    )
    html = f"""
    <p>Good news — new NCT appointment availability matching your alert:</p>
    <ul>{lines_html}</ul>
    <p>Book quickly at <a href="https://www.ncts.ie/">ncts.ie</a> — slots fill fast.</p>
    <p style="color:#888;font-size:12px;">
      Don't want these alerts anymore? <a href="{unsubscribe_link}">Unsubscribe</a>.
    </p>
    """
    text = "New NCT appointment availability:\n" + "\n".join(
        f"- {m['centre']} — {m['date']}: {', '.join(m['times'])}" for m in matches
    ) + f"\n\nBook at https://www.ncts.ie/\nUnsubscribe: {unsubscribe_link}"
    return html, text


def notify_subscribers(results: dict, subscribers: list[dict]):
    now = datetime.now()

    for sub in subscribers:
        sub_centres = sub.get("centres") or []
        days_ahead = sub.get("days_ahead") or DEFAULT_DAYS_AHEAD
        sub_cutoff = now + timedelta(days=days_ahead)
        notified = dict(sub.get("notified") or {})

        matches = []
        fresh_notified = {}
        for centre in sub_centres:
            for slot in results.get(centre, []):
                if slot["parsed"] > sub_cutoff:
                    continue
                key = f"{centre}|{slot['parsed'].date().isoformat()}"
                fresh_notified[key] = notified.get(key) or now.isoformat()
                if key in notified:
                    continue  # already emailed about this centre+date before
                matches.append({"centre": centre, "date": slot["date"], "times": slot["times"]})

        # Prune stale keys (dates that have now passed) so this field doesn't grow forever.
        pruned_notified = {
            k: v for k, v in fresh_notified.items()
            if datetime.fromisoformat(k.split("|")[1]) >= now - timedelta(days=1)
        }

        if matches:
            unsubscribe_link = f"{SITE_BASE_URL}/unsubscribe.html?token={sub['unsubscribe_token']}"
            html, text = build_email_body(matches, unsubscribe_link)
            sent = send_email(
                to=sub["email"],
                subject="New NCT appointment availability",
                html=html,
                text=text,
            )
            print(f"[notify] {sub['email']}: {len(matches)} new match(es), emailed={sent}")

            # Paid plan also gets an instant WhatsApp alert alongside the email
            # (email stays as a reliable backup/record either way).
            if sub.get("plan") == "paid" and sub.get("whatsapp_number"):
                wa_sent = send_whatsapp_alert(sub["whatsapp_number"], matches)
                print(f"[notify] {sub['email']}: whatsapp sent={wa_sent}")

        if pruned_notified != notified:
            try:
                patch_row("subscribers", "id", sub["id"], {"notified": pruned_notified})
            except Exception as e:
                print(f"[notify] failed to update notified state for {sub['email']}: {e}")


def write_last_checked():
    """Record when the checker last completed successfully, so the website
    can show a real 'last checked N minutes ago' instead of just claiming
    'hourly'. Only called once a full run has actually finished — if the
    scraper breaks partway through (e.g. ncts.ie changes its page), this
    timestamp correctly stops moving forward until someone fixes it."""
    try:
        os.makedirs(os.path.dirname(LAST_CHECKED_JSON_PATH), exist_ok=True)
        with open(LAST_CHECKED_JSON_PATH, "w") as f:
            json.dump({"timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")}, f)
    except Exception as e:
        print(f"[last_checked] failed to write last_checked.json: {e}")


def write_availability_snapshot(results: dict[str, list[dict]]):
    """Save what this run actually found to docs/availability.json, so the
    site's 'Live availability' page can show real current slots — not tied
    to any one subscriber's centres or window. Public info only (centre
    names, dates, times); nothing about who's subscribed."""
    try:
        snapshot = {
            centre: [
                {"date": s["date"], "iso": s["parsed"].date().isoformat(), "times": s["times"]}
                for s in slots
            ]
            for centre, slots in results.items()
        }
        os.makedirs(os.path.dirname(AVAILABILITY_JSON_PATH), exist_ok=True)
        with open(AVAILABILITY_JSON_PATH, "w") as f:
            json.dump(snapshot, f, indent=2)
    except Exception as e:
        print(f"[availability] failed to write availability.json: {e}")


def maybe_update_centres_file(all_centres: list[str]):
    try:
        existing = []
        if os.path.exists(CENTRES_JSON_PATH):
            with open(CENTRES_JSON_PATH) as f:
                existing = json.load(f)
        if sorted(existing) != sorted(all_centres):
            os.makedirs(os.path.dirname(CENTRES_JSON_PATH), exist_ok=True)
            with open(CENTRES_JSON_PATH, "w") as f:
                json.dump(sorted(all_centres), f, indent=2)
            print(f"[centres] docs/centres.json updated ({len(all_centres)} centres)")
        else:
            print("[centres] docs/centres.json already up to date")
    except Exception as e:
        print(f"[centres] failed to update centres.json: {e}")


async def main():
    if not REG:
        raise SystemExit(
            "NCT_REG is not set — add it as a GitHub Actions secret "
            "(your vehicle registration, e.g. 191D12345)."
        )

    subscribers = fetch_verified_subscribers()
    days_needed = [s.get("days_ahead") or DEFAULT_DAYS_AHEAD for s in subscribers]
    max_days = min(max(max(days_needed, default=DEFAULT_DAYS_AHEAD), MIN_PUBLIC_SCAN_DAYS), MAX_DAYS_AHEAD_CAP)
    cutoff = datetime.now() + timedelta(days=max_days)

    results: dict[str, list[dict]] = {}
    report_lines = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=HEADLESS)
        page = await browser.new_page()

        await run_flow(page)
        await expand_all_centres(page)

        all_centres = await get_all_centre_names(page)
        print(f"[centres] {len(all_centres)} centres found: {all_centres}")
        maybe_update_centres_file(all_centres)

        for centre in all_centres:
            slots = await get_available_dates_and_times(page, centre, cutoff)
            if slots:
                results[centre] = slots
                for s in slots:
                    times_str = ", ".join(s["times"]) if s["times"] else "(times not read)"
                    report_lines.append(f"{centre}: {s['date']} — {times_str}")

        await browser.close()

    if report_lines:
        print("Availability found:\n" + "\n".join(report_lines))
        send_ntfy(report_lines)
    else:
        print("No availability within window across any centre.")

    notify_subscribers(results, subscribers)
    write_availability_snapshot(results)
    write_last_checked()


if __name__ == "__main__":
    asyncio.run(main())

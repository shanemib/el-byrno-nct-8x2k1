"""
NCT appointment checker for ncts.ie

Walks the booking flow for a given registration, checks a set of target
centres, and sends a push notification (via ntfy.sh) if any appointment
is available within the next N weeks.

ENVIRONMENT VARIABLES (set as GitHub Actions secrets, see README.md):
    NCT_REG       - vehicle registration, e.g. "152C6241"
    NTFY_TOPIC    - a private topic name for ntfy.sh, e.g. "el-byrno-nct-8x2k1"

Run locally first with HEADLESS=false to verify selectors work:
    HEADLESS=false python nct_checker.py
"""

import os
import re
import asyncio
from datetime import datetime, timedelta

import requests
from playwright.async_api import async_playwright

REG = os.environ.get("NCT_REG", "152C6241")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "CHANGE-ME")
TARGET_CENTRES = ["Westport", "Castlerea", "Ballina", "Tuam"]
WEEKS_AHEAD = 4
HEADLESS = os.environ.get("HEADLESS", "true").lower() != "false"

BASE_URL = "https://www.ncts.ie/"


async def run_flow(page):
    """Step 1-2: enter reg, confirm vehicle, accept terms. (selectors verified via playwright codegen)"""
    await page.goto(BASE_URL)

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
                dates_found.append({"date": label_text, "times": times})
        except Exception as e:
            print(f"[{centre_name}] stopped early after an unexpected page change: {e}")
            break

    return dates_found


def send_notification(message: str):
    requests.post(
        f"https://ntfy.sh/{NTFY_TOPIC}",
        data=message.encode("utf-8"),
        headers={"Title": "NCT slot available!", "Priority": "high"},
    )


async def main():
    cutoff = datetime.now() + timedelta(weeks=WEEKS_AHEAD)
    report_lines = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=HEADLESS)
        page = await browser.new_page()

        await run_flow(page)
        await expand_all_centres(page)

        for centre in TARGET_CENTRES:
            slots = await get_available_dates_and_times(page, centre, cutoff)
            if slots:
                for s in slots:
                    times_str = ", ".join(s["times"]) if s["times"] else "(times not read)"
                    report_lines.append(f"{centre}: {s['date']} — {times_str}")

        await browser.close()

    if report_lines:
        send_notification("\n".join(report_lines))
        print("Sent notification:\n" + "\n".join(report_lines))
    else:
        print("No availability within window — no notification sent.")


if __name__ == "__main__":
    asyncio.run(main())

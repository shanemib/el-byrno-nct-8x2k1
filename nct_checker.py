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
    """Step 1-2: enter reg, confirm vehicle, accept terms."""
    await page.goto(BASE_URL)
    await page.fill('input[placeholder="ENTER REGISTRATION"]', REG)
    await page.keyboard.press("Enter")
    await page.wait_for_load_state("networkidle")

    # Confirmation page: tick both checkboxes, click YES
    checkboxes = page.locator('input[type="checkbox"]')
    count = await checkboxes.count()
    for i in range(count):
        await checkboxes.nth(i).check()
    await page.click('button:has-text("YES")')
    await page.wait_for_load_state("networkidle")


async def expand_all_centres(page):
    """Click 'SEE MORE SUGGESTED CENTRES' until every centre is listed."""
    for _ in range(5):  # safety cap
        btn = page.locator('button:has-text("SEE MORE SUGGESTED CENTRES")')
        if await btn.count() == 0:
            break
        await btn.first.click()
        await page.wait_for_timeout(800)


async def get_centre_next_dates(page):
    """
    Returns {centre_name: next_available_date_string} by reading the
    'Selected Centre' banner + 'Other Suggested Centre' table rows.

    NOTE: verify these selectors match the live DOM (see README) —
    built from the screenshots you shared, may need small tweaks.
    """
    results = {}

    # The currently selected centre banner
    selected_name = await page.locator(".selected-centre, [class*='SELECTED CENTRE'] a").first.inner_text()
    selected_date = await page.locator(".next-available-date, [class*='NEXT AVAILABLE'] >> nth=0").first.inner_text()
    results[selected_name.strip()] = selected_date.strip()

    # Rows in the "Other Suggested Centre" table
    rows = page.locator("table tr")
    row_count = await rows.count()
    for i in range(row_count):
        text = await rows.nth(i).inner_text()
        parts = [p.strip() for p in text.split("\n") if p.strip()]
        if len(parts) >= 2:
            results[parts[0]] = parts[-1]

    return results


async def get_available_dates_and_times(page, centre_name, cutoff_date):
    """
    Click into a centre (if not already selected) and collect every date
    button within the next WEEKS_AHEAD weeks, then click each date to
    read the available times.
    """
    dates_found = []

    # Click the centre name if it's not already the selected one
    link = page.locator(f"text={centre_name}").first
    if await link.count():
        await link.click()
        await page.wait_for_timeout(1000)

    date_buttons = page.locator("button:has-text('Sept'), button:has-text('Oct'), button:has-text('Nov')")
    n = await date_buttons.count()
    for i in range(n):
        label = (await date_buttons.nth(i).inner_text()).strip()
        try:
            parsed = datetime.strptime(f"{label} {datetime.now().year}", "%A\n%dth %b %Y")
        except ValueError:
            continue  # date format varies; adjust after checking real labels
        if parsed > cutoff_date:
            continue

        await date_buttons.nth(i).click()
        await page.wait_for_timeout(800)
        times = await page.locator("[class*='time-slot'], button[class*='time']").all_inner_texts()
        dates_found.append({"date": label, "times": times})

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
        next_dates = await get_centre_next_dates(page)

        for centre in TARGET_CENTRES:
            match = next((c for c in next_dates if centre.lower() in c.lower()), None)
            if not match:
                continue
            slots = await get_available_dates_and_times(page, match, cutoff)
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

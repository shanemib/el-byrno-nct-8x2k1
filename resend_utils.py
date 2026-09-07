"""
Tiny shared helper for sending email via the Resend API (https://resend.com).

Used by both nct_checker.py (availability alerts) and scripts/process_signups.py
(verification emails), so the sending logic and error handling only live in one
place.

ENVIRONMENT VARIABLES (set as GitHub Actions secrets):
    RESEND_API_KEY - your Resend API key
    RESEND_FROM    - the verified sender address, e.g. "NCT Alerts <alerts@yourdomain.com>"
"""

import os
import requests

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
RESEND_FROM = os.environ.get("RESEND_FROM", "")

RESEND_API_URL = "https://api.resend.com/emails"


def send_email(to: str, subject: str, html: str, text: str | None = None) -> bool:
    """Send one email via Resend. Returns True on success, False on failure
    (never raises — a single bad email address shouldn't crash a batch job)."""
    if not RESEND_API_KEY or not RESEND_FROM:
        print(f"[resend] RESEND_API_KEY/RESEND_FROM not set — would have emailed {to}: {subject}")
        return False

    payload = {
        "from": RESEND_FROM,
        "to": [to],
        "subject": subject,
        "html": html,
    }
    if text:
        payload["text"] = text

    try:
        resp = requests.post(
            RESEND_API_URL,
            json=payload,
            headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
            timeout=15,
        )
        if resp.status_code >= 300:
            print(f"[resend] failed to email {to}: {resp.status_code} {resp.text}")
            return False
        return True
    except requests.RequestException as e:
        print(f"[resend] error emailing {to}: {e}")
        return False

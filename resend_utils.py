"""
Tiny shared helper for sending email — via Gmail's free SMTP, or via the
Resend API (https://resend.com) — used by both nct_checker.py (availability
alerts) and process_signups.py (verification emails), so the sending logic
and error handling only live in one place.

Gmail is tried first if configured, since it needs no domain of your own and
can actually deliver to real subscribers on Gmail's free tier (an ordinary
Gmail account can send up to ~500 emails/day, more than enough here).
Resend's free tier, by contrast, only delivers to the email address on your
own Resend account until you verify a custom domain — which is why, without
one, every alert looked like it "worked" but only you ever received it.

Falls back to Resend if Gmail isn't configured, so nothing breaks for anyone
already using Resend with a verified domain.

ENVIRONMENT VARIABLES (set as GitHub Actions secrets):
    GMAIL_USER          - your full Gmail address, e.g. "you@gmail.com"
    GMAIL_APP_PASSWORD  - a 16-character Gmail "App Password" (NOT your normal
                           Gmail password — see SETUP.md for how to create one;
                           requires 2-Step Verification to be turned on first)
    RESEND_API_KEY      - your Resend API key (used only if GMAIL_USER isn't set)
    RESEND_FROM         - the verified sender address, e.g. "NCT Alerts <alerts@yourdomain.com>"
"""

import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import requests

GMAIL_USER = os.environ.get("GMAIL_USER", "")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
RESEND_FROM = os.environ.get("RESEND_FROM", "")

RESEND_API_URL = "https://api.resend.com/emails"


def _send_via_gmail(to: str, subject: str, html: str, text: str | None = None) -> bool:
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = GMAIL_USER
    msg["To"] = to
    if text:
        msg.attach(MIMEText(text, "plain"))
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=15) as server:
            server.login(GMAIL_USER, GMAIL_APP_PASSWORD)
            server.sendmail(GMAIL_USER, [to], msg.as_string())
        return True
    except Exception as e:
        print(f"[gmail] error emailing {to}: {e}")
        return False


def _send_via_resend(to: str, subject: str, html: str, text: str | None = None) -> bool:
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


def send_email(to: str, subject: str, html: str, text: str | None = None) -> bool:
    """Send one email via whichever provider is configured (Gmail preferred,
    then Resend). Returns True on success, False on failure (never raises —
    a single bad email address shouldn't crash a batch job)."""
    if GMAIL_USER and GMAIL_APP_PASSWORD:
        return _send_via_gmail(to, subject, html, text)
    if RESEND_API_KEY and RESEND_FROM:
        return _send_via_resend(to, subject, html, text)
    print(
        f"[email] neither GMAIL_USER/GMAIL_APP_PASSWORD nor RESEND_API_KEY/RESEND_FROM "
        f"is set — would have emailed {to}: {subject}"
    )
    return False

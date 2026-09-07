"""
Tiny shared helper for sending WhatsApp notifications via Twilio — the paid
plan's instant-alert channel (see SETUP.md "Set up WhatsApp alerts").

WhatsApp only allows a business to message someone it hasn't heard from in
the last 24 hours using a pre-approved "Content Template" — free-form text
isn't allowed for this kind of unprompted notification. So unlike
resend_utils.py, this doesn't send arbitrary HTML: it fills in the one
variable ({{1}}) of whichever template you created and had approved in the
Twilio console, and sends that.

ENVIRONMENT VARIABLES (set as GitHub Actions secrets):
    TWILIO_ACCOUNT_SID          - starts with "AC..."
    TWILIO_AUTH_TOKEN
    TWILIO_WHATSAPP_FROM        - your Twilio WhatsApp sender, e.g.
                                   "whatsapp:+14155238886" (sandbox) or your
                                   own approved number in production
    TWILIO_CONTENT_SID          - the ContentSid (starts with "HX...") of
                                   your approved template
"""

import os
import json
import requests

TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_WHATSAPP_FROM = os.environ.get("TWILIO_WHATSAPP_FROM", "")
TWILIO_CONTENT_SID = os.environ.get("TWILIO_CONTENT_SID", "")

MAX_BODY_CHARS = 900  # stay comfortably under WhatsApp template body limits


def configured() -> bool:
    return bool(
        TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM and TWILIO_CONTENT_SID
    )


def _format_body(matches: list[dict]) -> str:
    lines = [f"{m['centre']} — {m['date']}: {', '.join(m['times'])}" for m in matches]
    body = "New NCT availability:\n" + "\n".join(lines)
    if len(body) > MAX_BODY_CHARS:
        body = body[: MAX_BODY_CHARS - 3] + "..."
    return body


def send_whatsapp_alert(to_number: str, matches: list[dict]) -> bool:
    """Send the WhatsApp availability alert template. Returns True on success,
    False on failure (never raises — one bad number shouldn't crash a batch)."""
    if not configured():
        print(f"[whatsapp] Twilio env vars not set — would have messaged {to_number}")
        return False

    to = to_number if to_number.startswith("whatsapp:") else f"whatsapp:{to_number}"
    body = _format_body(matches)

    try:
        resp = requests.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json",
            auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
            data={
                "From": TWILIO_WHATSAPP_FROM,
                "To": to,
                "ContentSid": TWILIO_CONTENT_SID,
                # Matches a template body defined with one variable, e.g.
                # "{{1}}" — see SETUP.md for the exact template text to submit.
                # json.dumps handles escaping (quotes, newlines, etc.) safely.
                "ContentVariables": json.dumps({"1": body}),
            },
            timeout=15,
        )
        if resp.status_code >= 300:
            print(f"[whatsapp] failed to message {to_number}: {resp.status_code} {resp.text}")
            return False
        return True
    except requests.RequestException as e:
        print(f"[whatsapp] error messaging {to_number}: {e}")
        return False

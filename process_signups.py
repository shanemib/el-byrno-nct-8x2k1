"""
Sends the "confirm your email" verification message to anyone who just signed
up on the website but hasn't been emailed yet. Runs on its own frequent
schedule (see .github/workflows/process-signups.yml) so new subscribers get
their confirmation link quickly, without having to wait for the once-an-hour
availability checker.

ENVIRONMENT VARIABLES (set as GitHub Actions secrets, see SETUP.md):
    SUPABASE_URL               - e.g. https://xxxx.supabase.co
    SUPABASE_SERVICE_ROLE_KEY  - Supabase service_role secret key
    RESEND_API_KEY             - Resend API key
    RESEND_FROM                - verified sender, e.g. "NCT Alerts <alerts@yourdomain.com>"
    SITE_BASE_URL              - e.g. https://yourusername.github.io/el-byrno-nct-8x2k1
"""

import os

from supabase_utils import get_rows, patch_row
from resend_utils import send_email

SITE_BASE_URL = os.environ.get("SITE_BASE_URL", "").rstrip("/")


def build_verification_email(verify_link: str) -> tuple[str, str]:
    html = f"""
    <p>Thanks for signing up for NCT appointment alerts!</p>
    <p>Click below to confirm your email and start receiving alerts:</p>
    <p><a href="{verify_link}" style="display:inline-block;padding:10px 18px;
       background:#0b6e4f;color:#fff;text-decoration:none;border-radius:6px;">
       Confirm my email</a></p>
    <p>If you didn't sign up for this, you can just ignore this email.</p>
    """
    text = f"Confirm your NCT appointment alert subscription: {verify_link}\n\nIf you didn't sign up for this, ignore this email."
    return html, text


def main():
    pending = get_rows(
        "subscribers",
        {
            "verification_sent": "eq.false",
            "select": "id,email,verify_token",
        },
    )
    print(f"[signups] {len(pending)} pending verification email(s)")

    for row in pending:
        verify_link = f"{SITE_BASE_URL}/verify.html?token={row['verify_token']}"
        html, text = build_verification_email(verify_link)
        sent = send_email(
            to=row["email"],
            subject="Confirm your NCT appointment alert",
            html=html,
            text=text,
        )
        if sent:
            patch_row("subscribers", "id", row["id"], {"verification_sent": True})
        print(f"[signups] {row['email']}: sent={sent}")


if __name__ == "__main__":
    main()

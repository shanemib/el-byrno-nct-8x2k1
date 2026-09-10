"""
Runs only when the main "Run checker" step in nct-check.yml has just
failed (see the `if: failure()` step that calls this). A single failed
run is usually just a blip — a one-off ncts.ie hiccup, a flaky network
call — and isn't worth an email. This script looks at the workflow's own
recent run history via the GitHub API and only sends an alert email when
the failure is part of a real pattern: several in a row, or a high
failure rate over the last several runs.

This does NOT change whether the run shows as failed (red X) in the
Actions tab — that stays accurate. It only decides whether you get
emailed about it. For this to actually reduce the emails you get, you
also need to turn off GitHub's own default failure notification (see
SETUP.md), otherwise you'd get GitHub's email for every failure AND this
one for genuine streaks.

ENVIRONMENT VARIABLES (all provided automatically by the workflow step,
see nct-check.yml — no new secrets to create):
    GITHUB_TOKEN       - the run's own token; reading a public repo's own
                         run history needs no special secret
    GITHUB_REPOSITORY  - "owner/repo", set automatically by Actions
    WORKFLOW_FILE      - the workflow's filename, e.g. "nct-check.yml"
    GMAIL_USER / GMAIL_APP_PASSWORD - reused from resend_utils.py, to
                         email the alert to yourself (GMAIL_USER mails
                         GMAIL_USER — no separate "owner email" secret
                         needed)

THRESHOLDS — tune these two once you've seen how it behaves in practice:
"""

import os

import requests

from resend_utils import send_email

GITHUB_TOKEN = os.environ["GITHUB_TOKEN"]
REPO = os.environ["GITHUB_REPOSITORY"]
WORKFLOW_FILE = os.environ["WORKFLOW_FILE"]
GMAIL_USER = os.environ.get("GMAIL_USER", "")

# Alert if this many runs in a row have failed...
CONSECUTIVE_FAILURE_THRESHOLD = 3
# ...or if at least this fraction of the last LOOKBACK_RUNS runs failed.
LOOKBACK_RUNS = 10
FAILURE_RATE_THRESHOLD = 0.3  # 30%

API_URL = f"https://api.github.com/repos/{REPO}/actions/workflows/{WORKFLOW_FILE}/runs"


def get_recent_conclusions(n: int) -> list[str]:
    """Newest-first list of conclusions ("success"/"failure"/...) for the
    most recent completed runs of this workflow."""
    resp = requests.get(
        API_URL,
        params={"per_page": n},
        headers={
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=15,
    )
    resp.raise_for_status()
    runs = resp.json()["workflow_runs"]
    # Skip anything still in progress so it can't skew the count.
    return [r["conclusion"] for r in runs if r["status"] == "completed"]


def main():
    conclusions = get_recent_conclusions(max(LOOKBACK_RUNS, 20))

    consecutive = 0
    for c in conclusions:
        if c == "failure":
            consecutive += 1
        else:
            break

    window = conclusions[:LOOKBACK_RUNS]
    failure_rate = window.count("failure") / len(window) if window else 0

    print(
        f"[failure-check] {consecutive} consecutive failure(s); "
        f"{failure_rate:.0%} of the last {len(window)} run(s) failed"
    )

    should_alert = (
        consecutive >= CONSECUTIVE_FAILURE_THRESHOLD
        or failure_rate >= FAILURE_RATE_THRESHOLD
    )

    if not should_alert:
        print("[failure-check] looks like a one-off — not sending an alert")
        return

    if not GMAIL_USER:
        print("[failure-check] would have alerted, but GMAIL_USER isn't set")
        return

    reasons = []
    if consecutive >= CONSECUTIVE_FAILURE_THRESHOLD:
        reasons.append(f"{consecutive} failed runs in a row")
    if failure_rate >= FAILURE_RATE_THRESHOLD:
        reasons.append(f"{failure_rate:.0%} of the last {len(window)} runs failed")
    reason_text = " and ".join(reasons)

    actions_url = f"https://github.com/{REPO}/actions/workflows/{WORKFLOW_FILE}"
    subject = f"NCT checker: {reason_text}"
    body_text = (
        f"'{WORKFLOW_FILE}' has failed enough times in a row to be worth a look: "
        f"{reason_text}.\n\nActions history: {actions_url}"
    )
    body_html = (
        f"<p>'{WORKFLOW_FILE}' has failed enough times to be worth a look: "
        f"<strong>{reason_text}</strong>.</p>"
        f"<p><a href=\"{actions_url}\">View the Actions history</a></p>"
    )

    sent = send_email(to=GMAIL_USER, subject=subject, html=body_html, text=body_text)
    print(f"[failure-check] alert emailed={sent}")


if __name__ == "__main__":
    main()

"""
Tiny shared helper for talking to Supabase's auto-generated REST API
(PostgREST) using the SERVICE ROLE key. Only ever used from trusted,
server-side contexts (GitHub Actions) — the service role key bypasses
row-level security entirely, so it must never be put in the website's
frontend code (that uses the public anon key instead, which can only
call the restricted RPC functions defined in supabase_schema.sql).

ENVIRONMENT VARIABLES (set as GitHub Actions secrets):
    SUPABASE_URL              - e.g. https://xxxx.supabase.co
    SUPABASE_SERVICE_ROLE_KEY - the "service_role" secret key (NOT the anon key)
"""

import os
import time
import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

# Cloudflare sits in front of Supabase's API, and every so often it can't
# reach Supabase's own origin for a few seconds — reported as a 522
# ("connection timed out") or 524 ("a timeout occurred"), not a real
# problem with the request or the data. A handful of the plainer 5xx codes
# are just as likely to be a brief blip rather than something wrong with
# what we sent. Retrying a couple of times a few seconds apart clears most
# of these within the same run, instead of failing the whole job outright
# and either waiting ~10 minutes for the next scheduled run or tripping
# the failure-streak alert over what was really a few seconds of flakiness.
_RETRYABLE_STATUS_CODES = {500, 502, 503, 504, 522, 524}
_RETRY_ATTEMPTS = 3
_RETRY_DELAY_SECONDS = 5


def _headers(extra: dict | None = None) -> dict:
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


def configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def _request(method: str, url: str, **kwargs) -> requests.Response:
    """requests.request(), but retrying a transient-looking failure a
    couple of times before giving up. Raises requests.HTTPError (via
    raise_for_status) or the underlying connection error, exactly as
    before, once retries are exhausted — callers don't need to change."""
    last_exc: Exception | None = None
    for attempt in range(1, _RETRY_ATTEMPTS + 1):
        try:
            resp = requests.request(method, url, **kwargs)
        except requests.exceptions.RequestException as e:
            last_exc = e
            if attempt == _RETRY_ATTEMPTS:
                raise
            print(
                f"[supabase] {method} {url} failed (attempt {attempt}/{_RETRY_ATTEMPTS}): "
                f"{e} — retrying in {_RETRY_DELAY_SECONDS}s..."
            )
            time.sleep(_RETRY_DELAY_SECONDS)
            continue

        if resp.status_code in _RETRYABLE_STATUS_CODES and attempt < _RETRY_ATTEMPTS:
            print(
                f"[supabase] {method} {url} returned {resp.status_code} "
                f"(attempt {attempt}/{_RETRY_ATTEMPTS}) — retrying in {_RETRY_DELAY_SECONDS}s..."
            )
            time.sleep(_RETRY_DELAY_SECONDS)
            continue

        resp.raise_for_status()
        return resp

    # Unreachable in practice — the loop above always returns or raises —
    # but keeps type checkers happy and fails loudly if that ever changes.
    raise last_exc if last_exc else RuntimeError("_request: retry loop exited unexpectedly")


def get_rows(table: str, params: dict) -> list[dict]:
    """GET rows from a table. `params` are PostgREST query params,
    e.g. {"verified": "eq.true", "select": "id,email,centres"}."""
    if not configured():
        print("[supabase] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — skipping")
        return []
    resp = _request(
        "GET",
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_headers(),
        params=params,
        timeout=20,
    )
    return resp.json()


def insert_rows(table: str, rows: list[dict]) -> None:
    """Bulk-insert rows (a list of dicts, one per row)."""
    if not configured() or not rows:
        return
    _request(
        "POST",
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_headers({"Prefer": "return=minimal"}),
        json=rows,
        timeout=20,
    )


def patch_row(table: str, match_column: str, match_value: str, fields: dict) -> None:
    """PATCH the row(s) where match_column = match_value."""
    if not configured():
        return
    _request(
        "PATCH",
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_headers({"Prefer": "return=minimal"}),
        params={match_column: f"eq.{match_value}"},
        json=fields,
        timeout=20,
    )


def delete_row(table: str, match_column: str, match_value: str) -> None:
    """DELETE the row(s) where match_column = match_value."""
    if not configured():
        return
    _request(
        "DELETE",
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_headers({"Prefer": "return=minimal"}),
        params={match_column: f"eq.{match_value}"},
        timeout=20,
    )


def call_rpc(fn_name: str, args: dict):
    """Call a Postgres function via PostgREST's /rpc/ endpoint, using the
    service role key — same mechanism the website's anon-key callRpc() in
    app.js uses, just with elevated privileges for server-side-only
    functions like get_turnstile_verification()."""
    if not configured():
        return None
    resp = _request(
        "POST",
        f"{SUPABASE_URL}/rest/v1/rpc/{fn_name}",
        headers=_headers(),
        json=args,
        timeout=20,
    )
    return resp.json()

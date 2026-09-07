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
import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


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


def get_rows(table: str, params: dict) -> list[dict]:
    """GET rows from a table. `params` are PostgREST query params,
    e.g. {"verified": "eq.true", "select": "id,email,centres"}."""
    if not configured():
        print("[supabase] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — skipping")
        return []
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_headers(),
        params=params,
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


def patch_row(table: str, match_column: str, match_value: str, fields: dict) -> None:
    """PATCH the row(s) where match_column = match_value."""
    if not configured():
        return
    resp = requests.patch(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_headers({"Prefer": "return=minimal"}),
        params={match_column: f"eq.{match_value}"},
        json=fields,
        timeout=20,
    )
    resp.raise_for_status()

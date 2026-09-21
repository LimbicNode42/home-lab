#!/usr/bin/env python3
"""Refresh reviewed LSE public TIDM/ISIN mapping from a seed universe.

This uses the London Stock Exchange public API as an identifier source only. It
maps fail-closed: exact issuer-name key plus a unique ordinary-share instrument,
otherwise the row remains unmapped/ambiguous and is accounted for.

Robustness: the LSE public API intermittently resets connections mid-run. A
full 1,522-issuer pass takes ~40 minutes, so this tool checkpoints its
search/details cache to disk after every issuer and resumes from it on restart.
Transient fetch errors are retried with backoff; only after retries are
exhausted is a row recorded as a fetch error (still accounted, never guessed).
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("screener", ROOT / "screener.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load screener module from {ROOT / 'screener.py'}")
scr = importlib.util.module_from_spec(SPEC)
sys.modules["screener"] = scr
SPEC.loader.exec_module(scr)

HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Origin": "https://www.londonstockexchange.com",
    "Referer": "https://www.londonstockexchange.com/",
}

RETRY_ATTEMPTS = 4
RETRY_BACKOFF_BASE = 2.0  # seconds; exponential: 2, 4, 8, 16


def fetch_json(url: str, timeout: int = 20) -> dict:
    last_exc: Exception | None = None
    for attempt in range(RETRY_ATTEMPTS):
        try:
            request = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionError) as exc:
            last_exc = exc
            if attempt < RETRY_ATTEMPTS - 1:
                delay = RETRY_BACKOFF_BASE * (2 ** attempt)
                print(f"  retry {attempt + 1}/{RETRY_ATTEMPTS - 1} after {delay:.0f}s ({type(exc).__name__})", file=sys.stderr)
                time.sleep(delay)
    raise last_exc  # type: ignore[misc]


def search_lse(query: str, size: int = 10) -> list[dict]:
    url = scr.LSE_PUBLIC_API_SOURCE_URL + "?" + urllib.parse.urlencode({"q": query, "size": str(size)})
    payload = fetch_json(url)
    return list(payload.get("instruments") or [])


def instrument_details(tidm: str) -> dict:
    url = "https://api.londonstockexchange.com/api/gw/lse/instruments/alldata/" + urllib.parse.quote(tidm)
    return fetch_json(url)


def load_checkpoint(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf8"))
        except Exception:
            return {}
    return {}


def save_checkpoint(path: Path, search_results: dict, details: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps({"search_results": search_results, "details": details}, sort_keys=True) + "\n", encoding="utf8")
    tmp.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", default=str(ROOT / "universe" / "lse-listed-issuers.seed.json"))
    parser.add_argument("--output", default=str(ROOT / "universe" / "lse-public-symbol-mapping.seed.json"))
    parser.add_argument("--accounting-output", default=str(ROOT / "universe" / "lse-public-symbol-mapping.accounting.json"))
    parser.add_argument("--checkpoint", default=str(ROOT / "universe" / "lse-public-symbol-mapping.checkpoint.json"))
    parser.add_argument("--max-issuers", type=int, default=None, help="Optional bounded smoke limit")
    parser.add_argument("--start-offset", type=int, default=0, help="Zero-based seed offset for bounded smoke slices")
    parser.add_argument("--sleep-seconds", type=float, default=0.2)
    args = parser.parse_args()

    seed_payload = json.loads(Path(args.seed).read_text())
    seed_metadata = seed_payload.get("metadata") or {}
    entries = list(seed_payload.get("entries") or [])
    if args.start_offset:
        entries = entries[args.start_offset :]
    if args.max_issuers:
        entries = entries[: args.max_issuers]

    checkpoint_path = Path(args.checkpoint)
    checkpoint = load_checkpoint(checkpoint_path)
    search_results: dict[str, list[dict]] = checkpoint.get("search_results") or {}
    details: dict[str, dict] = checkpoint.get("details") or {}

    for index, entry in enumerate(entries, start=1):
        name = str(entry.get("name") or "").strip()
        query = name.casefold()
        if not name:
            search_results[query] = []
            save_checkpoint(checkpoint_path, search_results, details)
            continue
        if query in search_results:
            # Already resolved in a prior (resumed) pass; still refresh details if missing.
            rows = search_results[query]
        else:
            rows = search_lse(name)
            search_results[query] = rows
        seed_key = str(entry.get("name_match_key") or scr._slugify_identity(name)).strip()
        for row in rows:
            issuer_key = scr._slugify_identity(row.get("issuername") or row.get("issuerName") or "")
            if issuer_key != seed_key or row.get("islse") is False:
                continue
            tidm = str(row.get("tidm") or row.get("code") or "").strip().upper()
            if tidm and tidm not in details:
                try:
                    details[tidm] = instrument_details(tidm)
                except Exception as exc:  # keep mapping fail-closed/accounted
                    details[tidm] = {"tidm": tidm, "_fetch_error": scr._redact_secrets_in_text(str(exc))}
        save_checkpoint(checkpoint_path, search_results, details)
        if args.sleep_seconds and index != len(entries):
            time.sleep(args.sleep_seconds)
        if index % 100 == 0:
            print(f"mapped lookup {index}/{len(entries)} issuers", file=sys.stderr)

    retrieved_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    mapped_entries, report = scr.reconcile_lse_public_instruments(
        entries,
        search_results_by_query=search_results,
        instrument_details_by_tidm=details,
        retrieved_at=retrieved_at,
        seed_metadata=seed_metadata,
    )
    payload = {
        "metadata": {
            **seed_metadata,
            "schema_version": "investment-screener-lse-public-symbol-seed/v1",
            "retrieved_at": retrieved_at,
            "mapping_provider": "london_stock_exchange_public_api",
            "mapping_report": {
                key: report[key]
                for key in (
                    "seed_count", "mapped_count", "unmapped_count", "mapping_ambiguous_count",
                    "failed_count", "excluded_count", "accounted_seed_count", "unaccounted_seed_count",
                    "denominator_status", "provider_symbol_convention", "matching_rule",
                )
            },
            "provider_symbol_convention": scr.LSE_PUBLIC_YAHOO_CONVENTION,
            "denominator_status": report["denominator_status"],
        },
        "entries": mapped_entries,
    }
    Path(args.output).write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    Path(args.accounting_output).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps({k: report[k] for k in ("seed_count", "mapped_count", "unmapped_count", "mapping_ambiguous_count", "unaccounted_seed_count")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

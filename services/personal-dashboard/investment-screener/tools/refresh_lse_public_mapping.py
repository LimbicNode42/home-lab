#!/usr/bin/env python3
"""Refresh reviewed LSE public TIDM/ISIN mapping from a seed universe.

This uses the London Stock Exchange public API as an identifier source only. It
maps fail-closed: exact issuer-name key plus a unique ordinary-share instrument,
otherwise the row remains unmapped/ambiguous and is accounted for.
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import sys
import time
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


def fetch_json(url: str, timeout: int = 20) -> dict:
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def search_lse(query: str, size: int = 10) -> list[dict]:
    url = scr.LSE_PUBLIC_API_SOURCE_URL + "?" + urllib.parse.urlencode({"q": query, "size": str(size)})
    payload = fetch_json(url)
    return list(payload.get("instruments") or [])


def instrument_details(tidm: str) -> dict:
    url = "https://api.londonstockexchange.com/api/gw/lse/instruments/alldata/" + urllib.parse.quote(tidm)
    return fetch_json(url)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", default=str(ROOT / "universe" / "lse-listed-issuers.seed.json"))
    parser.add_argument("--output", default=str(ROOT / "universe" / "lse-public-symbol-mapping.seed.json"))
    parser.add_argument("--accounting-output", default=str(ROOT / "universe" / "lse-public-symbol-mapping.accounting.json"))
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

    search_results: dict[str, list[dict]] = {}
    details: dict[str, dict] = {}
    for index, entry in enumerate(entries, start=1):
        name = str(entry.get("name") or "").strip()
        query = name.casefold()
        if not name:
            search_results[query] = []
            continue
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

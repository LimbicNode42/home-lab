"""
screener.py
===========
ASX-first investment screener: universe hydration, scoring, and sanitized export.

Ported and adapted from the operator prototype (see architecture spec t_74d7361d).

Key design decisions (from architecture spec t_74d7361d):
  - Yahoo chart + fundamentals-timeseries as bootstrap data source; unofficial, verify.
  - Every field has provenance: source_url, retrieved_at, data_as_of, freshness label.
  - Missing fields -> missing FieldValue; never imputed.
  - Dashboard export is sanitized: no raw provider payloads, paths, or secrets.
  - ASX tickers use Yahoo .AX suffix (e.g. BHP.AX).

Usage (CLI):
  python3 screener.py --asx-watchlist universe/asx-watchlist.json \\
                      --output-dir /tmp/screener-out

Usage (library):
  from screener import hydrate_companies_from_asx_tickers, rank_companies, ...
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import random
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional
import urllib.parse
import urllib.request
import urllib.error


# ---------------------------------------------------------------------------
# Field types and schema
# ---------------------------------------------------------------------------

RAW_FIELDS = [
    "price", "shares_outstanding", "revenue", "prior_revenue",
    "net_income", "operating_cash_flow", "capital_expenditures",
    "total_assets", "total_liabilities", "current_assets", "current_liabilities",
]

DERIVED_INPUTS = {
    "market_cap": ["price", "shares_outstanding"],
    "pe_ratio": ["price", "shares_outstanding", "net_income"],
    "price_to_sales": ["price", "shares_outstanding", "revenue"],
    "net_margin": ["net_income", "revenue"],
    "roe": ["net_income", "total_assets", "total_liabilities"],
    "current_ratio": ["current_assets", "current_liabilities"],
    "debt_to_assets": ["total_liabilities", "total_assets"],
    "fcf": ["operating_cash_flow", "capital_expenditures"],
    "fcf_margin": ["operating_cash_flow", "capital_expenditures", "revenue"],
    "revenue_growth": ["revenue", "prior_revenue"],
}

# Yahoo fundamentals-timeseries type names for each field
YAHOO_FIELD_TYPES = {
    "revenue": "annualTotalRevenue",
    "net_income": "annualNetIncome",
    "operating_cash_flow": "annualOperatingCashFlow",
    "capital_expenditures": "annualCapitalExpenditure",
    "total_assets": "annualTotalAssets",
    "total_liabilities": "annualTotalLiabilitiesNetMinorityInterest",
    "current_assets": "annualCurrentAssets",
    "current_liabilities": "annualCurrentLiabilities",
    "shares_outstanding": "annualDilutedAverageShares",
}

FILTER_FIELDS = ("market", "exchange", "region", "sector", "industry")

# --- Partial hydration (three-tier coverage) -------------------------------------------------
# A "partially hydrated" name has fresh income/valuation inputs (price, shares,
# revenue, prior_revenue, net_income) but is missing >=1 cash-flow/balance-sheet
# field. It is scored on a capped, renormalized composite and surfaced in its own
# bucket, never interleaved with fully-scored candidates. Missing values are never
# imputed. See docs: asx-partial-scoring-policy-2026-09-01.md

CORE_INCOME_FIELDS = ("price", "shares_outstanding", "revenue", "prior_revenue", "net_income")
BALANCE_CASHFLOW_FIELDS = (
    "operating_cash_flow", "capital_expenditures", "total_assets",
    "total_liabilities", "current_assets", "current_liabilities",
)

# Each composite sub-score category's primary derived-metric inputs. A category is
# "live" (included in the partial denominator) when >=1 of these is present; it is
# suppressed only when ALL of them are missing.
SUBSCORE_METRIC_INPUTS = {
    "quality": ("net_margin", "roe", "fcf"),
    "valuation": ("pe_ratio", "price_to_sales"),
    "growth": ("revenue_growth",),
    "graham_safety": ("current_ratio", "debt_to_assets"),
    "durability": ("net_margin", "fcf"),
    "risk_adjustments": ("debt_to_assets",),
}

PARTIAL_BUCKET_CAVEAT = (
    "Partial score is capped and not comparable to a full candidate score; "
    "verify against ASX announcements and company reports."
)

DASHBOARD_EXPORT_LIMITATIONS = [
    "Candidates are for human investigation only; not recommendations, ratings, trading signals, or financial advice.",
    "Coverage is incomplete; ASX bootstrap uses Yahoo chart and fundamentals-timeseries (unofficial endpoint).",
    "Yahoo fundamentals-timeseries values should be verified against ASX announcements and company reports.",
    "Coverage may mix markets/currencies without FX normalization.",
]


# ---------------------------------------------------------------------------
# Core primitives
# ---------------------------------------------------------------------------

@dataclass
class FieldValue:
    """A single financial/operational field with full provenance."""
    value: Optional[float]
    provenance: dict


# ---------------------------------------------------------------------------
# Config and watchlist
# ---------------------------------------------------------------------------

def load_config(path: Path) -> dict:
    try:
        import yaml
        with open(path) as fh:
            return yaml.safe_load(fh)
    except ImportError:
        pass
    # Minimal YAML-ish fallback for simple key: value configs
    result: dict = {}
    current_section: Optional[str] = None
    with open(path) as fh:
        for raw in fh:
            line = raw.rstrip()
            if not line or line.startswith("#"):
                continue
            if not line.startswith(" "):
                if ":" in line:
                    key, _, val = line.partition(":")
                    val = val.strip()
                    if val:
                        try:
                            result[key.strip()] = int(val)
                        except ValueError:
                            try:
                                result[key.strip()] = float(val)
                            except ValueError:
                                result[key.strip()] = val
                    else:
                        current_section = key.strip()
                        result[current_section] = {}
            elif current_section and ":" in line:
                key, _, val = line.strip().partition(":")
                val = val.strip()
                try:
                    result[current_section][key.strip()] = int(val)
                except ValueError:
                    try:
                        result[current_section][key.strip()] = float(val)
                    except ValueError:
                        result[current_section][key.strip()] = val
    return result


def load_asx_watchlist(path: Path) -> list[dict]:
    """Load ASX watchlist from a JSON file. Returns a list of company dicts."""
    with open(path) as fh:
        data = json.load(fh)
    if not isinstance(data, list):
        raise ValueError(f"Watchlist at {path} must be a JSON array; got {type(data)}")
    return data


ASX_DIRECTORY_SOURCE_URL = "https://asx.api.markitdigital.com/asx-research/1.0/companies/directory/file"
ASX_CODE_RE = re.compile(r"^[A-Z0-9]{2,6}$")
ASX_UNIVERSE_SEED_SCHEMA_VERSION = "investment-screener-asx-universe-seed/v2"
ASX_IDENTITY_RULE = "company_id=asx:{asx_code}; yahoo_ticker={asx_code}.AX"

# --- US (first non-ASX market) identity constants -------------------------------------------
# Ticker suffix is `.US` for EODHD (unlike Yahoo's bare NASDAQ/NYSE symbols). A
# bounded curated universe (S&P 500 constituents) is the honest denominator for
# the first US backfill — NOT the full NYSE/NASDAQ ordinary-share list (~7000).
US_UNIVERSE_SEED_SCHEMA_VERSION = "investment-screener-us-universe-seed/v1"
US_IDENTITY_RULE = "company_id=us:{us_code}; eodhd_ticker={us_code}.US"
US_DEFAULT_SECURITY_TYPE = "unknown_from_eodhd_general"
US_DENOMINATOR_LABEL = "S&P 500 constituents (reviewed static seed)"
NASDAQ_UNIVERSE_SEED_SCHEMA_VERSION = "investment-screener-nasdaq-universe-seed/v2"
NASDAQ_IDENTITY_RULE = "company_id=nasdaq:{us_code}; eodhd_ticker={us_code}.US; exchange=NASDAQ"
NASDAQ_DENOMINATOR_LABEL = "NASDAQ listed equities (security-type-filtered, reviewed static seed)"
NASDAQ_MODE = "nasdaq-eodhd-fundamentals"
NASDAQ_SOURCE_NAME = "NASDAQ Trader listed securities (nasdaqlisted.txt)"
NASDAQ_SOURCE_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"
NASDAQ_EQUITY_SECURITY_TYPE = "nasdaq_listed_equity"
# Security-type filter for the reviewed FULL NASDAQ listing (not a bounded
# top-N sample). Excludes ETFs, exchange test/simulator symbols, and non-equity
# instruments (warrants, rights, SPAC/SPAC-like units, preferred/depositary
# shares, notes, ETNs). Word-bounded so company names like ``United``/``Unit``/
# ``Notion`` are NOT misread as ``Unit``/``Note`` securities.
#
# Legitimate operating MLP/partnership common units are kept as listed equity per
# the NASDAQ denominator prose. Generic acquisition-company ``Units`` remain
# excluded; this avoids hiding the MLP delta in an undocumented count mismatch.
NASDAQ_NON_EQUITY_TOKEN_RE = re.compile(
    r"\b(Warrants?|Rights?|Units?|Preferred|Notes?|ETN)\b", re.IGNORECASE
)
NASDAQ_OPERATING_PARTNERSHIP_COMMON_UNITS_RE = re.compile(
    r"\bCommon Units?\b.*\b(L\.?P\.?|Limited Partners?|Limited Partnership|Partners|Partnership)\b",
    re.IGNORECASE,
)
US_EODHD_MODE = "us-eodhd-fundamentals"


def _market_for_mode(mode: str) -> str:
    if mode == NASDAQ_MODE:
        return "NASDAQ"
    if mode == US_EODHD_MODE:
        return "US"
    return "ASX"


def _parse_market_cap(value: Any) -> Optional[int]:
    text = str(value or "").strip().replace(",", "")
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def _parse_asx_listing_date(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if not text:
        return None
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%b-%Y"):
        try:
            return datetime.datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    return text


def _normalise_asx_company_name(value: Any) -> str:
    """Return a stable display/match form for ASX directory company names."""
    text = str(value or "").strip()
    text = re.sub(r"\s+", " ", text)
    return text.upper()


def _asx_company_id(code: str) -> str:
    return f"asx:{code}"


def normalise_asx_directory_rows(
    rows: list[dict],
    source_url: str,
    retrieved_at: str,
    csv_sha256: str,
) -> tuple[list[dict], dict]:
    """Normalize ASX company-directory CSV rows into reviewed v2 seed entries."""
    entries: list[dict] = []
    excluded: list[dict] = []
    seen_codes: set[str] = set()
    seen_tickers: set[str] = set()
    row_count = len(rows)
    public_source_url = redact_url_secrets(source_url)
    source = {
        "name": "ASX company directory CSV",
        "url": public_source_url,
        "retrieved_at": retrieved_at,
        "sha256": csv_sha256,
        "row_count": row_count,
    }
    for row in rows:
        code = str(row.get("ASX code") or "").strip().upper()
        if not code or not ASX_CODE_RE.match(code):
            excluded.append({"asx_code": code, "reason": "missing or invalid ASX code"})
            continue
        ticker = f"{code}.AX"
        if code in seen_codes:
            raise ValueError(f"Duplicate ASX code in universe source: {code}")
        if ticker in seen_tickers:
            raise ValueError(f"Duplicate Yahoo ticker in universe source: {ticker}")
        seen_codes.add(code)
        seen_tickers.add(ticker)

        industry_group = str(row.get("GICs industry group") or "").strip() or None
        name_raw = str(row.get("Company name") or code).strip() or code
        name_normalized = _normalise_asx_company_name(name_raw)
        entry = {
            "company_id": _asx_company_id(code),
            "ticker": ticker,
            "asx_code": code,
            "name": name_raw,
            "name_raw": name_raw,
            "name_normalized": name_normalized,
            "market": "ASX",
            "exchange": "ASX",
            "region": "AU",
            "sector": industry_group,
            "industry": industry_group,
            "listing_date": _parse_asx_listing_date(row.get("Listing date")),
            "market_cap": _parse_market_cap(row.get("Market Cap")),
            "currency": "AUD",
            "security_type": "unknown_from_asx_directory",
            "active": True,
            "suspended": False,
            "delisted": False,
            "source": source,
        }
        entries.append(entry)

    entries.sort(key=lambda entry: (entry["market_cap"] is None, -(entry["market_cap"] or 0), entry["asx_code"]))
    for index, entry in enumerate(entries, start=1):
        entry["universe_rank"] = index

    metadata = {
        "schema_version": ASX_UNIVERSE_SEED_SCHEMA_VERSION,
        "source_name": source["name"],
        "source_url": public_source_url,
        "retrieved_at": retrieved_at,
        "source_sha256": csv_sha256,
        "sha256": csv_sha256,
        "source_row_count": row_count,
        "row_count": row_count,
        "normalized_active_count": len(entries),
        "excluded_count": len(excluded),
        "excluded": excluded,
        "sort_rule": "market_cap_desc_nulls_last_then_asx_code_asc",
        "identity_rule": ASX_IDENTITY_RULE,
        "security_type_source": "ASX directory does not provide security type; defaults to unknown_from_asx_directory",
        "generated_by": "investment-screener/screener.py normalise_asx_directory_rows",
    }
    return entries, metadata


def load_asx_universe_seed(path: Path) -> dict:
    """Load a wrapped reviewed ASX universe seed, with legacy array support."""
    with open(path, encoding="utf8") as fh:
        data = json.load(fh)
    if isinstance(data, list):
        return {"metadata": {"seed_path": str(path)}, "entries": data}
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        raise ValueError(f"ASX universe seed at {path} must contain an entries array")
    metadata = dict(data.get("metadata") or {})
    metadata.setdefault("seed_path", str(path))
    return {"metadata": metadata, "entries": data["entries"]}


def select_asx_universe_batch(
    entries: list[dict],
    batch_offset: int = 0,
    max_tickers: Optional[int] = None,
    include_security_types: Optional[set[str] | list[str] | tuple[str, ...]] = None,
    exclude_security_types: Optional[set[str] | list[str] | tuple[str, ...]] = None,
    denominator_label: Optional[str] = None,
) -> dict:
    """Select a deterministic active ASX universe slice and return accounting metadata."""
    if batch_offset < 0:
        raise ValueError("batch_offset must be non-negative")
    if max_tickers is not None and max_tickers < 1:
        raise ValueError("max_tickers must be at least 1")

    active = sorted(
        [entry for entry in entries if entry.get("active") and entry.get("ticker")],
        key=lambda entry: (int(entry.get("universe_rank") or 999999), str(entry.get("ticker"))),
    )
    include = {str(t).lower() for t in include_security_types or []}
    exclude = {str(t).lower() for t in exclude_security_types or []}

    def security_type(entry: dict) -> str:
        return str(entry.get("security_type") or "unknown_from_asx_directory").lower()

    eligible = [
        entry for entry in active
        if (not include or security_type(entry) in include) and security_type(entry) not in exclude
    ]
    full_count = len(active)
    eligible_count = len(eligible)
    end = eligible_count if max_tickers is None else min(eligible_count, batch_offset + max_tickers)
    selected = eligible[batch_offset:end]
    complete = batch_offset == 0 and end >= eligible_count
    security_filtered = bool(include or exclude)
    if security_filtered and complete:
        status = "complete_security_type_filtered_listing"
    elif complete:
        status = "complete_exchange_listing"
    else:
        status = "ranked_market_cap_batch"
    security_type_filter = sorted(include) if include else None
    excluded_security_type_count = full_count - eligible_count if security_filtered else 0
    return {
        "entries": selected,
        "tickers": [str(entry["ticker"]) for entry in selected],
        "full_count": full_count,
        "eligible_count": eligible_count,
        "selected_count": len(selected),
        "batch_offset": batch_offset,
        "batch_end_exclusive": end,
        "complete_exchange_listing": complete and not security_filtered,
        "complete_security_type_filtered_listing": complete and security_filtered,
        "denominator_status": status,
        "denominator_label": denominator_label,
        "security_type_filter": security_type_filter,
        "exclude_security_types": sorted(exclude) if exclude else None,
        "excluded_security_type_count": excluded_security_type_count,
    }


def build_universe_version(metadata: dict) -> str:
    """Build a public, path-free seed version label.

    Embeds only the content hash and a human-readable source label, never a
    filesystem path, so published provenance stays machine-independent and
    reproducible. The label comes from the seed's own ``denominator_label``
    (e.g. "S&P 500 constituents (reviewed static seed)") with ``source_name``
    as an honest fallback for seeds that carry no explicit denominator label.
    """
    sha = metadata.get("sha256") or metadata.get("source_sha256") or "unknown"
    retrieved = metadata.get("retrieved_at") or "unknown"
    label = metadata.get("denominator_label") or metadata.get("source_name") or "reviewed static seed"
    return f"{label} sha256:{sha} retrieved_at:{retrieved}"


def parse_security_type_list(value: Optional[str]) -> Optional[list[str]]:
    """Parse comma-separated security type filters into lower-case labels."""
    if value is None:
        return None
    parsed = [item.strip().lower() for item in value.split(",") if item.strip()]
    return parsed or None


def apply_asx_seed_identity(companies: list[dict], seed_entries: list[dict]) -> list[dict]:
    """Overlay reviewed seed identity fields onto hydrated provider company rows."""
    by_ticker = {normalise_asx_ticker(str(entry.get("ticker"))): entry for entry in seed_entries if entry.get("ticker")}
    identity_fields = (
        "company_id", "asx_code", "name_raw", "name_normalized", "exchange", "region",
        "sector", "industry", "security_type", "active", "suspended", "delisted",
    )
    enriched: list[dict] = []
    for company in companies:
        merged = dict(company)
        seed = by_ticker.get(normalise_asx_ticker(str(company.get("ticker") or "")))
        if seed:
            for field in identity_fields:
                if seed.get(field) is not None:
                    merged[field] = seed[field]
        enriched.append(merged)
    return enriched


def select_active_asx_tickers(watchlist: list[dict], max_tickers: Optional[int] = None) -> list[str]:
    """Return active ASX ticker strings from a watchlist, optionally bounded."""
    tickers = [str(entry["ticker"]) for entry in watchlist if entry.get("active") and entry.get("ticker")]
    if max_tickers is not None:
        if max_tickers < 1:
            raise ValueError("max_tickers must be at least 1")
        return tickers[:max_tickers]
    return tickers


# ---------------------------------------------------------------------------
# ASX ticker normalisation
# ---------------------------------------------------------------------------

def normalise_asx_ticker(ticker: str) -> str:
    """Append .AX to bare ASX codes; normalise existing .AX tickers to uppercase."""
    upper = ticker.upper()
    if upper.endswith(".AX"):
        return upper
    return upper + ".AX"


def normalise_us_ticker(ticker: str) -> str:
    """Append .US to bare US symbols; normalise existing .US tickers to uppercase.

    Accepts bare symbols (``AAPL``), an explicit EODHD suffix (``AAPL.US``), or a
    dual-class symbol (``BF.B``, ``BRK.B``). Unlike ASX, the normalized form always
    ends in ``.US`` because that is the EODHD fundamentals symbol contract.

    Dual-class US shares use a hyphen (not a dot) in the EODHD and Yahoo symbol
    contract: ``BF.B`` -> ``BF-B.US``, ``BRK.B`` -> ``BRK-B.US``. The class dot is
    therefore rewritten to a hyphen rather than dropped, so a dual-class symbol is
    never collapsed to its base root (``BF``/``BRK``), which 404s on both providers.
    """
    upper = str(ticker or "").strip().upper()
    if not upper:
        return ""
    # Strip a pre-existing .US suffix so a class dot inside the bare symbol (the
    # segment between root and .US) is normalized rather than misread as the
    # suffix delimiter.
    body = upper[:-3] if upper.endswith(".US") else upper
    # Any remaining dot is a dual-class delimiter (BF.B -> BF-B), the canonical
    # EODHD/Yahoo form.
    if "." in body:
        body = body.replace(".", "-")
    return body + ".US"


def _us_code_from_ticker(ticker: str) -> str:
    """Return the bare exchange symbol (Yahoo form) for a US ticker.

    Strips the trailing ``.US`` and preserves a dual-class hyphen, so the Yahoo
    chart-quote symbol is the exchange-correct ``BF-B``/``BRK-B`` rather than the
    collapsed root ``BF``/``BRK``. Yahoo accepts neither ``BF.B`` nor ``BF-B.US``.
    """
    normalised = normalise_us_ticker(ticker)
    if normalised.endswith(".US"):
        return normalised[:-3]
    return normalised


def _us_company_id(code: str) -> str:
    return f"us:{code}"


def _nasdaq_company_id(code: str) -> str:
    return f"nasdaq:{code}"


def _normalise_us_company_name(value: Any) -> str:
    """Return a stable display/match form for US company names (mirrors ASX rule)."""
    text = str(value or "").strip()
    text = re.sub(r"\s+", " ", text)
    return text.upper()


def _titlecase_us_classification(value: Any) -> Optional[str]:
    """Title-case a sector/industry label, preserving embedded commas/punctuation.

    EODHD ``General`` can return names with commas (e.g. ``Technology Hardware,
    Storage & Peripherals``) which must round-trip intact through JSON. We only
    normalize surrounding whitespace and word casing, never split on commas.
    """
    text = str(value or "").strip()
    if not text:
        return None
    text = re.sub(r"\s+", " ", text)
    return re.sub(r"[A-Za-z]+", lambda m: m.group(0).capitalize(), text)


# ---------------------------------------------------------------------------
# US universe seed (first non-ASX market)
# ---------------------------------------------------------------------------

US_CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,9}$")
# Exchange test/simulator symbols with a dot/hyphen suffix (e.g. NASDAQ
# ``ZXYZ.A``, ``ZXYZ-$``). Mirrors the reviewed source spec's ``^Z[A-Z]{3}[.$]``
# guard; bare ``Z``-prefixed operating names (``ZION``, ``ZTS``, ``ZYME``) are NOT
# matched. The primary test-issue filter is the ``Test Issue`` flag; this only
# defensively drops dotted/suffixed test symbols.
US_TEST_SYMBOL_RE = re.compile(r"^Z[A-Z]{3}[.$]")


def normalise_us_universe_rows(
    rows: list[dict],
    source_url: str,
    retrieved_at: str,
    source_sha256: str,
) -> tuple[list[dict], dict]:
    """Normalize a curated US universe source (e.g. S&P 500 constituents) into v1 seed entries.

    Accepts rows carrying ``Code``/``Symbol`` (the bare ticker), optional
    ``Name``/``Company``, ``Sector``, ``Industry``, ``Exchange``, ``CurrencyCode``/
    ``Currency`` and ``CountryISO``/``Market``. Every normalized entry is active
    and typed ``unknown_from_eodhd_general`` until EODHD ``General`` supplies the
    authoritative sector/industry/name. Derives the EODHD symbol as ``{Code}.US``.
    """
    entries: list[dict] = []
    excluded: list[dict] = []
    seen_codes: set[str] = set()
    seen_tickers: set[str] = set()
    row_count = len(rows)
    public_source_url = redact_url_secrets(source_url)
    source = {
        "name": "US curated universe (S&P 500 constituents)",
        "url": public_source_url,
        "retrieved_at": retrieved_at,
        "sha256": source_sha256,
        "row_count": row_count,
    }
    for row in rows:
        if not isinstance(row, dict):
            excluded.append({"reason": "row is not an object"})
            continue
        code = str(row.get("Code") or row.get("Symbol") or row.get("code") or "").strip().upper()
        if not code or not US_CODE_RE.match(code):
            excluded.append({"code": code, "reason": "missing or invalid US symbol"})
            continue
        ticker = normalise_us_ticker(code)
        if code in seen_codes:
            raise ValueError(f"Duplicate US symbol in universe source: {code}")
        if ticker in seen_tickers:
            raise ValueError(f"Duplicate EODHD ticker in universe source: {ticker}")
        seen_codes.add(code)
        seen_tickers.add(ticker)
        name_raw = str(row.get("Name") or row.get("Company") or code).strip() or code
        sector = _titlecase_us_classification(row.get("Sector")) or _titlecase_us_classification(row.get("GicSector"))
        industry = _titlecase_us_classification(row.get("Industry")) or _titlecase_us_classification(row.get("GicIndustry"))
        currency = str(row.get("CurrencyCode") or row.get("Currency") or "USD").strip().upper()
        exchange = str(row.get("Exchange") or "").strip().upper() or None
        entry = {
            "company_id": _us_company_id(code),
            "ticker": ticker,
            "us_code": code,
            "name": name_raw,
            "name_raw": name_raw,
            "name_normalized": _normalise_us_company_name(name_raw),
            "market": "US",
            "exchange": exchange,
            "region": "US",
            "sector": sector,
            "industry": industry,
            "currency": currency,
            "security_type": US_DEFAULT_SECURITY_TYPE,
            "active": True,
            "suspended": False,
            "delisted": False,
            "source": source,
        }
        entries.append(entry)
    source_market_cap_note = "US seed does not carry market-cap ranking; entries sort by symbol"
    entries.sort(key=lambda entry: str(entry["us_code"]))
    for index, entry in enumerate(entries, start=1):
        entry["universe_rank"] = index
    metadata = {
        "schema_version": US_UNIVERSE_SEED_SCHEMA_VERSION,
        "source_name": source["name"],
        "source_url": public_source_url,
        "retrieved_at": retrieved_at,
        "source_sha256": source_sha256,
        "sha256": source_sha256,
        "source_row_count": row_count,
        "row_count": row_count,
        "normalized_active_count": len(entries),
        "excluded_count": len(excluded),
        "excluded": excluded,
        "sort_rule": "symbol_asc",
        "identity_rule": US_IDENTITY_RULE,
        "denominator_label": US_DENOMINATOR_LABEL,
        "security_type_source": source_market_cap_note,
        "generated_by": "investment-screener/screener.py normalise_us_universe_rows",
    }
    return entries, metadata


def load_us_universe_seed(path: Path) -> dict:
    """Load a wrapped reviewed US universe seed, with legacy array support."""
    with open(path, encoding="utf8") as fh:
        data = json.load(fh)
    if isinstance(data, list):
        return {"metadata": {"seed_path": str(path)}, "entries": data}
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        raise ValueError(f"US universe seed at {path} must contain an entries array")
    metadata = dict(data.get("metadata") or {})
    metadata.setdefault("seed_path", str(path))
    return {"metadata": metadata, "entries": data["entries"]}


def select_us_universe_batch(
    entries: list[dict],
    batch_offset: int = 0,
    max_tickers: Optional[int] = None,
    denominator_label: Optional[str] = None,
) -> dict:
    """Select a deterministic active US universe slice and return accounting metadata."""
    if batch_offset < 0:
        raise ValueError("batch_offset must be non-negative")
    if max_tickers is not None and max_tickers < 1:
        raise ValueError("max_tickers must be at least 1")
    active = sorted(
        [entry for entry in entries if entry.get("active") and entry.get("ticker")],
        key=lambda entry: (int(entry.get("universe_rank") or 999999), str(entry.get("ticker"))),
    )
    full_count = len(active)
    end = full_count if max_tickers is None else min(full_count, batch_offset + max_tickers)
    selected = active[batch_offset:end]
    complete = batch_offset == 0 and end >= full_count
    status = "complete_exchange_listing" if complete else "ranked_market_cap_batch"
    return {
        "entries": selected,
        "tickers": [str(entry["ticker"]) for entry in selected],
        "full_count": full_count,
        "eligible_count": full_count,
        "selected_count": len(selected),
        "batch_offset": batch_offset,
        "batch_end_exclusive": end,
        "complete_exchange_listing": complete,
        "complete_security_type_filtered_listing": False,
        "denominator_status": status,
        "denominator_label": denominator_label or US_DENOMINATOR_LABEL,
        "security_type_filter": None,
        "exclude_security_types": None,
        "excluded_security_type_count": 0,
    }




def _nasdaq_row_symbol(row: dict) -> str:
    return str(
        row.get("Symbol")
        or row.get("symbol")
        or row.get("Code")
        or row.get("code")
        or ""
    ).strip()


def parse_nasdaq_listed_file(body: bytes) -> tuple[list[dict], dict]:
    """Parse the pipe-delimited ``nasdaqlisted.txt`` listing into rows + provenance.

    The file is ``Symbol|Security Name|Market Category|Test Issue|Financial
    Status|Round Lot Size|ETF|NextShares`` with a trailing ``File Creation Time``
    footer. Returns ``(rows, file_meta)`` where ``file_meta`` carries the parsed
    refresh timestamp (the ``File Creation Time`` footer) rather than any host
    path, so provenance stays machine-independent.
    """
    text = body.decode("utf-8-sig")
    lines = [line for line in text.replace("\r\n", "\n").split("\n")]
    if not lines:
        raise ValueError("NASDAQ Trader listing is empty")
    header = lines[0].split("|")
    columns = ["Symbol", "Security Name", "Market Category", "Test Issue", "Financial Status", "Round Lot Size", "ETF", "NextShares"]
    if header != columns:
        raise ValueError(f"Unexpected NASDAQ Trader header: {header!r}")
    file_creation_time = None
    rows: list[dict] = []
    for line in lines[1:]:
        if not line.strip():
            continue
        if line.startswith("File Creation Time"):
            value = line.split(":", 1)[1].split("|", 1)[0].strip()
            file_creation_time = value or None
            continue
        parts = line.split("|")
        if len(parts) != len(columns):
            raise ValueError(f"Malformed NASDAQ Trader row (expected {len(columns)} fields): {line[:80]!r}")
        rows.append(dict(zip(columns, parts)))
    return rows, {"file_creation_time": file_creation_time}


def classify_nasdaq_listed_row(row: dict) -> str:
    """Classify a ``nasdaqlisted.txt`` row for the full-universe equity filter.

    Returns ``"etf"``, ``"test_issue"``, a ``non_equity:<token>`` reason, or
    ``"equity_kept"``. Order and semantics follow the reviewed source spec
    (t_e4b82658): drop ETFs and exchange test/simulator symbols, then drop
    non-equity security types (warrants, rights, units, preferred, notes, ETNs)
    via a word-bounded token match so issuer names are not misread. A name
    carrying operating MLP/partnership Common Units is kept as listed equity.
    """
    if str(row.get("ETF") or "").strip().upper() == "Y":
        return "etf"
    if str(row.get("Test Issue") or "").strip().upper() == "Y":
        return "test_issue"
    security_name = str(row.get("Security Name") or "")
    if NASDAQ_OPERATING_PARTNERSHIP_COMMON_UNITS_RE.search(security_name):
        return "equity_kept"
    match = NASDAQ_NON_EQUITY_TOKEN_RE.search(security_name)
    if match:
        return f"non_equity:{match.group(1).lower()}"
    return "equity_kept"


def normalise_nasdaq_universe_rows(
    rows: list[dict],
    source_url: str,
    retrieved_at: str,
    source_sha256: str,
    file_creation_time: Optional[str] = None,
) -> tuple[list[dict], dict]:
    """Normalize the reviewed FULL NASDAQ listed-securities listing into v2 entries.

    NASDAQ keeps explicit user-facing exchange semantics while reusing the EODHD
    US fundamentals symbol contract: provider tickers are ``{symbol}.US`` and the
    inherited hyphen form applies to any (currently-nonexistent) dotted symbol.

    This is the full ``nasdaqlisted.txt`` directory, security-type filtered to
    equity: ETFs, exchange test/simulator symbols, and non-equity instruments
    (warrants/rights/units/preferred/notes/ETNs) are excluded, while legitimate
    operating MLP/partnership Common Units are kept, so the emitted denominator
    is honestly ``complete_security_type_filtered_listing`` rather than a
    bounded/sample label. ``nasdaqlisted.txt`` carries no sector/industry
    columns — those arrive from EODHD ``General`` at hydration time — so entries
    leave them ``None`` and carry the listing's ``Financial Status`` flag.
    """
    entries: list[dict] = []
    excluded: list[dict] = []
    seen_codes: set[str] = set()
    seen_tickers: set[str] = set()
    row_count = len(rows)
    public_source_url = redact_url_secrets(source_url)
    source = {
        "name": NASDAQ_SOURCE_NAME,
        "url": public_source_url,
        "retrieved_at": retrieved_at,
        "sha256": source_sha256,
        "row_count": row_count,
    }
    for row in rows:
        if not isinstance(row, dict):
            excluded.append({"reason": "row is not an object"})
            continue
        classification = classify_nasdaq_listed_row(row)
        if classification != "equity_kept":
            excluded.append({"code": _nasdaq_row_symbol(row), "reason": classification})
            continue
        raw_code = _nasdaq_row_symbol(row).upper()
        if not raw_code or not US_CODE_RE.match(raw_code):
            excluded.append({"code": raw_code, "reason": "missing or invalid NASDAQ symbol"})
            continue
        if US_TEST_SYMBOL_RE.search(raw_code):
            excluded.append({"code": raw_code, "reason": "exchange test/simulator symbol prefix"})
            continue
        ticker = normalise_us_ticker(raw_code)
        us_code = _us_code_from_ticker(ticker)
        if us_code in seen_codes:
            raise ValueError(f"Duplicate NASDAQ symbol in universe source: {us_code}")
        if ticker in seen_tickers:
            raise ValueError(f"Duplicate EODHD ticker in NASDAQ universe source: {ticker}")
        seen_codes.add(us_code)
        seen_tickers.add(ticker)
        name_raw = str(row.get("Security Name") or row.get("Company Name") or row.get("companyName") or us_code).strip() or us_code
        financial_status = str(row.get("Financial Status") or "").strip().upper() or None
        entry = {
            "company_id": _nasdaq_company_id(us_code),
            "ticker": ticker,
            "us_code": us_code,
            "name": name_raw,
            "name_raw": name_raw,
            "name_normalized": _normalise_us_company_name(name_raw),
            "market": "NASDAQ",
            "exchange": "NASDAQ",
            "region": "US",
            "sector": None,
            "industry": None,
            "currency": "USD",
            "security_type": NASDAQ_EQUITY_SECURITY_TYPE,
            "financial_status": financial_status,
            "active": True,
            "suspended": False,
            "delisted": False,
            "source": source,
        }
        entries.append(entry)
    entries.sort(key=lambda entry: str(entry["us_code"]))
    for index, entry in enumerate(entries, start=1):
        entry["universe_rank"] = index
    metadata = {
        "schema_version": NASDAQ_UNIVERSE_SEED_SCHEMA_VERSION,
        "source_name": source["name"],
        "source_url": public_source_url,
        "retrieved_at": retrieved_at,
        "source_sha256": source_sha256,
        "sha256": source_sha256,
        "source_row_count": row_count,
        "row_count": row_count,
        "normalized_active_count": len(entries),
        "excluded_count": len(excluded),
        "excluded": excluded,
        "file_creation_time": file_creation_time,
        "sort_rule": "symbol_asc",
        "identity_rule": NASDAQ_IDENTITY_RULE,
        "denominator_label": NASDAQ_DENOMINATOR_LABEL,
        "denominator_status": "complete_security_type_filtered_listing",
        "complete_exchange_listing": False,
        "complete_security_type_filtered_listing": True,
        "security_type_filter": ["etf", "test_issue", "warrant", "warrants", "right", "rights", "unit", "units", "preferred", "notes", "etn"],
        "security_type_source": "NASDAQ Trader listing ETF/Test-Issue flags + security-name token match (warrant/right/unit/preferred/note/ETN), except operating MLP/partnership Common Units which are kept as listed equity; sector/industry deferred to EODHD at hydration",
        "generated_by": "investment-screener/screener.py normalise_nasdaq_universe_rows",
    }
    return entries, metadata


def load_nasdaq_universe_seed(path: Path) -> dict:
    """Load a wrapped reviewed NASDAQ universe seed, with legacy array support."""
    with open(path, encoding="utf8") as fh:
        data = json.load(fh)
    if isinstance(data, list):
        return {"metadata": {"seed_path": str(path)}, "entries": data}
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        raise ValueError(f"NASDAQ universe seed at {path} must contain an entries array")
    metadata = dict(data.get("metadata") or {})
    metadata.setdefault("seed_path", str(path))
    return {"metadata": metadata, "entries": data["entries"]}


def select_nasdaq_universe_batch(
    entries: list[dict],
    batch_offset: int = 0,
    max_tickers: Optional[int] = None,
    denominator_label: Optional[str] = None,
) -> dict:
    """Select a deterministic full-universe slice and return accounting metadata.

    The reviewed full NASDAQ seed is a security-type-filtered exchange listing,
    so a complete (unbounded) selection is honestly labeled
    ``complete_security_type_filtered_listing``, never ``known_sample_universe``.
    """
    selected = select_us_universe_batch(entries, batch_offset=batch_offset, max_tickers=max_tickers, denominator_label=denominator_label or NASDAQ_DENOMINATOR_LABEL)
    selected["denominator_label"] = denominator_label or NASDAQ_DENOMINATOR_LABEL
    if selected["denominator_status"] == "complete_exchange_listing":
        selected["denominator_status"] = "complete_security_type_filtered_listing"
        selected["complete_exchange_listing"] = False
        selected["complete_security_type_filtered_listing"] = True
    return selected


def apply_nasdaq_seed_identity(companies: list[dict], seed_entries: list[dict]) -> list[dict]:
    """Overlay NASDAQ seed exchange identity while preserving EODHD fundamentals."""
    by_ticker = {normalise_us_ticker(str(entry.get("ticker"))): entry for entry in seed_entries if entry.get("ticker")}
    identity_fields = (
        "company_id", "us_code", "market", "exchange", "region", "security_type", "active", "suspended", "delisted",
    )
    enriched: list[dict] = []
    for company in companies:
        merged = dict(company)
        seed = by_ticker.get(normalise_us_ticker(str(company.get("ticker") or "")))
        for field in identity_fields:
            value = seed.get(field) if seed else None
            if value is not None:
                merged[field] = value
        merged["market"] = "NASDAQ"
        merged["exchange"] = "NASDAQ"
        merged["region"] = "US"
        merged["currency"] = merged.get("currency") or "USD"
        enriched.append(merged)
    return enriched


def apply_us_seed_identity(companies: list[dict], seed_entries: list[dict]) -> list[dict]:
    """Overlay reviewed US seed identity fields onto hydrated provider rows.

    Only seed-authoritative fields are overlaid: ``company_id``, ``us_code``,
    ``region``, ``security_type``, and lifecycle flags. Name/sector/industry/
    exchange/currency come from EODHD ``General`` at hydration time and are NOT
    clobbered by a curated list that typically lacks them.
    """
    by_ticker = {normalise_us_ticker(str(entry.get("ticker"))): entry for entry in seed_entries if entry.get("ticker")}
    identity_fields = (
        "company_id", "us_code", "region", "security_type", "active", "suspended", "delisted",
    )
    enriched: list[dict] = []
    for company in companies:
        merged = dict(company)
        seed = by_ticker.get(normalise_us_ticker(str(company.get("ticker") or "")))
        if seed:
            for field in identity_fields:
                if seed.get(field) is not None:
                    merged[field] = seed[field]
        enriched.append(merged)
    return enriched


# ---------------------------------------------------------------------------
# Provenance helpers
# ---------------------------------------------------------------------------

def _field_value(company: dict, name: str) -> Optional[float]:
    fv: Optional[FieldValue] = company.get(name)
    return fv.value if fv else None


def _field_provenance(company: dict, name: str) -> dict:
    fv: Optional[FieldValue] = company.get(name)
    return fv.provenance if fv else {}


def _derived_provenance(company: dict, metric_name: str) -> dict:
    source_fields = DERIVED_INPUTS.get(metric_name, [])
    provenances = {f: _field_provenance(company, f) for f in source_fields}
    source_urls = sorted(str(v) for v in {p.get("source_url") for p in provenances.values()} if v)
    retrieved_at = sorted(str(v) for v in {p.get("retrieved_at") for p in provenances.values()} if v)
    data_as_of = sorted(str(v) for v in {p.get("data_as_of") for p in provenances.values()} if v)
    freshness = sorted(str(v) for v in {p.get("freshness") for p in provenances.values()} if v)
    return {
        "source_family": "derived",
        "provider": "derived",
        "method": "derived",
        "note": "derived from raw fields; inspect source_field_provenance for traceability",
        "source_fields": source_fields,
        "source_urls": source_urls,
        "retrieved_at": retrieved_at,
        "data_as_of": data_as_of,
        "freshness": freshness,
        "source_field_provenance": provenances,
    }


def _provenance_summary(company: dict) -> dict:
    provenances = [_field_provenance(company, f) for f in RAW_FIELDS]
    return {
        "source_families": sorted(str(v) for v in {p.get("source_family") for p in provenances} if v),
        "providers": sorted(str(v) for v in {p.get("provider") for p in provenances} if v),
        "source_urls": sorted(str(v) for v in {p.get("source_url") for p in provenances} if v),
        "data_as_of": sorted(str(v) for v in {p.get("data_as_of") for p in provenances} if v),
        "retrieved_at": sorted(str(v) for v in {p.get("retrieved_at") for p in provenances} if v),
        "freshness": sorted(str(v) for v in {p.get("freshness") for p in provenances} if v),
    }


def _parse_provenance_time(value: Any) -> Optional[datetime.datetime]:
    if not value:
        return None
    if isinstance(value, datetime.datetime):
        return value if value.tzinfo else value.replace(tzinfo=datetime.timezone.utc)
    if isinstance(value, datetime.date):
        return datetime.datetime.combine(value, datetime.time.min, tzinfo=datetime.timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.datetime.fromisoformat(text)
    except ValueError:
        try:
            parsed = datetime.datetime.fromisoformat(text[:10])
        except ValueError:
            return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=datetime.timezone.utc)


def _freshness_failures(company: dict, cfg: dict) -> list[str]:
    max_age = cfg.get("hard_exclusions", {}).get("require_recent_financials_days")
    if not max_age:
        return []
    now = datetime.datetime.now(datetime.timezone.utc)
    failures = []
    for name in ["revenue", "net_income", "operating_cash_flow", "total_assets", "total_liabilities"]:
        fv: Optional[FieldValue] = company.get(name)
        if not fv or fv.value is None:
            continue
        provd = fv.provenance or {}
        as_of = _parse_provenance_time(
            provd.get("data_as_of") or provd.get("retrieved_from_source_at") or provd.get("retrieved_at")
        )
        if as_of is None:
            failures.append(f"{name} lacks data_as_of/retrieval timestamp for recency validation")
        elif (now - as_of).days > max_age:
            failures.append(f"{name} stale: data_as_of/retrieved_at is older than {max_age} days")
    return failures


# ---------------------------------------------------------------------------
# Hard exclusion gate
# ---------------------------------------------------------------------------

def apply_hard_exclusions(company: dict, cfg: dict) -> list[str]:
    """Return a list of exclusion reasons. Empty -> company passes to scoring."""
    reasons: list[str] = []
    price_fv: Optional[FieldValue] = company.get("price")
    shares_fv: Optional[FieldValue] = company.get("shares_outstanding")

    if cfg.get("hard_exclusions", {}).get("require_price_and_shares", True):
        price_val = price_fv.value if price_fv else None
        shares_val = shares_fv.value if shares_fv else None
        if price_val is None or shares_val is None:
            reasons.append(
                "missing price or shares_outstanding prevents market_cap and valuation scoring"
            )

    reasons.extend(_freshness_failures(company, cfg))
    return reasons


# ---------------------------------------------------------------------------
# Derived metrics
# ---------------------------------------------------------------------------

def _ratio(numerator: Optional[float], denominator: Optional[float]) -> Optional[float]:
    if numerator is None or denominator is None or denominator == 0:
        return None
    return numerator / denominator


def _derive_metrics(c: dict) -> dict:
    """Compute derived metrics from raw FieldValues. Never imputes."""
    price = c.get("price") and c["price"].value
    shares = c.get("shares_outstanding") and c["shares_outstanding"].value
    rev = c.get("revenue") and c["revenue"].value
    prior_rev = c.get("prior_revenue") and c["prior_revenue"].value
    ni = c.get("net_income") and c["net_income"].value
    ocf = c.get("operating_cash_flow") and c["operating_cash_flow"].value
    capex = c.get("capital_expenditures") and c["capital_expenditures"].value
    assets = c.get("total_assets") and c["total_assets"].value
    liabilities = c.get("total_liabilities") and c["total_liabilities"].value
    cur_a = c.get("current_assets") and c["current_assets"].value
    cur_l = c.get("current_liabilities") and c["current_liabilities"].value

    market_cap = None if (price is None or shares is None) else price * shares
    fcf = None if (ocf is None or capex is None) else ocf + capex  # capex typically negative
    equity = None if (assets is None or liabilities is None) else assets - liabilities

    return {
        "market_cap": market_cap,
        "pe_ratio": _ratio(market_cap, ni),
        "price_to_sales": _ratio(market_cap, rev),
        "net_margin": _ratio(ni, rev),
        "roe": _ratio(ni, equity) if (equity is not None and equity > 0 and ni is not None and ni > 0) else None,
        "current_ratio": _ratio(cur_a, cur_l),
        "debt_to_assets": _ratio(liabilities, assets),
        "equity": equity,
        "fcf": fcf,
        "fcf_margin": _ratio(fcf, rev),
        "revenue_growth": _ratio(rev - prior_rev, prior_rev) if (rev and prior_rev) else None,
    }


# ---------------------------------------------------------------------------
# Risk flags
# ---------------------------------------------------------------------------

def _risk_flags(company: dict, metrics: dict, cfg: dict) -> tuple[list[str], list[str], dict]:
    flags: list[str] = []
    caveats: list[str] = []
    caps: dict[str, float] = {}

    def add(flag: str, caveat: str, cap: Optional[float] = None):
        if flag not in flags:
            flags.append(flag)
        caveats.append(caveat)
        if cap is not None:
            caps[flag] = cap

    price = _field_value(company, "price")
    shares = _field_value(company, "shares_outstanding")
    if price is None or shares is None:
        add("missing_critical_fields", "missing price/shares_outstanding blocks market-cap valuation")

    missing_noncritical = [
        f for f in RAW_FIELDS
        if f not in ("price", "shares_outstanding") and _field_value(company, f) is None
    ]
    if missing_noncritical:
        add("missing_noncritical_fields", "missing noncritical fields: " + ", ".join(missing_noncritical), 80)

    ni = _field_value(company, "net_income")
    if ni is not None and ni < 0:
        add("negative_earnings", "negative net income; negative P/E is not treated as cheap", 50)

    fcf = metrics.get("fcf")
    if fcf is not None and fcf < 0:
        add("negative_fcf", "negative free cash flow; value-trap/distress risk", 60)

    equity = metrics.get("equity")
    if equity is not None and equity <= 0:
        add("negative_equity", "negative/invalid equity; ROE is not rewarded and score is capped", 25)
        add("insolvent_balance_sheet", "liabilities exceed assets; insolvency/leverage pathology", 25)

    da = metrics.get("debt_to_assets")
    if da is not None and da >= cfg.get("thresholds", {}).get("debt_to_assets_excessive", 0.8):
        add("excessive_leverage", f"excessive leverage: debt_to_assets={da:.3f}", 55)

    cr = metrics.get("current_ratio")
    if cr is not None and cr < 1.0:
        add("liquidity_pressure", f"current liabilities exceed current assets: current_ratio={cr:.3f}", 60)

    rg = metrics.get("revenue_growth")
    if rg is not None and abs(rg) >= cfg.get("thresholds", {}).get("single_year_anomaly_revenue_growth_abs", 0.5):
        add("single_year_anomaly", f"single-year revenue growth anomaly: {rg:.3f}; requires multi-year verification", 65)

    if company.get("market") not in (None, "US") or company.get("currency") not in (None, "USD"):
        add("cross_market_fx", "cross-market/FX caveat: currency not normalised; scores are not cross-market comparable")

    for failure in _freshness_failures(company, cfg):
        add("stale_recent_financials_failure", failure, 0)

    return flags, caveats, caps


# ---------------------------------------------------------------------------
# Scoring engine
# ---------------------------------------------------------------------------

def _score_quality(m: dict, t: dict) -> tuple[float, list[str], list[str]]:
    points = 0
    max_pts = 0
    caveats = []
    missing = []

    max_pts += 40
    nm = m["net_margin"]
    if nm is None:
        missing.append("net_margin")
    elif nm >= t["net_margin_good"]:
        points += 40
    elif nm > 0:
        points += 20

    max_pts += 30
    roe = m["roe"]
    if roe is None:
        missing.append("roe")
    elif roe >= t["roe_good"]:
        points += 30
    elif roe > 0:
        points += 15

    max_pts += 30
    fcf = m["fcf"]
    if fcf is None:
        missing.append("fcf")
    elif fcf > 0:
        points += 30

    if max_pts == 0:
        return 0, caveats + [f"missing {f}" for f in missing], missing
    caveats += [f"missing {f}" for f in missing]
    return 100 * points / max_pts, caveats, missing


def _score_valuation(m: dict, t: dict) -> tuple[float, list[str], list[str]]:
    points = 0
    max_pts = 0
    caveats = []
    missing = []

    max_pts += 50
    pe = m["pe_ratio"]
    if pe is None:
        missing.append("pe_ratio")
    elif pe <= 0:
        caveats.append("negative P/E or zero earnings; not rewarded as cheap")
    elif pe <= t["pe_good"]:
        points += 50
    elif pe <= t["pe_fair"]:
        points += 25

    max_pts += 50
    ps = m["price_to_sales"]
    if ps is None:
        missing.append("price_to_sales")
    elif ps <= t["price_to_sales_good"]:
        points += 50
    elif ps <= t["price_to_sales_good"] * 2:
        points += 20

    if max_pts == 0:
        return 0, caveats + [f"missing {f}" for f in missing], missing
    caveats += [f"missing {f}" for f in missing]
    return 100 * points / max_pts, caveats, missing


def _score_growth(m: dict, t: dict) -> tuple[float, list[str], list[str]]:
    caveats = []
    missing = []
    rg = m["revenue_growth"]
    if rg is None:
        missing.append("revenue_growth")
        caveats.append("missing revenue_growth")
        return 0, caveats, missing
    if rg >= t["revenue_growth_good"]:
        return 100, caveats, missing
    elif rg > 0:
        return 50, caveats, missing
    return 0, caveats, missing


def _score_graham_safety(m: dict, t: dict) -> tuple[float, list[str], list[str]]:
    points = 0
    max_pts = 0
    caveats = []
    missing = []

    max_pts += 50
    cr = m["current_ratio"]
    if cr is None:
        missing.append("current_ratio")
    elif cr >= t["current_ratio_good"]:
        points += 50
    elif cr >= 1.0:
        points += 25

    max_pts += 50
    da = m["debt_to_assets"]
    if da is None:
        missing.append("debt_to_assets")
    elif da <= t["debt_to_assets_good"]:
        points += 50
    elif da <= 0.7:
        points += 20

    if max_pts == 0:
        return 0, caveats + [f"missing {f}" for f in missing], missing
    caveats += [f"missing {f}" for f in missing]
    return 100 * points / max_pts, caveats, missing


def _score_durability(m: dict, t: dict) -> tuple[float, list[str], list[str]]:
    caveats = []
    missing = []
    ni = m.get("net_margin")
    fcf = m["fcf"]

    score = 0
    if ni is None:
        missing.append("net_margin (durability proxy)")
    elif ni > 0:
        score += 50

    if fcf is None:
        missing.append("fcf (durability proxy)")
    elif fcf > 0:
        score += 50

    caveats += [f"missing {f}" for f in missing]
    return score, caveats, missing


def _score_risk(m: dict, t: dict) -> tuple[float, list[str], list[str]]:
    caveats = []
    missing = []
    da = m["debt_to_assets"]
    if da is None:
        missing.append("debt_to_assets (risk proxy)")
        caveats.append("missing debt_to_assets (risk proxy)")
        return 0, caveats, missing
    return max(0.0, 100 * (1.0 - da * 2)), caveats, missing


_SUBSCORERS = {
    "quality": _score_quality,
    "valuation": _score_valuation,
    "growth": _score_growth,
    "graham_safety": _score_graham_safety,
    "durability": _score_durability,
    "risk_adjustments": _score_risk,
}


# ---------------------------------------------------------------------------
# Hydration tier classification (partial scoring policy)
# ---------------------------------------------------------------------------

def _present_raw_fields(company: dict) -> set[str]:
    """Return the set of RAW_FIELDS with a non-None value on the company dict."""
    present: set[str] = set()
    for name in RAW_FIELDS:
        fv: Optional[FieldValue] = company.get(name)
        if fv is not None and fv.value is not None:
            present.add(name)
    return present


def classify_hydration_tier(company: dict, cfg: dict) -> str:
    """Classify a company as 'full', 'partial', or 'missing'.

    - 'full': all RAW_FIELDS present.
    - 'partial': all CORE_INCOME_FIELDS present AND >=1 BALANCE_CASHFLOW_FIELD missing.
    - 'missing': missing a core income field (price/shares/revenue/prior_revenue/net_income)
      or missing everything. Hard-exclusion/freshness gating is a separate concern
      (apply_hard_exclusions); this classifier only decides hydration completeness.

    ``missing`` (formerly ``excluded``) marks a name whose provider returned
    identity and some statements but left at least one core income field absent
    (e.g. ``prior_revenue`` for a SPAC shell with a single annual row). It is
    deliberately a distinct tier from a hard exclusion (freshness/price-gate), so
    the caller can account it by its true hydration origin rather than dropping it
    silently and letting the seed-universe sweep re-derive it as a synthetic
    reconcile-only failure.

    Never imputes: absence is measured directly against the field set.
    """
    if not cfg.get("partial_scoring", {}).get("enabled", True):
        present = _present_raw_fields(company)
        return "full" if len(present) == len(RAW_FIELDS) else "missing"

    present = _present_raw_fields(company)
    core_present = present & set(CORE_INCOME_FIELDS)
    if len(core_present) == len(CORE_INCOME_FIELDS):
        missing_bs_cf = [f for f in BALANCE_CASHFLOW_FIELDS if f not in present]
        if not missing_bs_cf:
            return "full"
        return "partial"
    if len(present) == len(RAW_FIELDS):
        return "full"
    return "missing"


def hydration_completeness(company: dict, cfg: dict) -> dict:
    """Return n/m completeness plus the missing-field and suppressed-sub-score lists."""
    present = _present_raw_fields(company)
    denominator = int(cfg.get("partial_scoring", {}).get("hydration_completeness_denominator", len(RAW_FIELDS)) or len(RAW_FIELDS))
    present_count = len(present)
    missing_fields = sorted(f for f in RAW_FIELDS if f not in present)
    metrics = _derive_metrics(company)
    suppressed = [
        cat for cat, inputs in SUBSCORE_METRIC_INPUTS.items()
        if all(metrics.get(m) is None for m in inputs)
    ]
    return {
        "present": present_count,
        "denominator": denominator,
        "missing_raw_fields": missing_fields,
        "suppressed_sub_scores": sorted(suppressed),
    }


def _live_subscore_weights(weights: dict, metrics: dict) -> dict:
    """Return {category: weight} for categories whose primary inputs are live."""
    live: dict = {}
    for cat, inputs in SUBSCORE_METRIC_INPUTS.items():
        if cat not in weights:
            continue
        if any(metrics.get(m) is not None for m in inputs):
            live[cat] = weights.get(cat, 0)
    return live


def score_company(company: dict, cfg: dict) -> dict:
    """Full scoring of one company. Does NOT call apply_hard_exclusions."""
    weights: dict = cfg["composite_weights"]
    t: dict = cfg["thresholds"]
    missing_cfg: dict = cfg.get("missing_data", {})
    per_penalty: float = missing_cfg.get("per_missing_field_penalty", 2)
    max_penalty: float = missing_cfg.get("max_missing_penalty", 20)

    metrics = _derive_metrics(company)
    risk_flags, risk_caveats, score_caps = _risk_flags(company, metrics, cfg)
    sub_scores = {}
    all_caveats: list[str] = list(risk_caveats)
    all_missing: list[str] = []

    for cat, scorer in _SUBSCORERS.items():
        raw, cavs, miss = scorer(metrics, t)
        sub_scores[cat] = raw
        all_caveats += cavs
        all_missing += miss

    if any(flag in risk_flags for flag in ("negative_earnings", "negative_equity", "insolvent_balance_sheet")):
        sub_scores["valuation"] = 0
        all_caveats.append("valuation score suppressed for distress/negative-earnings balance-sheet pathology")

    tier = classify_hydration_tier(company, cfg)
    comp_detail = hydration_completeness(company, cfg)
    unique_missing = list(dict.fromkeys(all_missing))

    partial = tier == "partial"
    partial_cap = float(cfg.get("partial_scoring", {}).get("partial_cap", 60))

    if partial:
        # Renormalize only over live sub-score categories; dead categories
        # (graham_safety, risk_adjustments for a revenue-only name) are excluded
        # from the denominator rather than scored as zero-weights.
        live_weights = _live_subscore_weights(weights, metrics)
        live_total = sum(live_weights.values())
        composite = 0.0
        if live_total != 0:
            composite = sum(live_weights.get(cat, 0) * sub_scores.get(cat, 0) / 100 for cat in live_weights)
            composite = composite / live_total * 100
        suppressed = comp_detail["suppressed_sub_scores"]
        # Suppression already removes dead categories; do NOT additionally apply the
        # blanket missing-data penalty on top. The explicit completeness label + cap
        # replace the hidden penalty.
        missing_penalty = 0.0
        if score_caps:
            composite = min(composite, min(score_caps.values()))
        composite = min(composite, partial_cap)
        composite = max(0.0, composite)
        all_caveats.append(PARTIAL_BUCKET_CAVEAT)
        all_caveats.append("suppressed sub-scores: " + ", ".join(suppressed) if suppressed else "suppressed sub-scores: none")
    else:
        total_weight = sum(weights.values())
        composite = sum(weights.get(cat, 0) * sub_scores.get(cat, 0) / 100 for cat in weights)
        if total_weight != 0:
            composite = composite / total_weight * 100
        missing_penalty = min(len(unique_missing) * per_penalty, max_penalty)
        composite = max(0, composite - missing_penalty)
        if score_caps:
            composite = min(composite, min(score_caps.values()))

    fields = {}
    for f in RAW_FIELDS:
        fv: Optional[FieldValue] = company.get(f)
        fields[f] = {
            "value": fv.value if fv else None,
            "status": "present" if (fv and fv.value is not None) else "missing",
            "provenance": fv.provenance if fv else {},
        }

    for m_name, m_val in metrics.items():
        fields[m_name] = {
            "value": m_val,
            "status": "present" if m_val is not None else "missing",
            "provenance": _derived_provenance(company, m_name),
        }

    return {
        "ticker": company.get("ticker"),
        "name": company.get("name"),
        "market": company.get("market"),
        "currency": company.get("currency"),
        **{k: company.get(k) for k in ("company_id", "asx_code", "us_code", "name_raw", "name_normalized", "exchange", "region", "sector", "industry", "security_type", "active", "suspended", "delisted") if company.get(k) is not None},
        "_eodhd_depth": company.get("_eodhd_depth"),
        "excluded": False,
        "exclusion_reasons": [],
        "sub_scores": sub_scores,
        "composite_score": round(composite, 2),
        "score_caps": score_caps,
        "risk_flags": risk_flags,
        "missing_penalty_points": missing_penalty,
        "caveats": list(dict.fromkeys(all_caveats)),
        "missing_fields": unique_missing,
        "hydration_tier": tier,
        "hydration_completeness": {
            "present": comp_detail["present"],
            "denominator": comp_detail["denominator"],
        },
        "missing_raw_fields": comp_detail["missing_raw_fields"],
        "suppressed_sub_scores": comp_detail["suppressed_sub_scores"],
        "provenance_summary": _provenance_summary(company),
        "fields": fields,
        "multi_source_fields": company.get("multi_source_fields") or {},
        "field_quality": company.get("field_quality") or {
            "filled_fields": [],
            "conflicted_fields": [],
            "stale_fields": [],
            "missing_fields": unique_missing,
            "conflict_count": 0,
        },
        "source_summary": company.get("source_summary"),
        "provider_priority_version": company.get("provider_priority_version"),
        "threshold_version": company.get("threshold_version"),
    }


def rank_companies(companies: list[dict], cfg: dict) -> list[dict]:
    """Score and rank companies; apply hard exclusions; return sorted list."""
    scored = []
    for company in companies:
        exclusions = apply_hard_exclusions(company, cfg)
        if exclusions:
            scored.append({
                "ticker": company.get("ticker"),
                "name": company.get("name"),
                "market": company.get("market"),
                "currency": company.get("currency"),
                **{k: company.get(k) for k in ("company_id", "asx_code", "name_raw", "name_normalized", "exchange", "region", "sector", "industry", "security_type", "active", "suspended", "delisted") if company.get(k) is not None},
                "excluded": True,
                "exclusion_reasons": exclusions,
                "sub_scores": {},
                "composite_score": None,
                "score_caps": {},
                "risk_flags": ["missing_critical_fields"] if any("missing" in r for r in exclusions) else [],
                "missing_penalty_points": 0,
                "caveats": exclusions,
                "missing_fields": [],
                "provenance_summary": _provenance_summary(company),
                "fields": {},
                "rank": None,
            })
        else:
            row = score_company(company, cfg)
            # A name that the provider hydrated but with a missing *core income*
            # field (price/shares/revenue/prior_revenue/net_income) cannot be
            # scored at all. ``score_company`` reports this as tier "missing"
            # with ``excluded`` still False, which used to fall through every
            # ranked bucket and be silently dropped — so the seed-universe
            # reconcile sweep later re-derived it as a synthetic "no company,
            # failure, or exclusion record" failure. Give it a concrete reason
            # and account it as an exclusion here, from its true origin.
            if row.get("hydration_tier") == "missing":
                missing_core = [f for f in CORE_INCOME_FIELDS if f not in _present_raw_fields(company)]
                reason = "missing required core income field(s): " + ", ".join(missing_core)
                row["excluded"] = True
                row["exclusion_reasons"] = [reason]
                row["caveats"] = [reason]
                row["composite_score"] = None
            scored.append(row)

    fully_scored = [r for r in scored if not r.get("excluded") and r.get("hydration_tier") == "full"]
    partial = [r for r in scored if not r.get("excluded") and r.get("hydration_tier") == "partial"]
    excluded = [r for r in scored if r.get("excluded")]

    fully_scored = sorted(fully_scored, key=lambda r: r.get("composite_score") or 0, reverse=True)
    partial = sorted(partial, key=lambda r: r.get("composite_score") or 0, reverse=True)

    ranked = []
    for i, row in enumerate(fully_scored, start=1):
        row["rank"] = i
        row["partial_rank"] = None
        ranked.append(row)
    for i, row in enumerate(partial, start=1):
        row["rank"] = None
        row["partial_rank"] = i
        ranked.append(row)
    for row in excluded:
        row["rank"] = None
        row["partial_rank"] = None
        ranked.append(row)

    return ranked


# ---------------------------------------------------------------------------
# Filter/control helpers
# ---------------------------------------------------------------------------

def _split_filter_values(values: Optional[list[str]]) -> list[str]:
    if not values:
        return []
    parsed: list[str] = []
    for item in values:
        for part in str(item).split(","):
            value = part.strip()
            if value:
                parsed.append(value)
    return parsed


def apply_filters(companies: list[dict], filters: dict[str, list[str]]) -> list[dict]:
    filtered = list(companies)
    for field_name in FILTER_FIELDS:
        requested = _split_filter_values(filters.get(field_name))
        if not requested:
            continue
        allowed = {v.casefold() for v in requested}
        filtered = [
            c for c in filtered
            if c.get(field_name) not in (None, "") and str(c.get(field_name)).casefold() in allowed
        ]
    return filtered


def apply_top_n(ranked: list[dict], top_n: Optional[int]) -> list[dict]:
    if top_n is None:
        return ranked
    kept: list[dict] = []
    candidates_seen = 0
    for row in ranked:
        # Partial candidates are bucket-separated, never counted against top_n
        # (which applies to fully-scored names only).
        if row.get("excluded") or row.get("hydration_tier") == "partial":
            kept.append(row)
        elif candidates_seen < top_n:
            kept.append(row)
            candidates_seen += 1
    return kept


# ---------------------------------------------------------------------------
# Dashboard export helpers
# ---------------------------------------------------------------------------

def _first_sorted_value(values: list[Any]) -> Optional[str]:
    cleaned = sorted({str(v).strip() for v in values if v not in (None, "")})
    return cleaned[0] if cleaned else None


def _ranked_data_as_of(rows: list[dict]) -> Optional[str]:
    values: list[Any] = []
    for row in rows:
        summary = row.get("provenance_summary") or {}
        if isinstance(summary, dict):
            values.extend(summary.get("data_as_of") or [])
    return _first_sorted_value(values)


def _dashboard_score_caps(score_caps: Any) -> list[str]:
    if not score_caps:
        return []
    if isinstance(score_caps, dict):
        return [f"{key}: {value}" for key, value in score_caps.items()]
    if isinstance(score_caps, list):
        return [str(item) for item in score_caps]
    return [str(score_caps)]


def _dashboard_provenance_summary(row: dict) -> Optional[str]:
    summary = row.get("provenance_summary") or {}
    if not isinstance(summary, dict):
        return None
    source_count = len(summary.get("source_urls") or [])
    source_families = [str(item) for item in (summary.get("source_families") or []) if item]
    providers = [str(item) for item in (summary.get("providers") or []) if item]
    data_as_of = _first_sorted_value(summary.get("data_as_of") or [])
    retrieved_at = _first_sorted_value(summary.get("retrieved_at") or [])
    pieces = []
    if source_families:
        pieces.append("families=" + "+".join(source_families))
    if providers:
        pieces.append("providers=" + "+".join(providers))
    if source_count:
        pieces.append(f"{source_count} source(s)")
    if data_as_of:
        pieces.append(f"data_as_of={data_as_of}")
    if retrieved_at:
        pieces.append(f"retrieved_at={retrieved_at}")
    return "; ".join(pieces) if pieces else None


def _dashboard_ranked_row(row: dict) -> dict:
    row_dict = {
        "rank": row.get("rank"),
        "ticker": row.get("ticker"),
        "name": row.get("name"),
        "market": row.get("market"),
        "currency": row.get("currency"),
        "sector": row.get("sector"),
        "industry": row.get("industry"),
        "score": row.get("composite_score"),
        "sub_scores": dict(row.get("sub_scores") or {}),
        "missing_penalty_points": row.get("missing_penalty_points"),
        "risk_flags": list(row.get("risk_flags") or []),
        "caveats": list(dict.fromkeys(list(row.get("caveats") or []) + list(row.get("exclusion_reasons") or []))),
        "score_caps": _dashboard_score_caps(row.get("score_caps")),
        "sanitized_provenance_summary": _dashboard_provenance_summary(row),
        "source_summary": row.get("source_summary"),
        "field_quality": {
            "filled_fields": list((row.get("field_quality") or {}).get("filled_fields") or []),
            "conflicted_fields": list((row.get("field_quality") or {}).get("conflicted_fields") or []),
            "stale_fields": list((row.get("field_quality") or {}).get("stale_fields") or []),
            "missing_fields": list((row.get("field_quality") or {}).get("missing_fields") or row.get("missing_fields") or []),
            "conflict_count": int((row.get("field_quality") or {}).get("conflict_count") or 0),
        },
    }
    if row.get("hydration_tier") == "partial":
        row_dict["hydration_tier"] = "partial"
        row_dict["hydration_completeness"] = {
            "present": (row.get("hydration_completeness") or {}).get("present"),
            "denominator": (row.get("hydration_completeness") or {}).get("denominator"),
        }
        row_dict["missing_raw_fields"] = list(row.get("missing_raw_fields") or [])
        row_dict["suppressed_sub_scores"] = list(row.get("suppressed_sub_scores") or [])
        row_dict["partial_rank"] = row.get("partial_rank")
    return row_dict


def build_dashboard_ranked_export(
    ranked: list[dict],
    mode: str = "compact",
    filters_applied: Optional[dict[str, list[str]]] = None,
    top_n: Optional[int] = None,
) -> dict:
    """Build dashboard-safe ranked JSON; intentionally excludes raw fields/provenance."""
    limitations = list(DASHBOARD_EXPORT_LIMITATIONS)
    if top_n is not None:
        limitations.append(f"top_n={top_n}")
    candidates = [row for row in ranked if not row.get("excluded") and row.get("hydration_tier") != "partial"]
    partial = [row for row in ranked if not row.get("excluded") and row.get("hydration_tier") == "partial"]
    excluded = [row for row in ranked if row.get("excluded")]
    result = {
        "mode": mode,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "data_as_of": _ranked_data_as_of(ranked),
        "limitations": limitations,
        "candidates": [_dashboard_ranked_row(row) for row in candidates],
        "excluded": [_dashboard_ranked_row(row) for row in excluded],
    }
    if partial:
        result["partial"] = [_dashboard_ranked_row(row) for row in partial]
        result["limitations"].append(
            "Some candidates have no cash-flow or balance-sheet data and are listed "
            "separately under a partial bucket; they are not directly comparable to fully scored candidates."
        )
    return result


def build_plain_text_report(
    ranked: list[dict],
    export: dict,
    watchlist_path: Optional[str] = None,
) -> str:
    """Build a human-readable plain-text report from ranked companies."""
    now = export.get("generated_at", "")
    data_as_of = export.get("data_as_of", "unknown")
    lines = ["=" * 70]
    lines.append("ASX Investment Screener Report")
    lines.append(f"Generated: {now}")
    lines.append(f"Data as of: {data_as_of}")
    if watchlist_path:
        lines.append(f"Universe: {watchlist_path}")
    lines.append("=" * 70)
    lines.append("")
    lines.append("LIMITATIONS:")
    for lim in export.get("limitations") or []:
        lines.append(f"  * {lim}")
    lines.append("")
    lines.append("CANDIDATES:")
    candidates = export.get("candidates") or []
    if not candidates:
        lines.append("  (no candidates passed scoring)")
    for c in candidates:
        lines.append(f"\n  #{c['rank']} {c['ticker']} — {c.get('name', '')} [{c.get('market', '')}]")
        lines.append(f"     Score: {c['score']}")
        sub = c.get("sub_scores") or {}
        if sub:
            sub_str = ", ".join(f"{k}={v:.1f}" for k, v in sub.items())
            lines.append(f"     Sub-scores: {sub_str}")
        flags = c.get("risk_flags") or []
        if flags:
            lines.append(f"     Risk flags: {', '.join(flags)}")
        caveats = c.get("caveats") or []
        if caveats:
            lines.append(f"     Caveats: {'; '.join(caveats[:3])}")
        if c.get("sanitized_provenance_summary"):
            lines.append(f"     Provenance: {c['sanitized_provenance_summary']}")

    excl = export.get("excluded") or []
    if excl:
        lines.append(f"\nEXCLUDED ({len(excl)}):")
        for e in excl:
            lines.append(f"  {e['ticker']} — {'; '.join(e.get('caveats') or [])[:80]}")

    partial = export.get("partial") or []
    if partial:
        lines.append(f"\nPARTIALLY HYDRATED ({len(partial)}): income and valuation only; "
                     "cash-flow and balance-sheet not assessed; not directly comparable to fully scored candidates.")
        for p in partial:
            missing = ", ".join(p.get("missing_raw_fields") or []) or "none"
            lines.append(f"  {p['ticker']} — {p.get('name', '')} [{p.get('market', '')}]")
            lines.append(f"     Partial score: {p['score']} (capped); missing: {missing}")

    lines.append("")
    lines.append("=" * 70)
    lines.append("This is for investigation only. Not a recommendation or financial advice.")
    lines.append("=" * 70)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Yahoo data fetchers
# ---------------------------------------------------------------------------

def _cache_path(cache_dir: Optional[Path], url: str) -> Optional[Path]:
    if not cache_dir:
        return None
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    return cache_dir / f"{digest}.json"


def _fetch_json_url(
    url: str,
    timeout: int,
    cache_dir: Optional[Path] = None,
    max_attempts: int = 3,
    backoff_seconds: float = 0.75,
    jitter_seconds: float = 0.25,
) -> dict:
    path = _cache_path(cache_dir, url)
    if path and path.exists():
        with open(path) as fh:
            return json.load(fh)

    attempts = max(1, int(max_attempts))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    last_exc: Optional[BaseException] = None
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode())
            if path:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(data, default=str))
            return data
        except Exception as exc:
            last_exc = exc
            if attempt >= attempts:
                raise
            delay = max(0.0, backoff_seconds * (2 ** (attempt - 1)))
            if jitter_seconds:
                delay += random.uniform(0, jitter_seconds)
            print(
                f"WARNING: provider fetch failed attempt {attempt}/{attempts}; "
                f"retrying in {delay:.2f}s: {exc}",
                file=sys.stderr,
            )
            time.sleep(delay)
    raise RuntimeError(f"failed to fetch JSON after {attempts} attempt(s): {last_exc}")


def fetch_yahoo_chart_quote(ticker: str, cache_dir: Optional[Path] = None) -> dict:
    """Fetch current price and basic metadata from Yahoo Finance chart API."""
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        + urllib.parse.quote(ticker)
        + "?range=5d&interval=1d"
    )
    data = _fetch_json_url(url, timeout=20, cache_dir=cache_dir)
    result = (data.get("chart", {}).get("result") or [None])[0]
    if not result:
        raise ValueError(f"No quote returned for {ticker}")
    meta = result.get("meta") or {}
    return {
        "price": meta.get("regularMarketPrice") or meta.get("chartPreviousClose"),
        "currency": meta.get("currency") or "AUD",
        "exchange": meta.get("exchangeName") or "ASX",
        "name": meta.get("shortName") or meta.get("longName") or ticker,
    }


def fetch_yahoo_timeseries(ticker: str, years: int = 6, cache_dir: Optional[Path] = None) -> dict:
    """Fetch annual fundamentals from Yahoo fundamentals-timeseries endpoint."""
    period2 = int(time.time())
    period1 = period2 - int(years * 366 * 24 * 60 * 60)
    types = ",".join(YAHOO_FIELD_TYPES.values())
    url = (
        "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/"
        + urllib.parse.quote(ticker)
        + "?symbol=" + urllib.parse.quote(ticker)
        + "&type=" + types
        + f"&period1={period1}&period2={period2}"
    )
    return _fetch_json_url(url, timeout=30, cache_dir=cache_dir)


def _timeseries_by_type(timeseries: dict) -> dict[str, list[dict]]:
    output = {}
    for row in timeseries.get("timeseries", {}).get("result", []) or []:
        type_names = row.get("meta", {}).get("type") or []
        if not type_names:
            continue
        type_name = type_names[0]
        output[type_name] = list(row.get(type_name) or [])
    return output


def _latest_timeseries_item(items: list[dict], prior: bool = False) -> Optional[dict]:
    ordered = sorted(items, key=lambda item: str(item.get("asOfDate") or ""), reverse=True)
    if not ordered:
        return None
    return ordered[1] if prior and len(ordered) > 1 else ordered[0]


def _reported_raw(item: Optional[dict]) -> Optional[float]:
    if not item:
        return None
    reported = item.get("reportedValue") or {}
    return reported.get("raw")


def _yahoo_ts_field(
    ticker: str,
    field_name: str,
    type_name: str,
    item: Optional[dict],
    source_url: str,
) -> FieldValue:
    value = _reported_raw(item)
    if field_name == "capital_expenditures" and value is not None:
        value = -abs(float(value))
    retrieved_at = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    return FieldValue(
        value=value,
        provenance={
            "source_family": "yahoo-finance",
            "provider": "yahoo-finance",
            "source_url": source_url,
            "retrieved_at": retrieved_at,
            "retrieved_from_source_at": retrieved_at,
            "data_as_of": item.get("asOfDate") if item else None,
            "field_name": field_name,
            "yahoo_type": type_name,
            "freshness": (
                "Yahoo fundamentals-timeseries public data for ASX bootstrap; "
                "unofficial endpoint; verify against ASX announcements/company reports before acting"
            ),
        },
    )


def build_company_from_yahoo_timeseries(ticker: str, timeseries: dict, quote: dict) -> dict:
    """Build a screener company dict from Yahoo timeseries and quote data."""
    by_type = _timeseries_by_type(timeseries)
    source_url = (
        "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/"
        + urllib.parse.quote(ticker)
    )
    now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

    def ts_field(field_name: str, prior: bool = False) -> FieldValue:
        type_name = YAHOO_FIELD_TYPES[field_name]
        item = _latest_timeseries_item(by_type.get(type_name) or [], prior=prior)
        return _yahoo_ts_field(ticker, field_name, type_name, item, source_url)

    is_asx = ticker.upper().endswith(".AX")
    return {
        "ticker": ticker,
        "name": quote.get("name") or ticker,
        "market": "ASX" if is_asx else (quote.get("exchange") or "UNKNOWN"),
        "exchange": quote.get("exchange") or ("ASX" if is_asx else "UNKNOWN"),
        "region": "AU" if is_asx else None,
        "currency": quote.get("currency") or ("AUD" if is_asx else "USD"),
        "price": FieldValue(
            quote.get("price"),
            {
                "source_family": "yahoo-finance",
                "provider": "yahoo-finance",
                "source_url": (
                    "https://query1.finance.yahoo.com/v8/finance/chart/"
                    + urllib.parse.quote(ticker)
                ),
                "retrieved_at": now,
                "retrieved_from_source_at": now,
                "data_as_of": now[:10],
                "field_name": "price",
                "freshness": "Yahoo chart quote from unofficial public endpoint; verify before use",
            },
        ),
        "shares_outstanding": ts_field("shares_outstanding"),
        "revenue": ts_field("revenue"),
        "prior_revenue": ts_field("revenue", prior=True),
        "net_income": ts_field("net_income"),
        "operating_cash_flow": ts_field("operating_cash_flow"),
        "capital_expenditures": ts_field("capital_expenditures"),
        "total_assets": ts_field("total_assets"),
        "total_liabilities": ts_field("total_liabilities"),
        "current_assets": ts_field("current_assets"),
        "current_liabilities": ts_field("current_liabilities"),
    }


def hydrate_companies_from_asx_tickers(
    tickers: list[str],
    warning_sink: Optional[Callable[[str], None]] = None,
    quote_fetcher: Optional[Callable[[str], dict]] = None,
    timeseries_fetcher: Optional[Callable[[str], dict]] = None,
    sleep_seconds: float = 0.3,
    cache_dir: Optional[Path] = None,
    failure_sink: Optional[Callable[[dict], None]] = None,
) -> list[dict]:
    """
    Hydrate ASX companies from Yahoo finance data.

    Normalises bare ASX codes to {CODE}.AX format.
    Per-ticker failures emit a warning and skip that ticker (graceful partial failure).
    Returns list of company dicts (may be empty if all tickers fail).
    """
    warning_sink = warning_sink or (lambda message: print(message, file=sys.stderr))
    if quote_fetcher is None:
        quote_fetcher = lambda symbol: fetch_yahoo_chart_quote(symbol, cache_dir=cache_dir)
    if timeseries_fetcher is None:
        timeseries_fetcher = lambda symbol: fetch_yahoo_timeseries(symbol, cache_dir=cache_dir)

    companies: list[dict] = []
    for ticker in tickers:
        symbol = normalise_asx_ticker(ticker)
        try:
            quote = quote_fetcher(symbol)
            quote["exchange"] = quote.get("exchange") or "ASX"
            ts = timeseries_fetcher(symbol)
            companies.append(build_company_from_yahoo_timeseries(symbol, ts, quote))
        except Exception as exc:
            failure = {
                "ticker": symbol,
                "reason": str(exc),
                "recoverable": True,
                "provider": "yahoo-finance",
                "source_family": "yahoo-finance",
                "failed_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            }
            if failure_sink:
                failure_sink(failure)
            warning_sink(f"WARNING: failed to hydrate {symbol} ASX data: {exc}")
        if sleep_seconds and ticker != tickers[-1]:
            time.sleep(sleep_seconds)
    return companies



# ---------------------------------------------------------------------------
# Provider fallback framework (staged fundamentals fallback)
# ---------------------------------------------------------------------------

# Trust ranking for credentialed provider adapters. Lower index = higher
# preference when multiple providers supply the same missing field.
PROVIDER_TRUST_RANK = {
    "fmp": 0,
    "alpha_vantage": 1,
    "eodhd": 5,
    "asx_markitdigital": 20,
}

# Env var/config flag names. Secret values are never committed; credentialed
# providers are injected at runtime from Vaultwarden/local secret storage.
PROVIDER_ENV_VARS = {
    "fmp": "FMP_API_KEY",
    "alpha_vantage": "ALPHA_VANTAGE_API_KEY",
    "eodhd": "EODHD_API_KEY",
    "asx_markitdigital": "ASX_MARKITDIGITAL_ENABLED",
}


def missing_field_value(field_name: str, reason: str, source_family: str) -> FieldValue:
    """Return a FieldValue(None) carrying an explicit missing/unavailable reason.

    Distinguishes "provider has no value" from "fetch failed" so downstream
    scoring never conflates a throttled fetch with a genuinely unreported metric.
    """
    return FieldValue(
        value=None,
        provenance={
            "field_name": field_name,
            "source_family": source_family,
            "missing_reason": reason,
        },
    )


def build_company_from_eodhd_fundamentals(ticker: str, payload: dict, quote: Optional[dict] = None) -> dict:
    """Build a screener company dict from an EODHD fundamentals payload + a quote.

    ``quote`` supplies the current price (EODHD fundamentals has no live price);
    it is the Yahoo chart quote dict (``price``/``currency``/``exchange``) from
    ``fetch_yahoo_chart_quote``. Identity (name/sector/industry/currency/exchange/
    region) is taken from EODHD ``General`` via the adapter's extraction helpers;
    price is the one field sourced from the quote. Nothing is imputed: missing
    statement rows simply yield missing FieldValues.
    """
    adapter = EodhdAdapter(env={})
    identity = adapter._extract_identity(payload)
    depth = EodhdAdapter._statement_depth(payload)
    financials = payload.get("Financials") if isinstance(payload.get("Financials"), dict) else {}
    currency = identity.get("currency") or "USD"
    fields = adapter._shared_row_fields(financials, "", currency)

    # Price from the quote (chart), provenance yahoo-finance, currency = market.
    now = _now_iso()
    quote = quote or {}
    price = _coerce_float(quote.get("price"))
    price_fv = FieldValue(
        value=price,
        provenance={
            "source_family": "yahoo-finance",
            "provider": "yahoo-finance",
            "source_url": "https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(ticker),
            "retrieved_at": now,
            "retrieved_from_source_at": now,
            "data_as_of": now[:10],
            "field_name": "price",
            "freshness": "Yahoo chart quote from unofficial public endpoint; verify before use",
        },
    ) if price is not None else None

    # Shares outstanding from EODHD SharesStats / outstandingShares.
    shares = adapter._extract_shares_outstanding(payload)
    shares_fv = fields.get("shares_outstanding")
    if shares_fv is None and shares is not None:
        shares_fv = FieldValue(
            value=shares,
            provenance={
                "source_family": "eodhd",
                "provider": "eodhd",
                "source_url": "",
                "retrieved_at": now,
                "retrieved_from_source_at": now,
                "data_as_of": None,
                "field_name": "shares_outstanding",
                "unit": "shares",
                "currency": None,
                "scale": "ones",
                "period_type": "latest_market",
                "confidence": "medium",
                "trust_level": "licensed_provider_normalized_statement",
                "stale": False,
                "method": "reported",
            },
        )

    company = {
        "ticker": ticker,
        "name": identity.get("name") or quote.get("name") or ticker,
        "market": "US",
        "exchange": identity.get("exchange") or quote.get("exchange") or "UNKNOWN",
        "region": identity.get("region") or "US",
        "currency": currency,
        "company_id": identity.get("company_id"),
        "us_code": identity.get("us_code"),
        "name_raw": identity.get("name_raw"),
        "name_normalized": identity.get("name_normalized"),
        "sector": identity.get("sector"),
        "industry": identity.get("industry"),
        "security_type": identity.get("security_type") or US_DEFAULT_SECURITY_TYPE,
        "active": True,
        "suspended": False,
        "delisted": False,
        "_eodhd_depth": depth,
        "price": price_fv,
        "shares_outstanding": shares_fv,
        "revenue": fields.get("revenue"),
        "prior_revenue": fields.get("prior_revenue"),
        "net_income": fields.get("net_income"),
        "operating_cash_flow": fields.get("operating_cash_flow"),
        "capital_expenditures": fields.get("capital_expenditures"),
        "total_assets": fields.get("total_assets"),
        "total_liabilities": fields.get("total_liabilities"),
        "current_assets": fields.get("current_assets"),
        "current_liabilities": fields.get("current_liabilities"),
    }
    return company


def hydrate_companies_from_us_eodhd(
    payloads: list[dict],
    tickers: Optional[list[str]] = None,
    quote_fetcher: Optional[Callable[[str], dict]] = None,
    sleep_seconds: float = 0.3,
    cache_dir: Optional[Path] = None,
    warning_sink: Optional[Callable[[str], None]] = None,
    failure_sink: Optional[Callable[[dict], None]] = None,
) -> list[dict]:
    """Build company rows from a pre-fetched list of EODHD payloads + Yahoo quotes.

    The EODHD fundamentals payload is fetched upstream (via ``EodhdAdapter.fetch``)
    and passed in as ``payloads``; this function only builds rows and fetches the
    Yahoo chart quote (for live price). ``tickers`` must be `.US`-normalized and
    align positionally with ``payloads``; when omitted the ticker is read from the
    payload's ``General.Code``.
    """
    warning_sink = warning_sink or (lambda message: print(message, file=sys.stderr))
    if quote_fetcher is None:
        quote_fetcher = lambda symbol: fetch_yahoo_chart_quote(symbol, cache_dir=cache_dir)
    companies: list[dict] = []
    for index, payload in enumerate(payloads):
        ticker = normalise_us_ticker(tickers[index]) if tickers and index < len(tickers) else None
        fallback_code = None
        general = payload.get("General") if isinstance(payload, dict) and isinstance(payload.get("General"), dict) else {}
        fallback_code = str(general.get("Code") or "").strip().upper() or None
        if not ticker:
            ticker = normalise_us_ticker(fallback_code) if fallback_code else normalise_us_ticker("UNKNOWN")
        try:
            quote = quote_fetcher(ticker)
            companies.append(build_company_from_eodhd_fundamentals(ticker, payload, quote))
        except Exception as exc:
            if failure_sink:
                failure_sink({
                    "ticker": ticker,
                    "reason": str(exc),
                    "recoverable": True,
                    "provider": "yahoo-finance",
                    "source_family": "yahoo-finance",
                    "failed_at": _now_iso(),
                })
            warning_sink(f"WARNING: failed to hydrate {ticker} US quote: {exc}")
        if sleep_seconds and index != len(payloads) - 1:
            time.sleep(sleep_seconds)
    return companies


def _eodhd_payload_has_annual_fundamentals(payload: dict) -> bool:
    depth = EodhdAdapter._statement_depth(payload)
    return any(int(depth.get(section) or 0) > 0 for section in ("income", "balance_sheet", "cash_flow"))


def _fetch_us_eodhd_companies(
    tickers: list[str],
    eodhd: "EodhdAdapter",
    cache_dir: Optional[Path] = None,
    sleep_seconds: float = 0.3,
    failure_sink: Optional[Callable[[dict], None]] = None,
) -> list[dict]:
    """Fetch raw EODHD fundamentals payloads + Yahoo quotes and build US company rows.

    Bounded to the provided ``tickers``. Each ticker needs exactly one EODHD
    fundamentals call plus one Yahoo chart quote (for live price). Failures are
    recorded via ``failure_sink`` and skipped; nothing is imputed.
    """
    companies: list[dict] = []
    for index, ticker in enumerate(tickers):
        try:
            payload = eodhd.fetch_payload(ticker)
            if not payload:
                if eodhd.last_error is not None:
                    raise eodhd.last_error
                if failure_sink:
                    failure_sink({
                        "ticker": ticker,
                        "reason": "EODHD fundamentals returned no payload (0 statement rows)",
                        "recoverable": True,
                        "provider": "eodhd",
                        "source_family": "eodhd",
                        "failed_at": _now_iso(),
                    })
                continue
            if not _eodhd_payload_has_annual_fundamentals(payload):
                if failure_sink:
                    failure_sink({
                        "ticker": ticker,
                        "reason": "EODHD fundamentals returned no annual statement rows",
                        "recoverable": True,
                        "provider": "eodhd",
                        "source_family": "eodhd",
                        "failed_at": _now_iso(),
                    })
                continue
            # Yahoo chart quote uses the bare NASDAQ/NYSE symbol (no .US suffix).
            quote_symbol = _us_code_from_ticker(ticker)
            quote = fetch_yahoo_chart_quote(quote_symbol, cache_dir=cache_dir)
            companies.append(build_company_from_eodhd_fundamentals(ticker, payload, quote))
        except Exception as exc:
            if failure_sink:
                failure_sink({
                    "ticker": ticker,
                    "reason": _redact_secrets_in_text(str(exc)),
                    "recoverable": True,
                    "provider": "eodhd",
                    "source_family": "eodhd",
                    "failed_at": _now_iso(),
                })
        if sleep_seconds and index != len(tickers) - 1:
            time.sleep(sleep_seconds)
    return companies


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _field_is_fallback_fillable(fv: Optional[FieldValue], max_age_days: int = 730) -> bool:
    """Return True when a provider fallback may safely replace this field.

    Fresh existing values are preserved. Missing values and values already marked
    stale, or whose provenance timestamp is outside the hard freshness window,
    can be replaced by a configured fallback provider. This is deliberately
    conservative: it never overwrites a fresh Yahoo value just because another
    public endpoint disagrees.
    """
    if fv is None or fv.value is None:
        return True
    prov = fv.provenance or {}
    if prov.get("stale"):
        return True
    as_of = _parse_provenance_time(
        prov.get("data_as_of") or prov.get("retrieved_from_source_at") or prov.get("retrieved_at")
    )
    if as_of is None:
        return False
    return (datetime.datetime.now(datetime.timezone.utc) - as_of).days > max_age_days


def _company_needs_provider_fallback(company: dict) -> bool:
    return any(_field_is_fallback_fillable(company.get(field_name)) for field_name in RAW_FIELDS)


def _coerce_float(value: Any) -> Optional[float]:
    """Coerce a provider numeric value (int/float/str) to float, or None."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _first_dated(items: list[dict], date_keys: tuple[str, ...]) -> Optional[dict]:
    """Return the most recent item by date across common provider date fields."""
    dated = [
        item for item in items
        if any(str(item.get(key) or "").strip() for key in date_keys)
    ]
    if not dated:
        return None
    return max(
        dated,
        key=lambda item: str(next((item.get(key) for key in date_keys if item.get(key)), "")),
    )


_SECRET_QUERY_PARAMS = frozenset({"apikey", "api_key", "api_token", "access_token", "key", "token", "signature", "sig", "session", "sessionid", "session_id", "sid"})
_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)(?<![A-Za-z0-9_])"
    r"(" + "|".join(re.escape(param) for param in sorted(_SECRET_QUERY_PARAMS, key=len, reverse=True)) + r")"
    r"(\s*=\s*)"
    r"([^&;\s\"'<>]+)"
)


def _redact_secrets_in_text(text: str) -> str:
    """Redact secret-bearing URLs and query params embedded inside free text.

    ``redact_url_secrets`` handles a bare URL; this helper scans a longer
    string (e.g. a provider error reason) for any ``scheme://...`` URL and
    sanitizes it, then strips any leftover ``secret=value`` query fragments
    that may not be part of a full URL.
    """
    if not text or not isinstance(text, str):
        return text
    out = text
    # Redact any http(s) URL token inline.
    out = re.sub(r"https?://[^\s\"'<>]+", lambda m: redact_url_secrets(m.group(0)), out)
    # Redact bare/embedded secret assignments that survive (e.g. "apikey=XYZ" or "token = XYZ").
    return _SECRET_ASSIGNMENT_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}<REDACTED>", out)



def redact_url_secrets(url: str) -> str:
    """Return ``url`` with secret query params (apikey, token, ...) removed.

    Provider request URLs carry credentials in their query string (e.g.
    ``?apikey=<KEY>``). Those URLs must never be persisted into provenance
    artifacts (jsonl, parquet, Postgres ``source_url``), so strip secret params
    before persistence while leaving benign params (``function``, ``symbol``,
    ...) intact for provenance richness. The transient in-memory request keeps
    the full URL; only persisted provenance is sanitized.
    """
    if not url or not isinstance(url, str):
        return url
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return url
    if not parsed.query:
        return url
    kept = [
        (k, v)
        for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        if k.lower() not in _SECRET_QUERY_PARAMS
    ]
    new_query = urllib.parse.urlencode(kept) if kept else ""
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, new_query, parsed.fragment)
    )


class ProviderAdapter:
    """Base class for a single credentialed fundamentals provider.

    Fail-closed by default: an adapter with no credential/config is a no-op that
    returns no fields and never touches the network. Subclasses define ``name``,
    ``env_var``, ``trust_level`` and a ``_fetch_fields`` implementation.
    """

    name: str = "unknown"
    env_var: str = ""
    trust_level: str = "licensed"

    def __init__(self, env: Optional[dict] = None, fetcher: Optional[Callable] = None):
        self._env = dict(env or {})
        self._fetcher = fetcher
        self.last_error: Optional[BaseException] = None

    def credential(self) -> Optional[str]:
        value = self._env.get(self.env_var)
        if value is None:
            value = os.environ.get(self.env_var)
        return str(value).strip() if value else None

    def enabled(self) -> bool:
        return bool(self.credential())

    def status(self) -> dict:
        if self.enabled():
            return {"name": self.name, "enabled": True, "reason": None}
        return {
            "name": self.name,
            "enabled": False,
            "reason": f"missing {self.env_var} credential; adapter disabled (fail-closed)",
        }

    def _get_json(self, url: str, timeout: int = 30) -> dict:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())

    def fetch(self, ticker: str) -> dict[str, FieldValue]:
        """Return normalized {field_name: FieldValue}. Empty when disabled/failed."""
        self.last_error = None
        if not self.enabled():
            return {}
        try:
            return self._fetch_fields(ticker)
        except Exception as exc:
            # Rate-limit (429), 402, and other failures degrade to "no data",
            # never to fabricated values. The caller records this as a partial
            # run state, not a hard failure.
            self.last_error = exc
            return {}

    def _fetch_fields(self, ticker: str) -> dict[str, FieldValue]:
        raise NotImplementedError

    def _field(
        self,
        name: str,
        value: Any,
        source_url: str,
        data_as_of: Optional[str],
        currency: Optional[str] = None,
        filing_reference: str = "ASX filings / announcements",
    ) -> FieldValue:
        if name == "capital_expenditures" and value is not None:
            value = -abs(float(value))
        unit = _default_unit_for_field(name)
        is_currency_unit = unit == "currency"
        # Default currency for currency-unit fields is AUD (preserving existing
        # FMP/AlphaVantage semantics); multi-market adapters pass ``currency``
        # explicitly. Non-currency fields (shares, ratios) carry no currency.
        if currency is None:
            currency = "AUD"
        return FieldValue(
            value=_coerce_float(value),
            provenance={
                "source_family": self.name,
                "provider": self.name,
                "source_url": redact_url_secrets(source_url),
                "source_url_sanitized": True,
                "retrieved_at": _now_iso(),
                "retrieved_from_source_at": _now_iso(),
                "data_as_of": data_as_of,
                "period_end": data_as_of,
                "field_name": name,
                "unit": unit,
                "currency": currency if is_currency_unit else None,
                "scale": "ones" if unit in {"currency", "shares"} else "ratio",
                "period_type": "annual",
                "confidence": "medium",
                "trust_level": "licensed_provider_normalized_statement",
                "stale": False,
                "method": "reported",
                "caveats": [
                    f"{self.name} provider-normalized statement; verify against {filing_reference} before investment action."
                ],
                "freshness": (
                    f"{self.name} licensed fundamentals; verify against {filing_reference} "
                    "before acting"
                ),
            },
        )


class FmpAdapter(ProviderAdapter):
    """Financial Modeling Prep fundamentals adapter (recommended Stage 1 provider)."""

    name = "fmp"
    env_var = "FMP_API_KEY"

    def _fetch_fields(self, ticker: str) -> dict[str, FieldValue]:
        key = self.credential()
        base = "https://financialmodelingprep.com/stable"
        # FMP uses bare exchange codes for ASX (e.g. BHP.AX -> BHP).
        symbol = normalise_asx_ticker(ticker).replace(".AX", "")
        params = f"?symbol={urllib.parse.quote(symbol)}&apikey={urllib.parse.quote(key or '')}"

        fields: dict[str, FieldValue] = {}
        failures: list[str] = []

        fetcher = self._fetcher or self._get_json

        def fetch_statement(path: str) -> tuple[Any, str]:
            url = f"{base}/{path}{params}"
            try:
                return fetcher(url), url
            except urllib.error.HTTPError as exc:
                failures.append(
                    f"{path} status {exc.code} {getattr(exc, 'reason', '')}: {redact_url_secrets(exc.url or url)}"
                )
                return None, url

        income, income_url = fetch_statement("income-statement")
        inc = _first_dated(income or [], ("date",)) if isinstance(income, list) else {}
        if inc:
            fields["revenue"] = self._field("revenue", inc.get("revenue"), income_url, str(inc.get("date") or ""))
            fields["net_income"] = self._field("net_income", inc.get("netIncome"), income_url, str(inc.get("date") or ""))

        balance, bal_url = fetch_statement("balance-sheet-statement")
        bal = _first_dated(balance or [], ("date",)) if isinstance(balance, list) else {}
        if bal:
            fields["total_assets"] = self._field("total_assets", bal.get("totalAssets"), bal_url, str(bal.get("date") or ""))
            fields["total_liabilities"] = self._field("total_liabilities", bal.get("totalLiabilities"), bal_url, str(bal.get("date") or ""))
            fields["current_assets"] = self._field("current_assets", bal.get("totalCurrentAssets"), bal_url, str(bal.get("date") or ""))
            fields["current_liabilities"] = self._field("current_liabilities", bal.get("totalCurrentLiabilities"), bal_url, str(bal.get("date") or ""))

        cashflow, cf_url = fetch_statement("cash-flow-statement")
        cf = _first_dated(cashflow or [], ("date",)) if isinstance(cashflow, list) else {}
        if cf:
            fields["operating_cash_flow"] = self._field("operating_cash_flow", cf.get("operatingCashFlow"), cf_url, str(cf.get("date") or ""))
            fields["capital_expenditures"] = self._field("capital_expenditures", cf.get("capitalExpenditure"), cf_url, str(cf.get("date") or ""))

        if failures:
            self.last_error = RuntimeError("recoverable FMP endpoint failures: " + "; ".join(failures))

        return fields


class EodhdAdapter(ProviderAdapter):
    """EODHD fundamentals adapter — multi-market (``.US`` and ``.AU``) annual fills.

    One call to ``/fundamentals/{SYMBOL}?api_token=...&fmt=json`` returns the
    balance sheet, income statement, cash flow, plus ``General`` identity and
    ``SharesStats``/``outstandingShares``. ``_fetch_fields`` maps the most recent
    annual rows into the screener's normalized ``FieldValue`` names. Identity
    fields (sector/industry/name/currency/exchange) are returned alongside raw
    financials so a multi-market hydration path can build a full company row.

    Fail-closed: no credential -> no network, empty result. Never fabricates
    current assets/liabilities from totals.
    """

    name = "eodhd"
    env_var = "EODHD_API_KEY"
    base_url = "https://eodhd.com/api/fundamentals"

    # EODHD fundamentals returns string-formatted numbers ("416161000000.00").
    # _coerce_float already handles comma/whitespace stripping; we additionally
    # drop the trailing ".00" formatting by passing through _coerce_float.

    @staticmethod
    def _yearly_rows(section: Any) -> list[dict]:
        """Return annual rows (dict or list keyed by index/date), newest-first."""
        if not isinstance(section, dict):
            return []
        yearly = section.get("yearly") or section.get("Yearly") or section.get("annual")
        if isinstance(yearly, dict):
            raw = [row for row in yearly.values() if isinstance(row, dict)]
        elif isinstance(yearly, list):
            raw = [row for row in yearly if isinstance(row, dict)]
        else:
            raw = []
        # If rows carry no date, preserve provider ordering (already newest-first
        # in practice) rather than silently reordering on a missing key.
        dated = [row for row in raw if EodhdAdapter._row_date(row)]
        undated = [row for row in raw if not EodhdAdapter._row_date(row)]
        ordered = sorted(dated, key=lambda row: EodhdAdapter._row_date(row), reverse=True) + undated
        return ordered

    @staticmethod
    def _first_present(row: dict, *names: str) -> Any:
        for name in names:
            value = row.get(name)
            if value is not None:
                return value
        return None

    @staticmethod
    def _row_date(row: dict) -> str:
        return str(row.get("date") or row.get("filing_date") or row.get("period") or "")

    def _fetch_fields(self, ticker: str) -> dict[str, FieldValue]:
        key = self.credential()
        symbol = self._normalise_symbol(ticker)
        url = f"{self.base_url}/{urllib.parse.quote(symbol)}?api_token={urllib.parse.quote(key or '')}&fmt=json"
        fetcher = self._fetcher or self._get_json

        if self._fetcher is None:
            # Paid endpoint, but still external infrastructure. Keep live backfills gentle.
            try:
                sleep_seconds = float(os.environ.get("EODHD_PROVIDER_FALLBACK_SLEEP_SECONDS", "0.75") or 0.75)
            except ValueError:
                sleep_seconds = 0.75
            time.sleep(max(sleep_seconds, 0.75))

        try:
            payload = fetcher(url)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(
                f"recoverable EODHD fundamentals failure: status {exc.code} "
                f"{getattr(exc, 'reason', '')}: {redact_url_secrets(exc.url or url)}"
            ) from exc

        if not isinstance(payload, dict):
            return {}
        return self._parse_payload(payload, url)

    def _normalise_symbol(self, ticker: str) -> str:
        upper = str(ticker or "").strip().upper()
        if upper.endswith(".US"):
            return upper
        if upper.endswith(".AX"):
            return upper.replace(".AX", ".AU")
        if upper.endswith(".AU"):
            return upper
        # Bare symbol: treat as the EODHD fundamentals US contract by default.
        return upper + ".US"

    def fetch_payload(self, ticker: str) -> Optional[dict]:
        """Fetch the raw EODHD fundamentals JSON payload for ``ticker``.

        Returns the parsed JSON dict, or ``None`` on any failure/empty response.
        ``last_error`` carries a redacted error message for recoverable failures.
        This is the multi-market hydration path's raw-payload accessor (the
        normalized ``fetch`` path returns FieldValue mappings instead).
        """
        self.last_error = None
        if not self.enabled():
            return None
        key = self.credential()
        symbol = self._normalise_symbol(ticker)
        url = f"{self.base_url}/{urllib.parse.quote(symbol)}?api_token={urllib.parse.quote(key or '')}&fmt=json"
        fetcher = self._fetcher or self._get_json
        if self._fetcher is None:
            try:
                sleep_seconds = float(os.environ.get("EODHD_PROVIDER_FALLBACK_SLEEP_SECONDS", "0.75") or 0.75)
            except ValueError:
                sleep_seconds = 0.75
            time.sleep(max(sleep_seconds, 0.75))
        try:
            payload = fetcher(url)
        except urllib.error.HTTPError as exc:
            self.last_error = RuntimeError(
                f"recoverable EODHD fundamentals failure: status {exc.code} "
                f"{getattr(exc, 'reason', '')}: {redact_url_secrets(exc.url or url)}"
            )
            return None
        except Exception as exc:
            self.last_error = RuntimeError(_redact_secrets_in_text(str(exc)))
            return None
        if not isinstance(payload, dict):
            self.last_error = RuntimeError("EODHD fundamentals returned non-JSON payload")
            return None
        return payload

    @staticmethod
    def _coerce_raw(value: Any) -> Optional[float]:
        return _coerce_float(value)

    def _extract_identity(self, payload: dict) -> dict:
        general = payload.get("General") if isinstance(payload.get("General"), dict) else {}
        code = str(general.get("Code") or "").strip().upper() or None
        name = str(general.get("Name") or "").strip() or None
        return {
            "company_id": _us_company_id(code) if code else None,
            "us_code": code,
            "name": name,
            "name_raw": name,
            "name_normalized": _normalise_us_company_name(name) if name else None,
            "currency": str(general.get("CurrencyCode") or "USD").strip().upper(),
            "exchange": str(general.get("Exchange") or "").strip().upper() or None,
            "region": str(general.get("CountryISO") or "US").strip().upper(),
            "sector": _titlecase_us_classification(general.get("Sector") or general.get("GicSector")),
            "industry": _titlecase_us_classification(general.get("Industry") or general.get("GicIndustry")),
            "security_type": US_DEFAULT_SECURITY_TYPE,
            "market": "US",
        }

    @staticmethod
    def _statement_depth(payload: dict) -> dict:
        financials = payload.get("Financials") if isinstance(payload.get("Financials"), dict) else {}
        return {
            "income": len(EodhdAdapter._yearly_rows(financials.get("Income_Statement"))),
            "balance_sheet": len(EodhdAdapter._yearly_rows(financials.get("Balance_Sheet"))),
            "cash_flow": len(EodhdAdapter._yearly_rows(financials.get("Cash_Flow"))),
        }

    def _shared_row_fields(self, financials: dict, url: str, currency: str) -> dict[str, FieldValue]:
        income_rows = self._yearly_rows(financials.get("Income_Statement"))
        balance_rows = self._yearly_rows(financials.get("Balance_Sheet"))
        cash_rows = self._yearly_rows(financials.get("Cash_Flow"))
        income = income_rows[0] if income_rows else {}
        prior_income = income_rows[1] if len(income_rows) > 1 else {}
        balance = balance_rows[0] if balance_rows else {}
        cash = cash_rows[0] if cash_rows else {}

        fields: dict[str, FieldValue] = {}
        if income:
            fields["revenue"] = self._field(
                "revenue", self._first_present(income, "totalRevenue", "revenue"), url, self._row_date(income), currency=currency
            )
            fields["net_income"] = self._field(
                "net_income",
                self._first_present(income, "netIncome", "netIncomeApplicableToCommonShares"),
                url, self._row_date(income), currency=currency,
            )
            fields["shares_outstanding_proxy"] = self._field(
                "shares_outstanding",
                self._first_present(income, "dilutedWeightedAverageShares", "weightedAverageDilutedShares"),
                url, self._row_date(income),
            )
        if prior_income:
            fields["prior_revenue"] = self._field(
                "prior_revenue",
                self._first_present(prior_income, "totalRevenue", "revenue"),
                url, self._row_date(prior_income), currency=currency,
            )
        if balance:
            fields["total_assets"] = self._field(
                "total_assets", self._first_present(balance, "totalAssets"), url, self._row_date(balance), currency=currency
            )
            fields["total_liabilities"] = self._field(
                "total_liabilities",
                self._first_present(balance, "totalLiab", "totalLiabilities", "totalLiabilitiesNetMinorityInterest"),
                url, self._row_date(balance), currency=currency,
            )
            fields["current_assets"] = self._field(
                "current_assets", self._first_present(balance, "totalCurrentAssets"), url, self._row_date(balance), currency=currency
            )
            fields["current_liabilities"] = self._field(
                "current_liabilities", self._first_present(balance, "totalCurrentLiabilities"), url, self._row_date(balance), currency=currency
            )
        if cash:
            fields["operating_cash_flow"] = self._field(
                "operating_cash_flow",
                self._first_present(cash, "totalCashFromOperatingActivities", "operatingCashFlow", "operatingCashflow"),
                url, self._row_date(cash), currency=currency,
            )
            fields["capital_expenditures"] = self._field(
                "capital_expenditures",
                self._first_present(cash, "capitalExpenditures", "capitalExpenditure"),
                url, self._row_date(cash), currency=currency,
            )
        # No-imputation policy: never emit a FieldValue whose value is None from a
        # mapped statement line. Missing lines simply yield no key, so the merge
        # layer marks them "unavailable" rather than treating a fabricated None as
        # reported data. The shares_outstanding proxy is a placeholder dropped
        # later; filter it on value presence here too.
        return {name: fv for name, fv in fields.items() if fv.value is not None}

    def _parse_payload(self, payload: dict, url: str) -> dict[str, FieldValue]:
        """Map a fundamentals payload to normalized FieldValues, plus identity/depth.

        Returns a dict that includes the raw financial fields PLUS special keys:
          - ``_identity``   (dict): General identity for building a company row
          - ``_financials_depth`` (dict): annual row depth per statement
          - ``_shares_outstanding`` (float): SharesStats/outstandingShares value
        """
        general = payload.get("General") if isinstance(payload.get("General"), dict) else {}
        currency = str(general.get("CurrencyCode") or "USD").strip().upper()
        financials = payload.get("Financials") if isinstance(payload.get("Financials"), dict) else {}

        result = self._shared_row_fields(financials, url, currency)

        # shares_outstanding: prefer SharesStats.SharesOutstanding, fall back to
        # the top-level outstandingShares annual series (dict keyed by index).
        shares = self._extract_shares_outstanding(payload)
        if shares is not None:
            result["shares_outstanding"] = FieldValue(
                value=shares,
                provenance={
                    "source_family": self.name,
                    "provider": self.name,
                    "source_url": redact_url_secrets(url),
                    "source_url_sanitized": True,
                    "retrieved_at": _now_iso(),
                    "retrieved_from_source_at": _now_iso(),
                    "data_as_of": None,
                    "field_name": "shares_outstanding",
                    "unit": "shares",
                    "currency": None,
                    "scale": "ones",
                    "period_type": "latest_market",
                    "confidence": "medium",
                    "trust_level": "licensed_provider_normalized_statement",
                    "stale": False,
                    "method": "reported",
                    "caveats": [
                        f"{self.name} provider SharesStats; verify against SEC/company filings before investment action."
                    ],
                    "freshness": f"{self.name} licensed shares outstanding; verify against company filings",
                },
            )
        # Drop the proxy placeholder (only populated when income has a diluted
        # share count, which we do not currently prefer over SharesStats).
        result.pop("shares_outstanding_proxy", None)

        result["_identity"] = self._extract_identity(payload)
        result["_financials_depth"] = self._statement_depth(payload)
        result["_shares_outstanding"] = shares
        return result

    @staticmethod
    def _extract_shares_outstanding(payload: dict) -> Optional[float]:
        stats = payload.get("SharesStats")
        if isinstance(stats, dict):
            value = _coerce_float(stats.get("SharesOutstanding"))
            if value is not None:
                return value
        series = payload.get("outstandingShares")
        if isinstance(series, dict):
            annual = series.get("annual")
            if isinstance(annual, dict):
                # Keyed by index string; pick the largest numeric key (most recent).
                keys = sorted((k for k in annual if str(k).isdigit()), key=int, reverse=True)
                for k in keys:
                    row = annual[k]
                    if isinstance(row, dict):
                        value = _coerce_float(row.get("shares"))
                        if value is not None:
                            return value
        return None


class AlphaVantageAdapter(ProviderAdapter):
    """Alpha Vantage fundamentals adapter (spot-fill only; 25 req/day free tier)."""

    name = "alpha_vantage"
    env_var = "ALPHA_VANTAGE_API_KEY"

    def _fetch_fields(self, ticker: str) -> dict[str, FieldValue]:
        key = self.credential()
        symbol = normalise_asx_ticker(ticker).replace(".AX", "")
        base = "https://www.alphavantage.co/query"
        fields: dict[str, FieldValue] = {}
        fetcher = self._fetcher or self._get_json

        def q(function: str):
            url = (
                f"{base}?function={function}&symbol={urllib.parse.quote(symbol)}"
                f"&apikey={urllib.parse.quote(key or '')}"
            )
            return fetcher(url), url

        income, iurl = q("INCOME_STATEMENT")
        reports = income.get("annualReports") or [] if isinstance(income, dict) else []
        inc = reports[0] if reports else {}
        if inc:
            fields["revenue"] = self._field("revenue", inc.get("totalRevenue"), iurl, str(inc.get("fiscalDateEnding") or ""))
            fields["net_income"] = self._field("net_income", inc.get("netIncome"), iurl, str(inc.get("fiscalDateEnding") or ""))

        balance, burl = q("BALANCE_SHEET")
        breports = balance.get("annualReports") or [] if isinstance(balance, dict) else []
        bal = breports[0] if breports else {}
        if bal:
            fields["total_assets"] = self._field("total_assets", bal.get("totalAssets"), burl, str(bal.get("fiscalDateEnding") or ""))
            fields["total_liabilities"] = self._field("total_liabilities", bal.get("totalLiabilities"), burl, str(bal.get("fiscalDateEnding") or ""))
            fields["current_assets"] = self._field("current_assets", bal.get("totalCurrentAssets"), burl, str(bal.get("fiscalDateEnding") or ""))
            fields["current_liabilities"] = self._field("current_liabilities", bal.get("totalCurrentLiabilities"), burl, str(bal.get("fiscalDateEnding") or ""))

        cashflow, curl = q("CASH_FLOW")
        creports = cashflow.get("annualReports") or [] if isinstance(cashflow, dict) else []
        cf = creports[0] if creports else {}
        if cf:
            fields["operating_cash_flow"] = self._field("operating_cash_flow", cf.get("operatingCashflow"), curl, str(cf.get("fiscalDateEnding") or ""))
            fields["capital_expenditures"] = self._field("capital_expenditures", cf.get("capitalExpenditures"), curl, str(cf.get("fiscalDateEnding") or ""))

        return fields


class AsxMarkitDigitalAdapter(ProviderAdapter):
    """Public ASX-site MarkitDigital fallback adapter, disabled by default."""

    name = "asx_markitdigital"
    env_var = "ASX_MARKITDIGITAL_ENABLED"
    trust_level = "exchange_site_public"
    base_url = "https://asx.api.markitdigital.com/asx-research/1.0/companies"

    def enabled(self) -> bool:
        value = self._env.get(self.env_var)
        if value is None:
            value = os.environ.get(self.env_var)
        return str(value or "").strip().lower() in {"1", "true", "yes", "on"}

    def status(self) -> dict:
        if self.enabled():
            return {"name": self.name, "enabled": True, "reason": None}
        return {
            "name": self.name,
            "enabled": False,
            "reason": f"missing/false {self.env_var} config flag; adapter disabled (fail-closed)",
        }

    def _endpoint_url(self, symbol: str, endpoint: str) -> str:
        return f"{self.base_url}/{urllib.parse.quote(symbol)}/{endpoint}"

    @staticmethod
    def _excel_serial_date(value: Any) -> Optional[str]:
        """Convert MarkitDigital/Excel serial dates to ISO dates when present."""
        serial = _coerce_float(value)
        if serial is None:
            return None
        try:
            # Excel's 1900 leap-year bug means day 1 is 1899-12-31 for serials
            # before 60 and 1899-12-30 for modern serial dates. ASX statement
            # period-end serials are modern; keep the normal Excel convention.
            return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(serial))).isoformat()
        except (OverflowError, ValueError):
            return None

    @staticmethod
    def _fiscal_year(period: Optional[str]) -> Optional[str]:
        if not period:
            return None
        match = re.match(r"^(\d{4})", str(period).strip())
        return match.group(1) if match else None

    @staticmethod
    def _first_present(*values: Any) -> Any:
        for value in values:
            if value is not None:
                return value
        return None

    def _fetch_fields(self, ticker: str) -> dict[str, FieldValue]:
        symbol = normalise_asx_ticker(ticker).replace(".AX", "")
        fetcher = self._fetcher or self._get_json
        key_url = self._endpoint_url(symbol, "key-statistics")
        header_url = self._endpoint_url(symbol, "header")
        key_stats = fetcher(key_url, timeout=30)
        if self._fetcher is None:
            # This public ASX endpoint is undocumented. Be boring and gentle.
            try:
                sleep_seconds = float(os.environ.get("ASX_PROVIDER_FALLBACK_SLEEP_SECONDS", "0.75") or 0.75)
            except ValueError:
                sleep_seconds = 0.75
            time.sleep(max(sleep_seconds, 0.75))
        header = fetcher(header_url, timeout=30)

        key_data = key_stats.get("data") if isinstance(key_stats, dict) else None
        header_data = header.get("data") if isinstance(header, dict) else None
        if not isinstance(key_data, dict):
            key_data = {}
        if not isinstance(header_data, dict):
            header_data = {}

        fields: dict[str, FieldValue] = {}
        income_rows = key_data.get("incomeStatement") if isinstance(key_data, dict) else []
        if not isinstance(income_rows, list):
            income_rows = []
        income = income_rows[0] if income_rows and isinstance(income_rows[0], dict) else {}
        prior_income = income_rows[1] if len(income_rows) > 1 and isinstance(income_rows[1], dict) else {}
        period = str(income.get("period") or "") if income else None
        prior_period = str(prior_income.get("period") or "") if prior_income else None
        period_end = self._excel_serial_date(income.get("fPeriodEndDate")) if income else None
        prior_period_end = self._excel_serial_date(prior_income.get("fPeriodEndDate")) if prior_income else None

        def add_field(
            name: str,
            value: Any,
            url: str,
            data_as_of: Optional[str],
            path: str,
            period_type: str,
            source_period: Optional[str] = None,
        ) -> None:
            coerced = _coerce_float(value)
            if coerced is None:
                return
            fields[name] = FieldValue(
                value=coerced,
                provenance={
                    "source_family": self.name,
                    "provider": self.name,
                    "source_url": redact_url_secrets(url),
                    "source_url_family": "https://asx.api.markitdigital.com/asx-research/1.0/companies/{symbol}/{endpoint}",
                    "source_url_sanitized": True,
                    "retrieved_at": _now_iso(),
                    "retrieved_from_source_at": _now_iso(),
                    "data_as_of": data_as_of,
                    "period_end": data_as_of,
                    "fiscal_year": self._fiscal_year(source_period),
                    "source_reported_period": source_period,
                    "field_name": name,
                    "source_path": path,
                    "unit": _default_unit_for_field(name),
                    "currency": "AUD" if _default_unit_for_field(name) == "currency" else None,
                    "scale": "ones" if _default_unit_for_field(name) in {"currency", "shares"} else "ratio",
                    "period_type": period_type,
                    "confidence": "low",
                    "trust_level": self.trust_level,
                    "stale": False,
                    "method": "reported_public_endpoint",
                    "notes": "undocumented public ASX-site endpoint; verify against ASX announcements/company reports before acting",
                    "caveats": [
                        "ASX MarkitDigital is an undocumented public ASX-site endpoint; use only as fail-closed missing-field fallback."
                    ],
                    "freshness": "ASX MarkitDigital public endpoint fallback; verify before use",
                },
            )

        price_value = self._first_present(
            key_data.get("priceAsk"),
            header_data.get("priceLast"),
            header_data.get("priceAsk"),
            key_data.get("priceClose"),
        )
        price_path = "data.priceAsk" if key_data.get("priceAsk") is not None else "data.priceLast"
        add_field("price", price_value, key_url if key_data.get("priceAsk") is not None else header_url, None, price_path, "latest_market")
        add_field("shares_outstanding", key_data.get("numOfShares"), key_url, None, "data.numOfShares", "latest_market")
        add_field("revenue", income.get("revenue"), key_url, period_end, "data.incomeStatement[0].revenue", "annual", period)
        add_field("prior_revenue", prior_income.get("revenue"), key_url, prior_period_end, "data.incomeStatement[1].revenue", "annual", prior_period)
        add_field("net_income", income.get("netIncome"), key_url, period_end, "data.incomeStatement[0].netIncome", "annual", period)
        # The endpoint also returns header marketCap, but the screener keeps
        # market_cap derived from price * shares_outstanding; do not introduce a
        # raw balance-sheet/cash-flow field the endpoint did not return.
        return fields


ADAPTER_CLASSES: dict[str, type] = {
    "fmp": FmpAdapter,
    "alpha_vantage": AlphaVantageAdapter,
    "eodhd": EodhdAdapter,
    "asx_markitdigital": AsxMarkitDigitalAdapter,
}


def build_fallback_adapters(env: Optional[dict] = None) -> list[ProviderAdapter]:
    """Build enabled, trust-ordered fallback adapters from available credentials.

    Only adapters with a present credential/config are returned. Order follows
    PROVIDER_TRUST_RANK so the merge can prefer the highest-trust provider.
    """
    env = dict(env or {})
    adapters: list[ProviderAdapter] = []
    for name in sorted(ADAPTER_CLASSES, key=lambda n: PROVIDER_TRUST_RANK.get(n, 99)):
        adapter = ADAPTER_CLASSES[name](env=env)
        if adapter.enabled():
            adapters.append(adapter)
    return adapters


def merge_missing_fields(
    company: dict,
    provider_fields: list[tuple[str, dict[str, FieldValue]]],
) -> tuple[dict, dict[str, str]]:
    """Fill missing raw fields from fallback providers, preserving provenance.

    For each raw field that is currently missing (value is None), prefer the
    highest-trust provider (provider order as given) that supplied a non-None
    value. Existing values are never overwritten. Fields still missing after the
    merge are re-marked with ``missing_reason: unavailable``.

    Returns ``(company, filled)`` where ``filled`` maps field_name -> provider
    that supplied it.
    """
    company = dict(company)
    filled: dict[str, str] = {}

    for field_name in RAW_FIELDS:
        fv: Optional[FieldValue] = company.get(field_name)
        if not _field_is_fallback_fillable(fv):
            continue
        reject_zero = field_name in BALANCE_CASHFLOW_FIELDS
        for provider_name, fields in provider_fields:
            candidate = fields.get(field_name)
            if candidate is not None and candidate.value is not None:
                if reject_zero and candidate.value == 0:
                    # A zero balance-sheet/cash-flow line is a fabrication risk, not a
                    # legitimate fill. Reject it so a fabricated zero can never satisfy
                    # the "fully hydrated" bar. Mark for downstream visibility.
                    continue
                company[field_name] = sanitized_field_value(field_name, candidate)
                filled[field_name] = provider_name
                break

    # Any still-missing field gets an explicit unavailable reason so scoring can
    # distinguish provider-absent from fetch-failed. This overwrites any earlier
    # per-provider "provider_absent" marker with the post-merge truth: no
    # configured source supplied a value.
    for field_name in RAW_FIELDS:
        fv: Optional[FieldValue] = company.get(field_name)
        if fv is None:
            company[field_name] = missing_field_value(field_name, "unavailable", "no-provider")
        elif fv.value is None:
            fv.provenance["missing_reason"] = "unavailable"

    provider_inputs = [
        (provider_name, {name: fv for name, fv in fields.items() if filled.get(name) == provider_name})
        for provider_name, fields in provider_fields
    ]
    provider_inputs = [(provider_name, fields) for provider_name, fields in provider_inputs if fields]
    try:
        consolidated = consolidate_company_fields(company, provider_inputs)
        company["multi_source_fields"] = consolidated["fields"]
        company["field_quality"] = consolidated["field_quality"]
        company["source_summary"] = consolidated["source_summary"]
        company["provider_priority_version"] = consolidated["provider_priority_version"]
        company["threshold_version"] = consolidated["threshold_version"]
    except Exception:
        # Consolidation is diagnostic metadata; never let it make existing safe
        # fill-only behavior less reliable. Tests cover the normal path.
        pass

    return company, filled


def fill_company_missing_fields(
    company: dict,
    adapters: list[ProviderAdapter],
) -> tuple[dict, list[dict]]:
    """Fetch fallback fields from enabled adapters and merge them into a company.

    Adapters are queried in trust order. Disabled/erroring adapters are skipped
    silently (their absence is already represented by the missing field). Returns
    ``(company, failures)``; failures records per-adapter fetch errors (e.g. 429)
    as recoverable partial-run notes, never as fabricated data.
    """
    provider_fields: list[tuple[str, dict[str, FieldValue]]] = []
    failures: list[dict] = []
    for adapter in adapters:
        try:
            fields = adapter.fetch(str(company.get("ticker") or ""))
        except Exception as exc:
            failures.append({
                "provider": adapter.name,
                "source_family": adapter.name,
                "ticker": company.get("ticker"),
                "reason": _redact_secrets_in_text(str(exc)),
                "recoverable": True,
                "failed_at": _now_iso(),
            })
            continue
        if adapter.last_error is not None:
            failures.append({
                "provider": adapter.name,
                "source_family": adapter.name,
                "ticker": company.get("ticker"),
                "reason": _redact_secrets_in_text(str(adapter.last_error)),
                "recoverable": True,
                "failed_at": _now_iso(),
            })
        if fields:
            provider_fields.append((adapter.name, fields))

    merged, _ = merge_missing_fields(company, provider_fields)
    return merged, failures



# ---------------------------------------------------------------------------
# Multi-source field consolidation
# ---------------------------------------------------------------------------

FIELD_CONSOLIDATION_VERSION = "field-consolidation/v1"
FIELD_THRESHOLD_VERSION = "asx-fundamentals-thresholds/2026-08-28"

_FIELD_UNITS = {
    "price": "currency",
    "market_cap": "currency",
    "shares_outstanding": "shares",
    "revenue": "currency",
    "prior_revenue": "currency",
    "net_income": "currency",
    "operating_cash_flow": "currency",
    "capital_expenditures": "currency",
    "total_assets": "currency",
    "total_liabilities": "currency",
    "current_assets": "currency",
    "current_liabilities": "currency",
    "fcf": "currency",
    "fcf_margin": "ratio",
    "pe_ratio": "ratio",
    "price_to_sales": "ratio",
    "net_margin": "ratio",
    "roe": "ratio",
    "current_ratio": "ratio",
    "debt_to_assets": "ratio",
    "revenue_growth": "ratio",
}

_PROVIDER_SELECTION_RANK = {
    "asx_report": 0,
    "manual_review": 0,
    "fmp": 10,
    "alpha_vantage": 20,
    "eodhd": 30,
    "twelve_data": 40,
    "asx_markitdigital": 45,
    "yahoo-finance": 50,
    "yahoo_finance": 50,
    "derived": 5,
}

_SOURCE_FAMILY_RANK = {
    "reported_filing": 0,
    "manual_review": 0,
    "provider_statement": 10,
    "fmp": 10,
    "alpha_vantage": 10,
    "quote_market_data": 15,
    "asx_markitdigital": 25,
    "unofficial_statement": 30,
    "yahoo-finance": 30,
    "derived": 5,
    "missing_marker": 99,
}


def _default_unit_for_field(field_name: str) -> str:
    return _FIELD_UNITS.get(field_name, "unknown")


def _default_scale_for_unit(unit: str) -> str:
    if unit in {"currency", "shares", "count"}:
        return "ones"
    if unit in {"ratio", "percent"}:
        return "ratio"
    return "unknown"


def _field_value_status(fv: Optional[FieldValue]) -> str:
    if fv is None:
        return "missing"
    prov = fv.provenance or {}
    if prov.get("value_status"):
        return str(prov["value_status"])
    if fv.value is None:
        return "missing"
    return "present"


def serialize_field_value(field_name: str, fv: Optional[FieldValue], reason_not_selected: Optional[str] = None) -> dict:
    """Serialize FieldValue into the multi-source provenance contract.

    Keeps FieldValue.value as the scorer-facing primitive, while projecting the
    richer shape required by storage/dashboard callers. No raw provider payloads
    or secret-bearing URLs are emitted.
    """
    prov = dict((fv.provenance if fv else {}) or {})
    value = fv.value if fv else None
    unit = prov.get("unit") or _default_unit_for_field(field_name)
    raw_url = prov.get("source_url")
    safe_url = redact_url_secrets(raw_url) if raw_url else None
    status = _field_value_status(fv)
    if status == "present" and value is None:
        status = "missing"
    serialized = {
        "field_name": field_name,
        "value": value,
        "value_status": status,
        "unit": unit,
        "currency": prov.get("currency") if unit == "currency" else prov.get("currency"),
        "scale": prov.get("scale") or _default_scale_for_unit(unit),
        "period_type": prov.get("period_type") or ("latest_market" if field_name in {"price", "market_cap"} else "annual"),
        "period_start": prov.get("period_start"),
        "period_end": prov.get("period_end") or prov.get("data_as_of"),
        "fiscal_year": prov.get("fiscal_year"),
        "data_as_of": prov.get("data_as_of") or prov.get("period_end"),
        "filed_at": prov.get("filed_at"),
        "retrieved_at": prov.get("retrieved_at") or prov.get("retrieved_from_source_at") or _now_iso(),
        "source_reported_at": prov.get("source_reported_at"),
        "source_family": prov.get("source_family") or ("missing_marker" if value is None else "unknown"),
        "provider": prov.get("provider") or prov.get("source_family") or "unknown",
        "source_url": safe_url,
        "source_url_sanitized": bool(not raw_url or raw_url == safe_url or safe_url is not None),
        "confidence": prov.get("confidence") or ("unknown" if value is None else "medium"),
        "trust_level": prov.get("trust_level") or ("missing_or_unavailable" if value is None else "unknown"),
        "stale": bool(prov.get("stale", False)),
        "method": prov.get("method") or ("missing_marker" if value is None else "reported"),
        "caveats": list(prov.get("caveats") or ([] if value is not None else ["Value unavailable from configured providers."])),
        "missing_reason": prov.get("missing_reason") if value is None or status != "present" else None,
    }
    if reason_not_selected:
        serialized["reason_not_selected"] = reason_not_selected
    return serialized


def sanitized_field_value(field_name: str, fv: FieldValue) -> FieldValue:
    """Return a FieldValue with provenance normalized enough to persist safely."""
    prov = dict((fv.provenance or {}))
    if prov.get("source_url"):
        prov["source_url"] = redact_url_secrets(str(prov["source_url"]))
        prov["source_url_sanitized"] = True
    prov.setdefault("field_name", field_name)
    prov.setdefault("unit", _default_unit_for_field(field_name))
    prov.setdefault("scale", _default_scale_for_unit(str(prov.get("unit") or "unknown")))
    prov.setdefault("value_status", "present" if fv.value is not None else "missing")
    prov.setdefault("retrieved_at", _now_iso())
    prov.setdefault("caveats", [])
    if fv.value is None:
        prov.setdefault("missing_reason", "unavailable")
    return FieldValue(fv.value, prov)


def _candidate_priority(candidate: dict) -> tuple[int, int, str]:
    provider = str(candidate.get("provider") or "unknown")
    family = str(candidate.get("source_family") or "unknown")
    return (
        _SOURCE_FAMILY_RANK.get(family, 50),
        _PROVIDER_SELECTION_RANK.get(provider, 50),
        provider,
    )


def _dateish(candidate: dict) -> str:
    return str(candidate.get("filed_at") or candidate.get("source_reported_at") or candidate.get("period_end") or candidate.get("data_as_of") or "")


def _numeric_threshold(field_name: str) -> float:
    if field_name in {"fcf_margin", "net_margin", "roe", "revenue_growth"}:
        return 0.03
    if field_name in {"pe_ratio", "price_to_sales", "current_ratio", "debt_to_assets"}:
        return 0.05
    if field_name == "market_cap":
        return 0.05
    if field_name == "price":
        return 0.02
    if field_name == "shares_outstanding":
        return 0.01
    return 0.02


def _near_equal_threshold(field_name: str) -> float:
    if field_name in {"fcf_margin", "net_margin", "roe", "revenue_growth"}:
        return 0.01
    if field_name in {"pe_ratio", "price_to_sales", "current_ratio", "debt_to_assets"}:
        return 0.01
    if field_name == "market_cap":
        return 0.02
    if field_name == "price":
        return 0.005
    if field_name == "shares_outstanding":
        return 0.005
    return 0.005


def _relative_delta(a: Any, b: Any) -> Optional[float]:
    av = _coerce_float(a)
    bv = _coerce_float(b)
    if av is None or bv is None:
        return None
    denom = max(abs(av), abs(bv), 1.0)
    return abs(av - bv) / denom


def _conflict(kind: str, field_name: str, providers: list[str], message: str, severity: str = "blocking", threshold: Optional[str] = None, observed_delta: Any = None, selected_provider: Optional[str] = None) -> dict:
    return {
        "kind": kind,
        "severity": severity,
        "field_name": field_name,
        "providers": providers,
        "message": message,
        "threshold": threshold,
        "observed_delta": observed_delta,
        "selected_provider": selected_provider,
        "requires_review": severity == "blocking",
    }


def _shape_conflicts(field_name: str, present: list[dict]) -> list[dict]:
    conflicts: list[dict] = []
    if len(present) < 2:
        return conflicts
    providers = [str(c.get("provider") or "unknown") for c in present]
    currencies = {c.get("currency") for c in present if c.get("unit") == "currency" and c.get("currency")}
    if len(currencies) > 1:
        conflicts.append(_conflict("currency_mismatch", field_name, providers, "Candidate currencies differ and no FX normalization is approved.", threshold="currency_exact_match_required"))
    unit_scales = {(c.get("unit"), c.get("scale")) for c in present}
    if len(unit_scales) > 1:
        conflicts.append(_conflict("unit_or_scale_mismatch", field_name, providers, "Candidate units/scales are incompatible after canonicalization.", threshold="unit_scale_exact_match_required"))
    period_types = {c.get("period_type") for c in present if c.get("period_type")}
    if len(period_types) > 1:
        conflicts.append(_conflict("period_type_mismatch", field_name, providers, "Candidate period types are not comparable for this field.", threshold="period_type_exact_match_required"))
    period_ends = {c.get("period_end") for c in present if c.get("period_end")}
    if len(period_ends) > 1 and not conflicts:
        conflicts.append(_conflict("period_end_mismatch", field_name, providers, "Candidate period end dates differ beyond the safe merge assumption.", threshold="same_period_required"))
    return conflicts


def consolidate_field(field_name: str, candidates: list[tuple[str, FieldValue]]) -> dict:
    """Select one safe field value and retain alternates/conflicts.

    This is deliberately conservative: hard shape conflicts block scoring,
    material numeric disagreement is surfaced as a warning, and missing/error
    markers remain visible rather than being silently imputed. No averaging.
    """
    serialized: list[dict] = []
    for provider_name, fv in candidates:
        item = serialize_field_value(field_name, fv)
        item["provider"] = item.get("provider") or provider_name
        serialized.append(item)

    missing = [c for c in serialized if c.get("value") is None or c.get("value_status") != "present"]
    present = [c for c in serialized if c.get("value") is not None and c.get("value_status") == "present"]
    conflicts = _shape_conflicts(field_name, present)
    blocking = [c for c in conflicts if c["severity"] == "blocking"]
    if blocking:
        return {
            "field_name": field_name,
            "selected": None,
            "selection_reason": "blocking_conflict",
            "alternates": present + missing,
            "conflicts": conflicts,
            "caveats": [f"{field_name} unavailable because candidate sources are incompatible."],
            "score_effect": {"usable_for_scoring": False, "penalty_points": 1.5, "score_cap": "quality<=60"},
        }

    if not present:
        return {
            "field_name": field_name,
            "selected": None,
            "selection_reason": "no_value",
            "alternates": missing,
            "conflicts": [],
            "caveats": [f"{field_name} unavailable from configured sources."],
            "score_effect": {"usable_for_scoring": False, "penalty_points": 1.0, "score_cap": None},
        }

    # Same-provider/same-period restatement: newer filed/source date wins.
    provider_periods = {(c.get("provider"), c.get("period_type"), c.get("period_end")) for c in present}
    same_provider_period = len(provider_periods) == 1 and len(present) > 1
    if same_provider_period:
        selected = max(present, key=_dateish)
        alternates = [dict(c, reason_not_selected="superseded_by_newer_filing") for c in present if c is not selected] + missing
        return {
            "field_name": field_name,
            "selected": selected,
            "selection_reason": "newer_restatement",
            "alternates": alternates,
            "conflicts": [],
            "caveats": list(selected.get("caveats") or []),
            "score_effect": {"usable_for_scoring": True, "penalty_points": 0, "score_cap": None},
        }

    selected = sorted(present, key=_candidate_priority)[0]
    numeric_warning = False
    near_equal = len(present) > 1
    for other in present:
        if other is selected:
            continue
        delta = _relative_delta(selected.get("value"), other.get("value"))
        if delta is None:
            continue
        if delta > _numeric_threshold(field_name):
            numeric_warning = True
            near_equal = False
            conflicts.append(_conflict(
                "numeric_delta_exceeds_threshold",
                field_name,
                [str(selected.get("provider")), str(other.get("provider"))],
                "Candidate numeric values differ materially; selected value follows source priority.",
                severity="warning",
                threshold=f">{_numeric_threshold(field_name):.1%}",
                observed_delta=round(delta, 6),
                selected_provider=str(selected.get("provider")),
            ))
        elif delta > _near_equal_threshold(field_name):
            near_equal = False

    alternates = [dict(c, reason_not_selected="lower_priority_source") for c in present if c is not selected] + missing
    if missing and not [c for c in present if c is not selected]:
        reason = "filled_missing"
    elif near_equal and len(present) > 1:
        reason = "near_equal_sources"
    elif numeric_warning:
        reason = "highest_priority_same_period"
    else:
        reason = "highest_priority_same_period"
    return {
        "field_name": field_name,
        "selected": selected,
        "selection_reason": reason,
        "alternates": alternates,
        "conflicts": conflicts,
        "caveats": list(dict.fromkeys(list(selected.get("caveats") or []) + (["Provider alternates differ materially; verify before acting."] if numeric_warning else []))),
        "score_effect": {"usable_for_scoring": True, "penalty_points": 0, "score_cap": None},
    }


def _compatible_selected(a: Optional[dict], b: Optional[dict]) -> tuple[bool, Optional[dict]]:
    if not a or not b:
        return False, None
    providers = [str(a.get("provider") or "unknown"), str(b.get("provider") or "unknown")]
    if a.get("currency") != b.get("currency"):
        return False, _conflict("currency_mismatch", "fcf", providers, "OCF and capex currencies differ; FCF cannot be derived.")
    if a.get("unit") != b.get("unit") or a.get("scale") != b.get("scale"):
        return False, _conflict("unit_or_scale_mismatch", "fcf", providers, "OCF and capex units/scales differ; FCF cannot be derived.")
    if a.get("period_type") != b.get("period_type"):
        return False, _conflict("period_type_mismatch", "fcf", providers, "OCF and capex periods differ; FCF cannot be derived.")
    if a.get("period_end") != b.get("period_end"):
        return False, _conflict("period_end_mismatch", "fcf", providers, "OCF and capex period ends differ; FCF cannot be derived.")
    return True, None


def consolidate_company_fields(company: dict, provider_fields: Optional[list[tuple[str, dict[str, FieldValue]]]] = None) -> dict:
    """Consolidate raw FieldValues plus derived FCF/FCF margin for one company."""
    provider_fields = provider_fields or []
    consolidated: dict[str, dict] = {}
    for field_name in RAW_FIELDS:
        candidates: list[tuple[str, FieldValue]] = []
        current = company.get(field_name)
        if current is not None:
            candidates.append((str((current.provenance or {}).get("provider") or (current.provenance or {}).get("source_family") or "current"), current))
        for provider_name, fields in provider_fields:
            if field_name in fields:
                candidates.append((provider_name, fields[field_name]))
        if candidates:
            consolidated[field_name] = consolidate_field(field_name, candidates)

    ocf = (consolidated.get("operating_cash_flow") or {}).get("selected")
    capex = (consolidated.get("capital_expenditures") or {}).get("selected")
    compat, conflict = _compatible_selected(ocf, capex)
    if compat:
        fcf_value = (ocf.get("value") or 0) + (capex.get("value") or 0)
        fcf = serialize_field_value("fcf", FieldValue(fcf_value, {
            "field_name": "fcf",
            "provider": "derived",
            "source_family": "derived",
            "unit": "currency",
            "currency": ocf.get("currency"),
            "scale": ocf.get("scale"),
            "period_type": ocf.get("period_type"),
            "period_end": ocf.get("period_end"),
            "data_as_of": ocf.get("data_as_of"),
            "retrieved_at": _now_iso(),
            "confidence": "medium",
            "trust_level": "derived_from_selected_inputs",
            "method": "derived",
            "caveats": ["Free cash flow derived from selected operating cash flow and capex inputs."],
        }))
        consolidated["fcf"] = {"field_name": "fcf", "selected": fcf, "selection_reason": "derived_from_selected_inputs", "alternates": [], "conflicts": [], "caveats": fcf["caveats"], "score_effect": {"usable_for_scoring": True, "penalty_points": 0, "score_cap": None}}
    else:
        consolidated["fcf"] = {"field_name": "fcf", "selected": None, "selection_reason": "blocking_conflict" if conflict else "no_value", "alternates": [c for c in (ocf, capex) if c], "conflicts": [conflict] if conflict else [], "caveats": ["Free cash flow unavailable because selected OCF/capex inputs are not compatible."], "score_effect": {"usable_for_scoring": False, "penalty_points": 1.5, "score_cap": "quality<=60"}}

    fallback_provider_names = set(PROVIDER_ENV_VARS) | {"eodhd", "twelve_data"}
    filled = [name for name, result in consolidated.items() if (result.get("selected") or {}).get("provider") in fallback_provider_names and name in RAW_FIELDS]
    conflicted = [name for name, result in consolidated.items() if result.get("conflicts")]
    missing = [name for name, result in consolidated.items() if result.get("selected") is None]
    source_mix = sorted({
        (result.get("selected") or {}).get("provider")
        for result in consolidated.values()
        if result.get("selected") and (result.get("selected") or {}).get("provider") not in {None, "unknown", "current"}
    })
    return {
        "ticker": company.get("ticker"),
        "fields": consolidated,
        "field_quality": {
            "filled_fields": sorted(filled),
            "conflicted_fields": sorted(conflicted),
            "stale_fields": [name for name, result in consolidated.items() if (result.get("selected") or {}).get("stale")],
            "missing_fields": sorted(missing),
            "conflict_count": sum(len(result.get("conflicts") or []) for result in consolidated.values()),
        },
        "source_summary": _source_summary(source_mix, filled, conflicted),
        "provider_priority_version": FIELD_CONSOLIDATION_VERSION,
        "threshold_version": FIELD_THRESHOLD_VERSION,
    }


def _source_summary(source_mix: list[str], filled_fields: list[str], conflicted_fields: list[str]) -> str:
    sources = "+".join(s for s in source_mix if s) or "no selected sources"
    pieces = [sources]
    if filled_fields:
        pieces.append(f"{len(filled_fields)} fallback-filled field(s)")
    if conflicted_fields:
        pieces.append(f"{len(conflicted_fields)} conflicted field(s)")
    return "; ".join(pieces)

def _provenance_scalar(value: Any) -> Any:
    if isinstance(value, (list, tuple, set)):
        values = sorted(str(item) for item in value if item)
        return values[-1] if values else None
    return value


def _safe_timestamp(value: Optional[str] = None) -> str:
    if value:
        parsed = _parse_provenance_time(value)
        if parsed:
            return parsed.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        return str(value)
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _row_observable_fields(row: dict) -> dict:
    return {**_row_raw_fields(row), **_row_derived_fields(row)}


def _row_field_observations(row: dict) -> list[dict]:
    observations: list[dict] = []
    for field_name, field_data in _row_observable_fields(row).items():
        prov = field_data.get("provenance") or {}
        observations.append({
            "ticker": row.get("ticker"),
            "field_name": field_name,
            "value": field_data.get("value"),
            "source_family": prov.get("source_family") or prov.get("provider") or ("derived" if field_name not in RAW_FIELDS else "unknown"),
            "retrieved_at": _parse_iso_timestamp(_provenance_scalar(prov.get("retrieved_at") or prov.get("retrieved_from_source_at"))),
            "data_as_of": _parse_iso_date(_provenance_scalar(prov.get("data_as_of"))),
        })
    return observations


def _row_file_first_provenance(row: dict) -> list[dict]:
    provenance: list[dict] = []
    for field_name, field_data in _row_observable_fields(row).items():
        prov = field_data.get("provenance") or {}
        if not prov:
            continue
        provenance.append({
            "ticker": row.get("ticker"),
            "field_name": field_name,
            "source_family": prov.get("source_family") or prov.get("provider") or ("derived" if field_name not in RAW_FIELDS else "unknown"),
            "provider": prov.get("provider") or prov.get("source_family") or ("derived" if field_name not in RAW_FIELDS else "unknown"),
            "retrieved_at": _parse_iso_timestamp(_provenance_scalar(prov.get("retrieved_at") or prov.get("retrieved_from_source_at"))),
            "data_as_of": _parse_iso_date(_provenance_scalar(prov.get("data_as_of"))),
        })
    return provenance


def _ranked_data_as_of_latest(rows: list[dict]) -> Optional[str]:
    values: list[str] = []
    for row in rows:
        summary = row.get("provenance_summary") or {}
        if isinstance(summary, dict):
            values.extend(str(v) for v in summary.get("data_as_of") or [] if v)
    return sorted(set(values))[-1] if values else None


def _normalise_accounting_ticker(raw_ticker: Any, mode: str) -> str:
    """Normalize a run-accounting ticker without leaking local path/provider state."""
    ticker_text = str(raw_ticker or "").strip()
    if not ticker_text:
        return "UNKNOWN"
    upper = ticker_text.upper()
    if upper.endswith(".AX") or upper.endswith(".AU"):
        return normalise_asx_ticker(ticker_text)
    if mode in {US_EODHD_MODE, NASDAQ_MODE} or ".US" in upper:
        return normalise_us_ticker(ticker_text)
    return normalise_asx_ticker(ticker_text)


def _append_unique_accounting_failure(
    failures: list[dict],
    accounted_failures: set[str],
    ticker: str,
    reason: str,
    provider: str,
    source_family: str,
    failed_at: Optional[str] = None,
    recoverable: bool = True,
) -> None:
    """Append one durable failure record per ticker for denominator accounting."""
    if ticker in accounted_failures:
        return
    accounted_failures.add(ticker)
    failures.append({
        "ticker": ticker,
        "reason": _redact_secrets_in_text(str(reason or "provider hydration failed")),
        "recoverable": recoverable,
        "provider": provider or "unknown",
        "source_family": source_family or provider or "unknown",
        "failed_at": failed_at,
    })


def build_file_first_run_payload(
    ranked: list[dict],
    source: str,
    mode: str,
    universe: list[str],
    universe_source: str = "configured ASX bootstrap watchlist",
    universe_version: Optional[str] = None,
    universe_metadata: Optional[dict] = None,
    batch_metadata: Optional[dict] = None,
    hydration_failures: Optional[list[dict]] = None,
    started_at: Optional[str] = None,
    completed_at: Optional[str] = None,
) -> dict:
    """Build the canonical JSON payload consumed by the NAS/DuckDB artifact publisher."""
    completed = _safe_timestamp(completed_at)
    started = _safe_timestamp(started_at or completed)
    companies: list[dict] = []
    observations: list[dict] = []
    provenance: list[dict] = []
    scores: list[dict] = []
    failures: list[dict] = []
    exclusions: list[dict] = []
    accounted_failures: set[str] = set()
    accounted_exclusions: set[str] = set()
    accounted_companies: set[str] = set()
    for failure in hydration_failures or []:
        ticker = _normalise_accounting_ticker(failure.get("ticker"), mode)
        _append_unique_accounting_failure(
            failures,
            accounted_failures,
            ticker,
            str(failure.get("reason") or "provider hydration failed"),
            failure.get("provider") or failure.get("source_family") or "unknown",
            failure.get("source_family") or failure.get("provider") or "unknown",
            failed_at=failure.get("failed_at"),
            recoverable=failure.get("recoverable") is not False,
        )

    for index, row in enumerate(ranked, start=1):
        ticker = row.get("ticker")
        accounting_ticker = _normalise_accounting_ticker(ticker, mode)
        accounted_companies.add(accounting_ticker)
        companies.append({
            "ticker": ticker,
            "company_id": row.get("company_id"),
            "asx_code": row.get("asx_code") or (str(ticker).replace(".AX", "") if ticker else None),
            "name": row.get("name") or ticker,
            "name_raw": row.get("name_raw"),
            "name_normalized": row.get("name_normalized"),
            "market": row.get("market") or "ASX",
            "exchange": row.get("exchange") or "ASX",
            "region": row.get("region") or "AU",
            "sector": row.get("sector"),
            "industry": row.get("industry"),
            "currency": row.get("currency") or "AUD",
            "security_type": row.get("security_type"),
            "active": row.get("active"),
            "suspended": row.get("suspended"),
            "delisted": row.get("delisted"),
        })
        depth = row.get("_eodhd_depth")
        if isinstance(depth, dict):
            companies[-1]["annual_depth"] = {
                "income": depth.get("income"),
                "balance_sheet": depth.get("balance_sheet"),
                "cash_flow": depth.get("cash_flow"),
            }
        excluded = bool(row.get("excluded"))
        is_partial = row.get("hydration_tier") == "partial"
        exclusion_reason = "; ".join(str(reason) for reason in row.get("exclusion_reasons") or row.get("caveats") or [] if reason) or None
        score_entry = {
            "rank": row.get("rank") or index,
            "ticker": ticker,
            "name": row.get("name") or ticker,
            "market": row.get("market") or "ASX",
            "currency": row.get("currency") or "AUD",
            "sector": row.get("sector"),
            "industry": row.get("industry"),
            "composite_score": row.get("composite_score"),
            "sub_scores": dict(row.get("sub_scores") or {}),
            "excluded": excluded,
            "exclusion_reason": exclusion_reason,
        }
        if is_partial:
            score_entry["hydration_tier"] = "partial"
            score_entry["hydration_completeness"] = {
                "present": (row.get("hydration_completeness") or {}).get("present"),
                "denominator": (row.get("hydration_completeness") or {}).get("denominator"),
            }
            score_entry["missing_raw_fields"] = list(row.get("missing_raw_fields") or [])
            score_entry["suppressed_sub_scores"] = list(row.get("suppressed_sub_scores") or [])
        scores.append(score_entry)
        observations.extend(_row_field_observations(row))
        provenance.extend(_row_file_first_provenance(row))
        if excluded:
            item = {"ticker": ticker, "reason": exclusion_reason or "excluded from ranking", "recoverable": True}
            if accounting_ticker not in accounted_exclusions:
                accounted_exclusions.add(accounting_ticker)
                exclusions.append({"ticker": accounting_ticker, "reason": item["reason"]})

    universe_accounting = {
        _normalise_accounting_ticker(ticker, mode)
        for ticker in universe
        if str(ticker or "").strip()
    }
    for ticker in sorted(universe_accounting - accounted_companies - accounted_failures - accounted_exclusions):
        _append_unique_accounting_failure(
            failures,
            accounted_failures,
            ticker,
            "seed symbol produced no company, failure, or exclusion record",
            "no-provider",
            "reconcile-unmatched",
            failed_at=completed,
            recoverable=True,
        )

    fully_scored = [row for row in scores if not row["excluded"] and row.get("hydration_tier") != "partial" and row["composite_score"] is not None]
    partially_hydrated = [row for row in scores if not row["excluded"] and row.get("hydration_tier") == "partial" and row["composite_score"] is not None]
    usable = len(fully_scored)
    scored = len(fully_scored) + len(partially_hydrated)
    batch_metadata = dict(batch_metadata or {})
    universe_metadata = dict(universe_metadata or {})
    denominator = batch_metadata["eligible_count"] if "eligible_count" in batch_metadata else (len(universe) if universe else len(companies))
    denominator_status = batch_metadata.get("denominator_status")
    if not denominator_status:
        if mode == "fixture":
            denominator_status = "sample"
        elif batch_metadata.get("complete_exchange_listing"):
            denominator_status = "complete_exchange_listing"
        elif batch_metadata:
            denominator_status = "ranked_market_cap_batch"
        else:
            denominator_status = "known_sample_universe"
    if batch_metadata.get("denominator_label"):
        denominator_label = str(batch_metadata["denominator_label"])
    elif denominator_status == "ranked_market_cap_batch":
        top_n = batch_metadata.get("selected_count") or denominator
        denominator_label = f"top {top_n} ASX listings by Market Cap from ASX company directory seed"
    elif denominator_status == "complete_security_type_filtered_listing":
        filter_label = ", ".join(batch_metadata.get("security_type_filter") or batch_metadata.get("exclude_security_types") or [])
        denominator_label = f"ASX company directory seed filtered by security type: {filter_label or 'unspecified'}"
    elif denominator_status == "complete_exchange_listing":
        denominator_label = "complete ASX company directory seed"
    else:
        denominator_label = universe_source
    complete_listing = bool(batch_metadata.get("complete_exchange_listing", False))
    market = _market_for_mode(mode)
    source_caveats = [
        "Yahoo Finance public endpoints are unofficial; verify against ASX announcements/company reports before acting."
    ] if source == "yahoo-finance" or mode == "asx-yahoo-timeseries" else []
    if market in ("US", "NASDAQ"):
        label = "NASDAQ" if market == "NASDAQ" else "US"
        source_caveats.append(
            f"{label} fundamentals from EODHD (licensed); live price from Yahoo chart. "
            "USD values are NOT comparable to ASX AUD values without FX normalization."
        )
    accounted_symbols = set(accounted_companies) | set(accounted_failures) | set(accounted_exclusions)
    accounted = len(accounted_symbols)
    unaccounted = max(denominator - accounted, 0) if denominator is not None else 0
    return {
        "market": market,
        "source": source,
        "mode": mode,
        "fixture": mode == "fixture",
        "started_at": started,
        "completed_at": completed,
        "generated_at": completed,
        "data_as_of": _ranked_data_as_of_latest(ranked),
        "universe": {
            "source": universe_source,
            "version": universe_version,
            "market": market,
            "count": denominator,
            "complete_exchange_listing": complete_listing,
            "full_count": batch_metadata.get("full_count"),
            "selected_count": batch_metadata.get("selected_count", denominator),
            "batch_offset": batch_metadata.get("batch_offset"),
            "batch_end_exclusive": batch_metadata.get("batch_end_exclusive"),
            "source_row_count": universe_metadata.get("source_row_count") or universe_metadata.get("row_count"),
            "normalized_active_count": universe_metadata.get("normalized_active_count"),
            "source_sha256": universe_metadata.get("source_sha256") or universe_metadata.get("sha256"),
            "source_retrieved_at": universe_metadata.get("retrieved_at"),
            "eligible_count": batch_metadata.get("eligible_count"),
            "security_type_filter": batch_metadata.get("security_type_filter"),
            "exclude_security_types": batch_metadata.get("exclude_security_types"),
            "excluded_security_type_count": batch_metadata.get("excluded_security_type_count"),
            "denominator_label": denominator_label,
            "denominator_status": denominator_status,
        },
        "companies": companies,
        "observations": observations,
        "scores": scores,
        "provenance": provenance,
        "failures": failures,
        "exclusions": exclusions,
        "coverage": {
            "denominator": denominator,
            "denominator_label": denominator_label,
            "denominator_status": denominator_status,
            "scraped": len(companies),
            "scored": scored,
            "usable": usable,
            "partially_hydrated": len(partially_hydrated),
            "excluded": len(exclusions),
            "failed": len(failures),
            "accounted": accounted,
            "unaccounted": unaccounted,
            "stale": 0,
            "missing_required_fields": len(exclusions),
            "percent": round((usable / denominator) * 100, 1) if denominator else None,
        },
        "source_caveats": source_caveats,
        "provider_priority_version": FIELD_CONSOLIDATION_VERSION,
        "threshold_version": FIELD_THRESHOLD_VERSION,
        "source_mix": sorted({row.get("provider") or row.get("source_family") for row in provenance if row.get("provider") or row.get("source_family")}),
        "provider_failures": [
            {
                "provider": failure.get("provider"),
                "source_family": failure.get("source_family"),
                "ticker": failure.get("ticker"),
                "reason": str(failure.get("reason") or "provider failure")[:160],
                "recoverable": failure.get("recoverable") is not False,
            }
            for failure in failures
            if failure.get("provider") not in (None, "yahoo-finance")
        ],
        "field_quality": {
            "filled_fields": sorted({field for row in ranked for field in ((row.get("field_quality") or {}).get("filled_fields") or [])}),
            "conflicted_fields": sorted({field for row in ranked for field in ((row.get("field_quality") or {}).get("conflicted_fields") or [])}),
            "missing_fields": sorted({field for row in ranked for field in ((row.get("field_quality") or {}).get("missing_fields") or [])}),
            "conflict_count": sum(int((row.get("field_quality") or {}).get("conflict_count") or 0) for row in ranked),
        },
    }


# ---------------------------------------------------------------------------
# Postgres storage
# ---------------------------------------------------------------------------

POSTGRES_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS investment_screener_runs (
  id BIGSERIAL PRIMARY KEY,
  run_key TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'completed',
  market TEXT NOT NULL DEFAULT 'ASX',
  mode TEXT NOT NULL,
  universe_version TEXT,
  source_mix JSONB NOT NULL DEFAULT '{}'::jsonb,
  code_version TEXT,
  config_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  universe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_failures JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_iss_runs_run_key
  ON investment_screener_runs(run_key);

CREATE TABLE IF NOT EXISTS investment_screener_companies (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL UNIQUE,
  asx_code TEXT,
  name TEXT,
  market TEXT,
  exchange TEXT,
  region TEXT,
  sector TEXT,
  industry TEXT,
  currency TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  identity_provenance JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS investment_screener_observations (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES investment_screener_runs(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES investment_screener_companies(id),
  ticker TEXT NOT NULL,
  period_end DATE,
  data_as_of DATE,
  currency TEXT,
  source_quality TEXT,
  raw_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  derived_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  alternates JSONB NOT NULL DEFAULT '{}'::jsonb,
  conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
  field_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_confidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, company_id)
);

CREATE TABLE IF NOT EXISTS investment_screener_scores (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES investment_screener_runs(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES investment_screener_companies(id),
  ticker TEXT NOT NULL,
  rank INTEGER,
  excluded BOOLEAN NOT NULL DEFAULT false,
  composite_score NUMERIC,
  sub_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  missing_penalty_points NUMERIC,
  risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  caveats JSONB NOT NULL DEFAULT '[]'::jsonb,
  score_caps JSONB NOT NULL DEFAULT '{}'::jsonb,
  exclusion_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  score_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, company_id)
);

CREATE TABLE IF NOT EXISTS investment_screener_provenance (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES investment_screener_runs(id) ON DELETE CASCADE,
  company_id BIGINT REFERENCES investment_screener_companies(id),
  field_name TEXT,
  source_family TEXT,
  source_url TEXT,
  retrieved_at TIMESTAMPTZ,
  source_reported_at DATE,
  data_as_of DATE,
  trust_level TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'not_attempted',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_iss_provenance_dedupe
  ON investment_screener_provenance(run_id, company_id, field_name, source_family, source_url, data_as_of);

CREATE TABLE IF NOT EXISTS investment_screener_price_snapshots (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES investment_screener_companies(id),
  ticker TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  trading_date DATE,
  price NUMERIC,
  currency TEXT,
  source_family TEXT,
  source_quality TEXT,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id, observed_at, source_family)
);

ALTER TABLE investment_screener_runs
  ADD COLUMN IF NOT EXISTS run_key TEXT,
  ADD COLUMN IF NOT EXISTS universe_version TEXT,
  ADD COLUMN IF NOT EXISTS source_mix JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS code_version TEXT,
  ADD COLUMN IF NOT EXISTS config_hash TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS universe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS provider_failures JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE investment_screener_companies
  ADD COLUMN IF NOT EXISTS asx_code TEXT,
  ADD COLUMN IF NOT EXISTS sector TEXT,
  ADD COLUMN IF NOT EXISTS industry TEXT,
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS identity_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE investment_screener_observations
  ADD COLUMN IF NOT EXISTS period_end DATE,
  ADD COLUMN IF NOT EXISTS currency TEXT,
  ADD COLUMN IF NOT EXISTS source_quality TEXT,
  ADD COLUMN IF NOT EXISTS derived_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS selected_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS alternates JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS field_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_confidence JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE investment_screener_scores
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES investment_screener_companies(id),
  ADD COLUMN IF NOT EXISTS score_version TEXT;

CREATE INDEX IF NOT EXISTS idx_iss_scores_ticker_created ON investment_screener_scores(ticker, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_iss_obs_ticker_asof ON investment_screener_observations(ticker, data_as_of DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_iss_obs_run_company ON investment_screener_observations(run_id, company_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_iss_scores_run_company ON investment_screener_scores(run_id, company_id);
CREATE INDEX IF NOT EXISTS idx_iss_price_ticker_observed ON investment_screener_price_snapshots(ticker, observed_at DESC);
"""


def _json_param(value: Any) -> str:
    return json.dumps(value, default=str, sort_keys=True)


def _stable_run_key(source: str, mode: str, universe: list[str], metadata: Optional[dict]) -> str:
    payload = {
        "source": source,
        "mode": mode,
        "universe": sorted(str(item) for item in universe),
        "metadata": metadata or {},
    }
    market = _market_for_mode(mode)
    digest = __import__("hashlib").sha256(_json_param(payload).encode()).hexdigest()[:16]
    return f"investment-screener:{market}:{mode}:{digest}"


def _row_data_as_of(row: dict) -> Optional[str]:
    summary = row.get("provenance_summary") or {}
    return _first_sorted_value(summary.get("data_as_of") or []) if isinstance(summary, dict) else None


def _row_period_end(row: dict) -> Optional[str]:
    return _row_data_as_of(row)


def _field_entry_from_row(row: dict, key: str) -> dict:
    fields = row.get("fields") or {}
    value = fields.get(key) if isinstance(fields, dict) else None
    if isinstance(value, dict):
        return {
            "value": value.get("value"),
            "status": value.get("status") or ("present" if value.get("value") is not None else "missing"),
            "provenance": value.get("provenance") or {},
        }
    return {"value": None, "status": "missing", "provenance": {}}


def _row_raw_fields(row: dict) -> dict:
    return {key: _field_entry_from_row(row, key) for key in RAW_FIELDS}


def _row_derived_fields(row: dict) -> dict:
    fields = row.get("fields") or {}
    if not isinstance(fields, dict):
        return {}
    return {
        key: _field_entry_from_row(row, key)
        for key in fields
        if key not in RAW_FIELDS
    }


def _row_source_quality(row: dict) -> str:
    for field_data in _row_raw_fields(row).values():
        prov = field_data.get("provenance") or {}
        for key in ("source_quality", "trust_level", "freshness"):
            if prov.get(key):
                return str(prov[key])[:120]
    return "unknown"


def _parse_iso_date(value: Any) -> Optional[str]:
    if not value:
        return None
    parsed = _parse_provenance_time(value)
    return parsed.date().isoformat() if parsed else str(value)[:10]


def _parse_iso_timestamp(value: Any) -> Optional[str]:
    if not value:
        return None
    parsed = _parse_provenance_time(value)
    return parsed.isoformat() if parsed else None


def _provenance_rows(row: dict) -> list[tuple]:
    rows: list[tuple] = []
    seen: set[tuple] = set()
    for field_name, field_data in _row_observable_fields(row).items():
        prov = field_data.get("provenance") or {}
        if not prov:
            continue
        source_family = (
            prov.get("source_family")
            or prov.get("provider")
            or prov.get("yahoo_type")
            or ("derived" if field_name not in RAW_FIELDS else _provenance_scalar(prov.get("freshness")))
            or "unknown"
        )
        item = (
            field_name,
            str(source_family)[:80],
            _provenance_scalar(prov.get("source_url")),
            _parse_iso_timestamp(_provenance_scalar(prov.get("retrieved_at") or prov.get("retrieved_from_source_at"))),
            _parse_iso_date(_provenance_scalar(prov.get("source_reported_at"))),
            _parse_iso_date(_provenance_scalar(prov.get("data_as_of"))),
            _provenance_scalar(prov.get("trust_level") or prov.get("source_quality") or prov.get("freshness")),
            _provenance_scalar(prov.get("extraction_status")) or "not_attempted",
            _provenance_scalar(prov.get("notes") or prov.get("freshness")),
        )
        key = (item[0], item[1], item[2], item[5])
        if key not in seen:
            seen.add(key)
            rows.append(item)
    return rows


def init_postgres_schema(conn) -> None:
    """Apply the idempotent schema, or accept an existing schema for non-owner writers.

    The recurring homelab ASX job intentionally uses a least-privilege writer role.
    That role can insert/update screener history but does not own the tables, so the
    compatibility ALTER statements in POSTGRES_SCHEMA_SQL may fail even when the
    reviewed schema is already present. In that case, verify the expected tables are
    present and continue without broadening the credential to a schema owner.
    """
    try:
        conn.cursor().execute(POSTGRES_SCHEMA_SQL)
        conn.commit()
        return
    except Exception:
        conn.rollback()

    expected_tables = {
        "investment_screener_runs",
        "investment_screener_companies",
        "investment_screener_observations",
        "investment_screener_scores",
        "investment_screener_provenance",
        "investment_screener_price_snapshots",
    }
    cur = conn.cursor()
    cur.execute(
        """
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY(%s)
        """,
        (list(expected_tables),),
    )
    existing = {row[0] for row in cur.fetchall()}
    if existing != expected_tables:
        missing = ", ".join(sorted(expected_tables - existing))
        raise RuntimeError(f"Postgres screener schema initialization failed and expected tables are missing: {missing}")
    conn.commit()


def sanitize_provider_failures(failures: Optional[list[dict]]) -> list[dict]:
    """Project per-provider failures into a secret-free storage summary.

    Drops raw provider bodies/headers and redacts secret-bearing query params
    from the reason string so history never persists credentials or payloads.
    """
    cleaned: list[dict] = []
    for failure in failures or []:
        reason = str(failure.get("reason") or "provider failure")
        # Redact a bare source URL embedded in the reason string, then any
        # lingering secret-shaped query params, before truncation.
        reason = _redact_secrets_in_text(reason)
        cleaned.append({
            "provider": failure.get("provider") or failure.get("source_family") or "unknown",
            "source_family": failure.get("source_family") or failure.get("provider") or "unknown",
            "ticker": failure.get("ticker"),
            "reason": reason[:160],
            "recoverable": failure.get("recoverable") is not False,
            "failed_at": failure.get("failed_at"),
        })
    return cleaned


def build_universe_storage_metadata(
    universe: list[str],
    universe_metadata: Optional[dict] = None,
    batch_metadata: Optional[dict] = None,
) -> dict:
    """Flatten universe/denominator batch metadata into a storage-safe dict.

    Captures the denominator, denominator status, security-type filters,
    batch offset/size, and seed source hash so a run's coverage basis is
    auditable without re-inspecting the seed artifact.
    """
    universe_metadata = dict(universe_metadata or {})
    batch_metadata = dict(batch_metadata or {})
    seed_sha256 = (
        universe_metadata.get("source_sha256")
        or universe_metadata.get("sha256")
        or universe_metadata.get("seed_sha256")
    )
    return {
        "universe_count": len(universe) if universe else None,
        "denominator": batch_metadata.get("eligible_count") or batch_metadata.get("selected_count") or (len(universe) if universe else None),
        "denominator_status": batch_metadata.get("denominator_status"),
        "denominator_label": batch_metadata.get("denominator_label"),
        "complete_exchange_listing": bool(batch_metadata.get("complete_exchange_listing", False)),
        "security_type_filter": batch_metadata.get("security_type_filter") or batch_metadata.get("include_security_types"),
        "exclude_security_types": batch_metadata.get("exclude_security_types"),
        "excluded_security_type_count": batch_metadata.get("excluded_security_type_count"),
        "batch_offset": batch_metadata.get("batch_offset"),
        "batch_size": batch_metadata.get("selected_count") or batch_metadata.get("batch_size"),
        "batch_end_exclusive": batch_metadata.get("batch_end_exclusive"),
        "full_count": batch_metadata.get("full_count"),
        "seed_sha256": seed_sha256,
        "seed_source_row_count": universe_metadata.get("source_row_count") or universe_metadata.get("row_count"),
        "seed_retrieved_at": universe_metadata.get("retrieved_at"),
    }


def _multi_source_selected_fields(multi: dict) -> dict:
    selected: dict = {}
    for field_name, result in (multi or {}).items():
        entry = result.get("selected") if isinstance(result, dict) else None
        if not isinstance(entry, dict):
            continue
        projected = dict(entry)
        projected["selection_reason"] = result.get("selection_reason")
        # Defense in depth: never persist a secret-bearing URL even if an
        # upstream producer passed one through unsanitized.
        if projected.get("source_url"):
            projected["source_url"] = redact_url_secrets(str(projected["source_url"]))
            projected["source_url_sanitized"] = True
        selected[field_name] = projected
    return selected


def _multi_source_alternates(multi: dict) -> dict:
    alternates: dict = {}
    for field_name, result in (multi or {}).items():
        if not isinstance(result, dict):
            continue
        values = result.get("alternates") or []
        if values:
            sanitized = []
            for alt in values:
                if isinstance(alt, dict) and alt.get("source_url"):
                    alt = dict(alt)
                    alt["source_url"] = redact_url_secrets(str(alt["source_url"]))
                    alt["source_url_sanitized"] = True
                sanitized.append(alt)
            alternates[field_name] = sanitized
    return alternates


def _multi_source_conflicts(multi: dict) -> list[dict]:
    conflicts: list[dict] = []
    for result in (multi or {}).values():
        if not isinstance(result, dict):
            continue
        for conflict in result.get("conflicts") or []:
            if isinstance(conflict, dict):
                conflicts.append(conflict)
    return conflicts


def _multi_source_confidence(multi: dict) -> dict:
    confidence: dict = {}
    for result in (multi or {}).values():
        if not isinstance(result, dict):
            continue
        selected = result.get("selected")
        if isinstance(selected, dict):
            provider = selected.get("provider")
            level = selected.get("confidence")
            if provider and level:
                confidence[str(provider)] = level
    return confidence


def project_consolidated_fields_sanitized(multi: dict) -> dict:
    """Dashboard-safe projection of consolidated fields.

    Keeps selected value + provider + selection reason + conflict count, and
    drops raw ``source_url``, full alternates arrays, and any provider payload
    fields so the read path never re-exposes evidence internals.
    """
    projected: dict = {}
    for field_name, result in (multi or {}).items():
        if not isinstance(result, dict):
            continue
        selected = result.get("selected")
        if not isinstance(selected, dict):
            projected[field_name] = {
                "value": None,
                "value_status": "missing",
                "provider": None,
                "selection_reason": result.get("selection_reason"),
                "conflict_count": len(result.get("conflicts") or []),
            }
            continue
        projected[field_name] = {
            "value": selected.get("value"),
            "value_status": selected.get("value_status"),
            "provider": selected.get("provider"),
            "source_family": selected.get("source_family"),
            "confidence": selected.get("confidence"),
            "trust_level": selected.get("trust_level"),
            "currency": selected.get("currency"),
            "unit": selected.get("unit"),
            "period_type": selected.get("period_type"),
            "period_end": selected.get("period_end"),
            "data_as_of": selected.get("data_as_of"),
            "stale": selected.get("stale"),
            "selection_reason": result.get("selection_reason"),
            "conflict_count": len(result.get("conflicts") or []),
            "caveats": selected.get("caveats") or [],
        }
    return projected


def insert_screener_run(
    conn,
    ranked: list[dict],
    source: str,
    mode: str,
    universe: list[str],
    metadata: Optional[dict] = None,
    run_key: Optional[str] = None,
    score_version: Optional[str] = None,
    universe_version: Optional[str] = None,
    code_version: Optional[str] = None,
    config_hash: Optional[str] = None,
    universe_metadata: Optional[dict] = None,
    provider_failures: Optional[list[dict]] = None,
) -> int:
    """Insert/upsert a completed screener run and its historical rows. Returns run id.

    The writer is idempotent by ``run_key``. Re-running the same logical run updates
    the same run/company/observation/score rows instead of inserting mystery twins.
    """
    run_key = run_key or _stable_run_key(source, mode, universe, metadata)
    market = _market_for_mode(mode)
    universe_metadata_payload = _json_param(universe_metadata or {})
    provider_failures_payload = _json_param(sanitize_provider_failures(provider_failures))
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO investment_screener_runs(
          run_key, started_at, completed_at, status, market, mode, universe_version,
          source_mix, code_version, config_hash, metadata, universe_metadata, provider_failures
        )
        VALUES (%s, now(), now(), %s, %s, %s, %s, %s::jsonb, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb)
        ON CONFLICT (run_key) DO UPDATE SET
          completed_at = EXCLUDED.completed_at,
          status = EXCLUDED.status,
          market = EXCLUDED.market,
          mode = EXCLUDED.mode,
          universe_version = COALESCE(EXCLUDED.universe_version, investment_screener_runs.universe_version),
          source_mix = EXCLUDED.source_mix,
          code_version = COALESCE(EXCLUDED.code_version, investment_screener_runs.code_version),
          config_hash = COALESCE(EXCLUDED.config_hash, investment_screener_runs.config_hash),
          metadata = EXCLUDED.metadata,
          universe_metadata = EXCLUDED.universe_metadata,
          provider_failures = EXCLUDED.provider_failures
        RETURNING id
        """,
        (
            run_key,
            "completed",
            market,
            mode,
            universe_version,
            _json_param({"source": source, "universe": universe}),
            code_version,
            config_hash,
            _json_param(metadata or {}),
            universe_metadata_payload,
            provider_failures_payload,
        ),
    )
    run_id = cur.fetchone()[0]
    for row in ranked:
        ticker = row.get("ticker")
        ticker_upper = str(ticker).upper() if ticker else ""
        asx_code = row.get("asx_code") or (ticker_upper.replace(".AX", "") if ticker_upper.endswith(".AX") else None)
        cur.execute(
            """
            INSERT INTO investment_screener_companies(
              ticker, asx_code, name, market, exchange, region, sector, industry,
              currency, active, identity_provenance, last_seen_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, now())
            ON CONFLICT (ticker) DO UPDATE SET
              asx_code = COALESCE(EXCLUDED.asx_code, investment_screener_companies.asx_code),
              name = COALESCE(EXCLUDED.name, investment_screener_companies.name),
              market = COALESCE(EXCLUDED.market, investment_screener_companies.market),
              exchange = COALESCE(EXCLUDED.exchange, investment_screener_companies.exchange),
              region = COALESCE(EXCLUDED.region, investment_screener_companies.region),
              sector = COALESCE(EXCLUDED.sector, investment_screener_companies.sector),
              industry = COALESCE(EXCLUDED.industry, investment_screener_companies.industry),
              currency = COALESCE(EXCLUDED.currency, investment_screener_companies.currency),
              active = EXCLUDED.active,
              identity_provenance = EXCLUDED.identity_provenance,
              last_seen_at = now()
            RETURNING id
            """,
            (
                ticker,
                row.get("asx_code") or asx_code,
                row.get("name"),
                row.get("market"),
                row.get("exchange"),
                row.get("region"),
                row.get("sector"),
                row.get("industry"),
                row.get("currency"),
                bool(row.get("active", True)),
                _json_param(row.get("identity_provenance") or {"source_family": "screener_run"}),
            ),
        )
        company_id = cur.fetchone()[0]
        multi = row.get("multi_source_fields") or {}
        cur.execute(
            """
            INSERT INTO investment_screener_observations(
              run_id, company_id, ticker, period_end, data_as_of, currency, source_quality,
              raw_fields, derived_fields, missing_fields, selected_fields, alternates,
              conflicts, field_quality, source_confidence
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb)
            ON CONFLICT (run_id, company_id) DO UPDATE SET
              ticker = EXCLUDED.ticker,
              period_end = EXCLUDED.period_end,
              data_as_of = EXCLUDED.data_as_of,
              currency = EXCLUDED.currency,
              source_quality = EXCLUDED.source_quality,
              raw_fields = EXCLUDED.raw_fields,
              derived_fields = EXCLUDED.derived_fields,
              missing_fields = EXCLUDED.missing_fields,
              selected_fields = EXCLUDED.selected_fields,
              alternates = EXCLUDED.alternates,
              conflicts = EXCLUDED.conflicts,
              field_quality = EXCLUDED.field_quality,
              source_confidence = EXCLUDED.source_confidence
            """,
            (
                run_id,
                company_id,
                ticker,
                _row_period_end(row),
                _row_data_as_of(row),
                row.get("currency"),
                _row_source_quality(row),
                _json_param(_row_raw_fields(row)),
                _json_param(_row_derived_fields(row)),
                _json_param(row.get("missing_fields") or []),
                _json_param(_multi_source_selected_fields(multi)),
                _json_param(_multi_source_alternates(multi)),
                _json_param(_multi_source_conflicts(multi)),
                _json_param(row.get("field_quality") or {}),
                _json_param(_multi_source_confidence(multi)),
            ),
        )
        cur.execute(
            """
            INSERT INTO investment_screener_scores(
              run_id, company_id, ticker, rank, excluded, composite_score, sub_scores,
              missing_penalty_points, risk_flags, caveats, score_caps, exclusion_reasons, score_version
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s)
            ON CONFLICT (run_id, company_id) DO UPDATE SET
              ticker = EXCLUDED.ticker,
              rank = EXCLUDED.rank,
              excluded = EXCLUDED.excluded,
              composite_score = EXCLUDED.composite_score,
              sub_scores = EXCLUDED.sub_scores,
              missing_penalty_points = EXCLUDED.missing_penalty_points,
              risk_flags = EXCLUDED.risk_flags,
              caveats = EXCLUDED.caveats,
              score_caps = EXCLUDED.score_caps,
              exclusion_reasons = EXCLUDED.exclusion_reasons,
              score_version = EXCLUDED.score_version
            """,
            (
                run_id, company_id, ticker, row.get("rank"), bool(row.get("excluded")), row.get("composite_score"),
                _json_param(row.get("sub_scores") or {}), row.get("missing_penalty_points"),
                _json_param(row.get("risk_flags") or []), _json_param(row.get("caveats") or []),
                _json_param(row.get("score_caps") or {}), _json_param(row.get("exclusion_reasons") or []), score_version,
            ),
        )
        for prov in _provenance_rows(row):
            cur.execute(
                """
                INSERT INTO investment_screener_provenance(
                  run_id, company_id, field_name, source_family, source_url, retrieved_at,
                  source_reported_at, data_as_of, trust_level, extraction_status, notes
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT DO NOTHING
                """,
                (run_id, company_id) + prov,
            )
    conn.commit()
    return run_id


def connect_postgres_from_env(env_name: str = "DATABASE_URL"):
    database_url = os.environ.get(env_name)
    if not database_url:
        raise RuntimeError(f"{env_name} is not set; render it from Vaultwarden at runtime, do not commit it")
    try:
        import psycopg
        return psycopg.connect(database_url)
    except ImportError:
        try:
            import psycopg2
            return psycopg2.connect(database_url)
        except ImportError as exc:
            raise RuntimeError("Install psycopg or psycopg2 to write Postgres history") from exc


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description="ASX-first investment screener. Produces sanitized ranked JSON and plain-text report."
    )
    ap.add_argument(
        "--asx-watchlist",
        default=None,
        help="JSON watchlist file (universe/asx-watchlist.json). Use all active tickers.",
    )
    ap.add_argument(
        "--asx-universe-seed",
        default=None,
        help="Reviewed ASX company-directory seed JSON. Prefer this for expanded ASX batches.",
    )
    ap.add_argument(
        "--asx-tickers", nargs="*", metavar="TICKER",
        help="Hydrate specific ASX tickers via Yahoo (appends .AX when omitted).",
    )
    ap.add_argument(
        "--us-universe-seed",
        default=None,
        help="Reviewed US curated universe seed JSON (e.g. S&P 500 constituents). Hydrates via the EODHD fundamentals path.",
    )
    ap.add_argument(
        "--us-tickers", nargs="*", metavar="TICKER",
        help="Hydrate specific US tickers via EODHD fundamentals (appends .US when omitted).",
    )
    ap.add_argument(
        "--nasdaq-universe-seed",
        default=None,
        help="Reviewed full NASDAQ listed-equity seed JSON (security-type-filtered nasdaqlisted.txt). Hydrates via the EODHD fundamentals path with explicit NASDAQ exchange semantics.",
    )
    ap.add_argument(
        "--nasdaq-tickers", nargs="*", metavar="TICKER",
        help="Hydrate specific NASDAQ tickers via EODHD fundamentals (appends .US when omitted; market/exchange stay NASDAQ).",
    )
    ap.add_argument(
        "--fixture", action="store_true", default=False,
        help="Use built-in fixture data instead of live network calls.",
    )
    ap.add_argument(
        "--max-tickers", type=int, default=None,
        help="Bound live ASX hydration to the first N active tickers from the watchlist.",
    )
    ap.add_argument(
        "--batch-size", type=int, default=None,
        help="Alias for --max-tickers when selecting a deterministic ASX universe seed slice.",
    )
    ap.add_argument(
        "--batch-offset", type=int, default=0,
        help="Zero-based offset into the ranked ASX universe seed for resumable batches.",
    )
    ap.add_argument(
        "--include-security-types", default=None,
        help="Comma-separated security_type values to include from an ASX universe seed (e.g. ordinary_share,common_stock).",
    )
    ap.add_argument(
        "--exclude-security-types", default=None,
        help="Comma-separated security_type values to exclude from an ASX universe seed (e.g. etf,warrant).",
    )
    ap.add_argument(
        "--denominator-label", default=None,
        help="Human-readable denominator label exported in coverage metadata for dashboards.",
    )
    ap.add_argument(
        "--sleep-seconds", type=float, default=0.3,
        help="Delay between live provider requests to avoid aggressive scraping.",
    )
    ap.add_argument(
        "--cache-dir", default=None,
        help="Optional directory for cached provider JSON responses during bounded live runs.",
    )
    ap.add_argument(
        "--output-dir", default=None,
        help="Directory to write latest_ranked.json and latest_report.txt.",
    )
    ap.add_argument(
        "--file-first-run-json", default=None,
        help="Write canonical NAS/DuckDB publisher run payload JSON; publish it with scripts/publish-investment-screener-run.mjs.",
    )
    ap.add_argument(
        "--config", default=str(Path(__file__).parent / "config.yaml"),
        help="Path to config.yaml.",
    )
    ap.add_argument(
        "--top-n", type=int, default=None,
        help="Limit candidates to top N.",
    )
    ap.add_argument(
        "--write-postgres-history", action="store_true", default=False,
        help="Write the completed run to Postgres using a runtime database URL env var.",
    )
    ap.add_argument(
        "--database-url-env", default="DATABASE_URL",
        help="Environment variable containing the Postgres URL; value is read at runtime only.",
    )
    ap.add_argument(
        "--run-key", default=None,
        help="Stable idempotency key for this logical screener run.",
    )
    ap.add_argument(
        "--score-version", default="asx-bootstrap-v1",
        help="Version label for scorer logic stored with score rows.",
    )
    args = ap.parse_args(argv)
    if args.batch_size is not None:
        if args.max_tickers is not None and args.max_tickers != args.batch_size:
            ap.error("--batch-size and --max-tickers must match when both are provided")
        args.max_tickers = args.batch_size
    return args


FIXTURE_UNIVERSE = [
    {
        "ticker": "BHP.AX", "name": "BHP Group Limited (fixture)", "market": "ASX",
        "currency": "AUD", "price": FieldValue(45.0, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "price", "freshness": "fixture"}),
        "shares_outstanding": FieldValue(5_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "shares_outstanding", "freshness": "fixture"}),
        "revenue": FieldValue(60_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "revenue", "freshness": "fixture"}),
        "prior_revenue": FieldValue(55_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2024-06-30", "field_name": "prior_revenue", "freshness": "fixture"}),
        "net_income": FieldValue(10_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "net_income", "freshness": "fixture"}),
        "operating_cash_flow": FieldValue(18_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "operating_cash_flow", "freshness": "fixture"}),
        "capital_expenditures": FieldValue(-5_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "capital_expenditures", "freshness": "fixture"}),
        "total_assets": FieldValue(100_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "total_assets", "freshness": "fixture"}),
        "total_liabilities": FieldValue(40_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "total_liabilities", "freshness": "fixture"}),
        "current_assets": FieldValue(25_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "current_assets", "freshness": "fixture"}),
        "current_liabilities": FieldValue(10_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "current_liabilities", "freshness": "fixture"}),
    },
    {
        "ticker": "CBA.AX", "name": "Commonwealth Bank (fixture)", "market": "ASX",
        "currency": "AUD", "price": FieldValue(130.0, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "price", "freshness": "fixture"}),
        "shares_outstanding": FieldValue(1_800_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "shares_outstanding", "freshness": "fixture"}),
        "revenue": FieldValue(26_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "revenue", "freshness": "fixture"}),
        "prior_revenue": FieldValue(24_500_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2024-06-30", "field_name": "prior_revenue", "freshness": "fixture"}),
        "net_income": FieldValue(9_800_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "net_income", "freshness": "fixture"}),
        "operating_cash_flow": FieldValue(12_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "operating_cash_flow", "freshness": "fixture"}),
        "capital_expenditures": FieldValue(-1_200_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "capital_expenditures", "freshness": "fixture"}),
        "total_assets": FieldValue(1_200_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "total_assets", "freshness": "fixture"}),
        "total_liabilities": FieldValue(1_100_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "total_liabilities", "freshness": "fixture"}),
        "current_assets": FieldValue(200_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "current_assets", "freshness": "fixture"}),
        "current_liabilities": FieldValue(180_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "current_liabilities", "freshness": "fixture"}),
    },
    {
        "ticker": "CSL.AX", "name": "CSL Limited (fixture)", "market": "ASX",
        "currency": "AUD", "price": FieldValue(290.0, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "price", "freshness": "fixture"}),
        "shares_outstanding": FieldValue(476_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "shares_outstanding", "freshness": "fixture"}),
        "revenue": FieldValue(16_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "revenue", "freshness": "fixture"}),
        "prior_revenue": FieldValue(14_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2024-06-30", "field_name": "prior_revenue", "freshness": "fixture"}),
        "net_income": FieldValue(2_500_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "net_income", "freshness": "fixture"}),
        "operating_cash_flow": FieldValue(3_800_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "operating_cash_flow", "freshness": "fixture"}),
        "capital_expenditures": FieldValue(-1_500_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "capital_expenditures", "freshness": "fixture"}),
        "total_assets": FieldValue(32_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "total_assets", "freshness": "fixture"}),
        "total_liabilities": FieldValue(18_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "total_liabilities", "freshness": "fixture"}),
        "current_assets": FieldValue(8_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "current_assets", "freshness": "fixture"}),
        "current_liabilities": FieldValue(5_000_000_000, {"source_url": "fixture", "retrieved_at": "2026-01-01T00:00:00Z", "data_as_of": "2025-06-30", "field_name": "current_liabilities", "freshness": "fixture"}),
    },
]


def apply_provider_fallbacks_to_companies(companies: list[dict], adapters: list[ProviderAdapter]) -> tuple[list[dict], list[dict]]:
    """Apply enabled provider fallback adapters to hydrated companies.

    With the default empty environment this performs no network calls. If Ben
    later approves runtime credentials, adapters fill missing fields only and
    emit recoverable failures instead of fabricating values or aborting the run.
    """
    if not adapters:
        return companies, []
    updated: list[dict] = []
    failures: list[dict] = []
    for company in companies:
        if not _company_needs_provider_fallback(company):
            updated.append(company)
            continue
        merged, company_failures = fill_company_missing_fields(company, adapters)
        updated.append(merged)
        failures.extend(company_failures)
    return updated, failures


def main(argv=None):
    args = parse_args(argv)
    cfg = load_config(Path(args.config))

    companies: list[dict] = []
    universe_tickers: list[str] = []
    watchlist_path_str: Optional[str] = None
    universe_source = "fixture sample universe"
    universe_version: Optional[str] = None
    universe_metadata: dict = {}
    batch_metadata: dict = {}
    hydration_failures: list[dict] = []

    if args.fixture:
        print("Running in fixture mode (no network calls).", file=sys.stderr)
        companies = list(FIXTURE_UNIVERSE)
        universe_tickers = [str(c.get("ticker")) for c in companies if c.get("ticker")]
        mode = "fixture"
        universe_source = "fixture sample universe"
    elif args.asx_universe_seed:
        seed_path = Path(args.asx_universe_seed)
        watchlist_path_str = str(seed_path)
        seed = load_asx_universe_seed(seed_path)
        selected = select_asx_universe_batch(
            seed["entries"],
            batch_offset=args.batch_offset,
            max_tickers=args.max_tickers,
            include_security_types=parse_security_type_list(args.include_security_types),
            exclude_security_types=parse_security_type_list(args.exclude_security_types),
            denominator_label=args.denominator_label,
        )
        universe_tickers = list(selected["tickers"])
        cache_dir = Path(args.cache_dir) if args.cache_dir else None
        universe_source = "ASX company directory CSV via reviewed static seed"
        universe_version = build_universe_version(seed["metadata"])
        universe_metadata = dict(seed["metadata"])
        batch_metadata = dict(selected)
        batch_metadata.pop("entries", None)
        batch_metadata.pop("tickers", None)
        bound = f"offset={args.batch_offset}, size={args.max_tickers or selected['selected_count']}"
        print(f"Hydrating {len(universe_tickers)} active ASX tickers from universe seed ({bound}); sleep_seconds={args.sleep_seconds}.", file=sys.stderr)
        warnings: list[str] = []
        companies = hydrate_companies_from_asx_tickers(
            universe_tickers,
            warning_sink=warnings.append,
            sleep_seconds=args.sleep_seconds,
            cache_dir=cache_dir,
            failure_sink=hydration_failures.append,
        )
        companies = apply_asx_seed_identity(companies, selected["entries"])
        for w in warnings:
            print(w, file=sys.stderr)
        mode = "asx-yahoo-timeseries"
    elif args.asx_watchlist:
        watchlist_path = Path(args.asx_watchlist)
        watchlist_path_str = str(watchlist_path)
        watchlist = load_asx_watchlist(watchlist_path)
        tickers = select_active_asx_tickers(watchlist, max_tickers=args.max_tickers)
        universe_tickers = list(tickers)
        cache_dir = Path(args.cache_dir) if args.cache_dir else None
        universe_source = "configured ASX bootstrap watchlist"
        bound = f" (bounded to {args.max_tickers})" if args.max_tickers else ""
        print(f"Hydrating {len(tickers)} active ASX tickers from watchlist{bound}; sleep_seconds={args.sleep_seconds}.", file=sys.stderr)
        warnings: list[str] = []
        companies = hydrate_companies_from_asx_tickers(tickers, warning_sink=warnings.append, sleep_seconds=args.sleep_seconds, cache_dir=cache_dir, failure_sink=hydration_failures.append)
        for w in warnings:
            print(w, file=sys.stderr)
        mode = "asx-yahoo-timeseries"
    elif args.asx_tickers:
        print(f"Hydrating ASX tickers: {', '.join(args.asx_tickers)}", file=sys.stderr)
        universe_tickers = [normalise_asx_ticker(ticker) for ticker in args.asx_tickers]
        warnings: list[str] = []
        cache_dir = Path(args.cache_dir) if args.cache_dir else None
        universe_source = "explicit ASX ticker list"
        companies = hydrate_companies_from_asx_tickers(args.asx_tickers, warning_sink=warnings.append, sleep_seconds=args.sleep_seconds, cache_dir=cache_dir, failure_sink=hydration_failures.append)
        for w in warnings:
            print(w, file=sys.stderr)
        mode = "asx-yahoo-timeseries"
    elif args.nasdaq_universe_seed:
        seed_path = Path(args.nasdaq_universe_seed)
        watchlist_path_str = str(seed_path)
        seed = load_nasdaq_universe_seed(seed_path)
        selected = select_nasdaq_universe_batch(
            seed["entries"],
            batch_offset=args.batch_offset,
            max_tickers=args.max_tickers,
            denominator_label=args.denominator_label,
        )
        universe_tickers = list(selected["tickers"])
        cache_dir = Path(args.cache_dir) if args.cache_dir else None
        universe_source = NASDAQ_DENOMINATOR_LABEL
        universe_version = build_universe_version(seed["metadata"])
        universe_metadata = dict(seed["metadata"])
        batch_metadata = dict(selected)
        batch_metadata.pop("entries", None)
        batch_metadata.pop("tickers", None)
        bound = f"offset={args.batch_offset}, size={args.max_tickers or selected['selected_count']}"
        print(f"Hydrating {len(universe_tickers)} NASDAQ tickers via EODHD fundamentals from universe seed ({bound}); sleep_seconds={args.sleep_seconds}.", file=sys.stderr)
        eodhd = EodhdAdapter()
        companies = _fetch_us_eodhd_companies(
            universe_tickers,
            eodhd,
            cache_dir=cache_dir,
            sleep_seconds=args.sleep_seconds,
            failure_sink=hydration_failures.append,
        )
        companies = apply_nasdaq_seed_identity(companies, selected["entries"])
        mode = NASDAQ_MODE
        universe_source = NASDAQ_DENOMINATOR_LABEL
    elif args.nasdaq_tickers:
        print(f"Hydrating NASDAQ tickers via EODHD fundamentals: {', '.join(args.nasdaq_tickers)}", file=sys.stderr)
        universe_tickers = [normalise_us_ticker(ticker) for ticker in args.nasdaq_tickers]
        cache_dir = Path(args.cache_dir) if args.cache_dir else None
        universe_source = "explicit NASDAQ ticker list"
        eodhd = EodhdAdapter()
        companies = _fetch_us_eodhd_companies(
            universe_tickers,
            eodhd,
            cache_dir=cache_dir,
            sleep_seconds=args.sleep_seconds,
            failure_sink=hydration_failures.append,
        )
        companies = apply_nasdaq_seed_identity(companies, [])
        batch_metadata = {
            "eligible_count": len(universe_tickers),
            "selected_count": len(universe_tickers),
            "full_count": len(universe_tickers),
            "denominator_status": "known_sample_universe",
            "denominator_label": "explicit NASDAQ ticker list",
        }
        mode = NASDAQ_MODE
    elif args.us_universe_seed:
        seed_path = Path(args.us_universe_seed)
        watchlist_path_str = str(seed_path)
        seed = load_us_universe_seed(seed_path)
        selected = select_us_universe_batch(
            seed["entries"],
            batch_offset=args.batch_offset,
            max_tickers=args.max_tickers,
            denominator_label=args.denominator_label,
        )
        universe_tickers = list(selected["tickers"])
        cache_dir = Path(args.cache_dir) if args.cache_dir else None
        universe_source = US_DENOMINATOR_LABEL
        universe_version = build_universe_version(seed["metadata"])
        universe_metadata = dict(seed["metadata"])
        batch_metadata = dict(selected)
        batch_metadata.pop("entries", None)
        batch_metadata.pop("tickers", None)
        bound = f"offset={args.batch_offset}, size={args.max_tickers or selected['selected_count']}"
        print(f"Hydrating {len(universe_tickers)} US tickers via EODHD fundamentals from universe seed ({bound}); sleep_seconds={args.sleep_seconds}.", file=sys.stderr)
        eodhd = EodhdAdapter()
        companies = _fetch_us_eodhd_companies(
            universe_tickers,
            eodhd,
            cache_dir=cache_dir,
            sleep_seconds=args.sleep_seconds,
            failure_sink=hydration_failures.append,
        )
        companies = apply_us_seed_identity(companies, selected["entries"])
        mode = "us-eodhd-fundamentals"
        universe_source = US_DENOMINATOR_LABEL
    elif args.us_tickers:
        print(f"Hydrating US tickers via EODHD fundamentals: {', '.join(args.us_tickers)}", file=sys.stderr)
        universe_tickers = [normalise_us_ticker(ticker) for ticker in args.us_tickers]
        cache_dir = Path(args.cache_dir) if args.cache_dir else None
        universe_source = "explicit US ticker list"
        eodhd = EodhdAdapter()
        companies = _fetch_us_eodhd_companies(
            universe_tickers,
            eodhd,
            cache_dir=cache_dir,
            sleep_seconds=args.sleep_seconds,
            failure_sink=hydration_failures.append,
        )
        batch_metadata = {
            "eligible_count": len(universe_tickers),
            "selected_count": len(universe_tickers),
            "full_count": len(universe_tickers),
            "denominator_status": "known_sample_universe",
            "denominator_label": "explicit US ticker list",
        }
        mode = "us-eodhd-fundamentals"
    else:
        print("No input specified. Use --fixture, --asx-watchlist, --asx-tickers, --us-universe-seed, --us-tickers, --nasdaq-universe-seed, or --nasdaq-tickers.", file=sys.stderr)
        sys.exit(1)

    if not companies:
        print("No companies to score.", file=sys.stderr)
        sys.exit(1)

    fallback_adapters = build_fallback_adapters()
    companies, fallback_failures = apply_provider_fallbacks_to_companies(companies, fallback_adapters)
    hydration_failures.extend(fallback_failures)
    if fallback_adapters:
        print(
            "Applied provider fallback adapters: " + ", ".join(adapter.name for adapter in fallback_adapters),
            file=sys.stderr,
        )

    ranked = rank_companies(companies, cfg)
    if args.top_n:
        ranked = apply_top_n(ranked, args.top_n)

    export = build_dashboard_ranked_export(ranked, mode=mode)
    report = build_plain_text_report(ranked, export, watchlist_path_str)

    if args.file_first_run_json:
        payload = build_file_first_run_payload(
            ranked,
            source="yahoo-finance" if mode == "asx-yahoo-timeseries" else ("eodhd" if mode in {US_EODHD_MODE, NASDAQ_MODE} else mode),
            mode=mode,
            universe=universe_tickers,
            universe_source=universe_source,
            universe_version=universe_version,
            universe_metadata=universe_metadata,
            batch_metadata=batch_metadata,
            hydration_failures=hydration_failures,
        )
        Path(args.file_first_run_json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.file_first_run_json).write_text(json.dumps(payload, indent=2, default=str) + "\n")
        print("Wrote file-first run JSON payload.", file=sys.stderr)

    if args.write_postgres_history:
        conn = connect_postgres_from_env(args.database_url_env)
        init_postgres_schema(conn)
        run_id = insert_screener_run(
            conn,
            ranked,
            source=mode,
            mode=mode,
            universe=universe_tickers,
            metadata={
                "output_dir_requested": bool(args.output_dir),
                "top_n": args.top_n,
                "max_tickers": args.max_tickers,
                "sleep_seconds": args.sleep_seconds,
                "cache_enabled": bool(args.cache_dir),
                "source_caveat": (
                    "Yahoo Finance public endpoints are unofficial; verify against ASX filings before use."
                    if mode == "asx-yahoo-timeseries"
                    else "EODHD fundamentals are licensed provider data; verify against company filings before use."
                ),
            },
            run_key=args.run_key,
            score_version=args.score_version,
            universe_metadata=build_universe_storage_metadata(
                universe_tickers,
                universe_metadata=universe_metadata,
                batch_metadata=batch_metadata,
            ),
            provider_failures=hydration_failures,
        )
        print(f"Wrote Postgres history run id: {run_id}", file=sys.stderr)

    if args.output_dir:
        out = Path(args.output_dir)
        out.mkdir(parents=True, exist_ok=True)
        json_path = out / "latest_ranked.json"
        report_path = out / "latest_report.txt"
        json_path.write_text(json.dumps(export, indent=2, default=str))
        report_path.write_text(report)
        print(f"Wrote: {json_path}", file=sys.stderr)
        print(f"Wrote: {report_path}", file=sys.stderr)
    else:
        print(report)
        print("\n--- ranked JSON ---")
        print(json.dumps(export, indent=2, default=str))


if __name__ == "__main__":
    main()

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
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional
import urllib.parse
import urllib.request


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

    total_weight = sum(weights.values())
    composite = sum(weights.get(cat, 0) * sub_scores.get(cat, 0) / 100 for cat in weights)
    if total_weight != 0:
        composite = composite / total_weight * 100

    unique_missing = list(dict.fromkeys(all_missing))
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
        **{k: company.get(k) for k in ("exchange", "region", "sector", "industry") if company.get(k) is not None},
        "excluded": False,
        "exclusion_reasons": [],
        "sub_scores": sub_scores,
        "composite_score": round(composite, 2),
        "score_caps": score_caps,
        "risk_flags": risk_flags,
        "missing_penalty_points": missing_penalty,
        "caveats": list(dict.fromkeys(all_caveats)),
        "missing_fields": unique_missing,
        "provenance_summary": _provenance_summary(company),
        "fields": fields,
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
                **{k: company.get(k) for k in ("exchange", "region", "sector", "industry") if company.get(k) is not None},
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
            scored.append(score_company(company, cfg))

    # Sort: non-excluded by composite_score desc, excluded at end
    non_excluded = sorted(
        [r for r in scored if not r.get("excluded")],
        key=lambda r: r.get("composite_score") or 0,
        reverse=True,
    )
    excluded = [r for r in scored if r.get("excluded")]

    ranked = []
    for i, row in enumerate(non_excluded, start=1):
        row["rank"] = i
        ranked.append(row)
    for row in excluded:
        row["rank"] = None
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
        if row.get("excluded"):
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
    data_as_of = _first_sorted_value(summary.get("data_as_of") or [])
    retrieved_at = _first_sorted_value(summary.get("retrieved_at") or [])
    pieces = []
    if source_count:
        pieces.append(f"{source_count} source(s)")
    if data_as_of:
        pieces.append(f"data_as_of={data_as_of}")
    if retrieved_at:
        pieces.append(f"retrieved_at={retrieved_at}")
    return "; ".join(pieces) if pieces else None


def _dashboard_ranked_row(row: dict) -> dict:
    return {
        "rank": row.get("rank"),
        "ticker": row.get("ticker"),
        "name": row.get("name"),
        "market": row.get("market"),
        "currency": row.get("currency"),
        "score": row.get("composite_score"),
        "sub_scores": dict(row.get("sub_scores") or {}),
        "missing_penalty_points": row.get("missing_penalty_points"),
        "risk_flags": list(row.get("risk_flags") or []),
        "caveats": list(dict.fromkeys(list(row.get("caveats") or []) + list(row.get("exclusion_reasons") or []))),
        "score_caps": _dashboard_score_caps(row.get("score_caps")),
        "sanitized_provenance_summary": _dashboard_provenance_summary(row),
    }


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
    return {
        "mode": mode,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "data_as_of": _ranked_data_as_of(ranked),
        "limitations": limitations,
        "candidates": [_dashboard_ranked_row(row) for row in ranked if not row.get("excluded")],
        "excluded": [_dashboard_ranked_row(row) for row in ranked if row.get("excluded")],
    }


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


def _fetch_json_url(url: str, timeout: int, cache_dir: Optional[Path] = None) -> dict:
    path = _cache_path(cache_dir, url)
    if path and path.exists():
        with open(path) as fh:
            return json.load(fh)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode())
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, default=str))
    return data


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
            warning_sink(f"WARNING: failed to hydrate {symbol} ASX data: {exc}")
        if sleep_seconds and ticker != tickers[-1]:
            time.sleep(sleep_seconds)
    return companies


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
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
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
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

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
  ADD COLUMN IF NOT EXISTS missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb;

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
    digest = __import__("hashlib").sha256(_json_param(payload).encode()).hexdigest()[:16]
    return f"investment-screener:ASX:{mode}:{digest}"


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
    for field_name, field_data in _row_raw_fields(row).items():
        prov = field_data.get("provenance") or {}
        if not prov:
            continue
        source_family = prov.get("source_family") or prov.get("provider") or prov.get("yahoo_type") or prov.get("freshness") or "unknown"
        item = (
            field_name,
            str(source_family)[:80],
            prov.get("source_url"),
            _parse_iso_timestamp(prov.get("retrieved_at") or prov.get("retrieved_from_source_at")),
            _parse_iso_date(prov.get("source_reported_at")),
            _parse_iso_date(prov.get("data_as_of")),
            prov.get("trust_level") or prov.get("source_quality") or prov.get("freshness"),
            prov.get("extraction_status") or "not_attempted",
            prov.get("notes") or prov.get("freshness"),
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
) -> int:
    """Insert/upsert a completed screener run and its historical rows. Returns run id.

    The writer is idempotent by ``run_key``. Re-running the same logical run updates
    the same run/company/observation/score rows instead of inserting mystery twins.
    """
    run_key = run_key or _stable_run_key(source, mode, universe, metadata)
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO investment_screener_runs(
          run_key, started_at, completed_at, status, market, mode, universe_version,
          source_mix, code_version, config_hash, metadata
        )
        VALUES (%s, now(), now(), %s, %s, %s, %s, %s::jsonb, %s, %s, %s::jsonb)
        ON CONFLICT (run_key) DO UPDATE SET
          completed_at = EXCLUDED.completed_at,
          status = EXCLUDED.status,
          market = EXCLUDED.market,
          mode = EXCLUDED.mode,
          universe_version = COALESCE(EXCLUDED.universe_version, investment_screener_runs.universe_version),
          source_mix = EXCLUDED.source_mix,
          code_version = COALESCE(EXCLUDED.code_version, investment_screener_runs.code_version),
          config_hash = COALESCE(EXCLUDED.config_hash, investment_screener_runs.config_hash),
          metadata = EXCLUDED.metadata
        RETURNING id
        """,
        (
            run_key,
            "completed",
            "ASX",
            mode,
            universe_version,
            _json_param({"source": source, "universe": universe}),
            code_version,
            config_hash,
            _json_param(metadata or {}),
        ),
    )
    run_id = cur.fetchone()[0]
    for row in ranked:
        ticker = row.get("ticker")
        asx_code = (str(ticker).upper().replace(".AX", "") if ticker else None)
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
        cur.execute(
            """
            INSERT INTO investment_screener_observations(
              run_id, company_id, ticker, period_end, data_as_of, currency, source_quality,
              raw_fields, derived_fields, missing_fields
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb)
            ON CONFLICT (run_id, company_id) DO UPDATE SET
              ticker = EXCLUDED.ticker,
              period_end = EXCLUDED.period_end,
              data_as_of = EXCLUDED.data_as_of,
              currency = EXCLUDED.currency,
              source_quality = EXCLUDED.source_quality,
              raw_fields = EXCLUDED.raw_fields,
              derived_fields = EXCLUDED.derived_fields,
              missing_fields = EXCLUDED.missing_fields
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
        "--asx-tickers", nargs="*", metavar="TICKER",
        help="Hydrate specific ASX tickers via Yahoo (appends .AX when omitted).",
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
    return ap.parse_args(argv)


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


def main(argv=None):
    args = parse_args(argv)
    cfg = load_config(Path(args.config))

    companies: list[dict] = []
    universe_tickers: list[str] = []
    watchlist_path_str: Optional[str] = None

    if args.fixture:
        print("Running in fixture mode (no network calls).", file=sys.stderr)
        companies = list(FIXTURE_UNIVERSE)
        universe_tickers = [str(c.get("ticker")) for c in companies if c.get("ticker")]
        mode = "fixture"
    elif args.asx_watchlist:
        watchlist_path = Path(args.asx_watchlist)
        watchlist_path_str = str(watchlist_path)
        watchlist = load_asx_watchlist(watchlist_path)
        tickers = select_active_asx_tickers(watchlist, max_tickers=args.max_tickers)
        universe_tickers = list(tickers)
        cache_dir = Path(args.cache_dir) if args.cache_dir else None
        bound = f" (bounded to {args.max_tickers})" if args.max_tickers else ""
        print(f"Hydrating {len(tickers)} active ASX tickers from watchlist{bound}; sleep_seconds={args.sleep_seconds}.", file=sys.stderr)
        warnings: list[str] = []
        companies = hydrate_companies_from_asx_tickers(tickers, warning_sink=warnings.append, sleep_seconds=args.sleep_seconds, cache_dir=cache_dir)
        for w in warnings:
            print(w, file=sys.stderr)
        mode = "asx-yahoo-timeseries"
    elif args.asx_tickers:
        print(f"Hydrating ASX tickers: {', '.join(args.asx_tickers)}", file=sys.stderr)
        universe_tickers = [normalise_asx_ticker(ticker) for ticker in args.asx_tickers]
        warnings: list[str] = []
        cache_dir = Path(args.cache_dir) if args.cache_dir else None
        companies = hydrate_companies_from_asx_tickers(args.asx_tickers, warning_sink=warnings.append, sleep_seconds=args.sleep_seconds, cache_dir=cache_dir)
        for w in warnings:
            print(w, file=sys.stderr)
        mode = "asx-yahoo-timeseries"
    else:
        print("No input specified. Use --fixture, --asx-watchlist, or --asx-tickers.", file=sys.stderr)
        sys.exit(1)

    if not companies:
        print("No companies to score.", file=sys.stderr)
        sys.exit(1)

    ranked = rank_companies(companies, cfg)
    if args.top_n:
        ranked = apply_top_n(ranked, args.top_n)

    export = build_dashboard_ranked_export(ranked, mode=mode)
    report = build_plain_text_report(ranked, export, watchlist_path_str)

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
                "source_caveat": "Yahoo Finance public endpoints are unofficial; verify against ASX filings before use.",
            },
            run_key=args.run_key,
            score_version=args.score_version,
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

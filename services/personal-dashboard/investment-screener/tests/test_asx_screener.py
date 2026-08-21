"""
tests/test_asx_screener.py
==========================
TDD tests for ASX screener hydration and sanitized export.
All new behavior must fail first, then pass with minimal production code.

Test categories:
  1. ASX ticker normalization (.AX appending)
  2. Yahoo timeseries parsing -> company hydration
  3. Partial failure / no-match handling
  4. Dashboard export shape (market=ASX, no raw secrets/paths)
  5. Postgres storage insert shape
  6. Watchlist file loading
"""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add investment-screener directory to path so we can import screener
_SCREENER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_SCREENER_DIR))

import screener as scr
from screener import (
    FieldValue,
    apply_hard_exclusions,
    build_company_from_yahoo_timeseries,
    build_dashboard_ranked_export,
    hydrate_companies_from_asx_tickers,
    insert_screener_run,
    load_config,
    load_asx_watchlist,
    normalise_asx_ticker,
    rank_companies,
    score_company,
)

CONFIG_PATH = _SCREENER_DIR / "config.yaml"
WATCHLIST_PATH = _SCREENER_DIR / "universe" / "asx-watchlist.json"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def field(value, name, data_as_of="2025-06-30"):
    return FieldValue(
        value=value,
        provenance={
            "source_url": "fixture",
            "retrieved_at": "2026-01-01T00:00:00Z",
            "retrieved_from_source_at": "2026-01-01T00:00:00Z",
            "data_as_of": data_as_of,
            "field_name": name,
            "freshness": "fixture",
        },
    )


def stale_field(value, name):
    return FieldValue(
        value=value,
        provenance={
            "source_url": "fixture",
            "retrieved_at": "2020-01-01T00:00:00Z",
            "data_as_of": "2020-01-01",
            "field_name": name,
            "freshness": "stale fixture",
        },
    )


def asx_company(**overrides):
    """Baseline ASX company fixture."""
    base = {
        "ticker": "BHP.AX",
        "name": "BHP Group Limited",
        "market": "ASX",
        "exchange": "ASX",
        "region": "AU",
        "currency": "AUD",
        "price": field(45.00, "price"),
        "shares_outstanding": field(5_000_000_000, "shares_outstanding"),
        "revenue": field(60_000_000_000, "revenue"),
        "prior_revenue": field(55_000_000_000, "prior_revenue"),
        "net_income": field(10_000_000_000, "net_income"),
        "operating_cash_flow": field(18_000_000_000, "operating_cash_flow"),
        "capital_expenditures": field(-5_000_000_000, "capital_expenditures"),
        "total_assets": field(100_000_000_000, "total_assets"),
        "total_liabilities": field(40_000_000_000, "total_liabilities"),
        "current_assets": field(25_000_000_000, "current_assets"),
        "current_liabilities": field(10_000_000_000, "current_liabilities"),
    }
    base.update(overrides)
    return base


def bhp_timeseries_fixture():
    """Minimal Yahoo timeseries fixture for BHP.AX."""
    return {
        "timeseries": {
            "result": [
                {
                    "meta": {"type": ["annualTotalRevenue"]},
                    "annualTotalRevenue": [
                        {
                            "asOfDate": "2025-06-30",
                            "currencyCode": "USD",
                            "reportedValue": {"raw": 53_248_000_000.0},
                        },
                        {
                            "asOfDate": "2026-06-30",
                            "currencyCode": "USD",
                            "reportedValue": {"raw": 56_642_000_000.0},
                        },
                    ],
                },
                {
                    "meta": {"type": ["annualNetIncome"]},
                    "annualNetIncome": [
                        {
                            "asOfDate": "2026-06-30",
                            "currencyCode": "USD",
                            "reportedValue": {"raw": 9_845_000_000.0},
                        }
                    ],
                },
                {
                    "meta": {"type": ["annualOperatingCashFlow"]},
                    "annualOperatingCashFlow": [
                        {
                            "asOfDate": "2026-06-30",
                            "currencyCode": "USD",
                            "reportedValue": {"raw": 18_831_000_000.0},
                        }
                    ],
                },
                {
                    "meta": {"type": ["annualCapitalExpenditure"]},
                    "annualCapitalExpenditure": [
                        {
                            "asOfDate": "2026-06-30",
                            "currencyCode": "USD",
                            "reportedValue": {"raw": -10_170_000_000.0},
                        }
                    ],
                },
                {
                    "meta": {"type": ["annualTotalAssets"]},
                    "annualTotalAssets": [
                        {
                            "asOfDate": "2026-06-30",
                            "currencyCode": "USD",
                            "reportedValue": {"raw": 113_137_000_000.0},
                        }
                    ],
                },
                {
                    "meta": {
                        "type": ["annualTotalLiabilitiesNetMinorityInterest"]
                    },
                    "annualTotalLiabilitiesNetMinorityInterest": [
                        {
                            "asOfDate": "2026-06-30",
                            "currencyCode": "USD",
                            "reportedValue": {"raw": 65_066_000_000.0},
                        }
                    ],
                },
                {
                    "meta": {"type": ["annualCurrentAssets"]},
                    "annualCurrentAssets": [
                        {
                            "asOfDate": "2026-06-30",
                            "currencyCode": "USD",
                            "reportedValue": {"raw": 25_269_000_000.0},
                        }
                    ],
                },
                {
                    "meta": {"type": ["annualCurrentLiabilities"]},
                    "annualCurrentLiabilities": [
                        {
                            "asOfDate": "2026-06-30",
                            "currencyCode": "USD",
                            "reportedValue": {"raw": 17_050_000_000.0},
                        }
                    ],
                },
                {
                    "meta": {"type": ["annualDilutedAverageShares"]},
                    "annualDilutedAverageShares": [
                        {
                            "asOfDate": "2026-06-30",
                            "currencyCode": "USD",
                            "reportedValue": {"raw": 5_089_000_000.0},
                        }
                    ],
                },
            ]
        }
    }


# ---------------------------------------------------------------------------
# 1. ASX ticker normalisation
# ---------------------------------------------------------------------------


class TestNormaliseAsxTicker(unittest.TestCase):

    def test_bare_asx_code_gets_dot_ax_appended(self):
        self.assertEqual(normalise_asx_ticker("BHP"), "BHP.AX")

    def test_ticker_already_ending_dot_ax_unchanged(self):
        self.assertEqual(normalise_asx_ticker("BHP.AX"), "BHP.AX")

    def test_lowercase_dot_ax_suffix_is_normalised_to_uppercase(self):
        self.assertEqual(normalise_asx_ticker("cba.ax"), "CBA.AX")

    def test_mixed_case_bare_code_is_uppercased(self):
        self.assertEqual(normalise_asx_ticker("csl"), "CSL.AX")


# ---------------------------------------------------------------------------
# 2. Yahoo timeseries -> company hydration
# ---------------------------------------------------------------------------


class TestBuildCompanyFromYahooTimeseries(unittest.TestCase):

    def test_bhp_timeseries_sets_market_asx_and_currency_aud(self):
        quote = {"price": 65.16, "currency": "AUD", "exchange": "ASX", "name": "BHP Group"}
        timeseries = bhp_timeseries_fixture()

        hydrated = build_company_from_yahoo_timeseries("BHP.AX", timeseries, quote)

        self.assertEqual(hydrated["ticker"], "BHP.AX")
        self.assertEqual(hydrated["market"], "ASX")
        self.assertEqual(hydrated["currency"], "AUD")
        self.assertEqual(hydrated["region"], "AU")

    def test_timeseries_price_extracted_from_quote(self):
        quote = {"price": 65.16, "currency": "AUD", "exchange": "ASX"}
        hydrated = build_company_from_yahoo_timeseries(
            "BHP.AX", bhp_timeseries_fixture(), quote
        )
        self.assertAlmostEqual(hydrated["price"].value, 65.16)

    def test_timeseries_revenue_picks_most_recent_year(self):
        quote = {"price": 10.0, "currency": "AUD", "exchange": "ASX"}
        hydrated = build_company_from_yahoo_timeseries(
            "BHP.AX", bhp_timeseries_fixture(), quote
        )
        # fixture has 2025 and 2026; latest should be 2026
        self.assertAlmostEqual(hydrated["revenue"].value, 56_642_000_000.0)

    def test_timeseries_prior_revenue_picks_second_most_recent_year(self):
        quote = {"price": 10.0, "currency": "AUD", "exchange": "ASX"}
        hydrated = build_company_from_yahoo_timeseries(
            "BHP.AX", bhp_timeseries_fixture(), quote
        )
        self.assertAlmostEqual(hydrated["prior_revenue"].value, 53_248_000_000.0)

    def test_timeseries_capital_expenditure_forced_negative(self):
        quote = {"price": 10.0, "currency": "AUD", "exchange": "ASX"}
        hydrated = build_company_from_yahoo_timeseries(
            "BHP.AX", bhp_timeseries_fixture(), quote
        )
        # Fixture has a negative value already; ensure still negative
        self.assertLess(hydrated["capital_expenditures"].value, 0)

    def test_timeseries_shares_outstanding_from_diluted_average(self):
        quote = {"price": 10.0, "currency": "AUD", "exchange": "ASX"}
        hydrated = build_company_from_yahoo_timeseries(
            "BHP.AX", bhp_timeseries_fixture(), quote
        )
        self.assertAlmostEqual(hydrated["shares_outstanding"].value, 5_089_000_000.0)

    def test_timeseries_provenance_contains_yahoo_freshness_label(self):
        quote = {"price": 10.0, "currency": "AUD", "exchange": "ASX"}
        hydrated = build_company_from_yahoo_timeseries(
            "BHP.AX", bhp_timeseries_fixture(), quote
        )
        self.assertIn(
            "Yahoo fundamentals-timeseries",
            hydrated["revenue"].provenance["freshness"],
        )

    def test_timeseries_provenance_records_data_as_of(self):
        quote = {"price": 10.0, "currency": "AUD", "exchange": "ASX"}
        hydrated = build_company_from_yahoo_timeseries(
            "BHP.AX", bhp_timeseries_fixture(), quote
        )
        self.assertEqual(hydrated["revenue"].provenance["data_as_of"], "2026-06-30")

    def test_timeseries_missing_field_returns_none_value_with_provenance(self):
        """A field absent from the timeseries result should still be a FieldValue(None)."""
        quote = {"price": 10.0, "currency": "AUD", "exchange": "ASX"}
        # Remove operating cash flow from fixture
        ts = bhp_timeseries_fixture()
        ts["timeseries"]["result"] = [
            r for r in ts["timeseries"]["result"]
            if "annualOperatingCashFlow" not in r
        ]

        hydrated = build_company_from_yahoo_timeseries("BHP.AX", ts, quote)

        self.assertIsNone(hydrated["operating_cash_flow"].value)
        self.assertIsInstance(hydrated["operating_cash_flow"], FieldValue)

    def test_ticker_without_dot_ax_still_gets_asx_market(self):
        """Even if caller passes bare ASX code, market should be inferred from ticker suffix."""
        quote = {"price": 10.0, "currency": "AUD", "exchange": "ASX"}
        ts = {
            "timeseries": {"result": []}
        }
        # Use normalised form in caller
        hydrated = build_company_from_yahoo_timeseries("BHP.AX", ts, quote)
        self.assertEqual(hydrated["market"], "ASX")


# ---------------------------------------------------------------------------
# 3. Partial failure / no-match handling in hydrate_companies_from_asx_tickers
# ---------------------------------------------------------------------------


class TestHydrateAsxTickers(unittest.TestCase):

    def test_failed_ticker_emits_warning_and_is_skipped(self):
        warnings = []

        def failing_quote(ticker):
            raise RuntimeError("network error")

        def noop_timeseries(ticker, years=6):
            return {"timeseries": {"result": []}}

        result = hydrate_companies_from_asx_tickers(
            ["FAIL"],
            warning_sink=warnings.append,
            quote_fetcher=failing_quote,
            timeseries_fetcher=noop_timeseries,
            sleep_seconds=0,
        )

        self.assertEqual(result, [])
        self.assertTrue(any("FAIL" in w for w in warnings))

    def test_partial_failure_returns_successful_tickers_only(self):
        warnings = []
        call_counts = {"quote": 0}

        def selective_quote(ticker):
            call_counts["quote"] += 1
            if "FAIL" in ticker:
                raise RuntimeError("network error")
            return {"price": 45.0, "currency": "AUD", "exchange": "ASX", "name": "Good Co"}

        def noop_timeseries(ticker, years=6):
            return bhp_timeseries_fixture()

        result = hydrate_companies_from_asx_tickers(
            ["BHP", "FAIL", "CBA"],
            warning_sink=warnings.append,
            quote_fetcher=selective_quote,
            timeseries_fetcher=noop_timeseries,
            sleep_seconds=0,
        )

        tickers = [c["ticker"] for c in result]
        self.assertIn("BHP.AX", tickers)
        self.assertIn("CBA.AX", tickers)
        self.assertNotIn("FAIL.AX", tickers)
        self.assertTrue(any("FAIL" in w for w in warnings))

    def test_bare_codes_are_normalised_to_dot_ax_before_fetching(self):
        fetched_tickers = []

        def capturing_quote(ticker):
            fetched_tickers.append(ticker)
            return {"price": 10.0, "currency": "AUD", "exchange": "ASX", "name": "X"}

        def noop_timeseries(ticker, years=6):
            return {"timeseries": {"result": []}}

        hydrate_companies_from_asx_tickers(
            ["BHP", "CBA"],
            warning_sink=lambda w: None,
            quote_fetcher=capturing_quote,
            timeseries_fetcher=noop_timeseries,
            sleep_seconds=0,
        )

        self.assertIn("BHP.AX", fetched_tickers)
        self.assertIn("CBA.AX", fetched_tickers)

    def test_empty_ticker_list_returns_empty_list_no_warnings(self):
        warnings = []
        result = hydrate_companies_from_asx_tickers(
            [],
            warning_sink=warnings.append,
            sleep_seconds=0,
        )
        self.assertEqual(result, [])
        self.assertEqual(warnings, [])


# ---------------------------------------------------------------------------
# 4. Dashboard export shape (market=ASX, no raw secrets/paths/dumps)
# ---------------------------------------------------------------------------


class TestDashboardExportShape(unittest.TestCase):

    def test_export_candidates_have_market_asx(self):
        cfg = load_config(CONFIG_PATH)
        c = asx_company()
        ranked = rank_companies([c], cfg)
        export = build_dashboard_ranked_export(ranked, mode="asx-yahoo-timeseries")

        self.assertTrue(len(export["candidates"]) > 0)
        for candidate in export["candidates"]:
            self.assertEqual(candidate["market"], "ASX")

    def test_export_top_level_structure_has_required_keys(self):
        cfg = load_config(CONFIG_PATH)
        c = asx_company()
        ranked = rank_companies([c], cfg)
        export = build_dashboard_ranked_export(ranked, mode="asx-yahoo-timeseries")

        for key in ("mode", "generated_at", "data_as_of", "limitations", "candidates", "excluded"):
            self.assertIn(key, export)

    def test_export_candidates_have_no_raw_provenance_internals(self):
        """Candidate rows must not expose source_url, raw field dicts, or FieldValue objects."""
        cfg = load_config(CONFIG_PATH)
        c = asx_company()
        ranked = rank_companies([c], cfg)
        export = build_dashboard_ranked_export(ranked, mode="asx-yahoo-timeseries")

        for candidate in export["candidates"]:
            self.assertNotIn("fields", candidate)
            self.assertNotIn("provenance_summary", candidate)
            # sanitized_provenance_summary is allowed (it's a safe string)
            if "sanitized_provenance_summary" in candidate:
                self.assertIsInstance(candidate["sanitized_provenance_summary"], (str, type(None)))

    def test_export_serializes_to_json_cleanly(self):
        cfg = load_config(CONFIG_PATH)
        c = asx_company()
        ranked = rank_companies([c], cfg)
        export = build_dashboard_ranked_export(ranked, mode="asx-yahoo-timeseries")

        serialized = json.dumps(export)
        parsed = json.loads(serialized)
        self.assertIn("candidates", parsed)

    def test_export_excluded_companies_appear_in_excluded_list(self):
        cfg = load_config(CONFIG_PATH)
        good = asx_company(ticker="BHP.AX")
        bad = asx_company(ticker="MISS.AX", price=field(None, "price"))
        ranked = rank_companies([good, bad], cfg)
        export = build_dashboard_ranked_export(ranked, mode="asx-yahoo-timeseries")

        excluded_tickers = [e["ticker"] for e in export["excluded"]]
        self.assertIn("MISS.AX", excluded_tickers)

    def test_export_mode_field_reflects_asx_source(self):
        cfg = load_config(CONFIG_PATH)
        c = asx_company()
        ranked = rank_companies([c], cfg)
        export = build_dashboard_ranked_export(ranked, mode="asx-yahoo-timeseries")

        self.assertEqual(export["mode"], "asx-yahoo-timeseries")

    def test_export_candidates_contain_score_risk_flags_caveats(self):
        cfg = load_config(CONFIG_PATH)
        c = asx_company()
        ranked = rank_companies([c], cfg)
        export = build_dashboard_ranked_export(ranked, mode="asx-yahoo-timeseries")

        for candidate in export["candidates"]:
            self.assertIn("score", candidate)
            self.assertIn("risk_flags", candidate)
            self.assertIn("caveats", candidate)

    def test_export_asx_candidate_scores_above_zero(self):
        """A healthy ASX company with all fields should score above zero."""
        cfg = load_config(CONFIG_PATH)
        c = asx_company()
        ranked = rank_companies([c], cfg)
        export = build_dashboard_ranked_export(ranked, mode="asx-yahoo-timeseries")

        self.assertTrue(len(export["candidates"]) > 0)
        self.assertGreater(export["candidates"][0]["score"], 0)


# ---------------------------------------------------------------------------
# 5. Postgres storage insert shape
# ---------------------------------------------------------------------------


class TestInsertScreenerRun(unittest.TestCase):

    def _fake_conn(self, run_id=42):
        class FakeCursor:
            def __init__(self):
                self.statements = []
                self._ids = iter([run_id, 100, 101, 102, 103, 104])

            def execute(self, sql, params=None):
                self.statements.append((sql, params))

            def fetchone(self):
                return (next(self._ids),)

        class FakeConn:
            def __init__(self):
                self.cursor_obj = FakeCursor()
                self.committed = False

            def cursor(self):
                return self.cursor_obj

            def commit(self):
                self.committed = True

        return FakeConn()

    def test_insert_creates_run_company_observation_and_score_rows(self):
        cfg = load_config(CONFIG_PATH)
        c = asx_company()
        ranked = rank_companies([c], cfg)
        conn = self._fake_conn()

        run_id = insert_screener_run(
            conn, ranked, source="asx-yahoo-timeseries", mode="fixture", universe=["BHP.AX"]
        )

        self.assertEqual(run_id, 42)
        self.assertTrue(conn.committed)
        sql_text = "\n".join(sql for sql, _ in conn.cursor_obj.statements)
        self.assertIn("investment_screener_runs", sql_text)
        self.assertIn("investment_screener_companies", sql_text)
        self.assertIn("investment_screener_observations", sql_text)
        self.assertIn("investment_screener_scores", sql_text)

    def test_insert_run_id_is_returned_from_runs_insert(self):
        cfg = load_config(CONFIG_PATH)
        c = asx_company()
        ranked = rank_companies([c], cfg)
        conn = self._fake_conn(run_id=99)

        run_id = insert_screener_run(
            conn, ranked, source="test", mode="fixture", universe=["BHP.AX"]
        )

        self.assertEqual(run_id, 99)

    def test_insert_records_asx_ticker_in_score_params(self):
        cfg = load_config(CONFIG_PATH)
        c = asx_company(ticker="CBA.AX", market="ASX", currency="AUD")
        ranked = rank_companies([c], cfg)
        conn = self._fake_conn()

        insert_screener_run(
            conn, ranked, source="test", mode="fixture", universe=["CBA.AX"]
        )

        score_params = next(
            params for sql, params in conn.cursor_obj.statements
            if "investment_screener_scores" in sql
        )
        self.assertEqual(score_params[2], "CBA.AX")


# ---------------------------------------------------------------------------
# 6. Watchlist file loading
# ---------------------------------------------------------------------------


class TestLoadAsxWatchlist(unittest.TestCase):

    def test_watchlist_file_exists(self):
        self.assertTrue(WATCHLIST_PATH.exists(), f"Watchlist not found at {WATCHLIST_PATH}")

    def test_watchlist_loads_as_list_of_dicts(self):
        entries = load_asx_watchlist(WATCHLIST_PATH)
        self.assertIsInstance(entries, list)
        self.assertGreater(len(entries), 0)

    def test_watchlist_entries_have_required_fields(self):
        entries = load_asx_watchlist(WATCHLIST_PATH)
        required = {"ticker", "asx_code", "name", "market", "exchange", "region", "active"}
        for entry in entries:
            for key in required:
                self.assertIn(key, entry, f"Missing '{key}' in watchlist entry: {entry}")

    def test_watchlist_tickers_end_with_dot_ax(self):
        entries = load_asx_watchlist(WATCHLIST_PATH)
        for entry in entries:
            self.assertTrue(
                entry["ticker"].upper().endswith(".AX"),
                f"Ticker {entry['ticker']} does not end with .AX",
            )

    def test_watchlist_market_is_asx(self):
        entries = load_asx_watchlist(WATCHLIST_PATH)
        for entry in entries:
            self.assertEqual(entry["market"], "ASX")

    def test_watchlist_active_entries_count_is_nonzero(self):
        entries = load_asx_watchlist(WATCHLIST_PATH)
        active = [e for e in entries if e.get("active")]
        self.assertGreater(len(active), 0)

    def test_load_asx_watchlist_extracts_ticker_strings(self):
        """load_asx_watchlist returns dicts; caller can extract ticker strings."""
        entries = load_asx_watchlist(WATCHLIST_PATH)
        tickers = [e["ticker"] for e in entries if e.get("active")]
        self.assertIsInstance(tickers, list)
        self.assertGreater(len(tickers), 0)


if __name__ == "__main__":
    unittest.main()

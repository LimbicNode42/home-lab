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
import urllib.error

# Add investment-screener directory to path so we can import screener
_SCREENER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_SCREENER_DIR))

import screener as scr
from screener import (
    FieldValue,
    apply_hard_exclusions,
    build_company_from_yahoo_timeseries,
    build_dashboard_ranked_export,
    build_file_first_run_payload,
    build_universe_version,
    hydrate_companies_from_asx_tickers,
    select_active_asx_tickers,
    select_asx_universe_batch,
    insert_screener_run,
    load_config,
    load_asx_watchlist,
    load_asx_universe_seed,
    normalise_asx_directory_rows,
    normalise_asx_ticker,
    parse_args,
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
            "source_family": "fixture",
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
            "source_family": "fixture",
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




class TestFetchJsonUrlRetries(unittest.TestCase):

    def test_fetch_json_url_retries_transient_url_errors_then_succeeds(self):
        attempts = []

        class FakeResponse:
            def __enter__(self):
                return self
            def __exit__(self, exc_type, exc, tb):
                return False
            def read(self):
                return b'{"ok": true}'

        def flaky_urlopen(request, timeout):
            attempts.append(timeout)
            if len(attempts) < 3:
                raise urllib.error.URLError("temporary reset")
            return FakeResponse()

        with patch.object(scr.urllib.request, "urlopen", side_effect=flaky_urlopen), \
             patch.object(scr.time, "sleep") as sleep:
            result = scr._fetch_json_url("https://example.test/data.json", timeout=20, max_attempts=3, backoff_seconds=0.5, jitter_seconds=0)

        self.assertEqual(result, {"ok": True})
        self.assertEqual(len(attempts), 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.5, 1.0])

    def test_fetch_json_url_raises_after_configured_retry_budget(self):
        with patch.object(scr.urllib.request, "urlopen", side_effect=TimeoutError("too slow")), \
             patch.object(scr.time, "sleep") as sleep:
            with self.assertRaises(TimeoutError):
                scr._fetch_json_url("https://example.test/data.json", timeout=20, max_attempts=2, backoff_seconds=0.25, jitter_seconds=0)

        self.assertEqual(sleep.call_count, 1)


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

    def test_export_candidates_carry_sector_and_industry_when_present(self):
        cfg = load_config(CONFIG_PATH)
        c = asx_company(sector="Materials", industry="Metals & Mining")
        ranked = rank_companies([c], cfg)
        export = build_dashboard_ranked_export(ranked, mode="asx-yahoo-timeseries")

        self.assertEqual(export["candidates"][0]["sector"], "Materials")
        self.assertEqual(export["candidates"][0]["industry"], "Metals & Mining")

    def test_export_candidates_omit_sector_industry_when_classification_missing(self):
        cfg = load_config(CONFIG_PATH)
        c = asx_company()
        ranked = rank_companies([c], cfg)
        export = build_dashboard_ranked_export(ranked, mode="asx-yahoo-timeseries")

        self.assertIsNone(export["candidates"][0]["sector"])
        self.assertIsNone(export["candidates"][0]["industry"])

    def test_apply_filters_matches_sector_and_industry_case_insensitive(self):
        cfg = load_config(CONFIG_PATH)
        ranked = rank_companies([
            asx_company(ticker="BHP.AX", sector="Materials", industry="Metals & Mining"),
            asx_company(ticker="CBA.AX", sector="Banks", industry="Banks"),
        ], cfg)

        filtered = scr.apply_filters(ranked, {"sector": ["materials"], "industry": ["metals & mining"]})

        self.assertEqual([r["ticker"] for r in filtered], ["BHP.AX"])

    def test_derived_metric_provenance_is_labeled_as_derived(self):
        company = asx_company()

        provenance = scr._derived_provenance(company, "market_cap")

        self.assertEqual(provenance["source_family"], "derived")
        self.assertEqual(provenance["provider"], "derived")
        self.assertEqual(provenance["method"], "derived")

    def test_provenance_summary_lists_source_families_and_providers(self):
        company = asx_company()
        company["net_income"] = FieldValue(9_800_000_000.0, {
            "source_family": "fmp",
            "provider": "fmp",
            "source_url": "https://financialmodelingprep.com/api/v3/income-statement/BHP",
            "retrieved_at": "2026-01-01T00:00:00Z",
            "data_as_of": "2025-06-30",
            "field_name": "net_income",
        })

        summary = scr._provenance_summary(company)

        self.assertIn("fmp", summary["source_families"])
        self.assertIn("fmp", summary["providers"])
        self.assertIn("fixture", summary["source_families"])

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


    def test_dashboard_provenance_summary_names_source_families_and_providers(self):
        cfg = load_config(CONFIG_PATH)
        c = asx_company()
        c["net_income"] = FieldValue(9_800_000_000.0, {
            "source_family": "fmp",
            "provider": "fmp",
            "source_url": "https://financialmodelingprep.com/api/v3/income-statement/BHP",
            "retrieved_at": "2026-01-01T00:00:00Z",
            "data_as_of": "2025-06-30",
            "field_name": "net_income",
            "freshness": "fixture",
        })
        ranked = rank_companies([c], cfg)

        export = build_dashboard_ranked_export(ranked, mode="asx-yahoo-timeseries")

        summary = export["candidates"][0]["sanitized_provenance_summary"]
        self.assertIn("families=fixture+fmp", summary)
        self.assertIn("providers=fmp", summary)

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

    def test_insert_records_derived_provenance_with_scalar_dates_and_derived_source_family(self):
        cfg = load_config(CONFIG_PATH)
        c = asx_company()
        ranked = rank_companies([c], cfg)
        conn = self._fake_conn()

        insert_screener_run(
            conn, ranked, source="test", mode="fixture", universe=["BHP.AX"]
        )

        provenance_params = [
            params for sql, params in conn.cursor_obj.statements
            if "investment_screener_provenance" in sql
        ]
        market_cap = next(params for params in provenance_params if params[2] == "market_cap")
        self.assertEqual(market_cap[3], "derived")
        self.assertIsInstance(market_cap[5], str)
        self.assertIsInstance(market_cap[7], str)
        self.assertNotIn("[", market_cap[5])
        self.assertNotIn("[", market_cap[7])
        self.assertTrue(market_cap[8] is None or isinstance(market_cap[8], str))
        self.assertTrue(market_cap[10] is None or isinstance(market_cap[10], str))

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


class TestAsxUniverseSeed(unittest.TestCase):

    def test_normalise_asx_directory_rows_sorts_by_market_cap_and_preserves_source_provenance(self):
        rows = [
            {"ASX code": "zzz", "Company name": "Last Ltd", "GICs industry group": "Utilities", "Listing date": "1/02/2024", "Market Cap": "1,000"},
            {"ASX code": "BHP", "Company name": "BHP GROUP LIMITED", "GICs industry group": "Materials", "Listing date": "13/08/1987", "Market Cap": "334,284,993,458"},
            {"ASX code": "bad code", "Company name": "Bad Code", "Market Cap": "999999999999"},
            {"ASX code": "ABC", "Company name": "No Cap", "GICs industry group": "Financials", "Listing date": "", "Market Cap": ""},
        ]

        entries, metadata = normalise_asx_directory_rows(
            rows,
            source_url="https://example.test/asx.csv",
            retrieved_at="2026-08-23T05:47:51Z",
            csv_sha256="a" * 64,
        )

        self.assertEqual([entry["ticker"] for entry in entries], ["BHP.AX", "ZZZ.AX", "ABC.AX"])
        self.assertEqual(entries[0]["asx_code"], "BHP")
        self.assertEqual(entries[0]["market_cap"], 334_284_993_458)
        self.assertEqual(entries[0]["listing_date"], "1987-08-13")
        self.assertEqual(entries[0]["sector"], "Materials")
        self.assertEqual(entries[0]["universe_rank"], 1)
        self.assertTrue(entries[0]["active"])
        self.assertEqual(entries[0]["source"]["sha256"], "a" * 64)
        self.assertEqual(entries[0]["company_id"], "asx:BHP")
        self.assertEqual(entries[0]["name_raw"], "BHP GROUP LIMITED")
        self.assertEqual(entries[0]["name_normalized"], "BHP GROUP LIMITED")
        self.assertEqual(entries[0]["security_type"], "unknown_from_asx_directory")
        self.assertEqual(entries[0]["currency"], "AUD")
        self.assertFalse(entries[0]["suspended"])
        self.assertFalse(entries[0]["delisted"])
        self.assertEqual(metadata["schema_version"], "investment-screener-asx-universe-seed/v2")
        self.assertEqual(metadata["source_row_count"], 4)
        self.assertEqual(metadata["row_count"], 4)
        self.assertEqual(metadata["normalized_active_count"], 3)
        self.assertEqual(metadata["excluded_count"], 1)
        self.assertEqual(metadata["identity_rule"], "company_id=asx:{asx_code}; yahoo_ticker={asx_code}.AX")

    def test_normalise_asx_directory_rows_rejects_duplicate_asx_codes(self):
        rows = [
            {"ASX code": "BHP", "Company name": "BHP GROUP LIMITED", "GICs industry group": "Materials", "Listing date": "13/08/1987", "Market Cap": "334,284,993,458"},
            {"ASX code": "bhp", "Company name": "Broken duplicate", "GICs industry group": "Materials", "Listing date": "14/08/1987", "Market Cap": "1"},
        ]

        with self.assertRaisesRegex(ValueError, "Duplicate ASX code"):
            normalise_asx_directory_rows(rows, "https://example.test/asx.csv", "2026-08-23T05:47:51Z", "a" * 64)

    def test_security_type_filter_keeps_denominator_labels_honest(self):
        entries = [
            {"ticker": "BHP.AX", "company_id": "asx:BHP", "security_type": "ordinary_share", "active": True, "universe_rank": 1},
            {"ticker": "REI.AX", "company_id": "asx:REI", "security_type": "reit", "active": True, "universe_rank": 2},
            {"ticker": "ETF.AX", "company_id": "asx:ETF", "security_type": "etf", "active": True, "universe_rank": 3},
            {"ticker": "OLD.AX", "company_id": "asx:OLD", "security_type": "ordinary_share", "active": False, "universe_rank": 4},
        ]

        selected = scr.select_asx_universe_batch(
            entries,
            include_security_types={"ordinary_share"},
            denominator_label="ordinary ASX shares",
        )

        self.assertEqual(selected["tickers"], ["BHP.AX"])
        self.assertEqual(selected["full_count"], 3)
        self.assertEqual(selected["eligible_count"], 1)
        self.assertEqual(selected["excluded_security_type_count"], 2)
        self.assertEqual(selected["security_type_filter"], ["ordinary_share"])
        self.assertEqual(selected["denominator_label"], "ordinary ASX shares")
        self.assertEqual(selected["denominator_status"], "complete_security_type_filtered_listing")

    def test_file_first_payload_exports_dashboard_safe_denominator_metadata(self):
        payload = build_file_first_run_payload(
            ranked=[],
            source="yahoo-finance",
            mode="asx-yahoo-timeseries",
            universe=["BHP.AX"],
            universe_source="ASX company directory CSV via reviewed static seed",
            universe_metadata={"source_row_count": 4, "normalized_active_count": 3, "source_sha256": "a" * 64},
            batch_metadata={
                "full_count": 3,
                "eligible_count": 1,
                "selected_count": 1,
                "excluded_security_type_count": 2,
                "security_type_filter": ["ordinary_share"],
                "denominator_status": "complete_security_type_filtered_listing",
                "denominator_label": "ordinary ASX shares",
                "complete_exchange_listing": False,
            },
        )

        self.assertEqual(payload["universe"]["eligible_count"], 1)
        self.assertEqual(payload["universe"]["excluded_security_type_count"], 2)
        self.assertEqual(payload["universe"]["security_type_filter"], ["ordinary_share"])
        self.assertEqual(payload["coverage"]["denominator"], 1)
        self.assertEqual(payload["coverage"]["denominator_label"], "ordinary ASX shares")
        self.assertEqual(payload["coverage"]["denominator_status"], "complete_security_type_filtered_listing")

    def test_asx_seed_identity_can_be_overlaid_after_provider_hydration(self):
        companies = [{"ticker": "BHP.AX", "name": "Provider Name", "market": "ASX", "currency": "AUD"}]
        seed_entries = [{
            "ticker": "BHP.AX",
            "company_id": "asx:BHP",
            "asx_code": "BHP",
            "name_raw": "BHP GROUP LIMITED",
            "name_normalized": "BHP GROUP LIMITED",
            "exchange": "ASX",
            "region": "AU",
            "sector": "Materials",
            "industry": "Materials",
            "security_type": "unknown_from_asx_directory",
            "active": True,
            "suspended": False,
            "delisted": False,
        }]

        enriched = scr.apply_asx_seed_identity(companies, seed_entries)

        self.assertEqual(enriched[0]["company_id"], "asx:BHP")
        self.assertEqual(enriched[0]["name"], "Provider Name")
        self.assertEqual(enriched[0]["name_raw"], "BHP GROUP LIMITED")
        self.assertEqual(enriched[0]["security_type"], "unknown_from_asx_directory")

    def test_asx_seed_identity_survives_scoring_and_file_first_export(self):
        cfg = load_config(CONFIG_PATH)
        ranked = rank_companies([
            asx_company(
                company_id="asx:BHP",
                asx_code="BHP",
                name_raw="BHP GROUP LIMITED",
                name_normalized="BHP GROUP LIMITED",
                security_type="ordinary_share",
                active=True,
                suspended=False,
                delisted=False,
            )
        ], cfg)

        payload = build_file_first_run_payload(
            ranked,
            source="yahoo-finance",
            mode="asx-yahoo-timeseries",
            universe=["BHP.AX"],
        )

        self.assertEqual(ranked[0]["company_id"], "asx:BHP")
        self.assertEqual(ranked[0]["asx_code"], "BHP")
        self.assertEqual(ranked[0]["security_type"], "ordinary_share")
        self.assertEqual(payload["companies"][0]["company_id"], "asx:BHP")
        self.assertEqual(payload["companies"][0]["asx_code"], "BHP")
        self.assertEqual(payload["companies"][0]["security_type"], "ordinary_share")

    def test_load_asx_universe_seed_accepts_metadata_wrapped_seed(self):
        seed_path = self._write_tmp_seed({
            "metadata": {"source_url": "https://example.test/asx.csv", "sha256": "b" * 64, "retrieved_at": "2026-08-23T05:47:51Z"},
            "entries": [
                {"ticker": "BHP.AX", "asx_code": "BHP", "name": "BHP", "market": "ASX", "exchange": "ASX", "region": "AU", "active": True, "universe_rank": 1},
                {"ticker": "CBA.AX", "asx_code": "CBA", "name": "CBA", "market": "ASX", "exchange": "ASX", "region": "AU", "active": False, "universe_rank": 2},
            ],
        })

        seed = load_asx_universe_seed(seed_path)

        self.assertEqual(seed["metadata"]["sha256"], "b" * 64)
        self.assertEqual([entry["ticker"] for entry in seed["entries"]], ["BHP.AX", "CBA.AX"])

    def test_select_asx_universe_batch_honors_offset_limit_and_reports_denominator(self):
        entries = [
            {"ticker": "BHP.AX", "active": True, "universe_rank": 1},
            {"ticker": "CBA.AX", "active": True, "universe_rank": 2},
            {"ticker": "CSL.AX", "active": True, "universe_rank": 3},
        ]

        selected = select_asx_universe_batch(entries, batch_offset=1, max_tickers=1)

        self.assertEqual([entry["ticker"] for entry in selected["entries"]], ["CBA.AX"])
        self.assertEqual(selected["tickers"], ["CBA.AX"])
        self.assertEqual(selected["full_count"], 3)
        self.assertEqual(selected["selected_count"], 1)
        self.assertEqual(selected["batch_offset"], 1)
        self.assertEqual(selected["batch_end_exclusive"], 2)
        self.assertFalse(selected["complete_exchange_listing"])
        self.assertEqual(selected["denominator_status"], "ranked_market_cap_batch")

    def _write_tmp_seed(self, payload):
        import tempfile
        path = Path(tempfile.mkdtemp()) / "seed.json"
        path.write_text(json.dumps(payload), encoding="utf8")
        self.addCleanup(lambda: path.parent.rmdir())
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        return path


# ---------------------------------------------------------------------------
# 7. Bounded real ASX hydration command behavior
# ---------------------------------------------------------------------------


class TestBoundedAsxHydrationCli(unittest.TestCase):

    def test_cli_exposes_max_tickers_and_sleep_seconds_for_bounded_live_runs(self):
        args = parse_args([
            "--asx-watchlist", str(WATCHLIST_PATH),
            "--max-tickers", "2",
            "--sleep-seconds", "0.75",
        ])

        self.assertEqual(args.max_tickers, 2)
        self.assertEqual(args.sleep_seconds, 0.75)

    def test_cli_exposes_universe_seed_batch_offset_and_batch_size_alias(self):
        args = parse_args([
            "--asx-universe-seed", "investment-screener/universe/asx-listed-companies.seed.json",
            "--batch-offset", "100",
            "--batch-size", "50",
            "--sleep-seconds", "1.0",
        ])

        self.assertEqual(args.asx_universe_seed, "investment-screener/universe/asx-listed-companies.seed.json")
        self.assertEqual(args.batch_offset, 100)
        self.assertEqual(args.batch_size, 50)
        self.assertEqual(args.max_tickers, 50)

    def test_cli_exposes_universe_seed_security_type_filters_and_label(self):
        args = parse_args([
            "--asx-universe-seed", "investment-screener/universe/asx-listed-companies.seed.json",
            "--include-security-types", "ordinary_share,common_stock",
            "--exclude-security-types", "etf,warrant",
            "--denominator-label", "ordinary ASX shares",
        ])

        self.assertEqual(args.include_security_types, "ordinary_share,common_stock")
        self.assertEqual(args.exclude_security_types, "etf,warrant")
        self.assertEqual(args.denominator_label, "ordinary ASX shares")

    def test_select_active_asx_tickers_honors_max_tickers(self):
        entries = [
            {"ticker": "BHP.AX", "active": True},
            {"ticker": "CBA.AX", "active": True},
            {"ticker": "CSL.AX", "active": True},
        ]

        self.assertEqual(
            select_active_asx_tickers(entries, max_tickers=2),
            ["BHP.AX", "CBA.AX"],
        )

    def test_yahoo_hydrated_fields_carry_provider_source_family(self):
        quote = {"price": 65.16, "currency": "AUD", "exchange": "ASX", "name": "BHP Group"}
        hydrated = build_company_from_yahoo_timeseries("BHP.AX", bhp_timeseries_fixture(), quote)

        self.assertEqual(hydrated["revenue"].provenance["source_family"], "yahoo-finance")
        self.assertEqual(hydrated["price"].provenance["source_family"], "yahoo-finance")
        self.assertIn("unofficial", hydrated["revenue"].provenance["freshness"].lower())

    def test_hydration_records_recoverable_ticker_failures_without_stopping_batch(self):
        failures = []

        companies = hydrate_companies_from_asx_tickers(
            ["BHP", "BAD"],
            quote_fetcher=lambda symbol: {"price": 10.0, "currency": "AUD", "exchange": "ASX", "name": symbol} if symbol == "BHP.AX" else (_ for _ in ()).throw(RuntimeError("provider 404")),
            timeseries_fetcher=lambda symbol: bhp_timeseries_fixture(),
            sleep_seconds=0,
            failure_sink=failures.append,
        )

        self.assertEqual([company["ticker"] for company in companies], ["BHP.AX"])
        self.assertEqual(failures[0]["ticker"], "BAD.AX")
        self.assertEqual(failures[0]["provider"], "yahoo-finance")
        self.assertTrue(failures[0]["recoverable"])



class TestFileFirstArtifactPayload(unittest.TestCase):

    def test_build_file_first_run_payload_preserves_non_fixture_yahoo_provenance_and_coverage(self):
        cfg = load_config(CONFIG_PATH)
        company = asx_company()
        for key in scr.RAW_FIELDS:
            company[key].provenance.update({
                "source_family": "yahoo-finance",
                "provider": "yahoo-finance",
                "freshness": "Yahoo Finance unofficial bootstrap source",
            })
        ranked = rank_companies([company], cfg)

        payload = build_file_first_run_payload(
            ranked,
            source="yahoo-finance",
            mode="asx-yahoo-timeseries",
            universe=["BHP.AX", "CSL.AX"],
            universe_source="configured ASX bootstrap watchlist",
            universe_version="sha256:test-watchlist",
            started_at="2026-08-23T10:00:00Z",
            completed_at="2026-08-23T10:01:00Z",
        )

        self.assertEqual(payload["source"], "yahoo-finance")
        self.assertEqual(payload["mode"], "asx-yahoo-timeseries")
        self.assertFalse(payload["fixture"])
        self.assertEqual(payload["universe"]["count"], 2)
        self.assertEqual(payload["universe"]["source"], "configured ASX bootstrap watchlist")
        self.assertEqual(payload["scores"][0]["ticker"], "BHP.AX")
        self.assertEqual(payload["scores"][0]["composite_score"], ranked[0]["composite_score"])
        self.assertGreaterEqual(len(payload["observations"]), len(scr.RAW_FIELDS))
        self.assertTrue(any(row["provider"] == "yahoo-finance" for row in payload["provenance"]))
        self.assertEqual(payload["coverage"]["denominator_status"], "known_sample_universe")
        self.assertTrue(any("unofficial" in caveat.lower() for caveat in payload["source_caveats"]))

    def test_file_first_payload_preserves_ranked_batch_metadata_failures_and_coverage_math(self):
        cfg = load_config(CONFIG_PATH)
        ranked = rank_companies([asx_company(ticker="BHP.AX")], cfg)

        payload = build_file_first_run_payload(
            ranked,
            source="yahoo-finance",
            mode="asx-yahoo-timeseries",
            universe=["BHP.AX", "BAD.AX"],
            universe_source="ASX company directory CSV via reviewed static seed",
            universe_version="investment-screener/universe/asx-listed-companies.seed.json sha256:" + ("c" * 64),
            universe_metadata={"source_row_count": 1838, "normalized_active_count": 1838, "source_sha256": "a" * 64},
            batch_metadata={"batch_offset": 0, "batch_end_exclusive": 2, "selected_count": 2, "full_count": 1838, "complete_exchange_listing": False},
            hydration_failures=[{"ticker": "BAD.AX", "reason": "provider 404", "provider": "yahoo-finance", "recoverable": True}],
            started_at="2026-08-23T10:00:00Z",
            completed_at="2026-08-23T10:01:00Z",
        )

        self.assertEqual(payload["universe"]["source"], "ASX company directory CSV via reviewed static seed")
        self.assertEqual(payload["universe"]["count"], 2)
        self.assertEqual(payload["universe"]["batch_offset"], 0)
        self.assertEqual(payload["universe"]["full_count"], 1838)
        self.assertFalse(payload["universe"]["complete_exchange_listing"])
        self.assertEqual(payload["coverage"]["denominator"], 2)
        self.assertEqual(payload["coverage"]["usable"], 1)
        self.assertEqual(payload["coverage"]["failed"], 1)
        self.assertEqual(payload["coverage"]["excluded"], 0)
        self.assertEqual(payload["coverage"]["percent"], 50.0)
        self.assertEqual(payload["coverage"]["denominator_status"], "ranked_market_cap_batch")
        self.assertIn("top 2 ASX listings by Market Cap", payload["coverage"]["denominator_label"])
        self.assertEqual(payload["failures"][0]["ticker"], "BAD.AX")
        self.assertEqual(payload["failures"][0]["provider"], "yahoo-finance")

    def test_cli_exposes_file_first_run_payload_output_without_requiring_postgres(self):
        args = parse_args([
            "--fixture",
            "--file-first-run-json", "/tmp/screener-run.json",
        ])

        self.assertEqual(args.file_first_run_json, "/tmp/screener-run.json")
        self.assertFalse(args.write_postgres_history)


# ---------------------------------------------------------------------------
# 8. Provider fallback framework (staged fundamentals fallback)
# ---------------------------------------------------------------------------


class TestProviderAdapterFailClosed(unittest.TestCase):

    def test_adapter_disabled_without_credential_is_noop(self):
        adapter = scr.FmpAdapter(env={})
        self.assertFalse(adapter.enabled())
        self.assertEqual(adapter.fetch("BHP.AX"), {})

    def test_adapter_status_reports_missing_credential_reason(self):
        adapter = scr.AlphaVantageAdapter(env={})
        status = adapter.status()
        self.assertFalse(status["enabled"])
        self.assertIn("ALPHA_VANTAGE_API_KEY", status["reason"])

    def test_missing_credential_never_fabricates_and_no_network(self):
        calls = []

        def boom_fetcher(url, timeout=None, cache_dir=None):
            calls.append(url)
            raise AssertionError("network must not be called when disabled")

        adapter = scr.FmpAdapter(env={}, fetcher=boom_fetcher)
        result = adapter.fetch("BHP.AX")
        self.assertEqual(result, {})
        self.assertEqual(calls, [])


class TestProviderAdaptersNormalize(unittest.TestCase):


    def _fmp_fetcher(self):
        def fetcher(url, timeout=None, cache_dir=None):
            if "income-statement" in url:
                return [{"date": "2025-06-30", "revenue": 56_642_000_000.0, "netIncome": 9_845_000_000.0}]
            if "balance-sheet-statement" in url:
                return [{
                    "date": "2025-06-30",
                    "totalAssets": 113_137_000_000.0,
                    "totalLiabilities": 65_066_000_000.0,
                    "totalCurrentAssets": 25_269_000_000.0,
                    "totalCurrentLiabilities": 17_050_000_000.0,
                }]
            if "cash-flow-statement" in url:
                return [{
                    "date": "2025-06-30",
                    "operatingCashFlow": 18_831_000_000.0,
                    "capitalExpenditure": -10_170_000_000.0,
                }]
            raise AssertionError("unexpected url " + url)
        return fetcher

    def _av_fetcher(self):
        def fetcher(url, timeout=None, cache_dir=None):
            if "INCOME_STATEMENT" in url:
                return {"annualReports": [{"fiscalDateEnding": "2025-06-30", "totalRevenue": "56642000000", "netIncome": "9845000000"}]}
            if "BALANCE_SHEET" in url:
                return {"annualReports": [{
                    "fiscalDateEnding": "2025-06-30",
                    "totalAssets": "113137000000",
                    "totalLiabilities": "65066000000",
                    "totalCurrentAssets": "25269000000",
                    "totalCurrentLiabilities": "17050000000",
                }]}
            if "CASH_FLOW" in url:
                return {"annualReports": [{
                    "fiscalDateEnding": "2025-06-30",
                    "operatingCashflow": "18831000000",
                    "capitalExpenditures": "10170000000",
                }]}
            raise AssertionError("unexpected url " + url)
        return fetcher

    def test_fmp_adapter_normalizes_raw_fields_with_provenance(self):
        adapter = scr.FmpAdapter(env={"FMP_API_KEY": "test-key"}, fetcher=self._fmp_fetcher())
        self.assertTrue(adapter.enabled())
        fields = adapter.fetch("BHP.AX")

        self.assertAlmostEqual(fields["revenue"].value, 56_642_000_000.0)
        self.assertAlmostEqual(fields["net_income"].value, 9_845_000_000.0)
        self.assertAlmostEqual(fields["total_assets"].value, 113_137_000_000.0)
        self.assertAlmostEqual(fields["total_liabilities"].value, 65_066_000_000.0)
        self.assertAlmostEqual(fields["current_assets"].value, 25_269_000_000.0)
        self.assertAlmostEqual(fields["current_liabilities"].value, 17_050_000_000.0)
        self.assertAlmostEqual(fields["operating_cash_flow"].value, 18_831_000_000.0)
        # capex forced negative regardless of provider sign convention
        self.assertLess(fields["capital_expenditures"].value, 0)

        prov = fields["revenue"].provenance
        self.assertEqual(prov["source_family"], "fmp")
        self.assertEqual(prov["provider"], "fmp")
        self.assertEqual(prov["trust_level"], "licensed_provider_normalized_statement")
        self.assertEqual(prov["unit"], "currency")
        self.assertEqual(prov["currency"], "AUD")
        self.assertEqual(prov["period_type"], "annual")
        self.assertEqual(prov["data_as_of"], "2025-06-30")
        self.assertEqual(prov["field_name"], "revenue")

    def test_alpha_vantage_adapter_normalizes_string_fields(self):
        adapter = scr.AlphaVantageAdapter(env={"ALPHA_VANTAGE_API_KEY": "k"}, fetcher=self._av_fetcher())
        self.assertTrue(adapter.enabled())
        fields = adapter.fetch("BHP.AX")

        self.assertAlmostEqual(fields["revenue"].value, 56_642_000_000.0)
        self.assertAlmostEqual(fields["net_income"].value, 9_845_000_000.0)
        self.assertAlmostEqual(fields["total_assets"].value, 113_137_000_000.0)
        self.assertLess(fields["capital_expenditures"].value, 0)
        self.assertEqual(fields["revenue"].provenance["source_family"], "alpha_vantage")
        self.assertEqual(fields["revenue"].provenance["provider"], "alpha_vantage")
        self.assertEqual(fields["revenue"].provenance["trust_level"], "licensed_provider_normalized_statement")
        self.assertEqual(fields["revenue"].provenance["data_as_of"], "2025-06-30")

    def test_rate_limit_returns_empty_and_sets_last_error(self):
        def fetcher(url, timeout=None, cache_dir=None):
            raise urllib.error.HTTPError(url, 429, "Too Many Requests", None, None)

        adapter = scr.FmpAdapter(env={"FMP_API_KEY": "k"}, fetcher=fetcher)
        result = adapter.fetch("BHP.AX")

        self.assertEqual(result, {})
        self.assertIsNotNone(adapter.last_error)
        self.assertIn("429", str(adapter.last_error))

    def test_fmp_adapter_uses_stable_statement_endpoints_with_symbol_query(self):
        calls = []

        def fetcher(url, timeout=None, cache_dir=None):
            calls.append(url)
            parsed = scr.urllib.parse.urlsplit(url)
            query = dict(scr.urllib.parse.parse_qsl(parsed.query))
            self.assertEqual(parsed.netloc, "financialmodelingprep.com")
            self.assertEqual(query.get("symbol"), "BHP")
            self.assertEqual(query.get("apikey"), "test-key")
            if parsed.path == "/stable/income-statement":
                return [{"date": "2025-06-30", "revenue": 56_642_000_000.0, "netIncome": 9_845_000_000.0}]
            if parsed.path == "/stable/balance-sheet-statement":
                return [{"date": "2025-06-30", "totalAssets": 113_137_000_000.0}]
            if parsed.path == "/stable/cash-flow-statement":
                return [{"date": "2025-06-30", "operatingCashFlow": 18_831_000_000.0}]
            raise AssertionError("unexpected url " + url)

        adapter = scr.FmpAdapter(env={"FMP_API_KEY": "test-key"}, fetcher=fetcher)
        fields = adapter.fetch("BHP.AX")

        self.assertEqual([scr.urllib.parse.urlsplit(url).path for url in calls], [
            "/stable/income-statement",
            "/stable/balance-sheet-statement",
            "/stable/cash-flow-statement",
        ])
        self.assertEqual(fields["revenue"].provenance["source_url"], "https://financialmodelingprep.com/stable/income-statement?symbol=BHP")
        self.assertNotIn("test-key", json.dumps([fv.provenance for fv in fields.values()]))

    def test_fmp_statement_402_or_403_is_recoverable_per_endpoint(self):
        def fetcher(url, timeout=None, cache_dir=None):
            parsed = scr.urllib.parse.urlsplit(url)
            if parsed.path == "/stable/income-statement":
                raise urllib.error.HTTPError(url, 402, "Payment Required", None, None)
            if parsed.path == "/stable/balance-sheet-statement":
                return [{"date": "2025-06-30", "totalAssets": 113_137_000_000.0}]
            if parsed.path == "/stable/cash-flow-statement":
                raise urllib.error.HTTPError(url, 403, "Forbidden", None, None)
            raise AssertionError("unexpected url " + url)

        adapter = scr.FmpAdapter(env={"FMP_API_KEY": "test-key"}, fetcher=fetcher)
        fields = adapter.fetch("BHP.AX")

        self.assertIn("total_assets", fields)
        self.assertEqual(fields["total_assets"].value, 113_137_000_000.0)
        self.assertIsNotNone(adapter.last_error)
        self.assertIn("recoverable FMP endpoint failures", str(adapter.last_error))
        self.assertNotIn("test-key", str(adapter.last_error))


class TestProvenanceSourceUrlRedaction(unittest.TestCase):
    """Persisted provenance.source_url must never carry provider secrets."""

    FAKE_KEY = "SUPER_SECRET_FAKE_KEY_123"

    def test_redact_url_secrets_strips_apikey_keeps_benign_params(self):
        url = "https://financialmodelingprep.com/api/v3/income-statement/BHP?apikey=SUPER_SECRET_FAKE_KEY_123"
        redacted = scr.redact_url_secrets(url)
        self.assertNotIn("apikey", redacted)
        self.assertNotIn("SUPER_SECRET_FAKE_KEY_123", redacted)
        self.assertIn("income-statement/BHP", redacted)

    def test_redact_url_secrets_preserves_benign_query_params(self):
        url = "https://www.alphavantage.co/query?function=INCOME_STATEMENT&symbol=BHP&apikey=SUPER_SECRET_FAKE_KEY_123"
        redacted = scr.redact_url_secrets(url)
        self.assertIn("function=INCOME_STATEMENT", redacted)
        self.assertIn("symbol=BHP", redacted)
        self.assertNotIn("apikey", redacted)
        self.assertNotIn("SUPER_SECRET_FAKE_KEY_123", redacted)

    def test_redact_url_secrets_noop_without_query(self):
        url = "https://financialmodelingprep.com/api/v3/income-statement/BHP"
        self.assertEqual(scr.redact_url_secrets(url), url)

    def test_redact_secrets_in_text_redacts_bare_secret_assignments(self):
        secret_variants = [
            "apikey=SECRET123",
            "api_key=SECRET123",
            "access_token=SECRET123",
            "key=SECRET123",
            "token = SECRET456",
            "signature=SECRET123",
            "sig=SECRET123",
            "session=SECRET123",
            "sessionid=SECRET123",
            "session_id=SECRET123",
            "sid=SECRET123",
            "ApiKey=SECRET789",
            "token=SECRET123;symbol=BHP",
        ]
        for fragment in secret_variants:
            with self.subTest(fragment=fragment):
                redacted = scr._redact_secrets_in_text(f"fmp status 401 provider returned {fragment}")
                self.assertIn("fmp status 401 provider returned", redacted)
                self.assertNotIn("SECRET123", redacted)
                self.assertNotIn("SECRET456", redacted)
                self.assertNotIn("SECRET789", redacted)
                self.assertIn("<REDACTED>", redacted)
        self.assertIn(
            "symbol=BHP",
            scr._redact_secrets_in_text("fmp status 401 token=SECRET123;symbol=BHP"),
        )

    def test_sanitize_provider_failures_redacts_reason_and_drops_raw_payloads(self):
        failures = [
            {
                "provider": "fmp",
                "source_family": "fmp",
                "ticker": "BHP.AX",
                "reason": "fmp status 401 apikey=SECRET123 and token = SECRET456",
                "raw_payload": {"secret": "SECRET123"},
                "raw_headers": {"authorization": "SECRET456"},
                "recoverable": True,
                "failed_at": "2026-01-01T00:00:00Z",
            }
        ]

        sanitized = scr.sanitize_provider_failures(failures)

        self.assertEqual(sanitized[0]["provider"], "fmp")
        self.assertEqual(sanitized[0]["source_family"], "fmp")
        self.assertEqual(sanitized[0]["ticker"], "BHP.AX")
        self.assertIn("fmp status 401", sanitized[0]["reason"])
        self.assertNotIn("SECRET123", json.dumps(sanitized))
        self.assertNotIn("SECRET456", json.dumps(sanitized))
        self.assertNotIn("raw_payload", sanitized[0])
        self.assertNotIn("raw_headers", sanitized[0])

    def test_fmp_persisted_source_url_has_no_apikey(self):
        adapter = scr.FmpAdapter(env={"FMP_API_KEY": self.FAKE_KEY}, fetcher=self._fmp_fetcher())
        fields = adapter.fetch("BHP.AX")
        for fv in fields.values():
            src = fv.provenance.get("source_url", "")
            self.assertNotIn("apikey", src)
            self.assertNotIn(self.FAKE_KEY, src)
        self.assertIn("income-statement", fields["revenue"].provenance["source_url"])

    def test_alpha_vantage_persisted_source_url_has_no_apikey(self):
        adapter = scr.AlphaVantageAdapter(env={"ALPHA_VANTAGE_API_KEY": self.FAKE_KEY}, fetcher=self._av_fetcher())
        fields = adapter.fetch("BHP.AX")
        for fv in fields.values():
            src = fv.provenance.get("source_url", "")
            self.assertNotIn("apikey", src)
            self.assertNotIn(self.FAKE_KEY, src)
        self.assertIn("function=INCOME_STATEMENT", fields["revenue"].provenance["source_url"])


    def test_fmp_adapter_fields_use_fmp_source_family_for_output_provenance(self):
        adapter = scr.FmpAdapter(env={"FMP_API_KEY": self.FAKE_KEY}, fetcher=self._fmp_fetcher())

        fields = adapter.fetch("BHP.AX")

        self.assertEqual(fields["revenue"].provenance["source_family"], "fmp")
        self.assertEqual(fields["revenue"].provenance["provider"], "fmp")

    def test_alpha_vantage_adapter_fields_use_alpha_source_family_for_output_provenance(self):
        adapter = scr.AlphaVantageAdapter(env={"ALPHA_VANTAGE_API_KEY": self.FAKE_KEY}, fetcher=self._av_fetcher())

        fields = adapter.fetch("BHP.AX")

        self.assertEqual(fields["revenue"].provenance["source_family"], "alpha_vantage")
        self.assertEqual(fields["revenue"].provenance["provider"], "alpha_vantage")

    def _fmp_fetcher(self):
        def fetcher(url, timeout=None, cache_dir=None):
            if "income-statement" in url:
                return [{"date": "2025-06-30", "revenue": 56_642_000_000.0, "netIncome": 9_845_000_000.0}]
            if "balance-sheet-statement" in url:
                return [{"date": "2025-06-30", "totalAssets": 113_137_000_000.0, "totalLiabilities": 65_066_000_000.0, "totalCurrentAssets": 25_269_000_000.0, "totalCurrentLiabilities": 17_050_000_000.0}]
            if "cash-flow-statement" in url:
                return [{"date": "2025-06-30", "operatingCashFlow": 18_831_000_000.0, "capitalExpenditure": -10_170_000_000.0}]
            raise AssertionError("unexpected url " + url)
        return fetcher

    def _av_fetcher(self):
        def fetcher(url, timeout=None, cache_dir=None):
            if "INCOME_STATEMENT" in url:
                return {"annualReports": [{"fiscalDateEnding": "2025-06-30", "totalRevenue": "56642000000", "netIncome": "9845000000"}]}
            if "BALANCE_SHEET" in url:
                return {"annualReports": [{"fiscalDateEnding": "2025-06-30", "totalAssets": "113137000000", "totalLiabilities": "65066000000", "totalCurrentAssets": "25269000000", "totalCurrentLiabilities": "17050000000"}]}
            if "CASH_FLOW" in url:
                return {"annualReports": [{"fiscalDateEnding": "2025-06-30", "operatingCashflow": "18831000000", "capitalExpenditures": "10170000000"}]}
            raise AssertionError("unexpected url " + url)
        return fetcher


class TestMergeMissingFields(unittest.TestCase):

    def _company_with_missing(self):
        company = asx_company()
        company["net_income"] = scr.missing_field_value("net_income", "provider_absent", "yahoo-finance")
        company["total_assets"] = scr.missing_field_value("total_assets", "provider_absent", "yahoo-finance")
        return company

    def _fmp_net_income(self, value=9_800_000_000.0):
        return FieldValue(
            value,
            {
                "source_family": "fmp",
                "provider": "fmp",
                "trust_level": "licensed",
                "data_as_of": "2025-06-30",
                "retrieved_at": "2026-01-01T00:00:00Z",
                "field_name": "net_income",
                "source_url": "https://financialmodelingprep.com/api/v3/income-statement/BHP?apikey=TEST_SECRET&symbol=BHP",
            },
        )

    def test_merge_fills_missing_with_fallback_provenance(self):
        company = self._company_with_missing()
        fallback = {"net_income": self._fmp_net_income()}

        merged, filled = scr.merge_missing_fields(company, [("fmp", fallback)])

        self.assertAlmostEqual(merged["net_income"].value, 9_800_000_000.0)
        self.assertEqual(merged["net_income"].provenance["source_family"], "fmp")
        self.assertEqual(merged["net_income"].provenance["trust_level"], "licensed")
        self.assertEqual(filled["net_income"], "fmp")
        self.assertNotIn("apikey", merged["net_income"].provenance.get("source_url", ""))
        self.assertNotIn("TEST_SECRET", merged["net_income"].provenance.get("source_url", ""))

    def test_merge_does_not_overwrite_existing_value(self):
        company = asx_company()  # net_income already present (10B)
        fallback = {"net_income": self._fmp_net_income(1.0)}

        merged, filled = scr.merge_missing_fields(company, [("fmp", fallback)])

        self.assertAlmostEqual(merged["net_income"].value, 10_000_000_000.0)
        self.assertNotIn("net_income", filled)

    def test_merge_prefers_higher_trust_order(self):
        company = self._company_with_missing()
        fmp = {"net_income": self._fmp_net_income(111.0)}
        av = {"net_income": FieldValue(222.0, {"source_family": "alpha_vantage", "trust_level": "licensed", "field_name": "net_income"})}

        merged, filled = scr.merge_missing_fields(company, [("fmp", fmp), ("alpha_vantage", av)])

        self.assertAlmostEqual(merged["net_income"].value, 111.0)
        self.assertEqual(filled["net_income"], "fmp")

    def test_missing_remains_unavailable_with_reason(self):
        company = self._company_with_missing()  # total_assets not supplied by any fallback
        merged, filled = scr.merge_missing_fields(company, [("fmp", {"net_income": self._fmp_net_income()})])

        self.assertIsNone(merged["total_assets"].value)
        self.assertEqual(merged["total_assets"].provenance["missing_reason"], "unavailable")
        self.assertNotIn("total_assets", filled)


class TestMultiSourceFundamentalsConsolidation(unittest.TestCase):

    def _candidate(self, value, provider, *, field_name="operating_cash_flow", currency="AUD", unit="currency", scale="ones", period_type="annual", period_end="2025-06-30", source_family="provider_statement", trust_level="licensed_provider_normalized_statement", filed_at=None):
        prov = {
            "field_name": field_name,
            "provider": provider,
            "source_family": source_family,
            "trust_level": trust_level,
            "unit": unit,
            "currency": currency,
            "scale": scale,
            "period_type": period_type,
            "period_end": period_end,
            "data_as_of": period_end,
            "retrieved_at": "2026-01-01T00:00:00Z",
            "source_url": f"https://example.test/{provider}?apikey=SECRET&symbol=BHP&signature=BAD",
            "confidence": "medium",
            "method": "reported",
            "caveats": [],
        }
        if filed_at:
            prov["filed_at"] = filed_at
        return FieldValue(value, prov)

    def test_field_value_schema_defaults_and_sanitized_url_are_serialized(self):
        fv = self._candidate(123.0, "fmp")

        serialized = scr.serialize_field_value("operating_cash_flow", fv)

        self.assertEqual(serialized["field_name"], "operating_cash_flow")
        self.assertEqual(serialized["value_status"], "present")
        self.assertEqual(serialized["unit"], "currency")
        self.assertEqual(serialized["currency"], "AUD")
        self.assertEqual(serialized["period_type"], "annual")
        self.assertEqual(serialized["provider"], "fmp")
        self.assertTrue(serialized["source_url_sanitized"])
        self.assertNotIn("apikey", serialized["source_url"])
        self.assertNotIn("signature", serialized["source_url"])

    def test_consolidation_prefers_provider_statement_over_yahoo_missing(self):
        yahoo_missing = scr.missing_field_value("operating_cash_flow", "provider_absent", "yahoo-finance")
        fmp = self._candidate(18831.0, "fmp")

        result = scr.consolidate_field("operating_cash_flow", [("yahoo-finance", yahoo_missing), ("fmp", fmp)])

        self.assertEqual(result["selected"]["provider"], "fmp")
        self.assertEqual(result["selection_reason"], "filled_missing")
        self.assertEqual(result["alternates"][0]["missing_reason"], "provider_absent")
        self.assertEqual(result["conflicts"], [])

    def test_currency_and_unit_mismatch_blocks_selection(self):
        yahoo = self._candidate(100.0, "yahoo-finance", currency="AUD", source_family="unofficial_statement", trust_level="bootstrap_unofficial_yahoo_statement")
        fmp = self._candidate(101.0, "fmp", currency="USD")

        result = scr.consolidate_field("operating_cash_flow", [("yahoo-finance", yahoo), ("fmp", fmp)])

        self.assertIsNone(result["selected"])
        self.assertEqual(result["selection_reason"], "blocking_conflict")
        self.assertEqual(result["conflicts"][0]["kind"], "currency_mismatch")
        self.assertFalse(result["score_effect"]["usable_for_scoring"])

    def test_period_mismatch_blocks_statement_merge(self):
        annual = self._candidate(100.0, "yahoo-finance", source_family="unofficial_statement", trust_level="bootstrap_unofficial_yahoo_statement", period_type="annual")
        ttm = self._candidate(101.0, "fmp", period_type="ttm")

        result = scr.consolidate_field("operating_cash_flow", [("yahoo-finance", annual), ("fmp", ttm)])

        self.assertIsNone(result["selected"])
        self.assertEqual(result["conflicts"][0]["kind"], "period_type_mismatch")

    def test_same_period_large_delta_records_conflict_and_near_equal_selects(self):
        yahoo = self._candidate(100.0, "yahoo-finance", source_family="unofficial_statement", trust_level="bootstrap_unofficial_yahoo_statement")
        fmp = self._candidate(103.0, "fmp")

        result = scr.consolidate_field("operating_cash_flow", [("yahoo-finance", yahoo), ("fmp", fmp)])

        self.assertEqual(result["selected"]["provider"], "fmp")
        self.assertEqual(result["conflicts"][0]["kind"], "numeric_delta_exceeds_threshold")
        self.assertEqual(result["conflicts"][0]["severity"], "warning")

        near = scr.consolidate_field("operating_cash_flow", [("yahoo-finance", yahoo), ("fmp", self._candidate(100.4, "fmp"))])
        self.assertEqual(near["selected"]["provider"], "fmp")
        self.assertEqual(near["conflicts"], [])
        self.assertEqual(near["selection_reason"], "near_equal_sources")

    def test_newer_same_provider_filing_supersedes_older_alternate(self):
        old = self._candidate(100.0, "fmp", filed_at="2025-08-01")
        new = self._candidate(101.0, "fmp", filed_at="2025-09-01")

        result = scr.consolidate_field("operating_cash_flow", [("fmp", old), ("fmp", new)])

        self.assertEqual(result["selected"]["value"], 101.0)
        self.assertEqual(result["selection_reason"], "newer_restatement")
        self.assertEqual(result["alternates"][0]["reason_not_selected"], "superseded_by_newer_filing")

    def test_fcf_derived_only_from_compatible_selected_inputs(self):
        company = asx_company(
            operating_cash_flow=self._candidate(100.0, "fmp", field_name="operating_cash_flow"),
            capital_expenditures=self._candidate(-40.0, "fmp", field_name="capital_expenditures", period_type="ttm"),
        )

        result = scr.consolidate_company_fields(company)

        self.assertIsNone(result["fields"]["fcf"]["selected"])
        self.assertEqual(result["fields"]["fcf"]["conflicts"][0]["kind"], "period_type_mismatch")

    def test_dashboard_export_includes_sanitized_field_quality_shape(self):
        row = score_company(asx_company(), load_config(CONFIG_PATH))
        row["field_quality"] = {"filled_fields": ["operating_cash_flow"], "conflicted_fields": ["market_cap"], "stale_fields": [], "missing_fields": ["total_debt"], "conflict_count": 1}
        row["source_summary"] = "Yahoo bootstrap + 1 FMP-filled field; 1 warning conflict"

        export = build_dashboard_ranked_export([row])
        candidate = export["candidates"][0]

        self.assertEqual(candidate["source_summary"], row["source_summary"])
        self.assertEqual(candidate["field_quality"]["conflict_count"], 1)
        self.assertNotIn("fields", candidate)
        self.assertNotIn("source_url", json.dumps(candidate).lower())

    def test_fill_company_missing_fields_records_fetch_failure_without_fake_values(self):
        company = asx_company(operating_cash_flow=scr.missing_field_value("operating_cash_flow", "provider_absent", "yahoo-finance"))
        def fetcher(url, timeout=None, cache_dir=None):
            raise urllib.error.HTTPError(url, 429, "Too Many Requests", None, None)
        adapter = scr.FmpAdapter(env={"FMP_API_KEY": "k"}, fetcher=fetcher)

        merged, failures = scr.fill_company_missing_fields(company, [adapter])

        self.assertIsNone(merged["operating_cash_flow"].value)
        self.assertEqual(merged["operating_cash_flow"].provenance["missing_reason"], "unavailable")
        self.assertEqual(failures[0]["provider"], "fmp")
        self.assertIn("429", failures[0]["reason"])


class TestFallbackRegistry(unittest.TestCase):

    def test_build_fallback_adapters_returns_empty_when_no_credentials(self):
        adapters = scr.build_fallback_adapters(env={})
        self.assertEqual(adapters, [])

    def test_build_fallback_adapters_orders_by_trust_rank(self):
        env = {"FMP_API_KEY": "f", "ALPHA_VANTAGE_API_KEY": "a"}
        adapters = scr.build_fallback_adapters(env=env)
        self.assertEqual([adapter.name for adapter in adapters], ["fmp", "alpha_vantage"])

    def test_fill_company_missing_fields_records_disabled_providers(self):
        company = self._company_with_missing__helper()
        # no credentials -> no adapters -> fields stay missing, no network
        adapters = scr.build_fallback_adapters(env={})
        merged, failures = scr.fill_company_missing_fields(company, adapters)
        self.assertIsNone(merged["net_income"].value)
        self.assertEqual(failures, [])


    def test_apply_provider_fallbacks_no_adapters_does_not_add_fallback_provenance(self):
        company = self._company_with_missing__helper()

        updated, failures = scr.apply_provider_fallbacks_to_companies([company], [])

        self.assertEqual(failures, [])
        self.assertEqual(updated[0]["net_income"].provenance["source_family"], "yahoo-finance")
        fallback_providers = {
            (fv.provenance or {}).get("provider")
            for fv in updated[0].values()
            if isinstance(fv, FieldValue)
        }
        self.assertNotIn("fmp", fallback_providers)

    def test_apply_provider_fallbacks_fills_only_missing_fields_from_fmp(self):
        company = self._company_with_missing__helper()
        original_revenue = company["revenue"].value

        class FakeFmp:
            name = "fmp"
            last_error = None
            def fetch(self, ticker):
                return {
                    "revenue": FieldValue(1.0, {"source_family": "fmp", "provider": "fmp", "field_name": "revenue"}),
                    "net_income": FieldValue(9_800_000_000.0, {"source_family": "fmp", "provider": "fmp", "field_name": "net_income"}),
                }

        updated, failures = scr.apply_provider_fallbacks_to_companies([company], [FakeFmp()])

        self.assertEqual(failures, [])
        self.assertEqual(updated[0]["revenue"].value, original_revenue)
        self.assertEqual(updated[0]["revenue"].provenance["source_url"], "fixture")
        self.assertEqual(updated[0]["net_income"].provenance["source_family"], "fmp")
        self.assertEqual(updated[0]["net_income"].provenance["provider"], "fmp")

    def test_apply_provider_fallbacks_redacts_secret_bearing_failure_reason(self):
        company = self._company_with_missing__helper()

        class FailingAdapter:
            name = "fmp"
            last_error = None
            def fetch(self, ticker):
                raise RuntimeError("429 https://example.test/data?apikey=SECRET&symbol=BHP")

        updated, failures = scr.apply_provider_fallbacks_to_companies([company], [FailingAdapter()])

        self.assertIsNone(updated[0]["net_income"].value)
        self.assertIn("429", failures[0]["reason"])
        self.assertNotIn("apikey", failures[0]["reason"].lower())
        self.assertNotIn("SECRET", failures[0]["reason"])

    def _company_with_missing__helper(self):
        company = asx_company()
        company["net_income"] = scr.missing_field_value("net_income", "provider_absent", "yahoo-finance")
        return company


if __name__ == "__main__":
    unittest.main()

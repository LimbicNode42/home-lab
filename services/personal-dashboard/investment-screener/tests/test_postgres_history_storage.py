"""
TDD tests for ASX investment screener Postgres historical storage.

These tests deliberately use fake DB connections/cursors only. They verify SQL shape,
idempotency, JSON/provenance persistence, and CLI wiring without touching a live DB.
"""

import json
import sys
import unittest
from pathlib import Path

_SCREENER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_SCREENER_DIR))

from screener import (  # noqa: E402
    FieldValue,
    POSTGRES_SCHEMA_SQL,
    insert_screener_run,
    load_config,
    parse_args,
    rank_companies,
)

CONFIG_PATH = _SCREENER_DIR / "config.yaml"


def field(value, name, data_as_of="2025-06-30"):
    return FieldValue(
        value=value,
        provenance={
            "source_family": "fixture",
            "source_url": "https://example.invalid/asx/fixture",
            "retrieved_at": "2026-01-01T00:00:00Z",
            "source_reported_at": data_as_of,
            "data_as_of": data_as_of,
            "field_name": name,
            "trust_level": "fixture",
            "freshness": "fixture data for storage tests",
        },
    )


def company_fixture(**overrides):
    base = {
        "ticker": "BHP.AX",
        "asx_code": "BHP",
        "name": "BHP Group Limited",
        "market": "ASX",
        "exchange": "ASX",
        "region": "AU",
        "sector": "Materials",
        "industry": "Diversified Metals and Mining",
        "currency": "AUD",
        "active": True,
        "identity_provenance": {"source_family": "watchlist", "trust_level": "operator_curated"},
        "price": field(45.00, "price"),
        "shares_outstanding": field(5_000_000_000, "shares_outstanding"),
        "revenue": field(60_000_000_000, "revenue"),
        "prior_revenue": field(55_000_000_000, "prior_revenue", data_as_of="2024-06-30"),
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


class RecordingCursor:
    def __init__(self):
        self.statements = []
        self._ids = iter([42, 100, 42, 100])

    def execute(self, sql, params=None):
        self.statements.append((" ".join(sql.split()), params))

    def fetchone(self):
        return (next(self._ids),)


class RecordingConnection:
    def __init__(self):
        self.cursor_obj = RecordingCursor()
        self.commits = 0

    def cursor(self):
        return self.cursor_obj

    def commit(self):
        self.commits += 1


class TestPostgresSchemaContract(unittest.TestCase):
    def test_schema_is_review_safe_and_non_destructive(self):
        self.assertIn("CREATE TABLE IF NOT EXISTS investment_screener_runs", POSTGRES_SCHEMA_SQL)
        self.assertIn("CREATE TABLE IF NOT EXISTS investment_screener_companies", POSTGRES_SCHEMA_SQL)
        self.assertIn("CREATE TABLE IF NOT EXISTS investment_screener_observations", POSTGRES_SCHEMA_SQL)
        self.assertIn("CREATE TABLE IF NOT EXISTS investment_screener_scores", POSTGRES_SCHEMA_SQL)
        self.assertIn("CREATE TABLE IF NOT EXISTS investment_screener_provenance", POSTGRES_SCHEMA_SQL)
        self.assertIn("CREATE TABLE IF NOT EXISTS investment_screener_price_snapshots", POSTGRES_SCHEMA_SQL)
        self.assertNotIn("DROP TABLE", POSTGRES_SCHEMA_SQL.upper())
        self.assertNotIn("TRUNCATE", POSTGRES_SCHEMA_SQL.upper())

    def test_schema_enforces_run_key_and_per_company_idempotency(self):
        sql = POSTGRES_SCHEMA_SQL.lower()
        self.assertIn("run_key text not null", sql)
        self.assertIn("unique", sql)
        self.assertIn("run_key", sql)
        self.assertIn("unique(run_id, company_id)", sql)
        self.assertIn("references investment_screener_companies(id)", sql)

    def test_schema_keeps_contract_columns_for_history_and_later_performance(self):
        for column in (
            "asx_code",
            "sector",
            "industry",
            "active",
            "identity_provenance",
            "derived_fields",
            "missing_fields",
            "source_quality",
            "score_version",
            "observed_at",
            "trading_date",
            "price",
            "provenance",
        ):
            self.assertIn(column, POSTGRES_SCHEMA_SQL)


class TestInsertScreenerRunIdempotent(unittest.TestCase):
    def test_insert_uses_run_key_upsert_and_returns_stable_run_id(self):
        ranked = rank_companies([company_fixture()], load_config(CONFIG_PATH))
        conn = RecordingConnection()

        run_id = insert_screener_run(
            conn,
            ranked,
            source="asx-yahoo-timeseries",
            mode="fixture",
            universe=["BHP.AX"],
            run_key="investment-screener:ASX:fixture:2026-01",
            score_version="fixture-score-v1",
        )

        self.assertEqual(run_id, 42)
        run_sql, run_params = conn.cursor_obj.statements[0]
        self.assertIn("ON CONFLICT (run_key) DO UPDATE", run_sql)
        self.assertIn("RETURNING id", run_sql)
        self.assertEqual(run_params[0], "investment-screener:ASX:fixture:2026-01")

    def test_insert_upserts_companies_observations_and_scores_by_company_id(self):
        ranked = rank_companies([company_fixture()], load_config(CONFIG_PATH))
        conn = RecordingConnection()

        insert_screener_run(
            conn,
            ranked,
            source="fixture",
            mode="fixture",
            universe=["BHP.AX"],
            run_key="investment-screener:ASX:fixture:2026-01",
            score_version="fixture-score-v1",
        )

        sql_text = "\n".join(sql for sql, _ in conn.cursor_obj.statements)
        self.assertIn("ON CONFLICT (ticker) DO UPDATE", sql_text)
        self.assertIn("ON CONFLICT (run_id, company_id) DO UPDATE", sql_text)
        self.assertIn("investment_screener_observations", sql_text)
        self.assertIn("investment_screener_scores", sql_text)

    def test_insert_persists_json_fields_provenance_and_score_caveats(self):
        ranked = rank_companies([company_fixture()], load_config(CONFIG_PATH))
        conn = RecordingConnection()

        insert_screener_run(
            conn,
            ranked,
            source="fixture",
            mode="fixture",
            universe=["BHP.AX"],
            run_key="investment-screener:ASX:fixture:2026-01",
            score_version="fixture-score-v1",
        )

        obs_stmt = next(stmt for stmt in conn.cursor_obj.statements if "investment_screener_observations" in stmt[0])
        obs_params = obs_stmt[1]
        raw_fields = json.loads(obs_params[7])
        derived_fields = json.loads(obs_params[8])
        missing_fields = json.loads(obs_params[9])
        self.assertEqual(raw_fields["price"]["value"], 45.0)
        self.assertEqual(raw_fields["price"]["status"], "present")
        self.assertEqual(raw_fields["price"]["provenance"]["source_family"], "fixture")
        self.assertIn("market_cap", derived_fields)
        self.assertIsInstance(missing_fields, list)

        score_stmt = next(stmt for stmt in conn.cursor_obj.statements if "investment_screener_scores" in stmt[0])
        score_params = score_stmt[1]
        self.assertEqual(score_params[1], 100)  # company_id
        self.assertEqual(score_params[-1], "fixture-score-v1")
        self.assertIsInstance(json.loads(score_params[8]), list)  # risk_flags
        self.assertIsInstance(json.loads(score_params[9]), list)  # caveats

    def test_insert_writes_normalized_provenance_rows_without_credentials(self):
        ranked = rank_companies([company_fixture()], load_config(CONFIG_PATH))
        conn = RecordingConnection()

        insert_screener_run(
            conn,
            ranked,
            source="fixture",
            mode="fixture",
            universe=["BHP.AX"],
            run_key="investment-screener:ASX:fixture:2026-01",
            score_version="fixture-score-v1",
        )

        provenance_statements = [s for s in conn.cursor_obj.statements if "investment_screener_provenance" in s[0]]
        self.assertGreaterEqual(len(provenance_statements), 1)
        sql, params = provenance_statements[0]
        self.assertIn("ON CONFLICT DO NOTHING", sql)
        self.assertIn("fixture", params)
        serialized_params = json.dumps(params, default=str)
        self.assertNotIn("DATABASE_URL", serialized_params)
        self.assertNotIn("password", serialized_params.lower())

    def test_insert_can_label_non_fixture_asx_yahoo_timeseries_runs(self):
        ranked = rank_companies([company_fixture()], load_config(CONFIG_PATH))
        conn = RecordingConnection()

        insert_screener_run(
            conn,
            ranked,
            source="asx-yahoo-timeseries",
            mode="asx-yahoo-timeseries",
            universe=["BHP.AX"],
            run_key="investment-screener:ASX:asx-yahoo-timeseries:2026-08",
            score_version="asx-bootstrap-v1",
        )

        run_sql, run_params = conn.cursor_obj.statements[0]
        self.assertEqual(run_params[3], "asx-yahoo-timeseries")
        self.assertEqual(json.loads(run_params[5])["source"], "asx-yahoo-timeseries")


class TestPostgresCliFlags(unittest.TestCase):
    def test_cli_exposes_explicit_history_write_flag_and_env_reference_only(self):
        args = parse_args([
            "--fixture",
            "--write-postgres-history",
            "--run-key",
            "investment-screener:ASX:fixture:2026-01",
        ])

        self.assertTrue(args.write_postgres_history)
        self.assertEqual(args.database_url_env, "DATABASE_URL")
        self.assertEqual(args.run_key, "investment-screener:ASX:fixture:2026-01")


if __name__ == "__main__":
    unittest.main()

"""
TDD tests for multi-source historical storage schema extension.

These tests use fake DB connections only (like test_postgres_history_storage.py).
They verify that the Postgres history lane can persist multi-source consolidation
outcomes (selected value + reason, alternates, conflicts, field quality, source
confidence), universe/denominator metadata, and sanitized per-provider failure
summaries without leaking provider payloads or secret-bearing URLs.
"""

import json
import sys
import unittest
from pathlib import Path

_SCREENER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_SCREENER_DIR))

from screener import (  # noqa: E402
    POSTGRES_SCHEMA_SQL,
    build_universe_storage_metadata,
    insert_screener_run,
    project_consolidated_fields_sanitized,
    sanitize_provider_failures,
)


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


def multi_source_row_fixture():
    """A hand-built ranked row carrying a consolidated field with a conflict."""
    return {
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
        "identity_provenance": {"source_family": "watchlist"},
        "composite_score": 74.2,
        "rank": 1,
        "excluded": False,
        "sub_scores": {},
        "missing_penalty_points": 0,
        "risk_flags": [],
        "caveats": [],
        "score_caps": {},
        "exclusion_reasons": [],
        "missing_fields": [],
        "fields": {},
        "multi_source_fields": {
            "revenue": {
                "field_name": "revenue",
                "selected": {
                    "field_name": "revenue",
                    "value": 60000000000.0,
                    "value_status": "present",
                    "unit": "currency",
                    "currency": "AUD",
                    "scale": "ones",
                    "period_type": "annual",
                    "period_end": "2025-06-30",
                    "data_as_of": "2025-06-30",
                    "source_family": "provider_statement",
                    "provider": "fmp",
                    "source_url": "https://example.invalid/api/income-statement/BHP?apikey=TOPSECRET",
                    "source_url_sanitized": True,
                    "confidence": "medium",
                    "trust_level": "licensed_provider_normalized_statement",
                    "stale": False,
                    "method": "reported",
                    "caveats": ["verify"],
                },
                "selection_reason": "highest_priority_same_period",
                "alternates": [
                    {
                        "field_name": "revenue",
                        "value": 59000000000.0,
                        "provider": "yahoo_finance",
                        "source_family": "unofficial_statement",
                        "value_status": "present",
                        "reason_not_selected": "lower_priority_source",
                    }
                ],
                "conflicts": [
                    {
                        "kind": "numeric_delta_exceeds_threshold",
                        "severity": "warning",
                        "field_name": "revenue",
                        "providers": ["fmp", "yahoo_finance"],
                        "message": "Candidate numeric values differ materially.",
                        "threshold": ">2.0%",
                        "observed_delta": 0.0169,
                        "selected_provider": "fmp",
                        "requires_review": False,
                    }
                ],
                "caveats": ["verify"],
                "score_effect": {"usable_for_scoring": True, "penalty_points": 0, "score_cap": None},
            }
        },
        "field_quality": {
            "filled_fields": ["revenue"],
            "conflicted_fields": [],
            "stale_fields": [],
            "missing_fields": ["operating_cash_flow"],
            "conflict_count": 1,
        },
        "source_summary": "fmp+yahoo",
        "provider_priority_version": "field-consolidation/v1",
    }


def observation_statement(conn):
    return next(stmt for stmt in conn.cursor_obj.statements if "investment_screener_observations" in stmt[0])


def run_statement(conn):
    # first statement is the run upsert
    return conn.cursor_obj.statements[0]


class TestMultiSourceSchemaContract(unittest.TestCase):
    def test_schema_adds_multi_source_columns_non_destructively(self):
        sql = POSTGRES_SCHEMA_SQL
        for column in (
            "selected_fields",
            "alternates",
            "conflicts",
            "field_quality",
            "source_confidence",
            "universe_metadata",
            "provider_failures",
        ):
            self.assertIn(column, sql)
        self.assertIn("ADD COLUMN IF NOT EXISTS selected_fields", sql)
        self.assertIn("ADD COLUMN IF NOT EXISTS alternates", sql)
        self.assertIn("ADD COLUMN IF NOT EXISTS conflicts", sql)
        self.assertIn("ADD COLUMN IF NOT EXISTS field_quality", sql)
        self.assertIn("ADD COLUMN IF NOT EXISTS source_confidence", sql)
        self.assertIn("ADD COLUMN IF NOT EXISTS universe_metadata", sql)
        self.assertIn("ADD COLUMN IF NOT EXISTS provider_failures", sql)

    def test_migration_remains_non_destructive(self):
        upper = POSTGRES_SCHEMA_SQL.upper()
        self.assertNotIn("DROP TABLE", upper)
        self.assertNotIn("DROP COLUMN", upper)
        self.assertNotIn("TRUNCATE", upper)
        self.assertIn("CREATE TABLE IF NOT EXISTS", POSTGRES_SCHEMA_SQL)
        self.assertIn("ADD COLUMN IF NOT EXISTS", POSTGRES_SCHEMA_SQL)


class TestInsertMultiSourceColumns(unittest.TestCase):
    def _insert(self, conn=None, row=None):
        conn = conn or RecordingConnection()
        insert_screener_run(
            conn,
            [row if row is not None else multi_source_row_fixture()],
            source="fixture",
            mode="fixture",
            universe=["BHP.AX"],
            run_key="investment-screener:ASX:fixture:multi-source",
            score_version="fixture-score-v1",
            universe_metadata=build_universe_storage_metadata(
                ["BHP.AX"],
                universe_metadata={"source_sha256": "abc123", "source_row_count": 1},
                batch_metadata={
                    "denominator_status": "complete_exchange_listing",
                    "eligible_count": 1,
                    "security_type_filter": ["ordinary_share"],
                    "batch_offset": 0,
                    "selected_count": 1,
                },
            ),
            provider_failures=[
                {
                    "provider": "fmp",
                    "source_family": "fmp",
                    "ticker": "BHP.AX",
                    "reason": "429 Too Many Requests https://example.invalid?apikey=TOPSECRET",
                    "recoverable": True,
                    "failed_at": "2026-08-28T00:00:00Z",
                    "raw_body": {"secret": "leak"},
                }
            ],
        )
        return conn

    def test_observation_persists_selected_reason_and_field_quality(self):
        conn = self._insert()
        _, params = observation_statement(conn)
        selected_fields = json.loads(params[10])
        alternates = json.loads(params[11])
        conflicts = json.loads(params[12])
        field_quality = json.loads(params[13])
        source_confidence = json.loads(params[14])

        self.assertIn("revenue", selected_fields)
        self.assertEqual(selected_fields["revenue"]["value"], 60000000000.0)
        self.assertEqual(selected_fields["revenue"]["selection_reason"], "highest_priority_same_period")
        self.assertEqual(selected_fields["revenue"]["provider"], "fmp")

        self.assertIn("revenue", alternates)
        self.assertEqual(alternates["revenue"][0]["provider"], "yahoo_finance")
        self.assertEqual(alternates["revenue"][0]["reason_not_selected"], "lower_priority_source")

        self.assertEqual(conflicts[0]["field_name"], "revenue")
        self.assertEqual(field_quality["conflict_count"], 1)
        self.assertEqual(source_confidence["fmp"], "medium")

    def test_conflicts_persist_full_shape(self):
        conn = self._insert()
        _, params = observation_statement(conn)
        conflict = json.loads(params[12])[0]
        for key in ("kind", "severity", "providers", "threshold", "observed_delta", "selected_provider", "requires_review", "field_name"):
            self.assertIn(key, conflict)
        self.assertEqual(conflict["kind"], "numeric_delta_exceeds_threshold")
        self.assertEqual(conflict["providers"], ["fmp", "yahoo_finance"])

    def test_selected_and_alternates_store_no_secret_query_params(self):
        conn = self._insert()
        _, params = observation_statement(conn)
        blob = json.dumps(params[10:14], default=str)
        self.assertNotIn("TOPSECRET", blob)
        self.assertNotIn("apikey=", blob)

    def test_run_persists_universe_metadata_and_sanitized_failures(self):
        conn = self._insert()
        _, params = run_statement(conn)
        universe_metadata = json.loads(params[9])
        provider_failures = json.loads(params[10])

        self.assertEqual(universe_metadata["denominator"], 1)
        self.assertEqual(universe_metadata["denominator_status"], "complete_exchange_listing")
        self.assertEqual(universe_metadata["security_type_filter"], ["ordinary_share"])
        self.assertEqual(universe_metadata["batch_offset"], 0)
        self.assertEqual(universe_metadata["seed_sha256"], "abc123")

        self.assertEqual(len(provider_failures), 1)
        self.assertEqual(provider_failures[0]["provider"], "fmp")
        self.assertNotIn("TOPSECRET", json.dumps(provider_failures, default=str))
        self.assertNotIn("raw_body", provider_failures[0])
        self.assertNotIn("apikey=", provider_failures[0]["reason"])


class TestSanitizeProviderFailures(unittest.TestCase):
    def test_redacts_secrets_and_drops_raw_bodies(self):
        out = sanitize_provider_failures([
            {
                "provider": "fmp",
                "source_family": "fmp",
                "ticker": "BHP.AX",
                "reason": "429 Too Many Requests https://example.invalid?apikey=TOPSECRET",
                "recoverable": True,
                "failed_at": "2026-08-28T00:00:00Z",
                "raw_body": {"secret": "leak"},
                "headers": {"x-relaxed": "internal"},
            }
        ])
        item = out[0]
        self.assertEqual(item["provider"], "fmp")
        self.assertNotIn("raw_body", item)
        self.assertNotIn("headers", item)
        self.assertNotIn("TOPSECRET", item["reason"])
        self.assertNotIn("apikey=", item["reason"])


class TestUniverseStorageMetadata(unittest.TestCase):
    def test_includes_denominator_and_seed_hash(self):
        meta = build_universe_storage_metadata(
            ["BHP.AX", "CBA.AX"],
            universe_metadata={"source_sha256": "deadbeef", "source_row_count": 2},
            batch_metadata={
                "denominator_status": "complete_security_type_filtered_listing",
                "eligible_count": 2,
                "security_type_filter": ["ordinary_share"],
                "exclude_security_types": ["warrant", "etf"],
                "excluded_security_type_count": 5,
                "batch_offset": 0,
                "selected_count": 2,
            },
        )
        self.assertEqual(meta["denominator"], 2)
        self.assertEqual(meta["denominator_status"], "complete_security_type_filtered_listing")
        self.assertEqual(meta["security_type_filter"], ["ordinary_share"])
        self.assertEqual(meta["exclude_security_types"], ["warrant", "etf"])
        self.assertEqual(meta["excluded_security_type_count"], 5)
        self.assertEqual(meta["batch_offset"], 0)
        self.assertEqual(meta["batch_size"], 2)
        self.assertEqual(meta["seed_sha256"], "deadbeef")


class TestDashboardReadProjection(unittest.TestCase):
    def test_projection_omits_raw_urls_and_provider_payloads(self):
        row = multi_source_row_fixture()
        projection = project_consolidated_fields_sanitized(row["multi_source_fields"])
        self.assertIn("revenue", projection)
        entry = projection["revenue"]
        self.assertEqual(entry["value"], 60000000000.0)
        self.assertEqual(entry["provider"], "fmp")
        self.assertEqual(entry["selection_reason"], "highest_priority_same_period")
        self.assertEqual(entry["conflict_count"], 1)
        self.assertNotIn("source_url", entry)
        self.assertNotIn("alternates", entry)
        blob = json.dumps(projection, default=str)
        self.assertNotIn("TOPSECRET", blob)
        self.assertNotIn("apikey=", blob)


if __name__ == "__main__":
    unittest.main()

"""Tests for LSE and TSE/JPX screener seed and hydration contracts."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

_SCREENER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_SCREENER_DIR))

import recurring_markets as rm
import screener as scr


class LseSeedContractTests(unittest.TestCase):
    def test_lse_issuer_rows_normalise_without_guessing_provider_symbol(self):
        rows = [
            {
                "Admission Date": "01/02/2020",
                "Company Name": "HSBC Holdings plc",
                "ICB Industry": "Banks",
                "ICB Super-Sector": "Banks",
                "Country of Incorporation": "United Kingdom",
                "World Region": "Europe",
                "Market": "MAIN MARKET",
            }
        ]

        entries, metadata = scr.normalise_lse_issuer_rows(
            rows,
            source_url="https://docs.londonstockexchange.com/list.xlsx?token=SECRET",
            retrieved_at="2026-09-12T19:20:00Z",
            source_sha256="abc123",
            source_as_at="2026-07-31",
        )

        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["company_id"], "lse:hsbc-holdings-plc")
        self.assertIsNone(entry["ticker"])
        self.assertIsNone(entry["eodhd_ticker"])
        self.assertIsNone(entry["yahoo_ticker"])
        self.assertEqual(entry["market"], "LSE")
        self.assertEqual(entry["exchange"], "LSE")
        self.assertEqual(entry["region"], "GB")
        self.assertIsNone(entry["currency"])
        self.assertEqual(entry["security_type"], "shares_depositary_or_other_equity_like_from_lse_issuer_workbook")
        self.assertEqual(metadata["denominator_status"], "complete_issuer_listing_requires_symbol_mapping")
        self.assertEqual(metadata["unaccounted_source_row_count"], 0)
        self.assertNotIn("SECRET", json.dumps(metadata))

    def test_lse_duplicate_match_key_fails_closed(self):
        rows = [
            {"Company Name": "Foo plc", "Market": "AIM"},
            {"Company Name": "Foo PLC", "Market": "AIM"},
        ]
        with self.assertRaises(ValueError):
            scr.normalise_lse_issuer_rows(rows, "fixture", "now", "sha", source_as_at="2026-07-31")

    def test_lse_selection_accounts_unmapped_seed_rows_as_missing_provider_symbol(self):
        entries, _ = scr.normalise_lse_issuer_rows(
            [{"Company Name": "Foo plc", "Market": "AIM"}], "fixture", "now", "sha", source_as_at="2026-07-31"
        )
        selected = scr.select_lse_universe_batch(entries, max_tickers=1)
        self.assertEqual(selected["tickers"], [])
        self.assertEqual(selected["selected_count"], 0)
        self.assertEqual(selected["missing_provider_symbol_count"], 1)
        self.assertEqual(selected["denominator_status"], "complete_issuer_listing_requires_symbol_mapping")

    def test_file_first_payload_counts_missing_provider_symbols_without_silent_shrinkage(self):
        entries, metadata = scr.normalise_lse_issuer_rows(
            [{"Company Name": "Foo plc", "Market": "AIM"}], "fixture", "now", "sha", source_as_at="2026-07-31"
        )
        selected = scr.select_lse_universe_batch(entries, max_tickers=1)
        payload = scr.build_file_first_run_payload(
            [],
            source="eodhd",
            mode=scr.LSE_MODE,
            universe=[entry["company_id"] for entry in selected["entries"]],
            universe_source=scr.LSE_DENOMINATOR_LABEL,
            universe_metadata=metadata,
            batch_metadata={k: v for k, v in selected.items() if k not in {"entries", "tickers"}},
            hydration_failures=[],
        )
        self.assertEqual(payload["coverage"]["denominator"], 1)
        self.assertEqual(payload["coverage"]["failed"], 1)
        self.assertEqual(payload["coverage"]["unaccounted"], 0)
        self.assertIn("missing_provider_symbol", json.dumps(payload["failures"]))


class TseSeedContractTests(unittest.TestCase):
    def test_tse_rows_normalise_jpx_equities_and_exclusions(self):
        rows = [
            {
                "Local Code": "7203",
                "Name (English)": "TOYOTA MOTOR CORPORATION",
                "Section/Products": "Prime Market (Domestic)",
                "33 Sector(Code)": "3700",
                "33 Sector(name)": "Transportation Equipment",
                "17 Sector(Code)": "6",
                "17 Sector(name)": "Automobiles & Transportation Equipment",
                "Size Code (New Index Series)": "1",
                "Size (New Index Series)": "TOPIX Core30",
            },
            {
                "Local Code": "1306",
                "Name (English)": "NEXT FUNDS TOPIX ETF",
                "Section/Products": "ETFs/ ETNs",
            },
        ]

        entries, metadata = scr.normalise_tse_jpx_rows(
            rows,
            source_url="https://www.jpx.co.jp/data_e.xlsx?apikey=NOPE",
            retrieved_at="2026-09-12T19:20:00Z",
            source_sha256="def456",
            source_effective_date="2026-08-31",
        )

        self.assertEqual(len(entries), 1)
        self.assertEqual(metadata["excluded_count"], 1)
        self.assertEqual(metadata["unaccounted_source_row_count"], 0)
        entry = entries[0]
        self.assertEqual(entry["company_id"], "tse:7203")
        self.assertEqual(entry["ticker"], "7203.T")
        self.assertEqual(entry["yahoo_ticker"], "7203.T")
        self.assertIsNone(entry["eodhd_ticker"])
        self.assertEqual(entry["exchange"], "JPX")
        self.assertEqual(entry["market"], "TSE")
        self.assertEqual(entry["currency"], "JPY")
        self.assertEqual(entry["sector"], "Transportation Equipment")
        self.assertEqual(metadata["denominator_status"], "complete_security_type_filtered_listing")
        self.assertNotIn("NOPE", json.dumps(metadata))

    def test_tse_duplicate_local_code_fails_closed(self):
        rows = [
            {"Local Code": "7203", "Name (English)": "Toyota", "Section/Products": "Prime Market (Domestic)"},
            {"Local Code": "7203", "Name (English)": "Toyota duplicate", "Section/Products": "Prime Market (Domestic)"},
        ]
        with self.assertRaises(ValueError):
            scr.normalise_tse_jpx_rows(rows, "fixture", "now", "sha", source_effective_date="2026-08-31")

    def test_tse_selection_requires_provider_symbol_for_eodhd(self):
        entries, _ = scr.normalise_tse_jpx_rows(
            [{"Local Code": "7203", "Name (English)": "Toyota", "Section/Products": "Prime Market (Domestic)"}],
            "fixture", "now", "sha", source_effective_date="2026-08-31"
        )
        selected = scr.select_tse_universe_batch(entries, max_tickers=1, provider="eodhd")
        self.assertEqual(selected["tickers"], [])
        self.assertEqual(selected["missing_provider_symbol_count"], 1)
        self.assertEqual(selected["provider_symbol_convention"], "eodhd exchange suffix undiscovered; authenticated exchanges-list required")

    def test_tse_selection_can_use_yahoo_alias_for_bounded_smoke(self):
        entries, _ = scr.normalise_tse_jpx_rows(
            [{"Local Code": "7203", "Name (English)": "Toyota", "Section/Products": "Prime Market (Domestic)"}],
            "fixture", "now", "sha", source_effective_date="2026-08-31"
        )
        selected = scr.select_tse_universe_batch(entries, max_tickers=1, provider="yahoo")
        self.assertEqual(selected["tickers"], ["7203.T"])
        self.assertEqual(selected["missing_provider_symbol_count"], 0)
        self.assertEqual(selected["provider_symbol_convention"], "yahoo {local_code}.T smoke alias; not denominator source")


class LseTseRegistryTests(unittest.TestCase):
    def test_embedded_registry_lists_lse_and_tse_disabled_until_mapping_or_exchange_discovery(self):
        reg = rm.load_registry(_SCREENER_DIR / "universe" / "recurring-markets.json")
        disabled = {m["id"]: m for m in rm.disabled_markets(reg)}
        self.assertIn("lse", disabled)
        self.assertIn("tse", disabled)
        self.assertEqual(disabled["lse"]["denominator_status"], "complete_issuer_listing_requires_symbol_mapping")
        self.assertEqual(disabled["tse"]["denominator_status"], "complete_security_type_filtered_listing")
        self.assertIn("EODHD", disabled["tse"]["disabled_reason"])


if __name__ == "__main__":
    unittest.main()

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


class LseProviderMappingTests(unittest.TestCase):
    def test_lse_provider_reference_exactly_maps_unique_normalised_names(self):
        seed_entries, seed_metadata = scr.normalise_lse_issuer_rows(
            [
                {"Company Name": "HSBC Holdings plc", "Market": "MAIN MARKET"},
                {"Company Name": "No Provider Match plc", "Market": "AIM"},
            ],
            source_url="https://docs.londonstockexchange.com/list.xlsx",
            retrieved_at="2026-09-12T19:20:00Z",
            source_sha256="seedsha",
            source_as_at="2026-07-31",
        )
        provider_rows = [
            {
                "Code": "HSBA",
                "Name": "HSBC HOLDINGS PLC",
                "Exchange": "LSE",
                "Currency": "GBp",
                "Type": "Common Stock",
                "Isin": "GB0005405286",
            }
        ]

        mapped_entries, report = scr.reconcile_lse_provider_symbols(
            seed_entries,
            provider_rows,
            provider="eodhd",
            provider_source_url="https://eodhd.com/api/exchange-symbol-list/LSE?api_token=SECRET&fmt=json",
            retrieved_at="2026-09-13T08:00:00Z",
            provider_sha256="providersha",
            seed_metadata=seed_metadata,
        )

        by_id = {entry["company_id"]: entry for entry in mapped_entries}
        self.assertEqual(by_id["lse:hsbc-holdings-plc"]["eodhd_ticker"], "HSBA.LSE")
        self.assertEqual(by_id["lse:hsbc-holdings-plc"]["ticker"], "HSBA.LSE")
        self.assertEqual(by_id["lse:hsbc-holdings-plc"]["isin"], "GB0005405286")
        self.assertEqual(by_id["lse:hsbc-holdings-plc"]["currency"], "GBp")
        self.assertEqual(by_id["lse:hsbc-holdings-plc"]["mapping_status"], "mapped")
        self.assertEqual(by_id["lse:no-provider-match-plc"]["mapping_status"], "unmapped")
        self.assertEqual(report["mapped_count"], 1)
        self.assertEqual(report["unmapped_count"], 1)
        self.assertEqual(report["failed_count"], 0)
        self.assertEqual(report["excluded_count"], 0)
        self.assertEqual(report["unaccounted_seed_count"], 0)
        self.assertEqual(report["denominator_status"], "mapped_subset_provider_symbol_review_required")
        self.assertNotIn("SECRET", json.dumps(report))

    def test_lse_provider_reference_ambiguous_name_does_not_guess(self):
        seed_entries, seed_metadata = scr.normalise_lse_issuer_rows(
            [{"Company Name": "Example plc", "Market": "MAIN MARKET"}],
            source_url="fixture",
            retrieved_at="now",
            source_sha256="seedsha",
            source_as_at="2026-07-31",
        )
        provider_rows = [
            {"Code": "EXA", "Name": "Example plc", "Exchange": "LSE", "Isin": "GB00A"},
            {"Code": "EXB", "Name": "Example PLC", "Exchange": "LSE", "Isin": "GB00B"},
        ]

        mapped_entries, report = scr.reconcile_lse_provider_symbols(
            seed_entries,
            provider_rows,
            provider="eodhd",
            provider_source_url="fixture?api_token=SECRET",
            retrieved_at="now",
            provider_sha256="providersha",
            seed_metadata=seed_metadata,
        )

        self.assertIsNone(mapped_entries[0]["eodhd_ticker"])
        self.assertEqual(mapped_entries[0]["mapping_status"], "mapping_ambiguous")
        self.assertEqual(report["mapping_ambiguous_count"], 1)
        self.assertEqual(report["mapped_count"], 0)
        self.assertEqual(report["unaccounted_seed_count"], 0)

    def test_lse_selection_uses_only_reviewed_mapped_provider_symbols(self):
        entries = [
            {
                "company_id": "lse:mapped",
                "issuer_id": "lse:mapped",
                "name": "Mapped PLC",
                "name_match_key": "mapped",
                "active": True,
                "universe_rank": 1,
                "eodhd_ticker": "MAP.LSE",
                "mapping_status": "mapped",
            },
            {
                "company_id": "lse:ambiguous",
                "issuer_id": "lse:ambiguous",
                "name": "Ambiguous PLC",
                "name_match_key": "ambiguous",
                "active": True,
                "universe_rank": 2,
                "eodhd_ticker": "AMB.LSE",
                "mapping_status": "mapping_ambiguous",
            },
        ]

        selected = scr.select_lse_universe_batch(entries, max_tickers=2, provider="eodhd")

        self.assertEqual(selected["tickers"], ["MAP.LSE"])
        self.assertEqual(selected["selected_count"], 1)
        self.assertEqual(selected["missing_provider_symbol_count"], 1)
        self.assertEqual(selected["missing_provider_symbols"][0]["reason"], "mapping_ambiguous")
    def test_lse_file_first_payload_surfaces_mapping_accounting_fields(self):
        payload = scr.build_file_first_run_payload(
            [],
            source="eodhd",
            mode=scr.LSE_MODE,
            universe=[],
            universe_source=scr.LSE_DENOMINATOR_LABEL,
            universe_metadata={"source_row_count": 3},
            batch_metadata={
                "eligible_count": 3,
                "selected_count": 1,
                "mapped_count": 1,
                "unmapped_count": 1,
                "mapping_ambiguous_count": 1,
                "failed_count": 0,
                "excluded_count": 0,
                "denominator_status": "mapped_subset_provider_symbol_review_required",
                "denominator_label": "LSE mapped issuer subset pending review",
                "provider_symbol_convention": "fixture convention",
            },
            hydration_failures=[],
        )

        self.assertEqual(payload["coverage"]["mapped_count"], 1)
        self.assertEqual(payload["coverage"]["unmapped_count"], 1)
        self.assertEqual(payload["coverage"]["mapping_ambiguous_count"], 1)
        self.assertEqual(payload["universe"]["provider_symbol_convention"], "fixture convention")


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

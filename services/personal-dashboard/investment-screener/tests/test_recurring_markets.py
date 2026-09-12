"""Tests for the config-driven recurring investment-screener market registry.

These prove the registry iteration contract the owner wrappers depend on:
- the embedded registry enables ASX, NASDAQ, and NYSE while LSE/TSE/US are disabled,
- a future market is added by a config/seed entry, not loop-code edits,
- fail-closed seed handling (missing/empty seed raises, no magic count),
- full-count is resolved dynamically from the reviewed seed.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

_SCREENER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_SCREENER_DIR))

import recurring_markets as rm


def _minimal_market(**overrides):
    base = {
        "id": "asx",
        "enabled": True,
        "market": "ASX",
        "source": "yahoo-finance",
        "mode": "asx-yahoo-timeseries",
        "seed": "investment-screener/universe/asx-listed-companies.seed.json",
        "seed_arg": "--asx-universe-seed",
        "denominator_label": "Complete ASX company directory seed",
        "denominator_status": "complete_exchange_listing",
        "full_count_policy": "complete_seed",
        "smoke_batch_size": 4,
        "max_generated_age_hours": 26,
    }
    base.update(overrides)
    return base


def _registry_dict(markets):
    return {"schema_version": rm.REGISTRY_SCHEMA_VERSION, "markets": markets}


def _tmp() -> Path:
    return Path(tempfile.mkdtemp(prefix="recurring-registry-"))


def _write_registry(data) -> Path:
    p = _tmp() / "reg.json"
    p.write_text(json.dumps(data), encoding="utf8")
    return p


def _write_seed(app_dir: Path, rel: str, entries) -> None:
    seed = app_dir / rel
    seed.parent.mkdir(parents=True, exist_ok=True)
    seed.write_text(json.dumps({"entries": entries}), encoding="utf8")


class RegistryLoadingTests(unittest.TestCase):
    def test_embedded_registry_loads_and_iterates(self):
        reg_file = _SCREENER_DIR / "universe" / "recurring-markets.json"
        reg = rm.load_registry(reg_file)
        self.assertEqual(reg["schema_version"], rm.REGISTRY_SCHEMA_VERSION)
        enabled = rm.enabled_markets(reg)
        self.assertEqual([m["id"] for m in enabled], ["asx", "nasdaq", "nyse"])
        disabled = rm.disabled_markets(reg)
        self.assertEqual([m["id"] for m in disabled], ["lse", "tse", "us"])
        self.assertIs(disabled[-1]["enabled"], False)
        self.assertTrue(disabled[-1].get("disabled_reason"))

    def test_added_market_is_enumerated_without_code_change(self):
        # An operator adds a future market entry; the same driver loop
        # (enabled_markets) surfaces it with no loop-code edit.
        data = _registry_dict([_minimal_market()])
        data["markets"].append(_minimal_market(id="lse", market="LSE", seed="investment-screener/universe/lse.seed.json"))
        reg_file = _write_registry(data)
        reg = rm.load_registry(reg_file)
        ids = [m["id"] for m in rm.enabled_markets(reg)]
        self.assertIn("lse", ids)
        self.assertEqual(ids.count("lse"), 1)

    def test_bad_schema_version_rejected(self):
        data = {"schema_version": "nope", "markets": [_minimal_market()]}
        reg_file = _write_registry(data)
        with self.assertRaises(ValueError):
            rm.load_registry(reg_file)

    def test_empty_markets_rejected(self):
        reg_file = _write_registry({"schema_version": rm.REGISTRY_SCHEMA_VERSION, "markets": []})
        with self.assertRaises(ValueError):
            rm.load_registry(reg_file)


class FieldValidationTests(unittest.TestCase):
    def test_valid_market_has_no_missing_fields(self):
        self.assertEqual(rm.missing_required_fields(_minimal_market()), [])

    def test_missing_fields_are_named(self):
        missing = rm.missing_required_fields({"id": "x", "enabled": True})
        self.assertIn("mode", missing)

    def test_invalid_smoke_batch_size_rejected(self):
        with self.assertRaises(ValueError):
            rm.smoke_batch_size(_minimal_market(smoke_batch_size=0))
        with self.assertRaises(ValueError):
            rm.smoke_batch_size(_minimal_market(smoke_batch_size="nope"))

    def test_smoke_batch_size_coerces(self):
        self.assertEqual(rm.smoke_batch_size(_minimal_market(smoke_batch_size=7)), 7)


class SeedResolutionTests(unittest.TestCase):
    def test_full_count_resolves_dynamically_from_seed(self):
        app_dir = _tmp()
        _write_seed(app_dir, "investment-screener/universe/nasdaq.seed.json", [
            {"ticker": "A.US"}, {"ticker": "B.US"}, {"ticker": "C.US"},
        ])
        market = _minimal_market(
            id="nasdaq", market="NASDAQ", seed="investment-screener/universe/nasdaq.seed.json",
            denominator_status="complete_security_type_filtered_listing",
        )
        self.assertEqual(rm.resolve_full_count(market, app_dir), 3)

    def test_missing_seed_fails_closed(self):
        app_dir = _tmp()
        market = _minimal_market(seed="investment-screener/universe/does-not-exist.seed.json")
        with self.assertRaises(ValueError):
            rm.resolve_full_count(market, app_dir)

    def test_empty_seed_fails_closed(self):
        app_dir = _tmp()
        _write_seed(app_dir, "investment-screener/universe/empty.seed.json", [])
        market = _minimal_market(seed="investment-screener/universe/empty.seed.json")
        with self.assertRaises(ValueError):
            rm.resolve_full_count(market, app_dir)

    def test_unsupported_full_count_policy_fails_closed(self):
        market = _minimal_market(full_count_policy="legacy-magic-number")
        with self.assertRaises(ValueError):
            rm.resolve_full_count(market, _tmp())

    def test_legacy_bare_array_seed_supported(self):
        app_dir = _tmp()
        _write_seed(app_dir, "investment-screener/universe/bare.json", [
            {"ticker": "A.US"}, {"ticker": "B.US"},
        ])
        market = _minimal_market(seed="investment-screener/universe/bare.json")
        self.assertEqual(rm.resolve_full_count(market, app_dir), 2)


def _registry_json(markets):
    return {"schema_version": rm.REGISTRY_SCHEMA_VERSION, "markets": markets}


if __name__ == "__main__":
    unittest.main()
"""Config-driven recurring investment-screener market registry.

This module is the single source of truth for which markets the recurring
(monthly full-hydration / weekly smoke) jobs drive. The registry itself is
``universe/recurring-markets.json``; a new tracked market is added by writing a
registry entry (+ a reviewed seed + a hydration mode in ``screener.py``), never by
editing the driver loop code.

The bash owner wrappers shell out to ``--list`` / ``--full-count`` here; the
Python functions are also unit-tested directly so registry iteration and
fail-closed seed handling are proven without invoking a live provider scrape.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REGISTRY_SCHEMA_VERSION = "investment-screener-recurring-markets/v1"
DEFAULT_REGISTRY_RELPATH = "investment-screener/universe/recurring-markets.json"


def load_registry(path: Path | str) -> dict:
    """Load and shallow-validate the recurring-markets registry.

    Raises ``ValueError`` on a structurally invalid registry so the wrappers fail
    closed rather than defaulting to a hard-coded market list.
    """
    registry_path = Path(path)
    raw = json.loads(registry_path.read_text(encoding="utf8"))
    if not isinstance(raw, dict):
        raise ValueError(f"registry at {registry_path} must be a JSON object")
    if raw.get("schema_version") != REGISTRY_SCHEMA_VERSION:
        raise ValueError(
            f"registry at {registry_path} has schema_version {raw.get('schema_version')!r}, "
            f"expected {REGISTRY_SCHEMA_VERSION!r}"
        )
    markets = raw.get("markets")
    if not isinstance(markets, list) or not markets:
        raise ValueError(f"registry at {registry_path} must contain a non-empty markets array")
    return raw


def markets(registry: dict) -> list[dict]:
    return list(registry.get("markets") or [])


def enabled_markets(registry: dict) -> list[dict]:
    """Markets with ``enabled: true``, in registry order (stable)."""
    return [m for m in markets(registry) if m.get("enabled") is True]


def disabled_markets(registry: dict) -> list[dict]:
    """Markets that are not enabled (candidates, not part of recurring cycles)."""
    return [m for m in markets(registry) if m.get("enabled") is not True]


def missing_required_fields(market: dict) -> list[str]:
    """Return the list of required keys absent from a market entry.

    Required by the driver loop (see the registry schema): id, enabled, market,
    source, mode, seed, seed_arg, denominator_label, denominator_status,
    full_count_policy, smoke_batch_size, max_generated_age_hours.
    """
    required = (
        "id", "enabled", "market", "source", "mode", "seed", "seed_arg",
        "denominator_label", "denominator_status", "full_count_policy",
        "smoke_batch_size", "max_generated_age_hours",
    )
    return [key for key in required if key not in market]


def resolve_seed_path(market: dict, app_dir: Path | str) -> Path:
    """Resolve a market's seed path against the dashboard app dir.

    ``seed`` in the registry is a repo-root-relative path (e.g.
    ``investment-screener/universe/...``). Absolutize it once so downstream
    consumers (bash wrappers, tests) share one resolution rule.
    """
    seed = market.get("seed")
    if not seed:
        raise ValueError(f"market {market.get('id')!r} has no 'seed' path")
    candidate = Path(seed)
    if candidate.is_absolute():
        return candidate
    return Path(app_dir) / candidate


def seed_entry_count(seed_path: Path | str) -> int:
    """Return the number of entries in a reviewed universe seed.

    Fail-closed: a missing file, a non-dict/no-``entries`` payload, or a
    non-list/empty ``entries`` raises ``ValueError``. Legacy bare-array seeds
    are accepted for robustness (len of the array).
    """
    seed_file = Path(seed_path)
    if not seed_file.exists():
        raise ValueError(f"seed missing: {seed_file}")
    data = json.loads(seed_file.read_text(encoding="utf8"))
    entries = data.get("entries") if isinstance(data, dict) else data
    if not isinstance(entries, list) or not entries:
        raise ValueError(f"seed has no non-empty entries array: {seed_file}")
    return len(entries)


def resolve_full_count(market: dict, app_dir: Path | str) -> int:
    """Resolve a market's full seed count dynamically (fail-closed).

    ``full_count_policy`` is always ``complete_seed`` for currently-enabled
    markets: the full-count equals the reviewed seed's entry count. This is the
    "no hard-coded magic number" rule — a reviewed seed growth is picked up
    automatically, and a missing/empty seed raises instead of defaulting.
    """
    if market.get("full_count_policy") != "complete_seed":
        raise ValueError(
            f"market {market.get('id')!r} uses unsupported full_count_policy "
            f"{market.get('full_count_policy')!r}"
        )
    seed_path = resolve_seed_path(market, app_dir)
    return seed_entry_count(seed_path)


def smoke_batch_size(market: dict) -> int:
    size = market.get("smoke_batch_size")
    try:
        value = int(size)
    except (TypeError, ValueError):
        raise ValueError(
            f"market {market.get('id')!r} has invalid smoke_batch_size {size!r}"
        ) from None
    if value < 1:
        raise ValueError(f"market {market.get('id')!r} smoke_batch_size must be >= 1")
    return value


def _emit_resolved(registry: dict, app_dir: Path | str) -> None:
    """Print enabled markets as tab-separated records for the bash driver loop.

    Fields (shell-safe, no tabs/newlines in values)::

        id, market, source, mode, seed_arg, seed_path(abs), full_count,
        smoke_batch_size, sleep_seconds, max_generated_age_hours,
        denominator_label, denominator_status, credential_env (or ``-``)

    Full-count is resolved here (fail-closed) so the bash loop never touches a
    hard-coded magic number. Values are stripped of tabs/newlines defensively.
    """
    app = Path(app_dir)

    def clean(value) -> str:
        if value is None:
            return "-"
        return str(value).replace("\t", " ").replace("\n", " ").strip() or "-"

    for market in enabled_markets(registry):
        missing = missing_required_fields(market)
        if missing:
            raise ValueError(
                f"market {market.get('id')!r} missing required fields: {', '.join(missing)}"
            )
        seed_path = resolve_seed_path(market, app)
        full_count = resolve_full_count(market, app)
        row = [
            market["id"],
            market["market"],
            market.get("source"),
            market.get("mode"),
            market.get("seed_arg"),
            str(seed_path),
            str(full_count),
            str(smoke_batch_size(market)),
            market.get("sleep_seconds"),
            market.get("max_generated_age_hours"),
            market.get("denominator_label"),
            market.get("denominator_status"),
            market.get("credential_env"),
        ]
        print("\t".join(clean(value) for value in row))


def _cli(argv=None) -> int:
    import argparse
    parser = argparse.ArgumentParser(
        description="Resolve enabled recurring-hydration markets for the bash driver loop."
    )
    parser.add_argument("--app-dir", required=True, help="dashboard app dir (repo-path anchor)")
    parser.add_argument(
        "--registry",
        default=None,
        help="optional explicit registry path (defaults to <app-dir>/universe/recurring-markets.json)",
    )
    args = parser.parse_args(argv)
    registry_path = Path(args.registry) if args.registry else Path(args.app_dir) / DEFAULT_REGISTRY_RELPATH
    try:
        registry = load_registry(registry_path)
        _emit_resolved(registry, args.app_dir)
    except ValueError as exc:
        print(f"registry resolution failed: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())


__all__ = [
    "REGISTRY_SCHEMA_VERSION",
    "DEFAULT_REGISTRY_RELPATH",
    "load_registry",
    "markets",
    "enabled_markets",
    "disabled_markets",
    "missing_required_fields",
    "resolve_seed_path",
    "seed_entry_count",
    "resolve_full_count",
    "smoke_batch_size",
]
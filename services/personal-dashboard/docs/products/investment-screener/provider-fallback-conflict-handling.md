# Provider fallback and conflict handling

> Kanban task `t_5d7125ad`. Implementation of staged provider fallback and multi-source conflict handling. No live hydration, no credentials, no cron, no deploy performed by this task.

## What this is

The screener now has a fail-closed provider-fallback framework that can fill fields missing from the Yahoo bootstrap from optional credentialed providers, plus a conflict-resolution layer that selects one safe value per field and surfaces disagreement instead of averaging or fabricating data.

Nothing here is active until credentials exist. With the default empty environment, the fallback path makes no network calls and the consolidation layer is diagnostic metadata only.

## Default (no-credential) behavior

- `build_fallback_adapters()` inspects `FMP_API_KEY` and `ALPHA_VANTAGE_API_KEY` only. With neither present, it returns an empty list.
- `apply_provider_fallbacks_to_companies(companies, [])` returns the companies unchanged and performs no network calls.
- The existing Yahoo `asx-yahoo-timeseries` path is unchanged. Missing fields remain missing with an explicit `missing_reason`, never imputed.

## Credentialed adapters (optional, behind approval)

| Provider | Env var | Stage |
| --- | --- | --- |
| Financial Modeling Prep | `FMP_API_KEY` | First optional fill provider (statement fields) |
| Alpha Vantage | `ALPHA_VANTAGE_API_KEY` | Secondary spot-fill (rate-limited free tier) |

Both adapters subclass `ProviderAdapter`, which is fail-closed: with no credential, `fetch()` returns `{}` and never touches the network. A runtime credential is injected from Vaultwarden/local secret storage; values are never committed.

Credential requests were documented in `asx-fundamentals-provider-coverage-runbook-2026-08-28.md` with Vaultwarden references. Ben must approve each provider's ToS/licensing and private-storage terms before any key is created.

## Fill-only merge

`merge_missing_fields` fills only raw fields whose current value is `None`. Present Yahoo values are never overwritten in the first phase. The winning candidate follows provider trust order (FMP before Alpha Vantage). Any field still missing afterwards is re-marked `unavailable`.

## Conflict and selection model

`consolidate_field` / `consolidate_company_fields` implement the selection semantics from the [multi-source consolidation spec](./multi-source-fundamentals-consolidation-spec.md):

- Candidates are serialized into the normalized provenance shape (`unit`, `currency`, `scale`, `period_type`, `period_end`, `confidence`, `trust_level`, `method`, `caveats`, `missing_reason`, sanitized `source_url`).
- Hard shape conflicts — currency mismatch, unit/scale mismatch, period-type mismatch, period-end mismatch — are `blocking` and prevent selection.
- Same-provider/same-period restatements pick the newer `filed_at`/`source_reported_at`, retaining the older value as an alternate.
- Otherwise the highest-priority source wins; material numeric disagreement surfaces as a `warning` conflict with an observed delta.
- There is no averaging anywhere. If a field cannot be truthfully selected or derived, it stays unavailable.

## Derived FCF

`consolidate_company_fields` derives `fcf` only from selected `operating_cash_flow` and `capital_expenditures` that share currency, unit/scale, period type, and period end. Mismatched inputs leave FCF unavailable with a blocking conflict rather than a fabricated number.

## Dashboard-safe projection

- `build_dashboard_ranked_export` includes only `source_summary` and sanitized `field_quality` (filled/conflicted/stale/missing fields and a conflict count). Raw `fields`/`source_url` internals remain excluded.
- Run payloads gain `provider_priority_version`, `threshold_version`, `source_mix`, per-provider `provider_failures` (reason truncated to 160 chars), and aggregate `field_quality`.

## Provider URL sanitization

`redact_url_secrets` strips secret query parameters (`apikey`, `api_key`, `access_token`, `key`, `token`, `signature`, `sig`, `session`, `sessionid`, `session_id`, `sid`) from persisted `source_url` while preserving benign parameters. Provider adapters and the merge path sanitize before persistence.

## Tests

- Provider fail-closed behavior and disabled-adapter status.
- FMP/Alpha normalization to the enriched provenance shape.
- Rate-limit/fetch failures degrade to recoverable failures, never fabricated values.
- Fill-only merge, trust ordering, no overwrite, and remaining-missing reasons.
- Source-priority selection, currency/unit/period blocking conflicts, numeric near-equal vs material delta, newer-filing restatement, FCF compatibility, and dashboard-safe field-quality shape.
- Secret-scan fixture confirms no live keys, signed URLs, `.env` values, or local database paths are committed.

## Safety

No live hydration, cron change, or deploy was performed by this task. Provider adapters are disabled unless credentials are present, and the consolidation layer is non-mutating diagnostic metadata layered on top of the existing fill-only behavior.

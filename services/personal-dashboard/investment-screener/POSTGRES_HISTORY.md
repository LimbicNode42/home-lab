# Investment screener Postgres history

This directory contains the reviewable Postgres storage contract for ASX screener historical runs.

## Schema

The schema is committed at:

- `migrations/001_investment_screener_history.sql`

It is intentionally non-destructive: table creation uses `CREATE TABLE IF NOT EXISTS`, indexes use `CREATE INDEX IF NOT EXISTS`, and compatibility additions use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. It must be reviewed before applying to any live database.

Tables covered:

- `investment_screener_runs` — idempotent run records keyed by `run_key`.
- `investment_screener_companies` — stable ASX company/security identity.
- `investment_screener_observations` — raw normalized fields, derived fields, missing fields, source quality, and dates per company/run.
- `investment_screener_scores` — ranks, score components, risk flags, caveats, score caps, and scorer version per company/run.
- `investment_screener_provenance` — normalized field-level evidence rows.
- `investment_screener_price_snapshots` — reserved schema for later performance snapshots.

## Runtime credentials

Do not commit database URLs, passwords, `.env` files, provider tokens, or local operator paths.

The CLI reads the database URL only from a runtime environment variable:

```bash
export SCREENER_OUTPUT_DIR="<runtime-output-directory>"
DATABASE_URL="$(vaultwarden-rendered-secret)" \
python3 screener.py --fixture \
  --write-postgres-history \
  --run-key investment-screener:ASX:fixture:YYYY-MM \
  --output-dir "$SCREENER_OUTPUT_DIR"
```

In the homelab, render that environment variable from the existing Vaultwarden reference for the personal-dashboard Postgres connection: folder `homelab`, item `personal-dashboard/database`, field `database_url`. Commit only that folder/item/field reference, not the secret value.

The live ASX cron should use a least-privilege database role, not the shared Postgres superuser. Current intended grants for the existing `dashboard_user` credential are limited to `USAGE` on schema `public`, `SELECT, INSERT, UPDATE` on the six `investment_screener_*` tables, and `USAGE, SELECT` on their sequences. If a dedicated screener-writer credential is created later, move those same grants to that role and revoke them from `dashboard_user`.

Use `--database-url-env NAME` if the runtime chooses a different environment variable name. The variable value itself must stay outside Git and outside process command lines.

## Idempotency

Scheduled jobs should pass a stable `--run-key` derived from market, cadence, period, universe hash, config hash, and code version. Re-running the same logical run upserts the run/company/observation/score rows instead of creating duplicate history.

## Local verification

Unit tests use fake connections only:

```bash
python3 -m pytest tests/test_postgres_history_storage.py -v
```

The full screener test suite also avoids live Postgres credentials:

```bash
python3 -m pytest tests -v
```

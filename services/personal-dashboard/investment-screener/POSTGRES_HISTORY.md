# Investment screener Postgres history

This directory contains the reviewable Postgres storage contract for ASX screener historical runs.

## Schema

The schema is committed at:

- `migrations/001_investment_screener_history.sql`

It is intentionally non-destructive: table creation uses `CREATE TABLE IF NOT EXISTS`, indexes use `CREATE INDEX IF NOT EXISTS`, and compatibility additions use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. It must be reviewed before applying to any live database.

Tables covered:

- `investment_screener_runs` — idempotent run records keyed by `run_key`, now also carrying `universe_metadata` (denominator/status/filters/batch/seed hash) and sanitized `provider_failures`.
- `investment_screener_companies` — stable ASX company/security identity.
- `investment_screener_observations` — raw normalized fields, derived fields, missing fields, source quality, dates, and multi-source consolidation outcomes (`selected_fields` with selection reason, `alternates`, `conflicts`, `field_quality`, `source_confidence`) per company/run.
- `investment_screener_scores` — ranks, score components, risk flags, caveats, score caps, and scorer version per company/run.
- `investment_screener_provenance` — normalized field-level evidence rows.
- `investment_screener_price_snapshots` — reserved schema for later performance snapshots.

## Runtime credentials

Do not commit database URLs, passwords, `.env` files, provider tokens, or local operator paths.

The CLI reads the database URL only from a runtime environment variable:

```bash
# Fixture validation, no network calls.
export SCREENER_OUTPUT_DIR="<runtime-output-directory>"
DATABASE_URL="$(vaultwarden-rendered-secret)" \
python3 screener.py --fixture \
  --write-postgres-history \
  --run-key investment-screener:ASX:fixture:YYYY-MM \
  --output-dir "$SCREENER_OUTPUT_DIR"

# Bounded real ASX bootstrap hydration, using Yahoo public endpoints.
# Keep the database URL in the runtime environment only; do not paste or log it.
DATABASE_URL="$(vaultwarden-rendered-secret)" \
python3 screener.py --asx-watchlist universe/asx-watchlist.json \
  --max-tickers 25 \
  --sleep-seconds 1.0 \
  --cache-dir "$SCREENER_OUTPUT_DIR/provider-cache" \
  --output-dir "$SCREENER_OUTPUT_DIR" \
  --write-postgres-history \
  --run-key investment-screener:ASX:asx-yahoo-timeseries:YYYY-MM:<universe-hash>:<config-hash>:<code-version>
```

In the homelab, render that environment variable from the existing Vaultwarden reference for the personal-dashboard Postgres connection: folder `homelab`, item `personal-dashboard/database`, field `database_url`. Commit only that folder/item/field reference, not the secret value.

The live ASX cron should use a least-privilege database role, not the shared Postgres superuser. Current intended grants for the existing `dashboard_user` credential are limited to `USAGE` on schema `public`, `SELECT, INSERT, UPDATE` on the six `investment_screener_*` tables, and `USAGE, SELECT` on their sequences. If a dedicated screener-writer credential is created later, move those same grants to that role and revoke them from `dashboard_user`.

Use `--database-url-env NAME` if the runtime chooses a different environment variable name. The variable value itself must stay outside Git and outside process command lines. The real ASX mode is labeled `asx-yahoo-timeseries` in both the sanitized latest export and Postgres `investment_screener_runs.mode`; it is non-fixture but still a bootstrap/unofficial provider source, not ASX filings verification.

## Read-only verification queries

After an approved deploy/backfill card runs the live mutation, verify with read-only SQL. These queries should be run inside a transaction opened as read-only and rolled back:

```sql
select mode, market, count(*) as runs, max(completed_at) as latest_completed
from investment_screener_runs
group by mode, market
order by latest_completed desc;

select r.mode, r.market, count(*) as score_rows,
       count(*) filter (where s.excluded) as excluded_rows
from investment_screener_scores s
join investment_screener_runs r on r.id = s.run_id
group by r.mode, r.market
order by r.mode, r.market;

select r.mode, r.market, count(distinct c.ticker) as companies,
       count(o.id) as observations, max(o.created_at) as latest_observation
from investment_screener_runs r
join investment_screener_scores s on s.run_id = r.id
join investment_screener_companies c on c.id = s.company_id
left join investment_screener_observations o on o.run_id = r.id and o.company_id = c.id
group by r.mode, r.market
order by latest_observation desc nulls last;

select r.mode, c.ticker, p.field_name, p.source_family, p.data_as_of, p.retrieved_at
from investment_screener_provenance p
join investment_screener_runs r on r.id = p.run_id
join investment_screener_companies c on c.id = p.company_id
where r.market = 'ASX' and r.mode <> 'fixture'
order by p.retrieved_at desc nulls last
limit 20;
```

Passing state for real backfill requires at least one ASX `mode <> 'fixture'` run with non-zero company, observation, score, and provenance rows. Fixture rows prove only the storage path. Small but important distinction; databases love technically true lies.

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

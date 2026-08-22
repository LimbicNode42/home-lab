# Personal Dashboard

Private homelab dashboard MVP for household links and lightweight service status.

Status: implementation/deployment candidate only. Do not deploy, sync Traefik config, restart services, create Cloudflare hostnames, or enable Kanban mutations until Ben approves the exact apply commands.

Kanban board freshness and mutation planning lives in [`kanban-state-bridge-plan.md`](./kanban-state-bridge-plan.md). That plan deliberately separates read-only tori board snapshots from any future narrow mutation bridge.

## What is included

- Small dependency-free Node.js full-stack app.
- Static dashboard UI served from `public/`.
- JSON APIs:
  - `GET /healthz` unauthenticated container/proxy health endpoint; intentionally returns only `{ "status": "ok" }`.
  - `GET /api/config/public` authenticated public dashboard config, with server-side probe targets stripped.
  - `GET /api/status` authenticated status probe results, using an in-memory TTL cache.
  - `GET /api/finnick/report` authenticated endpoint that returns the latest Finnick/Polymarket daily betting report as `{ "content": "..." }` (see [Finnick report panel](#finnick-report-panel)).
  - `GET /api/investment-screener/ranked` and `GET /api/investment-screener/report` authenticated endpoints that return sanitized generated investment screener output with freshness metadata and doc links (see [Investment screener panel](#investment-screener-panel)).
  - `GET /api/docs` and `GET /api/docs/:id` authenticated documentation endpoints backed by an approved committed Markdown manifest (see [Documentation panel](#documentation-panel)).
  - `GET /api/epics` authenticated completed-epics endpoint that reads Kanban via Node's in-process SQLite API and exposes only redacted task summaries and committed GitHub doc links.
- Reverse-proxy authentication gate by default.
- Dockerfile and Compose service for local/homelab container runs.
- Node built-in test suite covering auth, config, status, Finnick, Kanban, completed epics, and documentation endpoints.

## Source evidence / deployment constraints

Discovery identified `/root/work/home-lab/services/personal-dashboard` as the Git-backed desired-state location. The safest current remote-access target is the `critical` LXC (`192.168.0.50`), which already hosts Traefik, cloudflared, Vaultwarden, and shared Postgres. This directory prepares desired-state only; it does not modify live infrastructure.

Historical `dev`/Toyota evidence is not treated as current live state. The old Postgres-backed seed has been replaced for MVP with a no-database app per the parent spec.

## Proposed live route

- Public hostname: `dashboard.wheeler-network.com`
- Cloudflare Tunnel public hostname origin: `http://192.168.0.50:80`
- Traefik entrypoint/router: `web`, ``Host(`dashboard.wheeler-network.com`)``
- Traefik backend service: `http://172.17.0.1:4322` from the `proxy` container to the Docker host gateway
- Dashboard container: `personal-dashboard`, listening on container port `4322`
- Compose host publish: `${DASHBOARD_PUBLISHED_IP:-172.17.0.1}:4322:4322`
- Auth expectation: Cloudflare Access protects the public hostname and forwards `cf-access-authenticated-user-email`; the app requires that header for `/api/*`.

The direct LAN route to `192.168.0.50:4322` must not be published. The app trusts Cloudflare Access identity headers, so direct LAN clients must not be able to reach the API and forge `cf-access-*` headers. The Traefik dashboard router also limits source IPs to Docker private ranges so LAN clients cannot bypass Cloudflare Access by sending Host-header requests to Traefik directly. If Traefik and this app are later moved to a user-defined Docker network, prefer an un-published container port and route by service DNS instead.

## Auth model

Default deployment candidate: `DASHBOARD_AUTH_MODE=reverse-proxy` with `DASHBOARD_PROXY_USER_HEADER=cf-access-authenticated-user-email`.

In reverse-proxy mode the app requires a non-empty identity header before serving `/api/*`. `DASHBOARD_AUTH_MODE=disabled` exists for local development and tests only. In `NODE_ENV=production`, disabled auth is refused unless `DASHBOARD_ALLOW_DISABLED_AUTH=true` is explicitly set. That flag is a foot-gun with a label, not a recommendation.

Ben decisions still required before public exposure:

- Confirm Cloudflare Access policy/users/groups for `dashboard.wheeler-network.com`.
- Confirm canonical dashboard URL/hostname.
- Confirm which services/links are safe for authenticated household users.
- Confirm whether status checks should target internal backend URLs or public route URLs server-side.

## Config

Copy the example public config and edit it for the target environment:

```bash
cp config/dashboard.public.example.json config/dashboard.public.json
```

Config shape:

```json
{
  "title": "Home Dashboard",
  "sections": [
    {
      "title": "Core services",
      "links": [
        { "label": "Vaultwarden", "href": "https://vault.wheeler-network.com" }
      ]
    }
  ],
  "statusChecks": [
    {
      "id": "vaultwarden",
      "label": "Vaultwarden",
      "targetUrl": "http://192.168.0.50:8084/alive",
      "displayUrl": "https://vault.wheeler-network.com"
    }
  ]
}
```

`targetUrl` is used only server-side and is never returned by `/api/config/public` or `/api/status`. Keep internal topology in config, not in the browser bundle.

Environment variables:

| Name | Default | Notes |
| --- | --- | --- |
| `PORT` | `4322` | HTTP listen port. |
| `HOST` | `0.0.0.0` | HTTP bind address. |
| `DASHBOARD_PUBLISHED_IP` | `172.17.0.1` in `.env.example` | Host IP used by Compose publish for the critical deployment candidate. Keep this on the Docker bridge gateway unless the auth model changes. |
| `DASHBOARD_CONFIG_FILE` | built-in defaults | Path to JSON config file. Compose uses `/app/config/dashboard.public.json`. |
| `DASHBOARD_AUTH_MODE` | `reverse-proxy` | `reverse-proxy` or local-dev `disabled`. |
| `DASHBOARD_PROXY_USER_HEADER` | `cf-access-authenticated-user-email` in `.env.example` | Header trusted from Cloudflare Access or another reverse-proxy auth layer. |
| `DASHBOARD_ALLOW_DISABLED_AUTH` | unset | Must be `true` to allow disabled auth in production. Avoid this outside a private dev tunnel. |
| `DASHBOARD_STATUS_CACHE_TTL_MS` | `30000` | Status result cache TTL. |
| `DASHBOARD_STATUS_PROBE_TIMEOUT_MS` | `2500` | Per-probe timeout. |
| `FINNICK_REPORT_FILE` | unset | Absolute path inside the container to the Finnick report file. Set to `/app/finnick/latest_report.txt` in the critical deployment (read from a read-only directory bind). If unset, `GET /api/finnick/report` returns 503. |
| `PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR` | `/var/lib/personal-dashboard/runtime-cache` | Host-local cache populated by `scripts/sync-runtime-snapshots.sh` and mounted read-only to `/app/config`, `/app/finnick`, `/app/investment-screener`, and `/app/kanban`. Keep this off NAS/NFS. |
| `FINNICK_REPORT_HOST_DIR` | operator-provided host directory | Host-side source directory copied into the runtime cache by Compose preflight / `run-critical-docker.sh`; not mounted into the running container and not read by the app itself. Keep the concrete local path out of runtime-served docs. |
| `INVESTMENT_SCREENER_REPORT_FILE` | unset | Absolute path inside the container to the latest sanitized investment screener text report. Set to `/app/investment-screener/latest_report.txt` in the deployment candidate. |
| `INVESTMENT_SCREENER_RANKED_FILE` | unset | Absolute path inside the container to the latest sanitized ranked investment screener JSON export. Set to `/app/investment-screener/latest_ranked.json` in the deployment candidate. |
| `INVESTMENT_SCREENER_HOST_DIR` | operator-provided host directory | Host-side export directory copied into the runtime cache; must contain `latest_report.txt` and `latest_ranked.json` before container recreate. |
| `PERSONAL_DASHBOARD_DATABASE_URL` | unset | Private Diary/Goals Postgres connection string. Render from Vaultwarden; after the stable Docker network is in place, only the URL host component should be `postgres` instead of a raw bridge IP. If unset, diary/goal APIs return 503 without creating data in surprise locations. |
| `PGSSLMODE` | `require` in Compose / fallback script | TLS mode for the shared critical Postgres service. Keep cert/key material out of this repo. |
| `PERSONAL_DASHBOARD_DB_NETWORK` | `critical-internal` in fallback script | Docker-local internal network used for stable Postgres DNS. Live creation/attachment requires explicit approval. |
| `PERSONAL_DASHBOARD_DB_ALIAS` | `postgres` in fallback script | Stable alias for the shared Postgres container on `critical-internal`; preserve database credentials and change only the Vaultwarden URL host. |

## Local development

```bash
npm test
DASHBOARD_AUTH_MODE=disabled DASHBOARD_ALLOW_DISABLED_AUTH=true DASHBOARD_CONFIG_FILE=./config/dashboard.public.example.json npm start
```

Then open `http://127.0.0.1:4322`.

## Dashboard navigation

The dashboard is organised into six hash-backed tabs. `/` defaults to Overview; direct links such as `/#work`, `/#knowledge`, `/#reports`, `/#diary`, and `/#goals` select the matching tab without adding server routes.

- **Overview**: service status and configured household links.
- **Work**: the Kanban board, still read-only unless the server explicitly enables the mutation bridge.
- **Knowledge**: completed epics first, then the approved documentation viewer.
- **Reports**: Finnick daily betting output and investment screener output.
- **Diary**: private diary entries backed by the shared critical Postgres service.
- **Goals**: private goal tracking backed by the same Postgres personal-data store, with stable goal ids and status/timestamp fields for later diary comparison work. There is no LLM assessment/scoring in the MVP.

Tabs support click, Back/Forward hash changes, and ArrowLeft/ArrowRight/Home/End keyboard navigation. The mobile layout keeps the tab strip horizontal and scrollable rather than turning into a tiny accordion hydra.

To exercise reverse-proxy auth locally:

```bash
DASHBOARD_CONFIG_FILE=./config/dashboard.public.example.json npm start
curl -i http://127.0.0.1:4322/api/config/public
curl -H 'cf-access-authenticated-user-email: ben@example.invalid' http://127.0.0.1:4322/api/config/public
```

## Docker / Compose validation

```bash
cp config/dashboard.public.example.json config/dashboard.public.json
DASHBOARD_PUBLISHED_IP=127.0.0.1 docker compose build
DASHBOARD_PUBLISHED_IP=127.0.0.1 docker compose up
curl http://127.0.0.1:4322/healthz
```

For the critical deployment candidate, render the real non-secret `.env` locally from `.env.example`, render `config/dashboard.public.json`, and keep both out of Git where applicable.


## Runtime artifact mount model

See `docs/runbook.md` for the stale NAS/NFS bind failure mode and recovery steps. In short: externally written report/config/Kanban artifacts are copied into a host-local runtime cache and only that cache is mounted read-only into the container. Direct NAS/NFS binds are avoided because Docker can preserve stale handles across atomic writer replacement or NAS remounts even while the host path reads cleanly. The app still reads the same explicit in-container file paths, so auth behavior and API contracts do not change. Diary/Goals now uses the shared critical Postgres service via `PERSONAL_DASHBOARD_DATABASE_URL`; there is no writable SQLite `/app/data` bind in the dashboard container.

## Apply sequence

1. On `critical`, verify current ports, container state, and redactable Docker network state:
   - `docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'`
   - `netstat -ltnp | grep -E ':(80|443|4322)\\b'` (`ss` is not currently installed on critical)
   - `docker inspect postgres personal-dashboard --format '{{.Name}} {{json .NetworkSettings.Networks}}'`
2. Ensure the stable Postgres network source-of-truth exists before editing the Vaultwarden URL host:
   - `docker network create --internal critical-internal` if the network is absent.
   - `docker network connect --alias postgres critical-internal postgres` if Postgres is not already attached.
3. Update Vaultwarden folder `homelab`, item `personal-dashboard/database`, field `database_url` by changing only the host component from the old raw bridge IP to `postgres`; preserve username/password/port/database/query parameters.
4. Render/copy `services/personal-dashboard` to `/mnt/nas/services/personal-dashboard`, render `config/dashboard.public.json`, and re-render the dashboard `.env` from Vaultwarden.
5. Start only the dashboard container. Preferred once Compose is available:
   - `DASHBOARD_PUBLISHED_IP=172.17.0.1 docker compose up -d --build dashboard`
   Current critical fallback, because the Docker Compose plugin is not installed there:
   - `sh scripts/run-critical-docker.sh`
6. Verify direct health, Postgres alias reachability, and Traefik:
   - `curl -fsS http://172.17.0.1:4322/healthz`
   - `docker exec personal-dashboard node -e "require('node:dns').lookup('postgres', console.log)"`
   - `curl -fsS -H 'Host: dashboard.wheeler-network.com' http://192.168.0.50/healthz`
   - `curl -i http://192.168.0.50:4322/api/config/public -H 'cf-access-authenticated-user-email: forged@example.invalid'` should fail to connect or otherwise not return `200`.
7. Sync the prepared Traefik `dynamic-config.yaml` route to `/mnt/nas/services/traefik/dynamic-config.yaml`.
8. Verify Traefik loaded the route; if the NAS file-provider watcher misses the update, restart only `proxy` after approval.
9. Create the Cloudflare Tunnel public hostname and Access policy described in `../cloudflare-tunnel/dashboard-public-hostname-plan.md`.
10. Verify public route with Cloudflare Access identity headers and confirm unauthenticated access is denied by Access/app.

## Rollback

- Restore the prior Vaultwarden `personal-dashboard/database` `database_url` host component (for example the previous bridge IP) without rotating credentials, re-render `.env`, and rerun `sh scripts/run-critical-docker.sh` to recreate only the dashboard container.
- If the rollback target should no longer use the Docker-local DB network, disconnect only the dashboard container from `critical-internal` after it is healthy on the restored URL. Leave Postgres data and credentials untouched.
- Remove/disable the Cloudflare public hostname `dashboard.wheeler-network.com` and any associated Access application/policy.
- Revert `/mnt/nas/services/traefik/dynamic-config.yaml` to the previous version and reload/restart only `proxy` if required.
- Stop/remove only the dashboard container: `docker compose down` from the approved dashboard live path.
- Leave rendered config files in place for inspection unless Ben explicitly approves deletion.

## Finnick report panel

The dashboard includes a live panel that surfaces the Finnick/Polymarket daily betting report generated by the `kobold` Hermes profile.

### User-facing location

The panel appears on the dashboard home page (`dashboard.wheeler-network.com`) as the third section: **"Finnick — Daily Betting Report"**. It loads automatically on page open and has a manual **Refresh** button. It renders the report as pre-formatted text.

Error states surfaced to the user:

| Condition | Message |
| --- | --- |
| Report not yet generated (before 08:00 AEST cron) | "No report yet — check back after the 08:00 AEST cron runs." |
| `FINNICK_REPORT_FILE` not set in container | "Finnick report is not configured on this instance." |
| Any other read error | "Report unavailable: \<error message\>" |

### Technical entry points

| Layer | Location | Role |
| --- | --- | --- |
| API route | `src/server.js` → `GET /api/finnick/report` | Reads the report file from `FINNICK_REPORT_FILE`, returns `{ content: "..." }` or an error object |
| Frontend panel | `public/index.html` `#finnick-panel`, `public/app.js` `refreshFinnick()` | Fetches the API on load and on Refresh click, renders `<pre class="finnick-report">` |
| Deploy script | `scripts/run-critical-docker.sh` | Copies the host Finnick directory's latest report into the local runtime cache, then bind-mounts that cache read-only into the container at `/app/finnick`; the app reads `/app/finnick/latest_report.txt` |
| Report source | Kobold cron writes the latest report on `critical` at 08:00 AEST | The rendered host path is operator-local and must stay out of runtime-served docs. |

**`createApp()` option / env var:**

```
FINNICK_REPORT_FILE=/app/finnick/latest_report.txt
```

The container environment uses `FINNICK_REPORT_FILE=/app/finnick/latest_report.txt`. The host-side source directory is controlled by `FINNICK_REPORT_HOST_DIR` in `.env.example` / `run-critical-docker.sh`, but the running container only sees the local runtime-cache copy.

Explicit `null` passed to `createApp({ finnickReportFile: null })` overrides any env var — used by tests to force the unconfigured state without polluting the process environment.

### Verify locally

```bash
# Run tests (includes 4 Finnick-specific tests)
npm test

# Smoke-test the endpoint with a fixture file
echo "test report" > /tmp/test-report.txt
FINNICK_REPORT_FILE=/tmp/test-report.txt \
  DASHBOARD_AUTH_MODE=disabled \
  DASHBOARD_ALLOW_DISABLED_AUTH=true \
  node src/server.js &
curl -s http://127.0.0.1:4322/api/finnick/report
# Expected: {"content":"test report"}
kill %1
```

### Verify on critical (192.168.0.50)

```bash
# Health check
curl -fsS http://172.17.0.1:4322/healthz

# Finnick endpoint — requires the cf-access-authenticated-user-email header
curl -s http://172.17.0.1:4322/api/finnick/report \
  -H 'cf-access-authenticated-user-email: ben@example.invalid'
# Returns {"content":"..."} after 08:00 AEST; {"error":"report_not_found"} before first cron run
```

### Redeploy after source changes

```bash
# On critical, from the synced NAS path:
sh /mnt/nas/services/personal-dashboard/scripts/run-critical-docker.sh
```

This rebuilds the image and recreates the container with the read-only report directory bind intact. The report file on the host is untouched.

## Investment screener panel

The dashboard includes an authenticated **Investment Screener** panel for the latest generated value-growth screener output. It is intentionally file-backed and read-only: an external writer exports sanitized files, then the dashboard reads those files through read-only container mounts.

The screener is an investigation aid only. It is not financial advice, not a rating, not a trading signal, and not a recommendation to buy/sell/hold anything. Treat every candidate as a prompt for human due diligence against primary filings or an authorised market-data source.

### Product documentation

Human-facing Investment Screener docs now live under `services/personal-dashboard/docs/products/investment-screener/` and are included in the dashboard's approved documentation manifest:

| Doc | Purpose |
| --- | --- |
| [Product guide](./docs/products/investment-screener/README.md) | What the screener is for, who should use it, and the deliverable map. |
| [CLI and generator](./docs/products/investment-screener/cli-generator.md) | How the generator artifact produces safe ranked JSON and report outputs. |
| [Dashboard panel](./docs/products/investment-screener/dashboard-panel.md) | How to use the Reports-tab panel and understand its controls. |
| [Interpreting results](./docs/products/investment-screener/interpreting-results.md) | How to read scores, filters, risk flags, caveats, and suggestion counts. |
| [Historical pipeline architecture](./docs/products/investment-screener/historical-pipeline-architecture.md) | ASX-first universe, data sources, Postgres history, recurrence, and dashboard evolution contract. |
| [Operations and limitations](./docs/products/investment-screener/operations-limitations.md) | Runbook, trust boundaries, troubleshooting, and future improvements. |

The sections below remain the implementation/API notes for maintainers; the product docs above are the intended starting point for humans trying to use the screener without reading JSON.

### User-facing location and controls

The panel appears in the **Reports** tab as **"Investment Screener"**. It loads automatically when the Reports tab is opened and has a manual **Refresh** button.

Default behavior:

- **Market**: `All markets`, with `Australia / ASX` as the current first-class populated option.
- **Exchange / Region / Sector / Industry**: visible but disabled in the current dashboard because the sanitized ranked output does not yet export those fields safely.
- **Score focus**: `Composite score`.
- **Weight preset**: `Balanced`.
- **Suggestions**: `Top 6`.

Available controls:

| Control | What it does |
| --- | --- |
| Market | Filters candidates by the `market` field already present in the sanitized ranked JSON. Current UI options are `All markets` and `Australia / ASX`; US, Japan, and Switzerland are not shown as active choices until the mounted dashboard export actually contains those markets. The API still accepts any plain label matching the validation regex for future exports. |
| Exchange / Region / Sector / Industry | Disabled with coming-later copy until those fields are present in the sanitized ranked export. The backend accepts those query keys only to return a clear unsupported-filter error instead of pretending an empty result is meaningful. |
| Score focus | Re-sorts the already-sanitized candidates by a public sub-score. Supported safe values are `composite`/default, `quality`, `valuation`, `growth`, `graham_safety`, `durability`, and `risk_adjustments`. |
| Weight preset | Applies the same public sub-score sort as a preset tilt. Supported safe values are `balanced`/default, `quality`, `valuation`, `growth`, `graham_safety`, `durability`, and `risk_adjustments`. |
| Search | Searches the sanitized candidate universe by ticker, company name, market, or currency using plain text. |
| Suggestions | Sets the page size to 3, 6, 10, or 25 visible candidates. The API also accepts `limit` up to 100 for clients that need larger pages. |
| Previous / Next | Pages through the sanitized candidate universe without requiring the generator to emit only a tiny top-N list. |
| Reset filters | Clears search, restores All markets, Composite score, Balanced weight, and Top 6 page size, then refreshes the first page. |

The panel renders ranked candidates with ticker, name, market/currency, score, selected risk flags, caveats, compact sanitized provenance where available, generated timestamp, data-as-of timestamp, visible applied filter state, limitations, and links to the committed investment screener product docs. Fixture output is explicitly labelled as sample data, not a proven ASX scrape/backfill.

### Dashboard API filters and validation

`GET /api/investment-screener/ranked` supports these query parameters:

| Parameter | Accepted values | Behavior |
| --- | --- | --- |
| `q` | Plain text company/ticker search matching `/^[\p{L}\p{N}][\p{L}\p{N} ._&'()-]{0,119}$/u` | Case-insensitive contains search over sanitized ticker, name, market, and currency fields. |
| `market` | Plain market label matching `/^[a-z0-9][a-z0-9 ._-]{0,79}$/i` | Exact, case-insensitive match against candidate `market`. |
| `exchange`, `region`, `sector`, `industry` | Any non-empty value currently rejected | Returns `400 unsupported_investment_screener_filter` because these fields are not available in the sanitized dashboard export yet. |
| `metric` | `composite`, `quality`, `valuation`, `growth`, `graham_safety`, `durability`, `risk_adjustments` | Re-sorts by the selected public sub-score unless `composite` is selected. |
| `weight` | `balanced`, `quality`, `valuation`, `growth`, `graham_safety`, `durability`, `risk_adjustments` | Re-sorts by the selected tilt unless `balanced` is selected. |
| `topN` | Integer `1` through `100` | Backward-compatible alias for page size when `limit` is absent. |
| `limit` | Integer `1` through `100` | Candidate page size. Defaults to 25 when filters are active and no page size is provided. |
| `offset` | Non-negative integer | Candidate page offset for browsing beyond the first page. |

Unsupported query keys return `400 unsupported_investment_screener_filter`. Invalid search text, market labels, metric values, weight presets, page limits, offsets, or top-N values return `400 invalid_investment_screener_filter`. When filters are valid but match nothing, the API returns `200` with an empty `candidates` list and the message: "No candidates match the selected investment screener filters. Try clearing one filter or waiting for richer ranked data." No-match is not treated as a server error; the goblin found zero mushrooms, not a fire.

Other user-visible error states:

| Condition | Message |
| --- | --- |
| Ranked output not yet generated | "No investment screener output yet — run the screener export first." |
| Screener output env vars not set in container | "Investment screener output is not configured on this instance." |
| Any other read/parse error | "Investment screener unavailable: \<error message\>" |

### Data contract

The screener CLI `--output` file is now the dashboard-safe ranked JSON object consumed by `GET /api/investment-screener/ranked`. It is not the raw internal scorer output and it is not an array. The CLI writes this object shape:

```json
{
  "mode": "fixture|live|asx-yahoo-timeseries|unknown",
  "generated_at": "ISO timestamp",
  "data_as_of": "ISO timestamp, source string, or null",
  "limitations": ["safe strings, including filter/top_n notes when relevant"],
  "candidates": [
    {
      "rank": 1,
      "ticker": "BRK-B",
      "name": "Berkshire Hathaway",
      "market": "US",
      "currency": "USD",
      "score": 91.4,
      "sub_scores": {
        "quality": 28,
        "valuation": 17,
        "growth": 14,
        "graham_safety": 18,
        "durability": 13,
        "risk_adjustments": 10
      },
      "missing_penalty_points": 0,
      "risk_flags": ["safe strings"],
      "caveats": ["safe strings"],
      "score_caps": ["safe strings"],
      "sanitized_provenance_summary": "safe string or null"
    }
  ],
  "excluded": []
}
```

The dashboard API reads that object, sanitizes it again, caps sanitized `candidates` and `excluded` to 500 rows each before API filtering/pagination, normalizes `mode` to `fixture`, `live`, `asx-yahoo-timeseries`, or `unknown`, and adds the dashboard-only fields `disclaimer` and `doc_links`. When API query filters are active, it also adds `applied_filters` and `messages`, for example:

```json
{
  "applied_filters": { "q": "berkshire", "market": "US", "metric": "quality", "weight": "quality", "limit": 10 },
  "total_candidates": 1,
  "displayed_count": 1,
  "pagination": { "limit": 10, "offset": 0, "total": 1, "has_more": false, "next_offset": null, "previous_offset": null },
  "messages": ["Showing 1 of 1 candidate after the selected filters."]
}
```

`GET /api/investment-screener/report` returns a sanitized plain-text report projection with `{ mode, generated_at, data_as_of, disclaimer, content, doc_links }`.

Sanitization strips or nulls local paths, Kanban DB names, stderr/diagnostic references, broad raw metadata, bearer tokens, and secret-shaped assignments before API responses reach the browser. The endpoint never returns the configured host path or task bodies.

### Screener artifact usage

The backend screener artifact exposes these safe local commands:

```bash
# Fixture sample, no network required.
python3 investment_screener.py --fixture --mode full

# Filter by fields present in the input data and limit suggestions.
python3 investment_screener.py --fixture --market US,JP --top-n 5

# Re-weight categories for a run; safe names are quality, valuation, growth,
# graham_safety, durability, and risk_adjustments. Values must be numeric and non-negative.
python3 investment_screener.py --fixture --weight quality=30 valuation=20

# Select displayed metrics/categories in the full report.
python3 investment_screener.py --fixture --mode full --metric pe_ratio,quality,fcf_margin

# Save the dashboard-safe ranked JSON object plus the plain-text report.
# The JSON is the object contract consumed by /api/investment-screener/ranked.
python3 investment_screener.py --fixture --output ranked.json --report report.txt

# Run the artifact tests.
python3 -m unittest tests/test_screener.py -v
```

The screener config includes `suggestion_count.min` and `suggestion_count.max` bounds for `--top-n` / `--count`; the current artifact documents a max of 25. CLI filter support covers `market`, `exchange`, `region`, `sector`, and `industry` only where those fields exist in the supplied universe. The built-in fixture has `market`; exchange/region/sector/industry require richer input rows. If a requested field is absent, the CLI exits with an explicit error rather than returning mystery-empty output. If supported filters match no rows, the CLI succeeds and writes a valid ranked JSON object with empty `candidates`/`excluded` lists plus the applied filter note in `limitations`.

Live Yahoo Finance mode remains prototype-only and guarded by `--allow-unofficial-yahoo-live`. It uses unofficial Yahoo endpoints with basic caching/retry/throttling and should not be treated as reliable coverage. Keep it out of unattended dashboard publication unless Ben has explicitly approved the data-source risk.

### Data caveats

- Fixture data is illustrative/backfill data and may be stale. `generated_at` says when the report was produced, not when the underlying financials became fresh.
- Live/prototype data can be incomplete, missing fields, or source-dependent. Fields are only filterable where present and supported in the sanitized export.
- Dashboard filtering is applied after sanitization to the currently mounted ranked JSON. It does not fetch fresh market data and does not recompute raw financial metrics.
- Scores are simplified Graham/Buffett/Munger-style screening heuristics, not a valuation model. International FX is not normalized, and cross-market scores are not strictly comparable.
- Risk flags, caveats, missing-data penalties, and score caps are part of the output and should be read before treating a high score as interesting.

### Local run and test commands

These are safe local checks and do not deploy anything:

```bash
# Dashboard tests. Requires Node >=22; the wrapper falls back to npx node@22 when needed.
npm test

# Local dashboard candidate with auth disabled only for local testing.
DASHBOARD_AUTH_MODE=disabled DASHBOARD_ALLOW_DISABLED_AUTH=true DASHBOARD_CONFIG_FILE=./config/dashboard.public.example.json npm start
```

Manual UI regression: open `/#reports`, confirm the Investment Screener panel loads or shows the safe empty/error state, change Market / Score focus / Weight preset / Suggestions, use Reset filters, and confirm no browser console errors.

### Approval-gated deployment notes

Do not deploy, restart the live dashboard, recreate the container, sync Traefik, or publish new hostnames without Ben approving the exact apply commands.

When approval is granted, Compose and `scripts/run-critical-docker.sh` expect these bounded host-side source directories and their expected files to exist before container recreate. `scripts/sync-runtime-snapshots.sh` copies them into `${PERSONAL_DASHBOARD_RUNTIME_CACHE_DIR:-/var/lib/personal-dashboard/runtime-cache}` and the container mounts that local cache. The script will fail fast if any expected source file is missing or not a regular file.

Read-only data sources (external-writer-owned):

- `FINNICK_REPORT_HOST_DIR` → runtime-cache `finnick/` → `/app/finnick` (app reads `latest_report.txt`)
- `INVESTMENT_SCREENER_HOST_DIR` → runtime-cache `investment-screener/` → `/app/investment-screener` (app reads `latest_report.txt` and `latest_ranked.json`)
- `KANBAN_DB_HOST_DIR` → runtime-cache `kanban/` → `/app/kanban` (app reads `kanban.db`; use a readable snapshot, not the Hermes runtime DB directly)

Persistent personal-data store (Postgres; render secrets before first deploy):

- Shared service: `services/postgres` on `critical` (`192.168.0.50:5432`), TLS enabled, data at `/mnt/nas/services/postgres`.
- Secret source: Vaultwarden folder `homelab`, item `personal-dashboard/database`, field `database_url` → `PERSONAL_DASHBOARD_DATABASE_URL`.
- `scripts/run-critical-docker.sh` may source an operator-local rendered env file at `/root/.hermes/rendered/personal-dashboard.env` (override with `PERSONAL_DASHBOARD_ENV_FILE`). Keep that file out of Git, mode `0600`, and render it from the Vaultwarden reference above.
- Use a dedicated database/user for the dashboard; do not reuse or commit the shared Postgres superuser password. The same dedicated `dashboard_user` may be granted least-privilege `SELECT, INSERT, UPDATE` plus sequence usage on the six `investment_screener_*` history tables so the ASX cron can write history without a Postgres superuser credential.
- The app creates its own `goals`, `diary_entries`, and `diary_entry_goals` tables on first connection. Creating the database/user and rendering the connection URL are deploy prerequisites, not repo state.
- Include the dedicated dashboard database in the Postgres backup/restore plan; do not store dumps or rendered connection strings in Git or Kanban comments.
- If the old SQLite Diary/Goals file exists on critical, perform an explicit reviewed backfill into Postgres before declaring the Postgres cutover complete. Do not mount the SQLite file back into the running container as a fallback.

The dashboard's `KANBAN_DB_HOST_DIR` remains a read-only SQLite snapshot source because it mirrors the Hermes Kanban board; that is not the Diary/Goals writable store.

## Documentation panel

The dashboard includes an authenticated **Documentation** panel for a small allowlist of committed, non-secret Markdown files from the `home-lab` repository. The browser renders those Markdown files as structured documentation with headings, lists, tables, code blocks, safe links, per-document table of contents, stable heading anchors, grouped navigation, client-side metadata search, and selected-document state.

### Safety model

- The browser can list approved docs with `GET /api/docs` and fetch one by opaque manifest id with `GET /api/docs/:id`.
- The browser cannot submit a filesystem path or browse repository directories.
- The API response uses repo-relative metadata paths and never accepts browser-supplied filesystem paths.
- Only `.md` files present in the committed-path manifest / Git `HEAD` are eligible.
- Uncommitted scratch artifacts, traversal paths, `.env`/secret-shaped files, and malformed manifest entries are silently excluded.
- Document content is read from `REPO_DOCS_ROOT` (defaulting to the local repo root in development and `/app/repo-docs` in the container) and then projected through a runtime sanitizer before being returned. The projection drops lines containing local filesystem paths, DB paths, command stderr/diagnostics, or secret-shaped assignments.
- The docs viewer reads committed Markdown content only after the id survives the manifest filter. Raw HTML in docs is not injected into the DOM; Markdown is converted with DOM nodes/text content, and Markdown links are limited to `http`, `https`, `mailto`, or same-page anchors with `rel="noopener noreferrer"` on new-tab links.
- Document `category` or `group` manifest metadata is optional and used only for navigation grouping after the same sanitizer used for other runtime values. Unsafe category values are dropped rather than served.
- This is for operator-readable documentation, not a generic file server wearing a moustache.

Default approved docs currently include:

- `services/personal-dashboard/README.md` (`Dashboard` category)
- `services/personal-dashboard/docs/products/investment-screener/*.md` (`Investment Screener` category)
- `docs/service-catalog.md` (`Operations` category)
- `docs/backup-coverage-matrix.md` (`Operations` category, when present in the committed manifest)

To add a new dashboard doc:

1. Create or update a `.md` file under the `home-lab` repo. Keep it committed, non-secret, and free of local absolute paths, DB paths, stderr/diagnostic dumps, and credential-shaped assignments.
2. Add the repo-relative Markdown path to `DEFAULT_DOCS_MANIFEST` in `src/server.js` with a stable opaque `id`, human `title`, and optional `category`/`group` for the navigation list.
3. Ensure the path appears in `config/home-lab-committed-files.txt` (generated from committed repo files for container trust-boundary checks).
4. Run `npm test` and manually open Knowledge → Documentation to confirm the doc renders with headings/TOC/anchors rather than raw text.

Completed epics continue to expose outbound GitHub blob links for relevant scribe artifacts where available. Those links are built from committed repo-local artifact paths only and avoid exposing task bodies or secret-shaped values.

## Kanban DB runtime

The dashboard container reads its mounted Kanban SQLite database via Node's built-in `node:sqlite` module, not the `sqlite3` CLI. This avoids the prior subprocess permission failure path in the `node:22-alpine` runtime and keeps the Docker image free of an extra SQLite subprocess dependency.

The host-side source is `KANBAN_DB_HOST_DIR`, defaulting to the dashboard's operator-managed read-only Kanban snapshot directory in Compose and `scripts/run-critical-docker.sh`. Use a readable snapshot/export at `kanban.db` in that directory. The deploy scripts copy it into the host-local runtime cache, which is the actual container bind source. Do not bind the Hermes runtime DB directly: it is commonly root-owned under a private home directory, while the container runs as `USER node`.

If the DB path is missing, not a file, unreadable, or fails a query, Kanban-backed APIs return a sanitized `503 { "error": "kanban_db_unavailable", ... }` instead of silently returning empty epics/cards. The response intentionally omits host paths and SQLite diagnostics; check server logs for the grimy details.

Kanban UI/API behavior remains read-only by default. `KANBAN_MUTATIONS_ENABLED` is not set by Compose or the live run script; mutation bridge work is out of scope until explicitly approved.

Container regression smoke:

```bash
# Start a local candidate with DASHBOARD_AUTH_MODE=disabled and a readable test DB bind.
npm run smoke:container
# Expected: container smoke passed: /api/epics includes t_a1193120
```

### Intended future expansion

The Finnick report panel is the first of three planned data panels on the dashboard:

1. **Homelab health analytics** — aggregate metrics from Proxmox nodes, containers, and NAS into a compact status summary. Likely fed by a periodic Hermes cron scraping internal APIs and writing a similar `latest_report.txt` file.
2. **Personal health analytics** — personal health tracking data (source TBD) surfaced in a dedicated panel via the same bind-mount + file-read pattern.
3. **Personal blog** — link/embed the personal blog or recent posts once the blog is live.

Each future panel will follow the same pattern: a Hermes cron (kobold or another profile) writes a plain-text or JSON report to a well-known host path; the dashboard syncs it into the host-local runtime cache, then picks it up via a read-only cache bind-mount and a dedicated `GET /api/<name>/report` route.

## Tests

```bash
npm test
```

`npm test` requires Node >=22 because the server uses `node:sqlite`. When the host `node` is older, the test wrapper prints that fact and runs the suite through `npx -y node@22 --test`; failures after that are real test failures, not host-version noise.

The suite covers config validation, auth gate behavior, health endpoint topology minimization, status probing, hiding server-side target URLs, Kanban board/mutation safety, completed-epic doc link sanitization, and documentation viewer allowlist behavior. Five tests specifically cover `GET /api/finnick/report`: unconfigured (503), file missing (404), directory bind-source guard (404 without leaking EISDIR), file present (200 with content), and auth enforcement (401 without proxy header).

### Manual browser regression checklist

Use this for UI-only behavior that the Node built-in test harness cannot prove reliably:

1. Start a local candidate only, without live deployment: `DASHBOARD_AUTH_MODE=disabled DASHBOARD_ALLOW_DISABLED_AUTH=true DASHBOARD_CONFIG_FILE=./config/dashboard.public.example.json npm start`.
2. Open `/` and confirm **Overview** is selected with Service status and Links visible.
3. Open `/#work`, `/#knowledge`, and `/#reports` directly; confirm each tab is selected after reload and only its panel group is visible.
4. Use ArrowLeft/ArrowRight/Home/End on focused tabs; confirm focus and selected tab move predictably.
5. Confirm the mobile/narrow viewport keeps the tab strip horizontally scrollable and panel content readable.
6. In Work, confirm the Kanban panel initially renders compactly, the **Expand board** / **Compact board** control toggles with `aria-expanded`, and the preference persists across reload via `localStorage`.
7. Collapse and expand at least one Kanban lane; confirm its count/title remain visible, cards hide/show by keyboard-operable buttons, and the lane preference persists across reload.
8. Confirm read-only mode is visible and card move controls remain disabled unless the server explicitly reports mutations enabled.
9. In Knowledge, confirm Completed Epics and Documentation load; selecting a document still fetches by opaque manifest id, and the docs search box filters the approved list with a clear no-match state.
10. In Reports, confirm Finnick and Investment Screener load or show their existing safe empty/error states.
11. With browser devtools open, confirm no console errors during initial load, tab changes, Kanban expand/collapse, docs selection, status refresh, and report refreshes.

## Secret handling

No secret values are required for the default MVP. If Ben later chooses app-level auth or Cloudflare automation, store rendered values in Vaultwarden folder `homelab` and commit only item/field/env references in `personal-dashboard.env.map.example`.

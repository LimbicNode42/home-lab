# Unified Inbox — Phase 2 deploy plan (t_6e698bb7)

Status: APPLIED on critical at 2026-09-02T23:59:02Z under Ben's bounded approval. Live mutation was limited to recreating `unified-inbox` and `personal-dashboard`; no gateway, Traefik, Cloudflare, DNS, firewall, credential, provider-app, or data-deletion change was performed.

## What this deploys

Phase 2 read-only chat/workspace connectors (Discord, Telegram, Matrix, Slack),
approved in review t_e98cba4e at commit `33f5355` ("add Phase 2
Discord/Telegram/Matrix/Slack read-only connectors"). No new live network
adapters, no credentials, no upstream API calls, no gateway/Hermes config change.

## Current live state (read-only verified 2026-09-03)

- `critical` (192.168.0.50) runs Phase 1 only:
  - `unified-inbox` container (image `unified-inbox:local`), publish `172.17.0.1:8766:8766`,
    boots `createApp({ store, connectors: [] })`, status `{read_only, ok}`,
    `connectors: []`, `message_count: 0`, both mandatory exclusions present.
  - `personal-dashboard` container (image `personal-dashboard:local`),
    publish `172.17.0.1:4322:4322`; `config/dashboard.public.json` (bind-mounted via
    runtime-cache) still lists the Phase 1 **2-connector** list (discord, telegram)
    with the old detail strings.
- Repo `services/unified-inbox/` contains 5 Phase 2 connector files not present on
  `critical`: `src/connectors/{discord,telegram,matrix,slack,cursor-state}.js`
  (plus 5 matching test files). Everything else is already identical to critical.
- Vaultwarden is locked; no connector credentials exist. All four connectors are
  implemented to report honest `not_configured`/`pending_credentials` health when
  no adapter/config is supplied (verified by tests). No credentials are needed for
  this deploy.

## What is NOT in scope (not performed, not approved)

- Wiring any connector into `index.js` (still `connectors: []`) or instantiating an
  adapter — there are no credentials and no app installs to wire.
- Any credential rendering, bot/app install, gateway config change, or gateway
  restart.
- Traefik / Cloudflare / DNS / firewall / router changes, or LAN/public exposure.
- Any change to Phase 1 connectors, storage model, or the shared Postgres instance.
- Message-body/sender exposure (unchanged; dashboard still shows health/counts only).

## Deployment shape

Two container recreations on `critical`, both bounded and reversible:

### 1. Backend `unified-inbox` — deploy Phase 2 connector source (inert)

Add the 5 new files to the synced app tree and rebuild the image so the connector
code is present for future credential onboarding. The backend still boots
`connectors: []` (honest zero-connector state) because nothing is wired yet.

### 2. Dashboard `personal-dashboard` — surface 4 connectors as `pending_credentials`

Update `config/dashboard.public.json` (bind-mounted) and `src/config.js` (baked
into the image) to list discord/telegram/matrix/slack with `pending_credentials`
state and the Phase 2 detail strings already in commit `33f5355`.

## Bounded apply commands (all on `critical`)

```
# --- Preflight (read-only) ---
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
docker images | grep -E 'unified-inbox|personal-dashboard'

# --- 1. Backend: sync Phase 2 files into the app tree (from tori, tar-over-ssh) ---
#     Copy ONLY the 5 connector files + 5 test files from the repo tree.
#     No secrets are in this tree (verified by reviewer + local scan).

# --- 2. Backend: tag rollback, rebuild, recreate ---
ssh root@192.168.0.50 'docker tag unified-inbox:local unified-inbox:rollback-t_6e698bb7-$(date +%Y%m%dT%H%M%SZ)'
ssh root@192.168.0.50 'cd /mnt/nas/services/unified-inbox/app && sh scripts/run-critical-docker.sh'

# --- 3. Dashboard: tag rollback image ---
ssh root@192.168.0.50 'docker tag personal-dashboard:local personal-dashboard:rollback-t_6e698bb7-$(date +%Y%m%dT%H%M%SZ)'

# --- 4. Dashboard: sync updated config + src/config.js, recreate ---
#     Write the 4-connector config to /mnt/nas/services/personal-dashboard/config/dashboard.public.json,
#     sync src/config.js, then recreate via existing run-critical-docker.sh + sync-runtime-snapshots.sh.
```

## Apply evidence

Applied at `2026-09-02T23:59:02Z` using the bounded procedure above.

- Rollback images created:
  - `unified-inbox:rollback-t_6e698bb7-20260902T235902Z`
  - `personal-dashboard:rollback-t_6e698bb7-20260902T235902Z`
- Deployed file set checksum-matched the reviewed repo files after sync:
  - `services/unified-inbox/src/connectors/{discord,telegram,matrix,slack,cursor-state}.js`
  - `services/unified-inbox/test/{discord,telegram,matrix,slack,cursor-state}.test.js`
  - `services/personal-dashboard/config/dashboard.public.json`
  - `services/personal-dashboard/src/config.js`
- Runtime verification:
  - `unified-inbox` healthy on `172.17.0.1:8766`, `connectors: []`, `message_count: 0`, mandatory WhatsApp/Instagram DM exclusions present.
  - `personal-dashboard` healthy on `172.17.0.1:4322`.
  - Dashboard `/api/unified-inbox/status` shows Discord, Telegram, Matrix, and Slack as `pending_credentials`, with Phase 1 email/RSS/webhook still `not_configured`.
  - Log tails contained only startup lines and the existing Node SQLite experimental warning; no token/session/DB URL/local-path-shaped values were present.
- No provider API hammering observed: backend still boots `createApp({ store, connectors: [] })`; no connector adapters are wired or configured.

## Rollback

- Backend: `ssh root@192.168.0.50 'docker tag unified-inbox:rollback-t_6e698bb7-<ts> unified-inbox:local && cd /mnt/nas/services/unified-inbox/app && sh scripts/run-critical-docker.sh'`
- Dashboard: `ssh root@192.168.0.50 'docker tag personal-dashboard:rollback-t_6e698bb7-<ts> personal-dashboard:local && cd /mnt/nas/services/personal-dashboard && sh scripts/run-critical-docker.sh && sh scripts/sync-runtime-snapshots.sh'`
- App/NAS/runtime dirs are left in place (unchanged from Phase 1). No data is deleted.

## Verification (after apply)

```
curl -fsS http://172.17.0.1:8766/healthz
curl -s http://172.17.0.1:8766/api/unified-inbox/status     # still connectors:[], exclusions, no paths/secrets
# dashboard (with proxy auth header):
#   /api/config/public -> unifiedInbox.expectedConnectors = 4 (discord/telegram/matrix/slack), pending_credentials
#   /api/unified-inbox/status -> service ok, honest pending_credentials for the 4, message_count 0
#   /api/status -> unified-inbox up
# secret scan over rendered tree + logs: no token/session/DB-URL/path values
```

Downstream verification lane t_a6de8100 (sentinel) runs the full read-only evidencing pass.

# Unified Inbox infra/runtime handoff

Status: read-only infrastructure discovery for Kanban task `t_506d50de` under epic `t_cbd02d0c`.

Scope lock: this handoff does not deploy, restart, edit live gateway config, create Cloudflare/Traefik routes, authorize connectors, or mutate any upstream message service. It only records the deployment shape downstream workers should target.

## Read-only sources inspected

- Repo branch/status: `/root/work/home-lab` on `wt/t_f165ad7d`; existing unrelated ASX/dashboard dirty work is present and must not be overwritten.
- Service layout convention: `services/README.md` expects `services/<service>/` with README, env example, compose/runbooks, and explicit Vaultwarden references.
- Dashboard service: `services/personal-dashboard/`, Node ESM, config at `services/personal-dashboard/config/dashboard.public.json`.
- Dashboard critical deploy helper: `services/personal-dashboard/scripts/run-critical-docker.sh`.
- Dashboard runtime snapshot copier: `services/personal-dashboard/scripts/sync-runtime-snapshots.sh`.
- Dashboard status probe implementation: `services/personal-dashboard/src/status.js` and current Overview rendering in `services/personal-dashboard/public/app.js`.
- Traefik notes: `services/traefik/README.md`.
- Cloudflare tunnel notes: `services/cloudflare-tunnel/README.md` and `services/cloudflare-tunnel/dashboard-public-hostname-plan.md`.
- Shared Postgres notes: `services/postgres/README.md`.
- Hermes Discord candidate service docs: `services/hermes-discord/README.md` and `services/hermes-discord/compose.yaml`.
- Architecture parent ADR: `docs/architecture/unified-inbox-readonly-architecture-adr.md`.
- Live read-only probes: local Hermes gateway process/ports; critical LXC Docker container names/status only.

## Observed runtime facts

- `critical` LXC is `192.168.0.50` and currently runs Docker containers `personal-dashboard`, `vaultwarden`, `postgres`, `proxy`, and `cloudflare`.
- No `hermes-discord`, `hermes`, or generic gateway container was observed on `critical` during the read-only Docker probe.
- A Hermes gateway process is running on this host as `/usr/local/lib/hermes-agent/venv/bin/python -m hermes_cli.main gateway run --replace`.
- Local listeners observed on this host:
  - `0.0.0.0:9119` by `hermes` for Hermes dashboard/Kanban.
  - `127.0.0.1:12008` via Docker proxy for MetaMCP.
  - `127.0.0.1:4322` by a local dashboard Node process.
- Kobold profile config is readable at `/root/.hermes/profiles/kobold/config.yaml`; profile secrets are in `/root/.hermes/profiles/kobold/.env` and were not printed or inspected.
- Kobold config has `discord.require_mention: true`, `discord.auto_thread: true`, `discord.history_backfill: true`, `discord.history_backfill_limit: 50`, empty `discord.allowed_channels`, empty `discord.free_response_channels`, and `platform_toolsets.discord: [hermes-discord]`.
- Kanban dispatch runs in the Hermes gateway with `kanban.dispatch_in_gateway: true` and `dispatch_interval_seconds: 60`.

## Recommended service placement

Use the existing service convention:

```text
services/unified-inbox/
├── README.md
├── env.example
├── env.map.example
├── package.json or pyproject.toml
├── src/
├── test/ or tests/
├── docs/
├── scripts/
└── runbooks/
```

Recommended runtime host for first deployment: `critical` (`192.168.0.50`), because it already hosts Traefik, cloudflared, Vaultwarden, and shared Postgres. Deployment should be desired-state first in Git, with an explicit apply gate before any live start/restart.

Do not assume Docker Compose exists on `critical`; mirror the dashboard pattern by keeping a plain Docker fallback script under `services/unified-inbox/scripts/run-critical-docker.sh`. A Compose file is still useful as documentation/local-dev desired state, but the critical lifecycle should not depend on the compose plugin unless a later read-only probe proves it exists.

## Recommended paths

Git/service code:

- Repo path: `/root/work/home-lab/services/unified-inbox/`.
- Critical synced app path: `/mnt/nas/services/unified-inbox/app` or `/mnt/nas/services/unified-inbox` if Ben keeps the current dashboard-style app-root convention.
- Container app path: `/app`.

Host-local writable state, not on NAS/NFS:

- Runtime root: `/var/lib/unified-inbox`.
- Active mutable state: `/var/lib/unified-inbox/state` mounted read/write to `/app/state`.
- Local staging for closed batches before NAS copy: `/var/lib/unified-inbox/snapshots/staging`.
- Local closed batch cache: `/var/lib/unified-inbox/snapshots/closed`.
- Optional local logs: use Docker json-file rotation first; if file logs are added, keep them under `/var/log/unified-inbox` and sanitize by default.

NAS immutable artifact surface:

- NAS service root: `/mnt/nas/services/unified-inbox`.
- Immutable normalized snapshots: `/mnt/nas/services/unified-inbox/snapshots/normalized/`.
- Immutable raw snapshots or restricted raw refs: `/mnt/nas/services/unified-inbox/snapshots/raw/`.
- Batch manifests and hash inventory: `/mnt/nas/services/unified-inbox/manifests/`.
- Dashboard-safe status export, if file-based fallback is needed: `/mnt/nas/services/unified-inbox/status/unified-inbox-status.json`.

Backups should target the NAS immutable snapshot/manifests tree and the shared Postgres database if Postgres projection is enabled. The active OLTP/WAL state must not live under `/mnt/nas`.

## Storage and backup shape

Baseline:

1. Write connector cursors, retry queues, and current ingest staging under `/var/lib/unified-inbox/state`.
2. Write each ingest batch to a temporary host-local file, fsync/close it, then atomically promote it under `/var/lib/unified-inbox/snapshots/closed`.
3. Copy closed immutable artifacts to `/mnt/nas/services/unified-inbox/snapshots/...` only after the batch is complete.
4. Write a manifest per batch under `/mnt/nas/services/unified-inbox/manifests/` with schema version, connector/account refs, record counts, min/max `sent_at`, hash, and copy status.
5. Never rewrite a closed batch in place. Corrections should be new batches that supersede earlier records by stable envelope identity.
6. If using shared Postgres, treat it as a rebuildable query projection, not the canonical store.

Postgres projection option:

- Shared service: `postgres` on critical internal Docker network `critical-internal`, stable alias `postgres`.
- Existing Postgres data mount: `/mnt/nas/services/postgres:/bitnami/postgresql`.
- TLS is already part of the imported Postgres service; keep connection string rendering in Vaultwarden.
- Recommended database name: `unified_inbox`.
- Recommended schema owner/user: `unified_inbox` or a least-privilege app user created in a separate approved DB task.
- Vaultwarden ref: folder `homelab`, item `unified-inbox/database/projection`, field `database_url`.

If Postgres is unavailable, the service should still ingest to local closed snapshots and report query projection `degraded` instead of dropping data.

## Ports and route placeholders

Suggested service defaults:

- Container listen: `HOST=0.0.0.0`, `PORT=8766`.
- Local development URL: `http://127.0.0.1:8766`.
- Critical host publish, if Traefik will route to it: `${UNIFIED_INBOX_PUBLISHED_IP:-172.17.0.1}:8766:8766`.
- Minimal unauthenticated health: `GET /healthz` -> no secrets, no counts, no local paths.
- Authenticated status: `GET /api/unified-inbox/status`.
- Authenticated messages: `GET /api/unified-inbox/messages`.
- Authenticated conversations: `GET /api/unified-inbox/conversations`.

Public or household UI route options, both require later approval:

- LAN-only first: dashboard link to `http://192.168.0.50:8766` only if the auth model is safe for direct LAN users.
- Traefik/Cloudflare later: `https://inbox.wheeler-network.com` through existing cloudflared -> Traefik origin `http://192.168.0.50:80` -> backend `http://172.17.0.1:8766`.

Any Traefik dynamic config edit, Cloudflare Tunnel rule, Cloudflare DNS record, or container restart/recreate is a live mutation requiring Ben approval.

## Vaultwarden reference map

Use folder `homelab`. Commit only these reference names; never values.

```text
UNIFIED_INBOX_DATABASE_URL        | homelab | unified-inbox/database/projection | database_url
UNIFIED_INBOX_SESSION_SECRET      | homelab | unified-inbox/app                 | session_secret
UNIFIED_INBOX_EMAIL_PERSONAL_*    | homelab | unified-inbox/email-imap/personal | imap_host, imap_port, imap_username, imap_password_or_oauth_ref, imap_tls_mode
UNIFIED_INBOX_DISCORD_HOME_*      | homelab | unified-inbox/discord/home-server-bot | bot_token, application_id, guild_id_allowlist, channel_id_allowlist
UNIFIED_INBOX_TELEGRAM_HOME_*     | homelab | unified-inbox/telegram/home-bot   | bot_token, webhook_secret_ref
UNIFIED_INBOX_MATRIX_HOME_*       | homelab | unified-inbox/matrix/home-account | homeserver_url, access_token, user_id, device_id
UNIFIED_INBOX_SLACK_WORKSPACE_*   | homelab | unified-inbox/slack/workspace-bot | bot_token, signing_secret, app_id, workspace_id
UNIFIED_INBOX_RSS_DEFAULT_*       | homelab | unified-inbox/rss/default         | feed_url_ref
UNIFIED_INBOX_ANDROID_*           | homelab | unified-inbox/android-sms-mms/<device> | device_pairing_secret, upload_api_token, device_label
```

Discord connector note: prefer a dedicated read-only Discord bot/app token for Unified Inbox instead of coupling the inbox to the live Hermes gateway token. Reusing Hermes' own Discord bot token would widen blast radius and couple connector health to agent access; do that only after explicit platform-scope review.

## Safe Hermes Discord gateway discovery

Safe read-only discovery performed:

- Read `/root/.hermes/profiles/kobold/config.yaml` for non-secret Discord/gateway settings.
- Checked local process and listening-port state.
- Checked `critical` Docker container list and confirmed no running `hermes-discord` container there.
- Did not read `.env`, print tokens, edit config, restart gateway, sync Discord commands, or call Discord APIs.

Safe future discovery pattern:

1. Read profile config only: `/root/.hermes/profiles/kobold/config.yaml` or target profile `$HERMES_HOME/config.yaml`.
2. Read sanitized logs only when needed: `/root/.hermes/profiles/kobold/logs/agent.log` or gateway-specific logs if present; never paste token-shaped content into docs/handoffs.
3. Use `ps`, `ss`, and `docker inspect` read-only probes for process/container health.
4. If channel/guild IDs or Discord history visibility are required, request explicit Vaultwarden refs or a sanitized export from Ben instead of reading secret env files.
5. Do not run `hermes config set`, `hermes tools`, gateway restart commands, command-sync commands, or any Discord write/sync call from the discovery lane.

Access request for later connector work:

- Minimum: allowed Discord guild IDs, allowed channel/thread IDs, bot/app identity decision, and whether Unified Inbox may use a separate bot token.
- Secret form: Vaultwarden folder `homelab`, item `unified-inbox/discord/home-server-bot`, fields `bot_token`, `application_id`, `guild_id_allowlist`, `channel_id_allowlist`.
- Required Ben approval: invite/install bot, enable privileged intents, expand channel visibility, reuse Hermes bot token, or sync slash/application commands.

## Dashboard changes needed

Backend should publish sanitized status first. Then the dashboard lane can add:

1. `services/personal-dashboard/config/dashboard.public.json`
   - Add Core Services link `Unified Inbox` -> `https://inbox.wheeler-network.com` after route approval, or a LAN-only reviewed URL before public exposure.
   - Add status check:
     ```json
     {
       "id": "unified-inbox",
       "label": "Unified Inbox",
       "targetUrl": "http://172.17.0.1:8766/healthz",
       "displayUrl": "https://inbox.wheeler-network.com"
     }
     ```
2. `services/personal-dashboard/src/config.js`
   - Add validation for a `unifiedInbox` config block or reuse the existing statusChecks plus a new API proxy.
   - Keep existing sanitizer behavior: no `/root`, `/mnt/nas`, `/app`, DB paths, credential refs, token-shaped URLs, stack traces, or raw diagnostics in browser responses.
3. `services/personal-dashboard/src/server.js`
   - Add an authenticated endpoint such as `GET /api/unified-inbox/status` that fetches/proxies the backend's sanitized status, with a short timeout and 503 soft-fail behavior.
   - Do not expose raw messages until sanitizer and auth review are complete.
4. `services/personal-dashboard/public/index.html`, `public/app.js`, and `public/styles.css`
   - Add an Overview panel or top-level tab with connector health, freshness, counts, excluded-channel rows, snapshot copy status, and the backend UI link.
   - Required visible excluded rows: personal WhatsApp DMs and Instagram DMs -> `excluded` with reason `unsanctioned personal DM access is out of scope`.
5. Dashboard deploy script later:
   - If file-based status fallback is used, extend `services/personal-dashboard/scripts/sync-runtime-snapshots.sh` and `run-critical-docker.sh` to copy `/mnt/nas/services/unified-inbox/status/unified-inbox-status.json` into `/var/lib/personal-dashboard/runtime-cache/unified-inbox/status.json` and mount it read-only.
   - Prefer live backend API status once Unified Inbox is running; file fallback is for degraded/offline visibility.

## Deploy caveats requiring later approval

- Creating or starting the Unified Inbox container on `critical`.
- Creating `/var/lib/unified-inbox` or changing ownership/modes on `critical`.
- Creating NAS directories under `/mnt/nas/services/unified-inbox`.
- Creating a Postgres database/user or applying migrations to shared Postgres.
- Rendering any `.env` from Vaultwarden.
- Inviting/configuring Discord, Telegram, Matrix, Slack, or Android integrations.
- Editing Traefik dynamic config, restarting `proxy`, adding Cloudflare Tunnel ingress, or adding DNS records.
- Exposing message bodies/senders in dashboard UI before sanitizer/auth review.

## Review/deploy/verify checklist

Backend foundation review:

- `services/unified-inbox/` exists with README, env example, Vaultwarden map, tests, and no secret values.
- `ReadOnlyMessageStream` exposes no mutator methods such as send/reply/delete/markRead/archive.
- Envelope validation covers all fields from the parent ADR.
- Snapshot writer proves local-close then immutable-copy behavior in tests.
- Postgres projection, if present, is rebuildable from snapshots.

Pre-deploy infra review:

- Ben approves exact critical commands and any route/database/secret rendering changes.
- Confirm whether Docker Compose is available on `critical`; otherwise use fallback Docker script.
- `timeout 5 stat` checks pass for required NAS source/destination paths before restart/recreate work.
- `/var/lib/unified-inbox` exists with least-privilege ownership and is not on NAS/NFS.
- Vaultwarden references exist; no rendered secrets are committed or logged.
- Shared Postgres backup coverage is confirmed if projection is enabled.

Post-deploy verification:

- `docker ps` shows `unified-inbox` healthy on `critical`.
- `curl http://127.0.0.1:8766/healthz` or approved equivalent returns minimal OK from the runtime host.
- If Traefik route is approved, Host-header probe through Traefik reaches the service and LAN bypass protections match the auth model.
- Dashboard `/api/status` reports `unified-inbox` up via server-side probe.
- Dashboard Unified Inbox panel shows connector health/freshness/counts/exclusions without local paths, secret refs, or raw diagnostics.
- First closed snapshot has local hash manifest and NAS copy status.
- Secret-pattern scan over changed files and generated public artifacts passes.

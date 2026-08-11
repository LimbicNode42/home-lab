# Kanban board freshness and mutation bridge plan

Status: planning artifact only. Do not deploy this, restart Docker, restart the Hermes gateway, or set `KANBAN_MUTATIONS_ENABLED=true` without explicit Ben approval and a fresh sentinel review.

## Problem statement

The live personal dashboard on `critical` currently reads a stale `critical`-local Kanban database copy. The current board source of truth is on `tori`. The safe path is two separate changes:

1. make read-only board state fresh on the dashboard; and
2. only later, after review, allow tightly-scoped Kanban mutations from the dashboard.

Those are intentionally not the same control. Fresh reads do not require write access. A browser getting drag/drop buttons does not mean the container should get host power. Obvious, but history suggests we should write it down before someone hands a dashboard a chainsaw.

## Safety invariants

- `KANBAN_MUTATIONS_ENABLED=false` remains the live setting until all gates below pass.
- The dashboard container must not receive:
  - a writable Kanban DB mount;
  - the Docker socket;
  - SSH keys;
  - broad host filesystem mounts;
  - a Hermes/Gateway admin token;
  - arbitrary command execution.
- The browser must never receive bridge credentials. Browser requests terminate at the dashboard server, and only the dashboard server calls any bridge.
- No Hermes gateway restart is required for this plan. If a future implementation needs a gateway config change, stop and ask Ben to make it manually.
- Secrets are stored in non-committed secret storage, preferably Vaultwarden folder `homelab`, not in Git.

## Phase 1: read-only fresh board state

Goal: make `/api/kanban/board` and `/api/epics` read from a fresh tori-sourced snapshot without enabling mutations.

Recommended architecture:

```text
[tori current board]
  /root/.hermes/kanban.db
        |
        | read-only export job on tori
        v
[NAS or critical-readable snapshot]
  /mnt/nas/services/personal-dashboard/kanban/kanban.db
        |
        | read-only bind mount
        v
[critical personal-dashboard container]
  /app/kanban/kanban.db
        |
        v
GET /api/kanban/board and GET /api/epics
```

Implementation shape, not yet approved:

- On `tori`, create a read-only exporter that copies a consistent SQLite snapshot from the live board to the dashboard data path.
- Use `sqlite3 /root/.hermes/kanban.db ".backup '/tmp/kanban-dashboard.db'"` or an equivalent safe SQLite backup API rather than copying the live DB file mid-write.
- Move the completed snapshot atomically into place on the shared path.
- Set permissions so the `critical` dashboard container can read the snapshot but cannot write it.
- Bind-mount the snapshot into the dashboard as read-only using `KANBAN_DB_HOST_PATH=/mnt/nas/services/personal-dashboard/kanban/kanban.db` or the approved live equivalent.
- Leave `KANBAN_MUTATIONS_ENABLED=false`.

Host power granted in Phase 1:

- `tori` exporter: read access to `/root/.hermes/kanban.db` and write access only to the chosen dashboard snapshot path.
- `critical` dashboard container: read-only access to one SQLite snapshot file at `/app/kanban/kanban.db`.
- Browser: no direct DB access; authenticated dashboard API only.

Why this is minimal:

- Board freshness needs only a copy of current state, not command execution.
- The dashboard can display stale-or-empty on exporter failure without corrupting the source board.
- The source DB remains writable only by Hermes/Kanban on `tori`.

Phase 1 preflight checklist:

- Confirm the source DB path on `tori`: expected `/root/.hermes/kanban.db`.
- Confirm the live dashboard is currently reading a stale path on `critical` and capture its current `KANBAN_DB_PATH`/mount.
- Confirm NAS path responsiveness from both `tori` and `critical` with bounded `stat`/read probes.
- Confirm the dashboard container user can read the proposed snapshot file and cannot write it.
- Confirm `GET /api/kanban/board` returns current task IDs from `tori` after the snapshot update.
- Confirm `GET /api/kanban/board` reports `mutations.enabled=false`.
- Confirm no dashboard restart is attempted until Ben approves the exact live commands.

Phase 1 rollback:

- Revert the dashboard `KANBAN_DB_HOST_PATH`/bind mount to the previous known-good read-only DB path, or unset it so the API returns empty board data.
- Disable the tori export job.
- Leave the last snapshot file in place for inspection unless Ben explicitly approves deletion.
- No source-board recovery should be required because the exporter only reads the source DB.

## Phase 2: narrow tori-hosted mutation bridge

Goal: allow only approved Kanban state transitions from the dashboard server to the current tori board, without giving the dashboard container raw DB write access or shell access.

Recommended architecture:

```text
[authenticated browser]
        |
        | existing reverse-proxy auth
        v
[critical dashboard server]
  POST /api/kanban/tasks/:id/move
        |
        | HTTPS or LAN HTTP to a fixed bridge URL
        | Authorization: Bearer ***
        v
[tori kanban-command-bridge]
  fixed allowlisted endpoint map only
        |
        | no shell; execFile/direct API only
        v
[tori Kanban source of truth]
```

Bridge interface:

- `GET /healthz`
  - returns bridge version, source board path, and whether read/write prerequisites are available;
  - must not expose secrets, environment dumps, or filesystem listings.
- `POST /tasks/:taskId/promote`
  - maps to exactly one allowlisted Kanban operation for moving to `ready`.
- `POST /tasks/:taskId/block`
  - requires a non-empty `reason` string with a bounded length.
- `POST /tasks/:taskId/complete`
  - requires a non-empty `summary` string with a bounded length.
- `POST /tasks/:taskId/archive`
  - requires `confirm: true` and should remain disabled until explicitly approved; archive is higher blast radius than a visual lane move.

Allowed task IDs: only `t_[0-9a-f]+`.
Allowed statuses: start with `ready`, `blocked`, and `done`. Treat `archived` as a separate later approval gate.
Rejected by design: creating tasks, editing task body, changing assignee, changing parents, arbitrary comments, arbitrary `hermes` args, arbitrary shell, file reads, file writes, Docker operations, and gateway control.

Bridge execution rules:

- Use a fixed command map, for example an internal table equivalent to:
  - `promote` -> `hermes kanban promote <taskId> <reason>`
  - `block` -> `hermes kanban block <taskId> <reason>`
  - `complete` -> `hermes kanban complete <taskId> --summary <summary>`
- Invoke commands with `execFile`/argument arrays or a direct library/API path; never `shell: true` and never string-concatenated command lines.
- Run as a dedicated low-privilege OS user if practical, with access only to the Kanban DB and the Hermes CLI/runtime required for `hermes kanban` commands.
- Bind to `127.0.0.1` plus a reverse proxy on tori, a private LAN address with firewall source restriction to `critical`, or a WireGuard-only address. Do not expose publicly.
- Require a bearer token from non-committed storage. Candidate Vaultwarden reference: folder `homelab`, item `personal-dashboard/kanban-bridge`, field `bridge_token`.
- Rate-limit mutation attempts and log: timestamp, dashboard authenticated user header, task id, action, result, and bridge version. Do not log token values.

Host power granted in Phase 2:

- `critical` dashboard container: outbound HTTP access only to the bridge URL and a server-side bridge token. It still receives no DB write mount, no shell, no Docker socket, no SSH keys, and no host filesystem power.
- `tori` bridge process: ability to mutate Kanban tasks through exactly the allowlisted Kanban commands above. It does not get broad shell, Docker, Proxmox, Traefik, Cloudflare, or gateway-control power.
- Browser: authenticated dashboard UI only. It cannot call tori directly and never sees the bridge token.

Why this is minimal:

- All writes happen on `tori`, where the current board lives.
- The dashboard container cannot corrupt the DB directly; it can only ask the bridge for schema-validated transitions.
- If the bridge is down, reads continue from the Phase 1 snapshot and drag/drop returns a disabled/unavailable state.

Phase 2 preflight checklist:

- Confirm `t_19708464` remediation is present in the exact code intended for deployment.
- Obtain fresh sentinel approval for the bridge design and exact live deployment commands.
- Confirm `KANBAN_MUTATIONS_ENABLED=false` before starting.
- Confirm the bridge token exists only in non-committed secret storage.
- Confirm bridge `/healthz` works from `critical` and is blocked from unapproved sources.
- Confirm the dashboard `/api/kanban/board` still returns `mutations.enabled=false` until the final enablement step.
- Test bridge commands against a disposable/non-production Kanban DB first.
- Test one safe transition on a deliberately created test card in the real board only after Ben approves that exact mutation.
- Enable `KANBAN_MUTATIONS_ENABLED=true` only after approval, then verify the dashboard reports the expected `supported_statuses`.

Phase 2 rollback:

- Set `KANBAN_MUTATIONS_ENABLED=false` and restart/reload only the dashboard container if explicitly approved.
- Stop or firewall the bridge service on `tori`.
- Revoke/rotate the bridge token in Vaultwarden/non-committed secret storage.
- Keep Phase 1 read-only snapshot path in place so board display remains available.
- Review bridge logs for the rollback window and record any mutations performed.

## Approval gate

No live action is approved by this document. The next safe approval request should include:

- exact files/config to change;
- exact service/container restart scope, if any;
- source DB path and snapshot path;
- bridge bind address and firewall/source restriction;
- Vaultwarden item/field references for any token;
- test card ID for mutation verification, if mutation testing is requested;
- rollback commands.

Until Ben approves those exact commands, the only allowed state is read-only planning and review.
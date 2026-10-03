# Obsidian source-of-truth architecture

Status: canonical spec / architecture decision record. Authored for T2 (kobold, deploy) and T3 (gremlin, pipeline) to implement. No deployment is part of this document.

## Purpose

Adopt **Obsidian** as the source of truth for Ben's diary, goals, personal notes, and work notes. This document settles the open design questions (vault layout, LiveSync/CouchDB component map, LLM diary-summary ingestion, dashboard reconciliation) and pins them so the deploy and pipeline tasks implement a single agreed shape rather than re-deciding.

Layering, highest to lowest authority for the *raw note content*:

1. Obsidian vault (plain Markdown on NAS) — **source of truth** for diary/goals/personal/work.
2. LiveSync/CouchDB — transport + sync backend; holds a synced copy, not a second truth.
3. LLM summary pipeline — read-only derivative, produces machine summaries.
4. Home Dashboard Diary/Goals tabs — **read-only mirror** of the summary output.

---

## Orchestrator decisions (baked in — do not re-decide)

These are fixed upstream and repeated here only for continuity:

1. Vault lives on the NAS share `obsidian`, server mount `/mnt/nas/obsidian/`, vault directory `/mnt/nas/obsidian/vault/`. Single human vault, never on Tori/Toyota local disk.
2. LiveSync backend = self-hosted CouchDB, Docker container on `critical` (LXC 100, `192.168.0.50`), the existing Docker host (alongside Traefik/Vaultwarden/Postgres).
3. LAN-only exposure: bind `192.168.0.50:<port>`, **not** published through Traefik or any public/Cloudflare route.
4. CouchDB data + config persisted to NAS at `/mnt/nas/services/obsidian-livesync/`.
5. Secrets in Vaultwarden folder `homelab`, referenced from Git by `folder/item/field` name only — values never committed.
6. Client LiveSync setup URL: `http://192.168.0.50:<port>`.

---

## A. Vault layout and naming conventions

### A.1 Top-level folders

The vault root is `/mnt/nas/obsidian/vault/`. Top-level folders, fixed:

```
/mnt/nas/obsidian/vault/
├── .obsidian/          # plugin/app config (auto-managed by Obsidian; never manually curated)
├── Diary/              # daily notes — one file per day
├── Goals/              # goal notes — one file per goal
├── Personal/           # ad-hoc personal notes (privacy-sensitive)
├── Work/               # work notes and work-related scratch
└── Inbox/              # unsorted capture; NOT summarized (excluded from pipeline)
```

Rules:

- `.obsidian/` is machine-owned. The pipeline and deploy task must never read, diff, or summarize it. Git does not track it.
- `Inbox/` is deliberately excluded from all summary ingestion (see C.2). It is a staging area for capture, not a category whose content feeds summaries without a deliberate move.

### A.2 Naming conventions

| Folder | Filename convention | Example | Notes |
|---|---|---|---|
| `Diary/` | `YYYY-MM-DD.md` (ISO 8601 local date) | `Diary/2026-10-03.md` | One file per day. Reopening the same calendar date edits that file. |
| `Goals/` | one file per goal, title-cased | `Goals/Lead the platform team.md` | Frontmatter carries structured fields (below). |
| `Personal/` | free-form, descriptive | `Personal/health-tracker.md` | No fixed convention; grouped by topic rather than date. |
| `Work/` | free-form, descriptive | `Work/roadmap-q4.md` | No fixed convention. |
| `Inbox/` | free-form | `Inbox/capture-2026-10-03.md` | Excluded from summaries. |

### A.3 Goals frontmatter schema

Goal files carry YAML frontmatter the pipeline reads as structured signal:

```yaml
---
title: Lead the platform team
status: active          # active | paused | completed | archived
target_date: 2026-12-31 # optional, YYYY-MM-DD
created: 2026-10-03
---
# body (free-form)
```

- `status` is the single governed field. Bodies remain free-form prose.
- A goal is "current" when `status: active`; the digest (C.3) groups by status.

### A.4 What Git does and does not track

- Git tracks **this spec and the service scaffolding** (compose/env-map/service docs) only.
- Git does **not** track vault content (diary entries, goal text, personal/work notes). Those are personal data and live on the NAS, synced by LiveSync — never in the homelab repo.
- The `.gitignore` already excludes secret-bearing and runtime files; vault content lives outside the repo tree entirely, so no ignore rule is needed, but T2 should confirm `/mnt/nas/obsidian/` is not inside any repo worktree.

---

## B. LiveSync / CouchDB component map

### B.1 Service definition (`services/obsidian-livesync/docker-compose.yml` — T2 writes this)

```yaml
services:
  couchdb:
    image: couchdb:3.3.3            # pin to a digest at deploy time; do not use :latest
    container_name: obsidian-couchdb
    restart: unless-stopped
    environment:
      COUCHDB_USER: ${COUCHDB_ADMIN_USER}
      COUCHDB_PASSWORD: ${COUCHDB_ADMIN_PASSWORD}
      COUCHDB_SINGLE_NODE: "true"   # single-node mode; no cluster sharding needed
    ports:
      - "192.168.0.50:5984:5984"    # LAN-only bind; see B.3
    volumes:
      - /mnt/nas/services/obsidian-livesync/data:/opt/couchdb/data
      - /mnt/nas/services/obsidian-livesync/config:/opt/couchdb/etc/local.d
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:5984/"]
      interval: 30s
      timeout: 5s
      retries: 3
```

Environment is rendered from Vaultwarden (B.4); `/opt/couchdb/etc/local.d/*.ini` is where the single-node flag and any CouchDB config snippets live, persisted to NAS so config survives recreation.

### B.2 Port and exposure

- **Port settled: `5984`** (CouchDB default, self-documenting). Bind explicitly to `192.168.0.50` — never `0.0.0.0` — so the socket is reachable only on the LAN interface.
- **Not published through Traefik.** No TLS, no Cloudflare Tunnel, no public hostname. The existing `critical` Traefik dynamic config must not gain a router for this service (T2/reviewer verifies absence, not just default).
- Remote access is explicitly deferred to a future task; the spec does not define it.

### B.3 Auth model

- **CouchDB admin** (`COUCHDB_USER`/`COUCHDB_PASSWORD`) — management/ops only; used to create the LiveSync database and user, and for backups.
- **LiveSync app credential** — a named CouchDB user (B.4) with permissions scoped to the `obsidian` database. Obsidian LiveSync authenticates with this username/password against `http://192.168.0.50:5984`.
- The Obsidian LiveSync plugin onboarding produces a setup URI (`obsidian://setuplivesync?...`) that encodes the target URL + credentials; T2 records the credential in Vaultwarden rather than committing the URI to Git.

### B.4 Vaultwarden items and fields (create these — exact names)

Folder for all items: `Homelab` (capital H). The live Vaultwarden folder is case-sensitive; do not use the earlier lowercase `homelab` spelling for this lane.

| Purpose | Item | Field(s) | Notes |
|---|---|---|---|
| CouchDB admin | `obsidian-livesync/couchdb` | `username`, `password`, custom `host`=192.168.0.50, custom `port`=5984 | Renders to `COUCHDB_ADMIN_USER` / `COUCHDB_ADMIN_PASSWORD`. |
| LiveSync client credential | `obsidian-livesync/livesync` | `username`, `password`, custom `database`=obsidian, custom `setup_url` (constructed, may hold the `obsidian://setuplivesync...` URI) | The account the Obsidian client uses against CouchDB. |

Git references these by **name only**, e.g. in the env map:

```
COUCHDB_ADMIN_USER     | Homelab | obsidian-livesync/couchdb   | username
COUCHDB_ADMIN_PASSWORD | Homelab | obsidian-livesync/couchdb   | password
LIVESYNC_USER          | Homelab | obsidian-livesync/livesync  | username
LIVESYNC_PASSWORD      | Homelab | obsidian-livesync/livesync  | password
```

Values render to `services/obsidian-livesync/.env` (mode 0600, untracked) via the existing `scripts/secrets/render-env-from-vaultwarden.sh` flow, mirroring how `services/vaultwarden` and `services/memory-reconciler` already work.

---

## C. LLM diary-summary ingestion path

Obsidian content is plain Markdown, so the pipeline reads `.md` files directly — **no extraction step, no text/PDF parsing**.

### C.1 Scanning convention (which folders feed which summary)

| Source folder | Feeds | Summary artifact |
|---|---|---|
| `Diary/` | daily diary entries | `diary-summary` (per-day, newest N days) |
| `Goals/` | goal notes (+ frontmatter) | `goals-digest` (grouped by status) |
| `Personal/`, `Work/` | opt-in | `personal-digest` / `work-digest` — **default OFF** (privacy) |
| `Inbox/`, `.obsidian/` | never | excluded always |

- Pipeline scans `*.md` under `/mnt/nas/obsidian/vault/<folder>` only.
- Diary files are keyed by filename date (`YYYY-MM-DD.md`); Goals by frontmatter `status`.
- Default schedule summarizes **Diary + Goals only**. `Personal/` and `Work/` summaries require an explicit `--include personal` / `--include work` opt-in (and a privacy review) before being enabled.

### C.2 Cadence and trigger

- **Scheduled:** daily. One run per day; the digest reflects diary/goals as of that run.
  - Runtime: `systemd` timer (`obsidian-summarizer.timer`) running the CLI in `--apply` mode against the volume. Timer unit + units live under `services/obsidian-livesync/` (T3 writes the actual unit; this spec fixes the *cadence* at once-daily).
  - Recommended OnCalendar: `21:30` local (end-of-day digest). Not earlier than daily; no intra-day churn.
- **On-demand trigger:** CLI `--once` (single run now, to stdout + output dir), used for manual refresh and for the verification gate in T3. Same code path as the timer — the timer just wraps the CLI.
- Idempotency: a per-day state ledger keyed `(folder, date)` prevents duplicate summaries on re-run; re-running overwrites (regenerates) the day's summary rather than appending.

### C.3 Summary output target

- Output directory: **`/mnt/nas/services/obsidian-livesync/summaries/`** — deliberately **outside the vault**, so machine output never syncs back into the human's notes.
- Layout:
  ```
  summaries/
  ├── diary/YYYY-MM-DD.md        # one markdown summary per day
  ├── goals/digest.md            # current goals digest (active/paused/completed/archived)
  └── meta/last-run.json         # { kind, window, generated_at, file_count, model, status }
  ```
- `meta/last-run.json` is the freshness signal the dashboard reads (D.3).
- Summaries are LLM-derived and stored on NAS; treat them as personal data — same redaction/no-Git posture as the repo's existing curated-ingest policy. Summary content is **never** committed to Git.

### C.4 Model / safety posture

- The summarizer is read-only over the vault: it reads Markdown, writes only to `summaries/`, and never mutates vault files or CouchDB.
- LLM model is pinned at implement time (reuse the repo's existing model-allowlist convention from `memory-reconciler`); fail-closed on model mismatch.
- No raw diary/goal body is written to logs; logs carry `(folder, date, file_count)` only.

---

## D. Dashboard reconciliation decision

### D.1 Recommendation: read-only mirror (do not deprecate)

The Home Dashboard **Diary** and **Goals** tabs become **read-only mirrors** of the Obsidian-backed pipeline — they are **not** deprecated.

Rationale:

- Obsidian is now the write path for diary/goals; keeping a read-only glanceable view on the dashboard preserves the operator-facing signal Ben already uses, without maintaining a second writable store to drift.
- The prior MVP plan (`services/personal-dashboard/docs/diary-goals-mvp-plan.md`) proposed a **dashboard-owned Postgres write store**. That assumption is superseded: the writable source of truth moves to Obsidian + LiveSync. Any dashboard write API for diary/goals is **deprecated**, not extended.
- Deprecating the tabs entirely would remove a working surface for a fad reason; there is no cost to a read-only mirror because it renders the pipeline's existing summary output.

### D.2 What changes in the dashboard

- Diary/Goals **writes** (the Postgres `personal-data-store` write endpoints for those two domains) are deprecated/removed. The tab becomes display-only.
- The tabs render from the pipeline's summary output (via a small dashboard read-path that serves `summaries/` from `/mnt/nas/services/obsidian-livesync/summaries/` through the existing authenticated `/api/*` surface — no new unauthenticated route).
- No personal Markdown body is exposed raw by default; the mirror shows digest/preview + a link/pointer to the source-of-truth vault (and the LiveSync endpoint) rather than dumping full private entries.

### D.3 Status / link / freshness signal

The Overview (or the Diary/Goals tab header) shows a single operator-facing signal:

- **Status:** "Obsidian summaries current" / "stale" derived from `summaries/meta/last-run.json` (`generated_at`; stale threshold ~26h given daily cadence, so a missed run flags within a day).
- **Link:** a pointer to the LiveSync endpoint (`http://192.168.0.50:5984`) and the vault path label (`obsidian` NAS share), so Ben can reach the source of truth.
- **Freshness:** `last summary at <generated_at>` plus per-kind file count; no timestamps fabricated — read from `last-run.json`.

This is the completion-visibility surface for the epic (per `docs/delivery-conventions.md`).

---

## Component / file placement summary (for T2 and T3)

| Artifact | Path | Owner |
|---|---|---|
| This spec | `docs/architecture/obsidian-source-of-truth.md` | scribe (done) |
| Compose scaffold | `services/obsidian-livesync/docker-compose.yml` | T2 (kobold) — write from B.1 |
| Env map / example | `services/obsidian-livesync/.env.example`, `vaultwarden-map.example.yml` | T2 |
| LiveSync runbook | `services/obsidian-livesync/runbooks/operate.md` | T2 or follow-up |
| Summary pipeline code | `services/obsidian-summarizer/` (proposed) | T3 (gremlin) |
| Summary output (runtime) | `/mnt/nas/services/obsidian-livesync/summaries/` | T3 (writes) |
| Dashboard read-path | `services/personal-dashboard/` | T3 |

## Explicitly not in scope here

- Deploying CouchDB or creating the NAS vault (T2).
- Implementing/wiring the pipeline or dashboard reconciliation (T3).
- Remote/Cloudflare access to the vault or LiveSync (deferred).
- Committing any vault content or secret values (never).
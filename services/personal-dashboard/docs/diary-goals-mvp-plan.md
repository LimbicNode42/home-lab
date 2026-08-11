# Diary and Goals MVP Implementation Plan

> For Hermes: use this as a short implementation/data-model handoff for adding Diary and Goals to the personal dashboard. Do not deploy, restart, or add automated goal assessment as part of this MVP.

Goal: add durable, authenticated Diary and Goals tabs to the personal dashboard without committing Ben's personal entries/goals to Git.

Architecture: keep the current dependency-light Node.js server plus static frontend. Add a dashboard-owned SQLite runtime database mounted outside Git, server-side migrations/init on startup, authenticated JSON APIs, and plain HTML/CSS/JS tab panels. Preserve a future link between diary entries and goals through a join table, but do not implement LLM assessment or prompts yet.

Tech stack: Node.js >=22, `node:sqlite` `DatabaseSync`, plain HTML/CSS/JavaScript, existing `node:test` suite.

---

## Current dashboard structure observed

Files inspected:

- `services/personal-dashboard/public/index.html`
- `services/personal-dashboard/public/app.js`
- `services/personal-dashboard/public/styles.css`
- `services/personal-dashboard/src/server.js`
- `services/personal-dashboard/src/config.js`
- `services/personal-dashboard/docker-compose.yml`
- `services/personal-dashboard/.env.example`
- `services/personal-dashboard/test/server.test.js`
- `services/personal-dashboard/test/app-tabs.test.js`
- `services/personal-dashboard/README.md`

Current top-level tabs are hash-backed and client-side only:

- `Overview`: service status and links.
- `Work`: Kanban board.
- `Knowledge`: completed epics and documentation.
- `Reports`: Finnick and investment screener.

The server already gates every `/api/*` route behind reverse-proxy auth unless explicitly running local-dev disabled auth. Keep that posture. New diary/goal APIs are personal write APIs, not read-only status panels wearing a false moustache.

## MVP product shape

Add two new top-level tabs:

1. `Diary` (`/#diary`)
   - Purpose: write and revisit dated private diary entries.
   - MVP capabilities:
     - Create diary entry.
     - List diary entries newest-first with short preview/snippet.
     - View one full diary entry.
     - No edit/delete in MVP unless Ben explicitly approves destructive/personal-data operations later.
   - Suggested UI:
     - Entry form at top: `Title` optional, `Entry` required, optional `Entry date` defaulting to today.
     - List below: date, title or `(untitled)`, created timestamp, short preview, `View` button.
     - Detail panel: full entry body and linked goal names if any.

2. `Goals` (`/#goals`)
   - Purpose: record and manage personal goals with lightweight status tracking.
   - MVP capabilities: create/list/view/update basics are low-complexity and useful enough here.
     - Create goal.
     - List goals grouped or filterable by status.
     - View one goal.
     - Update title/description/status/target date.
     - No hard delete in MVP; use status `archived` instead. Export/delete/destructive operations stay out of scope.
   - Suggested UI:
     - Goal form: `Title` required, `Description` optional, `Status` default `active`, optional `Target date`.
     - Goal cards/list: status badge, title, target date, created/updated timestamps.
     - Edit mode can be a small inline form; no drag/drop needed.

Future goal assessment:

- Do not add automated assessment, LLM prompts, scoring, embeddings, or raw-prompt storage in this MVP.
- Preserve future compatibility by allowing diary entries to be associated with goals manually or later by assessment code through a join table.
- If an assessment feature is later approved, it should create separate tables for assessment runs/results with explicit provenance, model/config metadata, sanitized outputs, and opt-in execution. That is deliberately not this task.

## Storage approach

Use a dashboard-owned SQLite database stored in runtime data, outside Git.

Recommended paths:

- Container path: `/app/data/personal-dashboard.sqlite3`
- Env var / createApp option: `PERSONAL_DASHBOARD_DB_FILE`
- Host default for Compose: `${PERSONAL_DASHBOARD_DB_HOST_PATH:-/mnt/nas/services/personal-dashboard/data/personal-dashboard.sqlite3}`

Compose mount should be read-write for this database only:

```yaml
- type: bind
  source: ${PERSONAL_DASHBOARD_DB_HOST_PATH:-/mnt/nas/services/personal-dashboard/data/personal-dashboard.sqlite3}
  target: /app/data/personal-dashboard.sqlite3
  read_only: false
  bind:
    create_host_path: false
```

Operational notes:

- The host directory/file must be created by the operator before container recreate; do not let Docker accidentally create a directory at the DB file path.
- Git must contain only schema/migration code, docs, runbooks, and obviously fake test fixtures.
- Do not commit a real `.sqlite3`, WAL, SHM, dump, diary entry, goal text, or generated personal-data export.
- Add ignore rules if needed: `services/personal-dashboard/data/`, `*.sqlite3`, `*.sqlite3-wal`, `*.sqlite3-shm`, `*.db` unless already covered at repo level.

Migration/init path:

- Create `src/personal-data-store.js` as the storage boundary.
- On `createPersonalDataStore({ dbFile })`, open `DatabaseSync(dbFile)` and run idempotent migrations in a transaction.
- Use `PRAGMA user_version` to track schema version.
- Set pragmatic SQLite safety defaults on each open:
  - `PRAGMA foreign_keys = ON`
  - `PRAGMA journal_mode = WAL`
  - `PRAGMA busy_timeout = 5000`
- If `PERSONAL_DASHBOARD_DB_FILE` is not set, diary/goals APIs should return `503 { "error": "personal_data_not_configured", "message": "Personal dashboard data store is not configured" }` and UI should show a configuration message. Do not fall back to an in-repo path.

Backup/restore note:

- The DB belongs in the NAS-backed dashboard runtime data path and should be included in the homelab backup coverage matrix.
- Backup with SQLite-safe methods: stop writer briefly, or run `sqlite3 /path/personal-dashboard.sqlite3 '.backup /backup/path/personal-dashboard-YYYYMMDD.sqlite3'` from the host/runtime environment.
- Restore by stopping/recreating the dashboard container against the restored DB file. Do not restore over a running writer.
- Treat backups as sensitive personal data; do not attach them to Kanban comments, GitHub issues, or logs.

## Data model

Initial schema version 1:

```sql
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 5000),
  status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'archived')),
  target_date TEXT CHECK(target_date IS NULL OR target_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  archived_at TEXT
);

CREATE INDEX goals_status_updated_idx ON goals(status, updated_at DESC);

CREATE TABLE diary_entries (
  id TEXT PRIMARY KEY,
  entry_date TEXT NOT NULL CHECK(entry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  title TEXT NOT NULL DEFAULT '' CHECK(length(title) <= 160),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 20000),
  mood TEXT NOT NULL DEFAULT '' CHECK(length(mood) <= 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX diary_entries_entry_date_idx ON diary_entries(entry_date DESC, created_at DESC);

CREATE TABLE diary_entry_goals (
  diary_entry_id TEXT NOT NULL REFERENCES diary_entries(id) ON DELETE CASCADE,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT 'manual' CHECK(link_type IN ('manual', 'future_assessment')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (diary_entry_id, goal_id)
);

CREATE INDEX diary_entry_goals_goal_idx ON diary_entry_goals(goal_id, diary_entry_id);
```

Field rules:

- IDs: server-generated opaque strings, e.g. `g_<random hex>` and `d_<random hex>` or UUIDs. Browser must not supply IDs.
- Timestamps: server-generated ISO 8601 UTC strings for `created_at` and `updated_at`.
- Goal statuses:
  - `active`: current goal.
  - `paused`: intentionally not active now.
  - `completed`: achieved; set `completed_at` when first entering this status.
  - `archived`: hidden/retired without deleting personal history; set `archived_at` when first entering this status.
- Diary `entry_date`: user-selected calendar date, default today in the browser, validated server-side.
- `mood` is optional text for future usefulness; no taxonomy needed now.
- `diary_entry_goals` exists for future assessment/manual links. MVP can expose `goal_ids` on create entry if cheap, but the UI may defer linking and still keep the schema.

## API surface and validation

All routes below live under `/api/*` and must require auth. Do not add unauthenticated exceptions besides existing `/healthz`.

### Goals

`GET /api/goals?status=active|paused|completed|archived|all`

- Auth required.
- Default `status=active` or `status=all`; recommended default for UI is `all` with client grouping.
- Response:

```json
{
  "goals": [
    {
      "id": "g_example",
      "title": "Fake test goal",
      "description": "Obviously fake fixture text.",
      "status": "active",
      "target_date": "2026-12-31",
      "created_at": "2026-08-11T00:00:00.000Z",
      "updated_at": "2026-08-11T00:00:00.000Z",
      "completed_at": null,
      "archived_at": null
    }
  ]
}
```

`GET /api/goals/:id`

- Auth required.
- Return one goal plus optionally recent linked diary entry summaries later. MVP can return just the goal.
- Unknown id: `404 { "error": "goal_not_found" }`.

`POST /api/goals`

- Auth required.
- JSON only, bounded body size. Suggested max request body: 32 KiB.
- Browser sends: `title`, optional `description`, optional `status`, optional `target_date`.
- Server ignores/rejects any `id`, `created_at`, `updated_at`, `completed_at`, `archived_at` from the browser.
- Validation:
  - `title`: required string, trim, 1..160 chars.
  - `description`: optional string, trim, <=5000 chars.
  - `status`: optional, one of `active|paused|completed|archived`, default `active`.
  - `target_date`: optional `YYYY-MM-DD` calendar date or `null`.
- Success: `201 { "goal": { ... } }`.

`PATCH /api/goals/:id`

- Auth required.
- JSON only, bounded body size.
- Allowed fields: `title`, `description`, `status`, `target_date`.
- At least one allowed field required.
- Apply the same validation as create.
- Always set `updated_at` server-side.
- Set `completed_at` only when moving into `completed` and it is not already set; clear it only if product decision later says so. MVP can leave historical completion timestamp in place if status changes away.
- Set `archived_at` only when moving into `archived` and it is not already set.
- Success: `200 { "goal": { ... } }`.

### Diary

`GET /api/diary/entries?limit=20&offset=0`

- Auth required.
- Query validation:
  - `limit`: integer 1..100, default 20.
  - `offset`: integer 0..10000, default 0.
- Response summaries include no full body unless body is intentionally a short preview:

```json
{
  "entries": [
    {
      "id": "d_example",
      "entry_date": "2026-08-11",
      "title": "Fake test entry",
      "preview": "This is obviously fake fixture diary text...",
      "mood": "",
      "goal_ids": ["g_example"],
      "created_at": "2026-08-11T00:00:00.000Z",
      "updated_at": "2026-08-11T00:00:00.000Z"
    }
  ],
  "limit": 20,
  "offset": 0
}
```

`GET /api/diary/entries/:id`

- Auth required.
- Return full entry body and linked goal IDs/titles.
- Unknown id: `404 { "error": "diary_entry_not_found" }`.

`POST /api/diary/entries`

- Auth required.
- JSON only, bounded body size. Suggested max request body: 40 KiB.
- Browser sends: `entry_date`, optional `title`, required `body`, optional `mood`, optional `goal_ids`.
- Server ignores/rejects any `id`, `created_at`, `updated_at` from the browser.
- Validation:
  - `entry_date`: optional `YYYY-MM-DD` valid calendar date, default server today if missing.
  - `title`: optional string, trim, <=160 chars.
  - `body`: required string, trim, 1..20000 chars.
  - `mood`: optional string, trim, <=64 chars.
  - `goal_ids`: optional array of existing goal ids, max 20, all unique. Invalid/unknown IDs should return `400 { "error": "invalid_goal_ids" }` rather than silently dropping links.
- Success: `201 { "entry": { ...full entry... } }`.

Out of scope for MVP:

- `PATCH /api/diary/entries/:id`
- `DELETE /api/diary/entries/:id`
- bulk export
- destructive purge
- automated assessment endpoints
- raw prompts or LLM outputs

## Privacy and safety requirements

- All diary/goal APIs require auth even if other panels stay read-only.
- No browser-supplied filesystem path, DB path, migration path, or backup path.
- No raw local paths, DB paths, SQLite errors, stack traces, stderr, or environment variable values in API responses.
- API errors should use stable public codes/messages, for example:
  - `personal_data_not_configured`
  - `invalid_request_body`
  - `validation_failed`
  - `goal_not_found`
  - `diary_entry_not_found`
  - `invalid_goal_ids`
  - `personal_data_unavailable`
- Server may log sanitized operational diagnostics, but avoid logging diary bodies or goal descriptions. Log error class/code, not personal payload content.
- Tiny fake test fixtures are allowed; real diary/goal content is not.
- Do not add raw prompts, assessment requests, embeddings, vector stores, or LLM evaluation outputs in this MVP.
- Export/delete/destructive operations are explicitly out of scope until Ben approves product shape and safety posture.

## Recommended files to edit

Server/storage:

- Create `services/personal-dashboard/src/personal-data-store.js`
  - Own SQLite open/init/migrations.
  - Export functions such as `createPersonalDataStore`, `listGoals`, `getGoal`, `createGoal`, `updateGoal`, `listDiaryEntries`, `getDiaryEntry`, `createDiaryEntry`.
  - Keep all SQL parameterized; no string-concatenated user values.
- Modify `services/personal-dashboard/src/server.js`
  - Resolve `PERSONAL_DASHBOARD_DB_FILE` / `options.personalDataDbFile`.
  - Instantiate the store once in `createApp` when configured.
  - Add route handling for `/api/goals`, `/api/goals/:id`, `/api/diary/entries`, `/api/diary/entries/:id`.
  - Reuse/extend JSON body parsing with per-endpoint byte limits.
  - Return sanitized errors only.
- Modify `services/personal-dashboard/docker-compose.yml`
  - Add `PERSONAL_DASHBOARD_DB_FILE: /app/data/personal-dashboard.sqlite3`.
  - Add the read-write bind mount for the host DB file.
- Modify `services/personal-dashboard/.env.example`
  - Document `PERSONAL_DASHBOARD_DB_HOST_PATH` with a sensitive-data warning.
- Modify `.gitignore` or service-level ignore if runtime SQLite files are not already ignored.

Frontend:

- Modify `services/personal-dashboard/public/index.html`
  - Add `Diary` and `Goals` to the tab list.
  - Add `#panel-diary` and `#panel-goals` tab panels.
  - Include forms/lists/detail containers with stable IDs, for example:
    - `#diary-entry-form`, `#diary-entry-date`, `#diary-entry-title`, `#diary-entry-body`, `#diary-entry-list`, `#diary-entry-detail`
    - `#goal-form`, `#goal-title`, `#goal-description`, `#goal-status`, `#goal-target-date`, `#goals-list`, `#goal-detail`
- Modify `services/personal-dashboard/public/app.js`
  - Extend `TAB_IDS` to `['overview', 'work', 'knowledge', 'reports', 'diary', 'goals']` unless Ben prefers personal tabs earlier in the order.
  - Add `getJson`, `postJson`, and new `patchJson` usage for goals.
  - Load Diary/Goals lazily when their tabs are selected.
  - Render validation/error states without dumping raw server errors.
  - After create/update success, clear forms where appropriate and refresh the affected list.
- Modify `services/personal-dashboard/public/styles.css`
  - Add simple form/list/card/detail styles; reuse existing `.panel`, `.badge`, `.muted`, `.error`, and grid patterns.
  - Ensure mobile forms are single-column and tab strip remains horizontally scrollable.

Documentation:

- Modify `services/personal-dashboard/README.md`
  - Add Diary/Goals APIs to the included JSON APIs list.
  - Document `PERSONAL_DASHBOARD_DB_FILE` and host bind path.
  - Add backup/restore note and no-Git personal-data warning.
- Optionally create `services/personal-dashboard/docs/products/diary-goals/README.md` after implementation for user-facing usage docs.

## Tests to add

Server tests in `services/personal-dashboard/test/server.test.js` or a new `test/personal-data-store.test.js`:

1. Auth gate:
   - Add `/api/goals`, `/api/goals/g_fake`, `/api/diary/entries`, `/api/diary/entries/d_fake` to the existing reverse-proxy auth regression list.
2. Not configured:
   - With `personalDataDbFile: null`, `GET /api/goals` and `GET /api/diary/entries` return `503 personal_data_not_configured` after auth.
3. Goal create/list/update:
   - Use `mkdtemp(tmpdir())` and a temp SQLite file.
   - `POST /api/goals` with fake title returns `201`, server-generated id/timestamps.
   - `GET /api/goals?status=all` returns the fake goal.
   - `PATCH /api/goals/:id` can move status to `completed` and sets `updated_at`/`completed_at`.
4. Goal validation:
   - Empty title returns `400 validation_failed`.
   - Overlong title/description returns `400 validation_failed` without echoing the submitted text.
   - Invalid status returns `400 validation_failed`.
   - Browser-supplied `id`/timestamps are ignored or rejected consistently.
5. Diary create/list/view:
   - `POST /api/diary/entries` with obviously fake body returns `201`.
   - `GET /api/diary/entries` returns preview but not necessarily full body.
   - `GET /api/diary/entries/:id` returns full fake body and linked fake goal metadata.
6. Diary validation:
   - Empty body returns `400 validation_failed`.
   - Overlong body returns `400 validation_failed` without echoing the submitted text.
   - Invalid date returns `400 validation_failed`.
   - Unknown linked goal id returns `400 invalid_goal_ids`.
7. Sanitized errors:
   - Directory path passed as DB file or unreadable DB path returns `503 personal_data_unavailable` without exposing filesystem paths or raw SQLite diagnostics.

Frontend/static tests:

- Modify `services/personal-dashboard/test/app-tabs.test.js`
  - Expect six accessible hash-backed tabs: `overview`, `work`, `knowledge`, `reports`, `diary`, `goals`.
  - Expect `TAB_IDS` includes diary/goals.
  - Expect `loadTabData()` calls `refreshDiaryEntries()` and `refreshGoals()` for those tabs.
- Add `services/personal-dashboard/test/app-diary-goals.test.js`
  - Static assertions for form IDs, API paths, bounded client-side attributes (`maxlength`), and no delete/export controls.
  - Assert UI copy does not mention automated assessment in a way that implies it exists.

Recommended verification commands:

```bash
cd /root/work/home-lab/services/personal-dashboard
npm test
DASHBOARD_AUTH_MODE=disabled DASHBOARD_ALLOW_DISABLED_AUTH=true PERSONAL_DASHBOARD_DB_FILE=/tmp/personal-dashboard-test.sqlite3 npm start
```

Manual smoke after implementation, using fake data only:

```bash
curl -s http://127.0.0.1:4322/api/goals \
  -H 'content-type: application/json'

curl -s -X POST http://127.0.0.1:4322/api/goals \
  -H 'content-type: application/json' \
  -d '{"title":"Fake test goal","description":"Obviously fake fixture text.","status":"active"}'

curl -s -X POST http://127.0.0.1:4322/api/diary/entries \
  -H 'content-type: application/json' \
  -d '{"entry_date":"2026-08-11","title":"Fake test entry","body":"This is obviously fake diary text for testing only."}'
```

Expected local-dev result with disabled auth: fake goal/entry can be created and listed. Expected reverse-proxy result without identity header: `401` for every `/api/goals*` and `/api/diary*` route.

## Acceptance checklist for the implementing worker

- [ ] Diary and Goals are top-level tabs with accessible tab/panel wiring.
- [ ] Runtime SQLite DB path is configured outside Git and mounted read-write only for that DB.
- [ ] Schema supports future diary-entry-to-goal links without implementing automated assessment.
- [ ] All diary/goal writes require auth and server-generated IDs/timestamps.
- [ ] Text lengths, statuses, dates, pagination, and linked goal IDs are validated server-side.
- [ ] API errors are sanitized and do not leak DB paths, local paths, stderr, stack traces, or submitted personal text.
- [ ] No delete/export/destructive operations exist in MVP.
- [ ] No real diary or goal content appears in Git, fixtures, test output, docs, or Kanban comments.
- [ ] `npm test` passes.

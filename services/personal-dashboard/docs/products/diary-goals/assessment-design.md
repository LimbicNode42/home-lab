# Diary and Goals Assessment Future-Feature Design

Status: future design only. This document does not implement assessment code, does not add prompts, does not add external model calls, and does not change deployment behavior.

## Purpose

The Diary and Goals MVP stores private diary entries and goals durably in the dashboard-owned SQLite database. A later assessment feature can help Ben reflect on whether day-to-day diary patterns line up with stated goals.

The feature should behave like a private coaching aid, not a machine-goblin pulpit. It can surface evidence, patterns, and possible next actions; it must not pretend to issue moral verdicts.

## Source state this design assumes

The MVP storage boundary is `services/personal-dashboard/src/personal-data-store.js` and schema version 1 currently includes:

- `goals`: goal title, description, status, target date, timestamps, completion/archive timestamps.
- `diary_entries`: entry date, title, body, mood, timestamps.
- `diary_entry_goals`: manual or future-assessment links between diary entries and goals.

Relevant MVP constraints from `docs/diary-goals-mvp-plan.md`:

- Diary/goal APIs require auth.
- Real diary and goal content must not be committed to Git, Kanban comments, issue trackers, logs, or test fixtures.
- Assessment, scoring, embeddings, prompts, model output storage, export, and destructive operations are intentionally out of MVP scope.
- Local runtime SQLite storage is preferred; missing storage should fail closed rather than creating surprise in-repo data.

## Useful assessment questions

The first version should answer practical reflection questions. Avoid global scores unless Ben explicitly asks for them later; scores are seductive little lies unless the data model is mature.

### Daily questions

- Which active goals did today's diary entry appear to support?
- Which active goals were mentioned, linked, or evidenced today?
- Which active goals had no diary evidence today?
- Did the entry describe concrete progress, maintenance, avoidance, blockers, or recovery?
- What is one low-friction next action for tomorrow?
- Is there anything Ben should consciously ignore because it is not aligned with current goals?

### Weekly or date-range questions

- Which goals received repeated diary evidence across the selected date range?
- Which goals were repeatedly neglected despite being active or high-priority?
- Are diary patterns aligned with stated priorities and target dates?
- Which blockers or recurring themes show up near neglected goals?
- Which goals may need status changes: active -> paused, active -> completed, paused -> active, or active -> archived?
- What is one concrete next action per active goal, if there is enough evidence to suggest one?

### Per-goal questions

- What diary snippets support progress toward this goal?
- What diary snippets suggest friction, avoidance, or conflict with this goal?
- When was this goal last materially evidenced in a diary entry?
- Is the goal still phrased clearly enough to assess?
- Does the goal need a smaller next action, a status change, or no action?

## Data flow

Assessment must be a separate artifact layer over the raw diary/goals store. Raw diary text remains the source material; assessment output is derived, reviewable, and disposable.

### Manual run flow

1. User opens the assessment UI and selects a scope:
   - one diary entry;
   - a date range;
   - one goal;
   - all active goals over a recent range.
2. Server reads the selected diary entries, goals, and existing `diary_entry_goals` links from the local SQLite store.
3. Assessment engine produces derived output:
   - summary by goal;
   - evidence references;
   - neglected-goal list;
   - next-action suggestions;
   - warnings about low confidence or missing data.
4. Server stores the assessment run and derived results separately from raw diary entries.
5. UI shows the draft assessment with explicit controls:
   - accept/save as reviewed;
   - edit note or next action;
   - ignore/dismiss;
   - delete derived assessment artifact, if a later deletion policy is approved.
6. Raw diary entries and goals are not modified automatically.
7. New inferred diary-goal links are suggestions until human-reviewed.

### Proposed future schema additions

Use a new migration after MVP schema version 1. Names are suggestions; an implementation task should refine them against the final store module.

```sql
CREATE TABLE assessment_runs (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('entry', 'date_range', 'goal', 'active_goals')),
  scope_start_date TEXT,
  scope_end_date TEXT,
  goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  diary_entry_id TEXT REFERENCES diary_entries(id) ON DELETE SET NULL,
  engine_type TEXT NOT NULL CHECK(engine_type IN ('deterministic', 'local_model', 'external_model')),
  engine_name TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK(status IN ('draft', 'reviewed', 'ignored')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE TABLE assessment_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES assessment_runs(id) ON DELETE CASCADE,
  goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  result_type TEXT NOT NULL CHECK(result_type IN ('supported', 'neglected', 'conflict', 'theme', 'next_action', 'summary')),
  confidence TEXT NOT NULL CHECK(confidence IN ('low', 'medium', 'high', 'not_applicable')),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 3000),
  next_action TEXT NOT NULL DEFAULT '' CHECK(length(next_action) <= 1000),
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE assessment_evidence (
  result_id TEXT NOT NULL REFERENCES assessment_results(id) ON DELETE CASCADE,
  diary_entry_id TEXT NOT NULL REFERENCES diary_entries(id) ON DELETE CASCADE,
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('manual_link', 'keyword_match', 'tag_match', 'model_reference')),
  snippet TEXT NOT NULL DEFAULT '' CHECK(length(snippet) <= 500),
  created_at TEXT NOT NULL,
  PRIMARY KEY (result_id, diary_entry_id, evidence_kind)
);
```

Important storage rules:

- `assessment_runs` records scope, engine, version, config, and timestamps.
- `assessment_results` stores derived summaries and next actions, not raw prompts.
- `assessment_evidence` stores bounded snippets or references, not full diary bodies.
- `provenance_json` should include source entry IDs, source goal IDs, algorithm version, keyword/tag rules used, and whether the result was edited by a human.
- If model-assisted assessment is ever approved, store model/provider/config metadata, but do not store raw prompts containing full diary bodies unless Ben explicitly approves that risk.

## Privacy and safety model

Diary content is sensitive personal data. Treat it as more sensitive than ordinary dashboard status/config.

### Defaults

- Local-only analysis by default.
- Manual/opt-in runs only at first.
- No external LLM/API calls unless Ben explicitly approves and configures a provider for this feature.
- No background automatic nagging, scheduled assessment, or push notifications in the first implementation.
- No raw diary/goal content in Git, logs, Kanban comments, exceptions, metrics, browser console output, telemetry, prompts, or test fixtures.
- API responses must not expose DB paths, local filesystem paths, stack traces, SQLite errors, provider errors, prompt text, or raw model diagnostics.

### External model gate

Before any external model provider is allowed, require an explicit product/config decision covering:

- provider name;
- exact data sent off-machine;
- retention policy and privacy posture;
- whether prompts/results may include diary body text;
- whether derived outputs may be stored;
- how Ben can disable the feature and inspect/delete derived artifacts.

If any of those are unknown, the implementation should fail closed with a clear `assessment_external_model_not_configured`-style error.

### Human control

Assessment output must be editable or ignorable. The UI language should make clear:

- assessment is reflective coaching, not judgment;
- low-confidence outputs are normal;
- absence of evidence is not proof of failure;
- the human remains the source of truth for goal priority and meaning.

### Logging

Server logs may record operational metadata only:

- assessment run ID;
- engine type/name/version;
- source counts;
- elapsed time;
- public error code.

Logs must not include diary body text, goal descriptions, snippets, next actions, raw prompts, or model responses.

## Product and UI shape

Add a future `Assessment` section under either `Goals` or a dedicated personal tab once the MVP proves useful. Start under `Goals` to keep the product small unless the page becomes crowded.

### Manual assessment panel

Controls:

- Scope selector:
  - today;
  - yesterday;
  - last 7 days;
  - custom date range;
  - one goal.
- Goal filter:
  - active goals by default;
  - optional paused/completed inclusion.
- Run button with copy such as `Run local assessment`.
- Privacy note near the run button:
  - `Runs locally against selected diary entries and goals. No external model calls are used unless explicitly configured.`

### Goal-alignment summary

Show:

- selected date range;
- number of diary entries assessed;
- active goals included;
- supported goals count;
- neglected goals count;
- low-confidence / insufficient-evidence notice.

This should be evidence-first, not score-first.

### Per-goal cards

For each goal:

- status badge and target date;
- alignment state: `supported`, `no evidence`, `possible conflict`, or `needs review`;
- evidence snippets or counts;
- last evidenced diary date;
- suggested next action;
- controls: `Accept`, `Edit note`, `Ignore`, `Add manual link`.

### Trends over time

After there are multiple reviewed runs:

- simple weekly count of diary entries linked to each active goal;
- last-evidenced date per goal;
- trend indicator such as `more evidence`, `less evidence`, `unchanged`, `insufficient data`;
- no guilt heatmaps unless Ben explicitly asks for quantified pressure. The goblin can stay in its lane.

### Accessibility and UX basics

- Use semantic headings and form labels.
- Keep assessment results keyboard navigable.
- Do not use color alone for supported/neglected/conflict states.
- Keep mobile layout single-column.
- Preserve existing auth and tab behavior.
- Do not auto-scroll or modal-spam after a run.

## Implementation phases

### Phase 1: deterministic linking and manual review

Goal: useful reflection without model risk.

Capabilities:

- User can manually link diary entries to goals using existing `diary_entry_goals` with `link_type = 'manual'`.
- Optional goal keywords/tags can be configured in local storage or a new table if explicitly scoped.
- Assessment run uses deterministic rules:
  - direct manual links count as support;
  - keyword/tag matches suggest support;
  - active goals with no links/matches in range appear as `no evidence`;
  - next action defaults to a template such as `Pick one small action for this goal tomorrow.`
- Store derived assessment runs/results with provenance.
- UI supports accept/edit/ignore.

No summarization, no external calls, no embeddings.

### Phase 2: local summarization if available

Goal: richer summaries without leaving the homelab.

Prerequisites:

- Local model runtime exists and is explicitly enabled for this feature.
- Model context limits and timeout behavior are documented.
- Prompt templates are committed only if they contain placeholders, not real diary content.
- Model outputs are stored as derived artifacts with provenance and review state.

Capabilities:

- Summarize selected local diary entries into bounded derived summaries.
- Suggest per-goal themes and next actions.
- Mark all model outputs as draft until reviewed.
- Fall back to Phase 1 deterministic results when the local model is unavailable.

### Phase 3: richer model-assisted assessment after privacy approval

Goal: optional deeper coaching after explicit approval.

Prerequisites:

- Ben approves provider/config/data policy.
- UI clearly indicates external processing before each run.
- Audit metadata records what provider/engine/config was used.
- Feature can be disabled without breaking diary/goals storage.

Capabilities:

- More nuanced goal-alignment summaries.
- Recurring theme detection.
- Better next-action suggestions.
- Optional comparison against goal priority, target dates, and reviewed prior assessments.

Still out of scope unless explicitly approved:

- automatic daily judgment messages;
- unreviewed goal status changes;
- sending diary entries to providers by default;
- raw prompt retention with personal content;
- deleting or modifying diary entries.

## API shape for a future implementation

Potential endpoints, all under authenticated `/api/*` routes:

- `GET /api/assessments?limit=20&offset=0`
  - list assessment run summaries, not raw evidence bodies.
- `GET /api/assessments/:id`
  - return one run, derived results, bounded evidence snippets, provenance metadata.
- `POST /api/assessments`
  - create a manual assessment run for a selected scope.
  - request body contains scope, date range, goal ID, and engine selection.
  - server chooses implementation based on allowed config.
- `PATCH /api/assessments/:id`
  - mark reviewed/ignored and optionally store human-edited note or next action.

Suggested public error codes:

- `personal_data_not_configured`
- `assessment_scope_invalid`
- `assessment_engine_not_configured`
- `assessment_external_model_not_approved`
- `assessment_run_not_found`
- `assessment_unavailable`
- `validation_failed`

## Future implementation acceptance criteria

A future implementation task should be accepted only when all of the following are true:

- Assessment code is separate from the Diary/Goals MVP storage APIs and can be disabled.
- All assessment routes require the same reverse-proxy auth gate as diary/goal APIs.
- First implementation is manual/opt-in; no scheduled automatic runs or unsolicited notifications.
- Phase 1 deterministic assessment works without any model provider.
- Assessment artifacts are stored separately from raw diary entries/goals with run ID, engine type, engine name/version, config/provenance metadata, status, and timestamps.
- Evidence snippets are bounded and linked back to diary entry IDs; full diary bodies are not duplicated into assessment tables.
- Human can review, edit, and ignore assessment outputs.
- No external LLM/API call is possible unless explicitly configured and approved.
- API errors and logs are sanitized and do not leak diary/goal content, DB paths, stack traces, provider diagnostics, or raw prompts.
- Tests use fake fixture diary/goal text only.
- Tests cover auth gating, invalid scopes, no-store/not-configured behavior, deterministic assessment output, provenance fields, review/ignore updates, and sanitized errors.
- Documentation warns that assessment is reflective coaching, not a machine verdict.
- No live deployment, restart, provider setup, or data migration occurs as part of the implementation unless separately approved.

## Non-goals

- Replacing Ben's judgment about his own priorities.
- Deleting, editing, or archiving diary entries automatically.
- Automatically changing goal status.
- Sending personal diary content to external services by default.
- Building a quantified productivity score for its own sake.
- Storing real personal examples in Git or tests.

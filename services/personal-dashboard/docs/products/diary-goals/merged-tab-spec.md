# Spec: Merged Diary and Goals Dashboard Tab
# Task t_4270f4e7

Status: spec only — no live mutation.

---

## 1. Existing state

### What exists today

The personal dashboard at `services/personal-dashboard` has seven top-level hash-backed tabs:

  overview / work / knowledge / reports / investment-screener / diary / goals

Diary and Goals are fully implemented as separate tabs with:

**Storage** — `src/personal-data-store.js` owns Postgres schema v1:
  - `goals` table: id, title, description, status, target_date, created_at,
    updated_at, completed_at, archived_at
  - `diary_entries` table: id, entry_date, title, body, mood, created_at, updated_at
  - `diary_entry_goals` join table: diary_entry_id, goal_id, link_type, created_at

**APIs** (all behind reverse-proxy auth):
  - GET  /api/goals?status=...
  - GET  /api/goals/:id
  - POST /api/goals
  - PATCH /api/goals/:id
  - GET  /api/diary/entries?limit=&offset=
  - GET  /api/diary/entries/:id
  - POST /api/diary/entries

**UI elements** in `public/index.html`:
  - #tab-diary / #panel-diary containing:
      #diary-entry-form, #diary-entry-date, #diary-entry-title,
      #diary-entry-body, #diary-entry-mood, #diary-entry-list, #diary-entry-detail
  - #tab-goals / #panel-goals containing:
      #goal-form, #goal-title, #goal-description, #goal-status, #goal-target-date,
      #goal-status-filter, #goals-list, #goal-detail

**Frontend** `public/app.js`:
  - TAB_IDS includes 'diary' and 'goals' as separate entries
  - loadTabData dispatches to refreshDiaryEntries() or refreshGoals() separately
  - Diary and Goals JS are separate function families

**Tests**: 143 passing (npm test, 2026-08-23)
  - test/app-diary.test.js: structure, form IDs, API paths, no delete/export/assessment
  - test/app-goals.test.js: same pattern for goals
  - test/diary.test.js: Postgres store + API (create, list, view, validate, sanitize)
  - test/goals.test.js: Postgres store + API (create, list, update, validate, sanitize)
  - test/app-tabs.test.js: expects 7 separate tabs including 'diary' and 'goals'

**Future design**: `docs/products/diary-goals/assessment-design.md` — deterministic
  then local-model assessment, stored as separate artifacts from raw diary/goal data.
  That feature is out of scope for this merge.


---

## 2. Proposed merged tab IA

### 2.1 Tab name and route

Rename the tab pair to a single combined entry: **"Diary & Goals"** at route `/#diary-goals`.

Reasoning:
- "Personal" is too vague. "Reflection" is precious. "Diary & Goals" is honest and
  matches what a user looks for — two nouns they already know.
- Combining two low-frequency personal tabs into one reduces the already long tab strip
  (currently 7 tabs) without losing any capability.

Old routes `/#diary` and `/#goals` must redirect to `/#diary-goals` via hashchange
  so bookmarks or external links don't 404 silently. Redirect in the client hash handler:
  if hash is 'diary' or 'goals', rewrite to 'diary-goals' before selectTab fires.


### 2.2 Navigation and layout within the tab

The merged panel uses **two sub-sections stacked vertically**, not sub-tabs.
Sub-tabs would just recreate the original problem one level deeper.

Section order within #panel-diary-goals:

  1. Goals section  (above)
  2. Diary section  (below)

Rationale: Goals are higher-stakes and more frequently consulted for orientation.
Diary is the daily write surface. A user arriving at the tab to write a diary entry
typically already has goals in mind — seeing them first provides context before
the form. A user arriving to update a goal can do so immediately without scrolling.

Within each sub-section the layout stays as-is: form at top, list + detail below.


### 2.3 Section anchors

Each sub-section gets a named anchor link so linking directly to one is still possible:
  - #goals anchor within the merged panel
  - #diary anchor within the merged panel

These are in-page anchors, not hash-route tabs. The tab route is `/#diary-goals`;
within-tab deep links are `/#diary-goals` plus scrolling to the heading. A dedicated
smooth-scroll helper targeting the Goals or Diary heading is optional; if implemented,
add it as a standalone helper that does not alter the tab hash.


### 2.4 Empty and error states

Goals section:
  - No goals configured: "No goals yet. Create one above to start tracking progress."
  - Store not configured (503): "Goals unavailable — personal data store not configured."
  - Store error (503): "Goals unavailable — try refreshing or contact the homelab operator."
  - Loading: "Loading goals…"

Diary section:
  - No entries: "No diary entries yet. Write your first entry above."
  - Store not configured (503): "Diary unavailable — personal data store not configured."
  - Store error (503): "Diary unavailable — try refreshing."
  - Loading: "Loading diary entries…"

Both errors should use the existing `.error` CSS class. Neither should expose the
Postgres connection string, stack trace, or raw error message.

The "not configured" 503 and "store error" 503 can be distinguished by the
`error` field in the JSON response:
  - `personal_data_not_configured` → "not configured" copy
  - `personal_data_unavailable`    → "unavailable, try refreshing" copy


### 2.5 Panel heading

Replace the two separate panel headings with one:

```html
<section id="panel-diary-goals" class="tab-panel" ...>
  <section class="panel" id="goals-section">
    <div class="panel-heading">
      <div>
        <h2>Goals</h2>
        <p class="muted board-message">
          Goals can be created, viewed, and moved between active, paused,
          completed, and archived states.
        </p>
      </div>
      <button id="refresh-goals" type="button">Refresh</button>
    </div>
    <!-- existing goals form, filter, list, detail -->
  </section>

  <section class="panel" id="diary-section">
    <div class="panel-heading">
      <div>
        <h2>Diary</h2>
        <p class="muted board-message">
          Diary entries can be created and viewed here.
          Editing and deleting are not part of this MVP.
        </p>
      </div>
      <button id="refresh-diary" type="button">Refresh</button>
    </div>
    <!-- existing diary form, list, detail -->
  </section>
</section>
```

All existing element IDs inside each section are preserved exactly.
Only the outer wrapper changes: #panel-diary and #panel-goals become children
of a single #panel-diary-goals.


### 2.6 Diary-to-goal relationship in the UI

The existing schema already supports diary_entry_goals links. The merged tab
should surface this relationship where the data already exists:

- In the diary entry detail view, linked goals continue to render as a list
  (already implemented: entry.goals array is shown as #diary-entry-detail linked goals).
- No new write controls are needed for MVP linking — manual goal_ids on diary create
  is already supported but the UI form does not expose it yet.
- Do not add a goal selector to the diary create form in this merge task.
  That is follow-up UX if Ben decides the cross-link workflow is important enough
  to surface in the form. Leave it to a separate implementation task.

The key benefit of merging is visible co-location: when Ben opens the tab,
he sees his active goals at the top and can then scroll to write a diary entry
with those goals in context.


---

## 3. Data-preservation rules and migration/backward-compatibility

### 3.1 No API changes

The following APIs remain unchanged, including URL, method, schema, auth gate,
and response envelope:

  GET  /api/goals?status=...
  GET  /api/goals/:id
  POST /api/goals
  PATCH /api/goals/:id
  GET  /api/diary/entries?limit=&offset=
  GET  /api/diary/entries/:id
  POST /api/diary/entries

No new endpoints are required. No existing endpoints are deprecated or removed.


### 3.2 No schema changes

Postgres schema version 1 (goals, diary_entries, diary_entry_goals) is unchanged.
No migration is needed. No data is moved, deleted, or transformed.


### 3.3 Client hash redirect

The only backward-compatibility shim is a client-side hash redirect:

  if hash === 'diary' or hash === 'goals'
    → rewrite URL to #diary-goals and proceed as if that hash was requested

This is a one-liner in the tabIdFromHash() helper. No server-side redirect is needed
because these are fragment-only URLs that never reach the server.


### 3.4 TAB_IDS change

TAB_IDS in app.js changes from:
  ['overview', 'work', 'knowledge', 'reports', 'investment-screener', 'diary', 'goals']

to:
  ['overview', 'work', 'knowledge', 'reports', 'investment-screener', 'diary-goals']

The loadTabData() handler for 'diary-goals' calls both refreshDiaryEntries() and
refreshGoals() when the tab first loads, then each Refresh button calls its own
function as before.


---

## 4. Acceptance criteria

### 4.1 Implementation

- [ ] Tab strip shows 6 tabs: Overview, Work, Knowledge, Reports, Investment Screener,
      Diary & Goals. No separate Diary or Goals tabs.
- [ ] /#diary-goals loads a single panel with Goals section above and Diary section below.
- [ ] /#diary redirects client-side to /#diary-goals without a visible error.
- [ ] /#goals redirects client-side to /#diary-goals without a visible error.
- [ ] All existing element IDs are preserved: goal-form, goal-title, goal-description,
      goal-status, goal-target-date, goal-status-filter, goals-list, goal-detail,
      diary-entry-form, diary-entry-date, diary-entry-title, diary-entry-body,
      diary-entry-mood, diary-entry-list, diary-entry-detail.
- [ ] Both Refresh buttons remain functional.
- [ ] Empty states display correctly when no data exists.
- [ ] Error states use safe copy without exposing Postgres errors.
- [ ] Linked goals still appear in diary entry detail view when present.
- [ ] No delete, export, or automated assessment controls appear anywhere.
- [ ] No real diary entries or goal text appear in any committed file, test output,
      or Kanban comment.


### 4.2 Tests

All tests that currently reference 'diary' and 'goals' as separate TAB_IDS must be
updated to reflect 'diary-goals'. Specifically:

test/app-tabs.test.js:
  - Expects 6 tabs in the tab list (not 7).
  - Expects TAB_IDS = ['overview', 'work', 'knowledge', 'reports',
    'investment-screener', 'diary-goals'].
  - Expects 'diary-goals' tab/panel exists with correct aria attributes.
  - Expects loadTabData for 'diary-goals' calls both refreshDiaryEntries()
    and refreshGoals().
  - Removes separate 'diary' and 'goals' tab/panel assertions.
  - Adds assertion: hash 'diary' or 'goals' is handled (redirects or falls through
    to 'diary-goals').

test/app-diary.test.js:
  - Update: #panel-diary is no longer a top-level tab panel. The aria-labelledby
    assertion will need to change. The diary panel is now #diary-section inside
    #panel-diary-goals, or the existing #panel-diary wrapper may be kept as an
    inner section — implementer should decide the cleanest structure.
  - Alternatively, keep the outer element ID as #diary-section with the
    tab-panel ARIA on #panel-diary-goals, and update tests accordingly.
  - Form ID assertions remain unchanged (#diary-entry-form etc).
  - TAB_IDS assertion changes to include 'diary-goals', not separate 'diary'.
  - loadTabData assertion: tabId === 'diary-goals' calls refreshDiaryEntries().

test/app-goals.test.js:
  - Mirror of diary test updates: panel wrapping changes, TAB_IDS reflects
    'diary-goals', loadTabData for 'diary-goals' calls refreshGoals().

diary.test.js, goals.test.js:
  - No changes required. Server API and Postgres store are unchanged.

New test assertions to add (can be in app-tabs.test.js or a new
test/app-diary-goals.test.js):
  - Panel structure: #panel-diary-goals exists as the top-level tab panel,
    contains a Goals section and a Diary section.
  - Within Goals section: all goal element IDs present.
  - Within Diary section: all diary element IDs present.
  - Hash redirect: tabIdFromHash('#diary') returns 'diary-goals'.
  - Hash redirect: tabIdFromHash('#goals') returns 'diary-goals'.


### 4.3 Review

- [ ] npm test passes (currently 143 tests; count should remain the same or increase
      as redirect tests are added).
- [ ] Tab strip renders correctly in desktop and mobile viewport widths.
- [ ] /#diary and /#goals both route to the merged tab without a broken panel.
- [ ] Goals and Diary sections are both visible and interactive on the merged tab.
- [ ] No visual regression on other tabs (Overview, Work, Knowledge, Reports,
      Investment Screener).
- [ ] No console errors during tab navigation.


### 4.4 Deploy

- [ ] Container smoke passes: `npm run smoke:container`
- [ ] New container image built and deployed to critical LXC (192.168.0.50)
      via the standard reviewed deploy process — no live deploy from the
      implementation card itself.
- [ ] Deployment is bounded: previous image tag is noted before deploy, and a
      rollback procedure is available.
- [ ] PERSONAL_DASHBOARD_DATABASE_URL is rendered from Vaultwarden (homelab /
      personal-dashboard/database) and is not committed to Git.
- [ ] No Diary or Goals data is modified, exported, or deleted as part of deploy.


### 4.5 Post-deploy verification

- [ ] Open live dashboard, navigate to /#diary-goals. Goals section and Diary section
      are both visible.
- [ ] Navigate to /#diary via address bar. Browser lands on the Diary & Goals tab.
- [ ] Navigate to /#goals via address bar. Browser lands on the Diary & Goals tab.
- [ ] Create a fake test goal ("Post-deploy smoke test goal - delete me") and verify
      it appears in the Goals list. Then archive it (PATCH status to archived).
- [ ] Create a fake test diary entry and verify it appears in the Diary list.
  NOTE: Do not use real personal content as smoke data. Use obviously fake text.
- [ ] Confirm no other tabs are broken by navigating through all six tabs.
- [ ] Container logs show no unexpected errors or stack traces.


---

## 5. Non-goals for this merge

- No new data model, migration, or schema change.
- No diary-to-goal link UI in the create form (existing detail view links are fine).
- No automated assessment, scoring, or LLM feature.
- No delete, export, or destructive operation.
- No new API endpoint.
- No server-side redirect for old fragment URLs.
- No sub-tab navigation within the merged panel.
- No reordering or removal of the six remaining tabs.

# Home Dashboard Tabs and Information Architecture Plan

> For Hermes: use this as a lightweight implementation plan for reorganising the existing personal dashboard UI. Do not deploy, restart, or enable write/mutation behaviour as part of this work.

Goal: make the dashboard easier to scan now that it contains service status, links, Kanban, completed epics, documentation, Finnick reporting, and investment screener output.

Architecture: keep the app as the current dependency-free static frontend plus authenticated JSON APIs. Add client-side tabs/hash navigation around existing panels instead of introducing a router, database, or dashboard-framework-shaped garden shed. Default to read-only display and keep all existing data endpoints authenticated and sanitized.

Tech stack: Node.js >=22, plain HTML/CSS/JavaScript, existing `node:test` suite.

## Current dashboard structure observed

Files inspected:

- `services/personal-dashboard/public/index.html`
- `services/personal-dashboard/public/app.js`
- `services/personal-dashboard/public/styles.css`
- `services/personal-dashboard/src/server.js`
- `services/personal-dashboard/README.md`
- `services/personal-dashboard/test/app-links.test.js`
- `services/personal-dashboard/test/server.test.js`
- `services/personal-dashboard/docs/epics/index.json`

Current top-level page order is a single long scroll:

1. Hero: `Home Dashboard` intro.
2. Service status: `#status-list`, `GET /api/status`.
3. Kanban Board: `#kanban-panel`, `GET /api/kanban/board`.
4. Links: `#sections`, `GET /api/config/public`.
5. Finnick Daily Betting Report: `#finnick-panel`, `GET /api/finnick/report`.
6. Investment Screener: `#investment-screener-panel`, `GET /api/investment-screener/ranked`.
7. Documentation: `#docs-panel`, `GET /api/docs`, `GET /api/docs/:id`.
8. Completed Epics: `#epics-panel`, `GET /api/epics`.

The current app already has a read-only default posture: Kanban mutations are disabled unless server-side environment explicitly enables them. This IA change should not add new write paths and should not make mutation controls more prominent.

## Recommended IA

Use four primary tabs:

1. `Overview`
   - Purpose: first-glance household/network status.
   - Contains:
     - Service status panel.
     - Links panel.
   - Why: these are the dashboard's most frequent, low-context checks.

2. `Work`
   - Purpose: active Hermes/Kanban work only.
   - Contains:
     - Kanban Board panel.
   - Default state:
     - Keep compact board enabled by default.
     - Preserve existing lane collapse and compact preferences.
     - Keep read-only message visible near the panel heading.
   - Why: Kanban is large and interaction-heavy enough to deserve its own surface.

3. `Knowledge`
   - Purpose: completed work and docs.
   - Contains:
     - Completed Epics panel.
     - Documentation panel.
   - Order inside tab:
     - Completed Epics first, because it provides the narrative index.
     - Documentation viewer second, because it is the detail reader.
   - Cross-link behaviour:
     - Existing epic `doc_links` should keep opening docs by opaque `/api/docs/:id` URLs.
     - If a link points at `/api/docs/<id>`, prefer intercepting the click and selecting that document inside the current docs viewer later as an enhancement; initial implementation may leave current link behaviour alone.
   - Why: epics and docs are both historical/contextual knowledge. Keeping them together avoids a tab for every noun in the building.

4. `Reports`
   - Purpose: generated reports and analytical outputs.
   - Contains:
     - Finnick Daily Betting Report.
     - Investment Screener.
     - Any future file-backed report panel using the existing `GET /api/<name>/report` pattern, such as homelab health analytics, personal health analytics, or blog/recent-post summaries if they are later implemented.
   - Why: Finnick and investment screener are both generated outputs with freshness/error states and disclaimers.

Do not add a fifth `Settings` or `Admin` tab. The dashboard is not an admin console. It should stay authenticated and mostly read-only, not grow a cockpit by accident.

## Route and state model

Use hash routes, not server routes:

- `/#overview`
- `/#work`
- `/#knowledge`
- `/#reports`

Default landing behaviour:

- `/` with no hash selects `Overview`.
- Unknown hash falls back to `Overview` and updates the selected tab state without throwing.
- Browser Back/Forward changes tabs via `hashchange`.
- Reload preserves the selected tab naturally through the URL hash.
- Existing scroll restoration code should either be removed for tabbed panels or scoped to per-tab scroll keys. With tabs, restoring a long-page scroll offset from the old single-page layout can create confusing jumps.

Recommended storage keys:

- Keep existing Kanban keys:
  - `personal-dashboard:kanban-compact`
  - `personal-dashboard:kanban-collapsed-lanes`
- Replace current single scroll key with optional per-tab keys only if needed:
  - `personal-dashboard:scroll:<tab-id>`

Initial implementation can skip custom scroll restoration entirely because each tab is much shorter. Less magic is often the cheapest bug fix.

## Component/layout changes

### `public/index.html`

Add a tab navigation block immediately after the hero:

```html
<nav class="dashboard-tabs" aria-label="Dashboard sections">
  <div class="tab-list" role="tablist" aria-label="Dashboard sections">
    <a id="tab-overview" class="dashboard-tab" role="tab" href="#overview" aria-controls="panel-overview" aria-selected="true">Overview</a>
    <a id="tab-work" class="dashboard-tab" role="tab" href="#work" aria-controls="panel-work" aria-selected="false">Work</a>
    <a id="tab-knowledge" class="dashboard-tab" role="tab" href="#knowledge" aria-controls="panel-knowledge" aria-selected="false">Knowledge</a>
    <a id="tab-reports" class="dashboard-tab" role="tab" href="#reports" aria-controls="panel-reports" aria-selected="false">Reports</a>
  </div>
</nav>
```

Wrap existing panels into tab panels:

```html
<section id="panel-overview" class="tab-panel" role="tabpanel" aria-labelledby="tab-overview" data-tab-panel="overview">
  <!-- existing Service status panel -->
  <!-- existing Links panel -->
</section>

<section id="panel-work" class="tab-panel" role="tabpanel" aria-labelledby="tab-work" data-tab-panel="work" hidden>
  <!-- existing Kanban panel -->
</section>

<section id="panel-knowledge" class="tab-panel" role="tabpanel" aria-labelledby="tab-knowledge" data-tab-panel="knowledge" hidden>
  <!-- existing Completed Epics panel -->
  <!-- existing Documentation panel -->
</section>

<section id="panel-reports" class="tab-panel" role="tabpanel" aria-labelledby="tab-reports" data-tab-panel="reports" hidden>
  <!-- existing Finnick panel -->
  <!-- existing Investment Screener panel -->
</section>
```

Recommended panel order after wrapping:

- Overview: Service status, Links.
- Work: Kanban.
- Knowledge: Completed Epics, Documentation.
- Reports: Finnick, Investment Screener.

### `public/app.js`

Add tab state near the existing query selectors:

```js
const TAB_IDS = ['overview', 'work', 'knowledge', 'reports'];
const DEFAULT_TAB_ID = 'overview';
const tabs = new Map(TAB_IDS.map((id) => [id, document.querySelector(`#tab-${id}`)]));
const tabPanels = new Map(TAB_IDS.map((id) => [id, document.querySelector(`#panel-${id}`)]));
const loadedTabs = new Set();
```

Add helpers:

```js
function tabIdFromHash(hash = window.location.hash) {
  const id = String(hash || '').replace(/^#/, '').toLowerCase();
  return TAB_IDS.includes(id) ? id : DEFAULT_TAB_ID;
}

async function loadTabData(tabId) {
  if (loadedTabs.has(tabId)) return;
  loadedTabs.add(tabId);
  if (tabId === 'overview') {
    try { renderConfig(await getJson('/api/config/public')); }
    catch (error) { sections.replaceChildren(el('p', { className: 'error', text: `Config unavailable: ${error.message}` })); }
    await refreshStatus();
  } else if (tabId === 'work') {
    await refreshKanban();
  } else if (tabId === 'knowledge') {
    await refreshEpics();
    await refreshDocs();
  } else if (tabId === 'reports') {
    await refreshFinnick();
    await refreshInvestmentScreener();
  }
}

async function selectTab(tabId, { updateHash = true } = {}) {
  const nextTabId = TAB_IDS.includes(tabId) ? tabId : DEFAULT_TAB_ID;
  for (const id of TAB_IDS) {
    const selected = id === nextTabId;
    tabs.get(id)?.setAttribute('aria-selected', String(selected));
    tabs.get(id)?.setAttribute('tabindex', selected ? '0' : '-1');
    const panel = tabPanels.get(id);
    if (panel) panel.hidden = !selected;
  }
  if (updateHash && window.location.hash !== `#${nextTabId}`) {
    window.history.pushState(null, '', `#${nextTabId}`);
  }
  await loadTabData(nextTabId);
}
```

Add keyboard support:

```js
function focusAdjacentTab(currentId, direction) {
  const index = TAB_IDS.indexOf(currentId);
  const nextIndex = (index + direction + TAB_IDS.length) % TAB_IDS.length;
  const nextId = TAB_IDS[nextIndex];
  tabs.get(nextId)?.focus();
  selectTab(nextId);
}

for (const [id, tab] of tabs) {
  tab?.addEventListener('click', (event) => {
    event.preventDefault();
    selectTab(id);
  });
  tab?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') { event.preventDefault(); focusAdjacentTab(id, 1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); focusAdjacentTab(id, -1); }
    if (event.key === 'Home') { event.preventDefault(); tabs.get(DEFAULT_TAB_ID)?.focus(); selectTab(DEFAULT_TAB_ID); }
    if (event.key === 'End') { event.preventDefault(); tabs.get(TAB_IDS.at(-1))?.focus(); selectTab(TAB_IDS.at(-1)); }
  });
}

window.addEventListener('hashchange', () => selectTab(tabIdFromHash(), { updateHash: false }));
```

Change `boot()` from loading every panel immediately to loading the selected tab only:

```js
async function boot() {
  await selectTab(tabIdFromHash(), { updateHash: false });
  dashboardBootComplete = true;
}
```

Then remove or simplify the old global scroll restoration block. If it stays, test it carefully with hidden tab panels. Hidden panels plus restored document scroll is exactly the sort of small ghost that becomes a support ticket.

Refresh buttons should continue to call their existing `refresh*()` functions and work only when their tab has loaded.

### `public/styles.css`

Add tab styles near the hero/panel rules:

```css
.dashboard-tabs {
  position: sticky;
  top: 0;
  z-index: 10;
  margin: 0 0 1rem;
  padding: 0.5rem 0;
  background: linear-gradient(180deg, rgba(14,17,23,0.96), rgba(14,17,23,0.78));
  backdrop-filter: blur(8px);
}
.tab-list {
  display: flex;
  gap: 0.5rem;
  overflow-x: auto;
  padding-bottom: 0.15rem;
}
.dashboard-tab {
  flex: 0 0 auto;
  min-height: 2.5rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.55rem 0.9rem;
  border: 1px solid #3b4658;
  border-radius: 999px;
  color: #e6edf3;
  background: #172033;
  text-decoration: none;
}
.dashboard-tab[aria-selected="true"] {
  border-color: #8cc2ff;
  color: #0e1117;
  background: #8cc2ff;
}
.dashboard-tab:focus-visible {
  outline: 3px solid #ffd580;
  outline-offset: 2px;
}
.tab-panel[hidden] { display: none; }
```

Responsive behaviour:

- At desktop widths, tabs remain a horizontal sticky tab strip.
- At mobile widths, keep the same horizontal scrollable tab strip rather than stacking into a tall menu.
- Ensure tab labels remain visible and touch targets stay at least roughly 44px high.
- Existing panel media rules at `max-width: 560px` can remain.

Optional later enhancement: add short count badges to tab labels, e.g. `Work 12`, `Reports 2`, but only if those counts come from already-loaded payloads. Do not add summary APIs for this first pass.

## Data/API changes

Required: none.

This should be a pure UI organisation change using existing endpoints:

- `GET /api/config/public`
- `GET /api/status`
- `GET /api/kanban/board`
- `GET /api/epics`
- `GET /api/docs`
- `GET /api/docs/:id`
- `GET /api/finnick/report`
- `GET /api/investment-screener/ranked`

Do not introduce a generic content endpoint, filesystem browsing, unauthenticated API, or mutation endpoint.

Possible later API improvement, not needed for this implementation:

- `GET /api/dashboard/summary` returning small sanitized counts/freshness values for tab badges. Avoid unless the UI proves it needs badges; YAGNI is not just a bumper sticker.

## Read-only posture requirements

- Keep `KANBAN_MUTATIONS_ENABLED` default false.
- Do not add any new POST/PUT/PATCH/DELETE routes.
- Do not enable dashboard-side Kanban mutations in Compose, `.env.example`, Dockerfile, or live scripts.
- In `Work`, if `mutations.enabled === false`, the read-only message must remain visible.
- Consider hiding disabled card action buttons in read-only mode in a later follow-up if the UI still feels noisy. If implemented, keep a short explicit read-only label so users do not think the board is broken.

## Implementation tasks

### Task 1: Add tab landmarks in HTML

Objective: wrap existing panels into four semantic tab panels.

Files:

- Modify: `services/personal-dashboard/public/index.html`

Steps:

1. Insert the `dashboard-tabs` nav after the hero.
2. Wrap Service status and Links in `#panel-overview`.
3. Wrap Kanban in `#panel-work`.
4. Wrap Completed Epics and Documentation in `#panel-knowledge`.
5. Wrap Finnick and Investment Screener in `#panel-reports`.
6. Preserve all existing element ids used by `app.js` tests/selectors.

Verification:

- Search confirms these ids exist: `tab-overview`, `panel-overview`, `tab-work`, `panel-work`, `tab-knowledge`, `panel-knowledge`, `tab-reports`, `panel-reports`.
- Existing ids still exist: `status-list`, `sections`, `kanban-board`, `finnick-content`, `investment-screener-content`, `docs-list`, `docs-content`, `epics-list`.

### Task 2: Add tab selection logic

Objective: make hash-backed tabs work without a frontend framework.

Files:

- Modify: `services/personal-dashboard/public/app.js`
- Test: `services/personal-dashboard/test/app-links.test.js` or a new `test/app-tabs.test.js`

Steps:

1. Add `TAB_IDS`, `tabs`, `tabPanels`, and `loadedTabs` constants.
2. Add `tabIdFromHash()`, `loadTabData()`, and `selectTab()` helpers.
3. Wire click, `hashchange`, ArrowLeft/ArrowRight/Home/End keyboard support.
4. Change `boot()` to load only the selected tab.
5. Decide whether to remove old scroll restoration or scope it per tab. Recommended first pass: remove custom global scroll restore and rely on hash-selected tabs.

Verification:

- `/` selects Overview.
- `/#work` selects Work and loads Kanban.
- `/#knowledge` selects Knowledge and loads epics/docs.
- `/#reports` selects Reports and loads Finnick/investment screener.
- Browser Back/Forward changes selected tab.
- No console errors during tab changes.

### Task 3: Add tab styling and mobile behaviour

Objective: make tab navigation clear, sticky, keyboard-visible, and mobile-safe.

Files:

- Modify: `services/personal-dashboard/public/styles.css`

Steps:

1. Add `.dashboard-tabs`, `.tab-list`, `.dashboard-tab`, `.dashboard-tab[aria-selected="true"]`, `.dashboard-tab:focus-visible`, and `.tab-panel[hidden]` rules.
2. Confirm mobile tab strip scrolls horizontally rather than stacking into a second dashboard.
3. Check sticky nav does not obscure anchors or the hero.

Verification:

- Desktop: four tabs visible in one row at normal widths.
- Mobile: tab strip scrolls horizontally; tap targets remain usable.
- Keyboard focus ring is visible in dark theme.

### Task 4: Preserve read-only Kanban behaviour

Objective: ensure IA does not accidentally make the dashboard operationally writable.

Files:

- Modify if needed: `services/personal-dashboard/public/app.js`
- Modify if needed: `services/personal-dashboard/public/styles.css`
- Test: existing Kanban tests in `services/personal-dashboard/test/server.test.js`; add frontend source assertions if helpful.

Steps:

1. Confirm no `KANBAN_MUTATIONS_ENABLED` defaults change.
2. Confirm `renderKanbanBoard()` still uses server `payload.mutations`.
3. Confirm read-only message is displayed in Work tab when mutations are disabled.
4. Optional: in read-only mode, hide card action button row with CSS/JS while leaving the explicit read-only message. Do not remove the server-side protection; UI hiding is not a safety boundary.

Verification:

- Existing tests covering Kanban auth/mutation safety still pass.
- Manual smoke confirms disabled mutations leave cards non-draggable/action-disabled or hidden, depending on implementation choice.

### Task 5: Update docs and manual smoke checklist

Objective: document the new IA and verification path.

Files:

- Modify: `services/personal-dashboard/README.md`

Steps:

1. Add a short `Dashboard navigation` section near `What is included` or before panel-specific sections.
2. Document the four tabs and their contents.
3. Update manual browser regression checklist to include:
   - default Overview load;
   - direct hash load for each tab;
   - keyboard tab navigation;
   - mobile horizontal tab strip;
   - read-only Work/Kanban state.

Verification:

- README does not include local filesystem paths, secrets, tokens, stderr logs, or raw private task details.

## Test and smoke checklist

Run from `services/personal-dashboard`:

```bash
npm test
```

Expected: full Node test suite passes. The wrapper should use Node 22 if the host Node is older.

Add/adjust source-level frontend tests:

- `index.html` contains the tablist and four tab panels.
- `app.js` contains `TAB_IDS` with exactly `overview`, `work`, `knowledge`, `reports`.
- `app.js` uses hash navigation and `aria-selected` updates.
- Existing external/generated links keep `rel="noreferrer noopener"`.
- Existing docs viewer still uses `/api/docs/:id`, not browser-supplied paths.

Manual browser smoke, local only:

```bash
DASHBOARD_AUTH_MODE=disabled DASHBOARD_ALLOW_DISABLED_AUTH=true DASHBOARD_CONFIG_FILE=./config/dashboard.public.example.json npm start
```

Then verify:

1. Open `http://127.0.0.1:4322/`; Overview is selected.
2. Click Work, Knowledge, Reports, Overview; only one tab panel is visible each time.
3. Open `http://127.0.0.1:4322/#work`; Work is selected after reload.
4. Use ArrowLeft/ArrowRight/Home/End on focused tabs; selected tab and focus update predictably.
5. Use browser Back/Forward after tab clicks; selected tab tracks URL hash.
6. In Work tab, read-only Kanban message is visible and mutations are not enabled unless explicitly configured server-side.
7. In Knowledge tab, Completed Epics and Documentation load; selecting a doc still fetches by opaque id.
8. In Reports tab, Finnick and Investment Screener load or show their existing safe error states.
9. Resize to mobile width; tab strip remains usable and panels do not overflow awkwardly.
10. DevTools console stays clean during load, tab changes, refresh buttons, and docs selection.

Container smoke remains unchanged:

```bash
npm run smoke:container
```

No deployment/restart is part of this plan.

## Acceptance criteria

- Dashboard has clear primary navigation with four tabs: Overview, Work, Knowledge, Reports.
- Default landing is Overview.
- Existing panels are grouped as described without losing current refresh buttons or error states.
- Existing authenticated APIs and sanitization boundaries remain unchanged.
- Dashboard remains read-only by default; no live service deploy/restart or mutation enablement occurs.
- Keyboard and screen-reader basics are present: `role="tablist"`, `role="tab"`, `role="tabpanel"`, `aria-selected`, `aria-controls`, `aria-labelledby`, visible focus styles.
- Mobile layout uses a horizontally scrollable tab strip and keeps panels readable.
- `npm test` passes, plus manual smoke checks for direct hash routes and tab keyboard behaviour.

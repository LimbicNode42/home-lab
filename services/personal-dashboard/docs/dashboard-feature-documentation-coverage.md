# Personal Dashboard Feature Documentation Coverage Audit

Status: audit artifact for task `t_0c86c5c6`; no live mutation.

## Scope and evidence

Audited source files:

- `services/personal-dashboard/public/index.html`
- `services/personal-dashboard/public/app.js`
- `services/personal-dashboard/src/server.js`
- `services/personal-dashboard/src/config.js`
- `services/personal-dashboard/config/dashboard.public.json`
- `services/personal-dashboard/README.md`
- `services/personal-dashboard/docs/**/*.md`
- `services/personal-dashboard/docs/epics/index.json`

Current dashboard visibility from `public/index.html` and `public/app.js`:

| Tab / surface | Current visibility |
| --- | --- |
| Overview | Visible top-level tab: service status and configured links |
| Knowledge | Visible top-level tab: Documentation panel, then Completed Epics |
| Blog / Drafts | Visible top-level tab: writing post list, editor modal, status filter, preview |
| Reports | Visible top-level tab: Finnick report and Homelab Health report |
| Investment Screener | Visible top-level tab: ranked candidates, filters, pagination, data-source/coverage panel |
| Diary & Goals | Visible top-level tab: Goals section above Diary section |
| Datasets | API-backed only; no current browser tab or panel found |
| Kanban board / Work | Not currently visible in `index.html`/`TAB_IDS`; stale CSS/tests/docs references remain |

Current approved Documentation panel manifest from `src/server.js` includes:

- `dashboard-readme` -> `services/personal-dashboard/README.md`
- `home-lab-service-catalog` -> `services/personal-dashboard/docs/products/home-lab/service-catalog.md`
- `investment-screener-*` -> six product docs under `services/personal-dashboard/docs/products/investment-screener/`
- `service-catalog` -> `docs/service-catalog.md`
- `backup-coverage` -> `docs/backup-coverage-matrix.md`

Completed Epic docs in `services/personal-dashboard/docs/epics/index.json` are intentionally reachable from Completed Epics links via `/api/docs/:id`; they are not listed in the Documentation panel manifest. Keep that separation. Completed Epics should not be reintroduced as Documentation panel entries.

## Coverage matrix

| Feature / API-backed surface | Existing docs / registry status | Missing user guidance | Stale or conflicting sections | Dashboard visibility | Recommended doc file/path |
| --- | --- | --- | --- | --- | --- |
| Dashboard shell, reverse-proxy auth, deployment safety, config loading | `README.md` covers auth, proposed route, config shape, env vars, deploy/rollback; visible in docs manifest as `dashboard-readme`. | Needs a short user-first dashboard overview separate from operator deploy notes: what each tab is for, how auth errors appear, and what users can/cannot change. | `README.md` still says the dashboard has seven hash-backed tabs and lists a `Work` tab; actual UI has six tabs and no `Work`. | Whole app; `/healthz`; `/api/config/public`. | Update `services/personal-dashboard/README.md`; add `services/personal-dashboard/docs/products/dashboard/overview.md` if the overview should be surfaced in Documentation panel. |
| Overview: Homelab status cards | `README.md` briefly covers `GET /api/status`; `config.dashboard.public.json` shows current checks; no user-facing status guide. | Explain status card states, refresh behavior, what `Open` means, why internal target URLs are hidden, and how to interpret timeout/error text. | None severe, but status is buried in operator README config details. | Visible in Overview tab; refresh button; `/api/status`. | `services/personal-dashboard/docs/products/dashboard/overview-status.md` and manifest id `dashboard-overview-status`. |
| Overview: configured links | `README.md` config section documents sections/links shape; no user-facing guide. | Explain link groups, who curates them, and why some internal URLs may be present behind auth. | README's navigation section includes stale `/#work` direct-link examples. | Visible in Overview tab via `/api/config/public`. | Same as `dashboard-overview-status` or `services/personal-dashboard/docs/products/dashboard/links.md`. |
| Knowledge: Documentation panel | `README.md` has a strong Documentation panel safety model and add-doc instructions; visible as `dashboard-readme`. | Needs a concise user guide for search, grouping, selecting docs, reader overlay, TOC/anchors, and why only allowlisted docs appear. | README says default approved docs include only dashboard/investment/ops docs; actual manifest now also includes Home Lab Service Catalog. | Visible in Knowledge tab; `/api/docs`, `/api/docs/:id`. | `services/personal-dashboard/docs/products/dashboard/documentation-panel.md`; add to manifest as `dashboard-documentation-panel`. |
| Knowledge: Completed Epics panel | `README.md` documents `/api/epics` and says completed epics expose doc links; `docs/epics/README.md` and `docs/epics/index.json` exist. | User guidance should explain what qualifies as an epic, how subtasks/doc links are chosen, date sorting, and why epics are separate from Documentation search. | README navigation says Knowledge is "completed epics first, then documentation", but current `index.html` renders Documentation first and Completed Epics second. | Visible in Knowledge tab; `/api/epics`; doc links can point to `/api/docs/:id`. | `services/personal-dashboard/docs/products/dashboard/completed-epics.md`; do not add individual epic docs to the Documentation panel list. |
| Blog / Drafts: writing post list, preview, editor, statuses | Runtime/cache model mentions Blog/Drafts; tests cover `writing`; no user-facing product doc found; not in docs manifest. | Need guidance for creating, editing, publishing, archiving, deleting, status filter, tags, Markdown preview/sanitization, attachments display, and persistence expectations. | README intended future expansion still says "Personal blog" is future; actual Blog / Drafts tab exists now. | Visible top-level tab; `/api/writing/posts`, `/api/writing/posts/:id`, POST/PATCH/DELETE. | `services/personal-dashboard/docs/products/blog-drafts/README.md`; manifest id `blog-drafts-guide`. |
| Reports: Finnick daily betting report | `README.md` has a Finnick report panel section with user location, errors, API, verification; not separately surfaced in docs manifest except through Dashboard README. | Could use a shorter user-facing report guide in Documentation panel; include refresh timing, stale/missing states, source responsibility, and non-betting-advice caveat if desired. | README says Finnick appears as the third section on the dashboard home page; actual UI places it in Reports tab. | Visible in Reports tab; `/api/finnick/report`. | `services/personal-dashboard/docs/products/reports/finnick.md`; manifest id `reports-finnick`. |
| Reports: Homelab Health report | `docs/runbook.md` has a strong configuration/troubleshooting section; `README.md` mentions future homelab health analytics, but the feature is now implemented. Not in docs manifest. | Needs user-facing meaning of OK/degraded/stale/empty, alert count badge, refresh behavior, and what action to take when stale or degraded. | README's "Intended future expansion" lists Homelab health analytics as future even though Reports tab includes it now. | Visible in Reports tab; `/api/homelab/health`. | `services/personal-dashboard/docs/products/reports/homelab-health.md`; add `docs/runbook.md` or new guide to manifest if safe. |
| Investment Screener: dashboard panel, filters, pagination, candidates | Strong coverage exists: `docs/products/investment-screener/README.md`, `dashboard-panel.md`, `interpreting-results.md`, `operations-limitations.md`, `cli-generator.md`, and historical pipeline docs; all six primary docs are in manifest. | Minor: update docs for the newer data source / coverage panel if current product docs do not fully describe `source_summary`, `coverage`, alternate denominators, and degraded DuckDB/artifact fallback states. | README's panel docs are extensive and mostly current; typo to avoid in future prose: file is `interpreting-results.md`. | Visible top-level tab; `/api/investment-screener/ranked`, `/api/investment-screener/report`, `/api/investment-screener/coverage` API exists though the UI primarily calls ranked. | Update `services/personal-dashboard/docs/products/investment-screener/dashboard-panel.md` and `operations-limitations.md`; no new path required unless splitting `data-source-coverage.md`. |
| Investment Screener: file-first / DuckDB / NAS artifacts | `docs/products/investment-screener/historical-pipeline-architecture.md`, `asx-hydration-audit-plan.md`, and `docs/runbook.md` cover parts; only six primary screener docs are in manifest, not the hydration audit plan. | Explain which parts are user-facing vs operator-only: latest files, immutable runs/manifests, coverage denominator, data freshness, and limitations of unofficial provider data. | None blocking for user docs, but hydration plan is not surfaced in Documentation panel. | API-backed through `/api/investment-screener/ranked` and `/coverage`; some details shown in source/coverage panel. | Add or update `services/personal-dashboard/docs/products/investment-screener/data-source-coverage.md`; consider manifest id `investment-screener-data-source-coverage`. |
| Diary & Goals: merged tab IA | `docs/products/diary-goals/merged-tab-spec.md`, `diary-goals-mvp-plan.md`, and `assessment-design.md` exist; none are in docs manifest. | Need actual user guide for creating/updating goals, goal statuses, creating/viewing diary entries, old `/#diary` and `/#goals` redirect behavior, privacy guarantees, and no delete/export/assessment in MVP. | `merged-tab-spec.md` describes planned `Work` tab in TAB_IDS, but actual current `TAB_IDS` has no `work`. Some docs still refer to separate Diary and Goals tabs. | Visible top-level tab; `/api/goals`, `/api/goals/:id`, `/api/diary/entries`, `/api/diary/entries/:id`. | `services/personal-dashboard/docs/products/diary-goals/README.md`; manifest id `diary-goals-guide`. |
| Goals sub-feature | MVP/spec docs cover data model and API; no user doc. | Explain statuses: active, paused, completed, archived; form fields; status filter; view/edit behavior; no hard delete. | None beyond merged-tab/stale Work references. | Visible inside Diary & Goals. | Covered by `docs/products/diary-goals/README.md`. |
| Diary sub-feature | MVP/spec docs cover data model and API; no user doc. | Explain entry date, optional title/mood, body limits, list previews, detail view, linked goals display, and absence of edit/delete. | None beyond separate-tab references in older docs. | Visible inside Diary & Goals. | Covered by `docs/products/diary-goals/README.md`. |
| Future Diary/Goals assessment | `docs/products/diary-goals/assessment-design.md` exists; not in manifest. | If surfaced, make it explicitly future/non-live to avoid implying scoring exists. Probably keep out of Documentation panel until feature exists. | Safe as future design, but easy to misread as live if surfaced without warning. | Not visible; no live API found. | Keep as internal design doc for now; do not add to manifest unless clearly labelled future. |
| Datasets API | Server has default dataset registry and routes: `/api/datasets`, `/api/datasets/:id/records`; no UI panel and no user docs found. | Decide whether datasets are intentionally API-only. If yes, document as developer/operator API. If no, create a visible panel spec before user docs. | No visible tab, so avoid presenting datasets as a current dashboard product until UI exists. | Not visible in browser. API-backed. | `services/personal-dashboard/docs/products/datasets/README.md` only if API remains supported; otherwise backlog cleanup/removal. |
| Kanban board / Work tab | Older docs and CSS/tests reference Kanban board, Work tab, mutation safety, and `/api/kanban/board`; current `index.html`, `TAB_IDS`, and server route scan do not expose a Work tab or `/api/kanban/board`. Overview config still links to external Hermes Kanban. | Need decision: either document external Hermes Kanban link only, or reintroduce dashboard Kanban surface in a separate feature. Do not write user guidance for a panel that is not actually visible. | Major stale coverage: `README.md` navigation/checklist says Work/Kanban exists; `dashboard-tabs-ia-plan.md`, `diary-goals-mvp-plan.md`, and `merged-tab-spec.md` contain obsolete Work-tab assumptions. | Not visible as a dashboard tab/panel. External link exists in Overview Links. Completed Epics still reads Kanban DB. | Update `README.md` to remove Work/Kanban panel claims. If external link deserves docs, include it in `dashboard-overview-status.md`/`links.md`, not as a dashboard panel. |
| Completed Epic document registry | `docs/epics/index.json` lists 17 epic docs; server uses `availableReadableDocs()` so individual epic docs can be fetched by id when linked. | Operator docs should explain regeneration/curation rules and why epic docs are not dumped into Documentation panel search. | None found in current registry behavior. | Via Completed Epics doc links only. | Update `services/personal-dashboard/docs/epics/README.md` if needed; keep out of `DEFAULT_DOCS_MANIFEST`. |
| Runtime artifact cache and stale-bind runbook | `docs/runbook.md` covers config/finnick/investment/kanban/homelab-health runtime cache and stale handle recovery. Not currently in docs manifest. | If intended for operators in-browser, surface the runbook or a sanitized subset in Documentation panel. | Runbook is current for Blog/Drafts and Homelab Health; check for any local-path lines before serving because runtime doc sanitizer drops several absolute-path lines. | Not a tab; backs runtime behavior across Reports/Investment/Docs/Kanban snapshots. | Either add `docs/runbook.md` to manifest as operator-only `dashboard-runbook`, or split a browser-safe `docs/products/dashboard/runtime-artifacts.md`. |

## Highest-priority gaps for the writer task

1. Create a browser-safe Dashboard feature guide covering the actual six tabs: Overview, Knowledge, Blog / Drafts, Reports, Investment Screener, Diary & Goals.
2. Create or update user-facing docs for Blog / Drafts and Diary & Goals. These are visible product features with almost no manifest-surfaced user guidance.
3. Create Reports docs for Homelab Health and, optionally, a concise Finnick guide. Homelab Health is implemented but still described as future in `README.md`.
4. Add a Documentation panel guide and Completed Epics guide; keep individual completed-epic docs out of the Documentation panel list.
5. Update stale README navigation/checklist language: actual code has six tabs and no Work/Kanban panel. Do not describe a Work tab unless gremlin intentionally restores it later.
6. Decide whether Datasets is supported API-only or dead code. If supported, document it as API-only; if not, create a cleanup card rather than inventing UI docs.

## Suggested Documentation panel manifest additions

Add only committed, browser-safe Markdown files after they are written and reviewed:

| Manifest id | Title | Category | Path |
| --- | --- | --- | --- |
| `dashboard-overview` | Dashboard Overview | Dashboard | `services/personal-dashboard/docs/products/dashboard/overview.md` |
| `dashboard-documentation-panel` | Documentation Panel Guide | Dashboard | `services/personal-dashboard/docs/products/dashboard/documentation-panel.md` |
| `dashboard-completed-epics` | Completed Epics Guide | Dashboard | `services/personal-dashboard/docs/products/dashboard/completed-epics.md` |
| `blog-drafts-guide` | Blog / Drafts Guide | Blog / Drafts | `services/personal-dashboard/docs/products/blog-drafts/README.md` |
| `reports-homelab-health` | Homelab Health Report Guide | Reports | `services/personal-dashboard/docs/products/reports/homelab-health.md` |
| `reports-finnick` | Finnick Report Guide | Reports | `services/personal-dashboard/docs/products/reports/finnick.md` |
| `diary-goals-guide` | Diary & Goals Guide | Diary & Goals | `services/personal-dashboard/docs/products/diary-goals/README.md` |
| `investment-screener-data-source-coverage` | Investment Screener Data Source and Coverage | Investment Screener | `services/personal-dashboard/docs/products/investment-screener/data-source-coverage.md` |

Do not add `services/personal-dashboard/docs/epics/*.md` to the default Documentation panel manifest. They belong behind Completed Epics links, not in the general docs list.

## Notes for downstream implementation

- Keep docs browser-safe: no private paths, connection strings, credentials, command-error dumps, exception traces, or private task bodies.
- If `docs/runbook.md` is surfaced, verify how much content the runtime sanitizer will drop before relying on it as user guidance.
- Update docs registry/config only after the new files exist and are committed; the server filters uncommitted or missing paths.
- Do not treat stale Kanban/Work docs as current product truth. Code wins here; prose is just code's alibi, and currently it has been caught loitering.

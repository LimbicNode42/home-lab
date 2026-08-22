const title = document.querySelector('#dashboard-title');
const sections = document.querySelector('#sections');
const statusList = document.querySelector('#status-list');
const refreshButton = document.querySelector('#refresh-status');
const finnickContent = document.querySelector('#finnick-content');
const refreshFinnickButton = document.querySelector('#refresh-finnick');
const investmentScreenerContent = document.querySelector('#investment-screener-content');
const refreshInvestmentScreenerButton = document.querySelector('#refresh-investment-screener');
const investmentScreenerControls = document.querySelector('#investment-screener-controls');
const investmentSearchFilter = document.querySelector('#investment-search-filter');
const investmentMarketFilter = document.querySelector('#investment-market-filter');
const investmentMetricFilter = document.querySelector('#investment-metric-filter');
const investmentWeightFilter = document.querySelector('#investment-weight-filter');
const investmentTopNFilter = document.querySelector('#investment-topn-filter');
const resetInvestmentScreenerFiltersButton = document.querySelector('#reset-investment-screener-filters');
const investmentPageSummary = document.querySelector('#investment-page-summary');
const investmentPrevPageButton = document.querySelector('#investment-prev-page');
const investmentNextPageButton = document.querySelector('#investment-next-page');
let investmentScreenerOffset = 0;
const epicsList = document.querySelector('#epics-list');
const docsList = document.querySelector('#docs-list');
const docsContent = document.querySelector('#docs-content');
const docReaderModal = document.querySelector('#doc-reader-modal');
const docReaderDialog = document.querySelector('#doc-reader-dialog');
const docReaderTitle = document.querySelector('#doc-reader-title');
const docReaderMeta = document.querySelector('#doc-reader-meta');
const docReaderContent = document.querySelector('#doc-reader-content');
const closeDocReaderButton = document.querySelector('#close-doc-reader');
const docsSearch = document.querySelector('#docs-search');
const refreshDocsButton = document.querySelector('#refresh-docs');
const writingPostsList = document.querySelector('#writing-posts-list');
const writingPostPreview = document.querySelector('#writing-post-preview');
const writingStatusFilter = document.querySelector('#writing-status-filter');
const refreshWritingPostsButton = document.querySelector('#refresh-writing-posts');
const datasetsList = document.querySelector('#datasets-list');
const datasetRecordsPreview = document.querySelector('#dataset-records-preview');
const refreshDatasetsButton = document.querySelector('#refresh-datasets');
const kanbanPanel = document.querySelector('#kanban-panel');
const kanbanBoard = document.querySelector('#kanban-board');
const kanbanMessage = document.querySelector('#kanban-message');
const refreshKanbanButton = document.querySelector('#refresh-kanban');
const kanbanCompactToggle = document.querySelector('#toggle-kanban-density');
const diaryEntryForm = document.querySelector('#diary-entry-form');
const diaryEntryDate = document.querySelector('#diary-entry-date');
const diaryEntryTitle = document.querySelector('#diary-entry-title');
const diaryEntryBody = document.querySelector('#diary-entry-body');
const diaryEntryMood = document.querySelector('#diary-entry-mood');
const diaryEntryList = document.querySelector('#diary-entry-list');
const diaryEntryDetail = document.querySelector('#diary-entry-detail');
const diaryFormMessage = document.querySelector('#diary-form-message');
const refreshDiaryButton = document.querySelector('#refresh-diary');
const goalForm = document.querySelector('#goal-form');
const goalTitle = document.querySelector('#goal-title');
const goalDescription = document.querySelector('#goal-description');
const goalStatus = document.querySelector('#goal-status');
const goalTargetDate = document.querySelector('#goal-target-date');
const goalStatusFilter = document.querySelector('#goal-status-filter');
const goalsList = document.querySelector('#goals-list');
const goalDetail = document.querySelector('#goal-detail');
const refreshGoalsButton = document.querySelector('#refresh-goals');
const newGoalButton = document.querySelector('#new-goal');
const goalFormMessage = document.querySelector('#goal-form-message');
let currentGoalId = null;
const KANBAN_COMPACT_STORAGE_KEY = 'personal-dashboard:kanban-compact';
const KANBAN_COLLAPSED_LANES_STORAGE_KEY = 'personal-dashboard:kanban-collapsed-lanes';
const KANBAN_COMPACT_CARD_LIMIT = 4;
let currentDraggedTaskId = null;
let currentKanbanMutations = { enabled: false, supported_statuses: [] };
let kanbanCompactMode = readStoredBoolean(KANBAN_COMPACT_STORAGE_KEY, true);
let collapsedKanbanLanes = readStoredJson(KANBAN_COLLAPSED_LANES_STORAGE_KEY, []);
let dashboardBootComplete = false;
const FEATURED_DOC_IDS = ['home-lab-service-catalog'];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

async function getJson(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.json();
}

function readStoredBoolean(key, fallback) {
  try {
    const value = window.localStorage?.getItem(key);
    if (value === 'true') return true;
    if (value === 'false') return false;
  } catch {
    // Rendering should not depend on storage availability. Browsers get touchy.
  }
  return fallback;
}

function readStoredJson(key, fallback) {
  try {
    const value = window.localStorage?.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredJson(key, value) {
  try {
    window.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures; the board still renders.
  }
}

function setStoredBoolean(key, value) {
  try {
    window.localStorage?.setItem(key, String(value));
  } catch {
    // Ignore storage failures; the board still renders.
  }
}

async function writeJson(path, method, payload) {
  const response = await fetch(path, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `${path} returned ${response.status}`);
  }
  return data;
}

function postJson(path, payload) {
  return writeJson(path, 'POST', payload);
}

function patchJson(path, payload) {
  return writeJson(path, 'PATCH', payload);
}

function renderConfig(config) {
  document.title = config.title;
  title.textContent = config.title;
  sections.replaceChildren();

  if (config.sections.length === 0) {
    sections.append(el('p', { className: 'muted', text: 'No links configured yet.' }));
    return;
  }

  for (const section of config.sections) {
    const links = section.links.map((link) => el('a', { href: link.href, text: link.label, rel: 'noreferrer noopener' }));
    sections.append(el('article', { className: 'link-section' }, [
      el('h3', { text: section.title }),
      el('div', { className: 'link-list' }, links)
    ]));
  }
}

function renderStatus(payload) {
  statusList.replaceChildren();
  if (payload.checks.length === 0) {
    statusList.append(el('p', { className: 'muted', text: 'No status checks configured.' }));
    return;
  }

  for (const check of payload.checks) {
    const badge = el('span', { className: `badge ${check.status}`, text: check.status });
    const body = [
      el('div', { className: 'status-title', text: check.label }),
      badge,
      el('p', { className: 'muted', text: `${check.httpStatus ?? check.error ?? 'no response'} · ${check.latencyMs}ms` })
    ];
    if (check.displayUrl) {
      body.push(el('a', { href: check.displayUrl, text: 'Open', rel: 'noreferrer noopener' }));
    }
    statusList.append(el('article', { className: 'status-card' }, body));
  }
}

async function refreshStatus() {
  refreshButton.disabled = true;
  try {
    renderStatus(await getJson('/api/status'));
  } catch (error) {
    statusList.replaceChildren(el('p', { className: 'error', text: `Status unavailable: ${error.message}` }));
  } finally {
    refreshButton.disabled = false;
  }
}

const TAB_IDS = ['overview', 'work', 'knowledge', 'reports', 'diary', 'goals'];
const DEFAULT_TAB_ID = 'overview';
const tabs = new Map(TAB_IDS.map((id) => [id, document.querySelector(`#tab-${id}`)]));
const tabPanels = new Map(TAB_IDS.map((id) => [id, document.querySelector(`#panel-${id}`)]));
const loadedTabs = new Set();

function tabIdFromHash(hash = window.location.hash) {
  const id = String(hash || '').replace(/^#/, '').toLowerCase();
  return TAB_IDS.includes(id) ? id : null;
}

async function loadOverviewData() {
  try {
    renderConfig(await getJson('/api/config/public'));
  } catch (error) {
    sections.replaceChildren(el('p', { className: 'error', text: `Config unavailable: ${error.message}` }));
  }
  await refreshStatus();
}

async function loadTabData(tabId) {
  if (loadedTabs.has(tabId)) return;
  loadedTabs.add(tabId);
  if (tabId === 'overview') {
    await loadOverviewData();
  } else if (tabId === 'work') {
    await refreshKanban();
  } else if (tabId === 'knowledge') {
    await refreshEpics();
    await refreshWritingPosts();
    await refreshDatasets();
    await refreshDocs();
  } else if (tabId === 'reports') {
    await refreshFinnick();
    await refreshInvestmentScreener();
  } else if (tabId === 'diary') {
    await refreshDiaryEntries();
  } else if (tabId === 'goals') {
    await refreshGoals();
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

function focusAdjacentTab(currentId, direction) {
  const index = TAB_IDS.indexOf(currentId);
  const nextIndex = (index + direction + TAB_IDS.length) % TAB_IDS.length;
  const nextId = TAB_IDS[nextIndex];
  tabs.get(nextId)?.focus();
  selectTab(nextId);
}

function bindTabNavigation() {
  for (const [id, tab] of tabs) {
    tab?.addEventListener('click', (event) => {
      event.preventDefault();
      selectTab(id);
    });
    tab?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        focusAdjacentTab(id, 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        focusAdjacentTab(id, -1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        tabs.get(DEFAULT_TAB_ID)?.focus();
        selectTab(DEFAULT_TAB_ID);
      } else if (event.key === 'End') {
        event.preventDefault();
        const lastTabId = TAB_IDS.at(-1);
        tabs.get(lastTabId)?.focus();
        selectTab(lastTabId);
      }
    });
  }
  window.addEventListener('hashchange', async () => {
    const tabId = tabIdFromHash();
    if (tabId) await selectTab(tabId, { updateHash: false });
  });
}

function setDiaryMessage(message, kind = 'muted') {
  if (!diaryFormMessage) return;
  diaryFormMessage.className = kind;
  diaryFormMessage.textContent = message;
}

function diaryErrorMessage(error) {
  const message = String(error?.message ?? 'Diary unavailable');
  if (message.includes('503')) return 'Diary storage is not configured or unavailable on this instance.';
  if (/validation|invalid/i.test(message)) return 'Check the diary entry fields and try again.';
  return message.replace(/\/[^\s]+/g, '[redacted]');
}

function todayInputDate() {
  return new Date().toISOString().slice(0, 10);
}

function setDiaryDefaultDate() {
  if (diaryEntryDate && !diaryEntryDate.value) diaryEntryDate.value = todayInputDate();
}

function renderDiaryEntrySummary(entry) {
  const title = entry.title || '(untitled)';
  const button = el('button', { className: 'entry-view-button', type: 'button', text: 'View' });
  button.addEventListener('click', () => loadDiaryEntry(entry));
  const meta = [entry.entry_date, entry.mood, entry.created_at ? `created ${formatDateTime(entry.created_at)}` : null].filter(Boolean).join(' · ');
  return el('article', { className: 'personal-entry-card' }, [
    el('div', { className: 'personal-entry-heading' }, [
      el('strong', { text: title }),
      button
    ]),
    el('div', { className: 'muted personal-entry-meta', text: meta }),
    el('p', { text: entry.preview || 'No preview available.' })
  ]);
}

function renderDiaryEntryDetail(entry) {
  if (!diaryEntryDetail) return;
  const title = entry.title || '(untitled)';
  const meta = [entry.entry_date, entry.mood, entry.created_at ? `created ${formatDateTime(entry.created_at)}` : null].filter(Boolean).join(' · ');
  const linkedGoals = Array.isArray(entry.goals) && entry.goals.length > 0
    ? el('ul', { className: 'linked-goal-list' }, entry.goals.map((goal) => el('li', { text: `${goal.title || goal.id} (${goal.status || 'unknown'})` })))
    : el('p', { className: 'muted', text: 'No linked goals yet.' });
  diaryEntryDetail.replaceChildren(el('div', { className: 'personal-entry-detail-card' }, [
    el('h3', { text: title }),
    el('p', { className: 'muted', text: meta }),
    el('p', { className: 'diary-entry-body', text: entry.body || '' }),
    el('h4', { text: 'Linked goals' }),
    linkedGoals
  ]));
}

async function loadDiaryEntry(entry) {
  if (!entry?.id || !diaryEntryDetail) return;
  diaryEntryDetail.replaceChildren(el('p', { className: 'muted', text: 'Loading diary entry…' }));
  try {
    const data = await getJson(`/api/diary/entries/${encodeURIComponent(entry.id)}`);
    renderDiaryEntryDetail(data.entry);
  } catch (error) {
    diaryEntryDetail.replaceChildren(el('p', { className: 'error', text: `Diary entry unavailable: ${diaryErrorMessage(error)}` }));
  }
}

async function refreshDiaryEntries() {
  if (!diaryEntryList) return;
  setDiaryDefaultDate();
  if (refreshDiaryButton) refreshDiaryButton.disabled = true;
  try {
    const data = await getJson('/api/diary/entries?limit=20&offset=0');
    const entries = Array.isArray(data.entries) ? data.entries : [];
    diaryEntryList.replaceChildren();
    if (entries.length === 0) {
      diaryEntryList.append(el('p', { className: 'muted', text: 'No diary entries yet.' }));
    } else {
      diaryEntryList.append(...entries.map(renderDiaryEntrySummary));
    }
  } catch (error) {
    diaryEntryList.replaceChildren(el('p', { className: 'error', text: `Diary unavailable: ${diaryErrorMessage(error)}` }));
  } finally {
    if (refreshDiaryButton) refreshDiaryButton.disabled = false;
  }
}

async function submitDiaryEntry(event) {
  event.preventDefault();
  if (!diaryEntryBody) return;
  const payload = {
    entry_date: diaryEntryDate?.value || undefined,
    title: diaryEntryTitle?.value || '',
    body: diaryEntryBody.value,
    mood: diaryEntryMood?.value || ''
  };
  setDiaryMessage('Saving diary entry…');
  try {
    const data = await postJson('/api/diary/entries', payload);
    if (diaryEntryTitle) diaryEntryTitle.value = '';
    if (diaryEntryBody) diaryEntryBody.value = '';
    if (diaryEntryMood) diaryEntryMood.value = '';
    setDiaryDefaultDate();
    setDiaryMessage('Saved diary entry.');
    await refreshDiaryEntries();
    renderDiaryEntryDetail(data.entry);
  } catch (error) {
    setDiaryMessage(diaryErrorMessage(error), 'error');
  }
}

if (diaryEntryForm) diaryEntryForm.addEventListener('submit', submitDiaryEntry);
if (refreshDiaryButton) refreshDiaryButton.addEventListener('click', refreshDiaryEntries);
setDiaryDefaultDate();


function setGoalMessage(message, kind = 'muted') {
  if (!goalFormMessage) return;
  goalFormMessage.className = kind;
  goalFormMessage.textContent = message;
}

function goalErrorMessage(error) {
  const message = String(error?.message ?? 'Goals unavailable');
  if (message.includes('503')) return 'Goal storage is not configured or unavailable on this instance.';
  if (/validation|invalid/i.test(message)) return 'Check the goal fields and try again.';
  return message.replace(/\/[^\s]+/g, '[redacted]');
}

function goalsRequestPath() {
  const status = goalStatusFilter?.value || 'all';
  return `/api/goals?status=${encodeURIComponent(status)}`;
}

async function loadGoal(goal) {
  if (!goal?.id || !goalDetail) return;
  goalDetail.replaceChildren(el('p', { className: 'muted', text: 'Loading goal…' }));
  try {
    const data = await getJson(`/api/goals/${encodeURIComponent(goal.id)}`);
    renderGoalDetail(data.goal);
  } catch (error) {
    goalDetail.replaceChildren(el('p', { className: 'error', text: `Goal unavailable: ${goalErrorMessage(error)}` }));
  }
}

function renderGoalDetail(goal) {
  if (!goalDetail) return;
  currentGoalId = goal.id;
  if (goalTitle) goalTitle.value = goal.title || '';
  if (goalDescription) goalDescription.value = goal.description || '';
  if (goalStatus) goalStatus.value = goal.status || 'active';
  if (goalTargetDate) goalTargetDate.value = goal.target_date || '';
  const meta = [goal.status, goal.target_date ? `target ${goal.target_date}` : null, goal.updated_at ? `updated ${formatDateTime(goal.updated_at)}` : null].filter(Boolean).join(' · ');
  goalDetail.replaceChildren(el('div', { className: 'personal-entry-detail-card' }, [
    el('h3', { text: goal.title || '(untitled goal)' }),
    el('p', { className: 'muted', text: meta }),
    el('p', { text: goal.description || 'No description yet.' })
  ]));
}

function renderGoalSummary(goal) {
  const view = el('button', { className: 'entry-view-button', type: 'button', text: 'View' });
  view.addEventListener('click', () => loadGoal(goal));
  const statusSelect = el('select', { 'aria-label': `Move goal ${goal.title || goal.id}` }, [
    el('option', { value: 'active', text: 'active' }),
    el('option', { value: 'paused', text: 'paused' }),
    el('option', { value: 'completed', text: 'completed' }),
    el('option', { value: 'archived', text: 'archived' })
  ]);
  statusSelect.value = goal.status || 'active';
  statusSelect.addEventListener('change', async () => {
    try {
      const data = await patchJson(`/api/goals/${encodeURIComponent(goal.id)}`, { status: statusSelect.value });
      renderGoalDetail(data.goal);
      await refreshGoals();
    } catch (error) {
      setGoalMessage(goalErrorMessage(error), 'error');
    }
  });
  const meta = [goal.status, goal.target_date ? `target ${goal.target_date}` : null, goal.updated_at ? `updated ${formatDateTime(goal.updated_at)}` : null].filter(Boolean).join(' · ');
  return el('article', { className: 'personal-entry-card' }, [
    el('div', { className: 'personal-entry-heading' }, [el('strong', { text: goal.title || '(untitled goal)' }), view]),
    el('div', { className: `badge ${goal.status || 'unknown'}`, text: goal.status || 'unknown' }),
    el('p', { className: 'muted personal-entry-meta', text: meta }),
    el('p', { text: goal.description || 'No description yet.' }),
    el('label', { className: 'inline-control' }, [document.createTextNode('Status '), statusSelect])
  ]);
}

async function refreshGoals() {
  if (!goalsList) return;
  if (refreshGoalsButton) refreshGoalsButton.disabled = true;
  try {
    const data = await getJson(goalsRequestPath());
    const goals = Array.isArray(data.goals) ? data.goals : [];
    goalsList.replaceChildren();
    if (goals.length === 0) goalsList.append(el('p', { className: 'muted', text: 'No goals yet.' }));
    else goalsList.append(...goals.map(renderGoalSummary));
  } catch (error) {
    goalsList.replaceChildren(el('p', { className: 'error', text: `Goals unavailable: ${goalErrorMessage(error)}` }));
  } finally {
    if (refreshGoalsButton) refreshGoalsButton.disabled = false;
  }
}

function resetGoalForm() {
  currentGoalId = null;
  goalForm?.reset();
  if (goalStatus) goalStatus.value = 'active';
  goalDetail?.replaceChildren(el('p', { className: 'muted', text: 'Select a goal to view it.' }));
  setGoalMessage('Ready to create a new goal.');
}

async function submitGoal(event) {
  event.preventDefault();
  const payload = {
    title: goalTitle?.value || '',
    description: goalDescription?.value || '',
    status: goalStatus?.value || 'active',
    target_date: goalTargetDate?.value || null
  };
  setGoalMessage('Saving goal…');
  try {
    const data = currentGoalId
      ? await patchJson(`/api/goals/${encodeURIComponent(currentGoalId)}`, payload)
      : await postJson('/api/goals', payload);
    setGoalMessage('Saved goal.');
    await refreshGoals();
    renderGoalDetail(data.goal);
  } catch (error) {
    setGoalMessage(goalErrorMessage(error), 'error');
  }
}

if (goalForm) goalForm.addEventListener('submit', submitGoal);
if (refreshGoalsButton) refreshGoalsButton.addEventListener('click', refreshGoals);
if (newGoalButton) newGoalButton.addEventListener('click', resetGoalForm);
if (goalStatusFilter) goalStatusFilter.addEventListener('change', refreshGoals);

async function boot() {
  await selectTab(tabIdFromHash() ?? DEFAULT_TAB_ID, { updateHash: false });
  dashboardBootComplete = true;
}

refreshButton.addEventListener('click', refreshStatus);
bindTabNavigation();
boot();

async function refreshFinnick() {
  if (refreshFinnickButton) refreshFinnickButton.disabled = true;
  try {
    const data = await getJson('/api/finnick/report');
    finnickContent.replaceChildren(el('pre', { className: 'finnick-report', text: data.content }));
  } catch (error) {
    const msg = error.message.includes('404')
      ? 'No report yet — check back after the 08:00 AEST cron runs.'
      : error.message.includes('503')
        ? 'Finnick report is not configured on this instance.'
        : `Report unavailable: ${error.message}`;
    finnickContent.replaceChildren(el('p', { className: 'error', text: msg }));
  } finally {
    if (refreshFinnickButton) refreshFinnickButton.disabled = false;
  }
}

if (refreshFinnickButton) {
  refreshFinnickButton.addEventListener('click', refreshFinnick);
}


function investmentScreenerRequestPath() {
  const searchParams = new URLSearchParams();
  const queryText = investmentSearchFilter?.value?.trim();
  const market = investmentMarketFilter?.value?.trim();
  const metric = investmentMetricFilter?.value?.trim();
  const weight = investmentWeightFilter?.value?.trim();
  const topN = investmentTopNFilter?.value?.trim();
  if (queryText) searchParams.set('q', queryText);
  if (market) searchParams.set('market', market);
  if (metric && metric !== 'composite') searchParams.set('metric', metric);
  if (weight && weight !== 'balanced') searchParams.set('weight', weight);
  if (topN) searchParams.set('limit', topN);
  if (investmentScreenerOffset > 0) searchParams.set('offset', String(investmentScreenerOffset));
  const query = searchParams.toString();
  return query ? `/api/investment-screener/ranked?${query}` : '/api/investment-screener/ranked';
}

function investmentSuggestionLimit(payload) {
  const serverLimit = payload?.pagination?.limit ?? payload?.applied_filters?.limit ?? payload?.applied_filters?.topN;
  const controlLimit = Number(investmentTopNFilter?.value ?? 6);
  const limit = Number.isInteger(serverLimit) ? serverLimit : controlLimit;
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 6;
}

function updateInvestmentPaginationControls(payload) {
  const pagination = payload && payload.pagination;
  if (!pagination) {
    if (investmentPageSummary) investmentPageSummary.textContent = 'Showing latest generated candidates.';
    if (investmentPrevPageButton) investmentPrevPageButton.disabled = true;
    if (investmentNextPageButton) investmentNextPageButton.disabled = true;
    return;
  }
  const total = Number(pagination.total ?? payload.total_candidates ?? 0);
  const offset = Number(pagination.offset ?? 0);
  const count = Number(payload.displayed_count ?? 0);
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + count, total);
  if (investmentPageSummary) investmentPageSummary.textContent = `Showing ${first}-${last} of ${total} candidates.`;
  if (investmentPrevPageButton) {
    investmentPrevPageButton.disabled = pagination.previous_offset === null || pagination.previous_offset === undefined;
    investmentPrevPageButton.dataset.offset = String(pagination.previous_offset ?? 0);
  }
  if (investmentNextPageButton) {
    investmentNextPageButton.disabled = pagination.next_offset === null || pagination.next_offset === undefined;
    investmentNextPageButton.dataset.offset = String(pagination.next_offset ?? 0);
  }
}

function renderInvestmentSourceCoveragePanel(payload) {
  const sourceSummary = payload?.source_summary;
  const coverage = payload?.coverage;
  if (!sourceSummary && !coverage) return null;
  const modeLabel = sourceSummary?.mode_label ?? (payload?.mode === 'fixture' ? 'Fixture/sample data' : payload?.mode ?? 'Unknown source mode');
  const sourceLine = [
    modeLabel,
    Array.isArray(sourceSummary?.providers) && sourceSummary.providers.length ? sourceSummary.providers.join(', ') : null,
    sourceSummary?.universe_source ? `Universe: ${sourceSummary.universe_source}` : null
  ].filter(Boolean).join(' · ');
  const coverageText = coverage?.coverage_label
    ?? (coverage?.denominator == null
      ? `Denominator unavailable; showing ${coverage?.usable ?? 0} scored candidates.`
      : `${coverage?.usable ?? 0} / ${coverage.denominator} ${coverage.denominator_label ?? 'universe'} scored${coverage.percent == null ? '' : ` (${coverage.percent}%)`}.`);
  const freshness = [
    sourceSummary?.data_as_of ? `Data as of ${formatDateTime(sourceSummary.data_as_of)}` : null,
    sourceSummary?.latest_retrieved_at ? `retrieved ${formatDateTime(sourceSummary.latest_retrieved_at)}` : null,
    sourceSummary?.latest_hydrated_at ? `hydrated ${formatDateTime(sourceSummary.latest_hydrated_at)}` : null,
    payload?.generated_at ? `generated ${formatDateTime(payload.generated_at)}` : null
  ].filter(Boolean).join(' · ') || 'Freshness: unknown';
  const caveats = [
    ...(Array.isArray(sourceSummary?.caveats) ? sourceSummary.caveats : []),
    ...(Array.isArray(coverage?.caveats) ? coverage.caveats : [])
  ].filter(Boolean).slice(0, 6);
  if (payload?.status === 'degraded' || payload?.source === 'ranked_artifact') {
    caveats.unshift('Coverage degraded — Postgres history is unavailable; coverage is inferred from the sanitized ranked artifact.');
  }
  if (payload?.mode === 'fixture' || sourceSummary?.mode === 'fixture') {
    caveats.unshift('Fixture/sample data — not full ASX market coverage.');
  }
  const rows = [
    el('div', { className: 'investment-source-row', text: `Source: ${sourceLine || 'Unknown source mode'}` }),
    el('div', { className: 'investment-source-row', text: `Coverage: ${coverageText}` }),
    el('div', { className: 'investment-source-row', text: `Freshness: ${freshness}` })
  ];
  if (caveats.length) {
    rows.push(el('ul', { className: 'investment-source-caveats' }, caveats.map((item) => el('li', { text: item }))));
  }
  if (Array.isArray(coverage?.alternate_denominators) && coverage.alternate_denominators.length) {
    rows.push(el('div', { className: 'investment-source-row muted', text: `Alternate coverage: ${coverage.alternate_denominators.map((item) => `${item.usable ?? 0} / ${item.denominator ?? '?'} ${item.denominator_label ?? 'alternate denominator'}${item.percent == null ? '' : ` (${item.percent}%)`}`).join(' · ')}` }));
  }
  rows.push(el('details', { className: 'investment-source-details' }, [
    el('summary', { text: 'Source and coverage details' }),
    el('p', { className: 'muted', text: `Denominator source: ${coverage?.denominator_label ?? 'unknown'} (${coverage?.denominator_status ?? 'unknown'}).` }),
    el('p', { className: 'muted', text: `Counts: scraped ${coverage?.scraped ?? 'unknown'}, scored ${coverage?.scored ?? 'unknown'}, usable ${coverage?.usable ?? 'unknown'}, excluded ${coverage?.excluded ?? 'unknown'}, missing required fields ${coverage?.missing_required_fields ?? 'unknown'}.` }),
    el('p', { className: 'muted', text: `Provenance rows: ${sourceSummary?.provenance_rows ?? 'unknown'}, fields: ${sourceSummary?.provenance_fields ?? 'unknown'}.` })
  ]));
  return el('section', { className: 'investment-source-panel', 'aria-label': 'Investment screener data provenance and market coverage' }, [
    el('h3', { text: 'Data source' }),
    ...rows
  ]);
}

function renderInvestmentScreener(payload) {
  if (!investmentScreenerContent) return;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const suggestionLimit = investmentSuggestionLimit(payload);
  updateInvestmentPaginationControls(payload);
  const metaItems = [
    payload.mode ? `Mode: ${payload.mode}` : null,
    payload.generated_at ? `Generated: ${formatDateTime(payload.generated_at)}` : null,
    payload.data_as_of ? `Data as of: ${formatDateTime(payload.data_as_of)}` : null
  ].filter(Boolean);

  const children = [
    el('p', { className: 'investment-disclaimer', text: payload.disclaimer ?? 'Informational screener output only; not financial advice.' })
  ];
  if (metaItems.length) {
    children.push(el('div', { className: 'investment-meta muted', text: metaItems.join(' · ') }));
  }

  const sourceCoveragePanel = renderInvestmentSourceCoveragePanel(payload);
  if (sourceCoveragePanel) children.push(sourceCoveragePanel);

  if (payload.mode === 'fixture') {
    children.push(el('p', { className: 'investment-fixture-warning', text: 'Fixture/sample data only — not a real ASX scrape/backfill. This is not full ASX market coverage.' }));
  }

  const appliedFilterSummary = investmentAppliedFilterSummary(payload.applied_filters);
  if (appliedFilterSummary) {
    children.push(el('p', { className: 'investment-applied-filters muted', text: appliedFilterSummary }));
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (messages.length) {
    children.push(el('ul', { className: 'investment-filter-messages muted' }, messages.slice(0, 3).map((message) => el('li', { text: message }))));
  }

  if (candidates.length === 0) {
    const message = messages.length ? 'No candidates match the selected filters.' : 'No ranked candidates are present in the latest screener output.';
    children.push(el('p', { className: 'muted', text: message }));
  } else {
    children.push(el('div', { className: 'investment-candidate-grid' }, candidates.slice(0, suggestionLimit).map(renderInvestmentCandidate)));
  }

  const limitations = Array.isArray(payload.limitations) ? payload.limitations : [];
  if (limitations.length) {
    children.push(el('ul', { className: 'investment-limitations muted' }, limitations.slice(0, 4).map((item) => el('li', { text: item }))));
  }

  if (Array.isArray(payload.doc_links) && payload.doc_links.length > 0) {
    children.push(el('div', { className: 'doc-links investment-doc-links' }, [
      el('span', { className: 'muted', text: 'Details: ' }),
      ...payload.doc_links.map((doc) => el('a', { href: doc.url, text: doc.label ?? 'Document', rel: 'noreferrer noopener', target: '_blank' }))
    ]));
  }

  investmentScreenerContent.replaceChildren(el('div', { className: 'investment-screener-card' }, children));
}

function investmentAppliedFilterSummary(appliedFilters) {
  if (!appliedFilters || typeof appliedFilters !== 'object') return null;
  const parts = [];
  if (appliedFilters.q) parts.push(`Search: ${appliedFilters.q}`);
  if (appliedFilters.market) parts.push(`Market: ${appliedFilters.market}`);
  if (appliedFilters.metric) parts.push(`Score focus: ${appliedFilters.metric}`);
  if (appliedFilters.weight) parts.push(`Sort preset: ${appliedFilters.weight}`);
  if (appliedFilters.limit || appliedFilters.topN) parts.push(`Page size: ${appliedFilters.limit ?? appliedFilters.topN}`);
  if (appliedFilters.offset) parts.push(`Offset: ${appliedFilters.offset}`);
  return parts.length ? `Applied filters: ${parts.join(' · ')}` : null;
}

function renderInvestmentCandidate(candidate) {
  const meta = [candidate.market, candidate.currency].filter(Boolean).join(' · ');
  const riskFlags = Array.isArray(candidate.risk_flags) ? candidate.risk_flags.slice(0, 3) : [];
  const caveats = Array.isArray(candidate.caveats) ? candidate.caveats.slice(0, 2) : [];
  const children = [
    el('div', { className: 'investment-candidate-heading' }, [
      el('span', { className: 'badge neutral', text: `#${candidate.rank ?? '?'}` }),
      el('strong', { text: candidate.ticker ?? 'UNKNOWN' }),
      candidate.score == null ? el('span', { className: 'muted', text: 'No score' }) : el('span', { className: 'badge up', text: String(candidate.score) })
    ]),
    el('div', { className: 'investment-candidate-name', text: candidate.name ?? 'Unknown candidate' })
  ];
  if (meta) children.push(el('div', { className: 'muted investment-candidate-meta', text: meta }));
  if (riskFlags.length) {
    children.push(el('div', { className: 'investment-risk-flags' }, riskFlags.map((flag) => el('span', { className: 'badge down', text: flag }))));
  }
  if (caveats.length) {
    children.push(el('ul', { className: 'investment-caveats muted' }, caveats.map((caveat) => el('li', { text: caveat }))));
  }
  if (candidate.sanitized_provenance_summary) {
    children.push(el('p', { className: 'investment-provenance muted', text: `Provenance: ${candidate.sanitized_provenance_summary}` }));
  }
  return el('article', { className: 'investment-candidate' }, children);
}

function formatDateTime(isoString) {
  if (!isoString) return 'unknown';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return String(isoString);
  return date.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function refreshInvestmentScreener() {
  if (!investmentScreenerContent) return;
  if (refreshInvestmentScreenerButton) refreshInvestmentScreenerButton.disabled = true;
  try {
    renderInvestmentScreener(await getJson(investmentScreenerRequestPath()));
  } catch (error) {
    const msg = error.message.includes('404')
      ? 'No investment screener output yet — run the screener export first.'
      : error.message.includes('503')
        ? 'Investment screener output is not configured on this instance.'
        : `Investment screener unavailable: ${error.message}`;
    updateInvestmentPaginationControls(null);
    investmentScreenerContent.replaceChildren(el('p', { className: 'error', text: msg }));
  } finally {
    if (refreshInvestmentScreenerButton) refreshInvestmentScreenerButton.disabled = false;
  }
}

if (refreshInvestmentScreenerButton) {
  refreshInvestmentScreenerButton.addEventListener('click', refreshInvestmentScreener);
}

if (investmentScreenerControls) {
  investmentScreenerControls.addEventListener('change', () => {
    investmentScreenerOffset = 0;
    refreshInvestmentScreener();
  });
  investmentScreenerControls.addEventListener('input', (event) => {
    if (event.target === investmentSearchFilter) {
      investmentScreenerOffset = 0;
      refreshInvestmentScreener();
    }
  });
}

if (resetInvestmentScreenerFiltersButton) {
  resetInvestmentScreenerFiltersButton.addEventListener('click', () => {
    if (investmentSearchFilter) investmentSearchFilter.value = '';
    if (investmentMarketFilter) investmentMarketFilter.value = '';
    if (investmentMetricFilter) investmentMetricFilter.value = 'composite';
    if (investmentWeightFilter) investmentWeightFilter.value = 'balanced';
    if (investmentTopNFilter) investmentTopNFilter.value = '6';
    investmentScreenerOffset = 0;
    refreshInvestmentScreener();
  });
}

if (investmentPrevPageButton) {
  investmentPrevPageButton.addEventListener('click', () => {
    investmentScreenerOffset = Number(investmentPrevPageButton.dataset.offset ?? 0);
    refreshInvestmentScreener();
  });
}

if (investmentNextPageButton) {
  investmentNextPageButton.addEventListener('click', () => {
    investmentScreenerOffset = Number(investmentNextPageButton.dataset.offset ?? 0);
    refreshInvestmentScreener();
  });
}


function writingRequestPath() {
  const status = writingStatusFilter?.value || 'all';
  return `/api/writing/posts?status=${encodeURIComponent(status)}`;
}

function writingStatusBadgeClass(status) {
  if (status === 'published') return 'badge up';
  if (status === 'draft') return 'badge neutral';
  if (status === 'archived') return 'badge down';
  return 'badge neutral';
}

function writingMeta(post) {
  return [
    post.updated_at ? `updated ${formatDateTime(post.updated_at)}` : null,
    Array.isArray(post.tags) && post.tags.length ? `tags: ${post.tags.join(', ')}` : null,
    Number.isInteger(post.attachment_count) && post.attachment_count > 0 ? `${post.attachment_count} attachment${post.attachment_count === 1 ? '' : 's'}` : null
  ].filter(Boolean).join(' · ');
}

function renderWritingPostCard(post) {
  const button = el('button', { className: 'entry-view-button', type: 'button', text: 'Preview' });
  button.addEventListener('click', () => loadWritingPost(post.post_id));
  return el('article', { className: 'writing-post-card' }, [
    el('div', { className: 'personal-entry-heading' }, [
      el('strong', { text: post.title || '(untitled post)' }),
      button
    ]),
    el('div', { className: writingStatusBadgeClass(post.status), text: post.status || 'unknown' }),
    el('p', { className: 'muted personal-entry-meta', text: writingMeta(post) }),
    el('p', { text: post.preview || 'No preview available.' })
  ]);
}

function renderWritingPostPreview(post) {
  if (!writingPostPreview) return;
  const tags = Array.isArray(post.tags) && post.tags.length
    ? el('div', { className: 'writing-tags' }, post.tags.map((tag) => el('span', { className: 'badge neutral', text: tag })))
    : el('p', { className: 'muted', text: 'No tags.' });
  const attachments = Array.isArray(post.attachments) && post.attachments.length
    ? el('ul', { className: 'writing-attachments' }, post.attachments.map((attachment) => el('li', {}, [
      el('a', { href: attachment.url, text: attachment.display_name, rel: 'noopener noreferrer', target: '_blank' }),
      el('span', { className: 'muted', text: ` ${attachment.content_type} · ${attachment.size} bytes` })
    ])))
    : el('p', { className: 'muted', text: 'No attachments exposed for this post.' });
  writingPostPreview.replaceChildren(el('div', { className: 'writing-post-detail' }, [
    el('div', { className: 'personal-entry-heading' }, [
      el('h3', { text: post.title || '(untitled post)' }),
      el('span', { className: writingStatusBadgeClass(post.status), text: post.status || 'unknown' })
    ]),
    el('p', { className: 'muted', text: [post.updated_at ? `Updated ${formatDateTime(post.updated_at)}` : null, post.published_at ? `published ${formatDateTime(post.published_at)}` : null, post.storage].filter(Boolean).join(' · ') }),
    tags,
    renderMarkdownDocument(post.body_markdown || ''),
    el('h4', { text: 'Attachments' }),
    attachments,
    el('p', { className: 'muted writing-storage-note', text: 'Read-only MVP: create/edit/publish/delete are deferred until storage and backup behavior are reviewed.' })
  ]));
}

async function loadWritingPost(postId) {
  if (!postId || !writingPostPreview) return;
  writingPostPreview.replaceChildren(el('p', { className: 'muted', text: 'Loading writing preview…' }));
  try {
    const data = await getJson(`/api/writing/posts/${encodeURIComponent(postId)}`);
    renderWritingPostPreview(data.post);
  } catch (error) {
    writingPostPreview.replaceChildren(el('p', { className: 'error', text: `Writing preview unavailable: ${error.message.replace(/\/[^\s]+/g, '[redacted]')}` }));
  }
}

async function refreshWritingPosts() {
  if (!writingPostsList) return;
  if (refreshWritingPostsButton) refreshWritingPostsButton.disabled = true;
  try {
    const data = await getJson(writingRequestPath());
    const posts = Array.isArray(data.posts) ? data.posts : [];
    writingPostsList.replaceChildren();
    if (posts.length === 0) {
      writingPostsList.append(el('p', { className: 'muted', text: 'No writing posts match this filter.' }));
    } else {
      writingPostsList.append(...posts.map(renderWritingPostCard));
    }
    if (writingPostPreview && posts.length && !writingPostPreview.dataset.loaded) {
      writingPostPreview.dataset.loaded = 'true';
      await loadWritingPost(posts[0].post_id);
    }
  } catch (error) {
    writingPostsList.replaceChildren(el('p', { className: 'error', text: `Writing posts unavailable: ${error.message}` }));
  } finally {
    if (refreshWritingPostsButton) refreshWritingPostsButton.disabled = false;
  }
}

if (refreshWritingPostsButton) refreshWritingPostsButton.addEventListener('click', refreshWritingPosts);
if (writingStatusFilter) writingStatusFilter.addEventListener('change', () => {
  if (writingPostPreview) delete writingPostPreview.dataset.loaded;
  refreshWritingPosts();
});


function renderDatasetCard(dataset) {
  const button = el('button', { className: 'entry-view-button', type: 'button', text: 'Preview' });
  button.addEventListener('click', () => loadDatasetRecords(dataset.dataset_id));
  const meta = [
    dataset.schema_version,
    dataset.mode,
    Number.isInteger(dataset.record_count) ? `${dataset.record_count} record${dataset.record_count === 1 ? '' : 's'}` : 'records unavailable',
    dataset.invalid_line_count ? `${dataset.invalid_line_count} invalid line${dataset.invalid_line_count === 1 ? '' : 's'}` : null
  ].filter(Boolean).join(' · ');
  return el('article', { className: 'dataset-card' }, [
    el('div', { className: 'personal-entry-heading' }, [
      el('strong', { text: dataset.display_name || dataset.dataset_id }),
      button
    ]),
    el('p', { className: 'muted personal-entry-meta', text: meta }),
    el('p', { text: dataset.description || 'Curated examples.' })
  ]);
}

function renderDatasetRecord(record) {
  return el('article', { className: 'dataset-record-card' }, [
    el('div', { className: 'muted personal-entry-meta', text: `Line ${record.line_number} · source: ${record.source}` }),
    el('h4', { text: record.instruction }),
    el('p', { text: record.output })
  ]);
}

function datasetErrorMessage(error) {
  const message = String(error?.message ?? 'Dataset unavailable');
  if (message.includes('422')) return 'Dataset contains invalid JSONL and is not being served until it is repaired.';
  if (message.includes('404')) return 'Dataset is not registered in the server-side allowlist.';
  if (message.includes('405')) return 'Dataset append/create are deferred until storage, locking, backups, and restore behavior are reviewed.';
  return message.replace(/\/[^\s]+/g, '[redacted]');
}

async function loadDatasetRecords(datasetId) {
  if (!datasetId || !datasetRecordsPreview) return;
  datasetRecordsPreview.replaceChildren(el('p', { className: 'muted', text: 'Loading dataset records…' }));
  try {
    const data = await getJson(`/api/datasets/${encodeURIComponent(datasetId)}/records?limit=20&offset=0`);
    const records = Array.isArray(data.records) ? data.records : [];
    const dataset = data.dataset || {};
    const children = [
      el('div', { className: 'personal-entry-heading' }, [
        el('h3', { text: dataset.display_name || dataset.dataset_id || 'Dataset' }),
        el('span', { className: 'badge neutral', text: data.mode || 'read-only' })
      ]),
      el('p', { className: 'muted', text: 'Schema: source, instruction, output. Append/create are deferred pending reviewed storage and backup behavior.' })
    ];
    if (records.length === 0) {
      children.push(el('p', { className: 'muted', text: 'No records available in this dataset.' }));
    } else {
      children.push(el('div', { className: 'dataset-record-list' }, records.map(renderDatasetRecord)));
    }
    datasetRecordsPreview.replaceChildren(el('div', { className: 'dataset-detail' }, children));
  } catch (error) {
    datasetRecordsPreview.replaceChildren(el('p', { className: 'error', text: `Dataset preview unavailable: ${datasetErrorMessage(error)}` }));
  }
}

async function refreshDatasets() {
  if (!datasetsList) return;
  if (refreshDatasetsButton) refreshDatasetsButton.disabled = true;
  try {
    const data = await getJson('/api/datasets');
    const datasets = Array.isArray(data.datasets) ? data.datasets : [];
    datasetsList.replaceChildren();
    if (datasets.length === 0) {
      datasetsList.append(el('p', { className: 'muted', text: 'No allowlisted datasets are configured.' }));
    } else {
      datasetsList.append(...datasets.map(renderDatasetCard));
    }
    if (datasetRecordsPreview && datasets.length && !datasetRecordsPreview.dataset.loaded) {
      datasetRecordsPreview.dataset.loaded = 'true';
      await loadDatasetRecords(datasets[0].dataset_id);
    }
  } catch (error) {
    datasetsList.replaceChildren(el('p', { className: 'error', text: `Datasets unavailable: ${datasetErrorMessage(error)}` }));
  } finally {
    if (refreshDatasetsButton) refreshDatasetsButton.disabled = false;
  }
}

if (refreshDatasetsButton) refreshDatasetsButton.addEventListener('click', () => {
  if (datasetRecordsPreview) delete datasetRecordsPreview.dataset.loaded;
  refreshDatasets();
});


let selectedDocId = null;
let selectedDocPath = null;
let docsByPath = new Map();
let docsById = new Map();
let currentDocs = [];
let lastDocReaderFocus = null;

function groupDocsByCategory(documents) {
  const groups = new Map();
  for (const doc of documents) {
    const category = typeof doc.category === 'string' && doc.category.trim() ? doc.category.trim() : 'General';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(doc);
  }
  return [...groups.entries()].map(([category, docs]) => ({ category, docs }));
}

function docSearchText(doc) {
  return [doc?.title, doc?.category, doc?.path, doc?.id]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function filterDocs(documents, query = docsSearch?.value ?? '') {
  const terms = String(query ?? '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return documents;
  return documents.filter((doc) => {
    const haystack = docSearchText(doc);
    return terms.every((term) => haystack.includes(term));
  });
}

function docsEmptyMessage(totalCount, query = docsSearch?.value ?? '') {
  if (totalCount === 0) return 'No approved dashboard docs are available.';
  const text = String(query ?? '').trim();
  return text ? `No docs match “${text}”.` : 'No approved dashboard docs are available.';
}

function renderDocList(documents, { totalCount = documents.length, query = docsSearch?.value ?? '' } = {}) {
  if (!docsList) return;
  docsList.replaceChildren();
  if (documents.length === 0) {
    docsList.append(el('p', { className: 'muted', text: docsEmptyMessage(totalCount, query) }));
    return;
  }
  for (const group of groupDocsByCategory(documents)) {
    const groupItems = group.docs.map((doc) => {
      const selected = doc.id === selectedDocId;
      const button = el('button', {
        className: selected ? 'doc-picker is-selected' : 'doc-picker',
        type: 'button',
        text: doc.title ?? doc.id,
        'aria-current': selected ? 'true' : 'false'
      });
      button.classList.toggle('is-selected', selected);
      button.addEventListener('click', () => loadDoc(doc, { sourceElement: button }));
      return el('li', { className: 'doc-picker-item' }, [button, el('span', { className: 'muted doc-path', text: doc.path })]);
    });
    docsList.append(el('li', { className: 'doc-group' }, [
      el('div', { className: 'doc-group-title', text: group.category }),
      el('ul', { className: 'doc-group-list' }, groupItems)
    ]));
  }
}

function headingAnchorId(text, used = new Set()) {
  const base = String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-') || 'section';
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function markdownHeadings(markdown) {
  const used = new Set();
  return String(markdown ?? '')
    .split(/\r?\n/)
    .map((line) => /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ level: match[1].length, text: match[2].trim(), id: headingAnchorId(match[2].trim(), used) }));
}

function normalizeDocPath(path) {
  const parts = [];
  for (const part of String(path ?? '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function relativeDocPath(basePath, href) {
  const cleanHref = String(href ?? '').split('#')[0].split('?')[0];
  if (!cleanHref || cleanHref.startsWith('/') || cleanHref.includes('\0')) return null;
  const baseParts = String(basePath ?? '').split('/');
  baseParts.pop();
  return normalizeDocPath([...baseParts, cleanHref].join('/'));
}

function approvedDocHrefForRelativeLink(href) {
  const path = relativeDocPath(selectedDocPath, href);
  const doc = path ? docsByPath.get(path) : null;
  return doc?.id ? `/api/docs/${encodeURIComponent(doc.id)}` : null;
}

function safeMarkdownHref(rawHref) {
  const href = String(rawHref ?? '').trim();
  if (!href) return null;
  if (href.startsWith('#')) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    try {
      const parsed = new URL(href);
      if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return parsed.href;
    } catch {
      return null;
    }
  }
  return approvedDocHrefForRelativeLink(href);
}

function appendInlineMarkdown(parent, text) {
  for (const node of renderMarkdownInline(text)) parent.append(node);
}

function renderMarkdownInline(text) {
  const nodes = [];
  const pattern = /(`([^`]+)`)|\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;
  let cursor = 0;
  for (const match of String(text ?? '').matchAll(pattern)) {
    if (match.index > cursor) nodes.push(document.createTextNode(String(text).slice(cursor, match.index)));
    if (match[2] !== undefined) {
      nodes.push(el('code', { text: match[2] }));
    } else {
      const href = safeMarkdownHref(match[4]);
      nodes.push(href
        ? el('a', { href, text: match[3], rel: 'noopener noreferrer', target: '_blank' })
        : document.createTextNode(match[3]));
    }
    cursor = match.index + match[0].length;
  }
  const rawText = String(text ?? '');
  if (cursor < rawText.length) nodes.push(document.createTextNode(rawText.slice(cursor)));
  return nodes;
}

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function renderMarkdownTable(lines) {
  const table = el('table');
  const [headerLine, _divider, ...bodyLines] = lines;
  const thead = el('thead');
  thead.append(el('tr', {}, splitTableRow(headerLine).map((cell) => {
    const th = el('th');
    appendInlineMarkdown(th, cell);
    return th;
  })));
  table.append(thead);
  const tbody = el('tbody');
  for (const line of bodyLines) {
    tbody.append(el('tr', {}, splitTableRow(line).map((cell) => {
      const td = el('td');
      appendInlineMarkdown(td, cell);
      return td;
    })));
  }
  table.append(tbody);
  return el('div', { className: 'doc-table-wrap' }, [table]);
}

function renderMarkdownToc(headings) {
  if (headings.length === 0) return null;
  return el('nav', { className: 'doc-toc', 'aria-label': 'Document table of contents' }, [
    el('div', { className: 'doc-toc-title', text: 'On this page' }),
    el('ol', {}, headings.map((heading) => el('li', { className: `doc-toc-level-${Math.min(heading.level, 6)}` }, [
      el('a', { href: `#${heading.id}`, text: heading.text })
    ])))
  ]);
}


function setBodyModalOpen(open) {
  try {
    document.body?.classList?.toggle('doc-reader-open', open);
  } catch {
    // The reader must still work in minimal DOM/test harnesses.
  }
}

function docReaderFocusableElements() {
  if (!docReaderModal?.querySelectorAll) return [];
  return [...docReaderModal.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')]
    .filter((node) => !node.disabled && node.getAttribute?.('aria-hidden') !== 'true');
}

function openDocReader(sourceElement = null) {
  if (!docReaderModal) return;
  lastDocReaderFocus = sourceElement ?? document.activeElement ?? null;
  docReaderModal.hidden = false;
  docReaderModal.setAttribute('aria-hidden', 'false');
  setBodyModalOpen(true);
  closeDocReaderButton?.focus?.();
}

function closeDocReader({ restoreFocus = true } = {}) {
  if (!docReaderModal || docReaderModal.hidden) return;
  docReaderModal.hidden = true;
  docReaderModal.setAttribute('aria-hidden', 'true');
  setBodyModalOpen(false);
  if (restoreFocus) lastDocReaderFocus?.focus?.();
}

function trapDocReaderFocus(event) {
  if (event.key !== 'Tab' || !docReaderModal || docReaderModal.hidden) return;
  const focusable = docReaderFocusableElements();
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus?.();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus?.();
  }
}

function renderDocShell(target, data, doc) {
  if (!target) return;
  target.replaceChildren(renderMarkdownDocument(data.content ?? ''));
  if (target === docReaderContent) {
    if (docReaderTitle) docReaderTitle.textContent = data.title ?? doc.title ?? doc.id;
    if (docReaderMeta) docReaderMeta.textContent = data.path ?? doc.path ?? '';
  }
}

function renderMarkdownDocument(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const headings = markdownHeadings(markdown);
  const headingIds = new Map();
  for (const heading of headings) {
    const key = `${heading.level}:${heading.text}`;
    if (!headingIds.has(key)) headingIds.set(key, []);
    headingIds.get(key).push(heading.id);
  }
  const body = el('div', { className: 'doc-markdown' });
  let index = 0;
  let inCode = false;
  let codeLines = [];
  const flushParagraph = (paragraphLines) => {
    if (paragraphLines.length === 0) return;
    const p = el('p');
    appendInlineMarkdown(p, paragraphLines.join(' '));
    body.append(p);
  };
  let paragraph = [];

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      if (inCode) {
        body.append(el('pre', {}, [el('code', { text: codeLines.join('\n') })]));
        codeLines = [];
        inCode = false;
      } else {
        flushParagraph(paragraph);
        paragraph = [];
        inCode = true;
      }
      index += 1;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      index += 1;
      continue;
    }
    if (!trimmed) {
      flushParagraph(paragraph);
      paragraph = [];
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      paragraph = [];
      const level = heading[1].length;
      const text = heading[2].trim();
      const idQueue = headingIds.get(`${level}:${text}`);
      const h = el(`h${level}`, { id: idQueue?.shift() ?? headingAnchorId(text) });
      appendInlineMarkdown(h, text);
      body.append(h);
      index += 1;
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      flushParagraph(paragraph);
      paragraph = [];
      body.append(el('hr'));
      index += 1;
      continue;
    }
    if (line.includes('|') && lines[index + 1] && isTableDivider(lines[index + 1])) {
      flushParagraph(paragraph);
      paragraph = [];
      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      body.append(renderMarkdownTable(tableLines));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph(paragraph);
      paragraph = [];
      const quoteLines = [];
      while (index < lines.length) {
        const match = /^>\s?(.*)$/.exec(lines[index]);
        if (!match) break;
        quoteLines.push(match[1]);
        index += 1;
      }
      const blockquote = el('blockquote');
      appendInlineMarkdown(blockquote, quoteLines.join(' '));
      body.append(blockquote);
      continue;
    }
    const listMatch = /^(\s*)([-*+] |\d+\. )(.*)$/.exec(line);
    if (listMatch) {
      flushParagraph(paragraph);
      paragraph = [];
      const ordered = /\d+\. /.test(listMatch[2]);
      const list = el(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const match = /^(\s*)([-*+] |\d+\. )(.*)$/.exec(lines[index]);
        if (!match || (/\d+\. /.test(match[2]) !== ordered)) break;
        const item = el('li');
        appendInlineMarkdown(item, match[3]);
        list.append(item);
        index += 1;
      }
      body.append(list);
      continue;
    }
    paragraph.push(trimmed);
    index += 1;
  }
  if (inCode) body.append(el('pre', {}, [el('code', { text: codeLines.join('\n') })]));
  flushParagraph(paragraph);
  const toc = renderMarkdownToc(headings);
  return el('div', { className: toc ? 'doc-rendered has-toc' : 'doc-rendered' }, toc ? [toc, body] : [body]);
}

async function loadDoc(doc, { sourceElement = null } = {}) {
  if (!doc?.id) return;
  selectedDocId = doc.id;
  selectedDocPath = doc.path ?? null;
  const label = doc.title ?? doc.id;
  docsContent?.replaceChildren(el('p', { className: 'muted', text: `Opening ${label} in the reader…` }));
  if (docReaderContent) docReaderContent.replaceChildren(el('p', { className: 'muted', text: `Loading ${label}…` }));
  if (docReaderTitle) docReaderTitle.textContent = label;
  if (docReaderMeta) docReaderMeta.textContent = doc.path ?? '';
  openDocReader(sourceElement);
  try {
    const data = await getJson(`/api/docs/${encodeURIComponent(doc.id)}`);
    renderDocShell(docReaderContent, data, doc);
    docsContent?.replaceChildren(el('article', { className: 'doc-viewer-card doc-viewer-summary' }, [
      el('div', { className: 'doc-viewer-title', text: data.title ?? label }),
      el('p', { className: 'muted', text: 'This document is open in the reader overlay.' }),
      el('button', { className: 'doc-reopen-button', type: 'button', text: 'Reopen reader' })
    ]));
    docsContent?.querySelector?.('.doc-reopen-button')?.addEventListener('click', () => openDocReader(sourceElement));
    const buttons = docsList?.querySelectorAll('.doc-picker') ?? [];
    for (const button of buttons) {
      const selected = button.textContent === label;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-current', selected ? 'true' : 'false');
    }
  } catch (error) {
    if (docReaderContent) docReaderContent.replaceChildren(el('p', { className: 'error', text: `Document unavailable: ${error.message}` }));
    docsContent?.replaceChildren(el('p', { className: 'error', text: `Document unavailable: ${error.message}` }));
  }
}

function applyDocsFilter() {
  const filtered = filterDocs(currentDocs);
  renderDocList(filtered, { totalCount: currentDocs.length });
}

async function refreshDocs() {
  if (!docsList) return;
  if (refreshDocsButton) refreshDocsButton.disabled = true;
  try {
    const data = await getJson('/api/docs');
    const documents = Array.isArray(data.documents) ? data.documents : [];
    currentDocs = documents;
    docsByPath = new Map(documents.map((doc) => [normalizeDocPath(doc.path), doc]).filter(([path]) => path));
    docsById = new Map(documents.map((doc) => [doc.id, doc]).filter(([id]) => id));
    applyDocsFilter();
    if (docsContent && !selectedDocId) {
      docsContent.replaceChildren(el('p', { className: 'muted', text: documents.length === 0 ? 'No document selected.' : 'Select a document to open the reader.' }));
    }
  } catch (error) {
    currentDocs = [];
    docsById = new Map();
    docsList.replaceChildren(el('p', { className: 'error', text: `Docs unavailable: ${error.message}` }));
  } finally {
    if (refreshDocsButton) refreshDocsButton.disabled = false;
  }
}

if (docsSearch) {
  docsSearch.addEventListener('input', applyDocsFilter);
}

if (refreshDocsButton) {
  refreshDocsButton.addEventListener('click', refreshDocs);
}

if (closeDocReaderButton) {
  closeDocReaderButton.addEventListener('click', () => closeDocReader());
}

if (docReaderModal) {
  docReaderModal.addEventListener('click', (event) => {
    if (event.target === docReaderModal || event.target?.classList?.contains('doc-reader-backdrop')) {
      closeDocReader();
    }
  });
  docReaderModal.addEventListener('keydown', trapDocReaderFocus);
  docReaderContent?.addEventListener('click', async (event) => {
    const link = event.target?.closest?.('a[href^="/api/docs/"]');
    if (!link) return;
    const id = decodeURIComponent(String(link.getAttribute('href')).replace(/^\/api\/docs\//, ''));
    const doc = docsById.get(id);
    if (!doc) return;
    event.preventDefault();
    await loadDoc(doc, { sourceElement: lastDocReaderFocus });
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !docReaderModal.hidden) {
      event.preventDefault();
      closeDocReader();
    }
  });
}

function formatDate(isoString) {
  if (!isoString) return 'Unknown completion date';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'Unknown completion date';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function truncateTitle(title) {
  const text = String(title ?? 'Untitled task');
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function statusBadgeClass(status) {
  if (status === 'done') return 'badge up';
  if (status === 'blocked') return 'badge down';
  return 'badge neutral';
}

function statusIcon(status) {
  if (status === 'done') return '✓';
  if (status === 'blocked') return '!';
  return '•';
}

async function refreshEpics() {
  if (!epicsList) return;
  try {
    const data = await getJson('/api/epics');
    epicsList.replaceChildren();

    const epics = Array.isArray(data.epics) ? data.epics : [];
    if (epics.length === 0) {
      epicsList.append(el('p', { className: 'muted', text: 'No completed epics yet.' }));
      return;
    }

    for (const epic of epics) {
      const children = [
        el('div', { className: 'epic-title', text: epic.title ?? 'Untitled epic' }),
        el('div', { className: 'epic-meta muted', text: formatDate(epic.completed_at) })
      ];

      if (Array.isArray(epic.subtasks) && epic.subtasks.length > 0) {
        const subtaskItems = epic.subtasks.map((task) => {
          return el('li', { className: 'subtask-item' }, [
            el('span', { className: 'badge neutral subtask-assignee', text: task.assignee ?? 'unassigned' }),
            el('span', { className: statusBadgeClass(task.status), text: `${statusIcon(task.status)} ${task.status ?? 'unknown'}` }),
            el('span', { className: 'subtask-title', title: task.title ?? '', text: truncateTitle(task.title) }),
          ]);
        });
        children.push(el('ul', { className: 'subtask-list' }, subtaskItems));
      }

      if (Array.isArray(epic.doc_links) && epic.doc_links.length > 0) {
        const links = epic.doc_links.map((doc) =>
          el('a', { href: doc.url, text: doc.label ?? 'Document', rel: 'noreferrer noopener', target: '_blank' })
        );
        children.push(el('div', { className: 'doc-links' }, [
          el('span', { className: 'muted', text: 'Docs: ' }),
          ...links,
        ]));
      }

      epicsList.append(el('article', { className: 'epic-card' }, children));
    }
  } catch (error) {
    epicsList.replaceChildren(el('p', { className: 'error', text: `Epics unavailable: ${error.message}` }));
  }
}


function updateKanbanDensityUi() {
  if (kanbanPanel) kanbanPanel.classList.toggle('kanban-compact', kanbanCompactMode);
  if (!kanbanCompactToggle) return;
  kanbanCompactToggle.textContent = kanbanCompactMode ? 'Expand board' : 'Compact board';
  kanbanCompactToggle.setAttribute('aria-expanded', String(!kanbanCompactMode));
  kanbanCompactToggle.setAttribute('aria-label', kanbanCompactMode ? 'Expand Kanban board cards' : 'Compact Kanban board cards');
}

function toggleKanbanDensity() {
  kanbanCompactMode = !kanbanCompactMode;
  setStoredBoolean(KANBAN_COMPACT_STORAGE_KEY, kanbanCompactMode);
  updateKanbanDensityUi();
}

function isKanbanLaneCollapsed(status) {
  return Array.isArray(collapsedKanbanLanes) && collapsedKanbanLanes.includes(status);
}

function toggleKanbanLane(status, laneNode, button) {
  const collapsed = !isKanbanLaneCollapsed(status);
  const next = new Set(Array.isArray(collapsedKanbanLanes) ? collapsedKanbanLanes : []);
  if (collapsed) next.add(status);
  else next.delete(status);
  collapsedKanbanLanes = [...next];
  writeStoredJson(KANBAN_COLLAPSED_LANES_STORAGE_KEY, collapsedKanbanLanes);
  laneNode.classList.toggle('is-collapsed', collapsed);
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-label', `${collapsed ? 'Show' : 'Hide'} ${laneTitle(status)} lane cards`);
  button.textContent = collapsed ? 'Show' : 'Hide';
}

function laneTitle(status) {
  return String(status || 'unknown').replace(/-/g, ' ').replace(/^./, (char) => char.toUpperCase());
}

function formatShortDate(isoString) {
  if (!isoString) return 'no date';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'no date';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function setKanbanMessage(message, kind = 'muted') {
  if (!kanbanMessage) return;
  kanbanMessage.className = `${kind} board-message`;
  kanbanMessage.textContent = message;
}

function mutationPayloadForDrop(card, status) {
  if (status === card.status) return null;
  if (!currentKanbanMutations.supported_statuses?.includes(status)) {
    setKanbanMessage(`Moving to ${status} is not supported by the safe dashboard API.`, 'error');
    return null;
  }
  if (status === 'blocked') {
    const reason = window.prompt(`Block ${card.id}? Enter the reason:`);
    if (!reason) return null;
    return { status, reason };
  }
  if (status === 'done') {
    const summary = window.prompt(`Complete ${card.id}? Enter the completion summary:`);
    if (!summary) return null;
    return { status, summary };
  }
  if (status === 'archived') {
    if (!window.confirm(`Archive ${card.id}? This hides it from the default board view.`)) return null;
    return { status, confirm: true };
  }
  const reason = window.prompt(`Move ${card.id} to ready? Optional reason:`, 'Promoted from dashboard');
  return { status, reason: reason || 'Promoted from dashboard' };
}

async function moveKanbanCard(card, status) {
  if (!currentKanbanMutations.enabled) {
    setKanbanMessage('Board is read-only: Kanban mutations are disabled on this dashboard instance.', 'error');
    return;
  }
  const payload = mutationPayloadForDrop(card, status);
  if (!payload) return;

  setKanbanMessage(`Moving ${card.id} to ${status}…`);
  try {
    await postJson(`/api/kanban/tasks/${card.id}/move`, payload);
    setKanbanMessage(`Moved ${card.id} to ${status}.`);
    await refreshKanban();
  } catch (error) {
    setKanbanMessage(`Move failed: ${error.message}`, 'error');
  }
}

function kanbanCardSummary(card, parentChildCue) {
  const parts = [
    card.id,
    card.title ?? 'Untitled task',
    `assignee: ${card.assignee ?? 'unassigned'}`,
    `status: ${card.status ?? 'unknown'}`,
    `priority: ${card.priority ?? 0}`
  ];
  if (parentChildCue.length) parts.push(parentChildCue.join(', '));
  return parts.join(' · ');
}

function renderKanbanCard(card, compactHidden = false) {
  const parentChildCue = [];
  if (card.parent_count) parentChildCue.push(`${card.parent_count} parent${card.parent_count === 1 ? '' : 's'}`);
  if (card.child_count) parentChildCue.push(`${card.child_count} child${card.child_count === 1 ? '' : 'ren'}`);

  const actionButtons = [
    ['ready', 'Ready'],
    ['blocked', 'Block'],
    ['done', 'Complete'],
    ['archived', 'Archive']
  ]
    .filter(([status]) => status !== card.status)
    .map(([status, label]) => {
      const button = el('button', { className: 'kanban-card-action', type: 'button', text: label });
      if (!currentKanbanMutations.enabled) {
        button.disabled = true;
        button.title = 'Kanban mutations are disabled on this dashboard instance';
      }
      button.addEventListener('click', () => moveKanbanCard(card, status));
      return button;
    });

  const summary = kanbanCardSummary(card, parentChildCue);
  const node = el('article', {
    className: compactHidden ? 'kanban-card compact-overflow-card' : 'kanban-card',
    draggable: currentKanbanMutations.enabled ? 'true' : 'false',
    'data-task-id': card.id,
    'data-task-status': card.status,
    title: summary,
    'aria-label': summary
  }, [
    el('div', { className: 'kanban-card-title', text: card.title ?? 'Untitled task' }),
    el('div', { className: 'kanban-card-meta' }, [
      el('span', { className: 'badge neutral', text: card.assignee ?? 'unassigned' }),
      el('span', { className: statusBadgeClass(card.status), text: card.status ?? 'unknown' }),
      el('span', { className: 'muted', text: `P${card.priority ?? 0}` })
    ]),
    el('div', { className: 'kanban-card-foot muted', text: `${card.id} · ${formatShortDate(card.created_at)}${parentChildCue.length ? ` · ${parentChildCue.join(' · ')}` : ''}` }),
    el('div', { className: 'kanban-card-actions' }, actionButtons)
  ]);

  node.addEventListener('dragstart', (event) => {
    if (!currentKanbanMutations.enabled) {
      event.preventDefault();
      setKanbanMessage('Board is read-only: Kanban mutations are disabled on this dashboard instance.', 'error');
      return;
    }
    currentDraggedTaskId = card.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.id);
  });
  node.addEventListener('dragend', () => {
    currentDraggedTaskId = null;
  });
  return node;
}

function renderKanbanBoard(payload) {
  if (!kanbanBoard) return;
  const lanes = Array.isArray(payload.lanes) ? payload.lanes : [];
  currentKanbanMutations = payload.mutations ?? { enabled: false, supported_statuses: [] };
  updateKanbanDensityUi();
  kanbanBoard.replaceChildren();

  if (lanes.length === 0) {
    kanbanBoard.append(el('p', { className: 'muted', text: 'No Kanban lanes available.' }));
    return;
  }

  setKanbanMessage(currentKanbanMutations.enabled
    ? 'Drag cards to supported lanes, or use card actions for Ready, Block, Complete, and Archive. Sensitive moves ask first.'
    : 'Read-only board: mutations are disabled unless the dashboard is explicitly configured with safe Hermes CLI access.');

  const cardsById = new Map(lanes.flatMap((lane) => (lane.cards ?? []).map((card) => [card.id, card])));
  for (const lane of lanes) {
    const cards = Array.isArray(lane.cards) ? lane.cards : [];
    const collapsed = isKanbanLaneCollapsed(lane.status);
    const laneNode = el('section', {
      className: collapsed ? 'kanban-lane is-collapsed' : 'kanban-lane',
      'data-status': lane.status
    });
    const laneToggle = el('button', {
      className: 'kanban-lane-toggle',
      type: 'button',
      text: collapsed ? 'Show' : 'Hide',
      'aria-expanded': String(!collapsed),
      'aria-label': `${collapsed ? 'Show' : 'Hide'} ${laneTitle(lane.status)} lane cards`
    });
    laneToggle.addEventListener('click', () => toggleKanbanLane(lane.status, laneNode, laneToggle));
    laneNode.append(el('div', { className: 'kanban-lane-heading' }, [
      el('div', { className: 'kanban-lane-title' }, [
        el('h3', { text: laneTitle(lane.status) }),
        el('span', { className: 'muted kanban-lane-summary', text: `${cards.length} card${cards.length === 1 ? '' : 's'}` })
      ]),
      el('div', { className: 'kanban-lane-controls' }, [
        el('span', { className: 'badge neutral', text: String(cards.length), 'aria-label': `${cards.length} cards` }),
        laneToggle
      ])
    ]));

    laneNode.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = currentKanbanMutations.supported_statuses?.includes(lane.status) ? 'move' : 'none';
    });
    laneNode.addEventListener('drop', async (event) => {
      event.preventDefault();
      const taskId = event.dataTransfer.getData('text/plain') || currentDraggedTaskId;
      const card = cardsById.get(taskId);
      if (card) await moveKanbanCard(card, lane.status);
    });

    if (cards.length === 0) {
      laneNode.append(el('p', { className: 'muted kanban-empty', text: 'No cards' }));
    } else {
      laneNode.append(...cards.map((card, index) => renderKanbanCard(card, index >= KANBAN_COMPACT_CARD_LIMIT)));
      if (cards.length > KANBAN_COMPACT_CARD_LIMIT) {
        laneNode.append(el('p', {
          className: 'muted kanban-overflow-note',
          text: `${cards.length - KANBAN_COMPACT_CARD_LIMIT} more card${cards.length - KANBAN_COMPACT_CARD_LIMIT === 1 ? '' : 's'} hidden in compact mode — expand board to show all.`
        }));
      }
    }
    kanbanBoard.append(laneNode);
  }
}

async function refreshKanban() {
  if (!kanbanBoard) return;
  if (refreshKanbanButton) refreshKanbanButton.disabled = true;
  try {
    renderKanbanBoard(await getJson('/api/kanban/board'));
  } catch (error) {
    kanbanBoard.replaceChildren(el('p', { className: 'error', text: `Kanban board unavailable: ${error.message}` }));
  } finally {
    if (refreshKanbanButton) refreshKanbanButton.disabled = false;
  }
}

if (refreshKanbanButton) {
  refreshKanbanButton.addEventListener('click', refreshKanban);
}

if (kanbanCompactToggle) {
  kanbanCompactToggle.addEventListener('click', toggleKanbanDensity);
}

updateKanbanDensityUi();

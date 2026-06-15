const title = document.querySelector('#dashboard-title');
const sections = document.querySelector('#sections');
const statusList = document.querySelector('#status-list');
const refreshButton = document.querySelector('#refresh-status');
const finnickContent = document.querySelector('#finnick-content');
const refreshFinnickButton = document.querySelector('#refresh-finnick');
const epicsList = document.querySelector('#epics-list');

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

function renderConfig(config) {
  document.title = config.title;
  title.textContent = config.title;
  sections.replaceChildren();

  if (config.sections.length === 0) {
    sections.append(el('p', { className: 'muted', text: 'No links configured yet.' }));
    return;
  }

  for (const section of config.sections) {
    const links = section.links.map((link) => el('a', { href: link.href, text: link.label, rel: 'noreferrer' }));
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
      body.push(el('a', { href: check.displayUrl, text: 'Open', rel: 'noreferrer' }));
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

async function boot() {
  try {
    renderConfig(await getJson('/api/config/public'));
  } catch (error) {
    sections.replaceChildren(el('p', { className: 'error', text: `Config unavailable: ${error.message}` }));
  }
  await refreshStatus();
  await refreshFinnick();
  await refreshEpics();
}

refreshButton.addEventListener('click', refreshStatus);
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

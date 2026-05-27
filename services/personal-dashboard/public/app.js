const title = document.querySelector('#dashboard-title');
const sections = document.querySelector('#sections');
const statusList = document.querySelector('#status-list');
const refreshButton = document.querySelector('#refresh-status');

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
}

refreshButton.addEventListener('click', refreshStatus);
boot();

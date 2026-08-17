import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

class FakeNode {
  constructor(tagName = '#text') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this._text = '';
    this.className = '';
    this.parent = null;
    this.ownerDocument = null;
    this.id = '';
    this.href = '';
    this.type = '';
    this.disabled = false;
    this.value = '';
  }

  append(...children) {
    for (const child of children) {
      if (child === null || child === undefined) continue;
      child.parent = this;
      child.ownerDocument = this.ownerDocument;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name === 'id') this.id = stringValue;
    if (name === 'href') this.href = stringValue;
    if (name === 'class') this.className = stringValue;
    if (name === 'type') this.type = stringValue;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }

  async click() {
    const event = { preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false, target: this };
    const results = (this.listeners.get('click') ?? []).map((callback) => callback(event));
    await Promise.all(results);
  }


  async input(value) {
    this.value = value;
    const event = { target: this };
    const results = (this.listeners.get('input') ?? []).map((callback) => callback(event));
    await Promise.all(results);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const results = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  get textContent() {
    if (this.tagName === '#TEXT') return this._text;
    return this.children.map((child) => child.textContent).join('') || this._text;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get classList() {
    return {
      contains: (className) => this.className.split(/\s+/).includes(className),
      toggle: (className, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        const shouldAdd = force ?? !classes.has(className);
        if (shouldAdd) classes.add(className);
        else classes.delete(className);
        this.className = [...classes].join(' ');
      }
    };
  }
}

function matchesSelector(node, selector) {
  if (selector.includes(',')) return selector.split(',').some((part) => matchesSelector(node, part.trim()));
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  const attrMatch = /^([a-z0-9-]+)?\[([^=]+)="([^"]+)"\]$/i.exec(selector);
  if (attrMatch) {
    const [, tag, attr, value] = attrMatch;
    return (!tag || node.tagName.toLowerCase() === tag.toLowerCase()) && node.getAttribute(attr) === value;
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

function createHarness() {
  const nodesById = new Map();
  const body = new FakeNode('body');
  const document = {
    title: '',
    activeElement: null,
    body,
    createElement: (tag) => { const node = new FakeNode(tag); node.ownerDocument = document; return node; },
    createTextNode: (text) => {
      const node = new FakeNode('#text');
      node.ownerDocument = document;
      node.textContent = text;
      return node;
    },
    querySelector: (selector) => {
      if (selector.startsWith('#')) return nodesById.get(selector.slice(1)) ?? null;
      return null;
    }
  };
  body.ownerDocument = document;
  const requiredIds = [
    'dashboard-title', 'sections', 'status-list', 'refresh-status', 'finnick-content', 'refresh-finnick',
    'investment-screener-content', 'refresh-investment-screener', 'investment-screener-controls',
    'investment-market-filter', 'investment-metric-filter', 'investment-weight-filter', 'investment-topn-filter',
    'reset-investment-screener-filters', 'epics-list', 'docs-list', 'docs-content', 'docs-search', 'refresh-docs',
    'kanban-panel', 'kanban-board', 'kanban-message', 'refresh-kanban', 'toggle-kanban-density',
    'doc-reader-modal', 'doc-reader-dialog', 'doc-reader-title', 'doc-reader-meta', 'doc-reader-content', 'close-doc-reader'
  ];
  for (const id of requiredIds) {
    const node = new FakeNode(id === 'close-doc-reader' ? 'button' : 'div');
    node.ownerDocument = document;
    node.setAttribute('id', id);
    nodesById.set(id, node);
    body.append(node);
  }
  for (const id of ['overview', 'work', 'knowledge', 'reports']) {
    const tab = new FakeNode('a');
    tab.ownerDocument = document;
    tab.setAttribute('id', `tab-${id}`);
    const panel = new FakeNode('section');
    panel.ownerDocument = document;
    panel.setAttribute('id', `panel-${id}`);
    nodesById.set(`tab-${id}`, tab);
    nodesById.set(`panel-${id}`, panel);
    body.append(tab);
    body.append(panel);
  }

  const hashListeners = [];
  const keyListeners = [];
  const window = {
    location: { hash: '#knowledge', origin: 'http://dashboard.local' },
    history: { pushState: (_state, _title, hash) => { window.location.hash = hash; } },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: (type, callback) => {
      if (type === 'hashchange') hashListeners.push(callback);
      if (type === 'keydown') keyListeners.push(callback);
    },
    dispatchHashChange: async () => {
      await Promise.all(hashListeners.map((callback) => callback()));
    },
    dispatchKeydown: async (key) => {
      const event = { key, preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false };
      await Promise.all(keyListeners.map((callback) => callback(event)));
      return event;
    }
  };

  const docs = [
    { id: 'investment-screener-overview', title: 'Overview', category: 'Investment Screener', path: 'services/personal-dashboard/docs/products/investment-screener/README.md' },
    { id: 'investment-screener-cli-generator', title: 'CLI and Generator', category: 'Investment Screener', path: 'services/personal-dashboard/docs/products/investment-screener/cli-generator.md' }
  ];
  const fetch = async (path) => {
    if (path === '/api/docs') return { ok: true, json: async () => ({ documents: docs }) };
    if (path === '/api/docs/investment-screener-overview') {
      return { ok: true, json: async () => ({ ...docs[0], content: '# What this is\n\nSee [CLI and generator](./cli-generator.md).' }) };
    }
    if (path === '/api/epics') return { ok: true, json: async () => ({ epics: [] }) };
    return { ok: true, json: async () => ({ checks: [], sections: [], lanes: [] }) };
  };

  vm.runInNewContext(appSource, { document, window, fetch, URL, URLSearchParams, console, setTimeout, clearTimeout });
  return { nodesById, window, document };
}

test('documentation TOC hash clicks keep the Knowledge tab selected', async () => {
  const { nodesById, window } = createHarness();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const docsList = nodesById.get('docs-list');
  const firstDocButton = docsList.querySelector('button');
  await firstDocButton.click();

  const tocLink = nodesById.get('doc-reader-content').querySelector('a[href="#what-this-is"]');
  assert.ok(tocLink, 'expected rendered TOC link for heading');

  window.location.hash = tocLink.href;
  await window.dispatchHashChange();

  assert.equal(nodesById.get('panel-knowledge').hidden, false);
  assert.equal(nodesById.get('panel-overview').hidden, true);
});

test('relative markdown doc links resolve to approved in-app document ids', async () => {
  const { nodesById } = createHarness();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const docsList = nodesById.get('docs-list');
  const firstDocButton = docsList.querySelector('button');
  await firstDocButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const content = nodesById.get('doc-reader-content');
  const docLink = content.querySelector('a[href="/api/docs/investment-screener-cli-generator"]');
  assert.ok(docLink, 'expected relative markdown link to map through approved /api/docs/:id route');
  assert.equal(docLink.getAttribute('target'), '_blank');
  assert.equal(content.querySelector('a[href="http://dashboard.local/cli-generator.md"]'), null);
});


test('documentation search filters approved docs and shows no-match state', async () => {
  const { nodesById } = createHarness();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const docsSearch = nodesById.get('docs-search');
  await docsSearch.input('cli');

  let buttons = nodesById.get('docs-list').querySelectorAll('button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, 'CLI and Generator');

  await docsSearch.input('nope');
  buttons = nodesById.get('docs-list').querySelectorAll('button');
  assert.equal(buttons.length, 0);
  assert.match(nodesById.get('docs-list').textContent, /No docs match “nope”/);
});


test('documentation opens in a modal reader and closes with Escape', async () => {
  const { nodesById, window, document } = createHarness();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const firstDocButton = nodesById.get('docs-list').querySelector('button');
  await firstDocButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(nodesById.get('doc-reader-modal').hidden, false);
  assert.equal(nodesById.get('doc-reader-title').textContent, 'Overview');
  assert.match(nodesById.get('doc-reader-content').textContent, /What this is/);
  assert.equal(document.activeElement, nodesById.get('close-doc-reader'));
  assert.match(nodesById.get('docs-content').textContent, /open in the reader overlay/);

  await window.dispatchKeydown('Escape');
  assert.equal(nodesById.get('doc-reader-modal').hidden, true);
  assert.equal(document.activeElement, firstDocButton);
});

test('documentation modal renders API-sanitized content without unsafe local values', async () => {
  const { nodesById } = createHarness();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nodesById.get('docs-list').querySelector('button').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rendered = nodesById.get('doc-reader-content').textContent;
  assert.equal(rendered.includes('/root/'), false);
  assert.doesNotMatch(rendered, /\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY)[A-Z0-9_]*\s*[:=]/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('dashboard docs viewer renders structured markdown instead of raw pre text', () => {
  assert.match(appSource, /function renderMarkdownDocument\(/);
  assert.match(appSource, /function renderMarkdownInline\(/);
  assert.match(appSource, /function headingAnchorId\(/);
  assert.match(appSource, /className: 'doc-markdown'/);
  assert.doesNotMatch(appSource, /el\('pre', \{ className: 'doc-viewer-content', text: data\.content/);
});

test('dashboard docs viewer builds a heading table of contents with stable anchors', () => {
  assert.match(appSource, /function markdownHeadings\(/);
  assert.match(appSource, /className: 'doc-toc'/);
  assert.match(appSource, /href: `#\$\{heading\.id\}`/);
  assert.match(appSource, /id: headingAnchorId\(/);
});

test('dashboard docs viewer preserves link safety for markdown links', () => {
  assert.match(appSource, /function safeMarkdownHref\(/);
  assert.match(appSource, /\['http:', 'https:', 'mailto:'\]/);
  assert.match(appSource, /rel: 'noopener noreferrer'/);
  assert.match(appSource, /target: '_blank'/);
  assert.doesNotMatch(appSource, /innerHTML\s*=/);
});

test('dashboard docs list supports grouping and selected document state', () => {
  assert.match(appSource, /function groupDocsByCategory\(/);
  assert.match(appSource, /function filterDocs\(/);
  assert.match(appSource, /const docsSearch = document\.querySelector\('#docs-search'\)/);
  assert.match(appSource, /docsSearch\.addEventListener\('input', applyDocsFilter\)/);
  assert.match(appSource, /className: 'doc-group'/);
  assert.match(appSource, /classList\.toggle\('is-selected'/);
  assert.match(appSource, /aria-current', selected \? 'true' : 'false'/);
});

test('dashboard docs CSS styles markdown, toc, selected state, tables, code blocks, and the modal reader', () => {
  for (const selector of ['.doc-markdown', '.doc-toc', '.doc-picker.is-selected', '.docs-actions', '#docs-search', '.doc-markdown table', '.doc-markdown pre', '.doc-markdown code', '.doc-reader-modal', '.doc-reader-dialog', '.doc-reader-content']) {
    assert.match(stylesSource, new RegExp(selector.replace('.', '\\.')));
  }
});


test('dashboard docs viewer includes modal reader focus and close handling', () => {
  assert.match(appSource, /const docReaderModal = document\.querySelector\('#doc-reader-modal'\)/);
  assert.match(appSource, /function openDocReader\(/);
  assert.match(appSource, /function closeDocReader\(/);
  assert.match(appSource, /event\.key === 'Escape'/);
  assert.match(appSource, /trapDocReaderFocus/);
});

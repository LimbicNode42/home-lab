import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { applyWritingFormat, createEmbedTemplate, parseWritingEmbedBlock } from '../public/writing-rich-text.js';

test('parseWritingEmbedBlock keeps only safe image embed fields and maps wrap classes', () => {
  const embed = parseWritingEmbedBlock([
    'type: image',
    'src: /assets/writing/hero.webp',
    'alt: Rack hero',
    'caption: safe caption',
    'align: right',
    'width: half',
    'style: position:absolute',
    'onclick: alert(1)'
  ].join('\n'));

  assert.equal(embed.kind, 'embed');
  assert.equal(embed.type, 'image');
  assert.equal(embed.src, '/assets/writing/hero.webp');
  assert.equal(embed.alt, 'Rack hero');
  assert.equal(embed.caption, 'safe caption');
  assert.deepEqual(embed.classes, ['writing-embed', 'writing-embed-image', 'writing-embed-align-right', 'writing-embed-width-half']);
  assert.equal(Object.hasOwn(embed, 'style'), false);
  assert.equal(Object.hasOwn(embed, 'onclick'), false);
});

test('parseWritingEmbedBlock turns unsafe media URLs and unsupported iframe embeds into warnings', () => {
  for (const raw of [
    'type: image\nsrc: javascript:alert(1)\nalt: bad',
    'type: image\nsrc: /assets/writing/../secret.png\nalt: bad',
    'type: image\nsrc: data:image/svg+xml,abc\nalt: bad',
    'type: iframe\nsrc: https://example.com/embed'
  ]) {
    const embed = parseWritingEmbedBlock(raw);
    assert.equal(embed.kind, 'warning');
    assert.equal(JSON.stringify(embed).includes('javascript:'), false);
    assert.equal(JSON.stringify(embed).includes('data:'), false);
    assert.equal(JSON.stringify(embed).includes('iframe'), false);
  }
});

test('writing formatting helpers wrap selections and create safe embed templates', () => {
  assert.deepEqual(applyWritingFormat('hello world', { start: 6, end: 11 }, 'bold'), {
    value: 'hello **world**',
    selectionStart: 8,
    selectionEnd: 13
  });
  assert.match(applyWritingFormat('item', { start: 0, end: 4 }, 'unordered-list').value, /^- item$/);
  const template = createEmbedTemplate({ type: 'image', src: '/assets/writing/hero.webp', alt: 'Hero', align: 'right', width: 'half', caption: 'Caption' });
  assert.match(template, /```embed\ntype: image\nsrc: \/assets\/writing\/hero\.webp\nalt: Hero\nalign: right\nwidth: half\ncaption: Caption\n```/);
});

test('Blog editor exposes rich toolbar, modal preview, and same safe renderer as saved posts', async () => {
  const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const stylesSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(indexSource, /id="writing-editor-toolbar"/);
  assert.match(indexSource, /data-writing-format="bold"/);
  assert.match(indexSource, /id="writing-editor-preview"/);
  assert.match(indexSource, /Markdown is supported[\s\S]*Raw HTML/);
  assert.match(indexSource, /src="\/writing-rich-text\.js"/);
  assert.match(appSource, /globalThis\.WritingRichText/);
  assert.match(appSource, /renderRichMarkdownDocument\(post\.body_markdown \|\| '', document/);
  assert.match(appSource, /renderWritingEditorPreview/);
  assert.match(stylesSource, /\.writing-embed-align-right/);
  assert.match(stylesSource, /float: right/);
  assert.match(stylesSource, /@media \(max-width: 720px\)[\s\S]*\.writing-embed-align-right/);
});

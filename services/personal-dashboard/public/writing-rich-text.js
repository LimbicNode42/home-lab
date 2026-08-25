const WRITING_EMBED_ALIGN = new Set(['none', 'left', 'right', 'center']);
const WRITING_EMBED_WIDTH = new Set(['full', 'wide', 'half', 'third']);
const WRITING_EMBED_TYPES = new Set(['image', 'video']);
const WRITING_LOCAL_ASSET_PATTERN = /^\/assets\/writing\/[a-z0-9][a-z0-9._/-]{0,180}$/i;

function clampText(value, max = 400) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function parseKeyValueBlock(raw) {
  const data = new Map();
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const match = /^([a-z][a-z0-9_-]{0,30})\s*:\s*(.*)$/i.exec(line.trim());
    if (!match) continue;
    data.set(match[1].toLowerCase(), clampText(match[2], 600));
  }
  return data;
}

function safeWritingAssetUrl(raw) {
  const url = clampText(raw, 220);
  if (!url || !WRITING_LOCAL_ASSET_PATTERN.test(url) || url.includes('..') || url.includes('\\')) return null;
  return url;
}

export function parseWritingEmbedBlock(raw) {
  const data = parseKeyValueBlock(raw);
  const type = data.get('type');
  if (!WRITING_EMBED_TYPES.has(type)) return { kind: 'warning', message: 'Unsupported or unsafe embed omitted.' };
  const src = safeWritingAssetUrl(data.get('src'));
  if (!src) return { kind: 'warning', message: 'Unsupported or unsafe embed omitted.' };
  const align = WRITING_EMBED_ALIGN.has(data.get('align')) ? data.get('align') : 'none';
  const width = WRITING_EMBED_WIDTH.has(data.get('width')) ? data.get('width') : 'full';
  const alt = clampText(data.get('alt'), 220);
  if (type === 'image' && !alt) return { kind: 'warning', message: 'Image embed omitted because alt text is required.' };
  const caption = clampText(data.get('caption'), 500);
  const embed = {
    kind: 'embed',
    type,
    src,
    alt,
    caption,
    align,
    width,
    classes: ['writing-embed', `writing-embed-${type}`, `writing-embed-align-${align}`, `writing-embed-width-${width}`]
  };
  if (!caption) delete embed.caption;
  return embed;
}

function safeMarkdownHref(rawHref) {
  const href = String(rawHref ?? '').trim();
  if (!href) return null;
  if (href.startsWith('#')) return href;
  if (href.startsWith('/') && !href.startsWith('//') && !href.includes('..') && !href.includes('\\')) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    try {
      const parsed = new URL(href);
      if (['http:', 'https:', 'mailto:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return parsed.href;
    } catch {
      return null;
    }
  }
  return null;
}

function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

function renderInline(doc, text) {
  const nodes = [];
  const source = String(text ?? '');
  const pattern = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) nodes.push(doc.createTextNode(source.slice(cursor, match.index)));
    if (match[2] !== undefined) nodes.push(el(doc, 'code', { text: match[2] }));
    else if (match[4] !== undefined) nodes.push(el(doc, 'strong', { text: match[4] }));
    else if (match[6] !== undefined) nodes.push(el(doc, 'em', { text: match[6] }));
    else {
      const href = safeMarkdownHref(match[8]);
      nodes.push(href ? el(doc, 'a', { href, text: match[7], rel: 'noopener noreferrer', target: '_blank' }) : doc.createTextNode(match[7]));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) nodes.push(doc.createTextNode(source.slice(cursor)));
  return nodes;
}

function appendInline(doc, parent, text) {
  for (const node of renderInline(doc, text)) parent.append(node);
}

function renderEmbed(doc, raw) {
  const embed = parseWritingEmbedBlock(raw);
  if (embed.kind !== 'embed') {
    return el(doc, 'aside', { className: 'writing-embed-warning', text: embed.message || 'Unsupported or unsafe embed omitted.' });
  }
  const media = embed.type === 'image'
    ? el(doc, 'img', { src: embed.src, alt: embed.alt, loading: 'lazy' })
    : el(doc, 'video', { src: embed.src, controls: '', preload: 'metadata', 'aria-label': embed.alt || 'Writing video embed' });
  const children = [media];
  if (embed.caption) children.push(el(doc, 'figcaption', { text: embed.caption }));
  return el(doc, 'figure', { className: embed.classes.join(' ') }, children);
}

function headingAnchorId(text, used = new Set()) {
  const base = String(text ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-') || 'section';
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

export function renderRichMarkdownDocument(markdown, doc = document) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const usedHeadings = new Set();
  const body = el(doc, 'div', { className: 'doc-markdown writing-rich-markdown' });
  let index = 0;
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = el(doc, 'p');
    appendInline(doc, p, paragraph.join(' '));
    body.append(p);
    paragraph = [];
  };
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    const fence = /^```\s*([a-z0-9_-]*)\s*$/i.exec(trimmed);
    if (fence) {
      flushParagraph();
      const lang = fence[1].toLowerCase();
      const blockLines = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        blockLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      if (lang === 'embed') body.append(renderEmbed(doc, blockLines.join('\n')));
      else body.append(el(doc, 'pre', {}, [el(doc, 'code', { text: blockLines.join('\n') })]));
      continue;
    }
    if (!trimmed) { flushParagraph(); index += 1; continue; }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const text = heading[2].trim();
      const h = el(doc, `h${level}`, { id: headingAnchorId(text, usedHeadings) });
      appendInline(doc, h, text);
      body.append(h);
      index += 1;
      continue;
    }
    if (/^---+$/.test(trimmed)) { flushParagraph(); body.append(el(doc, 'hr')); index += 1; continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      const quoteLines = [];
      while (index < lines.length) {
        const match = /^>\s?(.*)$/.exec(lines[index]);
        if (!match) break;
        quoteLines.push(match[1]);
        index += 1;
      }
      const blockquote = el(doc, 'blockquote');
      appendInline(doc, blockquote, quoteLines.join(' '));
      body.append(blockquote);
      continue;
    }
    const listMatch = /^(\s*)([-*+] |\d+\. )(.*)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      const ordered = /\d+\. /.test(listMatch[2]);
      const list = el(doc, ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const match = /^(\s*)([-*+] |\d+\. )(.*)$/.exec(lines[index]);
        if (!match || (/\d+\. /.test(match[2]) !== ordered)) break;
        const item = el(doc, 'li');
        appendInline(doc, item, match[3]);
        list.append(item);
        index += 1;
      }
      body.append(list);
      continue;
    }
    paragraph.push(trimmed);
    index += 1;
  }
  flushParagraph();
  return el(doc, 'div', { className: 'doc-rendered writing-rendered' }, [body]);
}

function selectionSlice(value, selection = {}) {
  const start = Number.isInteger(selection.start) ? selection.start : 0;
  const end = Number.isInteger(selection.end) ? selection.end : start;
  return { start: Math.max(0, Math.min(start, value.length)), end: Math.max(0, Math.min(end, value.length)) };
}

export function applyWritingFormat(value, selection, format) {
  const text = String(value ?? '');
  const { start, end } = selectionSlice(text, selection);
  const selected = text.slice(start, end);
  const fallback = selected || 'text';
  let replacement = fallback;
  let innerOffset = 0;
  if (format === 'bold') { replacement = `**${fallback}**`; innerOffset = 2; }
  else if (format === 'italic') { replacement = `*${fallback}*`; innerOffset = 1; }
  else if (format === 'code') { replacement = `\`${fallback}\``; innerOffset = 1; }
  else if (format === 'link') { replacement = `[${fallback}](https://example.com)`; innerOffset = 1; }
  else if (format === 'h2') { replacement = `## ${fallback}`; innerOffset = 3; }
  else if (format === 'h3') { replacement = `### ${fallback}`; innerOffset = 4; }
  else if (format === 'quote') { replacement = fallback.split(/\r?\n/).map((line) => `> ${line || 'quote'}`).join('\n'); innerOffset = 2; }
  else if (format === 'unordered-list') { replacement = fallback.split(/\r?\n/).map((line) => `- ${line || 'item'}`).join('\n'); innerOffset = 2; }
  else if (format === 'ordered-list') { replacement = fallback.split(/\r?\n/).map((line, index) => `${index + 1}. ${line || 'item'}`).join('\n'); innerOffset = 3; }
  else if (format === 'code-block') { replacement = `\n\`\`\`\n${fallback}\n\`\`\`\n`; innerOffset = 5; }
  const next = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
  return { value: next, selectionStart: start + innerOffset, selectionEnd: start + innerOffset + fallback.length };
}

export function createEmbedTemplate({ type = 'image', src = '/assets/writing/example.webp', alt = 'Describe this media', align = 'none', width = 'full', caption = '' } = {}) {
  const safeType = WRITING_EMBED_TYPES.has(type) ? type : 'image';
  const safeSrc = safeWritingAssetUrl(src) || '/assets/writing/example.webp';
  const safeAlign = WRITING_EMBED_ALIGN.has(align) ? align : 'none';
  const safeWidth = WRITING_EMBED_WIDTH.has(width) ? width : 'full';
  const lines = ['```embed', `type: ${safeType}`, `src: ${safeSrc}`, `alt: ${clampText(alt, 220) || 'Describe this media'}`, `align: ${safeAlign}`, `width: ${safeWidth}`];
  const safeCaption = clampText(caption, 500);
  if (safeCaption) lines.push(`caption: ${safeCaption}`);
  lines.push('```');
  return lines.join('\n');
}


globalThis.WritingRichText = { applyWritingFormat, createEmbedTemplate, parseWritingEmbedBlock, renderRichMarkdownDocument };

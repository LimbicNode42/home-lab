# Blog / Drafts Rich Authoring Design

> Implementation handoff for `t_5dc5a427`: build this with strict TDD. Write each failing test first, verify the failure, then implement the smallest passing slice.

## Goal

Modernize the existing Blog / Drafts feature from a plain textarea plus minimal Markdown preview into a safe rich authoring workflow that can create polished web posts with formatting, media, embeds, preview, and a migration path for existing plain-text/Markdown drafts.

## Current state inspected

Files inspected:

- `services/personal-dashboard/src/server.js`
  - Blog/Drafts storage is a host-local JSON file at `WRITING_POSTS_HOST_DIR` / `/app/writing`, defaulting in code to `data/writing-posts.json` for local fixtures.
  - API endpoints expose `/api/writing/posts` and `/api/writing/posts/:id` for list/read/create/update/delete.
  - Existing persisted post shape is flat JSON with `post_id`, `title`, `status`, `tags`, `body_markdown`, `attachments`, timestamps, and computed `preview`.
  - Existing body sanitization is `stripUnsafeMarkdown()`, which strips scripts, event attributes, `javascript:`, all raw HTML tags, control characters, and truncates to 40 KiB. Useful as a first gate, not a complete rich renderer security boundary.
  - Existing attachment sanitization only allows local `/assets/writing/...` URLs and limited content types.
- `services/personal-dashboard/public/index.html`
  - Blog/Drafts UI has a status filter, list, preview panel, and modal editor.
  - Editor is currently title/status/tags plus one `textarea#writing-editor-body`.
- `services/personal-dashboard/public/app.js`
  - Preview uses `renderMarkdownDocument(post.body_markdown || '')`.
  - The renderer creates DOM nodes with `textContent` and safe attributes via `el()`, not `innerHTML`.
  - Existing Markdown renderer supports headings, paragraphs, code fences, inline code, safe links, tables, quotes, lists, horizontal rules, and TOC generation; it does not support images, media/embed blocks, alignment, float/text-wrap controls, bold/italic parsing, editor toolbar controls, or live preview in the modal.
- `services/personal-dashboard/test/writing.test.js`
  - Tests already cover sanitized list/read behavior, CRUD durability, malformed IDs, corrupt/non-file store protection, and storage permissions.

## Decision: Markdown-first with typed fenced blocks

Use Markdown as the canonical authoring format for this iteration, plus a small typed-block convention embedded in Markdown fences for rich media/layout.

Do not switch to MDX for this dashboard now. MDX would require a build-time/runtime component compiler and a much larger XSS boundary. That is wrong for a private homelab app whose current frontend is dependency-light vanilla JS. Also, nobody needs a React compiler hiding under the bed.

Do not make block JSON the only canonical storage yet. It would be safer in the renderer but worse for authoring ergonomics, migration, manual recovery, and JSON-file diffability. The current store is already Markdown-shaped, so keep the stored `body_markdown` stable and layer typed blocks onto it.

Canonical model for the next implementation:

```json
{
  "post_id": "string-slug",
  "schema_version": "writing-post/v2",
  "title": "Post title",
  "status": "draft|published|archived",
  "tags": ["dashboard", "notes"],
  "body_markdown": "# Heading\n\nParagraph...\n\n```embed\ntype: image\nsrc: /assets/writing/hero.webp\nalt: Hero image\nalign: right\nwidth: half\ncaption: Optional caption\n```\n",
  "attachments": [],
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601",
  "published_at": "ISO-8601|null"
}
```

Compatibility rule:

- Missing `schema_version` means legacy `writing-post/v1`.
- Legacy posts already using `body_markdown`, `body`, or `text` continue to load through the existing fallback path.
- `sanitizeWritingPost()` should return `schema_version: 'writing-post/v2'` for API responses after normalizing, without rewriting the store just because a post was read.
- The store should be rewritten only on create/update/delete, preserving old posts unless touched.

## Supported authoring primitives

The implementation card should support these primitives first:

### Inline text

- Plain text
- Inline code: `` `code` ``
- Links: `[label](https://example.com)` or relative same-site links
- Strong emphasis: `**bold**`
- Emphasis: `*italic*`

Renderer rule: inline parsing must produce DOM nodes with `textContent` and explicit attributes only. No raw HTML interpretation.

### Block text

Already mostly present and should be kept:

- Headings `#` through `######`
- Paragraphs
- Ordered and unordered lists
- Blockquotes
- Fenced code blocks
- Tables
- Horizontal rules
- Generated TOC for headings

### Media/embed blocks

Use fenced blocks with a block kind as the fence language:

```markdown
```embed
type: image
src: /assets/writing/hero.webp
alt: Photo of the rack
align: right
width: half
caption: Optional caption
```
```

Initially supported `type` values:

1. `image`
   - `src`: required; must be a safe local asset URL matching the existing `/assets/writing/...` attachment boundary, or optionally `https://` only if explicitly permitted later.
   - `alt`: required for accessibility.
   - `caption`: optional text.
   - `align`: `none|left|right|center`.
   - `width`: `full|wide|half|third`.
2. `video`
   - Same local URL model; allow only safe media extensions/content types if server-side validation is added.
   - Render with controls, no autoplay, no inline event attributes.
   - `caption`, `align`, `width` same as image.
3. `iframe` / external embeds
   - Do not implement general iframe embeds in the first pass.
   - If YouTube/Vimeo/etc. are later wanted, implement named providers only (`type: youtube`, `video_id: ...`) and synthesize the embed URL from the ID. Never accept arbitrary iframe HTML or arbitrary `src`.

Unsupported embed blocks should render as a muted warning card in preview, not fail the whole post.

### Text wrap and alignment

Implement CSS classes generated from sanitized block options:

- `align: left` -> floated media card left on desktop, normal block on narrow screens.
- `align: right` -> floated media card right on desktop, normal block on narrow screens.
- `align: center` -> centered block.
- `align: none` -> normal block flow.
- `width: full|wide|half|third` maps to bounded CSS classes, never inline styles from user input.

Do not allow arbitrary CSS, classes, styles, dimensions, or HTML attributes in post content.

## Editor UX approach

Keep the textarea as the source editor for this iteration. Add progressive tooling around it rather than replacing it with a heavyweight WYSIWYG editor.

Required UI changes for `t_5dc5a427`:

- Add a compact toolbar above `#writing-editor-body`:
  - Heading dropdown or buttons for H2/H3.
  - Bold, italic, inline code.
  - Link insertion.
  - Quote, unordered list, ordered list, code block.
  - Image/embed block insertion.
  - Alignment/width controls for the selected embed block, or an insert dialog that writes the full fenced block.
- Add a split or toggle preview inside the modal:
  - `Write` pane keeps the textarea.
  - `Preview` pane renders the current textarea through the same safe renderer used by saved post preview.
  - Preview updates on input with a small debounce, or on explicit preview tab selection.
- Add help text near the editor linking the accepted subset:
  - “Markdown is supported. Raw HTML, scripts, and unsafe URLs are stripped. Embeds use fenced blocks.”
- Keep keyboard usability:
  - Toolbar buttons must be real buttons with labels/`aria-label`.
  - Focus stays in/near the editor after formatting actions.
  - Do not trap the user in toolbar gymnastics. The goblin can have a keyboard too.

Recommended file split before implementation grows more teeth:

- `public/app.js`
  - Keep app wiring and feature orchestration.
  - Move reusable render helpers into clearly named functions if modules are not introduced.
- If the project is ready for multiple browser modules, create:
  - `public/markdown-renderer.js` for safe Markdown/block rendering.
  - `public/writing-editor.js` for toolbar/editor behavior.
  - Then import them from `public/app.js`.
- If avoiding module split in this pass, at least group renderer/editor helpers together and add tests around exported/server-visible pieces where possible.

## API and storage contract

### Read/list

- `GET /api/writing/posts?status=...`
  - Continue omitting full `body_markdown` from list cards.
  - Include `schema_version` on cards if useful, but not required.
  - Keep `preview` plain text only.
- `GET /api/writing/posts/:id`
  - Return normalized `body_markdown` and `schema_version`.
  - Return only sanitized attachments/embeds metadata if adding any derived metadata.

### Create/update

- Accept `body_markdown` as the canonical body input.
- Accept no raw HTML field.
- Optional future body metadata field can be added as derived data only, for example `body_blocks_preview`, but do not persist unsanitized HTML.
- Reject empty body after sanitization.
- Keep max body around the current 40 KiB unless the implementation updates tests and UI limits together.

### Migration

- On read:
  - `body_markdown` wins.
  - Fallback to `body`, then `text`, matching current behavior.
  - Treat missing `schema_version` as `writing-post/v1` and normalize API response to `writing-post/v2`.
- On write/update:
  - Persist `schema_version: 'writing-post/v2'`.
  - Preserve existing post IDs and timestamps where current code already does.
  - Do not rewrite all existing posts as a separate migration step; lazy migration on edit is safer for a JSON file store.
- If an explicit migration script is later wanted, make it backup-first and idempotent:
  - Read JSON.
  - Validate it is a regular file.
  - Write `<posts.json>.bak.<timestamp>` before modifying.
  - Normalize only missing `schema_version` and fallback body fields.
  - Preserve unknown safe fields only if tests define that behavior.

## Rendering and sanitization boundaries

The renderer boundary must be: persisted Markdown in, trusted DOM nodes out. Never `innerHTML` post content.

Server-side boundaries:

- Keep stripping raw HTML and known script/event/unsafe URL patterns at write/read normalization.
- Add stricter parsing for fenced embed blocks:
  - Parse only simple `key: value` lines.
  - Drop unknown keys.
  - Validate `type`, `src`, `alt`, `caption`, `align`, `width` against allowlists and length caps.
  - For local assets, reuse the existing `/assets/writing/...` URL pattern and block `..`.
  - For any external URL, allow only `https:` and only for explicit named fields; no `javascript:`, `data:`, `file:`, `blob:`, protocol-relative URLs, or userinfo URLs.
- Keep API error payloads generic and path-free, matching existing writing tests.

Client-side boundaries:

- Render text through `document.createTextNode()` / `textContent`.
- Render links only after `safeMarkdownHref()` accepts the URL.
- Render images/media only from parsed safe embed attributes.
- Set `rel="noopener noreferrer"` and `target="_blank"` for external links.
- Never copy author-provided strings into `style`, `className` except via allowlist mapping, event handlers, `srcdoc`, or `iframe` HTML.
- Do not render arbitrary `<iframe>` or pasted embed HTML.

Defense-in-depth tests should include both server API sanitization and client renderer behavior. The existing server stripping is not enough by itself; a future change should have tests that prove unsafe content cannot become executable DOM.

## TDD implementation plan for `t_5dc5a427`

### Task 1: Preserve schema version and legacy migration contract

Files:

- Modify: `src/server.js`
- Test: `test/writing.test.js`

Steps:

1. Add a failing server test showing that a legacy post with `body` and no `schema_version` reads back with `schema_version: 'writing-post/v2'`, keeps the body as `body_markdown`, and is not rewritten on read.
2. Run the focused test and verify it fails for missing `schema_version`.
3. Implement minimal normalization in `sanitizeWritingPost()` / `normalizeWritingPayload()`.
4. Run the focused test, then `npm test`.

### Task 2: Add safe embed block parser tests

Files:

- Modify/create renderer/parser location depending on final split.
- Test: `test/writing.test.js` for server sanitization; add browser-renderer tests only if an existing DOM test harness is already present.

Steps:

1. Write failing tests for an image embed fenced block preserving safe fields and dropping unsafe fields/URLs.
2. Write failing tests for `javascript:`, `file:`, `data:`, `../`, arbitrary iframe HTML, unknown keys, and bad align/width values.
3. Implement a small parser that returns sanitized block metadata or a safe warning block.
4. Verify focused tests and full suite.

### Task 3: Render image/embed cards safely

Files:

- Modify: `public/app.js` or new `public/markdown-renderer.js`
- Modify: `public/styles.css`
- Test: add the closest available JS test coverage; if no DOM harness exists, factor pure parsing/URL validation so it is testable with `node:test`.

Steps:

1. Write a failing test for a safe image embed producing allowlisted metadata/classes and an unsafe embed not producing an executable URL.
2. Implement rendering with DOM node creation only.
3. Add CSS classes for `.writing-embed`, `.writing-embed-align-*`, `.writing-embed-width-*`, with responsive no-float behavior on small screens.
4. Verify focused tests and full suite.

### Task 4: Add formatting toolbar and insertion helpers

Files:

- Modify: `public/index.html`
- Modify: `public/app.js` or new `public/writing-editor.js`
- Modify: `public/styles.css`

Steps:

1. Write tests for pure text insertion helpers: wrap selection as bold/italic/code/link/list and insert image embed template.
2. Implement toolbar DOM and event handlers using those helpers.
3. Ensure toolbar buttons are `type="button"`, labeled, and return focus to the editor.
4. Verify tests.

### Task 5: Add modal preview

Files:

- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

Steps:

1. Write a failing test for preview state/helper behavior if practical.
2. Add `Write`/`Preview` toggle or split preview region in the modal.
3. Reuse the same renderer as the saved post preview.
4. Add debounce only if needed; avoid complicated state machines.
5. Verify manually if no browser automation exists, and include the manual steps in the handoff.

### Task 6: Update docs/help text and README

Files:

- Modify: `README.md`
- Optionally modify/create product doc under `docs/products/blog-drafts/`.

Steps:

1. Document the accepted Markdown subset, embed block syntax, security stripping behavior, and migration behavior.
2. Run `npm test`.
3. Commit task-scoped changes only.

## Acceptance checklist for implementation

- Existing posts/drafts still load and edit.
- Existing CRUD tests still pass.
- New tests cover schema migration, sanitizer behavior, safe renderer behavior, CRUD persistence, and at least one image embed with right/left wrap behavior.
- Saved preview and editor preview use the same safe renderer.
- Unsafe raw HTML, script/event handlers, unsafe URLs, arbitrary iframes, and inline styles do not reach rendered DOM.
- Author can create headings, emphasis, links, lists, quotes, code, image/media blocks, and choose align/wrap/width controls without hand-writing every character.
- The implementation remains dependency-light unless a sanitizer library is deliberately added with tests proving its allowlist configuration.

## Not in first implementation pass

- MDX.
- Arbitrary HTML blocks.
- General pasted iframe embed HTML.
- Remote image hotlinking unless explicitly approved.
- Full drag/drop media upload pipeline.
- Collaborative editing, version history, or scheduling.

Those are not bad ideas. They are just extra tentacles, and this feature already has enough limbs.

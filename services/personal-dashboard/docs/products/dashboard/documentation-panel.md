# Documentation Panel Guide

The **Documentation** panel is the dashboard's built-in reader for approved Markdown documentation. It is designed to show useful product and operations docs without turning the browser into a file browser.

## Where to find it

Open **Knowledge**, then use the **Documentation** panel at the top of the tab.

## What it does

The panel lists committed, allowlisted Markdown documents. Selecting a document loads it into the reader with formatted headings, lists, tables, code blocks, safe links, and a table of contents when headings are available.

## How to use it

1. Open **Knowledge**.
2. Type in **Search docs** to filter by document title, category, or description.
3. Select a document from the list.
4. Use the table of contents to jump between sections.
5. Open safe external links in a new tab when needed.
6. Use **Refresh** after a dashboard update if a newly added document does not appear yet.

## Why only some docs appear

The dashboard exposes only documents that are explicitly approved in the documentation registry and present in the committed repository. That keeps scratch files, secret-bearing files, local-only notes, and accidental paths out of the browser.

Completed Epic writeups are intentionally separate. They are linked from the **Completed Epics** panel, not dumped into the general Documentation list.

## Data source and freshness

The list comes from the dashboard documentation registry. The content comes from committed Markdown files. A document appears only after it exists in the committed source and the dashboard version serving the registry knows about it.

## Empty and error states

- **No documents**: the registry may be empty, filtered by the trust boundary, or the dashboard may be running an older build.
- **No search results**: clear the search text or try a broader term.
- **Document unavailable**: the document id is known, but the committed file may be absent or excluded by the safety checks.
- **Some lines missing**: the runtime sanitizer can omit browser-unsafe lines, such as private paths or secret-shaped values.

## Known limitations

- The panel is read-only. It cannot edit docs.
- It does not browse arbitrary repository paths.
- It is for human-facing Markdown, not live command output or private implementation notes.

## Troubleshooting hints

- If a document was just added, check whether it was committed and included in the registry.
- If a heading link feels wrong, use the visible table of contents rather than hand-editing anchors.
- If content appears over-sanitized, move private operational details into an operator-only doc and keep the browser-facing guide concise.

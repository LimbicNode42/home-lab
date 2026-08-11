# Completed epic documents

This directory contains sanitized Markdown coverage for completed epics shown by the personal dashboard Completed Epics panel.

Implementation contract for dashboard integration:

- Load `index.json` as a machine-readable manifest of dashboard document ids, epic ids, titles, completion timestamps, and repo-relative Markdown paths.
- Expose each entry through the existing documentation allowlist path; do not accept arbitrary browser-provided paths.
- Add a dashboard-internal doc link for each `/api/epics` item whose id matches an `epic_id` in the manifest.
- If a manifest entry is unavailable at runtime, generate a virtual fallback from the public `/api/epics` fields only: id, title, completed_at, subtasks id/title/status/assignee, and already-approved committed doc links.
- Never include task bodies, command logs, local filesystem paths, database paths, standard-error output, credentials, connection strings, or secret-shaped values.

The Markdown files here are intentionally concise. They are operator context, not a transcript dump with better typography.

# Completed Epics Guide

The **Completed Epics** panel summarizes finished multi-task work from the homelab Kanban workflow. It gives a human-readable record of what shipped, which subtasks contributed, and where the committed writeups live.

## Where to find it

Open **Knowledge**, then scroll below the **Documentation** panel to **Completed Epics**.

## What it does

Completed Epics shows finished project lanes as compact cards. Each card may include:

- the epic title;
- completion date or recent activity timing;
- a short summary;
- subtask counts or notable child work;
- links to committed documentation artifacts when available.

## How to use it

1. Open **Knowledge**.
2. Review the newest completed epics first.
3. Open any linked documentation for the detailed artifact or decision record.
4. Use the epic summary as an orientation point, not as a replacement for the underlying docs.

## Data source and freshness

Completed Epics is backed by a read-only snapshot of the Kanban board. The dashboard presents redacted summaries and committed documentation links rather than full task bodies. Freshness depends on when the snapshot was last produced and when the dashboard runtime picked it up.

## Empty and error states

- If there are no completed epics, the snapshot may not contain matching completed work yet.
- If the panel is unavailable, the Kanban snapshot may not be mounted or readable by the dashboard runtime.
- If an epic has no documentation link, the work may have completed without a committed artifact, or the artifact may not be in the approved repository path.

## Known limitations

- This panel is a read-only history view. It does not move cards or edit tasks.
- It intentionally does not show private task bodies, command output, secrets, or local paths.
- Completed Epic documents are linked from this panel only; they are not part of the general Documentation search list.

## Troubleshooting hints

- If a recent epic is missing, wait for the next snapshot or refresh after deployment.
- If a documentation link is missing, check whether the worker committed a safe artifact path.
- If the panel reports an unavailable state, treat it as a snapshot/runtime issue rather than a sign that the Kanban board itself is gone. Databases rarely vanish politely.

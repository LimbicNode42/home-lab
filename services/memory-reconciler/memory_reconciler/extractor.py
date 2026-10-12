"""Read-only Kanban extractor: done tasks -> curated completion records.

v1 scope (allowlist-first):

* only ``tasks.status == 'done'``
* only the LATEST successful run's human ``summary`` + curated non-secret
  ``metadata``
* NEVER read ``tasks.body`` (may hold sensitive ops detail)

The extractor opens the SQLite DB read-only (``mode=ro`` URI) so it can never
mutate the board. It returns plain dataclasses for the rest of the pipeline;
it does not write mem0 or Graphiti itself.

Session-outcome ingest is intentionally absent here (curated-ingest policy
section 3): raw transcripts and bulk session-search output are prohibited.
See ``classify.py`` for the stub left for a future review-gated extractor.
"""

from __future__ import annotations

import json
import sqlite3
import urllib.parse
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Metadata keys we are willing to lift out of a run. Everything else is ignored
# so a wide or carelessly-shaped metadata blob cannot feed secret material into
# downstream curation. These are the "curated non-secret" fields the task body
# explicitly calls out (unchanged_files/decisions/performance and the like).
CURATED_METADATA_KEYS = {
    "decisions",
    "unchanged_files",
    "changed_files",
    "performance",
    "tests_run",
    "tests_passed",
    "findings",
    "verification",
    "fix_strategy",
}


@dataclass
class CompletionRecord:
    """One done task reduced to non-secret, curated fields."""

    task_id: str
    title: str
    assignee: str
    run_id: int
    summary: str
    metadata: dict[str, Any] = field(default_factory=dict)
    completed_at: str | None = None

    @property
    def source(self) -> str:
        return "kanban_completion_summary"


class KanbanExtractor:
    """Read-only access to the Kanban board for the reconciler."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)

    def _connect(self) -> sqlite3.Connection:
        uri = "file:" + urllib.parse.quote(self.db_path) + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    def iter_done_records(self) -> list[CompletionRecord]:
        """Return curated completion records for all *done* tasks."""

        records: list[CompletionRecord] = []
        with self._connect() as conn:
            done_tasks = conn.execute(
                "SELECT id, title, assignee, completed_at FROM tasks WHERE status = 'done'"
            ).fetchall()
            for task in done_tasks:
                # Latest successful run: highest id among runs with outcome
                # 'completed'. A task might have later blocked/crashed runs; we
                # only trust a *successful* completion as the summary source.
                run = conn.execute(
                    "SELECT id, summary, metadata, ended_at FROM task_runs "
                    "WHERE task_id = ? AND outcome = 'completed' "
                    "ORDER BY id DESC LIMIT 1",
                    (task["id"],),
                ).fetchone()
                if run is None or not (run["summary"] and run["summary"].strip()):
                    continue
                meta = _curate_metadata(run["metadata"])
                completed_at = _fmt_epoch(task["completed_at"] or run["ended_at"])
                records.append(
                    CompletionRecord(
                        task_id=task["id"],
                        title=task["title"] or "",
                        assignee=task["assignee"] or "",
                        run_id=run["id"],
                        summary=run["summary"].strip(),
                        metadata=meta,
                        completed_at=completed_at,
                    )
                )
        return records


def _curate_metadata(raw: str | None) -> dict[str, Any]:
    """Lift only allowlisted, non-secret scalar/list metadata fields."""

    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {key: parsed[key] for key in CURATED_METADATA_KEYS if key in parsed}


def _fmt_epoch(epoch: int | None) -> str | None:
    if not epoch:
        return None
    return datetime.fromtimestamp(epoch, tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
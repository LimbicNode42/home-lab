"""Dedup/idempotency state: ``(source, task_id, run_id)`` -> ``ingested_at``.

Backed by a local SQLite file (tori-local disk, NOT NAS/NFS). mem0 and Graphiti
are recorded INDEPENDENTLY so a partial failure only loses track of the side
that actually failed; the other side still records and a re-run skips it.

Re-running the reconciler over the same ``(task_id, run_id)`` is a no-op for
any already-seen side.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS ingested (
    source      TEXT NOT NULL,
    task_id     TEXT NOT NULL,
    run_id      INTEGER NOT NULL,
    target      TEXT NOT NULL,  -- 'mem0' | 'graphiti'
    ingested_at TEXT NOT NULL,
    PRIMARY KEY (source, task_id, run_id, target)
);
"""


class DedupState:
    """Thin idempotency ledger keyed by ``(source, task_id, run_id, target)``."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(_SCHEMA)
        return conn

    def is_seen(self, source: str, task_id: str, run_id: int, target: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM ingested WHERE source = ? AND task_id = ? AND run_id = ? AND target = ?",
                (source, task_id, run_id, target),
            ).fetchone()
        return row is not None

    def record(self, source: str, task_id: str, run_id: int, target: str) -> None:
        now = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO ingested (source, task_id, run_id, target, ingested_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (source, task_id, run_id, target, now),
            )

    def record_many(self, entries: list[tuple[str, str, int, str]]) -> None:
        """Atomically record several ``(source, task_id, run_id, target)`` rows."""

        now = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        with self._connect() as conn:
            conn.executemany(
                "INSERT OR REPLACE INTO ingested (source, task_id, run_id, target, ingested_at) "
                "VALUES (?, ?, ?, ?, ?)",
                [(s, t, r, g, now) for (s, t, r, g) in entries],
            )

    def stats(self) -> dict[str, int]:
        with self._connect() as conn:
            total = conn.execute("SELECT COUNT(*) FROM ingested").fetchone()[0]
            mem0 = conn.execute("SELECT COUNT(*) FROM ingested WHERE target = 'mem0'").fetchone()[0]
            graphiti = conn.execute("SELECT COUNT(*) FROM ingested WHERE target = 'graphiti'").fetchone()[0]
        return {"total_rows": total, "mem0": mem0, "graphiti": graphiti}
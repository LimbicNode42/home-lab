"""Acceptance tests for the memory-reconciler pipeline.

Covers (mapped to the task's acceptance criteria):

1. dedup skips already-seen (task_id, run_id) on re-run
2. task-progress/secret-shaped summaries are NOT written to mem0
3. a credential/.env/token-shaped summary is redacted/rejected before Graphiti
4. batch >25 or >1500 words is rejected
5. model/embedding mismatch fails closed
6. dry-run performs no writes
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

import conftest  # noqa: F401  (registers sys.path)

from memory_reconciler.classify import classify_for_mem0, mem0_fact_text
from memory_reconciler.config import ReconcilerConfig
from memory_reconciler.episode_builder import build_episode
from memory_reconciler.extractor import CompletionRecord
from memory_reconciler.guardrails import GuardrailViolation, validate_batch_size, validate_word_count
from memory_reconciler.pipeline import Reconciler
from memory_reconciler.state import DedupState

TASK_ID = "t_abc12345"
RUN_ID = 1
DURABLE_SUMMARY = (
    "Establish the homelab secrets convention: secrets live in Vaultwarden under "
    "the Homelab folder and are referenced by folder/item/field only."
)


def durable_task_dict() -> dict:
    return {
        "id": TASK_ID,
        "title": "establish vaultwarden secrets convention",
        "assignee": "gremlin",
        "summary": DURABLE_SUMMARY,
        "metadata": {"decisions": ["use Vaultwarden folder/item/field references only"]},
    }


def record(**overrides) -> CompletionRecord:
    base = {
        "task_id": TASK_ID,
        "title": "establish vaultwarden secrets convention",
        "assignee": "gremlin",
        "run_id": RUN_ID,
        "summary": DURABLE_SUMMARY,
        "metadata": {"decisions": ["use Vaultwarden folder/item/field references only"]},
        "completed_at": "2026-10-01T00:00:00Z",
    }
    base.update(overrides)
    return CompletionRecord(**base)


def make_config(tmp_path: Path, *, dry_run: bool = True, state_db: Path | None = None) -> ReconcilerConfig:
    return ReconcilerConfig(
        kanban_db=tmp_path / "kanban.db",
        state_db=state_db or tmp_path / "state.db",
        dry_run=dry_run,
    )


def make_kanban_db(tmp_path: Path, tasks: list[dict]) -> Path:
    db = tmp_path / "kanban.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, assignee TEXT, status TEXT, completed_at INTEGER);
        CREATE TABLE task_runs (id INTEGER PRIMARY KEY, task_id TEXT, status TEXT, outcome TEXT, summary TEXT, metadata TEXT, ended_at INTEGER);
        """
    )
    for task in tasks:
        conn.execute(
            "INSERT INTO tasks (id, title, assignee, status, completed_at) VALUES (?,?,?,?,?)",
            (task["id"], task["title"], task["assignee"], "done", 1790000000),
        )
        conn.execute(
            "INSERT INTO task_runs (task_id, status, outcome, summary, metadata, ended_at) VALUES (?,?,?,?,?,?)",
            (task["id"], "done", "completed", task["summary"], json.dumps(task.get("metadata", {})), 1790000000),
        )
    conn.commit()
    conn.close()
    return db


class RecordingMem0:
    """Fake mem0 writer that records attempted writes."""

    def __init__(self, dry_run=False):
        self.dry_run = dry_run
        self.writes: list[str] = []

    def add_fact(self, text: str):
        self.writes.append(text)
        return {"status": "ok" if not self.dry_run else "dry_run"}


class RecordingGraphiti:
    def __init__(self, dry_run=False):
        self.dry_run = dry_run
        self.ingested: list[dict] = []

    def ingest(self, payload: dict):
        self.ingested.append(payload)
        return {"status": "ok" if not self.dry_run else "dry_run"}


class FailingGraphiti:
    def ingest(self, payload: dict):
        raise RuntimeError("graphiti down")


# --- (2) task-progress / secret-shaped summaries are NOT written to mem0 -----

def test_classifier_skips_task_progress_logs():
    progress = record(
        summary="Shipped the rate limiter; 14 tests passed.",
        title="shipped rate limiter",
    )
    assert classify_for_mem0(progress).mem0_writable is False


def test_classifier_rejects_secret_shaped_summary():
    secret = record(
        summary="Rotated OPENROUTER_API_KEY=sk-or-v1-abcdef1234567890abcdef1234567890 in production.",
        title="rotate key",
    )
    assert classify_for_mem0(secret).mem0_writable is False


def test_classifier_accepts_durable_fact():
    durable = record()
    assert classify_for_mem0(durable).mem0_writable is True
    fact = mem0_fact_text(durable)
    assert "Vaultwarden" in fact


# --- (3) credential/.env/token-shaped summary redacted/rejected pre-Graphiti --

def test_episode_builder_redacts_credential_material_via_existing_package():
    secret = record(
        summary="Rotated the API key; new value sk-abcdef1234567890abcdef1234567890abcdef.",
        title="rotate key",
    )
    # build_episode -> validate_episode(sanitize=True) redacts token-shaped
    # values, so no credential material may survive into the payload.
    payload = build_episode(secret)
    assert "sk-abcdef" not in payload["episode_body"]
    assert "[REDACTED_SECRET]" in payload["episode_body"]


def test_episode_builder_redacts_env_assignment():
    env = record(
        summary="Set OPENROUTER_API_KEY=sk-or-v1-abcdef1234567890abcdef1234567890 for ingest.",
        title="set env",
    )
    payload = build_episode(env)
    body = payload["episode_body"]
    assert "sk-or-v1" not in body
    assert "OPENROUTER_API_KEY=[REDACTED_SECRET]" in body


# --- (4) batch >25 or >1500 words rejected -----------------------------------

def test_batch_size_rejects_over_25():
    with pytest.raises(GuardrailViolation):
        validate_batch_size(26)
    validate_batch_size(25)


def test_word_count_rejects_over_1500():
    with pytest.raises(GuardrailViolation):
        validate_word_count(1501)
    validate_word_count(1500)


# --- (5) model/embedding mismatch fails closed -------------------------------

def test_model_mismatch_fails_closed():
    from memory_reconciler.guardrails import validate_model_allowlist

    with pytest.raises(GuardrailViolation):
        validate_model_allowlist(
            completion_model="openai/gpt-4o",  # not allowlisted
            rerank_model="openai/gpt-4o-mini",
            embedding_model="openai/text-embedding-3-small",
            embedding_dim=1536,
        )
    with pytest.raises(GuardrailViolation):
        validate_model_allowlist(
            completion_model="openai/gpt-4o-mini",
            rerank_model="openai/gpt-4o-mini",
            embedding_model="openai/text-embedding-3-small",
            embedding_dim=1024,  # wrong dim
        )


def test_model_mismatch_fails_closed_via_pipeline_preflight(tmp_path):
    cfg = make_config(tmp_path, dry_run=True)
    cfg.embedding_dim = 1024
    with pytest.raises(GuardrailViolation):
        Reconciler(cfg).reconcile()


# --- (6) dry-run performs no writes ------------------------------------------

def test_dry_run_performs_no_writes(tmp_path):
    make_kanban_db(tmp_path, [durable_task_dict()])
    cfg = make_config(tmp_path, dry_run=True)
    reporter = Reconciler(cfg).reconcile()
    assert reporter.dry_run is True
    # The state ledger must remain empty in dry-run (no side effects).
    assert DedupState(cfg.state_db).stats()["total_rows"] == 0


# --- (1) dedup skips already-seen (task_id, run_id) on re-run ----------------

def test_dedup_skips_already_seen_on_rerun(tmp_path):
    make_kanban_db(tmp_path, [durable_task_dict()])
    state_db = tmp_path / "state.db"
    cfg = make_config(tmp_path, dry_run=False, state_db=state_db)

    first = Reconciler(cfg, mem0_writer=RecordingMem0(), graphiti_writer=RecordingGraphiti()).reconcile()
    assert first.mem0_written == 1
    assert first.graphiti_written == 1

    # Second run over the same DB must be a no-op.
    mem0_2 = RecordingMem0()
    graphiti_2 = RecordingGraphiti()
    second = Reconciler(cfg, mem0_writer=mem0_2, graphiti_writer=graphiti_2).reconcile()
    assert second.seen == 1
    assert second.processed == 0
    assert mem0_2.writes == []
    assert graphiti_2.ingested == []
    assert second.mem0_written == 0
    assert second.graphiti_written == 0


def test_dedup_partial_failure_preserves_independent_state(tmp_path):
    """A mem0 success and Graphiti failure records mem0 but not Graphiti."""

    make_kanban_db(tmp_path, [durable_task_dict()])
    state_db = tmp_path / "state.db"
    cfg = make_config(tmp_path, dry_run=False, state_db=state_db)

    reporter = Reconciler(
        cfg, mem0_writer=RecordingMem0(), graphiti_writer=FailingGraphiti()
    ).reconcile()
    assert reporter.mem0_written == 1
    assert reporter.graphiti_written == 0
    assert reporter.failed >= 1

    state = DedupState(state_db)
    assert state.is_seen("kanban_completion_summary", TASK_ID, RUN_ID, "mem0") is True
    assert state.is_seen("kanban_completion_summary", TASK_ID, RUN_ID, "graphiti") is False


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main([__file__, "-v"]))
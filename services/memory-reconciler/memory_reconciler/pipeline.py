"""Reconciliation pipeline: extract -> classify -> dedup -> dual-write.

The heart of the reconciler. It walks done tasks, skips already-seen
``(task_id, run_id)`` per target, and dual-writes durable facts to mem0 and
curated episodes to Graphiti. Each target is recorded independently so a
partial failure never loses track of the side that succeeded.

``dry_run`` performs ZERO writes (neither network nor state ledger) and reports
what would have happened.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import guardrails
from .classify import classify_for_mem0, mem0_fact_text
from .config import MAX_EPISODES_PER_BATCH, ReconcilerConfig
from .episode_builder import build_episode
from .extractor import CompletionRecord, KanbanExtractor
from .state import DedupState
from .writers import GraphitiWriter, Mem0Writer, WriterError


@dataclass
class ItemOutcome:
    task_id: str
    run_id: int
    mem0: str = "skip"
    graphiti: str = "skip"
    error: str | None = None


@dataclass
class RunReport:
    seen: int = 0
    processed: int = 0
    mem0_written: int = 0
    graphiti_written: int = 0
    failed: int = 0
    dry_run: bool = True
    outcomes: list[ItemOutcome] = field(default_factory=list)
    review_bucket: list[tuple[str, int, str]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "seen": self.seen,
            "processed": self.processed,
            "mem0_written": self.mem0_written,
            "graphiti_written": self.graphiti_written,
            "failed": self.failed,
            "dry_run": self.dry_run,
            "review_bucket": [
                {"task_id": task, "run_id": run, "reason": reason}
                for task, run, reason in self.review_bucket
            ],
        }


class Reconciler:
    """Curated, idempotent Kanban -> mem0 + Graphiti pipeline."""

    SOURCE = "kanban_completion_summary"

    def __init__(
        self,
        config: ReconcilerConfig,
        *,
        mem0_writer: Any = None,
        graphiti_writer: Any = None,
    ) -> None:
        self.config = config
        self.extractor = KanbanExtractor(config.kanban_db)
        self.state = DedupState(config.state_db)
        self.mem0 = mem0_writer or Mem0Writer(
            host=config.mem0_host,
            api_key=config.mem0_api_key,
            user_id=config.mem0_user_id,
            agent_id=config.mem0_agent_id,
            dry_run=config.dry_run,
        )
        self.graphiti = graphiti_writer or GraphitiWriter(
            base_url=config.graphiti_base_url, dry_run=config.dry_run
        )

    def _preflight(self) -> None:
        """Fail closed on allowlist/budget mismatches before any writes."""

        guardrails.validate_model_allowlist(
            completion_model=self.config.completion_model,
            rerank_model=self.config.rerank_model,
            embedding_model=self.config.embedding_model,
            embedding_dim=self.config.embedding_dim,
        )

    def reconcile(self, *, record_limit: int | None = None) -> RunReport:
        self._preflight()

        records = self.extractor.iter_done_records()

        # The "max 25 episodes/batch" budget (policy section 8.3) applies to
        # what a single run *writes*, not to the total number of historically
        # done tasks. Default the cap to the batch limit; dedup makes re-runs
        # idempotent so the backlog drains in successive bounded runs.
        cap = record_limit if record_limit is not None else MAX_EPISODES_PER_BATCH
        if cap < 1:
            raise ValueError("record_limit must be a positive integer")

        report = RunReport(dry_run=self.config.dry_run)

        for record in records:
            if report.processed >= cap:
                break

            mem0_seen = self.state.is_seen(self.SOURCE, record.task_id, record.run_id, "mem0")
            graphiti_seen = self.state.is_seen(self.SOURCE, record.task_id, record.run_id, "graphiti")
            already_seen = mem0_seen and graphiti_seen

            if already_seen:
                report.seen += 1
                report.outcomes.append(ItemOutcome(record.task_id, record.run_id, "seen", "seen"))
                continue

            outcome = ItemOutcome(record.task_id, record.run_id)
            both_pending = (not mem0_seen) and (not graphiti_seen)
            report.processed += 1

            # --- mem0 side ---
            if not mem0_seen:
                classification = classify_for_mem0(record)
                if classification.mem0_writable:
                    fact = mem0_fact_text(record)
                    try:
                        self.mem0.add_fact(fact)
                        if not self.config.dry_run:
                            self.state.record(self.SOURCE, record.task_id, record.run_id, "mem0")
                        report.mem0_written += 1
                        outcome.mem0 = "written"
                    except WriterError as exc:
                        report.failed += 1
                        outcome.error = str(exc)
                        report.review_bucket.append((record.task_id, record.run_id, "mem0_write_failed"))
                else:
                    outcome.mem0 = "skipped"

            # --- Graphiti side ---
            if not graphiti_seen:
                try:
                    payload = build_episode(record)
                    self.graphiti.ingest(payload)
                    if not self.config.dry_run:
                        self.state.record(self.SOURCE, record.task_id, record.run_id, "graphiti")
                    report.graphiti_written += 1
                    outcome.graphiti = "written"
                except Exception as exc:  # noqa: BLE001 - episode build or writer error
                    report.failed += 1
                    if outcome.error is None:
                        outcome.error = str(exc)
                    report.review_bucket.append((record.task_id, record.run_id, "graphiti_build_or_ingest_failed"))

            report.outcomes.append(outcome)

        return report
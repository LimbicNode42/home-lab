#!/usr/bin/env python3
"""CLI for the memory-reconciler: ``status | query | validate | reconcile``.

Entry point name: ``graceful-memory-reconciler``.

* ``status`` — print dedup/state summary.
* ``query`` — inspect what would be extracted from the Kanban DB (read-only).
* ``validate`` — validate the config/allowlist + extract and dry-build episodes
  from a JSON fixture (or the live DB with ``--from-db``) without any writes.
* ``reconcile`` — run the pipeline. Default is dry-run; pass ``--apply`` to
  actually write mem0 + Graphiti and record state.

No ``--reconcile`` invocation touches mem0/Graphiti or the state ledger unless
``--apply`` is explicitly supplied.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import ReconcilerConfig
from .episode_builder import build_episode
from .extractor import CompletionRecord, KanbanExtractor
from .pipeline import Reconciler
from .state import DedupState


def _config(args: argparse.Namespace) -> ReconcilerConfig:
    return ReconcilerConfig(
        kanban_db=Path(args.kanban_db),
        state_db=Path(args.state_db),
        mem0_host=args.mem0_host,
        mem0_user_id=args.mem0_user_id,
        mem0_agent_id=args.mem0_agent_id,
        graphiti_base_url=args.graphiti_url,
        completion_model=args.completion_model,
        rerank_model=args.rerank_model,
        embedding_model=args.embedding_model,
        embedding_dim=args.embedding_dim,
        dry_run=True,
    )


def _emit(payload: dict) -> int:
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    state = DedupState(args.state_db)
    return _emit({"status": "ok", "state": state.stats(), "state_db": args.state_db})


def cmd_query(args: argparse.Namespace) -> int:
    extractor = KanbanExtractor(args.kanban_db)
    records = extractor.iter_done_records()
    limit = args.limit if args.limit else len(records)
    result = []
    for record in records[:limit]:
        result.append(
            {
                "task_id": record.task_id,
                "run_id": record.run_id,
                "title": record.title,
                "assignee": record.assignee,
                "completed_at": record.completed_at,
                "metadata_keys": sorted(record.metadata.keys()),
            }
        )
    return _emit({"status": "ok", "count": len(result), "results": result})


def cmd_validate(args: argparse.Namespace) -> int:
    cfg = _config(args)
    # Preflight allowlist/budget checks (fail closed).
    from . import guardrails

    try:
        guardrails.validate_model_allowlist(
            completion_model=cfg.completion_model,
            rerank_model=cfg.rerank_model,
            embedding_model=cfg.embedding_model,
            embedding_dim=cfg.embedding_dim,
        )
    except guardrails.GuardrailViolation as exc:
        return _emit({"status": "error", "reason": str(exc)})

    if args.file:
        records = _records_from_file(Path(args.file))
    elif args.from_db:
        records = KanbanExtractor(args.kanban_db).iter_done_records()
    else:
        return _emit({"status": "error", "reason": "provide --file or --from-db"})

    built = []
    errors = []
    from . import guardrails as g
    from .config import MAX_EPISODES_PER_BATCH

    # Validate a bounded slice (the per-batch budget), not the full backlog.
    sample = records[:MAX_EPISODES_PER_BATCH]
    for record in sample:
        try:
            built.append(build_episode(record))
        except Exception as exc:  # noqa: BLE001
            errors.append({"task_id": record.task_id, "error": str(exc)})

    return _emit(
        {
            "status": "ok" if not errors else "partial",
            "episodes_built": len(built),
            "episodes_failed": len(errors),
            "errors": errors,
            "sample_group_ids": sorted({ep["group_id"] for ep in built}),
        }
    )


def cmd_reconcile(args: argparse.Namespace) -> int:
    cfg = _config(args)
    cfg.dry_run = not args.apply
    report = Reconciler(cfg).reconcile(record_limit=args.limit or None)
    return _emit({"status": "ok", "report": report.as_dict()})


def _records_from_file(path: Path) -> list[CompletionRecord]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "records" in data:
        data = data["records"]
    if not isinstance(data, list):
        raise ValueError("record fixture must be a list or {'records': [...]}")
    records = []
    for item in data:
        records.append(
            CompletionRecord(
                task_id=item["task_id"],
                title=item.get("title", ""),
                assignee=item.get("assignee", ""),
                run_id=item["run_id"],
                summary=item["summary"],
                metadata=item.get("metadata", {}),
                completed_at=item.get("completed_at"),
            )
        )
    return records


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="graceful-memory-reconciler",
        description="Curated, idempotent Kanban -> mem0 + Graphiti reconciler.",
    )
    parser.add_argument("--kanban-db", default="/root/.hermes/kanban.db")
    parser.add_argument("--state-db", default="/var/lib/memory-reconciler/state.db")
    parser.add_argument("--mem0-host", default="http://127.0.0.1:8888")
    parser.add_argument("--mem0-user-id", default="ben-gremlin")
    parser.add_argument("--mem0-agent-id", default="memory-reconciler")
    parser.add_argument("--graphiti-url", default="http://127.0.0.1:8000")
    parser.add_argument("--completion-model", default="openai/gpt-4o-mini")
    parser.add_argument("--rerank-model", default="openai/gpt-4o-mini")
    parser.add_argument("--embedding-model", default="openai/text-embedding-3-small")
    parser.add_argument("--embedding-dim", type=int, default=1536)

    sub = parser.add_subparsers(dest="command", required=True)

    status = sub.add_parser("status", help="Show dedup/state ledger summary")
    status.set_defaults(func=cmd_status)

    query = sub.add_parser("query", help="List extractable done-task records (read-only)")
    query.add_argument("--limit", type=int, default=0)
    query.set_defaults(func=cmd_query)

    validate = sub.add_parser("validate", help="Validate config + build episodes without writing")
    validate.add_argument("--file")
    validate.add_argument("--from-db", action="store_true")
    validate.set_defaults(func=cmd_validate)

    reconcile = sub.add_parser("reconcile", help="Run the pipeline (dry-run unless --apply)")
    reconcile.add_argument("--apply", action="store_true", dest="apply", help="Actually write mem0 + Graphiti and record state")
    reconcile.add_argument("--limit", type=int, default=0, help="Cap the number of records processed")
    reconcile.add_argument("--once", action="store_true", dest="once", help="One-shot run (explicit; timer-driven default)")
    reconcile.set_defaults(func=cmd_reconcile)

    return parser


def from_text_to_sql(text: str) -> str:
    """Convert a curated fact phrase into a safe SELECT against state.db.

    This is a convenience/teaching helper (the ``from_text_to_sql`` CLI contract
    from the task). It only supports a curated verb->column mapping and always
    returns a read-only parameterized query — it never builds arbitrary SQL from
    untrusted text.
    """

    lowered = (text or "").lower()
    column = "ingested_at"
    if "mem0" in lowered:
        column = "target"
    elif "graphiti" in lowered:
        column = "target"
    # Always a fixed, parameterized query; caller binds the value.
    return f"SELECT source, task_id, run_id, target, ingested_at FROM ingested WHERE {column} = ? ORDER BY ingested_at DESC"


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except Exception as exc:  # noqa: BLE001 - CLI emits a safe, sanitized error
        print(
            json.dumps({"status": "error", "error": exc.__class__.__name__, "message": str(exc)}, indent=2, sort_keys=True),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
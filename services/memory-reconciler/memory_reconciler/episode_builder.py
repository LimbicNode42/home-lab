"""Build curated Graphiti episodes from completion records.

Reuses the existing ``services/graphiti/agent_graphiti`` package: it calls
``validate_episode(raw, sanitize=True)`` and ``to_graphiti_payload()``. It does
NOT write a new redactor — ``redaction.py`` + ``episode.py`` are already
reviewed and enforce the allowlist.

``source_type`` is one of ``kanban_completion_summary`` (default) or
``decision_supersession``; ``group_id`` follows the domain policy in
``services/graphiti/runbooks/curated-ingest-policy.md`` section 6.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from . import guardrails
from .extractor import CompletionRecord

# Locate the sibling Graphiti package so we can import its reviewed episode
# module without installing anything. services/graphiti is on the path so
# `agent_graphiti` resolves as a package.
_GRAPHITI_DIR = Path(__file__).resolve().parents[2] / "graphiti"
if str(_GRAPHITI_DIR) not in sys.path:
    sys.path.insert(0, str(_GRAPHITI_DIR))

from agent_graphiti.episode import (  # noqa: E402
    CuratedEpisode,
    validate_episode,
)


class EpisodeBuildError(ValueError):
    """Raised when a record cannot be turned into a policy-valid episode."""


def domain_for_record(record: CompletionRecord) -> str:
    """Map a completion record to a primary policy domain.

    Defaults to ``services`` (service lifecycle/deployment evidence) unless the
    title clearly signals a decision/supersession record, which maps to
    ``decisions``. This is a conservative default; group_id refinement happens
    in ``group_id_for_record``.
    """

    title = (record.title or "").lower()
    summary = (record.summary or "").lower()
    if any(token in f"{title} {summary}" for token in ("decision", "decided", "supersed", "chosen", "policy boundary")):
        return "decisions"
    return "services"


def group_id_for_record(record: CompletionRecord) -> str:
    """Choose a stable group_id by the section 6 domain policy.

    The reconciler cannot infer the exact service/area from every summary, so
    it falls back to a stable per-domain group. Decision-shaped records map to
    ``decisions.<area>``; everything else to ``services.memory-reconciler``
    (the reconciler's own operational boundary) plus a title-derived area
    suffix only when it maps to a known allowlisted group.
    """

    domain = domain_for_record(record)
    if domain == "decisions":
        # area = lowercased, slugified leading noun phrase; safe fallback.
        area = _slug_area(record.title) or "memory"
        return f"decisions.{area}"
    return "services.memory-reconciler"


def _slug_area(text: str) -> str:
    import re

    words = re.findall(r"[a-z0-9]+", text.lower())
    # Drop obvious non-area leading noise.
    stop = {"decision", "decisions", "supersed", "supersession", "the", "a", "an", "on", "of"}
    words = [w for w in words if w not in stop]
    return words[0] if words else ""


def build_episode(record: CompletionRecord, *, curated_by: str = "memory-reconciler") -> dict[str, Any]:
    """Build and validate a curated episode, returning the ``to_graphiti_payload`` dict."""

    source_type = "decision_supersession" if domain_for_record(record) == "decisions" else "kanban_completion_summary"
    now = _utc_now()
    raw_date = record.completed_at or now

    summary = (record.summary or "").strip()
    words = len(summary.split()) + sum(len(str(v).split()) for v in _flatten(record.metadata))
    guardrails.validate_word_count(words)

    facts: list[dict[str, Any]] = [
        {
            "text": (record.summary or "").strip() or f"Task {record.task_id} completed by {record.assignee}.",
            "confidence": "high",
            "caveat": "Curated from a Kanban completion summary; advisory operational provenance, not a live service health claim.",
            "valid_at": raw_date,
            "invalid_at": None,
            "supersedes": [],
        }
    ]

    title = (record.title or record.task_id).strip()
    raw = {
        "episode_id": f"kanban:{record.task_id}:completion",
        "title": title,
        "domain": domain_for_record(record),
        "group_id": group_id_for_record(record),
        "source_type": source_type,
        "source_ref": record.task_id,
        "source_path": None,
        "source_timestamp": raw_date,
        "curated_by": curated_by,
        "curated_at": now,
        "status": "current",
        "summary": summary,
        "facts": facts,
        "tags": ["kanban", record.assignee or "unknown"],
        "redaction": {
            "reviewed": True,
            "secret_values_removed": True,
            "private_memory_excluded": True,
        },
    }

    try:
        episode, _report = validate_episode(raw, sanitize=True)
    except ValueError as exc:
        raise EpisodeBuildError(f"episode validation failed for {record.task_id}: {exc}") from exc

    return episode.to_graphiti_payload()


def _flatten(value: Any):
    """Yield scalar leaves from nested metadata (for a coarse word count)."""

    if isinstance(value, dict):
        for item in value.values():
            yield from _flatten(item)
    elif isinstance(value, list):
        for item in value:
            yield from _flatten(item)
    else:
        yield value


def _utc_now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
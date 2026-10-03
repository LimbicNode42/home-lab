"""Classify completion records: durable mem0 facts vs skip.

Only DURABLE, high-signal facts qualify for mem0 (preferences, stable
environment facts, conventions, lasting decisions). Task-progress logs,
"shipped X" statements, PR numbers, commit SHAs, and file counts are
session_search material, not memory — those are skipped.

This module is deliberately conservative: when in doubt, skip. A false skip
costs a future re-derivation; a false write pollutes Ben's durable memory.

Session/transcript ingest is NOT implemented here (out of scope for v1 per the
curated-ingest policy section 3). ``classify_session_excerpt`` is a stub left
for a future review-gated extractor; it always returns ``skip``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .extractor import CompletionRecord

# Signal words/labels that indicate a durable, memory-worthy fact rather than
# a progress log. A match is a *prerequisite*, not a guarantee — see the
# skip-list below which overrides.
DURABLE_MARKERS = (
    "preference",
    "convention",
    "prefers",
    "policy",
    "decision",
    "decided",
    "boundary",
    "standard",
    "must always",
    "never",
    "convention is",
    "chosen",
    "adopted",
    "remediation",
    "established",
)

# Explicit skip signals. If any of these dominate the summary, it is a progress
# log or an artifact-bearing report, not durable memory.
SKIP_MARKERS = (
    "shipped",
    "deployed",
    "merged",
    "pushed",
    "committed",
    "commit ",
    "implemented",
    "fixed bug",
    "fixed the",
    "test passed",
    "tests pass",
    "closed the",
    "completed the",
    "verified that",
    "already reconciled",
    "no new code",
    "no-op",
    "superseded",
    "resolved the",
)

# Artifact-shaped tokens never belong in durable memory (memory-tool guidance:
# PR numbers, commit SHAs, file counts).
_ARTIFACT_PATTERNS = (
    re.compile(r"\bPR\s*#?\d+\b", re.IGNORECASE),
    re.compile(r"\b#[0-9a-f]{7,40}\b", re.IGNORECASE),  # commit SHAs
    re.compile(r"\b\d+\s*/\s*\d+\s*(tests?|files?|checks?)\b", re.IGNORECASE),
)


@dataclass
class Classification:
    mem0_writable: bool
    reason: str


def classify_for_mem0(record: CompletionRecord) -> Classification:
    """Decide whether ``record.summary`` yields a durable mem0 fact."""

    summary = record.summary or ""

    # Hard reject: artifact-shaped content.
    for pattern in _ARTIFACT_PATTERNS:
        if pattern.search(summary):
            return Classification(False, "artifact_shaped_progress")

    # Hard reject: dominated by skip markers.
    lowered = summary.lower()
    if any(marker in lowered for marker in SKIP_MARKERS):
        return Classification(False, "task_progress_log")

    # Positive signal required: durable marker present.
    if any(marker in lowered for marker in DURABLE_MARKERS):
        return Classification(True, "durable_fact")

    return Classification(False, "low_signal")


def mem0_fact_text(record: CompletionRecord) -> str:
    """Emit a declarative mem0 fact from a durable summary.

    The produced text is declarative (a fact about how things are), not an
    instruction, matching Hermes memory guidance. It is intentionally the
    (already non-secret) summary itself, lightly normalized so the classifier
    gate — not this function — is the quality bar.
    """

    text = (record.summary or "").strip()
    # Collapse whitespace and strip a trailing period for cleaner facts.
    text = re.sub(r"\s+", " ", text).strip()
    return text.rstrip(".")


class SessionExcerptClassifier:
    """Stub for a future review-gated session extractor (out of scope v1)."""

    # TODO(review-gated): implement a session/transcript classifier under the
    # curated-ingest policy section 3 expansion gate. Until then, every excerpt
    # is skipped so no raw transcript enters mem0 or Graphiti.
    def classify_session_excerpt(self, excerpt: str) -> Classification:
        return Classification(False, "session_ingest_out_of_scope")


# Convenience alias used by the pipeline.
SESSION_CLASSIFIER = SessionExcerptClassifier()
"""Fail-closed guardrails reused by the pipeline and the dual-writers.

These enforce the curated-ingest-policy budgets (section 8) and the OpenRouter
model/embedding allowlist. Every check raises on mismatch rather than degrading
silently, so a misconfigured run stops instead of spending money or leaking.
"""

from __future__ import annotations

from . import config as cfg


class GuardrailViolation(ValueError):
    """Raised when a boundary or allowlist check fails."""


def validate_model_allowlist(
    *,
    base_url: str = cfg.ALLOWED_OPENROUTER_BASE_URL,
    completion_model: str,
    rerank_model: str,
    embedding_model: str,
    embedding_dim: int,
) -> None:
    """Fail closed if any model/dimension differs from the allowlist.

    The error message names the offending field but never any credential.
    """
    if base_url.rstrip("/") != cfg.ALLOWED_OPENROUTER_BASE_URL.rstrip("/"):
        raise GuardrailViolation(f"openrouter base_url {base_url!r} is not allowlisted")
    if completion_model != cfg.ALLOWED_COMPLETION_MODEL:
        raise GuardrailViolation(f"completion model {completion_model!r} is not allowlisted")
    if rerank_model != cfg.ALLOWED_RERANK_MODEL:
        raise GuardrailViolation(f"rerank model {rerank_model!r} is not allowlisted")
    if embedding_model != cfg.ALLOWED_EMBEDDING_MODEL:
        raise GuardrailViolation(f"embedding model {embedding_model!r} is not allowlisted")
    if embedding_dim != cfg.ALLOWED_EMBEDDING_DIM:
        raise GuardrailViolation(f"embedding dimension {embedding_dim} is not allowlisted ({cfg.ALLOWED_EMBEDDING_DIM} required)")


def validate_batch_size(count: int) -> None:
    if count > cfg.MAX_EPISODES_PER_BATCH:
        raise GuardrailViolation(
            f"batch of {count} exceeds {cfg.MAX_EPISODES_PER_BATCH} episode policy limit"
        )


def validate_word_count(words: int) -> None:
    if words > cfg.MAX_WORDS_PER_EPISODE:
        raise GuardrailViolation(
            f"episode summary/facts of {words} words exceeds {cfg.MAX_WORDS_PER_EPISODE} policy limit"
        )
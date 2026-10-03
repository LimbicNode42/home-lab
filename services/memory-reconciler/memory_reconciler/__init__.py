"""memory-reconciler — curated, idempotent dual-write of completed Kanban tasks.

Turns *done* Kanban tasks into (a) durable mem0 facts and (b) curated Graphiti
episodes, reusing the existing ``services/graphiti/agent_graphiti`` package for
redaction + episode validation. This package is non-secret code only: every
credential is a Vaultwarden folder/item/field reference, never a value.

v1 scope is allowlist-first and read-only over ``/root/.hermes/kanban.db``.
Session/transcript ingest is deliberately OUT OF SCOPE (curated-ingest policy
section 3) and left behind a stubbed classifier for a future review-gated
extractor.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
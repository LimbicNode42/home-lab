"""Non-secret runtime configuration for the memory-reconciler.

Every value here is either a literal non-secret default or a pointer to a value
held in Vaultwarden (folder/item/field). No keys, tokens, or passwords live in
this module or in committed files. See ``config/vaultwarden-map.example.yml``
for the full reference map and ``.env.example`` for the rendered runtime shape.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# --- Paths ---------------------------------------------------------------
# Canonical Kanban DB (read-only source of truth for v1).
DEFAULT_KANBAN_DB = os.environ.get("MEMORY_RECONCILER_KANBAN_DB", "/root/.hermes/kanban.db")

# Dedup/idempotency state is tori-local disk, never NAS/NFS.
DEFAULT_STATE_DB = os.environ.get("MEMORY_RECONCILER_STATE_DB", "/var/lib/memory-reconciler/state.db")

# --- Graphiti model allowlist (curated-ingest-policy section 8.1) --------
# Any mismatch against these MUST fail closed.
ALLOWED_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
ALLOWED_COMPLETION_MODEL = "openai/gpt-4o-mini"
ALLOWED_RERANK_MODEL = "openai/gpt-4o-mini"
ALLOWED_EMBEDDING_MODEL = "openai/text-embedding-3-small"
ALLOWED_EMBEDDING_DIM = 1536

# --- Budgets (curated-ingest-policy section 8.3) --------------------------
MAX_EPISODES_PER_BATCH = 25
MAX_WORDS_PER_EPISODE = 1500
MAX_EXTRACTION_ATTEMPTS = 2  # then move to a "review" bucket, no retry storm

# --- mem0 write-shape defaults -------------------------------------------
DEFAULT_MEM0_HOST = os.environ.get("MEMORY_RECONCILER_MEM0_HOST", "http://127.0.0.1:8888")
DEFAULT_MEM0_USER_ID = os.environ.get("MEMORY_RECONCILER_MEM0_USER_ID", "ben-gremlin")
DEFAULT_MEM0_AGENT_ID = os.environ.get("MEMORY_RECONCILER_MEM0_AGENT_ID", "memory-reconciler")

# --- Graphiti API (loopback-only target, no public route) -----------------
DEFAULT_GRAPHITI_BASE_URL = os.environ.get("MEMORY_RECONCILER_GRAPHITI_URL", "http://127.0.0.1:8000")


@dataclass
class ReconcilerConfig:
    """Resolved, non-secret configuration. Secrets stay in the environment."""

    kanban_db: Path = field(default_factory=lambda: Path(DEFAULT_KANBAN_DB))
    state_db: Path = field(default_factory=lambda: Path(DEFAULT_STATE_DB))

    mem0_host: str = DEFAULT_MEM0_HOST
    mem0_user_id: str = DEFAULT_MEM0_USER_ID
    mem0_agent_id: str = DEFAULT_MEM0_AGENT_ID
    # The mem0 API key is read from the environment only, never defaulted and
    # never stored in this object's repr.
    mem0_api_key: str = field(default_factory=lambda: os.environ.get("MEM0_API_KEY", ""))

    graphiti_base_url: str = DEFAULT_GRAPHITI_BASE_URL
    graphiti_api_key: str = field(default_factory=lambda: os.environ.get("GRAPHITI_OPENROUTER_API_KEY", ""))
    completion_model: str = ALLOWED_COMPLETION_MODEL
    rerank_model: str = ALLOWED_RERANK_MODEL
    embedding_model: str = ALLOWED_EMBEDDING_MODEL
    embedding_dim: int = ALLOWED_EMBEDDING_DIM

    dry_run: bool = True

    def __repr__(self) -> str:  # never leak key material into logs/repl
        return (
            "ReconcilerConfig(kanban_db={!r}, state_db={!r}, mem0_host={!r}, "
            "mem0_user_id={!r}, mem0_agent_id={!r}, graphiti_base_url={!r}, "
            "completion_model={!r}, embedding_model={!r}, embedding_dim={!r}, dry_run={!r})"
        ).format(
            self.kanban_db,
            self.state_db,
            self.mem0_host,
            self.mem0_user_id,
            self.mem0_agent_id,
            self.graphiti_base_url,
            self.completion_model,
            self.embedding_model,
            self.embedding_dim,
            self.dry_run,
        )
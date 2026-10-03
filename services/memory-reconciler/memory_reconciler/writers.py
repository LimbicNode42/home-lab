"""Dual-writers: mem0 HTTP and Graphiti ingest.

Both writers are thin, fail-fast adapters over external services. They never
log credentials and accept only already-curated, already-validated payloads.

* ``Mem0Writer`` posts ``POST /memories`` to the self-hosted mem0 server with an
  ``X-API-Key`` header read strictly from the environment.
* ``GraphitiWriter`` reuses ``agent_graphiti.client.GraphitiReadOnlyClient`` for
  its ``ingest_episode`` path (the only mutation that curated wrapper permits).

Both honor ``dry_run`` and do NOT perform a network side effect in that mode.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from . import config as cfg
from . import guardrails


class WriterError(RuntimeError):
    """Raised when a downstream write fails; the message is non-secret."""


class Mem0Writer:
    """Thin adapter for the self-hosted mem0 HTTP API (write path only)."""

    def __init__(
        self,
        *,
        host: str = cfg.DEFAULT_MEM0_HOST,
        api_key: str | None = None,
        user_id: str = cfg.DEFAULT_MEM0_USER_ID,
        agent_id: str = cfg.DEFAULT_MEM0_AGENT_ID,
        dry_run: bool = True,
        opener: Any = None,
    ) -> None:
        self.host = host.rstrip("/")
        self.api_key = api_key if api_key is not None else cfg.ReconcilerConfig().mem0_api_key
        self.user_id = user_id
        self.agent_id = agent_id
        self.dry_run = dry_run
        self._opener = opener or (lambda req, timeout: urllib.request.urlopen(req, timeout=timeout))

    def _require_key(self) -> None:
        if not self.api_key:
            raise WriterError("mem0 API key is missing (set MEM0_API_KEY in the runtime environment)")

    def add_fact(self, text: str) -> dict[str, Any]:
        """Post one declarative fact to mem0 (``POST /memories``)."""

        if self.dry_run:
            return {"status": "dry_run", "target": "mem0", "skipped": True}

        self._require_key()
        body = json.dumps(
            {
                "messages": [{"role": "user", "content": text}],
                "user_id": self.user_id,
                "agent_id": self.agent_id,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            self.host + "/memories",
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-API-Key": self.api_key,
                "Accept": "application/json",
            },
        )
        try:
            with self._opener(req, 30.0) as response:
                payload = response.read().decode("utf-8")
        except (TimeoutError, OSError, urllib.error.URLError, urllib.error.HTTPError) as exc:
            raise WriterError("mem0 write unavailable") from exc
        try:
            decoded = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise WriterError("mem0 returned invalid JSON") from exc
        return {"status": "ok", "target": "mem0", "upstream": _non_secret_summary(decoded)}


class GraphitiWriter:
    """Reuse the reviewed Graphiti read-only client for curated ingest."""

    def __init__(
        self,
        *,
        base_url: str = cfg.DEFAULT_GRAPHITI_BASE_URL,
        dry_run: bool = True,
        client: Any = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.dry_run = dry_run
        self._client = client

    def _make_client(self) -> Any:
        if self._client is not None:
            return self._client
        # Import lazily so the module stays importable without the sibling
        # package on the path (tests inject a fake client instead).
        import os
        import sys
        from pathlib import Path

        agent_dir = Path(__file__).resolve().parents[2] / "graphiti"
        if str(agent_dir) not in sys.path:
            sys.path.insert(0, str(agent_dir))
        from agent_graphiti.client import GraphitiReadOnlyClient

        return GraphitiReadOnlyClient(self.base_url)

    def ingest(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self.dry_run:
            return {"status": "dry_run", "target": "graphiti", "skipped": True}

        client = self._make_client()
        try:
            upstream = client.ingest_episode(payload)
        except Exception as exc:  # noqa: BLE001 - normalize to non-secret WriterError
            raise WriterError("graphiti ingest failed") from exc
        return {"status": "ok", "target": "graphiti", "upstream": upstream}


def _non_secret_summary(value: Any) -> dict[str, Any]:
    """Reduce an upstream dict to non-secret scalar-ish fields."""

    if not isinstance(value, dict):
        return {"shape": type(value).__name__}
    safe: dict[str, Any] = {}
    for key, item in value.items():
        if isinstance(item, (str, int, float, bool)) or item is None:
            safe[key] = item
    return safe
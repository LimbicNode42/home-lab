"""Read-only Graphiti client and provenance-safe result normalization."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from typing import Any, Callable

MUTATION_WORDS = ("clear", "delete", "drop", "write", "cypher", "admin", "truncate", "remove")
SAFE_GROUP_CHARS = re.compile(r"[^A-Za-z0-9_-]")


class GraphitiUnavailable(RuntimeError):
    """Graphiti or the wrapper target is unavailable."""


@dataclass
class GraphitiQueryResult:
    fact: str
    source_episode: str | None
    source_ref: str | None
    source_timestamp: str | None
    valid_at: str | None
    invalid_at: str | None
    confidence: str
    caveat: str | None
    group: str | None
    domain: str | None
    status: str = "ok"

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class GraphitiReadOnlyClient:
    """Small wrapper around the raw Graphiti API with no mutation surface.

    The only outbound upstream operations are:
    - GET health/status endpoints
    - POST one configured search endpoint
    - POST one configured add-episode endpoint for curated ingest when explicitly used

    Agent query consumers should use ``search_facts`` only. Curated ingest uses
    ``ingest_episode`` from the dedicated ingest CLI after policy validation.
    """

    def __init__(
        self,
        base_url: str,
        *,
        search_path: str = "/search",
        health_path: str = "/healthcheck",
        ingest_path: str = "/episodes",
        timeout_seconds: float = 8.0,
        opener: Callable[[urllib.request.Request, float], Any] | None = None,
    ) -> None:
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("base_url must be an http(s) URL")
        self.base_url = base_url.rstrip("/")
        self.search_path = self._safe_path(search_path, allow_ingest=False)
        self.health_path = self._safe_path(health_path, allow_ingest=False)
        self.ingest_path = self._safe_path(ingest_path, allow_ingest=True)
        self.timeout_seconds = timeout_seconds
        self._opener = opener or (lambda req, timeout: urllib.request.urlopen(req, timeout=timeout))

    @staticmethod
    def _safe_path(path: str, *, allow_ingest: bool) -> str:
        if not isinstance(path, str) or not path.startswith("/"):
            raise ValueError("API paths must start with '/'")
        lower = path.lower()
        forbidden = MUTATION_WORDS if not allow_ingest else tuple(word for word in MUTATION_WORDS if word not in {"write"})
        if any(word in lower for word in forbidden):
            raise ValueError(f"unsafe Graphiti path is not allowed: {path}")
        return path

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        if method not in {"GET", "POST"}:
            raise ValueError("only GET and POST are allowed")
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with self._opener(req, self.timeout_seconds) as response:
                payload = response.read().decode("utf-8")
        except (TimeoutError, OSError, urllib.error.URLError, urllib.error.HTTPError) as exc:
            raise GraphitiUnavailable("graph_unavailable") from exc
        if not payload.strip():
            return {}
        try:
            decoded = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise GraphitiUnavailable("graphiti_invalid_json") from exc
        if not isinstance(decoded, dict):
            raise GraphitiUnavailable("graphiti_unexpected_response")
        return decoded

    def status(self) -> dict[str, Any]:
        try:
            payload = self._request("GET", self.health_path)
        except GraphitiUnavailable:
            return {"status": "graph_unavailable", "available": False}
        return {"status": "ok", "available": True, "upstream": _strip_raw(payload)}

    def search_facts(self, query: str, *, group_id: str | None = None, limit: int = 5) -> dict[str, Any]:
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query must be a non-empty string")
        if any(word in query.lower() for word in MUTATION_WORDS):
            raise ValueError("mutation-shaped query text is not accepted by the agent wrapper")
        if limit < 1 or limit > 25:
            raise ValueError("limit must be between 1 and 25")
        body: dict[str, Any] = {"query": query, "max_facts": limit}
        if group_id:
            body["group_ids"] = [_wire_group_id(group_id)]
        try:
            payload = self._request("POST", self.search_path, body)
        except GraphitiUnavailable:
            return {"status": "graph_unavailable", "results": [], "caveat": "Graphiti is unavailable; use mem0/session/source-of-truth/live inspection instead."}
        return {"status": "ok", "results": [item.as_dict() for item in normalize_results(payload, fallback_group=group_id)]}

    def ingest_episode(self, graphiti_payload: dict[str, Any]) -> dict[str, Any]:
        """Send one already-validated curated episode to Graphiti.

        This method is intentionally separate from the query path and never used
        by the agent-facing search CLI unless the operator invokes ``ingest``.
        """

        payload = dict(graphiti_payload)
        if isinstance(payload.get("group_id"), str):
            payload["group_id"] = _wire_group_id(payload["group_id"])
        return _strip_raw(self._request("POST", self.ingest_path, payload))


def _wire_group_id(group_id: str) -> str:
    """Map policy group ids to Graphiti's restricted upstream charset.

    The curated policy uses dotted domain groups such as ``services.graphiti``;
    graphiti-core accepts only alphanumerics, dashes, and underscores.  Keep the
    human-facing contract dotted, but send a deterministic upstream-safe group.
    """

    return SAFE_GROUP_CHARS.sub("_", group_id)


def _strip_raw(payload: dict[str, Any]) -> dict[str, Any]:
    """Return non-secret scalar-ish status fields, not raw graph dumps."""

    safe: dict[str, Any] = {}
    for key, value in payload.items():
        if key.lower() in {"nodes", "edges", "graph", "episodes", "facts", "results", "headers"}:
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            safe[key] = value
    return safe


def normalize_results(payload: dict[str, Any], *, fallback_group: str | None = None) -> list[GraphitiQueryResult]:
    raw_results = payload.get("results", payload.get("facts", payload.get("edges", [])))
    if isinstance(raw_results, dict):
        raw_results = [raw_results]
    if not isinstance(raw_results, list):
        raw_results = []
    normalized: list[GraphitiQueryResult] = []
    for raw in raw_results:
        if not isinstance(raw, dict):
            continue
        fact = raw.get("fact") or raw.get("text") or raw.get("name") or raw.get("content")
        if not isinstance(fact, str) or not fact.strip():
            continue
        group = raw.get("group_id") or raw.get("group") or fallback_group
        domain = raw.get("domain")
        if not domain and isinstance(group, str) and "." in group:
            domain = group.split(".", 1)[0]
        source_episode = raw.get("source_episode") or raw.get("episode") or raw.get("source") or raw.get("source_episode_name")
        source_ref = raw.get("source_ref") or raw.get("source_reference") or raw.get("source_path")
        source_timestamp = raw.get("source_timestamp") or raw.get("created_at") or raw.get("reference_time")
        valid_at = raw.get("valid_at") or raw.get("validAt")
        invalid_at = raw.get("invalid_at") or raw.get("invalidAt")
        confidence = raw.get("confidence", "unknown")
        if confidence not in {"low", "medium", "high", "unknown"}:
            confidence = "unknown"
        caveat = raw.get("caveat")
        if invalid_at and not caveat:
            caveat = "Fact has invalid_at; temporal invalidation is advisory until reviewed."
        normalized.append(
            GraphitiQueryResult(
                fact=fact,
                source_episode=source_episode if isinstance(source_episode, str) else None,
                source_ref=source_ref if isinstance(source_ref, str) else None,
                source_timestamp=source_timestamp if isinstance(source_timestamp, str) else None,
                valid_at=valid_at if isinstance(valid_at, str) else None,
                invalid_at=invalid_at if isinstance(invalid_at, str) else None,
                confidence=confidence,
                caveat=caveat if isinstance(caveat, str) else None,
                group=group if isinstance(group, str) else None,
                domain=domain if isinstance(domain, str) else None,
            )
        )
    return normalized

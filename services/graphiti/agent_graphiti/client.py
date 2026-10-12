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

    def _request_any(self, method: str, path: str) -> Any:
        """Like ``_request`` but tolerate list responses (used by /episodes/{id})."""

        if method != "GET":
            raise ValueError("only GET is allowed for _request_any")
        req = urllib.request.Request(
            self.base_url + path,
            method=method,
            headers={"Accept": "application/json"},
        )
        try:
            with self._opener(req, self.timeout_seconds) as response:
                payload = response.read().decode("utf-8")
        except (TimeoutError, OSError, urllib.error.URLError, urllib.error.HTTPError) as exc:
            raise GraphitiUnavailable("graph_unavailable") from exc
        if not payload.strip():
            return []
        try:
            return json.loads(payload)
        except json.JSONDecodeError as exc:
            raise GraphitiUnavailable("graphiti_invalid_json") from exc

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
        # The raw /search response carries episode UUIDs but no group_id or
        # source metadata, so resolve episode provenance from the group listing
        # endpoint when the query is group-scoped.
        episodes_by_uuid: dict[str, dict[str, Any]] = {}
        if group_id:
            episodes_by_uuid = self._list_group_episodes(group_id)
        return {"status": "ok", "results": [item.as_dict() for item in normalize_results(payload, fallback_group=group_id, episodes_by_uuid=episodes_by_uuid)]}

    def _list_group_episodes(self, group_id: str, last_n: int = 50) -> dict[str, dict[str, Any]]:
        """Return {episode_uuid: episode_payload} for a policy (dotted) group id.

        The read-only retrieve surface is keyed by group, so this is the way the
        wrapper recovers per-episode provenance (name, source_description,
        group_id) that the /search endpoint does not echo back.
        """

        wire = _wire_group_id(group_id)
        path = f"{self.ingest_path}/{urllib.parse.quote(wire)}?last_n={last_n}"
        try:
            payload = self._request_any("GET", path)
        except GraphitiUnavailable:
            return {}
        if not isinstance(payload, list):
            return {}
        out: dict[str, dict[str, Any]] = {}
        for ep in payload:
            if isinstance(ep, dict) and isinstance(ep.get("uuid"), str):
                out[ep["uuid"]] = ep
        return out

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


def normalize_results(
    payload: dict[str, Any],
    *,
    fallback_group: str | None = None,
    episodes_by_uuid: dict[str, dict[str, Any]] | None = None,
) -> list[GraphitiQueryResult]:
    """Map the live /search response into provenance-safe results.

    The live endpoint emits ``facts`` (not ``results``) whose records carry
    ``uuid``, ``name``, ``fact``, ``valid_at``, ``invalid_at``, ``created_at``,
    ``expired_at``, ``source_node_uuid``, ``target_node_uuid``, and ``episodes``
    (a list of episode UUIDs). It does NOT echo ``group_id``, ``source_ref``,
    ``source_episode``, or ``confidence``. Those come from the episode objects
    reachable via ``GET /episodes/{group_id}``, keyed by UUID in
    ``episodes_by_uuid``, with ``fallback_group`` (the query's policy group id)
    as the last-resort group.
    """

    raw_results = payload.get("results", payload.get("facts", payload.get("edges", [])))
    if isinstance(raw_results, dict):
        raw_results = [raw_results]
    if not isinstance(raw_results, list):
        raw_results = []
    episodes_by_uuid = episodes_by_uuid or {}
    normalized: list[GraphitiQueryResult] = []
    for raw in raw_results:
        if not isinstance(raw, dict):
            continue
        fact = raw.get("fact") or raw.get("text") or raw.get("name") or raw.get("content")
        if not isinstance(fact, str) or not fact.strip():
            continue
        episode = _resolve_episode(raw.get("episodes"), episodes_by_uuid)
        # Prefer fallback_group (the dotted policy id the agent asked for) over
        # the episode's stored group_id, which is the wire-safe underscore form.
        group = (
            raw.get("group_id")
            or raw.get("group")
            or fallback_group
            or (episode.get("group_id") if isinstance(episode, dict) else None)
        )
        domain = raw.get("domain")
        if not domain and isinstance(group, str) and "." in group:
            domain = group.split(".", 1)[0]
        source_episode = (
            raw.get("source_episode")
            or raw.get("episode")
            or raw.get("source")
            or raw.get("source_episode_name")
            or (episode.get("name") if isinstance(episode, dict) else None)
        )
        source_ref = (
            raw.get("source_ref")
            or raw.get("source_reference")
            or raw.get("source_path")
            or (episode.get("source_description") if isinstance(episode, dict) else None)
        )
        source_timestamp = raw.get("source_timestamp") or raw.get("created_at") or raw.get("reference_time")
        valid_at = raw.get("valid_at") or raw.get("validAt") or (episode.get("valid_at") if isinstance(episode, dict) else None)
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


def _resolve_episode(episode_refs: Any, episodes_by_uuid: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """Return the first episode object whose uuid matches any of ``episode_refs``."""

    if not isinstance(episode_refs, list):
        return None
    for ref in episode_refs:
        if isinstance(ref, str) and ref in episodes_by_uuid:
            return episodes_by_uuid[ref]
        if isinstance(ref, dict) and ref.get("uuid") in episodes_by_uuid:
            return episodes_by_uuid[ref["uuid"]]
    return None

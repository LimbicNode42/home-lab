"""Curated episode contract enforcement for Graphiti ingest."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

from .redaction import RedactionFailure, sanitize_text, validate_no_secret_material

ALLOWED_SOURCE_TYPES = {
    "kanban_completion_summary",
    "deployment_summary",
    "incident_summary",
    "service_inventory_snapshot",
    "dependency_ownership_note",
    "decision_supersession",
}

ALLOWED_STATUS = {"current", "historical", "superseded", "uncertain"}
ALLOWED_CONFIDENCE = {"low", "medium", "high", "unknown"}
ALLOWED_DOMAINS = {"homelab", "agents", "services", "incidents", "decisions"}


@dataclass
class EpisodeFact:
    text: str
    confidence: str = "unknown"
    caveat: str | None = None
    valid_at: str | None = None
    invalid_at: str | None = None
    supersedes: list[str] = field(default_factory=list)


@dataclass
class CuratedEpisode:
    episode_id: str
    title: str
    domain: str
    group_id: str
    source_type: str
    source_ref: str
    source_path: str | None
    source_timestamp: str | None
    curated_by: str
    curated_at: str
    status: str
    summary: str
    facts: list[EpisodeFact]
    tags: list[str] = field(default_factory=list)
    redaction: dict[str, Any] = field(default_factory=dict)

    def to_graphiti_payload(self) -> dict[str, Any]:
        """Map the curated contract to a conservative Graphiti add-episode payload."""

        # Keep provenance in episode_body because Graphiti derives facts from text.
        # Do not include raw source content; these are already curated facts.
        facts = "\n".join(f"- {fact.text}" for fact in self.facts)
        body = (
            f"Title: {self.title}\n"
            f"Domain: {self.domain}\n"
            f"Group: {self.group_id}\n"
            f"Source: {self.source_ref}\n"
            f"Source timestamp: {self.source_timestamp or 'unknown'}\n"
            f"Status: {self.status}\n"
            f"Summary: {self.summary}\n"
            f"Facts:\n{facts}\n"
        )
        return {
            "name": self.episode_id,
            "episode_body": body,
            "source": "text",
            "source_description": self.source_ref,
            "group_id": self.group_id,
            "reference_time": self.source_timestamp or self.curated_at,
        }

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _require_string(obj: dict[str, Any], field_name: str, *, allow_empty: bool = False) -> str:
    value = obj.get(field_name)
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ValueError(f"{field_name} must be a non-empty string")
    return value


def _validate_iso8601(value: str | None, field_name: str) -> None:
    if value is None:
        return
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be ISO-8601 string or null")
    candidate = value.replace("Z", "+00:00")
    try:
        datetime.fromisoformat(candidate)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be ISO-8601: {value}") from exc


def validate_episode(raw: dict[str, Any], *, sanitize: bool = True) -> tuple[CuratedEpisode, dict[str, int]]:
    """Validate and optionally sanitize a curated episode object."""

    if not isinstance(raw, dict):
        raise ValueError("episode must be an object")
    raw = dict(raw)
    source_type = _require_string(raw, "source_type")
    if source_type not in ALLOWED_SOURCE_TYPES:
        raise ValueError(f"source_type {source_type!r} is not allowlisted")
    domain = _require_string(raw, "domain")
    if domain not in ALLOWED_DOMAINS:
        raise ValueError(f"domain {domain!r} is not allowlisted")
    status = _require_string(raw, "status")
    if status not in ALLOWED_STATUS:
        raise ValueError(f"status {status!r} is not valid")
    group_id = _require_string(raw, "group_id")
    if not group_id.startswith(f"{domain}."):
        raise ValueError("group_id must start with '<domain>.'")
    facts_raw = raw.get("facts")
    if not isinstance(facts_raw, list) or not facts_raw:
        raise ValueError("facts must be a non-empty list")

    report_counts = {"total": 0}
    text_fields = ["episode_id", "title", "source_ref", "summary", "curated_by"]
    for key in text_fields:
        _require_string(raw, key)
        if sanitize:
            raw[key], report = sanitize_text(raw[key])
            report_counts["total"] += report.total

    for key in ("source_path", "source_timestamp", "curated_at"):
        if key not in raw:
            raise ValueError(f"{key} is required")
    _validate_iso8601(raw.get("source_timestamp"), "source_timestamp")
    _validate_iso8601(raw.get("curated_at"), "curated_at")

    facts: list[EpisodeFact] = []
    for index, fact_raw in enumerate(facts_raw):
        if not isinstance(fact_raw, dict):
            raise ValueError(f"facts[{index}] must be an object")
        text = _require_string(fact_raw, "text")
        caveat = fact_raw.get("caveat")
        if caveat is not None and not isinstance(caveat, str):
            raise ValueError(f"facts[{index}].caveat must be string or null")
        if sanitize:
            text, report = sanitize_text(text)
            report_counts["total"] += report.total
            if caveat:
                caveat, report = sanitize_text(caveat)
                report_counts["total"] += report.total
        confidence = fact_raw.get("confidence", "unknown")
        if confidence not in ALLOWED_CONFIDENCE:
            raise ValueError(f"facts[{index}].confidence {confidence!r} is not valid")
        _validate_iso8601(fact_raw.get("valid_at"), f"facts[{index}].valid_at")
        _validate_iso8601(fact_raw.get("invalid_at"), f"facts[{index}].invalid_at")
        supersedes = fact_raw.get("supersedes", [])
        if not isinstance(supersedes, list) or not all(isinstance(item, str) for item in supersedes):
            raise ValueError(f"facts[{index}].supersedes must be a list of strings")
        facts.append(
            EpisodeFact(
                text=text,
                confidence=confidence,
                caveat=caveat,
                valid_at=fact_raw.get("valid_at"),
                invalid_at=fact_raw.get("invalid_at"),
                supersedes=supersedes,
            )
        )

    tags = raw.get("tags", [])
    if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
        raise ValueError("tags must be a list of strings")
    redaction = raw.get("redaction", {})
    if not isinstance(redaction, dict):
        raise ValueError("redaction must be an object")
    if redaction.get("reviewed") is not True:
        raise RedactionFailure("redaction.reviewed must be true before ingest")
    if redaction.get("secret_values_removed") is not True:
        raise RedactionFailure("redaction.secret_values_removed must be true before ingest")
    if redaction.get("private_memory_excluded") is not True:
        raise RedactionFailure("redaction.private_memory_excluded must be true before ingest")

    episode = CuratedEpisode(
        episode_id=raw["episode_id"],
        title=raw["title"],
        domain=domain,
        group_id=group_id,
        source_type=source_type,
        source_ref=raw["source_ref"],
        source_path=raw.get("source_path"),
        source_timestamp=raw.get("source_timestamp"),
        curated_by=raw["curated_by"],
        curated_at=raw["curated_at"],
        status=status,
        summary=raw["summary"],
        facts=facts,
        tags=tags,
        redaction=redaction,
    )
    validate_no_secret_material(episode.as_dict())
    if len(episode.summary.split()) > 1500:
        raise ValueError("summary exceeds 1,500 word policy limit")
    return episode, report_counts


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")

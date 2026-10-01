"""Safe agent-facing Graphiti helpers.

This package deliberately exposes only curated ingest and read-only query paths.
It is not a Hermes memory provider and it does not replace mem0.
"""

from .client import GraphitiQueryResult, GraphitiReadOnlyClient, GraphitiUnavailable
from .episode import CuratedEpisode, EpisodeFact, validate_episode
from .redaction import RedactionFailure, sanitize_text, validate_no_secret_material

__all__ = [
    "CuratedEpisode",
    "EpisodeFact",
    "GraphitiQueryResult",
    "GraphitiReadOnlyClient",
    "GraphitiUnavailable",
    "RedactionFailure",
    "sanitize_text",
    "validate_episode",
    "validate_no_secret_material",
]

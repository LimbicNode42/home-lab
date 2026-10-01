"""Conservative sanitization for curated Graphiti episodes and query output."""

from __future__ import annotations

import re
from dataclasses import dataclass


class RedactionFailure(ValueError):
    """Raised when content still looks unsafe after sanitization."""


@dataclass(frozen=True)
class RedactionReport:
    secret_values_removed: int = 0
    private_keys_removed: int = 0
    credential_urls_removed: int = 0
    env_assignment_removed: int = 0
    contact_values_removed: int = 0

    @property
    def total(self) -> int:
        return (
            self.secret_values_removed
            + self.private_keys_removed
            + self.credential_urls_removed
            + self.env_assignment_removed
            + self.contact_values_removed
        )

    def as_dict(self) -> dict[str, int]:
        return {
            "secret_values_removed": self.secret_values_removed,
            "private_keys_removed": self.private_keys_removed,
            "credential_urls_removed": self.credential_urls_removed,
            "env_assignment_removed": self.env_assignment_removed,
            "contact_values_removed": self.contact_values_removed,
            "total": self.total,
        }


PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    re.DOTALL,
)
CRED_URL_RE = re.compile(r"\b([a-z][a-z0-9+.-]*://)([^\s/@:]+):([^\s/@]+)@", re.IGNORECASE)
ENV_SECRET_RE = re.compile(
    r"(?im)^\s*([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|COOKIE|SESSION|CLIENTSECRET|DATABASE_URL)[A-Z0-9_]*)\s*=\s*([^\n#]+)"
)
HEADER_SECRET_RE = re.compile(
    r"(?i)\b(authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie)\b\s*[:=]\s*([^\s,;]+)"
)
LONG_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z0-9_\-]{32,}(?![A-Za-z0-9])")
EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
RAW_ENV_HINT_RE = re.compile(r"(?im)^\s*(OPENROUTER_API_KEY|NEO4J_PASSWORD|BW_SESSION|BW_CLIENTSECRET|BW_CLIENTID)\s*=")


def sanitize_text(text: str) -> tuple[str, RedactionReport]:
    """Return redacted text and non-secret counts.

    The sanitizer is intentionally blunt. Curated ingest should be summaries,
    not raw logs, so false positives are cheaper than accidentally preserving a
    token-shaped goblin.
    """

    report = RedactionReport()
    sanitized = text

    sanitized, n_private = PRIVATE_KEY_RE.subn("[REDACTED_PRIVATE_KEY]", sanitized)
    sanitized, n_url = CRED_URL_RE.subn(r"\1[REDACTED_CREDENTIAL]@", sanitized)
    sanitized, n_env = ENV_SECRET_RE.subn(lambda m: f"{m.group(1)}=[REDACTED_SECRET]", sanitized)
    sanitized, n_header = HEADER_SECRET_RE.subn(lambda m: f"{m.group(1)}=[REDACTED_SECRET]", sanitized)
    sanitized, n_token = LONG_TOKEN_RE.subn("[REDACTED_SECRET]", sanitized)
    sanitized, n_email = EMAIL_RE.subn("[REDACTED_CONTACT]", sanitized)

    report = RedactionReport(
        secret_values_removed=n_header + n_token,
        private_keys_removed=n_private,
        credential_urls_removed=n_url,
        env_assignment_removed=n_env,
        contact_values_removed=n_email,
    )
    return sanitized, report


def validate_no_secret_material(value: object, *, path: str = "episode") -> None:
    """Fail closed if obvious credential material remains in a nested object."""

    if isinstance(value, dict):
        for key, child in value.items():
            validate_no_secret_material(child, path=f"{path}.{key}")
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            validate_no_secret_material(child, path=f"{path}[{index}]")
        return
    if value is None or isinstance(value, (bool, int, float)):
        return
    text = str(value)
    if PRIVATE_KEY_RE.search(text):
        raise RedactionFailure(f"{path}: private key material is not allowed")
    if CRED_URL_RE.search(text):
        raise RedactionFailure(f"{path}: credentialed URL is not allowed")
    if RAW_ENV_HINT_RE.search(text):
        raise RedactionFailure(f"{path}: raw secret environment assignment is not allowed")
    if HEADER_SECRET_RE.search(text):
        raise RedactionFailure(f"{path}: secret-bearing header/value is not allowed")

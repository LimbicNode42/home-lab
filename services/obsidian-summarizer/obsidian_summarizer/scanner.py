from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import re

DATE_RE = re.compile(r'^(?P<date>\d{4}-\d{2}-\d{2})\.md$')
VALID_GOAL_STATUS = {'active', 'paused', 'completed', 'archived'}

@dataclass(frozen=True)
class MarkdownDocument:
    kind: str
    key: str
    path: Path
    text: str
    frontmatter: dict[str, str]


def split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith('---\n'):
        return {}, text
    end = text.find('\n---', 4)
    if end == -1:
        return {}, text
    data: dict[str, str] = {}
    for line in text[4:end].strip().splitlines():
        if ':' not in line:
            continue
        key, value = line.split(':', 1)
        data[key.strip().lower()] = value.strip().strip('"\'')
    return data, text[end + len('\n---'):].lstrip('\r\n')


def read_markdown(path: Path, kind: str, key: str) -> MarkdownDocument:
    frontmatter, body = split_frontmatter(path.read_text(encoding='utf-8'))
    return MarkdownDocument(kind, key, path, body, frontmatter)


def scan_diary(vault_dir: Path, limit_days: int = 14) -> list[MarkdownDocument]:
    diary_dir = vault_dir / 'Diary'
    if not diary_dir.exists():
        return []
    docs = []
    for path in diary_dir.glob('*.md'):
        match = DATE_RE.match(path.name)
        if match:
            docs.append(read_markdown(path, 'diary', match.group('date')))
    return sorted(docs, key=lambda doc: doc.key, reverse=True)[:limit_days]


def scan_goals(vault_dir: Path) -> list[MarkdownDocument]:
    goals_dir = vault_dir / 'Goals'
    if not goals_dir.exists():
        return []
    docs = []
    for path in sorted(goals_dir.glob('*.md')):
        doc = read_markdown(path, 'goal', path.stem)
        status = doc.frontmatter.get('status', 'active').lower()
        if status not in VALID_GOAL_STATUS:
            status = 'active'
        docs.append(MarkdownDocument(doc.kind, doc.key, doc.path, doc.text, {**doc.frontmatter, 'status': status, 'title': doc.frontmatter.get('title', doc.key)}))
    return docs

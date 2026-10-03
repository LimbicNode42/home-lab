from __future__ import annotations
from collections import defaultdict
from datetime import datetime, timezone
import re
from .scanner import MarkdownDocument


def _sentences(text: str, max_items: int = 5) -> list[str]:
    clean = re.sub(r'```[\s\S]*?```', ' ', text)
    clean = re.sub(r'[#>*_`\[\]()]+', ' ', clean)
    parts = re.split(r'(?<=[.!?])\s+|\n+', clean)
    return [p.strip()[:260] for p in parts if p.strip()][:max_items]


def summarize_diary(doc: MarkdownDocument, model: str) -> str:
    body = '\n'.join(f'- {item}' for item in _sentences(doc.text, 6)) or '- No substantive diary text found.'
    return f"# Diary summary — {doc.key}\n\nModel: `{model}`\nSource: `Diary/{doc.path.name}`\n\n## Summary\n{body}\n"


def summarize_goals(docs: list[MarkdownDocument], model: str) -> str:
    grouped: dict[str, list[MarkdownDocument]] = defaultdict(list)
    for doc in docs:
        grouped[doc.frontmatter.get('status', 'active')].append(doc)
    lines = ['# Goals digest', '', f'Model: `{model}`', '']
    for status in ['active', 'paused', 'completed', 'archived']:
        lines.extend([f'## {status.title()}', ''])
        if not grouped.get(status):
            lines.extend(['- None.', ''])
            continue
        for doc in grouped[status]:
            title = doc.frontmatter.get('title', doc.key)
            target = doc.frontmatter.get('target_date')
            suffix = f' (target {target})' if target else ''
            preview = '; '.join(_sentences(doc.text, 2)) or 'No body text.'
            lines.append(f'- **{title}**{suffix}: {preview}')
        lines.append('')
    return '\n'.join(lines).rstrip() + '\n'


def last_run_payload(*, model: str, diary_count: int, goals_count: int, output_dir: str, status: str = 'ok') -> dict:
    return {
        'kind': 'obsidian-summary',
        'window': {'diary_days': diary_count, 'goals': goals_count},
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'file_count': {'diary': diary_count, 'goals': goals_count},
        'model': model,
        'status': status,
        'output_dir': output_dir,
        'source': {'vault_label': 'obsidian NAS share', 'livesync_url': 'http://192.168.0.50:5984'},
    }

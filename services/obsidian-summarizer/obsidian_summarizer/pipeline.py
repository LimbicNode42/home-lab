from __future__ import annotations
import json
from .config import Config
from .scanner import scan_diary, scan_goals
from .summarizer import last_run_payload, summarize_diary, summarize_goals


def run_once(config: Config, apply: bool = True) -> dict:
    diary_docs = scan_diary(config.vault_dir, config.diary_days)
    goal_docs = scan_goals(config.vault_dir)
    outputs: dict[str, str] = {}
    for doc in diary_docs:
        outputs[f'diary/{doc.key}.md'] = summarize_diary(doc, config.model)
    outputs['goals/digest.md'] = summarize_goals(goal_docs, config.model)
    meta = last_run_payload(model=config.model, diary_count=len(diary_docs), goals_count=len(goal_docs), output_dir=str(config.output_dir))
    outputs['meta/last-run.json'] = json.dumps(meta, indent=2, sort_keys=True) + '\n'
    if apply:
        for rel, content in outputs.items():
            target = config.output_dir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding='utf-8')
    return {'status': 'ok', 'vault_dir': str(config.vault_dir), 'output_dir': str(config.output_dir), 'outputs': sorted(outputs), 'metadata': meta}

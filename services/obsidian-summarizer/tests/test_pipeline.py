from __future__ import annotations
import json
from pathlib import Path
from obsidian_summarizer.config import Config
from obsidian_summarizer.pipeline import run_once


def test_run_once_scans_diary_and_goals_without_reading_excluded_dirs(tmp_path: Path):
    vault = tmp_path / 'vault'
    (vault / 'Diary').mkdir(parents=True)
    (vault / 'Goals').mkdir()
    (vault / 'Inbox').mkdir()
    (vault / '.obsidian').mkdir()
    (vault / 'Diary' / '2026-10-03.md').write_text('# Day\nShipped the fake fixture. Felt steady.\n', encoding='utf-8')
    (vault / 'Diary' / 'not-a-date.md').write_text('ignored', encoding='utf-8')
    (vault / 'Goals' / 'Lead.md').write_text('---\ntitle: Lead the platform team\nstatus: active\ntarget_date: 2026-12-31\n---\nMake useful decisions.\n', encoding='utf-8')
    (vault / 'Inbox' / 'capture.md').write_text('must not be summarized', encoding='utf-8')
    (vault / '.obsidian' / 'workspace.md').write_text('must not be summarized', encoding='utf-8')

    output = tmp_path / 'summaries'
    result = run_once(Config(vault_dir=vault, output_dir=output, model='fixture-llm', diary_days=14), apply=True)

    assert result['outputs'] == ['diary/2026-10-03.md', 'goals/digest.md', 'meta/last-run.json']
    assert 'fake fixture' in (output / 'diary' / '2026-10-03.md').read_text(encoding='utf-8')
    goals = (output / 'goals' / 'digest.md').read_text(encoding='utf-8')
    assert 'Lead the platform team' in goals
    assert 'must not be summarized' not in goals
    meta = json.loads((output / 'meta' / 'last-run.json').read_text(encoding='utf-8'))
    assert meta['kind'] == 'obsidian-summary'
    assert meta['file_count'] == {'diary': 1, 'goals': 1}
    assert meta['source']['livesync_url'] == 'http://192.168.0.50:5984'

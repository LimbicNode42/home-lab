from __future__ import annotations
import argparse, json
from pathlib import Path
from .config import Config
from .pipeline import run_once
def build_parser():
    p=argparse.ArgumentParser(description='Summarize Obsidian Diary/Goals markdown into dashboard-readable files.')
    p.add_argument('--once', action='store_true', help='Run one summarization cycle and exit (on-demand trigger).')
    p.add_argument('--apply', action='store_true', default=True)
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--vault-dir', type=Path, default=None); p.add_argument('--output-dir', type=Path, default=None); p.add_argument('--model', default=None); p.add_argument('--diary-days', type=int, default=None)
    return p
def main(argv=None):
    p=build_parser(); args=p.parse_args(argv)
    if not args.once: p.error('expected --once; scheduled runs use the same --once code path')
    base=Config.from_env(); cfg=Config(vault_dir=args.vault_dir or base.vault_dir, output_dir=args.output_dir or base.output_dir, model=args.model or base.model, diary_days=args.diary_days or base.diary_days, include_personal=base.include_personal, include_work=base.include_work)
    print(json.dumps(run_once(cfg, apply=not args.dry_run), indent=2, sort_keys=True)); return 0
if __name__ == '__main__': raise SystemExit(main())

from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import os
DEFAULT_VAULT_DIR = Path('/mnt/nas/obsidian/vault')
DEFAULT_OUTPUT_DIR = Path('/mnt/nas/services/obsidian-livesync/summaries')
DEFAULT_MODEL = 'local-extractive-v1'
@dataclass(frozen=True)
class Config:
    vault_dir: Path = DEFAULT_VAULT_DIR
    output_dir: Path = DEFAULT_OUTPUT_DIR
    model: str = DEFAULT_MODEL
    diary_days: int = 14
    include_personal: bool = False
    include_work: bool = False
    @classmethod
    def from_env(cls) -> 'Config':
        return cls(vault_dir=Path(os.environ.get('OBSIDIAN_VAULT_DIR', str(DEFAULT_VAULT_DIR))), output_dir=Path(os.environ.get('OBSIDIAN_SUMMARY_OUTPUT_DIR', str(DEFAULT_OUTPUT_DIR))), model=os.environ.get('OBSIDIAN_SUMMARIZER_MODEL', DEFAULT_MODEL), diary_days=int(os.environ.get('OBSIDIAN_SUMMARIZER_DIARY_DAYS', '14')), include_personal=os.environ.get('OBSIDIAN_SUMMARIZER_INCLUDE_PERSONAL','').lower() in {'1','true','yes'}, include_work=os.environ.get('OBSIDIAN_SUMMARIZER_INCLUDE_WORK','').lower() in {'1','true','yes'})

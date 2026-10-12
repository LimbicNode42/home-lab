"""Test support: put the package + sibling Graphiti package on sys.path."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

GRAPHITI_AGENT_DIR = ROOT.parents[1] / "graphiti"
if str(GRAPHITI_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(GRAPHITI_AGENT_DIR))
#!/usr/bin/env python3
"""Entrypoint for services/graphiti/agent_graphiti/cli.py."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent_graphiti.cli import main

if __name__ == "__main__":
    raise SystemExit(main())

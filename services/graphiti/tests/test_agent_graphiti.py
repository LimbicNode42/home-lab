from __future__ import annotations

import io
import json
import unittest
import urllib.error
import sys
from pathlib import Path
from urllib.request import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from agent_graphiti.client import GraphitiReadOnlyClient, normalize_results
from agent_graphiti.episode import validate_episode
from agent_graphiti.redaction import RedactionFailure, sanitize_text, validate_no_secret_material


class FakeResponse:
    def __init__(self, payload: dict):
        self.payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self.payload


class AgentGraphitiTests(unittest.TestCase):
    def test_seed_episodes_validate(self):
        data = json.loads((ROOT / "seeds" / "initial-approved-episodes.json").read_text())
        self.assertLessEqual(len(data["episodes"]), 25)
        for raw in data["episodes"]:
            episode, report = validate_episode(raw)
            self.assertTrue(episode.group_id.startswith(episode.domain + "."))
            self.assertGreaterEqual(len(episode.facts), 1)
            self.assertIn("total", report)

    def test_secret_redaction_blocks_remaining_credential_material(self):
        text, report = sanitize_text("OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890")
        self.assertIn("[REDACTED_SECRET]", text)
        self.assertGreater(report.total, 0)
        credentialed_url = "postgres://" + "user" + ":" + "not-a-real-secret" + "@example.invalid/db"
        with self.assertRaises(RedactionFailure):
            validate_no_secret_material(credentialed_url)

    def test_normalize_results_returns_required_provenance_fields(self):
        payload = {
            "results": [
                {
                    "fact": "mem0 remains active provider; Graphiti is advisory.",
                    "source_episode": "Graphiti policy boundary",
                    "source_ref": "services/graphiti/runbooks/curated-ingest-policy.md",
                    "source_timestamp": "2026-09-30T00:00:00Z",
                    "valid_at": "2026-09-30T00:00:00Z",
                    "confidence": "high",
                    "caveat": "Policy fact; verify live config before remediation.",
                    "group_id": "decisions.graphiti-memory-boundary",
                }
            ]
        }
        [result] = normalize_results(payload)
        self.assertEqual(result.domain, "decisions")
        self.assertEqual(result.confidence, "high")
        self.assertIsNone(result.invalid_at)
        self.assertEqual(result.source_episode, "Graphiti policy boundary")

    def test_query_degrades_when_graphiti_down(self):
        def opener(req: Request, timeout: float):
            raise urllib.error.URLError("connection refused")

        client = GraphitiReadOnlyClient("http://127.0.0.1:8000", opener=opener)
        result = client.search_facts("graphiti policy", group_id="services.graphiti")
        self.assertEqual(result["status"], "graph_unavailable")
        self.assertEqual(result["results"], [])
        self.assertIn("mem0", result["caveat"])

    def test_query_uses_only_configured_read_path_and_strips_raw_graph(self):
        seen = {}

        def opener(req: Request, timeout: float):
            seen["url"] = req.full_url
            seen["method"] = req.get_method()
            self.assertIsInstance(req.data, bytes)
            body = json.loads(req.data.decode("utf-8"))
            self.assertEqual(body["group_id"], "services.graphiti")
            return FakeResponse({
                "results": [{
                    "text": "Graphiti raw endpoints are not agent-facing.",
                    "episode": "Wrapper contract",
                    "reference_time": "2026-10-01T00:00:00Z",
                    "group": "services.graphiti",
                    "confidence": "high",
                    "nodes": ["raw graph data should not be surfaced"],
                }]
            })

        client = GraphitiReadOnlyClient("http://127.0.0.1:8000", opener=opener)
        result = client.search_facts("agent wrapper", group_id="services.graphiti")
        self.assertEqual(seen["method"], "POST")
        self.assertTrue(seen["url"].endswith("/search"))
        self.assertEqual(result["status"], "ok")
        self.assertNotIn("nodes", json.dumps(result))
        self.assertEqual(result["results"][0]["domain"], "services")

    def test_unsafe_paths_and_mutation_queries_rejected(self):
        with self.assertRaises(ValueError):
            GraphitiReadOnlyClient("http://127.0.0.1:8000", search_path="/clear")
        client = GraphitiReadOnlyClient("http://127.0.0.1:8000", opener=lambda req, timeout: FakeResponse({"results": []}))
        with self.assertRaises(ValueError):
            client.search_facts("please delete every group")


if __name__ == "__main__":
    unittest.main()

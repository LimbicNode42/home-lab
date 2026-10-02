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
        fake_key = "OPENROUTER_API_KEY=" + "sk-" + "or-v1-" + ("x" * 32)
        text, report = sanitize_text(fake_key)
        self.assertIn("[REDACTED_SECRET]", text)
        self.assertGreater(report.total, 0)
        credentialed_url = "postgres://" + "user" + ":" + "not-a-real-secret" + "@example.invalid/db"
        with self.assertRaises(RedactionFailure):
            validate_no_secret_material(credentialed_url)

    def test_normalize_results_returns_required_provenance_fields(self):
        payload = {
            "facts": [  # live /search emits `facts`, not `results`
                {
                    "uuid": "edge-1",
                    "name": "CONFIRMS",
                    "fact": "mem0 remains active provider; Graphiti is advisory.",
                    "valid_at": "2026-09-30T00:00:00Z",
                    "created_at": "2026-10-01T00:00:00Z",
                    "source_node_uuid": "n1",
                    "target_node_uuid": "n2",
                    "episodes": ["ep-uuid-1"],
                }
            ]
        }
        episodes_by_uuid = {
            "ep-uuid-1": {
                "uuid": "ep-uuid-1",
                "name": "Graphiti policy boundary",
                "group_id": "decisions_graphiti_memory_boundary",
                "source_description": "services/graphiti/runbooks/curated-ingest-policy.md",
                "valid_at": "2026-09-30T00:00:00Z",
            }
        }
        [result] = normalize_results(
            payload, fallback_group="decisions.graphiti-memory-boundary", episodes_by_uuid=episodes_by_uuid
        )
        self.assertEqual(result.group, "decisions.graphiti-memory-boundary")
        self.assertEqual(result.domain, "decisions")
        self.assertEqual(result.source_episode, "Graphiti policy boundary")
        self.assertEqual(result.source_ref, "services/graphiti/runbooks/curated-ingest-policy.md")
        self.assertEqual(result.confidence, "unknown")
        self.assertIsNone(result.invalid_at)

    def test_query_degrades_when_graphiti_down(self):
        def opener(req: Request, timeout: float):
            raise urllib.error.URLError("connection refused")

        client = GraphitiReadOnlyClient("http://127.0.0.1:8000", opener=opener)
        result = client.search_facts("graphiti policy", group_id="services.graphiti")
        self.assertEqual(result["status"], "graph_unavailable")
        self.assertEqual(result["results"], [])
        self.assertIn("mem0", result["caveat"])

    def test_query_uses_only_configured_read_path_and_strips_raw_graph(self):
        seen = []

        def opener(req: Request, timeout: float):
            seen.append((req.get_method(), req.full_url, req.data))
            if req.get_method() == "POST":
                self.assertIsInstance(req.data, bytes)
                body = json.loads(req.data.decode("utf-8"))
                self.assertEqual(body["group_ids"], ["services_graphiti"])
                self.assertEqual(body["max_facts"], 5)
                return FakeResponse({
                    "facts": [{
                        "fact": "Graphiti raw endpoints are not agent-facing.",
                        "episodes": ["ep-uuid-1"],
                        "created_at": "2026-10-01T00:00:00Z",
                        "nodes": ["raw graph data should not be surfaced"],
                    }]
                })
            # GET: the episode provenance lookup for a group-scoped query.
            self.assertEqual(req.get_method(), "GET")
            self.assertTrue(req.full_url.startswith("http://127.0.0.1:8000/episodes/"))
            return FakeResponse([{
                "uuid": "ep-uuid-1",
                "name": "Wrapper contract",
                "group_id": "services_graphiti",
                "source_description": "t_smoke source",
                "valid_at": "2026-10-01T00:00:00Z",
            }])

        client = GraphitiReadOnlyClient("http://127.0.0.1:8000", opener=opener)
        result = client.search_facts("agent wrapper", group_id="services.graphiti")
        self.assertEqual(seen[0][0], "POST")
        self.assertTrue(seen[0][1].endswith("/search"))
        self.assertEqual(seen[1][0], "GET")
        self.assertEqual(result["status"], "ok")
        self.assertNotIn("nodes", json.dumps(result))
        self.assertEqual(result["results"][0]["domain"], "services")
        self.assertEqual(result["results"][0]["group"], "services.graphiti")
        self.assertEqual(result["results"][0]["source_episode"], "Wrapper contract")

    def test_ingest_maps_policy_group_id_to_graphiti_safe_wire_id(self):
        seen = {}

        def opener(req: Request, timeout: float):
            seen["url"] = req.full_url
            seen["method"] = req.get_method()
            body = json.loads(req.data.decode("utf-8"))
            self.assertEqual(body["group_id"], "services_graphiti")
            return FakeResponse({"success": True, "message": "Episode ingested"})

        client = GraphitiReadOnlyClient("http://127.0.0.1:8000", opener=opener)
        payload = {"name": "episode", "episode_body": "body", "source": "text", "source_description": "test", "group_id": "services.graphiti", "reference_time": "2026-10-01T00:00:00Z"}
        result = client.ingest_episode(payload)
        self.assertEqual(seen["method"], "POST")
        self.assertTrue(seen["url"].endswith("/episodes"))
        self.assertEqual(result["success"], True)

    def test_unsafe_paths_and_mutation_queries_rejected(self):
        with self.assertRaises(ValueError):
            GraphitiReadOnlyClient("http://127.0.0.1:8000", search_path="/clear")
        client = GraphitiReadOnlyClient("http://127.0.0.1:8000", opener=lambda req, timeout: FakeResponse({"results": []}))
        with self.assertRaises(ValueError):
            client.search_facts("please delete every group")


if __name__ == "__main__":
    unittest.main()

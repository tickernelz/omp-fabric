import importlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pier_omp_agent
from pier_omp_agent import collect_omp_session_metrics

HAS_PIER = importlib.util.find_spec("pier") is not None


class OMPSessionMetricsTest(unittest.TestCase):
    def test_collects_pareto_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session = Path(directory) / "session.jsonl"
            records = [
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "usage": {
                            "input": 100,
                            "cacheWrite": 5,
                            "cacheRead": 200,
                            "output": 20,
                            "totalTokens": 325,
                            "cost": {"total": 0.25},
                        },
                        "content": [
                            {
                                "type": "toolCall",
                                "name": "read",
                                "arguments": {"path": "README.md"},
                            }
                        ],
                    },
                },
                {
                    "type": "message",
                    "message": {
                        "role": "toolResult",
                        "toolName": "fabric_exec",
                        "content": [{"type": "text", "text": "x" * 50_001}],
                        "details": {
                            "trace": {
                                "outcome": "failed",
                                "operations": [
                                    {
                                        "ref": "omp.read",
                                        "args": {
                                            "path": "src/a.ts",
                                            "offset": 10,
                                            "limit": 20,
                                        },
                                    },
                                    {
                                        "ref": "omp.edit",
                                        "args": {"path": "src/a.ts"},
                                    },
                                    {
                                        "ref": "omp.edit",
                                        "args": {"path": "src/a.ts"},
                                    },
                                ]
                            }
                        },
                    },
                },
                {"type": "compaction"},
            ]
            session.write_text("".join(json.dumps(row) + "\n" for row in records))

            metrics = collect_omp_session_metrics(Path(directory))

        self.assertEqual(metrics["input_tokens"], 305)
        self.assertEqual(metrics["fresh_input_tokens"], 105)
        self.assertEqual(metrics["cache_tokens"], 200)
        self.assertEqual(metrics["output_tokens"], 20)
        self.assertEqual(metrics["combined_total_tokens"], 325)
        self.assertEqual(metrics["peak_context_tokens"], 305)
        self.assertEqual(metrics["outer_tool_calls"], 1)
        self.assertEqual(metrics["outer_calls_by_name"], {"read": 1})
        self.assertEqual(metrics["nested_tool_calls"], 3)
        self.assertEqual(metrics["nested_calls_by_ref"], {
            "omp.edit": 2,
            "omp.read": 1,
        })
        self.assertEqual(metrics["fabric_failures"], 1)
        self.assertEqual(metrics["same_file_extra_edits"], 1)
        self.assertEqual(metrics["model_visible_result_chars"], 50_001)
        self.assertEqual(metrics["max_result_chars"], 50_001)
        self.assertEqual(metrics["whole_file_reads"], 1)
        self.assertEqual(metrics["bounded_reads"], 1)
        self.assertEqual(metrics["results_over_50kb"], 1)
        self.assertEqual(metrics["summarization_count"], 1)


class OMPVersionPinTest(unittest.TestCase):
    def _reloaded_default(self, env_value: str | None) -> str:
        with mock.patch.dict(os.environ, {}, clear=False):
            if env_value is None:
                os.environ.pop("OMP_BENCH_VERSION", None)
            else:
                os.environ["OMP_BENCH_VERSION"] = env_value
            version = importlib.reload(pier_omp_agent).DEFAULT_OMP_VERSION
        importlib.reload(pier_omp_agent)
        return version

    def test_env_var_overrides_pinned_version(self) -> None:
        self.assertEqual(self._reloaded_default("18.1.12"), "18.1.12")

    def test_falls_back_to_pinned_version(self) -> None:
        self.assertEqual(self._reloaded_default(None), "18.1.10")
        self.assertEqual(self._reloaded_default(""), "18.1.10")


class ModuleSurfaceTest(unittest.TestCase):
    def test_unknown_attribute_raises_attribute_error(self) -> None:
        with self.assertRaises(AttributeError):
            getattr(pier_omp_agent, "OMPCodingAgentt")


@unittest.skipUnless(HAS_PIER, "requires the pier package")
class OMPCodingAgentClassTest(unittest.TestCase):
    def test_agent_class_builds_against_pier(self) -> None:
        from pier.agents.installed.base import BaseInstalledAgent

        agent_class = pier_omp_agent.OMPCodingAgent

        self.assertTrue(issubclass(agent_class, BaseInstalledAgent))
        self.assertIs(agent_class, pier_omp_agent.OMPCodingAgent)
        self.assertEqual(agent_class.name(), "omp")


if __name__ == "__main__":
    unittest.main()

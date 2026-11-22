#!/usr/bin/env python3
"""Fixture-backed tests for proser_codex_workbench.py."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import subprocess
import sys
import unittest
from pathlib import Path


TEST_DIR = Path(__file__).resolve().parent
SKILL_DIR = TEST_DIR.parent
SCRIPT = SKILL_DIR / "scripts" / "proser_codex_workbench.py"
FIXTURES = TEST_DIR / "fixtures"


def load_workbench_module():
    spec = importlib.util.spec_from_file_location("proser_codex_workbench_tested", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ProserCodexWorkbenchTests(unittest.TestCase):
    def run_cli(self, *args: str, expect: int = 0) -> dict:
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            check=False,
            text=True,
            capture_output=True,
        )
        self.assertEqual(proc.returncode, expect, proc.stderr + proc.stdout)
        return json.loads(proc.stdout)

    def fixture(self, name: str) -> str:
        return str(FIXTURES / name)

    def test_merge_plan(self):
        result = self.run_cli("merge-plan", "--existing", self.fixture("existing-codex.json"), "--draft", self.fixture("draft-codex.json"), "--book-id", "42")
        self.assertEqual(result["actions"][0]["action"], "update_existing")
        self.assertEqual(result["actions"][1]["action"], "create_new")

    def test_live_merge_plan(self):
        result = self.run_cli("live-merge-plan", "--book-id", "42", "--draft", self.fixture("draft-codex.json"), "--api-fixture", self.fixture("api-fixture.json"))
        self.assertEqual(result["source"], "fixture")
        self.assertEqual(result["draftCount"], 2)

    def test_extract_mentions(self):
        result = self.run_cli("extract-mentions", "--source", self.fixture("export.md"), "--existing", self.fixture("existing-codex.json"), "--limit", "5")
        names = {item["name"] for item in result["candidates"]}
        self.assertIn("Calder Wick", names)
        self.assertIn("Silver Vial", names)
        aliases = {(item["entryName"], item["alias"]) for item in result["aliasCandidates"]}
        self.assertIn(("Vespera Vale", "the reluctant botanist"), aliases)
        relationships = {(item["source"], item["target"], item["relationship"]) for item in result["relationshipCandidates"]}
        self.assertIn(("Vespera Vale", "Calder Wick", "mentor"), relationships)
        relationship_entries = [item for item in result["draftEntries"] if item["entryType"] == "relationship"]
        self.assertTrue(any("Vespera Vale and Calder Wick" in item["entryName"] for item in relationship_entries))

    def test_graph(self):
        result = self.run_cli("graph", "--entries", self.fixture("existing-codex.json"))
        self.assertGreaterEqual(result["edgeCount"], 1)
        self.assertIn("graph TD", result["mermaid"])

    def test_preset(self):
        result = self.run_cli("preset", "--entry-type", "relationship")
        self.assertEqual(result["entryType"], "relationship")
        self.assertIn("source", result["attributes"])

    def test_coverage(self):
        result = self.run_cli("coverage", "--entries", self.fixture("existing-codex.json"), "--scenes", self.fixture("scenes.json"))
        self.assertEqual(result["sceneCount"], 2)
        self.assertEqual(len(result["weakScenes"]), 1)

    def test_live_coverage(self):
        result = self.run_cli("live-coverage", "--book-id", "42", "--api-fixture", self.fixture("api-fixture.json"))
        self.assertEqual(result["source"], "fixture")
        self.assertEqual(result["sceneCount"], 2)

    def test_dry_run_upload(self):
        result = self.run_cli("dry-run-upload", "--draft", self.fixture("draft-codex.json"), "--existing", self.fixture("existing-codex.json"), "--book-id", "42")
        self.assertEqual(result["stepCount"], 2)
        self.assertEqual(result["steps"][0]["toolCall"]["tool"], "proser_codex")

    def test_upload_execute_requires_confirmation(self):
        result = self.run_cli("upload-execute", "--plan", self.fixture("upload-plan.json"), expect=2)
        self.assertFalse(result["ok"])
        self.assertIn("confirm", result["error"].lower())

    def test_upload_execute_calls_plugin_tool_when_confirmed(self):
        module = load_workbench_module()
        calls = []

        def fake_call(tool_name, tool_args):
            calls.append((tool_name, tool_args))
            return {"ok": True, "status": 201, "response": {"success": True, "data": {"id": 99}}}

        module.call_plugin_tool = fake_call
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            exit_code = module.main(["upload-execute", "--plan", self.fixture("upload-plan.json"), "--confirm", "EXECUTE"])
        self.assertEqual(exit_code, 0)
        result = json.loads(stdout.getvalue())
        self.assertTrue(result["ok"])
        self.assertEqual(calls[0][0], "proser_codex")
        self.assertEqual(calls[0][1]["action"], "create_entry")

    def test_rename_scout(self):
        result = self.run_cli("rename-scout", "--old-name", "Old Name", "--new-name", "New Name", "--codex-id", "77", "--source", self.fixture("export.md"))
        self.assertEqual(result["impacts"][0]["hitCount"], 1)
        self.assertEqual(result["codexRenameCall"]["args"]["codexId"], 77)

    def test_live_rename_scout(self):
        result = self.run_cli(
            "live-rename-scout",
            "--book-id",
            "42",
            "--old-name",
            "Old Name",
            "--new-name",
            "New Name",
            "--include-notes",
            "--api-fixture",
            self.fixture("api-fixture.json"),
        )
        self.assertEqual(result["source"], "fixture")
        self.assertEqual(len(result["sceneHits"]), 1)
        self.assertEqual(len(result["noteHits"]), 1)

    def test_lint(self):
        result = self.run_cli("lint", "--entries", self.fixture("existing-codex.json"), "--include-clean")
        self.assertEqual(result["entryCount"], 3)
        self.assertIn("entries", result)

    def test_import_plan(self):
        result = self.run_cli(
            "import-plan",
            "--source",
            self.fixture("draft-codex.json"),
            "--target-existing",
            self.fixture("existing-codex.json"),
            "--book-id",
            "42",
            "--rename",
            "The Amber Pruners=The Gilded Pruners",
        )
        self.assertEqual(result["mappedCount"], 2)
        self.assertIn("The Amber Pruners", result["renameMap"])

    def test_visual_prompts(self):
        result = self.run_cli("visual-prompts", "--entries", self.fixture("existing-codex.json"), "--type", "character", "--limit", "2")
        self.assertEqual(result["seedCount"], 1)
        self.assertEqual(result["seeds"][0]["suggestPromptCall"]["tool"], "proser_images")


if __name__ == "__main__":
    unittest.main()

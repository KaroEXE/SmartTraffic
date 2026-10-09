"""Check publication diagnostics in disposable repos, never the project index."""

import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import review_repository


class RepositoryReviewTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True, capture_output=True)
        (self.root / ".gitignore").write_text(".env\n*.pt\naudit/\n")
        (self.root / "README.md").write_text("# Test project\n")

    def review(self):
        output = io.StringIO()
        with patch.object(review_repository, "ROOT", self.root), contextlib.redirect_stdout(output):
            code = review_repository.main()
        return code, json.loads(output.getvalue()), output.getvalue()

    def test_clean_source_tree_passes(self):
        (self.root / "app.py").write_text("value = 1\n")
        code, report, _ = self.review()
        self.assertEqual(code, 0)
        self.assertTrue(report["hygiene_checks_passed"])
        self.assertEqual(report["syntax_files_passed"], 1)

    def test_ignored_but_tracked_asset_fails_without_removing_it(self):
        model = self.root / "model.pt"
        model.write_bytes(b"test asset")
        subprocess.run(["git", "-C", str(self.root), "add", "-f", "model.pt"],
                       check=True, capture_output=True)
        code, report, _ = self.review()
        self.assertEqual(code, 2)
        self.assertFalse(report["hygiene_checks_passed"])
        self.assertEqual(report["already_tracked_ignored_files"], ["model.pt"])
        self.assertEqual(model.read_bytes(), b"test asset")

    def test_untracked_large_file_is_also_reported(self):
        (self.root / "generated.dat").write_bytes(b"0" * 5_000_001)
        code, report, _ = self.review()
        self.assertEqual(code, 2)
        self.assertEqual(report["candidate_large_or_binary_assets"][0]["path"], "generated.dat")

    def test_known_secret_is_reported_by_filename_without_printing_value(self):
        sentinel = "fake-repository-test-secret"
        (self.root / ".env").write_text(f"SERVICE_API_KEY={sentinel}\n")
        (self.root / "bad.py").write_text(f"value = '{sentinel}'\n")
        code, report, output = self.review()
        self.assertEqual(code, 1)
        self.assertEqual(report["known_secret_matches_in_candidates"], ["bad.py"])
        self.assertNotIn(sentinel, output)

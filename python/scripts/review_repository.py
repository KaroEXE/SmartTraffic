"""Read-only review of public Git candidates and history; never prints secrets."""

import ast
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def main():
    from dotenv import dotenv_values

    secrets = []
    for path in (ROOT / ".env", ROOT / "config/.env"):
        for name, value in dotenv_values(path, interpolate=False).items():
            if value and len(value) >= 12 and any(word in name.upper() for word in ("KEY", "TOKEN", "SECRET", "PASSWORD")):
                if not value.startswith("YOUR_"):
                    secrets.append(value.encode())
    listed = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").decode().split("\0")[:-1]
    # A removed/moved working-tree file won't be in the next tree after git add -A.
    candidates = sorted({name for name in listed if (ROOT / name).is_file()})
    binary_extensions = {".pt", ".pth", ".onnx", ".engine", ".mp4", ".avi", ".mov", ".zip"}
    known_hits, suspicious = [], []
    credential_pattern = re.compile(rb"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|https?://[^\s/:'\"]+:[^\s/@'\"]+@)")
    syntax = []
    for name in candidates:
        path = ROOT / name
        if not path.is_file() or path.suffix in binary_extensions:
            continue
        data = path.read_bytes()
        if any(secret in data for secret in secrets):
            known_hits.append(name)
        if credential_pattern.search(data):
            suspicious.append(name)
        if path.suffix == ".py":
            ast.parse(data.decode("utf-8-sig"), filename=name)
            syntax.append(name)
    history_hits = []
    # Scan reachable history, including removed text files; do not rewrite it.
    for line in git("rev-list", "--objects", "--all").decode().splitlines():
        parts = line.split(" ", 1)
        if len(parts) != 2:
            continue
        oid, name = parts
        if Path(name).suffix in binary_extensions:
            continue
        if git("cat-file", "-t", oid).strip() != b"blob":
            continue
        data = git("cat-file", "-p", oid)
        if any(secret in data for secret in secrets) or credential_pattern.search(data):
            history_hits.append(name)
    ignored_tracked = git("ls-files", "-ci", "--exclude-standard").decode().splitlines()
    assets = [{"path": name, "bytes": (ROOT / name).stat().st_size}
              for name in candidates if Path(name).suffix in binary_extensions
              or (ROOT / name).stat().st_size > 5_000_000]
    blockers = []
    if known_hits or suspicious or history_hits:
        blockers.append("Review credential matches before publishing")
    if ignored_tracked:
        blockers.append("Ignored files are already tracked; review index-only removal")
    if assets:
        blockers.append("Binary/large assets would be included; review distribution or untracking")
    license_files = [name for name in ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING")
                     if (ROOT / name).is_file()]
    report = {
        "hygiene_checks_passed": not blockers,
        "blockers": blockers,
        "project_license_files": license_files,
        "syntax_files_passed": len(syntax), "candidate_files": len(candidates),
        "known_secret_matches_in_candidates": sorted(set(known_hits)),
        "credential_pattern_matches_in_candidates": sorted(set(suspicious)),
        "secret_or_pattern_matches_in_history": sorted(set(history_hits)),
        "already_tracked_ignored_files": ignored_tracked,
        "candidate_large_or_binary_assets": assets,
        "note": "A heuristic scan is not proof of absence of every possible credential. Review staged diffs manually.",
    }
    print(json.dumps(report, indent=2))
    # Exit 1 for credential findings; 2 for repository hygiene needing review.
    return 1 if known_hits or suspicious or history_hits else (2 if blockers else 0)


if __name__ == "__main__":
    raise SystemExit(main())

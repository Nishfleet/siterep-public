#!/usr/bin/env python3
"""Count hand-written shell lines for the no-hand-built-orchestration ratchet.

CI runs this and compares the output (a single integer) to
.semgrep/shell-line-budget. The job fails if the current count EXCEEDS the
baseline; raising the baseline in the same PR is the justification act.

Definition (precise):
  1. Every *.sh / *.bash / *.bats file anywhere in the repo (excluding
     .git/, node_modules/, dist/, .wrangler/) -> all lines counted.
  2. Every file directly under scripts/ whose first line is a shell shebang
     (^#! .../sh or .../bash) -> all lines counted. Node/Python/PHP scripts
     in scripts/ are NOT shell and are not counted.
  3. Every .github/workflows/*.{yml,yaml} -> for each `run: |` block, the
     indented body lines after the `run: |` header, up to the first line at
     indentation <= the `run:` key's indentation. The `run: |` header line
     itself is NOT counted; body lines (blank or not) ARE counted.

This is a CI helper, not orchestration: it counts shell, it does not run any.
"""
import re
import sys
from pathlib import Path

EXCLUDE_DIRS = {".git", "node_modules", "dist", ".wrangler"}
SHELL_EXT = {".sh", ".bash", ".bats"}
SHELL_SHEBANG = re.compile(r"^#!\s*\S*/\S*\b(?:sh|bash)\b")
RUN_PIPE = re.compile(r"^(\s*)run:\s*\|\s*$")


def count_file_lines(p: Path) -> int:
    with p.open(encoding="utf-8", errors="replace") as fh:
        return sum(1 for _ in fh)


def count_run_blocks(p: Path) -> int:
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    total = 0
    i = 0
    n = len(lines)
    while i < n:
        m = RUN_PIPE.match(lines[i])
        if not m:
            i += 1
            continue
        key_indent = len(m.group(1))
        i += 1
        while i < n:
            line = lines[i]
            if line.strip() == "":
                total += 1
                i += 1
                continue
            indent = len(line) - len(line.lstrip(" "))
            if indent <= key_indent:
                break
            total += 1
            i += 1
    return total


def main() -> int:
    root = Path(".")
    total = 0

    for p in root.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in SHELL_EXT:
            continue
        if any(part in EXCLUDE_DIRS for part in p.parts):
            continue
        total += count_file_lines(p)

    scripts_dir = root / "scripts"
    if scripts_dir.is_dir():
        for p in sorted(scripts_dir.iterdir()):
            if not p.is_file():
                continue
            try:
                first = p.read_text(encoding="utf-8", errors="replace").splitlines()[0]
            except IndexError:
                continue
            if SHELL_SHEBANG.match(first):
                total += count_file_lines(p)

    wf_dir = root / ".github" / "workflows"
    if wf_dir.is_dir():
        for p in sorted(wf_dir.iterdir()):
            if p.suffix.lower() not in (".yml", ".yaml") or not p.is_file():
                continue
            total += count_run_blocks(p)

    print(total)
    return 0


if __name__ == "__main__":
    sys.exit(main())

// Shell-line ratchet, ported from the retired .semgrep Python count helper
// into the runner this repo already uses (`npm test` -> node --test).
// One test, no helper files: the counting logic lives here because the
// orchestrator ratchet is a check, and the #109 series moves checks into the
// existing test dir. The retired helper filename is intentionally not
// reproduced here so this repo keeps zero references to it.
//
// Definition (unchanged from the Python original):
//   1. Every *.sh / *.bash / *.bats file anywhere in the repo (excluding
//      .git/, node_modules/, dist/, .wrangler/) -> all lines counted.
//   2. Every .github/workflows/*.{yml,yaml} -> for each `run: |` block, the
//      indented body lines after the `run: |` header, up to the first line at
//      indentation <= the `run:` key's indentation. The `run: |` header line
//      itself is NOT counted; body lines (blank or not) ARE counted.
//
// The Python original also counted shell-shebang files directly under
// scripts/. That clause is dropped on purpose: scripts/ is being emptied and
// gated by the #109 CI check, so the clause would only ever count a shape
// that gate already bans.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const EXCLUDE_DIRS = new Set([".git", "node_modules", "dist", ".wrangler"]);
const SHELL_EXT = new Set([".sh", ".bash", ".bats"]);
const WORKFLOW_EXT = new Set([".yml", ".yaml"]);
const RUN_PIPE = /^(\s*)run:\s*\|\s*$/;

const ROOT = new URL("..", import.meta.url);

function countFileLines(text) {
  if (text === "") return 0;
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

function countRunBlocks(text) {
  // Mirror Python's str.splitlines(): split on \r?\n, then drop the trailing
  // empty element a final newline produces. Without this the last `run: |`
  // block counts a phantom blank line and the ratchet drifts by one.
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let total = 0;
  let i = 0;
  while (i < lines.length) {
    const match = RUN_PIPE.exec(lines[i]);
    if (!match) {
      i += 1;
      continue;
    }
    const keyIndent = match[1].length;
    i += 1;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        total += 1;
        i += 1;
        continue;
      }
      const indent = line.length - line.replace(/^ +/, "").length;
      if (indent <= keyIndent) break;
      total += 1;
      i += 1;
    }
  }
  return total;
}

function countShellFiles(dirUrl) {
  let total = 0;
  for (const entry of fs.readdirSync(dirUrl, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      total += countShellFiles(new URL(`${entry.name}/`, dirUrl));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SHELL_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    total += countFileLines(fs.readFileSync(new URL(entry.name, dirUrl), "utf8"));
  }
  return total;
}

function countWorkflowRunBlocks() {
  const workflowDir = new URL(".github/workflows/", ROOT);
  if (!fs.existsSync(workflowDir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(workflowDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!WORKFLOW_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    total += countRunBlocks(fs.readFileSync(new URL(entry.name, workflowDir), "utf8"));
  }
  return total;
}

test("hand-written shell lines stay within .semgrep/shell-line-budget", () => {
  const current = countShellFiles(ROOT) + countWorkflowRunBlocks();
  const budget = Number.parseInt(
    fs.readFileSync(new URL(".semgrep/shell-line-budget", ROOT), "utf8").trim(),
    10,
  );

  assert.ok(
    Number.isInteger(budget),
    `.semgrep/shell-line-budget is not an integer: ${budget}`,
  );
  assert.ok(
    current <= budget,
    `Shell-line budget exceeded: ${current} > ${budget}. Raise .semgrep/shell-line-budget in this PR with a one-line justification.`,
  );
});

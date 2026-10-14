
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

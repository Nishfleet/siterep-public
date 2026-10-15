import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const stub = await readFile(new URL("../.github/workflows/agent-dispatch.yml", import.meta.url), "utf8");

test("dispatch stub listens for all nine fleet PR events", () => {
  const types = stub.match(/pull_request_target:\n\s+types: \[([^\]]+)\]/)[1].split(",").map((type) => type.trim());
  assert.deepEqual(types.sort(), [
    "auto_merge_disabled",
    "auto_merge_enabled",
    "closed",
    "dequeued",
    "labeled",
    "opened",
    "ready_for_review",
    "reopened",
    "synchronize",
  ]);
});

test("dispatch stub concurrency groups never equal the callee's agent-dispatch-<run_id>", () => {
  const group = stub.match(/concurrency:\n\s+group: >-\n([\s\S]+?)\n\s+cancel-in-progress: (\w+)/);
  assert.ok(group, "concurrency block present");
  const names = [...group[1].matchAll(/format\('([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(names, [
    "agent-dispatch-comment-{0}-{1}",
    "agent-dispatch-pr-{0}-{1}",
    "agent-dispatch-pr-{0}-{1}-{2}",
    "agent-dispatch-stub-{0}",
  ]);
  for (const name of names) assert.doesNotMatch(name, /^agent-dispatch-\{0\}$/);
  assert.equal(group[2], "false", "nothing is cancelled mid-run");
  // The six hold-risky actions share one group per PR, so they never run
  // hold-risky and review-risky in parallel on one head.
  const shared = JSON.parse(group[1].match(/fromJSON\('(\[[^']+\])'\)/)[1]);
  assert.deepEqual(shared.sort(), ["auto_merge_enabled", "labeled", "opened", "ready_for_review", "reopened", "synchronize"]);
});

test("dispatch stub dispatches PR events only for a same-repo head", () => {
  const condition = stub.match(/jobs:\n\s+dispatch:\n\s+if: >-\n([\s\S]+?)\n\s+uses:/)[1].replace(/\s+/g, " ");
  assert.match(
    condition,
    /\(github\.event\.action != 'closed' && github\.event\.pull_request\.head\.repo\.full_name == github\.repository\)/,
  );
  assert.match(condition, /\(github\.event\.action == 'closed' && github\.event\.pull_request\.head\.repo\.full_name == github\.repository &&/);
  // Dropping either same-repo check would let a fork's PR start a run.
  assert.equal(condition.match(/head\.repo\.full_name == github\.repository/g).length, 2);
});

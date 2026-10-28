import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

function countOccurrences(source, target) {
  return source.split(target).length - 1;
}

async function readIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readReleaseMarkerConstants(worker) {
  const dateMatch = worker.match(/const RELEASE_STATUS_MARKER_UPDATED_AT = "(\d{4}-\d{2}-\d{2})";/);
  const markerMatch = worker.match(/const RELEASE_STATUS_MARKER = "([^"]+)";/);
  assert.ok(dateMatch, "worker/index.js must define RELEASE_STATUS_MARKER_UPDATED_AT");
  assert.ok(markerMatch, "worker/index.js must define RELEASE_STATUS_MARKER");
  return { markerDateString: dateMatch[1], marker: markerMatch[1] };
}

function readDeployIdentityConstants(worker) {
  const commitMatch = worker.match(/const RELEASE_STATUS_COMMIT = "([0-9a-f]+)";/);
  const deployedAtMatch = worker.match(/const RELEASE_STATUS_DEPLOYED_AT = "([^"]+)";/);
  assert.ok(commitMatch, "worker/index.js must define RELEASE_STATUS_COMMIT");
  assert.ok(deployedAtMatch, "worker/index.js must define RELEASE_STATUS_DEPLOYED_AT");
  return { commit: commitMatch[1], deployedAt: deployedAtMatch[1] };
}

test("release status marker date is not in the future", async () => {
  const workerPath = new URL("../worker/index.js", import.meta.url);
  const worker = await readFile(workerPath, "utf8");
  const { markerDateString } = readReleaseMarkerConstants(worker);

  const markerDate = new Date(`${markerDateString}T00:00:00Z`).getTime();
  const ageMs = Date.now() - markerDate;

  assert.ok(ageMs >= 0, `markerUpdatedAt ${markerDateString} must not be in the future`);
});

test("RELEASE_STATUS_MARKER name matches RELEASE_STATUS_MARKER_UPDATED_AT", async () => {
  const workerPath = new URL("../worker/index.js", import.meta.url);
  const worker = await readFile(workerPath, "utf8");
  const { marker, markerDateString } = readReleaseMarkerConstants(worker);

  assert.ok(
    marker.includes(markerDateString),
    `RELEASE_STATUS_MARKER ${JSON.stringify(marker)} must include RELEASE_STATUS_MARKER_UPDATED_AT ${markerDateString}`,
  );
});

test("RELEASE_STATUS_MARKER is the single source of truth", async () => {
  const workerPath = new URL("../worker/index.js", import.meta.url);
  const worker = await readFile(workerPath, "utf8");
  const { marker } = readReleaseMarkerConstants(worker);
  const workerOccurrences = countOccurrences(worker, marker);
  assert.equal(
    workerOccurrences,
    1,
    `RELEASE_STATUS_MARKER must be hardcoded exactly once in worker/index.js (found ${workerOccurrences})`,
  );

  const scriptPath = new URL("./siterep-live-synthetic.mjs", import.meta.url);
  const workflowPath = new URL("../.github/workflows/live-canary.yml", import.meta.url);

  for (const path of [scriptPath, workflowPath]) {
    const source = await readIfExists(path);
    if (source === null) continue;
    assert.ok(
      !source.includes(marker),
      `a second hardcoded copy of the release marker must not exist in ${path.pathname}`,
    );
  }
});

test("RELEASE_STATUS_DEPLOYED_AT is a valid UTC timestamp that is not in the future", async () => {
  const workerPath = new URL("../worker/index.js", import.meta.url);
  const worker = await readFile(workerPath, "utf8");
  const { deployedAt } = readDeployIdentityConstants(worker);

  assert.match(
    deployedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    `RELEASE_STATUS_DEPLOYED_AT ${JSON.stringify(deployedAt)} must be YYYY-MM-DDTHH:MM:SSZ`,
  );

  const deployedAtMs = Date.parse(deployedAt);
  assert.ok(
    Number.isFinite(deployedAtMs),
    `RELEASE_STATUS_DEPLOYED_AT ${JSON.stringify(deployedAt)} must parse as a valid UTC timestamp`,
  );

  const ageMs = Date.now() - deployedAtMs;
  assert.ok(ageMs >= 0, `RELEASE_STATUS_DEPLOYED_AT ${deployedAt} must not be in the future`);
});

test("RELEASE_STATUS_COMMIT is a 40-hex git SHA", async () => {
  const workerPath = new URL("../worker/index.js", import.meta.url);
  const worker = await readFile(workerPath, "utf8");
  const { commit } = readDeployIdentityConstants(worker);

  assert.match(
    commit,
    /^[0-9a-f]{40}$/,
    `RELEASE_STATUS_COMMIT ${JSON.stringify(commit)} must be a 40-character lowercase hex git SHA`,
  );
});

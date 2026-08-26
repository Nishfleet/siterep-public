import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_MS = 60 * DAY_MS;

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

test("release status marker is no older than 60 days", async () => {
  const workerPath = new URL("../worker/index.js", import.meta.url);
  const worker = await readFile(workerPath, "utf8");
  const { markerDateString } = readReleaseMarkerConstants(worker);

  const markerDate = new Date(`${markerDateString}T00:00:00Z`).getTime();
  const ageMs = Date.now() - markerDate;

  assert.ok(ageMs >= 0, `markerUpdatedAt ${markerDateString} must not be in the future`);
  assert.ok(ageMs <= MAX_AGE_MS, `release status marker updated at ${markerDateString} is older than 60 days`);
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

  const scriptPath = new URL("../scripts/siterep-live-synthetic.mjs", import.meta.url);
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

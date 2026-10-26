import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

// Scheduled only (weekly workflow). Not named *.test.js, so `npm test` and the
// PR gate never run it: it compares the checked-in release identity to the
// clock and would turn every PR red once it ages (siterep-public#206).
test("checked-in release identity in worker/index.js is within 60 days", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const markerDate = worker.match(/const RELEASE_STATUS_MARKER_UPDATED_AT = "(\d{4}-\d{2}-\d{2})";/)?.[1];
  const deployedAt = worker.match(/const RELEASE_STATUS_DEPLOYED_AT = "([^"]+)";/)?.[1];
  assert.ok(markerDate && deployedAt, "worker/index.js must define the release marker constants");
  for (const [name, value] of [
    ["RELEASE_STATUS_MARKER_UPDATED_AT", Date.parse(`${markerDate}T00:00:00Z`)],
    ["RELEASE_STATUS_DEPLOYED_AT", Date.parse(deployedAt)],
  ]) {
    assert.ok(Number.isFinite(value), `${name} must parse as a UTC time`);
    assert.ok(Date.now() - value <= MAX_AGE_MS, `${name} is older than 60 days; refresh the checked-in fallback to the live deploy-stamped identity from /api/health/deep`);
  }
});

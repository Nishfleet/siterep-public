import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

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
    const ageMs = Date.now() - value;
    assert.ok(ageMs >= 0 && ageMs <= MAX_AGE_MS, `${name} is older than 60 days; refresh the checked-in fallback to the live deploy-stamped identity from /api/health/deep`);
  }
});

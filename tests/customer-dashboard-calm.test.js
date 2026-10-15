import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("operator-only surfaces are gated out of the customer dashboard", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  const marketing = app.slice(app.indexOf('<section className="support-section"') - 80, app.indexOf('<section className="builder-section siterep-workspace"'));
  assert.match(marketing, /\{!isCustomerMode \?/);
  assert.match(marketing, /Verified handoff path/);

  const qa = app.slice(app.indexOf('<span>Routing profile</span>') - 120, app.indexOf('<span>Routing profile</span>'));
  assert.match(qa, /\{!isCustomerMode \?/);

  assert.match(app, /isCustomerMode \? "Answer quality" : "Answer QA and routing"/);
});

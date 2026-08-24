import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// A paying customer's workspace should read like a calm product, not an
// operator runbook: the roadmap/manifesto marketing sections and the internal
// model-routing control are hidden in customer mode.
test("operator-only surfaces are gated out of the customer dashboard", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  // Support/integrations/trust roadmap sections wrapped for non-customer only.
  const marketing = app.slice(app.indexOf('<section className="support-section"') - 80, app.indexOf('<section className="builder-section siterep-workspace"'));
  assert.match(marketing, /\{!isCustomerMode \?/);
  assert.match(marketing, /Verified handoff path/);

  // The fictional routing-profile control is hidden from customers.
  const qa = app.slice(app.indexOf('<span>Routing profile</span>') - 120, app.indexOf('<span>Routing profile</span>'));
  assert.match(qa, /\{!isCustomerMode \?/);

  // The panel reads "Answer quality" to customers (no internal "routing").
  assert.match(app, /isCustomerMode \? "Answer quality" : "Answer QA and routing"/);
});

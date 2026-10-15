import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("lead submit resolves the visitor check before touching the network", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  const leadHandler = widget.slice(widget.indexOf('name="need"'), widget.indexOf("message.appendChild(box)"));
  const tokenCapture = leadHandler.indexOf('const abuseProtectionToken = await ensureAbuseToken("lead");');
  const disableButton = leadHandler.indexOf("submitButton.disabled = true;");
  assert.ok(tokenCapture !== -1, "lead submit must resolve the abuse token before sending");
  assert.ok(disableButton !== -1, "lead submit must disable the button only after the token check");
  assert.ok(tokenCapture < disableButton, "token resolution must precede the submit/network path");
});

test("lead submit blocks with inline guidance when the visitor check is missing", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  const leadHandler = widget.slice(widget.indexOf('name="need"'), widget.indexOf("message.appendChild(box)"));
  assert.match(
    leadHandler,
    /abuseProtection\.enabled && abuseProtection\.actions\.includes\("lead"\) && !abuseProtectionToken/,
  );
  assert.match(leadHandler, /Complete the visitor check above, then send your details again\./);
  assert.ok(
    leadHandler.indexOf("!abuseProtectionToken)") < leadHandler.indexOf("submitButton.disabled = true;"),
    "missing-token block must precede the submit/network path",
  );
  assert.match(
    leadHandler.slice(0, leadHandler.indexOf("submitButton.disabled = true;")),
    /return;\s*\n\s*}/,
    "missing-token block must early-return before the button is disabled",
  );
});

test("lead submit sends only the already-captured token", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  const leadHandler = widget.slice(widget.indexOf('name="need"'), widget.indexOf("message.appendChild(box)"));
  assert.match(leadHandler, /abuseProtectionToken,\n\s+abuseProtectionAction: "lead",/);
  assert.doesNotMatch(leadHandler, /abuseProtectionToken: await ensureAbuseToken/);
});

test("chat path keeps its own visitor-check gate", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  const chatPath = widget.slice(widget.indexOf("async function findAnswer"), widget.indexOf("async function loadConfig"));
  assert.match(
    chatPath,
    /abuseProtection\.enabled && abuseProtection\.actions\.includes\("chat"\) && !abuseProtectionToken/,
  );
  assert.match(chatPath, /Complete the visitor check, then send your question again\./);
});

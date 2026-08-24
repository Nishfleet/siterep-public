import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("abuse protection is disabled by default and safe for existing reps", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /function defaultAbuseProtectionSettings/);
  assert.match(worker, /enabled: false/);
  assert.match(worker, /provider: "turnstile"/);
  assert.match(worker, /record\.abuseProtection = sanitizeAbuseProtectionSettings/);
  assert.match(worker, /abuseProtection: publicAbuseProtectionSettings\(bot\)/);
});

test("public config exposes only Turnstile site key and actions", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /abuseProtection: bot \? publicWidgetAbuseProtectionSettings\(bot\)/);
  assert.match(worker, /const configured = turnstileVerifierConfigured\(settings\)/);
  assert.match(worker, /siteKey: configured \? settings\.siteKey : ""/);
  assert.doesNotMatch(worker.slice(worker.indexOf("function publicWidgetAbuseProtectionSettings"), worker.indexOf("async function verifyPublicAbuseProtection")), /secret/i);
});

test("abuse protection only advertises actions with server verification", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const sanitizer = worker.slice(worker.indexOf("function sanitizeAbuseProtectionSettings"), worker.indexOf("function publicAbuseProtectionSettings"));

  assert.match(sanitizer, /\["chat", "lead"\]\.includes\(item\)/);
  assert.doesNotMatch(sanitizer, /feedback/);
  assert.doesNotMatch(sanitizer, /custom/);
});

test("Turnstile is verified server-side with token, remote IP, action, and hostname", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /async function verifyPublicAbuseProtection/);
  assert.match(worker, /SITEREP_TURNSTILE_SECRET/);
  assert.match(worker, /TURNSTILE_SECRET_KEY/);
  assert.match(worker, /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/);
  assert.match(worker, /form\.append\("secret", secret\)/);
  assert.match(worker, /form\.append\("response", token\)/);
  assert.match(worker, /form\.append\("remoteip", remoteIp\)/);
  assert.match(worker, /form\.append\("idempotency_key", crypto\.randomUUID\(\)\)/);
  assert.match(worker, /action: String\(data\.action \|\| ""\)/);
  assert.match(worker, /result\.action !== action/);
  assert.match(worker, /hostnameMatchesOrigin\(result\.hostname, origin\)/);
});

test("server enforces only fully configured Turnstile actions", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const verifier = worker.slice(worker.indexOf("async function verifyPublicAbuseProtection"), worker.indexOf("async function verifyTurnstileToken"));

  assert.match(verifier, /settings\.provider === "turnstile"/);
  assert.match(verifier, /settings\.siteKey/);
  assert.match(verifier, /turnstileSecret\(\)/);
  assert.match(verifier, /!settings\.actions\.includes\(action\)/);
});

test("public chat and lead routes verify after rate limits and before writes", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const directChatRoute = worker.slice(
    worker.indexOf('if (request.method === "POST" && url.pathname === "/api/public/chat")'),
    worker.indexOf('if (request.method === "POST" && url.pathname === "/api/public/install")'),
  );
  const leadRoute = worker.slice(worker.indexOf('url.pathname === "/api/public/leads"'), worker.indexOf('url.pathname === "/api/sources"'));

  assert.ok(directChatRoute.indexOf("checkPublicRateLimit") < directChatRoute.indexOf("verifyPublicAbuseProtection"));
  assert.ok(directChatRoute.indexOf("verifyPublicAbuseProtection") < directChatRoute.indexOf("const result = await recordConversation"));
  assert.ok(leadRoute.indexOf("checkPublicRateLimit") < leadRoute.indexOf("verifyPublicAbuseProtection"));
  assert.ok(leadRoute.indexOf("verifyPublicAbuseProtection") < leadRoute.indexOf("saveLead"));
});

test("widget renders optional Turnstile without breaking disabled mode", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  assert.match(widget, /abuseProtection = \{ enabled: false/);
  assert.match(widget, /data-cr-abuse/);
  assert.match(widget, /ensureAbuseToken\("chat"\)/);
  assert.match(widget, /abuseProtection\.enabled && abuseProtection\.actions\.includes\("chat"\) && !abuseProtectionToken/);
  assert.match(widget, /input\.value = question/);
  assert.match(widget, /ensureAbuseToken\("lead"\)/);
  assert.match(widget, /abuseProtectionToken/);
  assert.match(widget, /let abuseTokenAction = ""/);
  assert.match(widget, /if \(abuseToken && abuseTokenAction === action\) return abuseToken/);
  assert.match(widget, /if \(abuseToken && abuseTokenAction !== action\) resetAbuseChallenge\(action\)/);
  assert.match(widget, /resetAbuseChallenge\("chat"\)/);
  assert.match(widget, /resetAbuseChallenge\("lead"\)/);
  assert.match(widget, /turnstile\.reset/);
  assert.match(widget, /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/);
  assert.match(widget, /turnstile\.render/);
  assert.match(widget, /Complete the visitor check/);
});

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.SITEREP_STRANGER_PATH_PORT || 8787);
const base = `http://127.0.0.1:${port}`;
const stateDir = await mkdtemp(join(tmpdir(), "siterep-stranger-path-"));
const stamp = Date.now();
const ownerEmail = `stranger-${stamp}@example.com`;
const visitorEmail = `visitor-${stamp}@example.com`;
const sourceTitle = `Shipping and returns ${stamp}`;
const sourceContent =
  "Orders placed before 2pm ship the same working day from our Bristol warehouse. Standard delivery takes three working days. Returns are accepted within thirty days of delivery, and the return label is free.";
const sourceQuestion = "How long does standard delivery take?";
const sourceAnswer = "three working days";
const refusedQuestion = "Do you offer payroll support in Antarctica?";
const timings = {};
const workerLog = [];

const worker = spawn(
  join(repoRoot, "node_modules", ".bin", "wrangler"),
  ["dev", "--local", "--persist-to", stateDir, "--ip", "127.0.0.1", "--port", String(port)],
  { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: true },
);
worker.stdout.on("data", (chunk) => workerLog.push(String(chunk)));
worker.stderr.on("data", (chunk) => workerLog.push(String(chunk)));

async function waitForWorker(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`wrangler dev exited with ${worker.exitCode}.\n${workerLog.join("")}`);
    try {
      const response = await fetch(`${base}/api/health/live`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`wrangler dev was not ready within ${timeoutMs}ms.\n${workerLog.join("")}`);
}

async function stopWorker() {
  try {
    process.kill(-worker.pid, "SIGKILL");
  } catch {}
  try {
    worker.kill("SIGKILL");
  } catch {}
  await rm(stateDir, { recursive: true, force: true });
}

async function widgetFrame(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => candidate.url().includes("widget-test.html"));
    if (frame) return frame;
    await page.waitForTimeout(400);
  }
  throw new Error("The dashboard never framed the install preview page.");
}

async function openWidget(frame) {
  await frame.waitForSelector("#citerep-panel", { state: "attached", timeout: 30000 });
  if (!(await frame.locator("#citerep-panel.cr-open").count())) {
    await frame.locator("#citerep-launcher").click({ force: true });
    await frame.waitForSelector("#citerep-panel.cr-open", { timeout: 20000 });
  }
  await frame.waitForSelector("[data-cr-input]", { timeout: 20000 });
}

async function ask(frame, question) {
  const before = await frame.locator(".cr-msg.cr-bot:not(.cr-typing)").count();
  await frame.fill("[data-cr-input]", question);
  await frame.press("[data-cr-input]", "Enter");
  await frame.waitForFunction(
    (expected) => {
      if (document.querySelector(".cr-typing")) return false;
      return document.querySelectorAll(".cr-msg.cr-bot:not(.cr-typing)").length > expected;
    },
    before,
    { timeout: 45000 },
  );
  return frame.locator(".cr-msg.cr-bot:not(.cr-typing)").last().innerText();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let browser = null;
try {
  await waitForWorker();
  timings.workerReadyMs = Date.now() - stamp;

  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  const httpErrors = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const where = message.location()?.url || "";
    consoleErrors.push(`${message.text().slice(0, 200)}${where ? ` @ ${where}` : ""}`);
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    const url = response.url();
    if (url.startsWith(base) && url.includes("/api/") && response.status() >= 400) {
      httpErrors.push(`${response.status()} ${url.slice(base.length)}`);
    }
  });

  const startedAt = Date.now();
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.click("text=/Start free/i");
  await page.waitForSelector('input[name="siteUrl"]', { timeout: 20000 });
  await page.fill('input[name="siteUrl"]', "example.com");
  await page.fill('input[name="email"]', ownerEmail);
  await page.click('.checkout-modal button[type="submit"]');
  await page.waitForSelector("text=/Lead inbox/i", { timeout: 60000 });
  timings.signupMs = Date.now() - startedAt;

  const session = await page.evaluate(() => window.sessionStorage.getItem("citerep-demo-access"));
  const parsedSession = session ? JSON.parse(session) : {};
  const token = parsedSession?.authSession?.token || "";
  const botId = parsedSession?.customerAccess?.botId || parsedSession?.authSession?.botId || "";
  assert(token, "Sign-up did not persist an owner session in the browser.");
  assert(botId, "Sign-up did not persist the new site id in the browser.");

  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  let crawled = 0;
  let lastSources = [];
  const crawlDeadline = Date.now() + 90000;
  while (Date.now() < crawlDeadline) {
    const response = await fetch(`${base}/api/customer/bot?botId=${encodeURIComponent(botId)}`, { headers: auth });
    if (!response.ok) throw new Error(`GET /api/customer/bot failed with ${response.status}.`);
    const payload = await response.json();
    lastSources = (payload.sources || []).map((source) => ({ id: source.id, status: source.status }));
    crawled = lastSources.filter((source) => source.status === "indexed").length;
    if (crawled > 0) break;
    await page.waitForTimeout(1500);
  }
  assert(crawled > 0, `The sign-up crawl never indexed a source page (last seen: ${JSON.stringify(lastSources)}).`);
  timings.firstCrawlIndexedMs = Date.now() - startedAt;

  const sourceResponse = await fetch(`${base}/api/sources`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ botId, title: sourceTitle, content: sourceContent, url: "https://example.com/shipping" }),
  });
  assert(sourceResponse.ok, `POST /api/sources failed with ${sourceResponse.status}.`);

  const frame = await widgetFrame(page);
  await openWidget(frame);

  const answer = await ask(frame, sourceQuestion);
  timings.firstAnswerMs = Date.now() - startedAt;
  assert(
    answer.toLowerCase().includes(sourceAnswer),
    `The widget did not answer from the customer's own source. Got: ${answer.slice(0, 200)}`,
  );

  const refusal = await ask(frame, refusedQuestion);
  assert(
    /don't have that answer/i.test(refusal),
    `The widget did not refuse an uncovered question. Got: ${refusal.slice(0, 200)}`,
  );

  const emailField = frame.locator('.cr-lead input[name="email"]').last();
  await emailField.fill(visitorEmail);
  await emailField.press("Enter");
  await frame.getByText("Thanks").first().waitFor({ state: "visible", timeout: 20000 });
  timings.leadCapturedMs = Date.now() - startedAt;

  let leadSaved = false;
  const leadDeadline = Date.now() + 30000;
  while (Date.now() < leadDeadline) {
    const response = await fetch(`${base}/api/customer/bot?botId=${encodeURIComponent(botId)}`, { headers: auth });
    const payload = await response.json();
    leadSaved = (payload.leads || []).some((lead) => lead.email === visitorEmail);
    if (leadSaved) break;
    await page.waitForTimeout(1000);
  }
  assert(leadSaved, "The captured lead never reached the customer dashboard.");

  const inboxDeadline = Date.now() + 30000;
  let inboxListed = false;
  while (Date.now() < inboxDeadline) {
    inboxListed = (await page.locator("body").innerText()).includes(visitorEmail);
    if (inboxListed) break;
    await page.waitForTimeout(1000);
  }
  assert(inboxListed, "The dashboard lead inbox did not list the captured visitor.");

  const blocking = consoleErrors.filter((error) => !/favicon/i.test(error));
  assert(blocking.length === 0, `Console errors on the stranger path: ${JSON.stringify(blocking)}`);
  assert(httpErrors.length === 0, `The stranger path hit failed API responses: ${JSON.stringify(httpErrors)}`);

  console.log(JSON.stringify({
    ok: true,
    botId,
    crawledSources: crawled,
    timingsMs: timings,
    signupToFirstAnswerMs: timings.firstAnswerMs,
  }, null, 2));
} catch (error) {
  console.error(String(error && error.message ? error.message : error));
  console.error(JSON.stringify({ ok: false, timingsMs: timings }, null, 2));
  console.error(workerLog.join("").slice(-2000));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await stopWorker();
}

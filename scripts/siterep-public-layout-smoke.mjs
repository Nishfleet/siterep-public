#!/usr/bin/env node
import { spawn } from "node:child_process";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, firefox, webkit } from "playwright";

const root = process.cwd();
const port = Number(process.env.SITEREP_LAYOUT_SMOKE_PORT || 4177);
const externalBaseUrl = process.env.SITEREP_LAYOUT_SMOKE_BASE_URL || "";
const baseUrl = externalBaseUrl || `http://127.0.0.1:${port}`;
const npmBin = process.env.npm_execpath || "npm";
let previewProcess = null;
let currentStep = "starting";
const globalTimeout = setTimeout(() => {
  console.error(`public layout smoke timed out during ${currentStep}`);
  if (previewProcess) killProcessTree(previewProcess, "SIGKILL");
  process.exit(1);
}, Number(process.env.SITEREP_LAYOUT_SMOKE_TIMEOUT_MS || 90000));

function step(label) {
  currentStep = label;
  console.error(`[public-layout-smoke] ${label}`);
}

function killProcessTree(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function fail(message, data) {
  if (data) console.error(JSON.stringify(data, null, 2));
  throw new Error(message);
}

function run(command, args, options = {}) {
  const { timeoutMs = 20000, allowFailure = false, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      detached: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forceKillTimer = null;
    const timer = setTimeout(() => {
      killProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 1500);
      forceKillTimer.unref?.();
      const error = new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`);
      error.stdout = stdout;
      error.stderr = stderr;
      settled = true;
      reject(error);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (settled) return;
      settled = true;
      if (code === 0 || allowFailure) resolve({ stdout, stderr, code });
      else {
        const error = new Error(`${command} ${args.join(" ")} exited ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function buildCurrentAssets() {
  if (externalBaseUrl || process.env.SITEREP_LAYOUT_SMOKE_SKIP_BUILD === "1") return;
  step("building current assets");
  await run(npmBin, ["run", "build"], { timeoutMs: 120000 });
}

async function startPreview() {
  if (externalBaseUrl) return;
  step("starting Vite preview");
  previewProcess = spawn(npmBin, ["run", "preview", "--", "--port", String(port), "--strictPort"], {
    cwd: root,
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  previewProcess.on("exit", (code) => {
    if (code && code !== 0 && code !== 143) {
      console.error(`Vite preview exited early with code ${code}.`);
    }
  });
  await waitForHttp(baseUrl);
}

async function stopPreview() {
  if (!previewProcess) return;
  const child = previewProcess;
  previewProcess = null;
  killProcessTree(child, "SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(2000).then(() => killProcessTree(child, "SIGKILL")),
  ]);
}

async function waitForHttp(url) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await canReach(url)) return;
    await delay(250);
  }
  fail(`Timed out waiting for ${url}`);
}

function canReach(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode && response.statusCode < 500);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(1200, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function launchBrowser() {
  const browserEngines = { chromium, firefox, webkit };
  const requestedEngine = process.env.SITEREP_LAYOUT_SMOKE_BROWSER || "chromium";
  const engine = browserEngines[requestedEngine];
  if (!engine) {
    fail(`unsupported SITEREP_LAYOUT_SMOKE_BROWSER "${requestedEngine}" (use chromium, firefox, or webkit)`, { requestedEngine });
  }
  step(`launching ${requestedEngine}`);
  const baseOptions = {
    headless: true,
    // --no-sandbox is a Chromium flag; Firefox/WebKit must not receive it.
    args: requestedEngine === "chromium" && process.platform === "linux" ? ["--no-sandbox"] : [],
  };
  const requestedChannel = process.env.SITEREP_LAYOUT_BROWSER_CHANNEL;
  const attempts = requestedEngine === "chromium" && requestedChannel ? [{ channel: requestedChannel }] : [{}];
  const errors = [];

  for (const attempt of attempts) {
    try {
      return await engine.launch({ ...baseOptions, ...attempt });
    } catch (error) {
      errors.push(error.message);
    }
  }

  fail("Could not launch a Playwright browser for public layout smoke", { errors });
}

function collectLayout() {
  const pick = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
      text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
    };
  };
  // First-viewport buyer qualifier: the public hero must state who Site Rep
  // is for ("For small business sites") inside the first mobile viewport, so
  // the buying site owner stays explicit behind the visitor-focused h1. This
  // is a rendered-DOM check on the exact phrase's Range rect (not the whole
  // paragraph box): a hero rewrite that drops the qualifier, a stale deploy
  // serving pre-#114 copy, or a layout change that pushes the phrase below
  // the fold all fail here while a paragraph that merely wraps around the
  // phrase still passes.
  const heroQualifier = (() => {
    const hero = document.querySelector(".public-hero");
    if (!hero) return null;
    const walker = document.createTreeWalker(hero, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const match = /\bFor small business sites\b/.exec(node.textContent);
      if (!match) continue;
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rect = range.getBoundingClientRect();
      const style = getComputedStyle(node.parentElement);
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
      };
    }
    return null;
  })();
  return {
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight },
    counts: {
      publicHero: document.querySelectorAll(".public-hero").length,
      proofPanel: document.querySelectorAll(".hero-live-proof-panel").length,
      heroProofStrip: document.querySelectorAll(".hero-proof-strip").length,
      pricing: document.querySelectorAll("#public-pricing").length,
    },
    hero: pick(".public-hero"),
    heroQualifier,
    proofPanel: pick(".hero-live-proof-panel"),
    miniDemo: pick(".hero-live-demo-card"),
    fullDemo: pick("#demo"),
    pricing: pick("#public-pricing"),
    accessNotice: pick(".field-notice"),
    signIn: pick(".signin-card"),
    horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    // Rendered word count, counted exactly like the SEO Fix Kit audit engine's
    // "Thin rendered content" rule (document.body textContent split on
    // whitespace). Kept on the public home so the dogfood finding below has a
    // rendered-DOM guard instead of a source-slice approximation.
    renderedWords: (document.body.textContent || "").split(/\s+/).filter(Boolean).length,
  };
}

async function layout(page) {
  return page.evaluate(collectLayout);
}

function assertPublicLayout(data, label) {
  const height = data.viewport.height;
  if (data.counts.publicHero !== 1) fail(`${label}: expected one public hero`, data);
  if (data.counts.proofPanel !== 1) fail(`${label}: expected one proof panel`, data);
  if (data.counts.heroProofStrip !== 0) fail(`${label}: old hidden proof strip should not render`, data);
  if (data.counts.pricing !== 1) fail(`${label}: expected exactly one public pricing section`, data);
  if (!data.proofPanel?.visible || data.proofPanel.top >= height) fail(`${label}: proof panel is not above the fold`, data);
  if (!data.miniDemo?.visible || data.miniDemo.top >= height) fail(`${label}: mini demo preview is not above the fold`, data);
  if (!data.fullDemo?.visible || data.fullDemo.top >= height) fail(`${label}: full demo should peek into the first viewport`, data);
  if (!data.pricing?.visible || data.pricing.top >= height * 2.5) fail(`${label}: pricing is still buried too deep`, data);
  if (data.horizontalOverflow !== 0) fail(`${label}: page has horizontal overflow`, data);
  if (label === "small-mobile" && data.proofPanel.bottom > height) fail(`${label}: proof and pricing links must fit in the first viewport`, data);
  // First-viewport audience regression: the "For small business sites"
  // qualifier must render fully inside the 390x844 first viewport (the
  // product-live detector's exact surface). Scoped to the mobile viewport:
  // the small-mobile (320x568) hero intentionally hides the paragraph via a
  // media query, and desktop is not the packet's surface.
  if (label === "mobile") {
    if (!data.heroQualifier?.visible || data.heroQualifier.top < 0 || data.heroQualifier.bottom > height) {
      fail(`${label}: the "For small business sites" qualifier must be fully readable inside the first viewport`, data);
    }
  }
  // Dogfood "Thin rendered content on /" (patternKey 845f5442d5a7): the home
  // measured only 79 rendered words on 2026-08-08, under the SEO Fix Kit
  // engine's 250-word thin-content threshold. The content resolution merged
  // via #106/#107/#114 brought the rendered home to ~1.2k words; this floor
  // pins the engine's exact threshold into the rendered-DOM smoke so the
  // public page cannot silently regress to a thin surface again.
  if (data.renderedWords < 250) fail(`${label}: public home renders too few words (${data.renderedWords} < 250)`, data);
}

function assertPrivateSurface(data, label) {
  if (data.counts.publicHero !== 0) fail(`${label}: public hero leaked into private surface`, data);
  if (data.counts.proofPanel !== 0) fail(`${label}: proof panel leaked into private surface`, data);
}

// Resource contract for guest surfaces (dogfood "Slow resource requests on
// home", patternKey 077b7d7781d8): the owner deep-health probe measured ~1.4s
// on the live edge and renders nothing on guest pages, so it must never be
// requested; the localized public pricing preview is product truth and must
// still load.
function trackApiRequests(page) {
  const paths = [];
  const requests = [];
  const handler = (request) => {
    try {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/")) paths.push(url.pathname);
      requests.push(url.href);
    } catch {
      // Ignore malformed request URLs; the contract only cares about /api/*.
    }
  };
  page.on("request", handler);
  return {
    paths,
    requests,
    detach() {
      page.off("request", handler);
    },
  };
}

function assertGuestResourceContract(apiPaths, label, requests = null) {
  const deepHits = apiPaths.filter((path) => path === "/api/health/deep").length;
  const pricingHits = apiPaths.filter((path) => path === "/api/public/pricing").length;
  if (deepHits !== 0) fail(`${label}: guest surface must not request the owner deep health probe (/api/health/deep)`, { apiPaths });
  if (pricingHits < 1) fail(`${label}: guest surface must still request localized public pricing (/api/public/pricing)`, { apiPaths, requests });
}

// When the live target hands back a page that never boots the SPA (for
// example an edge challenge or block page to a datacenter egress), the guest
// resource contract above would fail with an empty request list and no hint
// why. Dump the observable page state so the failure is diagnosable from the
// workflow log instead of looking like a product regression.
async function assertGuestResourceContractWithDiagnostics(page, tracked, label) {
  try {
    assertGuestResourceContract(tracked.paths, label, tracked.requests);
  } catch (error) {
    console.error(`[public-layout-smoke] ${label} failure diagnostics`, JSON.stringify(await pageState(page), null, 2));
    throw error;
  }
}

async function goto(page, path) {
  await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle", timeout: 30000 });
}

async function pageState(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyText: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400),
    rootRendered: Boolean(document.querySelector("#root")?.children.length),
    responseStatus: performance.getEntriesByType("navigation")[0]?.responseStatus ?? null,
  }));
}

// The live edge can hand a datacenter egress a challenge or block document
// instead of the SPA shell on a cold session (observed on the first canary
// run: the Firefox leg got zero /api requests in under a second and aborted
// with no hint). Re-navigating once distinguishes that transient condition
// from a real regression: a genuinely broken SPA stays broken on retry, so
// the retry never masks a product failure — it only absorbs the edge blip.
async function gotoBootedSpa(page, path) {
  await goto(page, path);
  const booted = await page.evaluate(() => Boolean(document.querySelector("#root")?.children.length)).catch(() => false);
  if (booted) return;
  console.error(`[public-layout-smoke] ${path} did not render the SPA root on the first navigation; retrying once`);
  await goto(page, path);
  const bootedAfterRetry = await page.evaluate(() => Boolean(document.querySelector("#root")?.children.length)).catch(() => false);
  if (!bootedAfterRetry) {
    fail(`${path}: the SPA did not render even after a navigation retry`, await pageState(page));
  }
}

async function main() {
  await buildCurrentAssets();
  await startPreview();

  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    step("opening public page");
    const homeRequests = trackApiRequests(page);
    await gotoBootedSpa(page, "/");
    homeRequests.detach();
    await assertGuestResourceContractWithDiagnostics(page, homeRequests, "home");

    step("checking desktop layout");
    await page.setViewportSize({ width: 1366, height: 768 });
    assertPublicLayout(await layout(page), "desktop");

    step("checking mobile layout");
    await page.setViewportSize({ width: 390, height: 844 });
    assertPublicLayout(await layout(page), "mobile");

    step("checking small mobile layout");
    await page.setViewportSize({ width: 320, height: 568 });
    assertPublicLayout(await layout(page), "small-mobile");

    // The site shell must collapse to the viewport at any width, including
    // sub-320 phones. The outer `body { min-width: 320px }` floor that lived
    // on this layout before #fix-siterep-shell-below-320 forced the document
    // to scroll horizontally at viewport widths < 320; this regression
    // re-asserts the shell stays inside the viewport at 240, 260, and 280
    // px. Runs at viewport==content-width so the shell containers' right
    // edge must equal the viewport, not just clip under `overflow-x: hidden`.
    step("checking sub-320 mobile layout");
    for (const width of [240, 260, 280]) {
      await page.setViewportSize({ width, height: 568 });
      const data = await layout(page);
      assertPublicLayout(data, `sub-320-${width}`);
      const containerRight = await page.evaluate(() => {
        const main = document.querySelector("main");
        const header = document.querySelector("header");
        const hero = document.querySelector(".hero");
        return {
          main: main?.getBoundingClientRect()?.right ?? null,
          header: header?.getBoundingClientRect()?.right ?? null,
          hero: hero?.getBoundingClientRect()?.right ?? null,
        };
      });
      if (containerRight.main !== null && containerRight.main > width) {
        fail(`sub-320-${width}: main right edge exceeds viewport`, { width, containerRight });
      }
      if (containerRight.header !== null && containerRight.header > width) {
        fail(`sub-320-${width}: site-header right edge exceeds viewport`, { width, containerRight });
      }
      if (containerRight.hero !== null && containerRight.hero > width) {
        fail(`sub-320-${width}: hero right edge exceeds viewport`, { width, containerRight });
      }
    }

    // The hero "See plans" control must show the four-plan public pricing
    // section instead of opening paid checkout, in both the checkout-ready
    // (live site) and checkout-unavailable (local preview) states. Only the
    // explicit plan-card setup buttons may open paid checkout. This runs in
    // both states so a live-ready regression cannot hide behind the local
    // unavailable-checkout path again.
    step("checking See plans scrolls to public pricing");
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoBootedSpa(page, "/");
    const seePlans = page.locator("button", { hasText: /^See plans$/ });
    await seePlans.first().waitFor({ timeout: 5000 });
    await seePlans.first().click();
    await page.waitForFunction(
      () => {
        const pricing = document.querySelector("#public-pricing")?.getBoundingClientRect();
        return pricing && Math.abs(Math.round(pricing.top)) <= 120;
      },
      null,
      { timeout: 4000 },
    ).catch(() => {});
    await page.waitForFunction(
      () => document.activeElement?.id === "public-pricing",
      null,
      { timeout: 4000 },
    ).catch(() => {});
    const seePlansResult = await page.evaluate(() => ({
      pricingTop: document.querySelector("#public-pricing") ? Math.round(document.querySelector("#public-pricing").getBoundingClientRect().top) : null,
      dialogs: document.querySelectorAll('[role="dialog"][aria-modal="true"]').length,
      focused: document.activeElement?.id === "public-pricing",
      notice: document.querySelector(".field-notice")?.textContent || "",
    }));
    if (seePlansResult.pricingTop === null || Math.abs(seePlansResult.pricingTop) > 120) {
      fail("See plans must scroll to public pricing", { seePlansResult });
    }
    if (seePlansResult.dialogs !== 0) fail("See plans must not open a checkout dialog", { seePlansResult });
    if (!seePlansResult.focused) fail("See plans must move focus to the public pricing section", { seePlansResult });

    // Comparison CTA handoff (SPA half): Worker-rendered /vs pages link their
    // free-start control to the durable /?surface=free-start entry, which the
    // app must turn into the existing FreeStartModal. The Worker-side control
    // rendering is covered by tests/comparison-pages.test.js; here we prove the
    // public entry behavior: the query entry opens the real signup modal,
    // keyboard focus lands inside it, and closing clears the sticky entry. The
    // legacy /#free-start hash entry is covered as a backward-compatible path
    // for already-cached comparison pages.
    step("checking comparison free-start CTA handoff");
    await page.setViewportSize({ width: 1366, height: 768 });
    await goto(page, "/?surface=free-start");
    // The entry opens the modal and the dialog lifecycle moves keyboard focus
    // into the form on a microtask; wait for that handoff instead of racing it.
    await page.waitForSelector('[role="dialog"][aria-modal="true"]', { timeout: 5000 });
    await page.waitForFunction(
      () => {
        const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
        return Boolean(dialog?.contains(document.activeElement));
      },
      null,
      { timeout: 5000 },
    );
    const freeStartHandoff = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      const title = document.querySelector("#free-start-title");
      const submit = dialog?.querySelector("button[type='submit']");
      return {
        dialogOpen: Boolean(dialog),
        heading: title?.textContent || "",
        focusInsideDialog: Boolean(dialog?.contains(document.activeElement)),
        // The dialog promises "no card, no time limit", so its submit action
        // must name the free start — never a time-limited "trial".
        submitLabel: submit?.textContent || "",
        submitHasTrial: /trial/i.test(submit?.textContent || ""),
      };
    });
    if (!freeStartHandoff.dialogOpen) fail("free-start CTA: expected the signup modal to open from /?surface=free-start", freeStartHandoff);
    if (!freeStartHandoff.heading.includes("Start free — no card")) fail("free-start CTA: expected the free-start modal heading", freeStartHandoff);
    if (!freeStartHandoff.focusInsideDialog) fail("free-start CTA: keyboard focus must land inside the signup modal", freeStartHandoff);
    if (!freeStartHandoff.submitLabel) fail("free-start CTA: the modal must render the free-start submit action", freeStartHandoff);
    if (!freeStartHandoff.submitLabel.includes("Start free")) fail("free-start CTA: the free-start submit action must say Start free", freeStartHandoff);
    if (freeStartHandoff.submitHasTrial) fail("free-start CTA: the free-start submit action must not say 'trial' next to the no-time-limit promise", freeStartHandoff);
    await page.keyboard.press("Escape");
    await delay(100);
    const freeStartClosed = await page.evaluate(() => !document.querySelector('[role="dialog"][aria-modal="true"]'));
    if (!freeStartClosed) fail("free-start CTA: Escape must close the signup modal");

    // Closing the entry must clear the sticky ?surface=free-start query: the
    // URL would otherwise claim a signup flow that is no longer open.
    const freeStartParamsAfterClose = await page.evaluate(() => new URLSearchParams(window.location.search).get("surface"));
    if (freeStartParamsAfterClose === "free-start") fail("free-start CTA: closing must clear the sticky ?surface=free-start query", { surface: freeStartParamsAfterClose });
    // Re-entering the durable entry must reopen the modal: the comparison link
    // has to finish the signup handoff on every visit, not just the first.
    await goto(page, "/?surface=free-start");
    await page.waitForSelector('[role="dialog"][aria-modal="true"]', { timeout: 5000 });
    await page.waitForFunction(
      () => {
        const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
        return Boolean(dialog?.contains(document.activeElement));
      },
      null,
      { timeout: 5000 },
    );
    const freeStartReopened = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      return {
        dialogOpen: Boolean(dialog),
        heading: document.querySelector("#free-start-title")?.textContent || "",
        focusInsideDialog: Boolean(dialog?.contains(document.activeElement)),
      };
    });
    if (!freeStartReopened.dialogOpen) fail("free-start CTA: re-entering /?surface=free-start must reopen the signup modal", freeStartReopened);
    if (!freeStartReopened.focusInsideDialog) fail("free-start CTA: the reopened modal must receive keyboard focus", freeStartReopened);
    await page.keyboard.press("Escape");
    await delay(100);

    // Legacy hash entry: already-cached comparison pages still link /#free-start.
    await goto(page, "/#free-start");
    await page.waitForSelector('[role="dialog"][aria-modal="true"]', { timeout: 5000 });
    await page.waitForFunction(
      () => {
        const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
        return Boolean(dialog?.contains(document.activeElement));
      },
      null,
      { timeout: 5000 },
    );
    const legacyHashEntry = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      return {
        dialogOpen: Boolean(dialog),
        heading: document.querySelector("#free-start-title")?.textContent || "",
        focusInsideDialog: Boolean(dialog?.contains(document.activeElement)),
      };
    });
    if (!legacyHashEntry.dialogOpen) fail("free-start CTA: the legacy /#free-start entry must still open the signup modal", legacyHashEntry);
    if (!legacyHashEntry.focusInsideDialog) fail("free-start CTA: the legacy hash entry must receive keyboard focus", legacyHashEntry);
    await page.keyboard.press("Escape");
    await delay(100);
    const freeStartHashAfterClose = await page.evaluate(() => window.location.hash);
    if (freeStartHashAfterClose === "#free-start") fail("free-start CTA: closing must clear the sticky #free-start hash", { hash: freeStartHashAfterClose });

    // End-to-end comparison CTA click-through: the live-delivery defect behind
    // scout 2026-08-08 05:34 IST lived in the Worker-rendered /vs/* pages —
    // activation was a no-op on the live comparison pages for days while the
    // SPA half of the handoff passed every local check. When the smoke target
    // serves those Worker pages (live site or cf:dev via
    // SITEREP_LAYOUT_SMOKE_BASE_URL), click the real CTA anchor on every /vs/*
    // page and prove the signup modal arrives with keyboard focus. The local
    // Vite preview cannot render Worker /vs pages, so there the step is
    // skipped; the Worker-side anchor rendering is pinned by
    // tests/comparison-pages.test.js, which executes the real renderer.
    step("checking comparison free-start CTA click-through");
    const vsProbe = await page.evaluate(async (target) => {
      const response = await fetch(`${target}/vs/chatbase`);
      const html = await response.text();
      return { workerServed: html.includes('href="/?surface=free-start"') };
    }, baseUrl);
    if (!vsProbe.workerServed) {
      console.error("[public-layout-smoke] target does not serve Worker-rendered /vs pages; skipping comparison CTA click-through (covered by tests/comparison-pages.test.js)");
    } else {
      for (const path of ["/vs/customgpt", "/vs/chatbase", "/vs/intercom-fin", "/vs/tidio-lyro", "/vs/webspeaker", "/vs/chatling"]) {
        await goto(page, path);
        const cta = page.locator('a[href="/?surface=free-start"]');
        if ((await cta.count()) === 0) fail(`comparison CTA: ${path} must render the free-start anchor`, { path });
        await cta.first().click();
        await page.waitForSelector('[role="dialog"][aria-modal="true"]', { timeout: 5000 });
        await page.waitForFunction(
          () => {
            const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
            return Boolean(dialog?.contains(document.activeElement));
          },
          null,
          { timeout: 5000 },
        );
        const freeStartE2e = await page.evaluate(() => ({
          url: location.href,
          surface: new URLSearchParams(window.location.search).get("surface"),
          heading: document.querySelector("#free-start-title")?.textContent || "",
          focusInsideDialog: Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')?.contains(document.activeElement)),
        }));
        if (freeStartE2e.surface !== "free-start") fail(`comparison CTA: ${path} click must land on the durable ?surface=free-start entry`, freeStartE2e);
        if (!freeStartE2e.heading.includes("Start free — no card")) fail(`comparison CTA: ${path} click must open the free-start signup modal`, freeStartE2e);
        if (!freeStartE2e.focusInsideDialog) fail(`comparison CTA: ${path} click must move keyboard focus into the signup modal`, freeStartE2e);
        await page.keyboard.press("Escape");
        await delay(100);
        // Closing must clear the sticky ?surface=free-start query on the live
        // path too: the URL would otherwise claim a signup flow that is no
        // longer open, and the comparison link has to stay reusable on the
        // next visit.
        const freeStartE2eAfterClose = await page.evaluate(() => ({
          url: location.href,
          surface: new URLSearchParams(window.location.search).get("surface"),
          dialogOpen: Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')),
        }));
        if (freeStartE2eAfterClose.dialogOpen) fail(`comparison CTA: ${path} Escape must close the signup modal`, freeStartE2eAfterClose);
        if (freeStartE2eAfterClose.surface === "free-start") fail(`comparison CTA: ${path} closing must clear the sticky ?surface=free-start query`, freeStartE2eAfterClose);
      }
    }

    step("checking sign-in surface");
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.evaluate(() => {
      const link = [...document.querySelectorAll("a")].find((item) => item.textContent.trim() === "Sign in");
      link?.click();
      return { clicked: Boolean(link) };
    });
    await delay(100);
    const signInLayout = await layout(page);
    assertPrivateSurface(signInLayout, "sign-in");
    if (!signInLayout.signIn?.visible) fail("sign-in: expected workspace sign-in card", signInLayout);

    step("checking admin surface");
    await goto(page, "/admin");
    assertPrivateSurface(await layout(page), "admin");

    // The pre-auth sign-in page (?surface=customer) is the second measured
    // scope of the same finding (performance-2, /api/health/deep at 1037ms);
    // a fresh guest navigation there must also stay free of the deep probe.
    step("checking guest sign-in resource contract");
    const signInRequests = trackApiRequests(page);
    await goto(page, "/?surface=customer");
    signInRequests.detach();
    await assertGuestResourceContractWithDiagnostics(page, signInRequests, "guest sign-in");

    console.log("public layout smoke passed");
  } finally {
    await Promise.race([browser.close(), delay(5000)]);
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    if (error.stdout) console.error(error.stdout);
    if (error.stderr) console.error(error.stderr);
    process.exitCode = 1;
  })
  .finally(async () => {
    clearTimeout(globalTimeout);
    await stopPreview();
  });

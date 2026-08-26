import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import { skipReasonIfPackageMissing } from "./optional-dev-package.js";

// These privacy facts were verified true in code before publishing:
// the widget uses no cookies/localStorage (sessionStorage only), and visitor
// IPs are used transiently for rate-limiting and never persisted. Promoting
// them to the trust status is under-claiming and over-delivering.
test("trust status publishes the already-true privacy facts", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  // Machine-readable trust-status payload.
  assert.match(worker, /area: "Visitor data minimization"/);
  assert.match(worker, /area: "No tracking cookies"/);
  assert.match(worker, /area: "Sub-processors disclosed"/);

  // Human trust page + privacy page.
  assert.match(worker, /No tracking cookies: the chat widget sets no cookies/);
  assert.match(worker, /Visitor IP addresses are used only transiently in memory/);
  assert.match(worker, /## Sub-processors/);
  assert.match(worker, /Dodo Payments — checkout, subscription, and billing/);
  // The trust page's visible "Last updated" stamp must match the
  // machine-readable TRUST_STATUS_UPDATED_AT constant: a content edit that
  // bumps one and not the other makes the page advertise stale freshness.
  const trustUpdatedAt = worker.match(/const TRUST_STATUS_UPDATED_AT = "([^"]+)"/)?.[1];
  assert.ok(trustUpdatedAt, "TRUST_STATUS_UPDATED_AT constant must exist");
  assert.match(worker, new RegExp(`Last updated: ${trustUpdatedAt}\\.`));
  assert.match(worker, /updatedAt: TRUST_STATUS_UPDATED_AT/);
  assert.match(worker, /customerControl: "Review and export from the private dashboard\."/);
  assert.match(worker, /ownerControl: "Review and export from the private dashboard\."/);
});

test("widget lead form shows a point-of-capture consent line", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");
  assert.match(widget, /We'll only use your details to follow up on your question\./);
  assert.match(widget, /\.cr-lead-consent\{/);
});

const TRUST_OVERFLOW_LI =
  "Abuse and browser safety: public signup/chat/lead/install/feedback routes are rate limited and Worker responses include security headers.";

function extractTrustPageStyle(worker) {
  const renderFn = worker.slice(worker.indexOf("function renderTrustPageHtml"), worker.indexOf("function canonicalUrlFor"));
  const styleStart = renderFn.indexOf("<style>");
  const styleEnd = renderFn.indexOf("</style>");
  assert.ok(styleStart >= 0 && styleEnd > styleStart, "trust-page renderer must emit a style block");
  return renderFn.slice(styleStart, styleEnd + "</style>".length);
}

test("trust page list items wrap at 320px instead of overflowing the article", { skip: skipReasonIfPackageMissing("playwright") }, async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const style = extractTrustPageStyle(worker);

  // Live 2026-08-13 defect: this slash-token list item was 266px inside a
  // 206px box and grew the 320px document to 333px. Copy stays verbatim;
  // the article must wrap, not hide overflow at the document.
  assert.match(worker, new RegExp(TRUST_OVERFLOW_LI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(style, /p,li\{[^}]*overflow-wrap:anywhere/);
  assert.doesNotMatch(style, /(?:html|body)\{[^}]*overflow-x:\s*hidden/);
  assert.doesNotMatch(style, /overflow-x:\s*hidden/);

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${style}
  </head>
  <body>
    <main>
      <article>
        <ul>
          <li>${TRUST_OVERFLOW_LI}</li>
        </ul>
      </article>
    </main>
  </body>
</html>`;

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  try {
    for (const width of [320, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true });
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      const measured = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        overflowingItems: [...document.querySelectorAll("li")]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => ({
            text: element.innerText.trim().replace(/\s+/g, " ").slice(0, 160),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
          })),
      }));
      await page.close();
      assert.equal(
        measured.overflowingItems.length,
        0,
        `${width}px list overflow: ${JSON.stringify(measured.overflowingItems)}`,
      );
      assert.ok(
        measured.scrollWidth <= measured.clientWidth,
        `${width}px document overflow scrollWidth=${measured.scrollWidth} clientWidth=${measured.clientWidth}`,
      );
    }
  } finally {
    await browser.close();
  }
});

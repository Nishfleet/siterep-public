import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const widgetPath = new URL("../public/widget.js", import.meta.url);
const artifactsDir = new URL("../artifacts", import.meta.url);
const artifactsPath = fileURLToPath(artifactsDir);
const apiBase = "http://127.0.0.1:8787";
const port = Number(process.env.SITEREP_WIDGET_HOST_SMOKE_PORT || 0);
const widgetSource = await readFile(widgetPath, "utf8");

const server = createServer((request, response) => {
  if (request.url === "/widget.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(widgetSource);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Docs host smoke</title>
    <style>
      body{font-family:system-ui;margin:0;color:#111614;background:#fbfcfa}
      header{position:sticky;top:0;z-index:20;background:white;border-bottom:1px solid #dfe5da;padding:14px 22px}
      main{display:grid;grid-template-columns:220px minmax(0,1fr);gap:28px;max-width:1040px;margin:0 auto;padding:28px 18px 120px}
      nav{position:sticky;top:70px;align-self:start;background:white;border:1px solid #dfe5da;border-radius:8px;padding:14px}
      article{min-width:0}
      h1{font-size:42px;margin:0 0 14px}
      p,li{line-height:1.6}
      .host-overlay{position:fixed;right:24px;bottom:92px;z-index:500;background:#fff4df;border:1px solid #f0d38a;border-radius:8px;padding:9px 12px}
      @media(max-width:720px){main{display:block}.host-overlay{left:12px;right:auto;bottom:76px}}
    </style>
  </head>
  <body>
    <header>Example Docs</header>
    <main>
      <nav><strong>Docs nav</strong><p>Install</p><p>Sources</p><p>Billing</p></nav>
      <article>
        <h1>Install the assistant</h1>
        <p>This page represents a customer documentation site with sidebars, sticky headers, and a small host overlay.</p>
        <button type="button" onclick="document.querySelector('.host-overlay').hidden = !document.querySelector('.host-overlay').hidden">Toggle host overlay</button>
        <div style="height:900px"></div>
      </article>
    </main>
    <div class="host-overlay">Host overlay</div>
    <script>
      window.siterep = {
        botId: "docs-smoke",
        publicKey: "pk_docs_smoke",
        apiBase: "${apiBase}",
        mode: "docs",
        hotkey: "mod+k"
      };
    </script>
    <script src="/widget.js" defer></script>
  </body>
</html>`);
});

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const hostUrl = `http://127.0.0.1:${server.address().port}`;
await mkdir(artifactsPath, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const conversations = [];
const leads = [];
const corsHeaders = {
  "access-control-allow-origin": hostUrl,
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: corsHeaders,
    body: JSON.stringify(body),
  });
}

await page.route(`${apiBase}/api/public/**`, async (route) => {
  const url = new URL(route.request().url());
  if (route.request().method() === "OPTIONS") {
    await route.fulfill({ status: 204, headers: corsHeaders });
    return;
  }
  const body = route.request().postDataJSON?.() || {};
  if (url.pathname === "/api/public/config") {
    await fulfillJson(route, {
        botId: "docs-smoke",
        widgetSettings: {
          title: "Docs assistant",
          welcomeMessage: "Ask about these docs.",
          theme: "#1f8f5f",
          mode: "docs",
          hotkey: "mod+k",
          suggestedQuestions: ["How do I install it?", "Which sources were used?"],
        },
        sourceManifest: { sourceCount: 2, retrievableCount: 2, staleCount: 0, sources: [] },
        abuseProtection: { enabled: false, provider: "turnstile", siteKey: "", actions: [] },
        lifecycleStatus: "live",
        planLimits: {},
        brandingRequired: true,
    });
    return;
  }
  if (url.pathname === "/api/public/install") {
    await fulfillJson(route, { ok: true, installs: [{ origin: hostUrl, count: 1 }] });
    return;
  }
  if (url.pathname === "/api/public/chat") {
    const unknown = /tax|payroll/i.test(body.question || "");
    const conversation = { id: Date.now() + conversations.length };
    conversations.push(conversation);
    await fulfillJson(route, {
        answer: unknown ? "I don't have that answer yet. Leave your email below and the team will get back to you directly." : "Paste the script before the closing body tag, then publish the docs site.",
        unknown,
        confidence: unknown ? "none" : "high",
        sources: unknown
          ? []
          : [
              {
                id: "docs-install",
                title: "Install Site Rep Docs Mode",
                url: "https://siterep.net/docs/install",
                excerpt: "Docs Mode uses one script tag with data-mode docs and data-hotkey mod+k.",
              },
            ],
        leadPrompt: unknown,
        conversation,
    });
    return;
  }
  if (url.pathname === "/api/public/leads") {
    leads.push(body);
    await fulfillJson(route, { ok: true, id: "lead_smoke", conversationId: body.conversationId });
    return;
  }
  await fulfillJson(route, { ok: true });
});

async function runDocsFlow(viewport, screenshotName) {
  await page.setViewportSize(viewport);
  await page.goto(hostUrl, { waitUntil: "networkidle" });
  const launcher = page.locator("#citerep-launcher");
  await launcher.waitFor({ state: "visible" });
  await expectText(launcher, "Ask AI");
  await launcher.click();
  await page.locator("#citerep-panel.cr-open").waitFor({ state: "visible" });
  await page.locator("[data-cr-input]").waitFor({ state: "visible" });
  await page.locator(".cr-close").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await page.locator("#citerep-panel.cr-open").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "How do I install it?" }).click();
  // Scope answer assertions to the bot message bubble: the widget's screen-reader
  // live region (div.cr-hp[data-cr-announcer]) echoes every bot answer verbatim
  // and is never cleared, so a bare getByText strict-mode-resolves to two elements.
  await expectBotAnswer("Paste the script before the closing body tag");
  const sourceToggle = page.getByRole("button", { name: /Used 1 source/ });
  await sourceToggle.click();
  await page.getByText("Install Site Rep Docs Mode").waitFor({ state: "visible" });
  await page.getByText("https://siterep.net/docs/install").waitFor({ state: "visible" });
  await page.getByText("Docs Mode uses one script tag").waitFor({ state: "visible" });
  await page.locator("[data-cr-input]").fill("Can it file my taxes?");
  await page.keyboard.press("Enter");
  await expectBotAnswer("I don't have that answer yet");
  await page.locator('.cr-lead input[name="email"]').last().fill("visitor@example.com");
  await page.locator(".cr-lead button").last().click();
  await page.getByText("Thanks").waitFor({ state: "visible" });
  const panelBox = await page.locator("#citerep-panel").boundingBox();
  if (!panelBox || panelBox.x < -1 || panelBox.y < -1 || panelBox.x + panelBox.width > viewport.width + 1 || panelBox.y + panelBox.height > viewport.height + 1) {
    throw new Error(`Docs Mode panel escaped viewport ${JSON.stringify({ viewport, panelBox })}`);
  }
  await page.screenshot({ path: join(artifactsPath, screenshotName), fullPage: false });
}

async function expectText(locator, text) {
  const value = (await locator.textContent()) || "";
  if (!value.includes(text)) throw new Error(`Expected ${text}, got ${value}`);
}

async function expectBotAnswer(text) {
  await page.locator(".cr-msg.cr-bot").getByText(text).waitFor({ state: "visible" });
}

try {
  await runDocsFlow({ width: 1366, height: 768 }, "docs-mode-desktop.png");
  await runDocsFlow({ width: 390, height: 844 }, "docs-mode-mobile.png");
  if (!leads.some((lead) => lead.conversationId)) throw new Error("Lead capture did not preserve conversation linkage.");
  console.log(JSON.stringify({ ok: true, hostUrl, conversations: conversations.length, leads: leads.length, screenshots: ["artifacts/docs-mode-desktop.png", "artifacts/docs-mode-mobile.png"] }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

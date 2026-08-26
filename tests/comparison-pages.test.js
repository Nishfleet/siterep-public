import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const VS_PATHS = ["/vs", "/vs/customgpt", "/vs/chatbase", "/vs/intercom-fin", "/vs/tidio-lyro", "/vs/webspeaker", "/vs/chatling"];

test("comparison pages are registered, discoverable, and listed for AI agents", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const sitemap = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  const llms = await readFile(new URL("../public/llms.txt", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const index = await readFile(new URL("../index.html", import.meta.url), "utf8");

  for (const path of VS_PATHS) {
    assert.match(worker, new RegExp(`"${path}": \\{`), `${path} must be a registered TRUST_PAGES entry`);
    assert.match(sitemap, new RegExp(`https://siterep\\.net${path}`), `${path} must be in the sitemap`);
    assert.match(llms, new RegExp(path), `${path} must be listed in llms.txt`);
    assert.match(app, new RegExp(`href: "${path}"`), `${path} must be linked from the rendered homepage`);
    assert.match(index, new RegExp(`href="${path}"`), `${path} must be linked from the static homepage fallback`);
  }
  assert.match(worker, /Honest comparison pages are available at \[All comparisons\]\(\/vs\), \[CustomGPT\]\(\/vs\/customgpt\), \[Chatbase\]\(\/vs\/chatbase\), \[Intercom Fin\]\(\/vs\/intercom-fin\), \[Tidio Lyro\]\(\/vs\/tidio-lyro\), \[WebSpeaker\]\(\/vs\/webspeaker\), and \[Chatling\]\(\/vs\/chatling\)\./);
  // The /vs hub lists every comparison page so the hub collects link equity
  // for the whole cluster, including the WebSpeaker and Chatling leaves
  // (scout 2026-08-09, 2026-08-21).
  const hubStart = worker.indexOf("const VS_HUB_MARKDOWN =");
  assert.ok(hubStart >= 0, "VS_HUB_MARKDOWN must exist");
  const hubBody = worker.slice(hubStart, worker.indexOf("\n`;", hubStart));
  assert.match(hubBody, /description: Compare Site Rep with CustomGPT, Chatbase, Intercom Fin, Tidio Lyro, WebSpeaker, and Chatling/, "the hub description must name all six comparison pages");
  const hubLeafLabels = { "/vs/customgpt": "CustomGPT", "/vs/chatbase": "Chatbase", "/vs/intercom-fin": "Intercom Fin", "/vs/tidio-lyro": "Tidio Lyro", "/vs/webspeaker": "WebSpeaker", "/vs/chatling": "Chatling" };
  for (const [path, label] of Object.entries(hubLeafLabels)) {
    assert.ok(hubBody.includes(`[${label}](${path})`), `the hub body must list ${path}`);
  }
  // The hub's own TRUST_PAGES description matches the front matter list.
  assert.match(worker, /"\/vs": \{\s*\n\s*title: "Site Rep comparisons",\s*\n\s*description: "Honest, dated comparisons of Site Rep with CustomGPT, Chatbase, Intercom Fin, Tidio Lyro, WebSpeaker, and Chatling/, "the /vs TRUST_PAGES description must name all six comparison pages");
  // Internal link equity from the shared trust-page footer.
  for (const path of VS_PATHS) {
    assert.match(worker, new RegExp(`path: "${path}"`), `${path} must be linked from the shared comparison link list`);
  }
});

test("the /vs hub is a self-canonical index page with an h1 naming the comparison index (scout 2026-08-13 closure pin)", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const sitemap = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");

  // The scout defect: /vs 404'd while the four leaves were 200 and cross-linked
  // each other, so directory-truncating crawlers hit a hard 404 instead of a
  // comparison index. The closure contract ("Done when") is: /vs returns 200
  // with an h1 naming the comparison index, a self-canonical, links to all
  // leaves with human labels, and a sitemap entry with a current lastmod.
  const hubStart = worker.indexOf("const VS_HUB_MARKDOWN =");
  assert.ok(hubStart >= 0, "VS_HUB_MARKDOWN must exist");
  const hubBody = worker.slice(hubStart, worker.indexOf("\n`;", hubStart));

  // h1 naming the comparison index, not a leaf or a generic title.
  assert.match(hubBody, /^# Site Rep comparisons$/m, "the hub must render an h1 naming the comparison index");

  // Every leaf is linked from the hub with its human label (no raw paths).
  const hubLeafLabels = { "/vs/customgpt": "CustomGPT", "/vs/chatbase": "Chatbase", "/vs/intercom-fin": "Intercom Fin", "/vs/tidio-lyro": "Tidio Lyro", "/vs/webspeaker": "WebSpeaker" };
  for (const [path, label] of Object.entries(hubLeafLabels)) {
    assert.ok(hubBody.includes(`[${label}](${path})`), `the hub must link ${path} with its human label`);
  }
  assert.doesNotMatch(hubBody, /\]\(\/vs\/[a-z-]+\)\s*—\s*\/vs\//, "the hub must not render a raw path as link text");

  // The worker emits a canonical for /vs (self-canonical) via canonicalUrlFor.
  assert.match(worker, /function canonicalUrlFor\(pathname\)/, "the worker must have a canonical URL builder");
  assert.ok(worker.includes('canonicalUrlFor(page.pathname || "/")'), "the worker must emit a canonical per page");

  // The hub's TRUST_PAGES entry is registered and carries a description.
  assert.match(worker, /"\/vs": \{\s*\n\s*title: "Site Rep comparisons",/, "the /vs TRUST_PAGES entry must be registered");

  // The hub is in the sitemap with a lastmod (presence, not staleness — the
  // live monitor pins the freshness floor).
  assert.match(sitemap, /<loc>https:\/\/siterep\.net\/vs<\/loc>\s*<lastmod>/, "the sitemap must include /vs with a lastmod");

  // The homepage links to the hub with a human label ("All comparisons").
  assert.match(app, /name: "All comparisons",\s*\n\s*href: "\/vs"/, "the homepage comparison grid must link the hub with a human label");
});

test("short comparison guesses redirect to the real dated pages instead of soft-falling to the homepage", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  // The alias map: short visitor guesses point at the canonical dated pages.
  assert.match(worker, /\/vs\/intercom": "\/vs\/intercom-fin"/, "/vs/intercom must alias the Intercom Fin page");
  assert.match(worker, /\/vs\/tidio": "\/vs\/tidio-lyro"/, "/vs/tidio must alias the Tidio Lyro page");

  // The worker resolves the alias before the SPA soft-fallback serves the
  // homepage, and only for GET/HEAD requests.
  assert.match(worker, /const aliasTarget = comparisonAliasFor\(url\)/, "the fetch path must resolve the comparison alias");
  assert.match(worker, /if \(request\.method === "GET" \|\| request\.method === "HEAD"\)/, "the alias redirect must apply to GET and HEAD");
  assert.match(worker, /withSecurityHeaders\(Response\.redirect\(new URL\(aliasTarget, url\)\.toString\(\), 301\)\)/, "the alias must 301 to the canonical page on the same origin");
  assert.ok(worker.indexOf("const aliasTarget = comparisonAliasFor(url)") < worker.indexOf("const trustPage = trustPageFor(url)"), "the alias redirect must run before the trust page lookup");

  // Every alias target is a real registered page (and the aliases themselves
  // are never registered as duplicate content pages).
  for (const target of ["/vs/intercom-fin", "/vs/tidio-lyro"]) {
    assert.match(worker, new RegExp(`"${target}": \\{`), `${target} must stay a registered TRUST_PAGES entry`);
  }
  assert.doesNotMatch(worker, /"\/vs\/intercom": \{|"\/vs\/tidio": \{/, "aliases must not create duplicate registered pages");
});

test("comparison page html titles come from front matter instead of duplicate route labels", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  assert.match(worker, /const title = frontmatterTitle \|\| `Site Rep \| \$\{page\.title\}`/);
  assert.match(worker, /function markdownFrontmatterValue\(markdown, key\)/);
  assert.match(worker, /title: Site Rep vs CustomGPT \| Cited answers, local pricing/);
  assert.match(worker, /title: Site Rep vs Intercom Fin \| Local-price website answers/);
  assert.match(worker, /title: Site Rep vs WebSpeaker \| Local checkout, cited answers/);
  assert.match(worker, /title: Site Rep vs Chatling \| Local checkout, cited answers/);
  assert.match(worker, /title: Site Rep comparisons \| Honest, dated alternatives/);
  assert.match(worker, /"\/vs": \{\s*\n\s*title: "Site Rep comparisons",/, "the hub H1 source stays Site Rep comparisons");

  const extractBlock = (startNeedle, endNeedles) => {
    const start = worker.indexOf(startNeedle);
    assert.ok(start >= 0, `${startNeedle} must exist`);
    let end = worker.length;
    for (const needle of endNeedles) {
      const idx = worker.indexOf(needle, start + startNeedle.length);
      if (idx >= 0 && idx < end) end = idx;
    }
    return worker.slice(start, end);
  };
  const prefix = "const VS_HUB_MARKDOWN = `";
  const hubRaw = extractBlock(prefix, ["\n`;"]);
  const hubMarkdown = hubRaw.slice(prefix.length);
  const frontmatterTitle = hubMarkdown.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  assert.equal(frontmatterTitle, "Site Rep comparisons | Honest, dated alternatives");

  const escapeHtmlFn = extractBlock("function escapeHtml", ["\nfunction withVaryAccept"]);
  const renderInlineHtmlFn = extractBlock("function renderInlineHtml", ["\nfunction jsonLdScript"]);
  const markdownBodyToHtmlFn = extractBlock("function markdownBodyToHtml", ["\nfunction renderInlineHtml"]);
  const markdownFrontmatterValueFn = extractBlock("function markdownFrontmatterValue", ["\nfunction markdownBodyToHtml"]);
  const jsonLdScriptFn = extractBlock("function jsonLdScript", ["\nfunction slugify"]);
  const renderTrustPageHtmlFn = extractBlock("function renderTrustPageHtml", ["\nfunction canonicalUrlFor"]);
  const { renderTrustPageHtml } = new Function(
    `"use strict";
const COMPARISON_LINKS = [{ path: "/vs", label: "All comparisons" }];
const SOCIAL_IMAGE_URL = "https://siterep.net/social-card.png";
const BUYER_INTENT_PATH = "/ai-website-chatbot-for-small-business";
function canonicalUrlFor(pathname) { return "https://siterep.net" + pathname; }
function docsInstallBody(markdown) { return markdown; }
${escapeHtmlFn}
${renderInlineHtmlFn}
${markdownBodyToHtmlFn}
${markdownFrontmatterValueFn}
${jsonLdScriptFn}
${renderTrustPageHtmlFn}
return { renderTrustPageHtml };`,
  )();

  const html = renderTrustPageHtml({
    pathname: "/vs",
    title: "Site Rep comparisons",
    description: "Honest, dated comparisons of Site Rep with CustomGPT, Chatbase, Intercom Fin, Tidio Lyro, WebSpeaker, and Chatling.",
    markdown: hubMarkdown,
  });
  const renderedTitle = html.match(/<title>([^<]*)<\/title>/)?.[1];
  assert.notEqual(renderedTitle, "Site Rep | Site Rep comparisons");
  assert.equal(renderedTitle, frontmatterTitle);
  assert.match(html, /<h1>Site Rep comparisons<\/h1>/);
});

test("comparison pages stay honest: dated claims, sourced pricing, and a fit caveat", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  const blocks = {
    VS_CUSTOMGPT_MARKDOWN: "customgpt.ai/pricing",
    VS_CHATBASE_MARKDOWN: "chatbase.co/pricing",
    VS_INTERCOM_MARKDOWN: "intercom.com/pricing",
    VS_TIDIO_MARKDOWN: "tidio.com/pricing",
    VS_WEBSpeaker_MARKDOWN: "webspeaker.pro/pricing",
    VS_CHATLING_MARKDOWN: "chatling.ai/pricing",
  };
  for (const [name, pricingSource] of Object.entries(blocks)) {
    const start = worker.indexOf(`const ${name} =`);
    assert.ok(start >= 0, `${name} must exist`);
    const body = worker.slice(start, worker.indexOf("\n`;", start));
    // Every competitor claim is date-stamped so it can't silently go stale.
    assert.match(body, /as of (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}/i, `${name} must date-stamp competitor facts`);
    // ...and points to the vendor's own pricing page as the source of truth.
    assert.ok(body.includes(pricingSource), `${name} must link ${pricingSource}`);
    // ...and never overclaims: each page says where the competitor fits better.
    assert.match(body, /may fit better/i, `${name} must include a candid fit caveat`);
    // Site Rep's own verifiable hook appears on every page without hardcoding
    // buyer-visible pricing away from the live local checkout.
    assert.match(body, /buyer-local total|buyer's local currency/i, `${name} must state Site Rep's local checkout pricing`);
    assert.doesNotMatch(body, /Site Rep Starter is \$9\/month|\$9\/month for 1,000/i, `${name} must not hardcode Site Rep public prices`);
    assert.match(body, /50 source-backed answers/i, `${name} must state the no-card free trial`);
    assert.match(body, /Compare Site Rep with/i, `${name} must cross-link the comparison cluster`);
  }

  const inlineRenderer = worker.slice(worker.indexOf("function renderInlineHtml"), worker.indexOf("function escapeHtml"));
  for (const path of VS_PATHS) {
    assert.ok(inlineRenderer.includes(path.slice(1).replaceAll("/", "\\/")), `${path} must be converted into a real rendered link`);
  }
});

test("every comparison page renders an actionable free-start link from the Try Site Rep free section", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  const extractBlock = (startNeedle, endNeedles) => {
    const start = worker.indexOf(startNeedle);
    assert.ok(start >= 0, `${startNeedle} must exist`);
    let end = worker.length;
    for (const needle of endNeedles) {
      const idx = worker.indexOf(needle, start + startNeedle.length);
      if (idx >= 0 && idx < end) end = idx;
    }
    return worker.slice(start, end);
  };
  const escapeHtmlFn = extractBlock("function escapeHtml", ["\nfunction withVaryAccept"]);
  const renderInlineHtmlFn = extractBlock("function renderInlineHtml", ["\nfunction jsonLdScript"]);
  const markdownBodyToHtmlFn = extractBlock("function markdownBodyToHtml", ["\nfunction renderInlineHtml"]);
  const { markdownBodyToHtml } = new Function(`"use strict";\n${escapeHtmlFn}\n${renderInlineHtmlFn}\n${markdownBodyToHtmlFn}\nreturn { markdownBodyToHtml };`)();

  const blocks = ["VS_CUSTOMGPT_MARKDOWN", "VS_CHATBASE_MARKDOWN", "VS_INTERCOM_MARKDOWN", "VS_TIDIO_MARKDOWN", "VS_WEBSpeaker_MARKDOWN", "VS_CHATLING_MARKDOWN"];
  for (const name of blocks) {
    const markdown = extractBlock(`const ${name} = \``, ["\n`;"]);
    const html = markdownBodyToHtml(markdown);
    const sectionStart = html.indexOf("<h2>Try Site Rep free</h2>");
    assert.ok(sectionStart >= 0, `${name} must render a Try Site Rep free heading`);
    const section = html.slice(sectionStart, html.indexOf("<h2>Compare Site Rep with</h2>", sectionStart));
    // The free-start control is a real anchor to the durable /?surface=free-start
    // signup entry (a query entry, not a same-page pricing fragment), so
    // Enter/Space activation works through native link semantics and survives
    // navigation paths that strip URL fragments.
    assert.match(section, /<a href="\/\?surface=free-start">Start free<\/a>/, `${name} must render the free-start CTA with a human label instead of the raw URL`);
    assert.doesNotMatch(section, /href="\/#public-pricing"/, `${name} must not point the CTA at a pricing fragment`);
    // The 50 source-backed answers and no-card explanation survive the render.
    assert.match(section, /50 source-backed answers and no card/i, `${name} must keep the no-card 50-answer explanation`);
    // Only the intended free-start path becomes a link inside the section.
    assert.equal(section.match(/href="/g).length, section.match(/href="\/\?surface=free-start"/g).length, `${name} must not linkify anything else in the free-start section`);
    // The comparison cluster cross-links still render after the CTA.
    const compareSection = html.slice(html.indexOf("<h2>Compare Site Rep with</h2>", sectionStart));
    for (const path of VS_PATHS) {
      assert.ok(compareSection.includes(`href="${path}"`), `${name} must still render the ${path} cross-link`);
    }
    // The cluster cross-links must show human labels, never the raw path as
    // link text (the same human-label rule the CTA already follows; the
    // footer on these pages uses the same labels).
    const clusterLabels = { "/vs/customgpt": "CustomGPT", "/vs/chatbase": "Chatbase", "/vs/intercom-fin": "Intercom Fin", "/vs/tidio-lyro": "Tidio Lyro", "/vs/webspeaker": "WebSpeaker", "/vs/chatling": "Chatling" };
    for (const [path, label] of Object.entries(clusterLabels)) {
      assert.ok(compareSection.includes(`<a href="${path}">${label}</a>`), `${name} must render the ${path} cross-link with its human label`);
      assert.doesNotMatch(compareSection, new RegExp(`>${path}</a>`), `${name} must not render the raw ${path} as link text`);
    }
    // The Useful links section follows the same human-label rule: no bare
    // paths as visible link text, including the bare root homepage link.
    const usefulSection = html.slice(html.indexOf("<h2>Useful links</h2>", sectionStart));
    assert.ok(usefulSection.includes('<a href="/trust">Trust and data handling</a>'), `${name} must render the trust link with a human label`);
    assert.doesNotMatch(usefulSection, />\/<\/a>/, `${name} must not render the raw root path as link text`);
    assert.doesNotMatch(usefulSection, />\/trust<\/a>/, `${name} must not render the raw /trust as link text`);
    // The body copy follows the same human-label rule: the trust-note bullet
    // links to /trust with a human label, never the raw path as link text.
    const howDifferentStart = html.indexOf("<h2>How Site Rep is different</h2>");
    const howDifferentEnd = html.indexOf("<h2>Where ", howDifferentStart);
    assert.ok(howDifferentStart >= 0 && howDifferentEnd > howDifferentStart, `${name} must render the How Site Rep is different section`);
    const howDifferentSection = html.slice(howDifferentStart, howDifferentEnd);
    assert.ok(howDifferentSection.includes('<a href="/trust">trust page</a>'), `${name} must render the trust-note link with a human label`);
    assert.doesNotMatch(howDifferentSection, />\/trust<\/a>/, `${name} must not render the raw /trust as link text in the body copy`);
    assert.doesNotMatch(html, />\/trust<\/a>/, `${name} must not render the raw /trust as link text anywhere`);
  }
  // The free-start linkifier must stay available for the Worker-rendered pages:
  // the emitted /?surface=free-start query entry turns into a real anchor, and
  // the legacy /#free-start hash stays linkified for already-cached pages.
  assert.match(worker, /\\\?surface=free-start/, "the Worker linkifier must turn /?surface=free-start into a real anchor");
  assert.match(worker, /#free-start\|\\\?surface=free-start\)\?/, "the Worker linkifier must keep the legacy /#free-start hash linkified next to the query entry");

  // URL-to-signup handoff: the durable query entry opens the existing public
  // FreeStartModal — one signup implementation, no dead fragment. The legacy
  // hash entry stays supported for already-cached comparison pages.
  assert.match(app, /params\.get\("surface"\) === "free-start"/, "the SPA must react to the comparison /?surface=free-start query entry");
  assert.match(app, /window\.location\.hash === "#free-start" \|\| params\.get\("surface"\) === "free-start"/, "the SPA must open the modal from either durable entry");
  assert.match(app, /setFreeStartOpen\(true\)/, "the SPA must open the existing free-start modal state");
  assert.match(app, /<FreeStartModal onClose=\{closeFreeStart\}/, "the SPA must reuse the existing FreeStartModal entry path");

  // Closing the entry must not leave a sticky ?surface=free-start query or
  // #free-start hash: the URL would claim a signup flow that is no longer
  // open, and re-entering the same hash fires no hashchange, silently
  // dead-ending the shared path. The close path clears the entry so the
  // comparison CTA keeps finishing the handoff on every visit.
  assert.match(app, /function closeFreeStart\(\)/, "the SPA must have a single named close path for the free-start modal");
  assert.match(app, /function closeFreeStart\(\) \{\s*\n\s*setFreeStartOpen\(false\);/, "the close path must close the existing modal state");
  assert.match(app, /params\.get\("surface"\) === "free-start"/, "the close path must detect the sticky ?surface=free-start query entry");
  assert.match(app, /params\.delete\("surface"\);/, "closing the query entry must remove the sticky ?surface=free-start parameter");
  assert.match(app, /window\.history\.replaceState\(null, "", `\$\{window\.location\.pathname\}/, "closing the query entry must rewrite the URL without losing other query parameters");
  assert.match(app, /window\.history\.replaceState\(null, "", window\.location\.pathname \+ window\.location\.search\)/, "closing must clear the sticky #free-start hash without adding history noise");
  assert.match(app, /if \(window\.location\.hash === "#free-start"\) \{\s*\n\s*window\.history\.replaceState/, "the close path must only clear the hash when the comparison CTA entry is active");
});

test("every comparison leaf carries a pricing-check stamp within 60 days that matches sitemap lastmod", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const sitemap = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");

  const MONTHS = {
    January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
    July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
  };
  const MONTH = "(January|February|March|April|May|June|July|August|September|October|November|December)";
  const CHECKED_IN = new RegExp(`checked in ${MONTH} (\\d{4})`, "g");
  const AS_OF = new RegExp(`as of ${MONTH} (\\d{4})`, "gi");
  const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

  const extractBlock = (startNeedle, endNeedles) => {
    const start = worker.indexOf(startNeedle);
    assert.ok(start >= 0, `${startNeedle} must exist`);
    let end = worker.length;
    for (const needle of endNeedles) {
      const idx = worker.indexOf(needle, start + startNeedle.length);
      if (idx >= 0 && idx < end) end = idx;
    }
    return worker.slice(start, end);
  };
  const escapeHtmlFn = extractBlock("function escapeHtml", ["\nfunction withVaryAccept"]);
  const renderInlineHtmlFn = extractBlock("function renderInlineHtml", ["\nfunction jsonLdScript"]);
  const markdownBodyToHtmlFn = extractBlock("function markdownBodyToHtml", ["\nfunction renderInlineHtml"]);
  const { markdownBodyToHtml } = new Function(`"use strict";\n${escapeHtmlFn}\n${renderInlineHtmlFn}\n${markdownBodyToHtmlFn}\nreturn { markdownBodyToHtml };`)();

  const registeredLeaves = [...worker.matchAll(/"(\/vs\/[^"]+)": \{/g)].map((match) => match[1]);
  const leafPaths = VS_PATHS.filter((path) => path !== "/vs");
  assert.deepEqual([...new Set(registeredLeaves)].sort(), [...leafPaths].sort(), "every registered /vs/<competitor> leaf must be in the freshness set");

  const stampDate = (month, year) => Date.UTC(Number(year), MONTHS[month], 1);

  for (const path of leafPaths) {
    const entryStart = worker.indexOf(`"${path}": {`);
    assert.ok(entryStart >= 0, `${path} must be a registered TRUST_PAGES entry`);
    const nameMatch = worker.slice(entryStart, entryStart + 800).match(/markdown:\s*(VS_\w+_MARKDOWN)/);
    assert.ok(nameMatch, `${path} must point at a VS_*_MARKDOWN constant`);
    const markdown = extractBlock(`const ${nameMatch[1]} = \``, ["\n`;"]);
    const html = markdownBodyToHtml(markdown);

    const checked = [...html.matchAll(CHECKED_IN)];
    assert.ok(checked.length >= 1, `${path} must render a "checked in <Month YYYY>" stamp`);
    const [, checkedMonth, checkedYear] = checked[0];
    for (const extra of checked.slice(1)) {
      assert.equal(`${extra[1]} ${extra[2]}`, `${checkedMonth} ${checkedYear}`, `${path} must not mix checked-in months`);
    }

    const asOf = [...html.matchAll(AS_OF)];
    assert.ok(asOf.length >= 1, `${path} must render an "as of <Month YYYY>" stamp`);
    for (const match of asOf) {
      assert.equal(`${match[1]} ${match[2]}`, `${checkedMonth} ${checkedYear}`, `${path} in-body "as of" stamp must match the pricing-note month`);
    }

    const ageMs = Date.now() - stampDate(checkedMonth, checkedYear);
    assert.ok(ageMs >= 0, `${path} stamp ${checkedMonth} ${checkedYear} must not be in the future`);
    assert.ok(ageMs <= MAX_AGE_MS, `${path} stamp ${checkedMonth} ${checkedYear} is older than 60 days`);

    const loc = `https://siterep.net${path}`;
    const lastmodMatch = sitemap.match(new RegExp(`<loc>${loc.replaceAll(".", "\\.")}</loc>\\s*<lastmod>(\\d{4})-(\\d{2})-\\d{2}</lastmod>`));
    assert.ok(lastmodMatch, `${path} must have a sitemap lastmod`);
    assert.equal(Number(lastmodMatch[1]), Number(checkedYear), `${path} sitemap lastmod year must match the stamp`);
    assert.equal(Number(lastmodMatch[2]), MONTHS[checkedMonth] + 1, `${path} sitemap lastmod month must match the stamp`);
  }
});

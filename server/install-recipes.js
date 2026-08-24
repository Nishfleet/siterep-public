export const INSTALL_RECIPE_PLATFORMS = Object.freeze([
  "mintlify",
  "docusaurus",
  "gitbook",
  "static-docs",
  "webflow",
  "framer",
  "generic",
  "wordpress",
]);

export function canonicalEmbedSnippet({
  widgetUrl = "https://siterep.net/widget.js",
  botId = "YOUR_BOT_ID",
  publicKey = "YOUR_PUBLIC_WIDGET_KEY",
  apiBase = "https://siterep.net",
  theme = "#1f8f5f",
  mode = "docs",
  hotkey = "mod+k",
} = {}) {
  return `<script src="${widgetUrl}" defer data-bot-id="${botId}" data-public-key="${publicKey}" data-api-base="${apiBase}" data-theme="${theme}" data-mode="${mode}" data-hotkey="${hotkey}"></script>`;
}

export const INSTALL_RECIPES = Object.freeze([
  {
    id: "mintlify",
    label: "Mintlify",
    status: "supported",
    placement: "Add a custom JavaScript file to the Mintlify docs repo so it runs across docs pages.",
    snippet: `const script = document.createElement("script");
script.src = "https://siterep.net/widget.js";
script.defer = true;
script.dataset.botId = "YOUR_BOT_ID";
script.dataset.publicKey = "YOUR_PUBLIC_WIDGET_KEY";
script.dataset.apiBase = "https://siterep.net";
script.dataset.mode = "docs";
script.dataset.hotkey = "mod+k";
document.head.appendChild(script);`,
    notes: [
      "Mintlify custom scripts run globally after the page is interactive, so test search, navigation, dark mode, and mobile.",
      "Lock the docs domain in Site Rep before expecting install proof.",
      "Import the docs sitemap or approved docs URLs into the source manifest before launch.",
    ],
  },
  {
    id: "docusaurus",
    label: "Docusaurus",
    status: "supported",
    placement: "Add a script object to docusaurus.config.js in the site config.",
    snippet: `scripts: [
  {
    src: "https://siterep.net/widget.js",
    defer: true,
    "data-bot-id": "YOUR_BOT_ID",
    "data-public-key": "YOUR_PUBLIC_WIDGET_KEY",
    "data-api-base": "https://siterep.net",
    "data-mode": "docs",
    "data-hotkey": "mod+k",
  },
],`,
    notes: [
      "If the docs site has a strict Content Security Policy, allow script-src and connect-src for https://siterep.net.",
      "Use the production docs hostname as the allowed install domain.",
      "Validate after a production build, not only local dev.",
    ],
  },
  {
    id: "gitbook",
    label: "GitBook",
    status: "not-directly-installable",
    placement: "Hosted GitBook does not directly support arbitrary custom HTML, CSS, or JavaScript.",
    snippet: "",
    notes: [
      "Hosted GitBook is not directly installable with the widget today.",
      "Use Site Rep to ingest public GitBook pages as approved sources.",
      "Install the widget on a wrapper site, marketing site, app shell, or another host that supports custom scripts.",
      "Do not promise hosted GitBook widget install unless GitBook adds a supported custom-code path.",
    ],
  },
  {
    id: "static-docs",
    label: "Static docs",
    status: "supported",
    placement: "Paste the canonical script in the shared layout or footer before the closing body tag.",
    snippet: canonicalEmbedSnippet(),
    notes: [
      "Use docs mode for docs sites and site mode for marketing pages.",
      "If CSP is enabled, allow script-src and connect-src for https://siterep.net.",
      "Publish, open the live page once, then confirm the install ping in Site Rep.",
    ],
  },
  {
    id: "webflow",
    label: "Webflow",
    status: "supported",
    placement: "Use Site settings Footer code for site-wide install, or Page settings before body for a docs-only page.",
    snippet: canonicalEmbedSnippet(),
    notes: [
      "Publish the Webflow site before expecting Site Rep to see the install.",
      "If a fixed cookie banner or chat tool overlaps the widget, move that tool or use Docs Mode's compact Ask AI launcher.",
      "Keep the Webflow production domain in the allowed-domain list.",
    ],
  },
  {
    id: "framer",
    label: "Framer",
    status: "supported",
    placement: "Use Project Settings, Custom Code, and place the script where Framer loads site-wide body code.",
    snippet: canonicalEmbedSnippet(),
    notes: [
      "Choose a site-wide placement for docs collections; use page-level code only for a limited rollout.",
      "Publish before checking the Site Rep install receipt.",
      "Test route changes because Framer navigation can keep pages alive without a full reload.",
    ],
  },
  {
    id: "generic",
    label: "Generic sites",
    status: "supported",
    placement: "Paste the canonical script before the closing body tag on every page that should show Ask AI.",
    snippet: canonicalEmbedSnippet(),
    notes: [
      "Use data-mode=\"docs\" for docs pages and omit it for the normal site widget.",
      "Allowed domains are exact origins, with apex/www twins accepted.",
      "A valid install needs a live-domain widget ping and one test lead or cited answer.",
    ],
  },
  {
    id: "wordpress",
    label: "WordPress",
    status: "supported",
    placement: "Use the Site Rep WordPress plugin or a trusted header/footer script plugin.",
    snippet: canonicalEmbedSnippet(),
    notes: [
      "Prefer the Site Rep WordPress plugin when available because it keeps the snippet in one place.",
      "If caching is enabled, purge cache after adding the script.",
      "Do not paste owner access keys or private dashboard links into WordPress.",
    ],
  },
]);

export function installRecipeById(id) {
  return INSTALL_RECIPES.find((recipe) => recipe.id === id) || INSTALL_RECIPES.find((recipe) => recipe.id === "generic");
}

export function renderInstallRecipesMarkdown() {
  const sections = INSTALL_RECIPES.map((recipe) => {
    const lines = [
      `## ${recipe.label}`,
      "",
      `Status: ${recipe.status}.`,
      "",
      `Where to paste: ${recipe.placement}`,
      "",
    ];
    if (recipe.snippet) {
      lines.push("Minimal snippet:", "", "```js", recipe.snippet, "```", "");
    }
    lines.push("Recommended validation:", "");
    lines.push("- Confirm the docs or site domain is in Site Rep allowed domains.");
    lines.push("- Confirm the approved source manifest includes docs pages, sitemap, llms.txt links, PDFs, or manual uploads as appropriate.");
    lines.push("- Publish the host, open the live page once, ask a cited question, expand Used N sources, and submit one test lead.");
    lines.push("- Check for overlay conflicts on desktop and mobile.");
    lines.push("", "Troubleshooting:", "");
    for (const note of recipe.notes) lines.push(`- ${note}`);
    return lines.join("\n");
  });

  return `---
title: Install Site Rep Docs Mode
description: Install recipes for Site Rep Docs Mode across Mintlify, Docusaurus, GitBook, static docs, Webflow, Framer, WordPress, and generic sites.
---

# Install Site Rep Docs Mode

Last updated: 2026-08-11.

Docs Mode adds a compact Ask AI launcher, a configurable hotkey, starter questions, and an expandable Used N sources drawer. It still answers only from approved sources and records every visitor answer or lead against a conversation ID.

Use the canonical single-script snippet when the host supports custom JavaScript:

\`\`\`html
${canonicalEmbedSnippet()}
\`\`\`

Before you start, get the real values from your dashboard:

- [Start free](/?surface=free-start) with 50 source-backed answers and no card, or [sign in](/?surface=customer) to an existing workspace. The dashboard shows your bot ID, public widget key, allowed install domains, and a ready-to-copy snippet with your values already filled in.
- Replace \`YOUR_BOT_ID\` and \`YOUR_PUBLIC_WIDGET_KEY\` with the dashboard values before publishing. A snippet left with placeholders stays dormant.
- Add the docs domain to the Site Rep allowed-domain list. Site Rep records install proof only after the published domain sends one widget ping and one test lead or cited answer comes through the widget.

Never put owner dashboard keys, session tokens, payment secrets, source files, or private docs content into the snippet. The public widget key is safe to expose, but the allowed-domain lock must still match the live site.

${sections.join("\n\n")}
`;
}

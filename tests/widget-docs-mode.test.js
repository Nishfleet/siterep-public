import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("widget supports first-class Docs Mode entry point and hotkey", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  assert.match(widget, /const widgetMode = String\(config\.mode \|\| scriptData\.mode \|\| "site"\)/);
  assert.match(widget, /const docsMode = widgetMode === "docs"/);
  assert.match(widget, /configuredHotkey = config\.hotkey \|\| scriptData\.hotkey \|\| \(docsMode \? "mod\+k" : ""\)/);
  assert.match(widget, /const configuredTheme = config\.theme \|\| scriptData\.theme \|\| ""/);
  assert.match(widget, /const theme = \/\^#\[0-9a-f\]\{6\}\$\/i\.test\(configuredTheme\) \? configuredTheme : "#1f8f5f"/);
  assert.match(widget, /const inlineOverrides = \{\}/);
  assert.match(widget, /if \(config\.theme \|\| scriptData\.theme\) inlineOverrides\.theme = theme/);
  assert.match(widget, /if \(config\.mode \|\| scriptData\.mode\) inlineOverrides\.mode = widgetMode/);
  assert.match(widget, /if \(config\.hotkey \|\| scriptData\.hotkey\) inlineOverrides\.hotkey = configuredHotkey/);
  assert.match(widget, /\.\.\.inlineOverrides/);
  assert.match(widget, /Ask AI/);
  assert.match(widget, /hotkeyMatches\(event, widgetSettings\.hotkey\)/);
  assert.match(widget, /!typingTarget\(event\.target\)/);
  assert.match(widget, /aria-controls", "citerep-panel"/);
  assert.match(widget, /aria-labelledby", "citerep-title"/);
});

test("widget renders an accessible Used N sources drawer", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  assert.match(widget, /function renderSourceDrawer/);
  assert.match(widget, /cr-source-toggle/);
  assert.match(widget, /aria-expanded", "false"/);
  assert.match(widget, /aria-controls", id/);
  assert.match(widget, /Used \$\{count\} source/);
  assert.match(widget, /sourceDisplayUrl/);
  assert.match(widget, /sourceExcerpt/);
  assert.match(widget, /No excerpt is available for this source/);
  assert.match(widget, /role", "list"/);
  assert.match(widget, /role", "listitem"/);
});

test("widget keeps mobile Docs Mode controls inside the viewport", async () => {
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");

  assert.match(widget, /100dvh/);
  assert.match(widget, /env\(safe-area-inset-bottom,0px\)/);
  assert.match(widget, /cr-panel\.cr-docs/);
  assert.match(widget, /cr-launcher\.cr-docs/);
  assert.match(widget, /max-height:38dvh/);
});

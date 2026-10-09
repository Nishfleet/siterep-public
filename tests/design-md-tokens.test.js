// Drift test: DESIGN.md frontmatter must stay in sync with the real tokens.
//
// Site Rep's design tokens live in three places that can drift apart:
//   1. DESIGN.md frontmatter (the agent-facing description),
//   2. the :root palette block in src/styles.css (what the app actually renders),
//   3. the @theme inline block in src/index.css (what shadcn utilities resolve to).
// This test fails when 1 disagrees with 2 or 3. Colors are checked against the
// real :root values; typography and radius are checked against @theme.
//
// Spacing and component recipes are documented in DESIGN.md but have no
// token surface to test (raw padding values and class names), so they are out
// of scope here — same as 0509's design-token test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(p) {
  return readFileSync(path.join(ROOT, p), "utf8");
}

function norm(value) {
  return String(value)
    .replace(/\\(["'\\])/g, "$1") // YAML "\"" escapes → plain quote
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Minimal parser for the DESIGN.md frontmatter: nested maps up to two levels,
// with quoted strings, numbers, and bare values (0px, 999px, none).
function parseFrontmatter(doc) {
  const match = doc.match(/^---\n([\s\S]*?)\n---/);
  assert(match, "DESIGN.md must start with a YAML frontmatter block (--- ... ---)");
  const result = {};
  let stack = [{ indent: -1, obj: result }];
  for (const rawLine of match[1].split("\n")) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const m = rawLine.trim().match(/^([^:]+):\s*(.*)$/);
    assert(m, `Unparsable frontmatter line: ${rawLine}`);
    const key = m[1].trim();
    const value = m[2].trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (value === "") {
      parent[key] = {};
      stack.push({ indent, obj: parent[key] });
    } else {
      parent[key] = value;
    }
  }
  return result;
}

function extractBlock(css, startMarker) {
  const start = css.indexOf(startMarker);
  assert(start !== -1, `CSS must contain ${startMarker}`);
  let depth = 0;
  let i = css.indexOf("{", start);
  const begin = i;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return css.slice(begin + 1, i);
}

function parseDeclarations(block) {
  const out = {};
  // Strip comments first: they can contain semicolons, so splitting on ";"
  // before removing them would cut a comment in half.
  const clean = block.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const decl of clean.split(";")) {
    const m = decl.trim().match(/^(--[\w-]+|[a-z-]+)\s*:\s*([\s\S]+)$/i);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const frontmatter = parseFrontmatter(read("DESIGN.md"));
const rootCss = parseDeclarations(extractBlock(read("src/styles.css"), ":root"));
const themeCss = parseDeclarations(extractBlock(read("src/index.css"), "@theme inline"));

test("every DESIGN.md color exists in the styles.css :root palette with the same value", () => {
  const colors = frontmatter.colors || {};
  assert.ok(Object.keys(colors).length >= 10, "DESIGN.md must document the palette");
  for (const [name, value] of Object.entries(colors)) {
    const actual = rootCss[`--${name}`];
    assert.ok(
      actual !== undefined,
      `DESIGN.md color "${name}" has no --${name} in styles.css :root`,
    );
    assert.equal(
      norm(actual),
      norm(value),
      `DESIGN.md color "${name}" (${value}) != styles.css :root --${name} (${actual})`,
    );
  }
});

test("the styles.css :root palette has no undocumented colors", () => {
  const colors = frontmatter.colors || {};
  for (const name of Object.keys(rootCss)) {
    if (!name.startsWith("--")) continue;
    if (name === "--shadow") continue; // documented under "Elevation", not a color
    assert.ok(
      colors[name.slice(2)] !== undefined,
      `styles.css :root defines ${name} but DESIGN.md frontmatter does not document it`,
    );
  }
});

test("every DESIGN.md typography token exists in @theme with matching size, line-height and letter-spacing", () => {
  const typography = frontmatter.typography || {};
  assert.ok(Object.keys(typography).length >= 8, "DESIGN.md must document the type scale");
  const themeNames = new Set();
  for (const name of Object.keys(themeCss)) {
    const m = name.match(/^--text-([\w-]+)$/);
    // skip the sub-declarations --text-x--line-height / --text-x--letter-spacing
    if (m && !m[1].includes("--")) themeNames.add(m[1]);
  }
  for (const [name, spec] of Object.entries(typography)) {
    const size = themeCss[`--text-${name}`];
    assert.ok(size !== undefined, `DESIGN.md token "${name}" has no --text-${name} in @theme`);
    assert.equal(norm(size), norm(spec.fontSize), `typography "${name}" fontSize drifted`);
    const lh = themeCss[`--text-${name}--line-height`];
    assert.ok(lh !== undefined, `--text-${name}--line-height missing from @theme`);
    assert.equal(norm(lh), norm(spec.lineHeight), `typography "${name}" lineHeight drifted`);
    const ls = themeCss[`--text-${name}--letter-spacing`];
    assert.ok(ls !== undefined, `--text-${name}--letter-spacing missing from @theme`);
    assert.equal(norm(ls), norm(spec.letterSpacing), `typography "${name}" letterSpacing drifted`);
    themeNames.delete(name);
  }
  assert.deepEqual(
    [...themeNames],
    [],
    `@theme has --text-* tokens missing from DESIGN.md: ${[...themeNames].join(", ")}`,
  );
});

test("every DESIGN.md radius step exists in @theme with the same value", () => {
  const rounded = frontmatter.rounded || {};
  const themeRadii = {};
  for (const [name, value] of Object.entries(themeCss)) {
    const m = name.match(/^--radius-([\w-]+)$/);
    if (m) themeRadii[m[1]] = value;
  }
  assert.ok(Object.keys(rounded).length >= 5, "DESIGN.md must document the radius scale");
  for (const [name, value] of Object.entries(rounded)) {
    assert.ok(
      themeRadii[name] !== undefined,
      `DESIGN.md radius "${name}" has no --radius-${name} in @theme`,
    );
    assert.equal(norm(themeRadii[name]), norm(value), `radius "${name}" drifted`);
    delete themeRadii[name];
  }
  assert.deepEqual(
    Object.keys(themeRadii),
    [],
    `@theme has --radius-* steps missing from DESIGN.md: ${Object.keys(themeRadii).join(", ")}`,
  );
});

test("font family slots match the DESIGN.md typography families", () => {
  const typography = frontmatter.typography || {};
  const sans = typography.body?.fontFamily ?? typography.bodySmall?.fontFamily;
  assert.ok(sans, "DESIGN.md body token must carry fontFamily");
  assert.ok(themeCss["--font-sans"], "--font-sans missing from @theme");
  assert.equal(norm(themeCss["--font-sans"]), norm(sans), "--font-sans drifted from DESIGN.md");
  const code = typography.code;
  assert.ok(code, "DESIGN.md must document a code token");
  assert.ok(themeCss["--font-mono"], "--font-mono missing from @theme");
  assert.equal(norm(themeCss["--font-mono"]), norm(code.fontFamily), "--font-mono drifted from DESIGN.md");
});

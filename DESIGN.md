---
name: Site Rep (siterep-public)
colors:
  page: "#f6f7f9"
  surface: "#ffffff"
  surface-strong: "#f8fafc"
  soft: "#eef2f4"
  line: "#dde3e8"
  ink: "#111614"
  ink-soft: "#26312d"
  muted: "#5c665f"
  green: "#1f8f5f"
  green-dark: "#126342"
  green-wash: "#f2fbf5"
  green-mid: "#b7ebcf"
  blue: "#315ff4"
  blue-ink: "#2448ba"
  blue-wash: "#eef4ff"
  amber: "#e7a62f"
  amber-wash: "#fff9e8"
  amber-ink: "#7b5314"
  red-ink: "#8a2f22"
  red-wash: "#f7e3df"
typography:
  display-xl:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "clamp(3rem, 7.4vw, 7.4rem)"
    lineHeight: 0.93
    letterSpacing: "0"
  display-lg:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "clamp(2.84rem, 4.45vw, 4.82rem)"
    lineHeight: 0.94
    letterSpacing: "0"
  display-md:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "clamp(2rem, 4vw, 3.4rem)"
    lineHeight: 1
    letterSpacing: "0"
  stat:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "clamp(2rem, 4.3vw, 4rem)"
    lineHeight: 0.98
    letterSpacing: "0"
  lead:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "clamp(1.04rem, 1.45vw, 1.24rem)"
    lineHeight: 1.6
    letterSpacing: "0"
  title-lg:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "1.25rem"
    lineHeight: 1.35
    letterSpacing: "0"
  eyebrow:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "0.92rem"
    lineHeight: 1.35
    letterSpacing: "0"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "1rem"
    lineHeight: 1.35
    letterSpacing: "0"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "1rem"
    lineHeight: 1.35
    letterSpacing: "0"
  body-sm:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "0.9rem"
    lineHeight: 1.35
    letterSpacing: "0"
  body-xs:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "0.82rem"
    lineHeight: 1.35
    letterSpacing: "0"
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.78rem"
    lineHeight: 1.35
    letterSpacing: "0"
  meta:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "0.76rem"
    lineHeight: 1.35
    letterSpacing: "0"
  micro:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "0.72rem"
    lineHeight: 1.35
    letterSpacing: "0"
rounded:
  none: 0px
  xs: 5px
  sm: 7px
  md: 8px
  lg: 10px
  xl: 12px
  2xl: 14px
  3xl: 16px
  4xl: 999px
spacing:
  unit: 2px
  control-gap: 10px
  field-gap: 14px
  block-gap: 18px
  section-gap: 34px
components:
  button-primary: .primary-button
  button-secondary: .secondary-button
  button-quiet: .secondary-action
  panel: .panel
  eyebrow: .eyebrow
  section-heading: .section-heading
  panel-title: .panel-title
  field-error: .field-error
  empty-state: .empty-state
  lead-chip: .lead-chip
  trust-pill: .trust-row span
  checkout-modal: .checkout-modal
  console-sidebar: .console-sidebar
  chat-shell: .chat-shell
---

# Design brief — Site Rep

Site Rep is the public site and owner console for a source-backed website rep.
The look is a light, calm Intercom-style shell in Site Rep colors: near-white
page, white cards, hairline gray lines, one green action color, one blue link
and focus color, amber and red only for warnings and errors. This file is the
design source of truth. `src/styles.css` is the rendering source of truth: the
`@theme` tokens in `src/index.css` and the YAML frontmatter above must agree
with it, and `tests/design-md-tokens.test.js` fails when they drift.

## Overview

- Light-only. There is no dark mode (`color-scheme: light`).
- Flat and hairline: 1px `--line` borders, almost no shadows; the few shadows
  are large, soft, and low-alpha (hero console, modals).
- One font family (Inter) for everything except code. Display sizes are huge
  and tight (line-height 0.9 to 1), UI text is small (0.72rem to 1rem).
- Radius is 8px almost everywhere; pills are `999px`.

## Colors

| Token | Value | Role |
| --- | --- | --- |
| `page` | `#f6f7f9` | page background |
| `surface` | `#ffffff` | cards, modal fills |
| `surface-strong` | `#f8fafc` | inset bands, table heads |
| `soft` | `#eef2f4` | quiet wash, secondary button fill, hover |
| `line` | `#dde3e8` | hairline borders |
| `ink` | `#111614` | headings and body text |
| `ink-soft` | `#26312d` | dense console text |
| `muted` | `#5c665f` | secondary text |
| `green` | `#1f8f5f` | primary action fill, success |
| `green-dark` | `#126342` | pressed/hover green, green text on wash |
| `green-wash` | `#f2fbf5` | success bands |
| `blue` | `#315ff4` | links, eyebrows, focus outline |
| `blue-ink` | `#2448ba` | blue text on wash |
| `blue-wash` | `#eef4ff` | info bands |
| `amber` | `#e7a62f` | warning accent |
| `amber-wash` / `amber-ink` | `#fff9e8` / `#7b5314` | warning bands |
| `red-ink` / `red-wash` | `#8a2f22` / `#f7e3df` | errors and destructive text |

shadcn role mapping (see `src/index.css` `@theme inline`): `background` →
`page`, `foreground` → `ink`, `card`/`popover` → `surface`, `primary` →
`green` with white text, `secondary`/`muted`/`accent` → `soft`,
`muted-foreground` → `muted`, `destructive` → `red-ink`, `border`/`input` →
`line`, `ring` → `blue`.

## Typography

Inter everywhere (`ui-sans-serif` system fallback); code is
`ui-monospace, SFMono-Regular, Menlo, Consolas`. Named tokens live in the
frontmatter `typography` map and in `@theme` as `--text-*` +
`--text-*--line-height` + `--text-*--letter-spacing`.

- Display sizes carry the brand: `display-xl` is the public hero (up to
  7.4rem, line-height 0.93), `display-lg` the console hero, `display-md`
  section headings, `stat` big numbers.
- `eyebrow` is uppercase, weight 900, blue. Uppercase is a property of the
  recipe, not the token.
- Body text is `body`/`body-sm`/`body-xs` with line-height 1.35, the dominant
  value in the stylesheet.
- Display type is never lighter than weight 800; UI labels sit at 720 to 900.

## Layout

- Two-pixel base unit; common steps are 10px (control gaps), 14px (field
  gaps), 18px (block gaps), 34px (section gaps).
- Content column: max-width 860px to 920px for marketing sections; the console
  is a sidebar shell (`console-sidebar` + `console-detail`).
- The shell must never scroll horizontally at any width, including sub-320px
  phones (`overflow-wrap: anywhere` on the public shell).

## Elevation

Flat by default. Two soft, large, low-alpha shadows only:

- `0 24px 70px rgba(24, 37, 31, 0.12)` (`--shadow`, hero console, panels).
- `0 28px 90px rgba(20, 39, 29, 0.15)` (hero console on the hero band).
- Trust pills use `0 10px 28px rgba(18, 47, 31, 0.06)`.

## Shapes

Radius steps in the frontmatter `rounded` map, pinned as `--radius-*` in
`src/index.css`: `xs` 5px (tiny accents), `sm` 7px (small controls), `md` 8px
(the default: buttons, inputs, cards, panels — 127 uses), `lg` 10px, `xl`
12px, `2xl` 14px, `3xl` 16px, `4xl` 999px (pills, badges). Two large hero
cards use 18px; they read as `3xl` and keep their literal value in
`styles.css`.

## Components

Recipes live in `src/styles.css`; the frontmatter `components` map names each
recipe's class. When a shadcn primitive is used on a screen, the app class
stays on the element (`<Button className="primary-button">`), so
`styles.css` keeps owning the pixels until a recipe is deliberately
re-rendered as variants.

- `primary-button`: green fill, white text, 58px min-height on the marketing
  hero; glow shadow on the hero pair only.
- `secondary-button` / `secondary-action`: white (or transparent on dark
  bands) with a hairline border.
- Panels (`.panel`): white fill, hairline border, `md` radius, quiet headers
  (`.panel-title`).
- Forms: `.field-error` for validation text in `red-ink`; inputs are white,
  hairline-bordered, `md` radius.
- Focus everywhere: `outline: 3px solid rgba(49, 95, 244, 0.28)` with 2px
  offset. Components must not add a ring shadow on focus.
- Vendored shadcn primitives live in `src/components/ui`: `button`, `input`,
  `textarea` (bare native passthroughs styled by the app recipes, already on
  screens), plus `badge`, `select` and `native-select` (vendored, not yet used
  on screens — the DOM-changing ones are deferred, see Known Gaps).

## Do's and Don'ts

- Do keep the app light-only; do not add a dark theme.
- Do use 8px radius unless a named step says otherwise; do not invent values
  outside the scale (the 18px hero cards are grandfathered).
- Do keep display type tight (line-height at or below 1); do not bold it past
  its recipe weight.
- Do not add a new accent color; green acts, blue links and focuses, amber
  warns, red errors.
- Do not replace `styles.css` recipes with utility classes on existing
  screens; the class is the pixel authority.

## Responsive

- Marketing sections collapse to one column on small screens; hero paddings
  clamp (`clamp(20px, 7vw, 112px)` section rhythm).
- Display sizes are clamps; they shrink with the viewport, never overflow.
- The console shell has breakpoint layouts at roughly 1100px and 860px.

## Known Gaps

- The frontmatter maps the light theme only; the app has no dark values.
- Easing and duration tokens (`--ease-*`, transitions) have no schema key.
- `letter-spacing` is `0` everywhere except a few uppercase recipes
  (0.04em to 0.16em); those stay literal in `styles.css`.
- The 18px hero-card radius and the inline wash hexes that predate the named
  tokens are literal in `styles.css` and are not enforced by the drift test.
- Tailwind's preflight is neutralized by a browser-defaults block at the top
  of `styles.css` (line-height, border-style, heading sizes, button padding,
  placeholder color); every existing screen depends on it, so it must not be
  removed.
- `select` stays a native element on screens: the shadcn `native-select`
  wrapper adds a wrapper div and the Base UI `select` replaces the popup
  entirely; both would move pixels, so adoption is deferred.

import js from "@eslint/js";
import noComments from "eslint-plugin-no-comments";
import tseslint from "typescript-eslint";
import globals from "globals";

const WORKAROUND_TERMS = [
  "todo",
  "fixme",
  "xxx",
  "hack",
  "workaround",
  "work around",
  "for now",
  "temporary",
  "temporarily",
  "not ideal",
  "should be",
  "ideally",
  "revisit",
  "later",
];

const APP_CODE = ["src/**/*.{ts,tsx}", "worker/**/*.js", "server/**/*.js", "public/widget.js"];
const TEST_CODE = ["tests/**/*.{js,mjs}"];

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      ".wrangler/**",
      "**/*.d.ts",
      ".agents/skills/shadcn/**",
      "marketing/launch-video/**",
    ],
  },

  js.configs.recommended,

  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tseslint.parser },
    rules: { "no-undef": "off" },
  },

  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
  },

  {
    files: APP_CODE,
    plugins: { "no-comments": noComments },
    rules: {
      "no-comments/disallowComments": ["error", { allow: ["eslint", "global", "nosemgrep", "https:\\/\\/"] }],
      "no-inline-comments": ["error", { ignorePattern: "^\\s*nosemgrep:" }],
      "no-warning-comments": ["error", { terms: WORKAROUND_TERMS, location: "anywhere" }],
    },
  },

  {
    files: TEST_CODE,
    plugins: { "no-comments": noComments },
    rules: {
      "no-comments/disallowComments": [
        "error",
        { allow: ["eslint-(?:disable|enable|env)", "global ", "@ts-", "nosemgrep", "https:\\/\\/"] },
      ],
      "no-inline-comments": ["error", { ignorePattern: "^\\s*nosemgrep:" }],
      "no-warning-comments": ["error", { terms: WORKAROUND_TERMS, location: "anywhere" }],
    },
  },
];

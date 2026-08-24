import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// Regression guard for research-desk item 4eb0457f0b: the /terms page must
// carry an explicit no-warranty and limitation of liability section so the
// product has AI-chatbot liability limitation parity with competitor terms.
test("the /terms page includes a no-warranty and limitation of liability section", async () => {
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  const termsMarkdown = worker.slice(
    worker.indexOf("const TERMS_MARKDOWN"),
    worker.indexOf("const VS_CUSTOMGPT_MARKDOWN"),
  );

  assert.match(termsMarkdown, /## No warranty and limitation of liability/);
  assert.match(termsMarkdown, /"as is"/);
  assert.match(termsMarkdown, /without warranties of any kind/);
  assert.match(termsMarkdown, /AI-generated answers may be incomplete, inaccurate, or out of date/);
  assert.match(termsMarkdown, /not liable for any direct, indirect, incidental, special, or consequential damages/);
  assert.match(termsMarkdown, /arising from AI-generated answers/);
  assert.match(termsMarkdown, /The customer remains responsible for reviewing answers/);
});

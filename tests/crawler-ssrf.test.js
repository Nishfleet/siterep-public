import assert from "node:assert/strict";
import { test } from "node:test";
import { guardedFetch, isBlockedCrawlHost, normalizeUrl } from "../server/crawler.js";

// https://url.spec.whatwg.org/ canonicalizes a host before it reaches us, so these fixtures use the parser's own form.

test("blocks loopback, private, link-local, and metadata IPv4", () => {
  for (const host of [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "198.18.0.1",
    "255.255.255.255",
    "224.0.0.1",
  ]) {
    assert.equal(isBlockedCrawlHost(host), true, `${host} must be blocked`);
  }
});

test("allows ordinary public IPv4 and hostnames", () => {
  for (const host of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "example.com", "siterep.net", "172.32.0.1", "192.169.0.1"]) {
    assert.equal(isBlockedCrawlHost(host), false, `${host} must be allowed`);
  }
});

test("blocks IPv4-mapped IPv6 pointing at private/metadata addresses (the bypass)", () => {
  for (const host of [
    "[::ffff:169.254.169.254]",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::ffff:7f00:1",
    "::ffff:127.0.0.1",
    "::127.0.0.1",
  ]) {
    assert.equal(isBlockedCrawlHost(host), true, `${host} must be blocked`);
  }
});

test("blocks loopback, unspecified, ULA, and link-local IPv6", () => {
  for (const host of ["::1", "[::1]", "::", "fc00::1", "fd12:3456::1", "fe80::1", "feab::1"]) {
    assert.equal(isBlockedCrawlHost(host), true, `${host} must be blocked`);
  }
});

test("allows ordinary public IPv6", () => {
  for (const host of ["2606:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e"]) {
    assert.equal(isBlockedCrawlHost(host), false, `${host} must be allowed`);
  }
});

test("blocks localhost name variants", () => {
  for (const host of ["localhost", "foo.localhost", "router.local", ""]) {
    assert.equal(isBlockedCrawlHost(host), true, `${host} must be blocked`);
  }
});

test("normalizeUrl rejects encoded-IP forms of loopback and metadata end to end", () => {
  for (const raw of [
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://0xA9FEA9FE/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::1]/",
  ]) {
    assert.throws(() => normalizeUrl(raw), /public website URL/i, `${raw} must be rejected`);
  }
});

test("normalizeUrl still accepts a real public site", () => {
  assert.equal(normalizeUrl("https://example.com/docs"), "https://example.com/docs");
});

test("guardedFetch refuses a webhook or source URL that points at a private or metadata host", async () => {
  for (const url of ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:8787/api/health", "http://10.0.0.5/hook"]) {
    await assert.rejects(guardedFetch(url, { method: "POST", body: "{}" }), /Blocked host/, `${url} must be refused`);
  }
});

test("guardedFetch refuses a redirect from a public host to a private one", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
  await assert.rejects(guardedFetch("https://example.com/hook"), /Blocked host: 169\.254\.169\.254/);
});

function recordHops(t, firstStatus) {
  const hops = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    hops.push({ url: String(url), method: init.method || "GET", body: init.body, authorization: new Headers(init.headers).get("authorization") });
    if (hops.length === 1) return new Response(null, { status: firstStatus, headers: { location: "https://collector.example.net/catch" } });
    return new Response("ok", { status: 200 });
  });
  return hops;
}

const webhookInit = () => ({
  method: "POST",
  body: JSON.stringify({ lead: "visitor@example.org" }),
  headers: { authorization: "Bearer hook-token", "content-type": "application/json" },
});

test("a cross-origin 302 on a POST follows as a bodiless GET without Authorization", async (t) => {
  const hops = recordHops(t, 302);
  await guardedFetch("https://example.com/hook", webhookInit());
  assert.equal(hops.length, 2);
  assert.deepEqual(hops[1], { url: "https://collector.example.net/catch", method: "GET", body: undefined, authorization: null });
});

test("a cross-origin 307 keeps the method but drops Authorization", async (t) => {
  const hops = recordHops(t, 307);
  await guardedFetch("https://example.com/hook", webhookInit());
  assert.equal(hops[1].method, "POST");
  assert.equal(hops[1].authorization, null);
});

test("redirect manual, as webhook delivery uses, never contacts the redirect target", async (t) => {
  const hops = recordHops(t, 307);
  const response = await guardedFetch("https://example.com/hook", { ...webhookInit(), redirect: "manual" });
  assert.equal(response.status, 307);
  assert.deepEqual(hops.map((hop) => hop.url), ["https://example.com/hook"]);
});

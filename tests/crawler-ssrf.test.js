import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlockedCrawlHost, normalizeUrl } from "../server/crawler.js";

// SSRF guard: every host that resolves to a private, loopback, link-local,
// ULA, or cloud-metadata address must be blocked — in every encoding. Hosts
// arrive here already canonicalized by the WHATWG URL parser, so the cases
// below use the canonical form the parser produces (verified separately).

test("blocks loopback, private, link-local, and metadata IPv4", () => {
  for (const host of [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // carrier-grade NAT
    "0.0.0.0",
    "198.18.0.1",
    "255.255.255.255",
    "224.0.0.1", // multicast
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
    "[::ffff:169.254.169.254]", // dotted mapped form, with brackets
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe", // hex hextet form the URL parser canonicalizes to (= 169.254.169.254)
    "::ffff:7f00:1", // = 127.0.0.1
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
  // The URL parser folds these to dotted-decimal, which the guard then blocks.
  for (const raw of [
    "http://2130706433/", // decimal 127.0.0.1
    "http://0x7f000001/", // hex 127.0.0.1
    "http://0177.0.0.1/", // octal 127.0.0.1
    "http://0xA9FEA9FE/", // hex 169.254.169.254
    "http://[::ffff:169.254.169.254]/",
    "http://[::1]/",
  ]) {
    assert.throws(() => normalizeUrl(raw), /public website URL/i, `${raw} must be rejected`);
  }
});

test("normalizeUrl still accepts a real public site", () => {
  assert.equal(normalizeUrl("https://example.com/docs"), "https://example.com/docs");
});

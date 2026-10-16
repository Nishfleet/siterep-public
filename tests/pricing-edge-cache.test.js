import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    if (url === "cloudflare:workers") {
      return {
        format: "module",
        source: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const CLIENT_CACHE_CONTROL = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

function fakeEdgeCache() {
  const map = new Map();
  return {
    map,
    match: async (request) => {
      const stored = map.get(request.url);
      return stored ? stored.clone() : undefined;
    },
    put: async (request, response) => {
      map.set(request.url, response);
    },
  };
}

function fakeContext(pending = []) {
  return { waitUntil: (work) => pending.push(work), passThroughOnException: () => {}, props: {} };
}

function pricingEnv(overrides = {}) {
  return {
    RAZORPAY_CURRENCY: "USD",
    RAZORPAY_STARTER_AMOUNT_SUBUNITS: "900",
    RAZORPAY_GROWTH_AMOUNT_SUBUNITS: "2900",
    RAZORPAY_PRO_AMOUNT_SUBUNITS: "5900",
    RAZORPAY_AGENCY_AMOUNT_SUBUNITS: "14900",
    ...overrides,
  };
}

function pricingRequest(country, method = "GET") {
  return new Request("https://siterep.net/api/public/pricing", { method, headers: country ? { "cf-ipcountry": country } : {} });
}

async function withEdgeCache(run) {
  const worker = (await import("../worker/index.js")).default;
  const cache = fakeEdgeCache();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", { value: { default: cache }, configurable: true, writable: true });
  try {
    await run(worker, cache);
  } finally {
    if (previous) Object.defineProperty(globalThis, "caches", previous);
    else delete globalThis.caches;
  }
}

test("pricing endpoint sends edge cache headers and serves the second request from the edge cache", async () => {
  await withEdgeCache(async (worker, cache) => {
    const env = pricingEnv();
    const first = await worker.fetch(pricingRequest("DE"), env, fakeContext());
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), CLIENT_CACHE_CONTROL);
    assert.equal(first.headers.get("x-pricing-cache"), "MISS");
    const firstBody = await first.json();
    assert.equal(firstBody.ok, true);
    assert.equal(cache.map.size, 1);

    const second = await worker.fetch(pricingRequest("DE"), env, fakeContext());
    assert.equal(second.headers.get("cache-control"), CLIENT_CACHE_CONTROL);
    assert.equal(second.headers.get("x-pricing-cache"), "HIT");
    assert.deepEqual(await second.json(), firstBody);

    const head = await worker.fetch(pricingRequest("DE", "HEAD"), env, fakeContext());
    assert.equal(head.headers.get("x-pricing-cache"), "HIT");
    assert.equal(await head.text(), "");
  });
});

test("pricing edge cache is keyed by country and by pricing configuration", async () => {
  await withEdgeCache(async (worker, cache) => {
    await worker.fetch(pricingRequest("DE"), pricingEnv(), fakeContext());
    const otherCountry = await worker.fetch(pricingRequest("IN"), pricingEnv(), fakeContext());
    assert.equal(otherCountry.headers.get("x-pricing-cache"), "MISS");
    const changedPrice = await worker.fetch(pricingRequest("DE"), pricingEnv({ RAZORPAY_STARTER_AMOUNT_SUBUNITS: "1100" }), fakeContext());
    assert.equal(changedPrice.headers.get("x-pricing-cache"), "MISS");
    assert.equal((await changedPrice.json()).plans[0].amountSubunits, 1100);
    assert.equal(cache.map.size, 3);
  });
});

test("stale pricing is served immediately and refreshed in the background", async () => {
  await withEdgeCache(async (worker, cache) => {
    const env = pricingEnv();
    await worker.fetch(pricingRequest("DE"), env, fakeContext());
    const [key, stored] = [...cache.map.entries()][0];
    const body = await stored.clone().text();
    cache.map.set(key, new Response(body, { headers: { "x-pricing-cached-at": String(Date.now() - 2 * 3600 * 1000) } }));
    const pending = [];
    const stale = await worker.fetch(pricingRequest("DE"), env, fakeContext(pending));
    assert.equal(stale.headers.get("x-pricing-cache"), "STALE");
    await Promise.all(pending);
    assert.equal(pending.length, 1);
    const refreshed = await worker.fetch(pricingRequest("DE"), env, fakeContext());
    assert.equal(refreshed.headers.get("x-pricing-cache"), "HIT");
  });
});

test("degraded pricing is never cached at the edge or by clients", async () => {
  await withEdgeCache(async (worker, cache) => {
    const response = await worker.fetch(pricingRequest("DE"), {}, fakeContext());
    assert.equal((await response.json()).ok, false);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(cache.map.size, 0);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { coerceRows, isSimproNotFound, parseRetryAfterMs, SimproClient, SimproError, sourceHash } from "../../src/lib/simpro/client";
import { loadSimproConfig } from "../../src/lib/simpro/config";
import { DistributedSimproRateLimiter } from "../../src/lib/simpro/distributed-rate-limiter";

test("coerceRows handles array, wrapped rows, and object detail payloads", () => {
  assert.deepEqual(coerceRows([{ ID: 1 }]), [{ ID: 1 }]);
  assert.deepEqual(coerceRows({ items: [{ ID: 2 }] }), [{ ID: 2 }]);
  assert.deepEqual(coerceRows({ ID: 3 }), [{ ID: 3 }]);
  assert.deepEqual(coerceRows(null), []);
});

test("sourceHash is stable across object key order", () => {
  assert.equal(sourceHash({ b: 2, a: 1 }), sourceHash({ a: 1, b: 2 }));
});

test("loadSimproConfig caps central rate limit at five requests per second", () => {
  const config = loadSimproConfig({
    SIMPRO_REQUESTS_PER_SECOND: "25",
    SIMPRO_REQUEST_TIMEOUT_MS: "10",
  });

  assert.equal(config.requestsPerSecond, 5);
  assert.equal(config.requestTimeoutMs, 1000);
});

test("distributed limiter fails closed when aggregate coordination is unavailable", async () => {
  const original = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  delete process.env.AZURE_POSTGRES_CONNECTION_STRING;
  try {
    await assert.rejects(
      new DistributedSimproRateLimiter(5).wait(),
      /AZURE_POSTGRES_CONNECTION_STRING is required/,
    );
  } finally {
    if (original === undefined) delete process.env.AZURE_POSTGRES_CONNECTION_STRING;
    else process.env.AZURE_POSTGRES_CONNECTION_STRING = original;
  }
});

test("isSimproNotFound only recognizes typed 404 responses", () => {
  assert.equal(isSimproNotFound(new SimproError("missing", { status: 404 })), true);
  assert.equal(isSimproNotFound(new SimproError("forbidden", { status: 403 })), false);
  assert.equal(isSimproNotFound(new Error("404")), false);
});

test("every physical retry consumes request budget and both rate-limit gates", async () => {
  const budget = { limit: 4, used: 0 };
  let calls = 0;
  let localWaits = 0;
  let distributedWaits = 0;
  const client = new SimproClient(
    loadSimproConfig({
      SIMPRO_BASE_URL: "https://example.invalid/api/v1.0",
      SIMPRO_COMPANY_ID: "1",
      SIMPRO_BEARER_TOKEN: "test-token",
    }),
    {
      localLimiter: { wait: async () => { localWaits += 1; } },
      distributedLimiter: { wait: async () => { distributedWaits += 1; } },
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return calls < 3
          ? new Response("", { status: 503 })
          : new Response(JSON.stringify({ ID: 42 }), { status: 200 });
      },
    },
  );

  assert.deepEqual(await client.getJson("/jobs/42", undefined, budget), { ID: 42 });
  assert.equal(calls, 3);
  assert.equal(budget.used, 3);
  assert.equal(localWaits, 3);
  assert.equal(distributedWaits, 3);
});

test("physical retries stop before exceeding the request budget", async () => {
  const budget = { limit: 2, used: 0 };
  let calls = 0;
  const client = new SimproClient(
    loadSimproConfig({
      SIMPRO_BASE_URL: "https://example.invalid/api/v1.0",
      SIMPRO_COMPANY_ID: "1",
      SIMPRO_BEARER_TOKEN: "test-token",
    }),
    {
      localLimiter: { wait: async () => {} },
      distributedLimiter: { wait: async () => {} },
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return new Response("", { status: 503 });
      },
    },
  );

  await assert.rejects(client.getJson("/jobs/42", undefined, budget), /request budget exhausted/);
  assert.equal(calls, 2);
  assert.equal(budget.used, 2);
});

test("retryable responses honor Retry-After while reacquiring both gates", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  let localWaits = 0;
  let distributedWaits = 0;
  const client = new SimproClient(
    loadSimproConfig({
      SIMPRO_BASE_URL: "https://example.invalid/api/v1.0",
      SIMPRO_COMPANY_ID: "1",
      SIMPRO_BEARER_TOKEN: "test-token",
    }),
    {
      localLimiter: { wait: async () => { localWaits += 1; } },
      distributedLimiter: { wait: async () => { distributedWaits += 1; } },
      sleepImpl: async (ms) => { sleeps.push(ms); },
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response("", { status: 429, headers: { "Retry-After": "2" } })
          : new Response(JSON.stringify({ ID: 42 }), { status: 200 });
      },
    },
  );
  const budget = { limit: 2, used: 0 };

  await client.getJson("/jobs/42", undefined, budget);

  assert.deepEqual(sleeps, [2000]);
  assert.equal(budget.used, 2);
  assert.equal(localWaits, 2);
  assert.equal(distributedWaits, 2);
});

test("Retry-After supports HTTP dates", () => {
  assert.equal(parseRetryAfterMs("Thu, 09 Jul 2026 12:00:02 GMT", Date.parse("2026-07-09T12:00:00Z")), 2000);
  assert.equal(parseRetryAfterMs("invalid", 0), 0);
});

test("non-retryable responses are attempted exactly once", async () => {
  const budget = { limit: 4, used: 0 };
  let calls = 0;
  const client = new SimproClient(
    loadSimproConfig({
      SIMPRO_BASE_URL: "https://example.invalid/api/v1.0",
      SIMPRO_COMPANY_ID: "1",
      SIMPRO_BEARER_TOKEN: "test-token",
    }),
    {
      localLimiter: { wait: async () => {} },
      distributedLimiter: { wait: async () => {} },
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return new Response("forbidden", { status: 403 });
      },
    },
  );

  await assert.rejects(client.getJson("/jobs/42", undefined, budget), /403/);
  assert.equal(calls, 1);
  assert.equal(budget.used, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPostgresPoolLimits,
  buildPostgresSslConfig,
  getDatabaseHealthStatus,
} from "../../src/lib/store/postgres";

test("worker database pools default to one bounded connection", () => {
  assert.deepEqual(buildPostgresPoolLimits({}), {
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
});

test("web database pool caps oversized environment requests", () => {
  assert.deepEqual(buildPostgresPoolLimits({
    POSTGRES_POOL_MAX: "10",
    POSTGRES_POOL_IDLE_TIMEOUT_MS: "45000",
    POSTGRES_CONNECTION_TIMEOUT_MS: "5000",
  }), {
    max: 10,
    idleTimeoutMillis: 45_000,
    connectionTimeoutMillis: 5_000,
  });
});

test("invalid pool values fail closed to bounded defaults", () => {
  assert.deepEqual(buildPostgresPoolLimits({
    POSTGRES_POOL_MAX: "11",
    POSTGRES_POOL_IDLE_TIMEOUT_MS: "not-a-number",
    POSTGRES_CONNECTION_TIMEOUT_MS: "0",
  }), {
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
});

test("database TLS certificate verification remains enabled by default", () => {
  assert.deepEqual(buildPostgresSslConfig({}), { rejectUnauthorized: true });
});

test("database readiness reflects a successful bounded query", async () => {
  const previous = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  process.env.AZURE_POSTGRES_CONNECTION_STRING = "postgresql://configured.invalid/test";
  try {
    const status = await getDatabaseHealthStatus(async () => ({ rows: [{ ready: 1 }] }));
    assert.equal(status.configured, true);
    assert.equal(status.connected, true);
    assert.equal(typeof status.latencyMs, "number");
  } finally {
    if (previous === undefined) delete process.env.AZURE_POSTGRES_CONNECTION_STRING;
    else process.env.AZURE_POSTGRES_CONNECTION_STRING = previous;
  }
});

test("database readiness fails closed without leaking probe errors", async () => {
  const previous = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  process.env.AZURE_POSTGRES_CONNECTION_STRING = "postgresql://configured.invalid/test";
  try {
    const status = await getDatabaseHealthStatus(async () => {
      throw new Error("secret connection details");
    });
    assert.deepEqual(status, {
      configured: true,
      sslConfigured: false,
      connected: false,
      latencyMs: null,
    });
  } finally {
    if (previous === undefined) delete process.env.AZURE_POSTGRES_CONNECTION_STRING;
    else process.env.AZURE_POSTGRES_CONNECTION_STRING = previous;
  }
});

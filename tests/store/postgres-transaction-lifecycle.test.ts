import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { Pool, type PoolClient } from "pg";
import {
  closePostgresPool,
  type QueryResult,
  withPostgresTransaction,
} from "../../src/lib/store/postgres";

const previousConnectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;

beforeEach(() => {
  process.env.AZURE_POSTGRES_CONNECTION_STRING = "postgresql://transaction-test.invalid/database";
});

afterEach(async () => {
  await closePostgresPool();
  mock.restoreAll();

  if (previousConnectionString === undefined) {
    delete process.env.AZURE_POSTGRES_CONNECTION_STRING;
  } else {
    process.env.AZURE_POSTGRES_CONNECTION_STRING = previousConnectionString;
  }
});

test("BEGIN rejection releases the client once", async () => {
  const beginError = new Error("begin failed");
  const events: string[] = [];
  const callback = mock.fn(async () => "unreachable");
  const { release } = mockClient(async (text) => {
    events.push(text);
    throw beginError;
  }, events);

  await rejectsWithIdentity(withPostgresTransaction(callback), beginError);

  assert.deepEqual(events, ["begin", "release"]);
  assert.equal(callback.mock.callCount(), 0);
  assert.equal(release.mock.callCount(), 1);
});

test("callback rejection attempts rollback then releases", async () => {
  const callbackError = new Error("callback failed");
  const events: string[] = [];
  const { release } = mockClient(async (text) => {
    events.push(text);
    return emptyResult();
  }, events);

  await rejectsWithIdentity(withPostgresTransaction(async () => {
    events.push("callback");
    throw callbackError;
  }), callbackError);

  assert.deepEqual(events, ["begin", "callback", "rollback", "release"]);
  assert.equal(release.mock.callCount(), 1);
});

test("rollback rejection preserves the callback error and releases", async () => {
  const callbackError = new Error("callback failed");
  const rollbackError = new Error("rollback failed");
  const events: string[] = [];
  const { release } = mockClient(async (text) => {
    events.push(text);
    if (text === "rollback") throw rollbackError;
    return emptyResult();
  }, events);

  await rejectsWithIdentity(withPostgresTransaction(async () => {
    events.push("callback");
    throw callbackError;
  }), callbackError);

  assert.deepEqual(events, ["begin", "callback", "rollback", "release"]);
  assert.equal(release.mock.callCount(), 1);
});

test("commit rejection attempts rollback then releases", async () => {
  const commitError = new Error("commit failed");
  const rollbackError = new Error("rollback failed");
  const events: string[] = [];
  const { release } = mockClient(async (text) => {
    events.push(text);
    if (text === "commit") throw commitError;
    if (text === "rollback") throw rollbackError;
    return emptyResult();
  }, events);

  await rejectsWithIdentity(withPostgresTransaction(async () => {
    events.push("callback");
    return "unreachable";
  }), commitError);

  assert.deepEqual(events, ["begin", "callback", "commit", "rollback", "release"]);
  assert.equal(release.mock.callCount(), 1);
});

test("successful transaction commits and releases", async () => {
  const events: string[] = [];
  const { release } = mockClient(async (text) => {
    events.push(text);
    return emptyResult();
  }, events);

  const result = await withPostgresTransaction(async (query) => {
    events.push("callback");
    await query("select 1");
    return "complete";
  });

  assert.equal(result, "complete");
  assert.deepEqual(events, ["begin", "callback", "select 1", "commit", "release"]);
  assert.equal(release.mock.callCount(), 1);
});

function mockClient(
  execute: (text: string, values?: unknown[]) => Promise<QueryResult<Record<string, unknown>>>,
  events: string[],
) {
  const query = mock.fn(execute);
  const release = mock.fn(() => {
    events.push("release");
  });
  const client = { query, release } as unknown as PoolClient;

  mock.method(Pool.prototype, "connect", async () => client);

  return { query, release };
}

function emptyResult(): QueryResult<Record<string, unknown>> {
  return { rows: [], rowCount: 0 };
}

async function rejectsWithIdentity(promise: Promise<unknown>, expected: Error) {
  await assert.rejects(promise, (error) => {
    assert.equal(error, expected);
    return true;
  });
}

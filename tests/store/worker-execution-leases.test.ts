import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireWorkerExecutionLease,
  heartbeatWorkerExecutionLease,
  releaseWorkerExecutionLease,
} from "../../src/lib/store/worker-execution-leases";
import type { PostgresQuery } from "../../src/lib/store/postgres";

test("worker execution leases acquire, heartbeat, and release exact ownership", async () => {
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const query: PostgresQuery = async <T>(text: string, values?: unknown[]) => {
    statements.push({ text, values });
    if (text.includes("select exists")) return { rows: [{ acquired: true }] as T[], rowCount: 1 };
    return { rows: [{ lock_key: "rollups" }] as T[], rowCount: 1 };
  };
  const lease = { lockKey: "rollups", owner: "worker-a" };

  assert.equal(await acquireWorkerExecutionLease(lease, query), true);
  await heartbeatWorkerExecutionLease(lease, query);
  await releaseWorkerExecutionLease(lease, query);

  assert.deepEqual(statements.map((statement) => statement.values?.slice(0, 2)), [
    ["rollups", "worker-a"],
    ["rollups", "worker-a"],
    ["rollups", "worker-a"],
  ]);
  assert.match(statements[0]!.text, /lease_expires_at < now\(\)/);
  assert.match(statements[1]!.text, /lease_owner = \$2 and lease_expires_at > now\(\)/);
  assert.match(statements[2]!.text, /lease_owner = null, lease_expires_at = null/);
});

test("worker execution lease rejects an active owner and detects a lost heartbeat", async () => {
  const unavailable: PostgresQuery = async <T>() => ({ rows: [{ acquired: false }] as T[], rowCount: 1 });
  assert.equal(await acquireWorkerExecutionLease({ lockKey: "ingest:jobs", owner: "worker-b" }, unavailable), false);

  const lost: PostgresQuery = async <T>() => ({ rows: [] as T[], rowCount: 0 });
  await assert.rejects(
    heartbeatWorkerExecutionLease({ lockKey: "ingest:jobs", owner: "worker-b" }, lost),
    /Lost worker execution lease ingest:jobs/,
  );
});

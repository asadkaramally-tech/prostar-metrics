import assert from "node:assert/strict";
import test from "node:test";
import { markScheduleSourceUnavailable } from "../../src/lib/simpro/normalize-nested";
import type { PostgresQuery } from "../../src/lib/store/postgres";

const tombstoneSnapshot = {
  entityType: "schedule_details",
  entityId: "170049",
  sourcePath: "/schedules/170049",
  payload: { sourceUnavailable: true, status: 404, scheduleId: 170049 },
  sourceHash: "schedule-170049-missing",
  parentIdentity: { scheduleId: 170049 },
};

test("schedule source deletion rejects an injected query before any operation without its transaction", async () => {
  let calls = 0;
  const query: PostgresQuery = async () => {
    calls += 1;
    return { rows: [], rowCount: 0 };
  };
  await assert.rejects(
    markScheduleSourceUnavailable(170049, {
      observedAt: "2026-07-13T12:00:00Z",
      tombstoneSnapshot,
      query,
    }),
    /requires an explicit transaction/,
  );
  assert.equal(calls, 0);
});

test("schedule source deletion uses one query for authority, evidence, mutations, and period queues", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const query: PostgresQuery = async <T>(text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (text.includes("from metrics.metrics_schedules") && text.includes("for update")) {
      return { rows: [{
        reference_type: "job",
        reference_id: "42",
        source_modified_at: "2026-07-10T09:00:00Z",
        fetched_at: "2026-07-10T10:00:00Z",
      }] as T[], rowCount: 1 };
    }
    if (text.includes("select distinct period_start::text")) {
      return { rows: [{ period_start: "2026-06-01" }, { period_start: "2026-07-01" }] as T[], rowCount: 2 };
    }
    if (text.includes("with upserted as")) {
      return { rows: [{ id: 99, inserted: true, extracted_at: "2026-07-13T12:00:00Z" }] as T[], rowCount: 1 };
    }
    if (text.includes("insert into metrics.rollup_rebuild_queue")) {
      return { rows: [{ id: "1", status: "queued" }] as T[], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  const result = await markScheduleSourceUnavailable(170049, {
    observedAt: "2026-07-13T12:00:00Z",
    tombstoneSnapshot,
    query,
    transaction: async (callback) => callback(query),
  });

  assert.deepEqual(result, {
    applied: true,
    snapshotInserted: true,
    affectedPeriods: [
      { scope: "technicians", periodStart: "2026-06-01" },
      { scope: "technicians", periodStart: "2026-07-01" },
    ],
  });
  assert.ok(calls.some((call) => call.text.includes("pg_advisory_xact_lock")));
  assert.ok(calls.some((call) => call.text.includes("update metrics.metrics_schedules")));
  assert.ok(calls.some((call) => call.text.includes("delete from metrics.schedule_snapshots")));
  assert.ok(calls.some((call) => call.text.includes("update metrics.metrics_schedule_blocks")));
  assert.ok(calls.some((call) => call.text.includes("parent_identity->>'scheduleId'")));
  assert.equal(calls.filter((call) => call.text.includes("insert into metrics.rollup_rebuild_queue")).length, 2);
});

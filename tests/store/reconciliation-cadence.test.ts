import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  ALL_MONTHS_CURSOR_RESET_CONFIRMATION,
  allMonthStarts,
  createPostgresReconciliationCadenceStore,
  pacificMonthStart,
  resetAllMonthsReconciliationCursor,
  runReconciliationCadence,
  trailingMonthStarts,
  type ReconciliationCadenceMode,
  type ReconciliationCadenceStore,
} from "../../src/lib/store/reconciliation-cadence";
import type { ReconciliationResult } from "../../src/lib/store/reconciliation";
import { parseResetAllMonthsArgs } from "../../workers/reset-all-months-reconciliation";

test("all-month cursor reset is explicit, audited, and starts at January 2023", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const query = async <T>(sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (/select source_hash/.test(sql)) return { rows: [{ source_hash: "2026-08-01" }] as T[], rowCount: 1 };
    if (/update metrics\.ingestion_watermarks/.test(sql)) return { rows: [{ source_hash: "2023-01-01" }] as T[], rowCount: 1 };
    if (/insert into metrics\.audit_events/.test(sql)) return { rows: [{ id: "42" }] as T[], rowCount: 1 };
    return { rows: [] as T[], rowCount: 1 };
  };
  let transactions = 0;
  const transaction = async <T>(callback: (transactionQuery: typeof query) => Promise<T>) => {
    transactions += 1;
    return callback(query);
  };
  await assert.rejects(
    resetAllMonthsReconciliationCursor({ actorEmail: "owner@example.com", confirmation: "wrong", query }),
    /confirmation must equal/,
  );
  const result = await resetAllMonthsReconciliationCursor({
    actorEmail: "Owner@Example.com",
    confirmation: ALL_MONTHS_CURSOR_RESET_CONFIRMATION,
    query,
    transaction,
  });
  assert.deepEqual(result, { previous_cursor: "2026-08-01", current_cursor: "2023-01-01", audit_id: "42" });
  assert.equal(transactions, 1);
  assert.match(calls[1].sql, /for update/);
  assert.match(calls[2].sql, /'2023-01-01'/);
  assert.match(calls[3].sql, /reconciliation_all_months_cursor_reset/);
  assert.deepEqual(calls[3].values, ["owner@example.com", "2026-08-01", "2023-01-01"]);

  assert.deepEqual(
    parseResetAllMonthsArgs(["--actor", "owner@example.com", "--confirm", ALL_MONTHS_CURSOR_RESET_CONFIRMATION]),
    { actorEmail: "owner@example.com", confirmation: ALL_MONTHS_CURSOR_RESET_CONFIRMATION },
  );
  assert.throws(() => parseResetAllMonthsArgs(["--actor", "owner@example.com"]), /--confirm/);
});

test("cursor reset locks the current value and audits the value it overwrites", async () => {
  const db = new PGlite();
  await db.exec(`
    create schema metrics;
    create table metrics.ingestion_watermarks (
      entity text not null, window_key text not null, status text not null,
      source_hash text, last_attempt_at timestamptz, updated_at timestamptz,
      primary key (entity, window_key)
    );
    create table metrics.audit_events (
      id bigserial primary key, actor_email text not null, action text not null,
      entity_type text not null, entity_id text not null, before_value jsonb,
      after_value jsonb, reason text not null
    );
    insert into metrics.ingestion_watermarks (
      entity, window_key, status, source_hash, last_attempt_at, updated_at
    ) values ('reconciliation_cadence', 'all-months', 'current', '2026-08-01', now(), now());
  `);
  const query = async <T>(sql: string, values?: unknown[]) => {
    const result = await db.query<T>(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? null };
  };
  const transaction = async <T>(callback: (transactionQuery: typeof query) => Promise<T>) => {
    await db.exec("begin");
    try {
      const result = await callback(query);
      await db.exec("commit");
      return result;
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  };
  try {
    const result = await resetAllMonthsReconciliationCursor({
      actorEmail: "owner@example.com",
      confirmation: ALL_MONTHS_CURSOR_RESET_CONFIRMATION,
      query,
      transaction,
    });
    assert.deepEqual(result, { previous_cursor: "2026-08-01", current_cursor: "2023-01-01", audit_id: "1" });
    const audit = await db.query<{ before_cursor: string; after_cursor: string }>(`
      select before_value ->> 'cursor' as before_cursor, after_value ->> 'cursor' as after_cursor
        from metrics.audit_events
    `);
    assert.deepEqual(audit.rows, [{ before_cursor: "2026-08-01", after_cursor: "2023-01-01" }]);
  } finally {
    await db.close();
  }
});

test("trailing window contains the latest 24 Pacific calendar months", () => {
  assert.equal(pacificMonthStart(new Date("2026-01-01T07:30:00.000Z")), "2025-12-01");
  assert.equal(pacificMonthStart(new Date("2026-01-01T08:30:00.000Z")), "2026-01-01");
  const months = trailingMonthStarts(new Date("2026-07-09T12:00:00.000Z"));
  assert.equal(months.length, 24);
  assert.equal(months[0], "2024-08-01");
  assert.equal(months.at(-1), "2026-07-01");
});

test("all-month cadence resumes from January 2023 and seals the current Pacific month", async () => {
  const months = allMonthStarts(new Date("2026-07-09T12:00:00.000Z"));
  assert.equal(months[0], "2023-01-01");
  assert.equal(months.at(-1), "2026-07-01");

  const store = memoryStore("2023-01-01");
  const run = await runReconciliationCadence(
    { ...cadenceOptions("all-months"), batchMonths: 60 },
    {
      store,
      clock: () => new Date("2026-07-09T12:00:00.000Z"),
      reconcile: async (options) => matchedAllResults(options.periodStart!, 1),
    },
  );
  assert.deepEqual(run.processed.map((entry) => entry.periodStart), months);
  assert.equal(run.cursorEnd, "2026-08-01");
  assert.equal(run.stopReason, "complete");

  const repeated = await runReconciliationCadence(
    { ...cadenceOptions("all-months"), batchMonths: 60 },
    {
      store,
      clock: () => new Date("2026-07-09T12:00:00.000Z"),
      reconcile: async () => {
        throw new Error("completed months must not run again");
      },
    },
  );
  assert.equal(repeated.stopReason, "complete");
  assert.equal(repeated.processed.length, 0);
});

test("all-month cursor remains on sample-missing, failed, and scope-incomplete months", async (t) => {
  for (const scenario of [
    {
      name: "sample missing",
      results: (periodStart: string) => [
        { ...result(periodStart, 4), status: "sample_missing" as const },
        ...matchedAllResults(periodStart, 4).slice(1),
      ],
    },
    {
      name: "failed",
      results: (periodStart: string) => [
        { ...result(periodStart, 4), status: "failed" },
        ...matchedAllResults(periodStart, 4).slice(1),
      ] as ReconciliationResult[],
    },
    {
      name: "missing scope",
      results: (periodStart: string) => matchedAllResults(periodStart, 4).slice(0, 3),
    },
  ]) {
    await t.test(scenario.name, async () => {
      const store = memoryStore("2023-03-01");
      const run = await runReconciliationCadence(
        cadenceOptions("all-months"),
        {
          store,
          clock: () => new Date("2026-07-09T12:00:00.000Z"),
          reconcile: async (options) => scenario.results(options.periodStart!),
        },
      );
      assert.equal(run.stopReason, "incomplete-month");
      assert.equal(run.cursorEnd, "2023-03-01");
      assert.deepEqual(run.processed.map((entry) => entry.periodStart), ["2023-03-01"]);

      const retried = await runReconciliationCadence(
        cadenceOptions("all-months"),
        {
          store,
          clock: () => new Date("2026-07-09T12:00:00.000Z"),
          reconcile: async (options) => scenario.results(options.periodStart!),
        },
      );
      assert.equal(retried.processed[0]?.periodStart, "2023-03-01");
    });
  }
});

test("trailing cadence resumes its cursor and shares the 1,000-request budget", async () => {
  const store = memoryStore("2024-08-01");
  const calls: Array<{ periodStart?: string; requestBudget?: number }> = [];
  const run = await runReconciliationCadence(
    cadenceOptions("trailing-24-months"),
    {
      store,
      clock: () => new Date("2026-07-09T12:00:00.000Z"),
      reconcile: async (options) => {
        calls.push(options);
        const used = calls.length === 1 ? 400 : 600;
        return [result(options.periodStart!, used)];
      },
    },
  );

  assert.deepEqual(calls, [
    { scope: "all", periodStart: "2024-08-01", requestBudget: 1000 },
    { scope: "all", periodStart: "2024-09-01", requestBudget: 600 },
  ]);
  assert.equal(run.requestsUsed, 1000);
  assert.equal(run.cursorEnd, "2024-10-01");
  assert.equal(run.stopReason, "request-budget");
});

test("forced cadence disables only-if-needed without changing cursor advancement", async () => {
  const store = memoryStore("2023-01-01");
  const calls: Array<{ periodStart?: string; onlyIfNeeded?: boolean }> = [];
  const run = await runReconciliationCadence(
    { ...cadenceOptions("all-months"), scope: "technicians", batchMonths: 1, force: true },
    {
      store,
      clock: () => new Date("2026-07-09T12:00:00.000Z"),
      reconcile: async (options) => {
        calls.push(options);
        return [{ ...result(options.periodStart!, 0), scope: "technicians" }];
      },
    },
  );

  assert.deepEqual(calls, [{
    scope: "technicians",
    periodStart: "2023-01-01",
    requestBudget: 1000,
    onlyIfNeeded: false,
  }]);
  assert.equal(run.cursorEnd, "2023-02-01");
  assert.equal(run.stopReason, "batch-limit");
});

test("cadence stops after advancing the completed month when the runtime expires", async () => {
  const store = memoryStore("2024-08-01");
  let now = Date.parse("2026-07-09T12:00:00.000Z");
  const run = await runReconciliationCadence(
    { ...cadenceOptions("trailing-24-months"), runtimeMinutes: 20 },
    {
      store,
      clock: () => new Date(now),
      reconcile: async (options) => {
        now += 20 * 60_000;
        return [result(options.periodStart!, 10)];
      },
    },
  );

  assert.deepEqual(run.processed.map((entry) => entry.periodStart), ["2024-08-01"]);
  assert.equal(run.cursorEnd, "2024-09-01");
  assert.equal(run.stopReason, "runtime-limit");
});

test("older history processes only stable eligible months at or after its persisted cursor", async () => {
  const store = memoryStore("2022-02-01", ["2022-01-01", "2022-03-01", "2022-05-01"]);
  const run = await runReconciliationCadence(
    cadenceOptions("older-stable-history"),
    {
      store,
      clock: () => new Date("2026-07-09T12:00:00.000Z"),
      reconcile: async (options) => [result(options.periodStart!, 25)],
    },
  );

  assert.deepEqual(run.processed.map((entry) => entry.periodStart), ["2022-03-01", "2022-05-01"]);
  assert.equal(run.cursorEnd, "2022-06-01");
  assert.equal(run.cutoffMonth, "2024-08-01");
});

test("unknown modes and cadence bounds fail closed", async () => {
  await assert.rejects(
    runReconciliationCadence({ ...cadenceOptions("trailing-24-months"), mode: "unknown" as ReconciliationCadenceMode }),
    /Unknown reconciliation cadence mode/,
  );
  await assert.rejects(
    runReconciliationCadence({ ...cadenceOptions("trailing-24-months"), batchMonths: 4 }),
    /batchMonths/,
  );
  await assert.rejects(
    runReconciliationCadence({ ...cadenceOptions("trailing-24-months"), runtimeMinutes: 21 }),
    /runtimeMinutes/,
  );
  await assert.rejects(
    runReconciliationCadence({ ...cadenceOptions("trailing-24-months"), requestBudget: 1001 }),
    /requestBudget/,
  );
});

test("Postgres store requires two unchanged matched checks for all four scopes", async () => {
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const store = createPostgresReconciliationCadenceStore(async <T>(text: string, values?: unknown[]) => {
    statements.push({ text, values });
    return { rows: [{ period_start: "2023-01-01" }] as T[], rowCount: 1 };
  });
  const months = await store.listStableHistoryMonths("2024-08-01");

  assert.deepEqual(months, ["2023-01-01"]);
  assert.match(statements[0].text, /row_number\(\) over/);
  assert.match(statements[0].text, /latest\.status = 'matched'/);
  assert.match(statements[0].text, /previous\.status = 'matched'/);
  assert.equal([...statements[0].text.matchAll(/is not distinct from/g)].length, 4);
  assert.deepEqual(statements[0].values, [
    "2024-08-01",
    ["quotes", "jobs", "technicians", "commissions"],
    4,
  ]);
});

function cadenceOptions(mode: ReconciliationCadenceMode) {
  return { mode, scope: "all" as const, batchMonths: 3, runtimeMinutes: 20, requestBudget: 1000 };
}

function result(periodStart: string, requestsUsed: number): ReconciliationResult {
  return {
    scope: "quotes",
    periodStart,
    periodEnd: periodStart,
    status: "matched",
    checkId: 1,
    rollupValue: 1,
    snapshotValue: 1,
    upstreamSampleValue: 1,
    detail: { requestsUsed },
  };
}

function matchedAllResults(periodStart: string, requestsUsed: number): ReconciliationResult[] {
  return (["quotes", "jobs", "technicians", "commissions"] as const).map((scope, index) => ({
    ...result(periodStart, requestsUsed),
    scope,
    checkId: index + 1,
  }));
}

function memoryStore(initialCursor: string, stableMonths: string[] = []): ReconciliationCadenceStore {
  let cursor = initialCursor;
  return {
    async loadCursor() {
      return cursor;
    },
    async advanceCursor(_mode, expectedCursor, nextCursor) {
      if (cursor !== expectedCursor) return false;
      cursor = nextCursor;
      return true;
    },
    async listStableHistoryMonths() {
      return stableMonths;
    },
  };
}

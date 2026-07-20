import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  planEmployeeTimesheetTombstone,
  tombstoneAbsentEmployeeTimesheets,
} from "../../src/lib/simpro/ingest";
import type { PostgresQuery } from "../../src/lib/store/postgres";

const window = { StartDate: "2026-06-01", EndDate: "2026-06-30" };

test("a saved continuation is partial evidence and never plans a tombstone", () => {
  const plan = planEmployeeTimesheetTombstone({
    employeeId: 42,
    window,
    startedAtFirstPage: true,
    continuationToken: { page: 2 },
    seenTimesheetIds: ["A"],
    seenSnapshotEntityIds: ["42:A"],
  });
  assert.equal(plan, null);
});

test("a traversal resumed above page one lacks the earlier seen set and never plans a tombstone", () => {
  const plan = planEmployeeTimesheetTombstone({
    employeeId: 42,
    window,
    startedAtFirstPage: false,
    continuationToken: null,
    seenTimesheetIds: ["B"],
    seenSnapshotEntityIds: ["42:B"],
  });
  assert.equal(plan, null);
});

test("a complete employee-window traversal plans a tombstone scoped to that employee and window", () => {
  const plan = planEmployeeTimesheetTombstone({
    employeeId: 42,
    window,
    startedAtFirstPage: true,
    continuationToken: null,
    seenTimesheetIds: ["A", "B", "A"],
    seenSnapshotEntityIds: ["42:A", "42:B", "42:A"],
  });
  assert.deepEqual(plan, {
    employeeId: 42,
    startDate: "2026-06-01",
    endDate: "2026-06-30",
    seenTimesheetIds: ["A", "B"],
    seenSnapshotEntityIds: ["42:A", "42:B"],
  });
});

test("tombstoning is scoped to the traversed employee and window and reports affected periods", async () => {
  const db = await timesheetDatabase();
  const { transaction } = pgliteRuntime(db);
  try {
    await db.exec(`
      insert into metrics.metrics_jobs (job_id, completed_date, stage) values
        (500, '2026-06-15', 'Complete'),
        (501, '2026-06-20', 'Pending');
      insert into metrics.metrics_employee_timesheets (
        timesheet_id, employee_id, reference_type, reference_id, work_date, source_deleted_at
      ) values
        ('A', 42, 'job', 500, '2026-06-10', null),
        ('B', 42, 'job', 500, '2026-06-12', null),
        ('C', 42, 'job', 500, '2026-05-20', null),
        ('D', 42, 'job', 500, '2026-06-13', timestamptz '2026-06-14T00:00:00Z'),
        ('E', 42, 'activity', null, '2026-06-14', null),
        ('G', 42, 'job', 501, '2026-06-16', null),
        ('F', 43, 'job', 500, '2026-06-11', null);
      insert into metrics.timesheet_snapshots (employee_id, simpro_timesheet_id, work_date) values
        (42, 'A', '2026-06-10'),
        (42, 'B', '2026-06-12'),
        (42, 'C', '2026-05-20'),
        (43, 'F', '2026-06-11');
      insert into metrics.raw_simpro_snapshots (entity_type, entity_id, payload, source_deleted_at) values
        ('timesheets', '42:A', '{"Date":"2026-06-10"}', null),
        ('timesheets', '42:B', '{"Date":"2026-06-12"}', null),
        ('timesheets', '42:C', '{"Date":"2026-05-20"}', null),
        ('timesheets', '43:F', '{"Date":"2026-06-11"}', null),
        ('timesheets', '4:X', '{"Date":"2026-06-10"}', null),
        ('employees', '42', '{"Date":"2026-06-10"}', null);
    `);

    const result = await tombstoneAbsentEmployeeTimesheets({
      employeeId: 42,
      startDate: window.StartDate,
      endDate: window.EndDate,
      seenTimesheetIds: ["A"],
      seenSnapshotEntityIds: ["42:A"],
    }, transaction);

    // B (absent, in window), E (absent activity row), and G (absent, job not
    // completed) are tombstoned. A was seen, C is outside the window, D was
    // already tombstoned, F belongs to another employee.
    assert.equal(result.tombstonedCount, 3);
    assert.deepEqual(result.affectedPeriods, [
      { scope: "jobs", periodStart: "2026-06-01" },
      { scope: "technicians", periodStart: "2026-06-01" },
      { scope: "commissions", periodStart: "2026-06-01" },
    ]);

    const facts = await db.query<{ timesheet_id: string; employee_id: number; deleted: boolean }>(`
      select timesheet_id, employee_id::int as employee_id, source_deleted_at is not null as deleted
        from metrics.metrics_employee_timesheets
       order by employee_id, timesheet_id
    `);
    assert.deepEqual(facts.rows, [
      { timesheet_id: "A", employee_id: 42, deleted: false },
      { timesheet_id: "B", employee_id: 42, deleted: true },
      { timesheet_id: "C", employee_id: 42, deleted: false },
      { timesheet_id: "D", employee_id: 42, deleted: true },
      { timesheet_id: "E", employee_id: 42, deleted: true },
      { timesheet_id: "G", employee_id: 42, deleted: true },
      { timesheet_id: "F", employee_id: 43, deleted: false },
    ]);

    const snapshots = await db.query<{ employee_id: number; simpro_timesheet_id: string }>(`
      select employee_id::int as employee_id, simpro_timesheet_id
        from metrics.timesheet_snapshots
       order by employee_id, simpro_timesheet_id
    `);
    assert.deepEqual(snapshots.rows, [
      { employee_id: 42, simpro_timesheet_id: "A" },
      { employee_id: 42, simpro_timesheet_id: "C" },
      { employee_id: 43, simpro_timesheet_id: "F" },
    ]);

    const raw = await db.query<{ entity_id: string; deleted: boolean }>(`
      select entity_id, source_deleted_at is not null as deleted
        from metrics.raw_simpro_snapshots
       order by entity_type, entity_id
    `);
    assert.deepEqual(raw.rows, [
      { entity_id: "42", deleted: false },
      { entity_id: "42:A", deleted: false },
      { entity_id: "42:B", deleted: true },
      { entity_id: "42:C", deleted: false },
      { entity_id: "43:F", deleted: false },
      { entity_id: "4:X", deleted: false },
    ]);

    // A later complete traversal that observed nothing tombstones the other
    // employee's whole window: verified emptiness is authoritative evidence.
    const emptied = await tombstoneAbsentEmployeeTimesheets({
      employeeId: 43,
      startDate: window.StartDate,
      endDate: window.EndDate,
      seenTimesheetIds: [],
      seenSnapshotEntityIds: [],
    }, transaction);
    assert.equal(emptied.tombstonedCount, 1);
    const other = await db.query<{ deleted: boolean; snapshots: number }>(`
      select (select source_deleted_at is not null from metrics.metrics_employee_timesheets
               where employee_id = 43 and timesheet_id = 'F') as deleted,
             (select count(*)::int from metrics.timesheet_snapshots where employee_id = 43) as snapshots
    `);
    assert.deepEqual(other.rows[0], { deleted: true, snapshots: 0 });
  } finally {
    await db.close();
  }
});

test("tombstoning is idempotent and repeated complete traversals change nothing", async () => {
  const db = await timesheetDatabase();
  const { transaction } = pgliteRuntime(db);
  try {
    await db.exec(`
      insert into metrics.metrics_employee_timesheets (
        timesheet_id, employee_id, reference_type, reference_id, work_date, source_deleted_at
      ) values ('B', 42, 'activity', null, '2026-06-12', null);
    `);
    const first = await tombstoneAbsentEmployeeTimesheets({
      employeeId: 42,
      startDate: window.StartDate,
      endDate: window.EndDate,
      seenTimesheetIds: [],
      seenSnapshotEntityIds: [],
    }, transaction);
    const second = await tombstoneAbsentEmployeeTimesheets({
      employeeId: 42,
      startDate: window.StartDate,
      endDate: window.EndDate,
      seenTimesheetIds: [],
      seenSnapshotEntityIds: [],
    }, transaction);
    assert.equal(first.tombstonedCount, 1);
    assert.equal(second.tombstonedCount, 0);
    assert.deepEqual(second.affectedPeriods, []);
  } finally {
    await db.close();
  }
});

async function timesheetDatabase() {
  const db = new PGlite();
  await db.exec(`
    create schema metrics;
    create table metrics.metrics_jobs (
      job_id bigint primary key,
      completed_date date,
      stage text,
      source_deleted_at timestamptz
    );
    create table metrics.metrics_employee_timesheets (
      timesheet_id text not null,
      employee_id bigint not null,
      reference_type text,
      reference_id bigint,
      work_date date,
      source_deleted_at timestamptz,
      updated_from_source_at timestamptz,
      primary key (employee_id, timesheet_id)
    );
    create table metrics.timesheet_snapshots (
      employee_id bigint not null,
      simpro_timesheet_id text not null,
      work_date date,
      primary key (employee_id, simpro_timesheet_id)
    );
    create table metrics.raw_simpro_snapshots (
      id bigserial primary key,
      entity_type text not null,
      entity_id text not null,
      payload jsonb not null default '{}',
      source_deleted_at timestamptz
    );
  `);
  return db;
}

function pgliteRuntime(db: PGlite) {
  const query: PostgresQuery = async <T>(sql: string, values?: unknown[]) => {
    const result = await db.query<T>(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? null };
  };
  const transaction = async <T>(callback: (transactionQuery: PostgresQuery) => Promise<T>): Promise<T> => {
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
  return { query, transaction };
}

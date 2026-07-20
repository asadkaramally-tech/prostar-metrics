import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSimproSnapshot } from "../../src/lib/simpro/normalize";
import type { PostgresQuery } from "../../src/lib/store/postgres";

test("timesheet normalization routes person, canonical, snapshot, and job-period reads through the injected query", async () => {
  const statements: string[] = [];
  const query: PostgresQuery = async (text) => {
    statements.push(text);
    return { rows: [], rowCount: 0 };
  };
  const result = await normalizeSimproSnapshot({
    entity: "timesheets",
    entityId: "17:timesheet-1",
    payload: {
      UID: "timesheet-1",
      EmployeeID: 17,
      Employee: { ID: 17, Name: "Technician 17" },
      ScheduleType: "Job",
      Reference: "42-1",
      Date: "2026-07-13",
      StartTime: "08:30",
      EndTime: "12:30",
      TotalHrs: 4,
    },
    query,
  });
  assert.equal(result.normalized, true);
  assert.equal(statements.length, 4);
  assert.ok(statements.some((text) => text.includes("insert into metrics.dim_people")));
  assert.ok(statements.some((text) => text.includes("insert into metrics.metrics_employee_timesheets")));
  assert.ok(statements.some((text) => text.includes("insert into metrics.timesheet_snapshots")));
  assert.ok(statements.some((text) => text.includes("from metrics.metrics_jobs")));
});

test("mobile normalization routes person and status publication through the injected query", async () => {
  const statements: string[] = [];
  const query: PostgresQuery = async (text) => {
    statements.push(text);
    return { rows: [], rowCount: 0 };
  };
  const result = await normalizeSimproSnapshot({
    entity: "mobile_status",
    entityId: "91",
    payload: {
      ID: 91,
      Staff: { ID: 17, Name: "Technician 17" },
      WorkOrder: { ID: 3, Type: "Job", ProjectID: 42, CostCenterID: 5 },
      Status: { ID: 6, Name: "On Site" },
      DateLogged: "2026-07-13T09:00:00-07:00",
    },
    query,
  });
  assert.equal(result.normalized, true);
  assert.equal(statements.length, 2);
  assert.ok(statements.some((text) => text.includes("insert into metrics.dim_people")));
  assert.ok(statements.some((text) => text.includes("insert into metrics.metrics_mobile_status_logs")));
});

test("job root normalization reprojects category from persisted nested cost centers", async () => {
  const statements: string[] = [];
  const query: PostgresQuery = async (text) => {
    statements.push(text);
    return { rows: [], rowCount: 0 };
  };
  const result = await normalizeSimproSnapshot({
    entity: "jobs",
    entityId: "17212",
    payload: {
      ID: 17212,
      JobNo: "J-17212",
      Name: "Root refresh without nested cost centers",
      Stage: "Complete",
      Total: { ExTax: 59 },
    },
    query,
  });
  assert.equal(result.normalized, true);
  assert.ok(statements.some((text) => text.includes("insert into metrics.metrics_jobs")));
  assert.ok(statements.some((text) => text.includes("child_updated") && text.includes("canonical_updated")));
});

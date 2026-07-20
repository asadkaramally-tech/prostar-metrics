import assert from "node:assert/strict";
import test from "node:test";
import type { SimproClient } from "../../src/lib/simpro/client";
import { SimproEndpoints } from "../../src/lib/simpro/endpoints";
import { buildEmployeeTimesheetQuery, planSummaryRows } from "../../src/lib/simpro/ingest";

class StubClient {
  calls: Array<{ path: string; query?: Record<string, unknown> }> = [];

  async getJson<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    this.calls.push({ path, query });
    return [] as T;
  }
}

async function captureEmployeeTimesheetRequest() {
  const client = new StubClient();
  const endpoints = new SimproEndpoints(client as unknown as SimproClient);
  const query = buildEmployeeTimesheetQuery({
    StartDate: "2026-06-01",
    EndDate: "2026-06-30",
  });

  await endpoints.listEmployeeTimesheets(42, { query });
  return client.calls[0];
}

test("employee timesheet ingestion omits unsupported display=all", async () => {
  const request = await captureEmployeeTimesheetRequest();

  assert.equal(request?.path, "/employees/42/timesheets/");
  assert.equal(Object.hasOwn(request?.query ?? {}, "display"), false);
});

test("employee timesheet ingestion does not narrow Includes to Job", async () => {
  const request = await captureEmployeeTimesheetRequest();

  assert.deepEqual(request?.query, {
    StartDate: "2026-06-01",
    EndDate: "2026-06-30",
  });
  assert.equal(Object.hasOwn(request?.query ?? {}, "Includes"), false);
});

test("a one-request 250-row parent page creates exact restart-safe detail coverage", () => {
  const rows = Array.from({ length: 250 }, (_, index) => ({ ID: index + 1, Name: `Job ${index + 1}` }));

  const firstAttempt = planSummaryRows("jobs", rows);
  const replay = planSummaryRows("jobs", rows);

  assert.equal(firstAttempt.length, 250);
  assert.equal(new Set(firstAttempt.map((item) => item.candidate.entityId)).size, 250);
  assert.ok(firstAttempt.every((item) => item.candidate.entity === "job_nested"));
  assert.deepEqual(
    replay.map((item) => item.candidate),
    firstAttempt.map((item) => item.candidate),
  );
});

test("every summary family maps all valid rows to a detail candidate", () => {
  const rows = [{ ID: 7 }, { ID: 8 }];

  assert.deepEqual(planSummaryRows("quotes", rows).map((item) => item.candidate.entity), ["quote_nested", "quote_nested"]);
  assert.deepEqual(planSummaryRows("jobs", rows).map((item) => item.candidate.entity), ["job_nested", "job_nested"]);
  assert.deepEqual(planSummaryRows("employees", rows).map((item) => item.candidate.entity), ["employees", "employees"]);
  assert.deepEqual(planSummaryRows("schedules", rows).map((item) => item.candidate.entity), ["schedules", "schedules"]);
});

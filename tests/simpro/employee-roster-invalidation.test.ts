import assert from "node:assert/strict";
import test from "node:test";
import {
  employeeRosterPeriodStarts,
  normalizeEmployeeCapacity,
  normalizeSimproSnapshot,
} from "../../src/lib/simpro/normalize";
import type { PostgresQuery } from "../../src/lib/store/postgres";

type PriorPersonRow = {
  position: string | null;
  archived: boolean | null;
  date_of_hire: string | null;
  availability_json: unknown;
};

function employeeQuery(prior: PriorPersonRow | null) {
  const statements: string[] = [];
  const query: PostgresQuery = async <T = Record<string, unknown>>(text: string) => {
    statements.push(text);
    if (text.includes("select position, archived, date_of_hire")) {
      return { rows: (prior ? [prior] : []) as T[], rowCount: prior ? 1 : 0 };
    }
    return { rows: [] as T[], rowCount: 0 };
  };
  return { query, statements };
}

function fieldTechnicianPayload(overrides: Record<string, unknown> = {}) {
  return {
    ID: 134,
    Name: "Roberto Villalta",
    Position: "Service Technician ",
    Archived: false,
    DateOfHire: "2022-11-21",
    ...overrides,
  };
}

const expectedInvalidation = employeeRosterPeriodStarts(
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }),
).flatMap((periodStart) => [
  { scope: "technicians" as const, periodStart },
  { scope: "commissions" as const, periodStart },
]);

test("employee roster invalidation window is the prior and current business month", () => {
  assert.deepEqual(employeeRosterPeriodStarts("2026-07-15"), ["2026-06-01", "2026-07-01"]);
  assert.deepEqual(employeeRosterPeriodStarts("2026-01-03"), ["2025-12-01", "2026-01-01"]);
});

test("a newly seen field technician invalidates technician and commission periods", async () => {
  const { query } = employeeQuery(null);
  const result = await normalizeSimproSnapshot({
    entity: "employees",
    entityId: "134",
    payload: fieldTechnicianPayload(),
    query,
  });
  assert.equal(result.normalized, true);
  assert.deepEqual(result.affectedPeriods, expectedInvalidation);
});

test("a position change onto or off the field roster invalidates periods", async () => {
  const promoted = await normalizeSimproSnapshot({
    entity: "employees",
    entityId: "207",
    payload: fieldTechnicianPayload({ ID: 207, Name: "Stephen Furtado" }),
    query: employeeQuery({
      position: "Service Manager",
      archived: false,
      date_of_hire: "2022-11-21",
      availability_json: null,
    }).query,
  });
  assert.deepEqual(promoted.affectedPeriods, expectedInvalidation);

  const demoted = await normalizeSimproSnapshot({
    entity: "employees",
    entityId: "207",
    payload: fieldTechnicianPayload({ ID: 207, Position: "Service Manager" }),
    query: employeeQuery({
      position: "Service Technician ",
      archived: false,
      date_of_hire: "2022-11-21",
      availability_json: null,
    }).query,
  });
  assert.deepEqual(demoted.affectedPeriods, expectedInvalidation);
});

test("archiving a field technician invalidates periods", async () => {
  const result = await normalizeSimproSnapshot({
    entity: "employees",
    entityId: "253",
    payload: fieldTechnicianPayload({ ID: 253, Name: "Victor Contreras", Archived: true }),
    query: employeeQuery({
      position: "Service Technician ",
      archived: false,
      date_of_hire: "2022-11-21",
      availability_json: JSON.parse(JSON.stringify(normalizeEmployeeCapacity(undefined).schedule ?? null)),
    }).query,
  });
  assert.deepEqual(result.affectedPeriods, expectedInvalidation);
});

test("an unchanged field technician re-ingest does not thrash read models", async () => {
  const result = await normalizeSimproSnapshot({
    entity: "employees",
    entityId: "134",
    payload: fieldTechnicianPayload(),
    query: employeeQuery({
      position: "Service Technician ",
      archived: false,
      date_of_hire: "2022-11-21",
      availability_json: JSON.parse(JSON.stringify(normalizeEmployeeCapacity(undefined).schedule ?? null)),
    }).query,
  });
  assert.equal(result.normalized, true);
  assert.deepEqual(result.affectedPeriods, []);
});

test("any employee's attribute change invalidates technician periods, whatever their position", async () => {
  // Owner rule (2026-07-16): roster membership follows recorded work, so
  // position no longer decides who matters. Anyone whose attributes change
  // could be in some month's roster, so the rebuild must be triggered.
  const result = await normalizeSimproSnapshot({
    entity: "employees",
    entityId: "12",
    payload: { ID: 12, Name: "Office Admin", Position: "Controller", Archived: false },
    query: employeeQuery({
      position: "Admin Assistant",
      archived: false,
      date_of_hire: null,
      availability_json: null,
    }).query,
  });
  assert.equal(result.normalized, true);
  assert.ok(result.affectedPeriods.length > 0, "a changed employee must invalidate technician periods");
  assert.ok(result.affectedPeriods.every((period) => ["technicians", "commissions"].includes(period.scope)));
});

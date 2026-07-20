import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PostgresQuery } from "../../src/lib/store/postgres";
import {
  TECHNICIAN_RECONCILIATION_SOURCE_FAMILIES,
  compareTechnicianReconciliationInputs,
  getTechnicianManifestAuthority,
  getTechnicianReconciliationSourceInputs,
  isTechnicianManifestAuthorityPublishable,
  persistTechnicianReconciliationResults,
} from "../../src/lib/store/technician-reconciliation";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);

test("technician publication authority requires positive exact page completion", async () => {
  const invalidCounts = [
    { label: "zero", expected: 0, completed: 0 },
    { label: "null", expected: null, completed: null },
    { label: "negative", expected: -1, completed: -1 },
    { label: "impossible", expected: 1, completed: 2 },
  ];
  for (const counts of invalidCounts) {
    const authority = await getTechnicianManifestAuthority(
      "2026-06-01",
      "2026-06-30",
      manifestAuthorityQuery(counts.expected, counts.completed),
    );
    assert.deepEqual(
      authority,
      { complete: false, matched: false, generations: {} },
      `${counts.label} page counts must fail closed for every source family`,
    );
  }

  const authority = await getTechnicianManifestAuthority(
    "2026-06-01",
    "2026-06-30",
    manifestAuthorityQuery(2, 2),
  );
  assert.deepEqual(authority, {
    complete: true,
    matched: true,
    generations: Object.fromEntries(
      TECHNICIAN_RECONCILIATION_SOURCE_FAMILIES.map((family) => [family, 11]),
    ),
  });
});

test("technician publication rejects incomplete or unmatched manifest statuses", async () => {
  const invalidStatuses = [
    { label: "partial coverage", coverageStatus: "partial", reconciliationStatus: "matched" },
    { label: "pending reconciliation", coverageStatus: "complete", reconciliationStatus: "pending" },
    { label: "mismatched reconciliation", coverageStatus: "complete", reconciliationStatus: "mismatch" },
    { label: "null coverage", coverageStatus: null, reconciliationStatus: "matched" },
    { label: "null reconciliation", coverageStatus: "complete", reconciliationStatus: null },
  ];
  for (const statuses of invalidStatuses) {
    const authority = await getTechnicianManifestAuthority(
      "2026-06-01",
      "2026-06-30",
      manifestAuthorityQuery(2, 2, statuses),
    );
    assert.equal(authority.complete, true, `${statuses.label} retains structurally complete traversal evidence`);
    assert.equal(authority.matched, false, `${statuses.label} must not be publishable`);
    assert.equal(isTechnicianManifestAuthorityPublishable(authority), false);
  }

  const matchedAuthority = await getTechnicianManifestAuthority(
    "2026-06-01",
    "2026-06-30",
    manifestAuthorityQuery(2, 2),
  );
  assert.equal(isTechnicianManifestAuthorityPublishable(matchedAuthority), true);
});

test("technician reconciliation derives, persists, and protects employee-keyed comparisons", async () => {
  const db = new PGlite();
  try {
    for (const migration of await loadMigrations()) await db.exec(migration.sql);
    await db.exec(`
      insert into metrics.dim_people (simpro_employee_id, display_name, position, archived, date_of_hire) values
        (1, 'Alex Rivera', 'Service Technician ', false, '2022-01-10'),
        (2, 'Morgan Lee', 'Dispatcher', false, null),
        (3, 'Vic Archived', 'Service Technician', true, '2023-02-01'),
        (4, 'Tia Hired Later', 'Apprentice', false, '2026-08-15');
      insert into metrics.metrics_jobs (
        job_id, completed_date, stage, total, gross_profit_actual, net_profit_actual, job_source_type, source_hash
      ) values (100, '2026-06-15', 'Complete', 400, 160, 100, 'Direct service', 'job-100');
      insert into metrics.metrics_employee_timesheets (
        timesheet_id, employee_id, reference_type, reference_id, work_date,
        total_hours, source_hash
      ) values
        ('one', 1, 'job', 100, '2026-06-15', 2, 'timesheet-one'),
        ('two', 2, 'job', 100, '2026-06-15', 6, 'timesheet-two'),
        ('three', 3, 'activity', 9, '2026-06-20', 3, 'timesheet-three');
    `);
    const query = pgliteQuery(db);

    // Owner rule (2026-07-16): the view is the person dimension — every mapped
    // employee appears, and position never filters it. is_field_technician here
    // only means "not archived"; it does not decide roster membership.
    const rosterView = await db.query<{ simpro_employee_id: string; is_field_technician: boolean }>(
      "select simpro_employee_id::text, is_field_technician from metrics.effective_technician_roster order by simpro_employee_id",
    );
    assert.deepEqual(rosterView.rows, [
      { simpro_employee_id: "1", is_field_technician: true },
      { simpro_employee_id: "2", is_field_technician: true },
      { simpro_employee_id: "3", is_field_technician: false },
      { simpro_employee_id: "4", is_field_technician: true },
    ]);

    const source = await getTechnicianReconciliationSourceInputs("2026-06-01", "2026-06-30", query);
    assert.deepEqual(source.map(({ employeeId, sourceCount, sourceValue, sourceHours, sourceGrossProfit, sourceNetProfit, sourceRosterMember }) => ({
      employeeId, sourceCount, sourceValue, sourceHours, sourceGrossProfit, sourceNetProfit, sourceRosterMember,
    })), [
      // Employee 2 is a Dispatcher by position but recorded 6 job hours in
      // June, so under the owner's rule they are on the month's roster.
      // Employee 4 is an Apprentice with no June work, so they are not.
      { employeeId: "1", sourceCount: 0.25, sourceValue: 100, sourceHours: 2, sourceGrossProfit: 40, sourceNetProfit: 25, sourceRosterMember: true },
      { employeeId: "2", sourceCount: 0.75, sourceValue: 300, sourceHours: 6, sourceGrossProfit: 120, sourceNetProfit: 75, sourceRosterMember: true },
      { employeeId: "3", sourceCount: 0, sourceValue: 0, sourceHours: 0, sourceGrossProfit: null, sourceNetProfit: null, sourceRosterMember: true },
    ]);
    assert.deepEqual(source[0].sourceTimesheets, [{ timesheetId: "one", workDate: "2026-06-15" }]);
    assert.deepEqual(source[2].sourceTimesheets, []);

    // A corrected read model reconciles: everyone who recorded work in the
    // month is on the scorecard with preserved work-date evidence. Under the
    // owner's rule nobody who worked is disclosed "outside the roster".
    const correctedPayload = {
      technicians: [
        { employeeId: "1", completedJobCredit: 0.25, allocatedSellValue: 100, actualJobHours: 2, allocatedGrossProfit: 40, allocatedNetProfit: 25 },
        { employeeId: "2", completedJobCredit: 0.75, allocatedSellValue: 300, actualJobHours: 6, allocatedGrossProfit: 120, allocatedNetProfit: 75 },
        { employeeId: "3", completedJobCredit: 0, allocatedSellValue: 0, actualJobHours: 0, allocatedGrossProfit: 0, allocatedNetProfit: null },
      ],
      outsideRoster: [],
      allocations: [
        { employeeId: "1", workDates: [{ timesheetId: "one", workDate: "2026-06-15", hours: 2 }] },
        { employeeId: "2", workDates: [{ timesheetId: "two", workDate: "2026-06-15", hours: 6 }] },
      ],
    };
    const corrected = compareTechnicianReconciliationInputs(source, correctedPayload, "read-model-hash");
    assert.deepEqual(corrected.map((row) => [row.employeeId, row.status, row.rosterStatus, row.profitStatus, row.timesheetStatus]), [
      ["1", "matched", "matched", "matched", "matched"],
      ["2", "matched", "matched", "matched", "matched"],
      ["3", "matched", "matched", "matched", "matched"],
    ]);

    // A wrong-valued, incomplete payload still fails independently on every
    // assertion: corrupted values, a missing roster member (3), and absent
    // work-date evidence.
    const promoted = compareTechnicianReconciliationInputs(source, {
      technicians: [
        { employeeId: "1", completedJobCredit: 0.25, allocatedSellValue: 100, actualJobHours: 2, allocatedGrossProfit: 40, allocatedNetProfit: 25 },
        { employeeId: "2", completedJobCredit: 0.5, allocatedSellValue: 250, actualJobHours: 5, allocatedGrossProfit: 100, allocatedNetProfit: 60 },
      ],
    }, "read-model-hash");
    assert.deepEqual(promoted.map((row) => [row.employeeId, row.status, row.rosterStatus, row.timesheetStatus]), [
      ["1", "mismatch", "matched", "mismatch"],
      ["2", "mismatch", "matched", "mismatch"],
      ["3", "mismatch", "mismatch", "matched"],
    ]);

    // Profit sums are asserted independently of count/value/hours.
    const profitCorrupted = compareTechnicianReconciliationInputs(source, {
      ...correctedPayload,
      technicians: [
        { ...correctedPayload.technicians[0], allocatedGrossProfit: 90 },
        correctedPayload.technicians[1],
      ],
    }, "read-model-hash");
    assert.equal(profitCorrupted[0].status, "mismatch");
    assert.equal(profitCorrupted[0].profitStatus, "mismatch");

    // Timesheet identity and work dates are asserted against the source rows.
    const identityCorrupted = compareTechnicianReconciliationInputs(source, {
      ...correctedPayload,
      allocations: [
        { employeeId: "1", workDates: [{ timesheetId: "one", workDate: "2026-06-14", hours: 2 }] },
      ],
    }, "read-model-hash");
    assert.equal(identityCorrupted[0].status, "mismatch");
    assert.equal(identityCorrupted[0].timesheetStatus, "mismatch");

    const check = await db.query<{ id: string; checked_at: string }>(`
      insert into metrics.reconciliation_checks (
        scope, period_start, period_end, status, generation, complete_traversal,
        source_manifest_generations
      ) values (
        'technicians', '2026-06-01', '2026-06-30', 'mismatch', 1, true,
        '{"jobs":1,"job_nested":1,"employees":1,"timesheets":1,"jobs_from_timesheets":1,"schedules":1,"mobile_status":1}'::jsonb
      ) returning id::text, checked_at::text
    `);
    await persistTechnicianReconciliationResults({
      reconciliationCheckId: Number(check.rows[0]?.id),
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
      checkedAt: check.rows[0]!.checked_at,
      comparisons: promoted,
      query,
    });
    const persisted = await db.query<{
      employee_id: string;
      status: string;
      source_value: string;
      served_value: string;
      detail: Record<string, unknown>;
    }>(`
      select employee_id, status, source_value::text, served_value::text, detail
        from metrics.technician_reconciliation_results
       order by employee_id
    `);
    assert.deepEqual(persisted.rows.map(({ employee_id, status, source_value, served_value }) => ({
      employee_id, status, source_value, served_value,
    })), [
      { employee_id: "1", status: "mismatch", source_value: "100.000000", served_value: "100.000000" },
      { employee_id: "2", status: "mismatch", source_value: "300.000000", served_value: "250.000000" },
      { employee_id: "3", status: "mismatch", source_value: "0.000000", served_value: "0.000000" },
    ]);
    // Employee 2 recorded June work, so they belong on the scorecard: roster
    // membership itself matches, and only their corrupted values mismatch.
    assert.equal(persisted.rows[1].detail.rosterStatus, "matched");
    assert.equal(persisted.rows[1].detail.servedInScorecard, true);
    assert.equal(persisted.rows[1].detail.sourceRosterMember, true);
    // Employee 3 recorded work but is missing from the served payload entirely.
    assert.equal(persisted.rows[2].detail.rosterStatus, "mismatch");
    assert.equal(persisted.rows[2].detail.sourceRosterMember, true);
    assert.equal(persisted.rows[0].detail.timesheetStatus, "mismatch");
    await assert.rejects(
      db.exec("update metrics.technician_reconciliation_results set served_value = source_value"),
      /immutable/,
    );
  } finally {
    await db.close();
  }
});

async function loadMigrations() {
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  return Promise.all(files.map(async (name) => ({ name, sql: await readFile(new URL(name, migrationDirectory), "utf8") })));
}

function pgliteQuery(db: PGlite): PostgresQuery {
  return async <T = Record<string, unknown>>(text: string, values?: unknown[]) => {
    const result = await db.query<T>(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
}

function manifestAuthorityQuery(
  expectedPageCount: number | null,
  completedPageCount: number | null,
  statuses: { coverageStatus: string | null; reconciliationStatus: string | null } = {
    coverageStatus: "complete",
    reconciliationStatus: "matched",
  },
): PostgresQuery {
  const rows = TECHNICIAN_RECONCILIATION_SOURCE_FAMILIES.map((sourceFamily) => ({
    source_family: sourceFamily,
    coverage_status: statuses.coverageStatus,
    reconciliation_status: statuses.reconciliationStatus,
    manifest_generation: "11",
    reconciliation_generation: "11",
    expected_page_count: expectedPageCount,
    completed_page_count: completedPageCount,
  }));
  return async <T = Record<string, unknown>>() => ({
    rows: rows as unknown as T[],
    rowCount: rows.length,
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { buildCommissionReadModel } from "../../src/lib/metrics/commissions";
import {
  buildCalculationDetailCsv,
  buildCommissionWorksheetPdf,
  buildPayrollCsv,
  createOrGetCommissionExport,
  getCurrentCommissionRunForExport,
  validateCommissionWorksheetPdf,
  type CommissionRunForExport,
} from "../../src/lib/store/commission-exports";
import type { CommissionQuery } from "../../src/lib/store/commission-lifecycle";
import { completeCommissionSourceEvidence } from "./commission-evidence-fixture";
import {
  commissionPayoutServingRow,
  commissionZeroUnknownPayoutOverrideRow,
  rehashCommissionServingRow,
} from "../helpers/commission-serving";

const readModel = buildCommissionReadModel({
  periodStart: "2026-06-01",
  periodEnd: "2026-06-30",
  config: { poolPercent: 0.5, minBonusPercent: 100, efficiencyEnabled: true, maxEfficiencyAdjustmentPercent: 20 },
  roster: [
    { employeeId: "10", displayName: "Alex Rivera", included: true, notes: "Reviewed, field lead" },
    { employeeId: "20", displayName: "Jordan Lee", included: true },
    { employeeId: "30", displayName: "Taylor Morgan", included: false },
  ],
  jobs: [
    { jobId: "100", completedDate: "2026-06-10", stageName: "Complete", sellValue: 100_000, quotedHours: 100, timesheets: [
      { employeeId: "10", hours: 60 }, { employeeId: "20", hours: 30 }, { employeeId: "30", hours: 10 },
    ] },
    { jobId: "101", completedDate: "2026-06-11", stageName: "Archived", sellValue: 25_000, quotedHours: 20, timesheets: [
      { employeeId: "20", hours: 20 },
    ] },
  ],
  overrides: [{ employeeId: "20", field: "outside_pool_adjustment", value: 25, reason: "Approved payroll correction.", poolTreatment: "outside_pool" }],
});

const run: CommissionRunForExport = {
  periodId: 4, periodStart: "2026-06-01", periodEnd: "2026-06-30",
  periodRevision: 2, editRevision: 7, periodStatus: "reviewed", calculationStale: false,
  runId: 91, runRevision: 3, runStatus: "succeeded", sourceComplete: true,
  sourceEvidence: completeCommissionSourceEvidence(),
  inputManifestHash: "a".repeat(64), sourceHash: "b".repeat(64), configHash: "c".repeat(64),
  overrideHash: "d".repeat(64), calculationHash: "e".repeat(64),
  createdAt: "2026-07-09T12:00:00Z", createdBy: "worker@example.test",
  readModel,
  manifest: [{ inputType: "job", sourceIdentity: "100", sourceVersion: "v1", sourceHash: "f".repeat(64), input: { jobId: "100" } }],
};

type CsvRecord = Record<string, string>;

function parseCsv(csv: string): CsvRecord[] {
  const parsedRows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      parsedRows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field || row.length) {
    row.push(field);
    parsedRows.push(row);
  }
  const [header = [], ...records] = parsedRows;
  return records.filter((record) => record.some(Boolean)).map((record) => Object.fromEntries(header.map((column, index) => [column, record[index] ?? ""])));
}

function cents(value: string | number) {
  return Math.round(Number(value) * 100);
}

test("payroll CSV includes current immutable run, outside adjustment, and reconciling team row", () => {
  const csv = buildPayrollCsv(run);
  assert.match(csv, /period_revision,run_id,run_revision/);
  assert.match(csv, /TEAM_TOTAL,Team Total/);
  assert.match(csv, /91,3/);
  assert.match(csv, new RegExp(readModel.payrollTotal.toFixed(2)));
  assert.match(csv, /25\.00/);
  assert.equal(csv.split("\r\n").filter(Boolean).length, readModel.technicians.length + 2);
});

test("detail CSV parses and reconciles technician, job, efficiency, and team rows", () => {
  const detailRun: CommissionRunForExport = {
    ...run,
    readModel: {
      ...run.readModel,
      technicians: run.readModel.technicians.map((technician, index) => index === 0
        ? { ...technician, finalBonusLocked: true }
        : technician),
    },
  };
  const records = parseCsv(buildCalculationDetailCsv(detailRun));
  const recordTypes = new Set(records.map((record) => record.record_type));
  for (const recordType of ["run", "config", "technician", "job_allocation", "coverage", "efficiency_coverage", "manifest", "team_total"]) {
    assert.equal(recordTypes.has(recordType), true, `${recordType} rows are missing`);
  }

  const technicianRows = records.filter((record) => record.record_type === "technician");
  const expectedFields = [
    "notes", "belowMinimum", "postForfeitureBonus", "finalBonusLocked",
    "efficiencyEnabled", "efficiencyMaxAdjustmentPercent", "efficiencyQuoteJobs",
    "efficiencyQuotedHours", "efficiencyActualHours", "efficiencyRatio",
    "efficiencyPotentialMultiplier", "efficiencyMultiplier", "efficiencyEffect",
    "efficiencyNeutralReason",
  ];
  for (const technician of detailRun.readModel.technicians) {
    const fields = new Map(technicianRows.filter((record) => record.employee_id === technician.employeeId).map((record) => [record.field, record.value]));
    for (const fieldName of expectedFields) assert.equal(fields.has(fieldName), true, `${fieldName} is missing for ${technician.employeeId}`);
    assert.equal(cents(fields.get("postForfeitureBonus") ?? 0), cents((fields.get("rawBonus") ? Number(fields.get("rawBonus")) : 0) - (fields.get("forfeitedBonus") ? Number(fields.get("forfeitedBonus")) : 0) + (fields.get("reallocationReceived") ? Number(fields.get("reallocationReceived")) : 0)));
    assert.equal(cents(fields.get("payrollBonus") ?? 0), cents(Number(fields.get("finalBonus") ?? 0) + Number(fields.get("outsidePoolAdjustment") ?? 0)));
  }
  assert.equal(technicianRows.some((record) => record.field === "belowMinimum" && record.value === "true"), true);
  assert.equal(technicianRows.some((record) => record.field === "finalBonusLocked" && record.value === "true"), true);
  const notes = technicianRows.find((record) => record.employee_id === "10" && record.field === "notes");
  assert.deepEqual(JSON.parse(notes?.value ?? "[]"), ["Reviewed, field lead"]);

  const teamFields = new Map(records.filter((record) => record.record_type === "team_total").map((record) => [record.field, record.value]));
  const sumField = (fieldName: string) => technicianRows
    .filter((record) => record.field === fieldName)
    .reduce((total, record) => total + cents(record.value || 0), 0);
  assert.equal(sumField("finalBonus"), cents(teamFields.get("inside_pool") ?? 0));
  assert.equal(sumField("outsidePoolAdjustment"), cents(teamFields.get("outside_pool") ?? 0));
  assert.equal(sumField("payrollBonus"), cents(teamFields.get("payroll") ?? 0));
  assert.equal(sumField("efficiencyEffect"), 0);

  const allocationRows = records.filter((record) => record.record_type === "job_allocation");
  for (const jobId of new Set(allocationRows.map((record) => record.job_id))) {
    const jobRows = allocationRows.filter((record) => record.job_id === jobId);
    const disclosedJobTotal = /jobTotal=([0-9.-]+)/.exec(jobRows[0]?.detail ?? "")?.[1] ?? "0";
    assert.equal(jobRows.reduce((total, record) => total + cents(record.value), 0), cents(disclosedJobTotal));
  }

  const efficiencyCoverageFields = new Set(records.filter((record) => record.record_type === "efficiency_coverage").map((record) => record.field));
  assert.deepEqual(efficiencyCoverageFields, new Set([
    "status", "required", "quoteSourcedJobs", "jobsWithLaborRows", "qualifyingJobs",
    "jobsWithNoQualifyingWork", "laborRows", "incompleteJobIds",
  ]));
  assert.equal(records.every((record) => Object.hasOwn(record, "source_hash")), true);
});

test("worksheet PDF is branded US Letter, paginated, and tied to immutable totals", async () => {
  const bytes = await buildCommissionWorksheetPdf(run);
  const validation = await validateCommissionWorksheetPdf(bytes, {
    runId: run.runId,
    periodRevision: run.periodRevision,
    payrollTotal: run.readModel.payrollTotal,
  });
  assert.equal(validation.valid, true, validation.errors.join("; "));
  assert.ok(validation.pageCount >= 1);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 8)), "%PDF-1.7");
});

test("efficiency-enabled incomplete quote evidence blocks export before file generation", async () => {
  const sourceEvidence = completeCommissionSourceEvidence({ efficiencyEnabled: true });
  sourceEvidence.complete = false;
  sourceEvidence.status = "loading";
  sourceEvidence.units.quoteLabor.status = "loading";
  const incompleteRun: CommissionRunForExport = { ...run, sourceEvidence };
  await assert.rejects(
    createOrGetCommissionExport({
      run: incompleteRun,
      expectedRevision: 7,
      exportType: "payroll_csv",
      actorEmail: "finance@example.test",
    }, async () => {
      throw new Error("query should not run");
    }),
    /canonically verified immutable run/,
  );
});

test("export loading rejects a nonimmutable canonical run", async () => {
  const row = commissionPayoutServingRow({ immutable: false });
  const query: CommissionQuery = async <T>() => ({ rows: [row as T], rowCount: 1 });
  await assert.rejects(
    getCurrentCommissionRunForExport("2026-06-01", query),
    /not immutable/,
  );
});

test("export loading rejects a hash-consistent zero run with an unknown employee payout override", async () => {
  const row = commissionZeroUnknownPayoutOverrideRow();
  const query: CommissionQuery = async <T>() => ({ rows: [row as T], rowCount: 1 });
  await assert.rejects(
    getCurrentCommissionRunForExport("2026-06-01", query),
    /unknown employee 404/,
  );
});

test("export lock re-verification rejects hash-consistent payout corruption before insert", async () => {
  const valid = commissionPayoutServingRow();
  const loadQuery: CommissionQuery = async <T>() => ({ rows: [valid as T], rowCount: 1 });
  const verifiedRun = await getCurrentCommissionRunForExport("2026-06-01", loadQuery);
  assert.ok(verifiedRun);

  const corrupt = structuredClone(valid);
  const employees = corrupt.employee_results as Array<Record<string, unknown>>;
  const technicians = (corrupt.read_model as typeof readModel).technicians;
  for (const [index, finalBonus] of [[0, 40], [1, 10]] as const) {
    employees[index].finalBonus = finalBonus;
    employees[index].payrollBonus = finalBonus;
    technicians[index].finalBonus = finalBonus;
    technicians[index].payrollBonus = finalBonus;
  }
  const rehashed = rehashCommissionServingRow(corrupt);
  let insertAttempted = false;
  const lockedQuery: CommissionQuery = async <T>(sql: string) => {
    if (sql.startsWith("select pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (sql.includes("period_config_source")) return { rows: [rehashed as T], rowCount: 1 };
    insertAttempted = true;
    return { rows: [], rowCount: 0 };
  };
  await assert.rejects(
    createOrGetCommissionExport({
      run: verifiedRun, expectedRevision: valid.edit_revision,
      exportType: "payroll_csv", actorEmail: "finance@example.test",
    }, lockedQuery),
    /cannot be exported/,
  );
  assert.equal(insertAttempted, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildCommissionReadModel, type CommissionReadModel } from "../../src/lib/metrics/commissions";
import {
  buildCommissionSummary,
  evaluateCommissionRunForServing,
  getCommissionDashboardReadModel,
} from "../../src/lib/store/commissions-read-model";
import {
  commissionFreshness,
  buildCommissionServingRow,
  commissionPayoutServingRow,
  commissionQuery,
  commissionServingRow,
  commissionZeroUnknownPayoutOverrideRow,
  rehashCommissionServingRow,
} from "../helpers/commission-serving";
import { commissionHashJson } from "../../src/lib/store/commission-integrity";
import { commissionCanonicalRunSelect } from "../../src/lib/store/commission-integrity";

const getFreshness = async () => commissionFreshness;

test("a commission store read failure returns unavailable null facts and preserves diagnostics", async () => {
  const model = await getCommissionDashboardReadModel(
    { year: 2026, month: 6, summaryYear: 2026 },
    { query: commissionQuery({ error: new Error("database offline") }), getFreshness },
  );

  assert.equal(model.worksheet.servingStatus, "unavailable");
  assert.equal(model.worksheet.servingCode, "READ_MODEL_UNAVAILABLE");
  assert.equal(model.worksheet.completedJobs, null);
  assert.equal(model.worksheet.totalWorkValue, null);
  assert.equal(model.worksheet.commissionPool, null);
  assert.equal(model.worksheet.payrollTotal, null);
  assert.equal(model.worksheet.coverage, null);
  assert.match(model.worksheet.servingMessage ?? "", /database offline/);
  assert.equal(model.freshness, commissionFreshness);
  assert.equal(model.summary.totalAnnualPool, null);
  assert.match(model.summary.diagnostics.join(" "), /database offline/);
});

test("a period without a current calculation run remains building without zero facts", async () => {
  const row = commissionServingRow({
    current_run_id: null,
    run_id: null,
    run_revision: null,
    run_status: null,
    read_model: null,
  });
  const model = await getCommissionDashboardReadModel(
    { year: 2026, month: 6, summaryYear: 2026 },
    { query: commissionQuery({ selectedRows: [row] }), getFreshness },
  );

  assert.equal(model.worksheet.servingStatus, "building");
  assert.equal(model.worksheet.servingCode, "RUN_BUILDING");
  assert.equal(model.worksheet.completedJobs, null);
  assert.equal(model.worksheet.payrollTotal, null);
  assert.equal(model.worksheet.exportGate.allowed, false);
});

test("stale and source-incomplete runs fail closed", () => {
  const stale = evaluateCommissionRunForServing(commissionServingRow({ calculation_stale: true }));
  assert.deepEqual(stale, {
    ready: false,
    servingStatus: "building",
    code: "RUN_STALE",
    message: "The current commission calculation is stale and must be rebuilt.",
  });

  const incomplete = evaluateCommissionRunForServing(commissionServingRow({ source_complete: false }));
  assert.equal(incomplete.ready, false);
  if (!incomplete.ready) {
    assert.equal(incomplete.servingStatus, "building");
    assert.equal(incomplete.code, "SOURCE_INCOMPLETE");
  }

  const malformedEvidence = evaluateCommissionRunForServing(commissionServingRow({
    source_complete: true,
    source_evidence: { schemaVersion: 2, complete: true, status: "complete", units: {} },
  }));
  assert.equal(malformedEvidence.ready, false);
  if (!malformedEvidence.ready) {
    assert.equal(malformedEvidence.servingStatus, "unavailable");
    assert.equal(malformedEvidence.code, "READ_MODEL_INVALID");
  }
});

test("failed and non-current runs fail closed", () => {
  const failed = evaluateCommissionRunForServing(commissionServingRow({ run_status: "failed" }));
  assert.equal(failed.ready, false);
  if (!failed.ready) assert.equal(failed.code, "RUN_FAILED");

  const nonCurrent = evaluateCommissionRunForServing(commissionServingRow({ current_run_id: "802" }));
  assert.equal(nonCurrent.ready, false);
  if (!nonCurrent.ready) assert.equal(nonCurrent.code, "RUN_NOT_CURRENT");
});

test("malformed legacy fragments are not reconstructed into a worksheet", async () => {
  const row = {
    ...commissionServingRow({ read_model: { technicians: [], coverage: {}, invariants: {} } }),
    employee_results: [{ employeeId: "1", allocatedWorkValue: 0, finalBonus: 0 }],
    job_allocations: [{ employeeId: "1", jobId: "10", allocatedValue: 0 }],
  };
  const model = await getCommissionDashboardReadModel(
    { year: 2026, month: 6, summaryYear: 2026 },
    { query: commissionQuery({ selectedRows: [row], summaryRows: [row] }), getFreshness },
  );

  assert.equal(model.worksheet.servingStatus, "unavailable");
  assert.equal(model.worksheet.servingCode, "READ_MODEL_INVALID");
  assert.equal(model.worksheet.totalWorkValue, null);
  assert.equal(model.worksheet.commissionPool, null);
  assert.equal(model.summary.months[5].commissionPool, null);
  assert.equal(model.summary.loadedFinalizedMonths, 0);
});

test("a complete detailed run with legitimate numeric zeros remains ready", async () => {
  const row = commissionServingRow();
  const model = await getCommissionDashboardReadModel(
    { year: 2026, month: 6, summaryYear: 2026 },
    { query: commissionQuery({ selectedRows: [row], summaryRows: [row] }), getFreshness },
  );

  assert.equal(model.worksheet.servingStatus, "ready");
  assert.equal(model.worksheet.completedJobs, 0);
  assert.equal(model.worksheet.totalWorkValue, 0);
  assert.equal(model.worksheet.commissionPool, 0);
  assert.equal(model.worksheet.payrollTotal, 0);
  assert.equal(model.summary.months[5].commissionPool, 0);
  assert.equal(model.summary.loadedFinalizedMonths, 1);
  assert.equal(model.summary.totalAnnualPool, 0);
  assert.equal(model.summary.averageMonthlyPool, 0);
});

test("annual summary reads the compact run read model without manifest child-table aggregation", async () => {
  const row = commissionServingRow();
  let summarySql = "";
  const query = async <T>(sql: string): Promise<{ rows: T[]; rowCount: number }> => {
    if (sql.includes("p.period_start >= $1::date")) {
      summarySql = sql;
      return { rows: [row] as T[], rowCount: 1 };
    }
    if (sql.includes("limit 1")) return { rows: [row] as T[], rowCount: 1 };
    if (sql.includes("from metrics.commission_periods p") && sql.includes("order by p.revision desc")) {
      return { rows: [row] as T[], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  const model = await getCommissionDashboardReadModel(
    { year: 2026, month: 6, summaryYear: 2026 },
    { query, getFreshness },
  );

  assert.equal(model.summary.months[5].commissionPool, 0);
  assert.equal(model.summary.loadedFinalizedMonths, 1);
  assert.match(summarySql, /r\.read_model/);
  assert.doesNotMatch(summarySql, /commission_run_inputs/);
  assert.doesNotMatch(summarySql, /commission_employee_results/);
  assert.doesNotMatch(summarySql, /commission_job_allocations/);
});

test("selected commission worksheet serves the compact persisted read model without audit side reads", async () => {
  const row = commissionServingRow();
  const compactRow = { ...row };
  delete (compactRow as Partial<typeof row>).employee_results;
  delete (compactRow as Partial<typeof row>).job_allocations;
  delete (compactRow as Partial<typeof row>).input_manifest;
  let selectedSql = "";
  const sideReadSql: string[] = [];
  const query = async <T>(sql: string): Promise<{ rows: T[]; rowCount: number }> => {
    if (sql.includes("p.period_start >= $1::date")) return { rows: [] as T[], rowCount: 0 };
    if (sql.includes("limit 1")) {
      selectedSql = sql;
      return { rows: [compactRow] as T[], rowCount: 1 };
    }
    if (
      sql.includes("from metrics.audit_events")
      || sql.includes("from metrics.commission_overrides")
      || sql.includes("from metrics.commission_run_inputs")
      || sql.includes("from metrics.commission_employee_results")
      || sql.includes("from metrics.commission_job_allocations")
    ) {
      sideReadSql.push(sql);
    }
    return { rows: [] as T[], rowCount: 0 };
  };

  const model = await getCommissionDashboardReadModel(
    { year: 2026, month: 6, summaryYear: 2026 },
    { query, getFreshness },
  );

  assert.equal(model.worksheet.servingStatus, "ready");
  assert.match(selectedSql, /r\.read_model/);
  assert.doesNotMatch(selectedSql, /commission_run_inputs/);
  assert.doesNotMatch(selectedSql, /commission_employee_results/);
  assert.doesNotMatch(selectedSql, /commission_job_allocations/);
  assert.equal(model.worksheet.revisionHistory.length, 1);
  assert.equal(model.worksheet.auditHistory.length, 0);
  assert.equal(model.worksheet.overrides.length, 0);
  assert.equal(model.worksheet.exports.length, 0);
  assert.equal(sideReadSql.length, 0);
});

test("canonical commission allocation rows carry normalized job/customer labels", () => {
  const sql = commissionCanonicalRunSelect();

  assert.match(sql, /left join metrics\.metrics_jobs j on j\.job_id = a\.job_id/);
  assert.match(sql, /'jobName', nullif\(btrim\(j\.name\), ''\)/);
  assert.match(sql, /'customer', nullif\(btrim\(to_jsonb\(j\)->>'customer_name'\), ''\)/);
});

test("canonical allocation rows honor their declared database precision", async () => {
  const row = commissionPayoutServingRow({}, { first: 1, second: 2 });
  row.job_allocations = childAllocations(row).map((allocation) => ({
    ...allocation,
    jobTotal: Number(Number(allocation.jobTotal).toFixed(2)),
    employeeHours: Number(Number(allocation.employeeHours).toFixed(2)),
    jobTotalHours: Number(Number(allocation.jobTotalHours).toFixed(2)),
    share: Number(Number(allocation.share).toFixed(8)),
    allocatedValue: Number(Number(allocation.allocatedValue).toFixed(2)),
  }));

  const model = await getCommissionDashboardReadModel(
    { year: 2026, month: 6, summaryYear: 2026 },
    { query: commissionQuery({ selectedRows: [row] }), getFreshness },
  );

  assert.equal(model.worksheet.servingStatus, "ready");
});

test("canonical allocation rows still reject a material stored-share mismatch", async () => {
  const row = commissionPayoutServingRow({}, { first: 1, second: 2 });
  row.job_allocations = childAllocations(row).map((allocation, index) => ({
    ...allocation,
    share: Number(Number(allocation.share).toFixed(8)) + (index === 0 ? 0.00000001 : 0),
  }));

  await assertIntegrityUnavailable(row);
});

test("serving rejects a hash-consistent zero run with an unknown employee payout override", async () => {
  await assertIntegrityUnavailable(commissionZeroUnknownPayoutOverrideRow());
});

test("annual summary excludes malformed months instead of counting them as zero", () => {
  const malformed = commissionServingRow({ read_model: null });
  const summary = buildCommissionSummary(2026, [malformed]);

  assert.equal(summary.months[5].commissionPool, null);
  assert.equal(summary.totalAnnualPool, null);
  assert.equal(summary.averageMonthlyPool, null);
  assert.equal(summary.loadedFinalizedMonths, 0);
});

test("annual summary does not substitute an older run when the latest revision is stale", () => {
  const latest = commissionServingRow({ period_id: "62", revision: 2, calculation_stale: true });
  const older = commissionServingRow({ period_id: "61", revision: 1 });
  const summary = buildCommissionSummary(2026, [latest, older]);

  assert.equal(summary.months[5].commissionPool, null);
  assert.equal(summary.loadedFinalizedMonths, 0);
  assert.match(summary.months[5].diagnostics.join(" "), /RUN_STALE/);
});

const invariantMutations: Array<[string, (row: ReturnType<typeof commissionPayoutServingRow>) => void]> = [
  ["insidePoolReconciles", (row) => setEmployeeValue(row, 0, "finalBonus", 29)],
  ["outsidePoolReconciles", (row) => setEmployeeValue(row, 0, "payrollBonus", 29)],
  ["jobAllocationsReconcile", (row) => setAllocationValue(row, 0, "allocatedValue", 5999)],
  ["unsupportedJobsUnallocated", (row) => {
    const allocation = { jobId: "200", employeeId: "1", jobTotal: 0, employeeHours: 1, jobTotalHours: 1, share: 1, allocatedValue: 0, included: true };
    childAllocations(row).push(allocation);
    readModel(row).jobAllocations.push(allocation);
  }],
  ["forfeitureReconciles", (row) => setEmployeeValue(row, 0, "forfeitedBonus", 1)],
  ["efficiencyReconciles", (row) => {
    childEmployees(row)[0].efficiency = { ...(childEmployees(row)[0].efficiency as object), effect: 1 };
    readModel(row).technicians[0].efficiency = { ...readModel(row).technicians[0].efficiency!, effect: 1 };
  }],
  ["nonnegativePayroll", (row) => setEmployeeValue(row, 0, "payrollBonus", -1)],
];

for (const [invariant, mutate] of invariantMutations) {
  test(`serving independently rejects a failed ${invariant} invariant`, async () => {
    const row = structuredClone(commissionPayoutServingRow());
    mutate(row);
    await assertIntegrityUnavailable(rehashCommissionServingRow(row));
  });
}

test("serving rejects a negative payout even when persisted flags remain true", async () => {
  const row = structuredClone(commissionPayoutServingRow());
  setEmployeeValue(row, 0, "finalBonus", -1);
  await assertIntegrityUnavailable(rehashCommissionServingRow(row));
});

test("serving rejects an orphan allocation", async () => {
  const row = structuredClone(commissionPayoutServingRow());
  const allocation = { jobId: "999", employeeId: "999", jobTotal: 1, employeeHours: 1, jobTotalHours: 1, share: 1, allocatedValue: 1, included: true };
  childAllocations(row).push(allocation);
  readModel(row).jobAllocations.push(allocation);
  await assertIntegrityUnavailable(rehashCommissionServingRow(row));
});

test("serving rejects negative persisted coverage", async () => {
  const row = structuredClone(commissionPayoutServingRow());
  readModel(row).coverage.mappedHours = -1;
  row.run_coverage = readModel(row).coverage;
  await assertIntegrityUnavailable(rehashCommissionServingRow(row));
});

test("serving reuses config range validation and rejects poolPercent 99", async () => {
  const row = commissionPayoutServingRow({ run_config: { ...commissionPayoutServingRow().run_config as object, poolPercent: 99 } });
  await assertIntegrityUnavailable(row);
});

test("serving rejects run config that mismatches immutable source config", async () => {
  const row = commissionPayoutServingRow({ run_config: { ...commissionPayoutServingRow().run_config as object, poolPercent: 0.55 } });
  await assertIntegrityUnavailable(row);
});

test("serving rejects a nonimmutable run", async () => {
  await assertIntegrityUnavailable(commissionPayoutServingRow({ immutable: false }));
});

test("serving rejects malformed SHA-256 provenance", async () => {
  await assertIntegrityUnavailable(commissionPayoutServingRow({ input_manifest_hash: "not-a-sha256" }));
});

test("serving rejects a valid-looking recomputed hash mismatch", async () => {
  await assertIntegrityUnavailable(commissionPayoutServingRow({ calculation_hash: "f".repeat(64) }));
});

test("mandatory evidence cannot bypass completion with required=false", async () => {
  const row = structuredClone(commissionPayoutServingRow());
  const evidence = row.source_evidence as { units: Record<string, { required: boolean }> };
  evidence.units.timesheets.required = false;
  const manifest = row.input_manifest as Array<{ inputType: string; sourceHash: string; input: unknown }>;
  const evidenceEntry = manifest.find((entry) => entry.inputType === "evidence_summary")!;
  evidenceEntry.input = evidence;
  evidenceEntry.sourceHash = commissionHashJson(evidence);
  await assertIntegrityUnavailable(rehashCommissionServingRow(row));
});

test("serving rejects persisted child rows that mismatch read_model", async () => {
  const row = structuredClone(commissionPayoutServingRow());
  childEmployees(row)[0].finalBonus = 29;
  await assertIntegrityUnavailable(row);
});

test("serving rejects a balanced payout redistribution with fully recomputed hashes", async () => {
  const row = structuredClone(commissionPayoutServingRow());
  setEmployeeValue(row, 0, "finalBonus", 40);
  setEmployeeValue(row, 0, "payrollBonus", 40);
  setEmployeeValue(row, 1, "finalBonus", 10);
  setEmployeeValue(row, 1, "payrollBonus", 10);
  await assertIntegrityUnavailable(rehashCommissionServingRow(row));
});

for (const [label, mutate] of [
  ["scope", (reconciliation: Record<string, unknown>) => { reconciliation.scope = "payroll"; }],
  ["status", (reconciliation: Record<string, unknown>) => { reconciliation.status = "mismatch"; }],
  ["period", (reconciliation: Record<string, unknown>) => { reconciliation.period_start = "2026-05-01"; }],
] as const) {
  test(`serving rejects a hash-consistent reconciliation ${label} mismatch`, async () => {
    const row = structuredClone(commissionPayoutServingRow());
    const manifest = row.input_manifest as Array<{ inputType: string; sourceHash: string; input: unknown }>;
    const reconciliationEntry = manifest.find((entry) => entry.inputType === "reconciliation")!;
    const reconciliation = reconciliationEntry.input as Record<string, unknown>;
    mutate(reconciliation);
    reconciliationEntry.sourceHash = commissionHashJson(reconciliation);
    const evidence = row.source_evidence as {
      matchedReconciliations: Array<{ scope: string; id: string; hash: string }>;
    };
    const match = evidence.matchedReconciliations.find((entry) => entry.id === reconciliation.id)!;
    match.scope = String(reconciliation.scope);
    match.hash = reconciliationEntry.sourceHash;
    replaceEvidenceManifest(row);
    await assertIntegrityUnavailable(rehashCommissionServingRow(row));
  });
}

test("serving rejects efficiency-enabled source with absent quote-labor inputs", async () => {
  const row = structuredClone(efficiencyServingRow());
  const manifest = row.input_manifest as Array<{ inputType: string; sourceHash: string; input: unknown }>;
  row.input_manifest = manifest.filter((entry) => entry.inputType !== "quote_labor");
  const evidence = row.source_evidence as {
    units: Record<string, { status: string; rowCount: number; identities: string[] }>;
  };
  evidence.units.quoteLabor.status = "complete_no_qualifying_work";
  evidence.units.quoteLabor.rowCount = 0;
  evidence.units.quoteLabor.identities = [];
  replaceEvidenceManifest(row);
  await assertIntegrityUnavailable(rehashCommissionServingRow(row));
});

test("serving accepts complete_no_qualifying_work with immutable zero-hour quote labor rows", () => {
  const evaluation = evaluateCommissionRunForServing(efficiencyServingRow(0));
  assert.equal(evaluation.ready, true);
  if (evaluation.ready) {
    const quoteLabor = evaluation.readModel.coverage.quoteLabor;
    assert.ok(quoteLabor);
    assert.equal(quoteLabor.status, "complete_no_qualifying_work");
    assert.equal(quoteLabor.laborRows, 1);
    assert.equal(quoteLabor.qualifyingJobs, 0);
  }
});

test("serving rejects complete_no_qualifying_work with immutable nonzero quote labor hours", async () => {
  const row = structuredClone(efficiencyServingRow());
  const evidence = row.source_evidence as { units: { quoteLabor: { status: string } } };
  evidence.units.quoteLabor.status = "complete_no_qualifying_work";
  replaceEvidenceManifest(row);
  await assertIntegrityUnavailable(rehashCommissionServingRow(row));
});

test("serving rejects config_json that differs from its persisted scalar config", async () => {
  const row = structuredClone(commissionPayoutServingRow());
  const source = row.period_config_source as Record<string, unknown>;
  source.config_json = { ...(source.config_json as object), poolPercent: 0.55 };
  const configEntry = (row.input_manifest as Array<{ inputType: string; sourceHash: string; input: unknown }>)
    .find((entry) => entry.inputType === "config")!;
  (configEntry.input as Record<string, unknown>).sourceRow = source;
  configEntry.sourceHash = commissionHashJson(configEntry.input);
  await assertIntegrityUnavailable(rehashCommissionServingRow(row));
});

test("serving rejects structurally empty evidence labeled complete", async () => {
  const row = structuredClone(commissionPayoutServingRow());
  const evidence = row.source_evidence as {
    units: Record<string, { rowCount: number; identities: string[] }>;
  };
  for (const unit of Object.values(evidence.units)) {
    unit.rowCount = 0;
    unit.identities = [];
  }
  replaceEvidenceManifest(row);
  await assertIntegrityUnavailable(rehashCommissionServingRow(row));
});

async function assertIntegrityUnavailable(row: ReturnType<typeof commissionPayoutServingRow>) {
  const model = await getCommissionDashboardReadModel(
    { year: 2026, month: 6, summaryYear: 2026 },
    { query: commissionQuery({ selectedRows: [row], summaryRows: [row] }), getFreshness },
  );
  assert.equal(model.worksheet.servingStatus, "unavailable");
  assert.equal(model.worksheet.completedJobs, null);
  assert.equal(model.worksheet.totalWorkValue, null);
  assert.equal(model.worksheet.commissionPool, null);
  assert.equal(model.worksheet.payrollTotal, null);
  assert.equal(model.worksheet.coverage, null);
  assert.equal(model.worksheet.exportGate.allowed, false);
  assert.equal(model.summary.months[5].commissionPool, null);
  assert.equal(model.summary.loadedFinalizedMonths, 0);
}

function readModel(row: ReturnType<typeof commissionPayoutServingRow>) {
  return row.read_model as CommissionReadModel & {
    technicians: Array<Record<string, unknown> & { efficiency?: Record<string, unknown> }>;
    jobAllocations: Array<Record<string, unknown>>;
  };
}

function childEmployees(row: ReturnType<typeof commissionPayoutServingRow>) {
  return row.employee_results as Array<Record<string, unknown>>;
}

function childAllocations(row: ReturnType<typeof commissionPayoutServingRow>) {
  return row.job_allocations as Array<Record<string, unknown>>;
}

function setEmployeeValue(row: ReturnType<typeof commissionPayoutServingRow>, index: number, field: string, value: number) {
  childEmployees(row)[index][field] = value;
  readModel(row).technicians[index][field] = value;
}

function setAllocationValue(row: ReturnType<typeof commissionPayoutServingRow>, index: number, field: string, value: number) {
  childAllocations(row)[index][field] = value;
  readModel(row).jobAllocations[index][field] = value;
}

function replaceEvidenceManifest(row: ReturnType<typeof commissionPayoutServingRow>) {
  const evidenceEntry = (row.input_manifest as Array<{ inputType: string; sourceHash: string; input: unknown }>)
    .find((entry) => entry.inputType === "evidence_summary")!;
  evidenceEntry.input = row.source_evidence;
  evidenceEntry.sourceHash = commissionHashJson(evidenceEntry.input);
}

function efficiencyServingRow(quotedHours = 10) {
  const config = {
    poolPercent: 0.5, minBonusPercent: 5, efficiencyEnabled: true,
    maxEfficiencyAdjustmentPercent: 20,
    tierMultipliers: { Gold: 1.3, Silver: 1.2, Bronze: 1.1, Standard: 1 },
  };
  const readModel = buildCommissionReadModel({
    periodStart: "2026-06-01", periodEnd: "2026-06-30", config,
    roster: [{ employeeId: "1", displayName: "Alex", included: true }],
    jobs: [{
      jobId: "100", completedDate: "2026-06-10", stageName: "Complete", sellValue: 10000,
      quoteId: "500", quotedHours, quoteLaborRows: 1,
      quoteLaborCoverageStatus: quotedHours > 0 ? "complete" : "complete_no_qualifying_work",
      timesheets: [{ employeeId: "1", hours: 10, mapped: true, fieldTechnician: true }],
    }],
  });
  return buildCommissionServingRow({
    readModel,
    inputRows: [
      manifestInput("job", "100", { jobId: "100", completedDate: "2026-06-10", stageName: "Complete", sellValue: 10000, quoteId: "500", quotedHours }),
      manifestInput("timesheet", "1:ts-1", { jobId: "100", timesheetId: "ts-1", employeeId: "1", hours: 10, mapped: true, fieldTechnician: true }),
      manifestInput("quote_labor", "500:1:1:1", {
        jobId: "100", quoteId: "500", sectionId: "1", costCenterId: "1", laborId: "1",
        laborTypeId: null, laborTypeName: null, quantityHours: quotedHours, sellExTax: null, actualCost: null,
      }),
    ],
  });
}

function manifestInput(inputType: string, sourceIdentity: string, value: unknown) {
  return { inputType, sourceIdentity, sourceVersion: `v:${sourceIdentity}`, sourceHash: commissionHashJson(value), input: value };
}

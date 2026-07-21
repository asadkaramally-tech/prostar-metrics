import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  COMMISSION_INVARIANTS,
  aggregateLaborEfficiencySources,
  aggregateQuoteSources,
  classifyTechnicianLaborSource,
  expectedCapacities,
  forbiddenInvoiceArDimensionPaths,
  independentCostCenterCategory,
  laborEfficiencyServedTotals,
  recomputeCommissionInvariants,
  readQuoteSourceRows,
  validateCommissions,
  validateCostCenterCategories,
  validateInvoiceRuntime,
  validateJobs,
  validateNoInvoiceArApiDimensions,
  validatePayloadSourceHash,
  validateProductionOwnerAuthorization,
  validateQuoteConversionEvidence,
  validateQuotes,
  validateTechnicianUtilization,
  validateTechnicians,
  type AppRoleSourceRow,
  type CapacitySourceRow,
  type CostCenterCategorySourceRow,
  type CommissionEmployeeResult,
  type CommissionInputRow,
  type CommissionJobAllocation,
  type JobSourceAggregate,
  type LaborEfficiencySourceAggregate,
  type LaborEfficiencySourceRow,
  type QuoteSourceRow,
  type ReadModelRow,
  type TechnicianUtilizationSourceRow,
  type ValidationMismatch,
} from "../../scripts/validate-dashboard-read-models";
import { readModelSourceHash } from "../../src/lib/store/read-model-rebuilds";

function readModel(family: ReadModelRow["metric_family"], values: Record<string, unknown>): ReadModelRow {
  return {
    metric_family: family,
    period_start: "2026-06-01",
    dimensions_json: {},
    values_json: values,
    status: "ready",
    source_hash: readModelSourceHash(values),
    rebuilt_at: "2026-07-01T00:00:00Z",
  };
}

function quoteFixture() {
  const rows: QuoteSourceRow[] = [
    quoteRow("1", 500, { status_name: " Quote Accepted Online ", direct_linked_job_id: "91", direct_conversion_job_id: "91" }),
    quoteRow("2", 1_000, { status_name: "Quote Accepted Online" }),
    quoteRow("3", 3_000, { inverse_conversion_job_id: "93" }),
    quoteRow("4", 12_000),
    quoteRow("5", 600, { override_outcome: "excluded" }),
    quoteRow("6", 700, { date_issued: null }),
  ];
  const source = aggregateQuoteSources(rows).get("2026-06-01");
  assert.ok(source);
  const values = {
    quoteCount: source.quote_count,
    quoteValue: source.quote_value,
    acceptedCount: source.accepted_count,
    acceptedValue: source.accepted_value,
    notAcceptedCount: source.not_accepted_count,
    notAcceptedValue: source.not_accepted_value,
    acceptanceDenominatorCount: source.quote_count,
    acceptanceDenominatorValue: source.quote_value,
    excludedCount: source.excluded_count,
    acceptanceRateByCount: source.acceptance_rate_by_count,
    acceptanceRateByValue: source.acceptance_rate_by_value,
    averageAcceptedDeal: source.average_accepted_deal,
    overrideCount: source.override_count,
    excludedWithoutDateIssued: source.excluded_without_date_issued,
    tiers: structuredClone(source.tiers),
    acceptancePaths: { ...source.acceptance_paths },
    dashboard: {
      classificationRows: source.quotes.map((quote) => ({
        quoteId: Number(quote.quoteId),
        outcome: quote.outcome,
        acceptancePath: quote.path,
        tier: quote.tier,
      })),
      acceptancePaths: (["accepted_online_and_converted", "accepted_online_only", "converted_only", "not_accepted"] as const).map((path) => ({
        path,
        count: source.acceptance_paths[path],
        value: source.acceptance_path_values[path],
      })),
      pagination: { classificationTotal: source.source_records, pageSize: 50 },
    },
  };
  return { source, values };
}

function quoteRow(quoteId: string, total: number, overrides: Partial<QuoteSourceRow> = {}): QuoteSourceRow {
  return {
    quote_id: quoteId,
    date_issued: "2026-06-15",
    date_approved: "2026-06-15",
    total,
    status_name: null,
    direct_source_snapshot_id: `snapshot-${quoteId}`,
    direct_linked_job_id: null,
    direct_linked_job_id_alias: null,
    direct_linked_job_id_snake: null,
    direct_conversion_job_id: null,
    inverse_conversion_job_id: null,
    override_outcome: null,
    won_override: null,
    ...overrides,
  };
}

test("quote validation compares every outcome/path, tier partition, rate, and per-quote classification", () => {
  const { source, values } = quoteFixture();
  const matched: ValidationMismatch[] = [];
  validateQuotes(readModel("quotes", values), source, matched);
  assert.deepEqual(matched, []);

  const mutations: Array<[string, () => Record<string, unknown>]> = [
    ["acceptancePaths.converted_only", () => ({ ...values, acceptancePaths: { ...values.acceptancePaths, converted_only: 0 } })],
    ["tiers.$2K-$10K.acceptedCount", () => ({
      ...values,
      tiers: { ...values.tiers, "$2K-$10K": { ...values.tiers["$2K-$10K"], acceptedCount: 0 } },
    })],
    ["acceptanceRateByValue", () => ({ ...values, acceptanceRateByValue: 0 })],
    ["averageAcceptedDeal", () => ({ ...values, averageAcceptedDeal: 0 })],
    ["dashboard.acceptancePaths.converted_only.value", () => ({
      ...values,
      dashboard: {
        ...values.dashboard,
        acceptancePaths: values.dashboard.acceptancePaths.map((item) => item.path === "converted_only" ? { ...item, value: 0 } : item),
      },
    })],
  ];
  for (const [field, mutate] of mutations) {
    const mismatches: ValidationMismatch[] = [];
    validateQuotes(readModel("quotes", mutate()), source, mismatches);
    assert.ok(mismatches.some((item) => item.field === field), field);
  }

  const classificationMutation = structuredClone(values);
  classificationMutation.dashboard.classificationRows[2].acceptancePath = "not_accepted";
  const perQuote: ValidationMismatch[] = [];
  validateQuotes(readModel("quotes", classificationMutation), source, perQuote);
  assert.ok(perQuote.some((item) => item.type === "quote_classification" && item.quoteId === "3"));
});

test("quote source validation uses raw direct and inverse fields and never JobNo equality", () => {
  const direct = quoteRow("11", 1_000, { direct_linked_job_id: "501", direct_conversion_job_id: "501" });
  const inverse = quoteRow("12", 1_000, { inverse_conversion_job_id: "502" });
  const jobNoOnly = {
    ...quoteRow("13", 1_000),
    exact_job_no_match_id: "503",
  } as QuoteSourceRow;
  const source = aggregateQuoteSources([direct, inverse, jobNoOnly]).get("2026-06-01");
  assert.ok(source);
  assert.equal(source.accepted_count, 2);
  assert.equal(source.not_accepted_count, 1);
  assert.equal(source.quotes.find((quote) => quote.quoteId === "13")?.path, "not_accepted");

  const matched: ValidationMismatch[] = [];
  validateQuoteConversionEvidence([direct, inverse, jobNoOnly], matched);
  assert.deepEqual(matched, []);

  const corruptions: QuoteSourceRow[] = [
    { ...direct, direct_source_snapshot_id: null },
    { ...direct, direct_linked_job_id_alias: "999" },
    { ...inverse, inverse_conversion_job_id: "not-an-id" },
  ];
  const mismatches: ValidationMismatch[] = [];
  validateQuoteConversionEvidence(corruptions, mismatches);
  assert.deepEqual(new Set(mismatches.map((item) => item.type)), new Set([
    "quote_direct_conversion_source_missing",
    "conflicting_direct_conversion_ids",
    "invalid_inverse_conversion_id",
  ]));
});

test("quote relationship validator rejects direct and inverse canonical drift", () => {
  const staleDirect = quoteRow("21", 1_000, {
    canonical_linked_job_id: "400",
    snapshot_linked_job_id: "400",
  });
  const missingDirect = quoteRow("22", 1_000, {
    direct_linked_job_id: "500",
    direct_conversion_job_id: "500",
    canonical_linked_job_id: null,
    snapshot_linked_job_id: null,
  });
  const missingInverse = quoteRow("23", 1_000, {
    inverse_conversion_job_id: "703",
    expected_inverse_job_ids: ["703"],
    canonical_inverse_job_ids: [],
    snapshot_inverse_job_ids: [],
  });
  const staleInverse = quoteRow("24", 1_000, {
    expected_inverse_job_ids: [],
    canonical_inverse_job_ids: ["704"],
    snapshot_inverse_job_ids: ["704"],
  });
  const conflict = quoteRow("25", 1_000, {
    direct_linked_job_id: "400",
    direct_linked_job_id_alias: "500",
    relationship_provenance_error: "Raw quote direct-link scalar fields conflict.",
  });
  const mismatches: ValidationMismatch[] = [];
  validateQuoteConversionEvidence(
    [staleDirect, missingDirect, missingInverse, staleInverse, conflict],
    mismatches,
  );
  assert.deepEqual(new Set(mismatches.map((item) => item.type)), new Set([
    "canonical_direct_relationship_drift",
    "snapshot_direct_relationship_drift",
    "canonical_inverse_relationship_drift",
    "snapshot_inverse_relationship_drift",
    "conflicting_direct_conversion_ids",
    "invalid_quote_relationship_provenance",
  ]));

  const source = aggregateQuoteSources([staleDirect, missingDirect, missingInverse, staleInverse, conflict])
    .get("2026-06-01");
  assert.ok(source);
  assert.equal(source.accepted_count, 2);
  assert.equal(source.not_accepted_count, 3);
});

test("strict quote source reader ignores incomplete/deleted newer provenance and detects authoritative removal", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema metrics;
      create table metrics.metrics_quotes (
        quote_id bigint primary key, date_issued date, date_approved date, total numeric, status_name text,
        linked_job_id bigint, source_deleted_at timestamptz
      );
      create table metrics.quote_snapshots (quote_id bigint primary key, linked_job_id bigint);
      create table metrics.metrics_jobs (
        job_id bigint primary key, converted_from_type text, converted_from_id bigint,
        job_source_type text, job_source_id bigint, source_deleted_at timestamptz
      );
      create table metrics.job_snapshots (job_id bigint primary key, source_quote_id bigint);
      create table metrics.raw_simpro_snapshots (
        id bigint primary key, entity_type text, entity_id text, payload jsonb,
        extracted_at timestamptz, complete_traversal boolean, source_deleted_at timestamptz
      );
      create table metrics.quote_classification_overrides (
        id bigint primary key, quote_id bigint, outcome text, won_override boolean,
        active boolean, revision integer, created_at timestamptz
      );
      insert into metrics.metrics_quotes values
        (31, date '2026-06-01', date '2026-06-01', 1000, 'Pending', 500, null),
        (32, date '2026-06-02', date '2026-06-02', 1000, 'Pending', null, null);
      insert into metrics.quote_snapshots values (31, 500), (32, null);
      insert into metrics.metrics_jobs values
        (500, 'Direct service', null, 'Direct service', null, null),
        (703, 'Quote', 32, 'Quote', 32, null);
      insert into metrics.job_snapshots values (500, null), (703, 32);
      insert into metrics.raw_simpro_snapshots values
        (1, 'quote_details', '31', '{"ID":31,"LinkedJobID":500}', timestamptz '2026-06-01', true, null),
        (2, 'quote_details', '31', '{"ID":31,"LinkedJobID":400}', timestamptz '2026-06-03', false, null),
        (3, 'quote_details', '31', '{"ID":31,"LinkedJobID":400}', timestamptz '2026-06-04', true, timestamptz '2026-06-05'),
        (4, 'quote_details', '32', '{"ID":32,"LinkedJobID":null}', timestamptz '2026-06-01', true, null),
        (5, 'job_details', '500', '{"ID":500,"ConvertedFrom":null}', timestamptz '2026-06-01', true, null),
        (6, 'job_details', '703', '{"ID":703,"ConvertedFrom":{"Type":"Quote","ID":32}}', timestamptz '2026-06-01', true, null),
        (7, 'job_details', '703', '{"ID":703,"ConvertedFrom":null}', timestamptz '2026-06-03', false, null),
        (8, 'job_details', '703', '{"ID":703,"ConvertedFrom":null}', timestamptz '2026-06-04', true, timestamptz '2026-06-05');
    `);
    const client = {
      query: <T>(sql: string, values?: unknown[]) => db.query<T>(sql, values),
    } as Parameters<typeof readQuoteSourceRows>[0];
    const baseline = await readQuoteSourceRows(client);
    const baselineMismatches: ValidationMismatch[] = [];
    validateQuoteConversionEvidence(baseline, baselineMismatches);
    assert.deepEqual(baselineMismatches, []);
    assert.equal(aggregateQuoteSources(baseline).get("2026-06-01")?.accepted_count, 2);

    await db.exec(`
      insert into metrics.raw_simpro_snapshots values
        (9, 'quote_details', '31', '{"ID":31,"LinkedJobID":null}', timestamptz '2026-06-06', true, null),
        (10, 'job_details', '703', '{"ID":703,"ConvertedFrom":null}', timestamptz '2026-06-06', true, null)
    `);
    const removed = await readQuoteSourceRows(client);
    const removalMismatches: ValidationMismatch[] = [];
    validateQuoteConversionEvidence(removed, removalMismatches);
    assert.ok(removalMismatches.some((item) => item.type === "canonical_direct_relationship_drift"));
    assert.ok(removalMismatches.some((item) => item.type === "snapshot_direct_relationship_drift"));
    assert.ok(removalMismatches.some((item) => item.type === "canonical_inverse_relationship_drift"));
    assert.ok(removalMismatches.some((item) => item.type === "snapshot_inverse_relationship_drift"));
    assert.equal(aggregateQuoteSources(removed).get("2026-06-01")?.accepted_count, 0);
  } finally {
    await db.close();
  }
});

const JOB_FIELDS = [
  "netProfitActual", "netMarginActual", "materialsCostActual", "materialsCostEstimate", "laborCostActual", "laborCostEstimate",
  "laborHoursActual", "laborHoursEstimate", "overheadCostActual", "overheadCostEstimate",
  "totalResourceCostActual", "totalResourceCostEstimate", "commissionCostActual",
] as const;

function jobFixture() {
  const sourceColumns = JOB_FIELDS.map((field) => field.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`));
  const source: JobSourceAggregate = {
    period_start: "2026-06-01",
    completed_jobs: 2,
    total_sell_value: 1_000,
    gross_profit_actual: 400,
    gross_margin_included_jobs: 2,
    gross_margin_covered_sell_value: 1_000,
    gross_margin_covered_profit: 400,
    net_profit_actual: 250,
    net_margin_included_jobs: 1,
    net_margin_covered_sell_value: 600,
    net_margin_covered_profit: 250,
    materials_actual: 200,
    labor_actual: 150,
    overhead_actual: 50,
    commission_actual: 25,
    materials_paired_actual: 200,
    materials_paired_estimate: 180,
    materials_paired_jobs: 1,
    labor_paired_actual: 150,
    labor_paired_estimate: 140,
    labor_paired_jobs: 1,
    overhead_paired_actual: 50,
    overhead_paired_estimate: 45,
    overhead_paired_jobs: 1,
    total_paired_actual: 225,
    total_paired_estimate: 210,
    total_paired_jobs: 1,
    sell_value_supported: 2,
    gross_profit_supported: 2,
    net_profit_supported: 1,
    cost_totals_supported: 1,
    field_support: Object.fromEntries(sourceColumns.map((field) => [field, 1])),
  };
  const values = {
    completedJobCount: 2,
    totalSellValue: 1_000,
    averageJobValue: 500,
    grossProfitActual: 400,
    grossMarginActual: 40,
    netProfitActual: 250,
    netMarginActual: 250 / 600 * 100,
    profitBridge: { revenue: 1_000, materials: 200, labor: 150, overhead: 50, commission: 25, netProfit: 250, other: 325 },
    costVariance: {
      materialsActual: 200, materialsEstimate: 180, materialsPairedJobs: 1,
      laborActual: 150, laborEstimate: 140, laborPairedJobs: 1,
      overheadActual: 50, overheadEstimate: 45, overheadPairedJobs: 1,
      totalActual: 225, totalEstimate: 210, totalPairedJobs: 1,
    },
    financialCoverage: {
      totalJobs: 2, sellValueSupported: 2, sellValueMissing: 0,
      grossProfitSupported: 2, grossProfitMissing: 0, netProfitSupported: 1,
      netProfitMissing: 1, costTotalsSupported: 1,
      grossMarginIncludedJobs: 2, grossMarginCoveredSellValue: 1_000, grossMarginCoveredProfit: 400,
      netMarginIncludedJobs: 1, netMarginCoveredSellValue: 600, netMarginCoveredProfit: 250,
    },
    grossMarginCoverage: { fromSimproTotals: 2, fallbackOrMissing: 0 },
    fieldCoverage: Object.fromEntries(JOB_FIELDS.map((field) => [field, { total: 2, supported: 1, missing: 1 }])),
  };
  return { source, values };
}

test("job validation covers gross/net margin pairs, all financial coverage, and paired cost aggregates", () => {
  const { source, values } = jobFixture();
  const matched: ValidationMismatch[] = [];
  validateJobs(readModel("jobs", values), source, matched);
  assert.deepEqual(matched, []);

  const fields = [
    "averageJobValue", "grossMarginActual", "netMarginActual",
    "financialCoverage.grossMarginIncludedJobs", "financialCoverage.grossMarginCoveredSellValue",
    "financialCoverage.grossMarginCoveredProfit", "financialCoverage.netMarginIncludedJobs",
    "financialCoverage.netMarginCoveredSellValue", "financialCoverage.netMarginCoveredProfit",
    "grossMarginCoverage.fromSimproTotals", "grossMarginCoverage.fallbackOrMissing",
    "costVariance.materialsActual", "costVariance.materialsEstimate", "costVariance.materialsPairedJobs",
    "costVariance.laborActual", "costVariance.laborEstimate", "costVariance.laborPairedJobs",
    "costVariance.overheadActual", "costVariance.overheadEstimate", "costVariance.overheadPairedJobs",
    "costVariance.totalActual", "costVariance.totalEstimate", "costVariance.totalPairedJobs",
  ];
  for (const path of fields) {
    const mutated = structuredClone(values) as Record<string, unknown>;
    setNumberAt(mutated, path, Number(valueAt(mutated, path)) + 1);
    const mismatches: ValidationMismatch[] = [];
    validateJobs(readModel("jobs", mutated), source, mismatches);
    assert.ok(mismatches.some((item) => item.field === path), path);
  }
});

test("job margin and average denominators remain null when their denominator is zero", () => {
  const { source, values } = jobFixture();
  const zero: JobSourceAggregate = {
    ...source,
    completed_jobs: 0,
    total_sell_value: 0,
    gross_profit_actual: 0,
    gross_margin_included_jobs: 0,
    gross_margin_covered_sell_value: 0,
    gross_margin_covered_profit: 0,
    net_profit_actual: 0,
    net_margin_included_jobs: 0,
    net_margin_covered_sell_value: 0,
    net_margin_covered_profit: 0,
    sell_value_supported: 0,
    gross_profit_supported: 0,
    net_profit_supported: 0,
    cost_totals_supported: 0,
    field_support: {},
  };
  const zeroValues = structuredClone(values);
  zeroValues.completedJobCount = 0;
  zeroValues.totalSellValue = 0;
  zeroValues.averageJobValue = null as unknown as number;
  zeroValues.grossProfitActual = 0;
  zeroValues.grossMarginActual = null as unknown as number;
  zeroValues.netProfitActual = 0;
  zeroValues.netMarginActual = null as unknown as number;
  for (const key of Object.keys(zeroValues.financialCoverage)) zeroValues.financialCoverage[key as keyof typeof zeroValues.financialCoverage] = 0;
  zeroValues.grossMarginCoverage = { fromSimproTotals: 0, fallbackOrMissing: 0 };
  zeroValues.fieldCoverage = Object.fromEntries(JOB_FIELDS.map((field) => [field, { total: 0, supported: 0, missing: 0 }]));
  zeroValues.profitBridge = { revenue: 0, materials: 200, labor: 150, overhead: 50, commission: 25, netProfit: 0, other: -425 };

  for (const field of ["averageJobValue", "grossMarginActual", "netMarginActual"] as const) {
    const mutated = { ...zeroValues, [field]: 0 };
    const mismatches: ValidationMismatch[] = [];
    validateJobs(readModel("jobs", mutated), zero, mismatches);
    assert.ok(mismatches.some((item) => item.field === field), field);
  }
});

test("labor source classification matches production aliases and quote/recurring fallbacks", () => {
  for (const alias of ["Quote", "quote-generated", "generated from quote"]) {
    assert.equal(classifyTechnicianLaborSource({ jobSource: alias }), "quote_generated", alias);
  }
  for (const alias of ["Recurring", "recurring-job", "recurring job"]) {
    assert.equal(classifyTechnicianLaborSource({ jobSource: alias }), "recurring", alias);
  }
  assert.equal(classifyTechnicianLaborSource({ jobSource: "Direct", quoteId: "10" }), "quote_generated");
  assert.equal(classifyTechnicianLaborSource({ recurringJobId: "20" }), "recurring");
  assert.equal(classifyTechnicianLaborSource({ jobSource: "Contract" }), "other");

  const rows: LaborEfficiencySourceRow[] = [
    laborRow("generated from quote", { quote_id: "10", quote_quoted_hours: 8, quote_labor_rows: 1, technicians: 1, actual_hours: 4 }),
    laborRow("recurring job", { quote_quoted_hours: 6, quote_labor_rows: 1, technicians: 2, actual_hours: 3 }),
    laborRow("Direct", { quote_id: "30", quote_quoted_hours: 4, quote_labor_rows: 1, technicians: 1, actual_hours: 2 }),
  ];
  const aggregate = aggregateLaborEfficiencySources(rows).get("2026-06-01");
  assert.equal(aggregate?.quote_generated_jobs, 2);
  assert.equal(aggregate?.recurring_jobs, 1);
  assert.equal(aggregate?.individual_jobs, 2);
  assert.equal(aggregate?.crew_jobs, 1);
});

function laborRow(jobSource: string | null, overrides: Partial<LaborEfficiencySourceRow>): LaborEfficiencySourceRow {
  return {
    period_start: "2026-06-01",
    job_source_type: jobSource,
    job_source_id: null,
    quote_id: null,
    labor_hours_estimate: null,
    quote_quoted_hours: null,
    quote_labor_rows: 0,
    technicians: 0,
    actual_hours: 0,
    ...overrides,
  };
}

test("labor efficiency totals group allocation rows once per job", () => {
  const totals = laborEfficiencyServedTotals({
    technicians: [{ laborEfficiency: {
      quoteGenerated: { quotedHours: 8, actualHours: 4, jobs: 1 },
      recurring: { quotedHours: 7.5, actualHours: 3, jobs: 1 },
    } }],
    crewLaborEfficiency: [{ source: "recurring", quotedHours: 12, actualHours: 8, jobs: 1 }],
    allocations: [
      { jobId: "Q", jobSource: "quote_generated", laborEfficiencyCovered: true, quotedHours: 8, actualHours: 4 },
      { jobId: "R", jobSource: "recurring", laborEfficiencyCovered: true, quotedHours: 12, actualHours: 3 },
      { jobId: "R", jobSource: "recurring", laborEfficiencyCovered: true, quotedHours: 12, actualHours: 5 },
    ],
  });
  assert.deepEqual(totals, {
    quoteGenerated: { quotedHours: 8, actualHours: 4, jobs: 1 },
    recurring: { quotedHours: 12, actualHours: 8, jobs: 1 },
  });
});

test("utilization independently uses productive supported job hours over all positive recorded hours", () => {
  const source: TechnicianUtilizationSourceRow[] = [{
    period_start: "2026-06-01",
    employee_id: "7",
    person_mapped: true,
    roster_member: true,
    productive_supported_job_hours: 3,
    all_positive_recorded_hours: 10,
  }];
  const values = {
    coverage: {
      productiveHours: 3,
      utilizationProductiveHours: 3,
      totalRecordedHours: 10,
      utilizationAllRecordedHours: 10,
      adjustedCapacityHours: 4,
    },
    technicians: [{
      employeeId: "7",
      productiveHours: 3,
      totalRecordedHours: 10,
      adjustedCapacityHours: 4,
      utilizationPercent: 30,
      coverage: {
        utilizationProductiveHours: 3,
        utilizationAllRecordedHours: 10,
      },
    }],
  };
  const matched: ValidationMismatch[] = [];
  validateTechnicianUtilization(readModel("technicians", values), source, matched);
  assert.deepEqual(matched, []);

  const corrupted = structuredClone(values);
  corrupted.technicians[0].utilizationPercent = 75;
  const mismatches: ValidationMismatch[] = [];
  validateTechnicianUtilization(readModel("technicians", corrupted), source, mismatches);
  assert.ok(mismatches.some((item) => item.field === "technicians.7.utilizationPercent"));
});

test("cost-center and parent categories fail on known, unknown, or missing ID corruption", () => {
  const rows: CostCenterCategorySourceRow[] = [
    categoryRow("job", "1", "11", 4, "Water Heating", "Water Heating"),
    categoryRow("job", "2", "21", 999, "Unclassified", "Unclassified"),
    categoryRow("quote", "3", "31", 5, "HVAC", "HVAC"),
    categoryRow("quote", "4", "41", null, "Unclassified", "Unclassified"),
  ];
  assert.equal(independentCostCenterCategory(4), "Water Heating");
  assert.equal(independentCostCenterCategory(6), "Water Heating");
  assert.equal(independentCostCenterCategory(8), "Water Heating");
  assert.equal(independentCostCenterCategory(5), "HVAC");
  assert.equal(independentCostCenterCategory(7), "HVAC");
  assert.equal(independentCostCenterCategory(9), "Unclassified");
  assert.equal(independentCostCenterCategory(null), "Unclassified");
  const matched: ValidationMismatch[] = [];
  validateCostCenterCategories(rows, matched);
  assert.deepEqual(matched, []);

  const corrupted = structuredClone(rows);
  corrupted[0].category = "HVAC";
  corrupted[1].category = "Water Heating";
  corrupted[3].category = "HVAC";
  corrupted[2].parent_category = "Unclassified";
  const mismatches: ValidationMismatch[] = [];
  validateCostCenterCategories(corrupted, mismatches);
  assert.equal(mismatches.filter((item) => item.type === "cost_center_category_mapping").length, 3);
  assert.ok(mismatches.some((item) => item.type === "parent_category_projection" && item.projectId === "3"));
});

test("invoice runtime and invoice or AR API dimensions must remain absent", () => {
  const matched: ValidationMismatch[] = [];
  validateInvoiceRuntime({ active_ingestion_jobs: 0, active_ingestion_runs: 0, active_backfill_units: 0 }, matched);
  validateNoInvoiceArApiDimensions([readModel("jobs", {})], matched);
  assert.deepEqual(matched, []);

  const invoiceMismatches: ValidationMismatch[] = [];
  validateInvoiceRuntime({ active_ingestion_jobs: 1, active_ingestion_runs: 2, active_backfill_units: 3 }, invoiceMismatches);
  assert.equal(invoiceMismatches.filter((item) => item.type === "active_invoice_runtime").length, 3);

  const row = readModel("jobs", {});
  row.dimensions_json = {
    customerInvoiceStatus: "sent",
    activeInvoice: true,
    accountReceivableStatus: "past_due",
    receivableAging: "30_days",
    invoicingMode: "batch",
    arAging: "60_days",
    arStatus: "open",
    accounts_receivable: true,
    arrivalStatus: "scheduled",
    targetArrivalWindow: "morning",
    targetStatus: "met",
  };
  const dimensionMismatches: ValidationMismatch[] = [];
  validateNoInvoiceArApiDimensions([row], dimensionMismatches);
  assert.deepEqual(dimensionMismatches.map((item) => item.path), [
    "dimensions.customerInvoiceStatus",
    "dimensions.activeInvoice",
    "dimensions.accountReceivableStatus",
    "dimensions.receivableAging",
    "dimensions.invoicingMode",
    "dimensions.arAging",
    "dimensions.arStatus",
    "dimensions.accounts_receivable",
  ]);
  assert.deepEqual(forbiddenInvoiceArDimensionPaths({
    category: "HVAC",
    arrivalStatus: "scheduled",
    targetArrivalWindow: "morning",
    targetStatus: "met",
  }), []);
});

test("production environment and active app_roles authorize exactly Asad and Laila", () => {
  const env = productionOwnerEnvironment();
  const roles: AppRoleSourceRow[] = [
    { email: "asad@prostarmechanical.com", role: "admin" },
    { email: "laila@prostarmechanical.com", role: "finance" },
  ];
  const matched: ValidationMismatch[] = [];
  validateProductionOwnerAuthorization(env, roles, matched);
  assert.deepEqual(matched, []);

  const corruptedEnv = { ...env, METRICS_VIEWER_EMAILS: "third@prostarmechanical.com" };
  const corruptedRoles = [...roles, { email: "third@prostarmechanical.com", role: "admin" }];
  const mismatches: ValidationMismatch[] = [];
  validateProductionOwnerAuthorization(corruptedEnv, corruptedRoles, mismatches);
  assert.ok(mismatches.some((item) => item.type === "production_owner_environment"));
  assert.ok(mismatches.some((item) => item.type === "production_owner_app_roles"));
});

test("capacity validation starts from source eligibility and detects omitted explicit and default employees", () => {
  const capacityRows: CapacitySourceRow[] = [
    capacityRow("7", null),
    capacityRow("8", {
      Monday: { StartTime: "08:00", EndTime: "16:00" },
      Tuesday: { StartTime: "08:00", EndTime: "16:00" },
    }),
  ];
  const base = readModel("technicians", { technicians: [] });
  const expected = expectedCapacities(base, capacityRows);
  assert.equal(expected.length, 2);
  assert.deepEqual(new Set(expected.map((item) => item.availabilitySource)), new Set(["default", "simpro"]));
  const technicians = expected.map((capacity) => ({
    employeeId: capacity.employeeId,
    displayName: capacity.source.display_name,
    availabilitySource: capacity.availabilitySource,
    dateOfHire: capacity.dateOfHire,
    archived: capacity.archived,
    grossCapacityHours: capacity.grossCapacityHours,
    adjustedCapacityHours: capacity.adjustedCapacityHours,
    eligibleWorkdays: capacity.eligibleWorkdays,
    holidayHours: capacity.holidayHours,
    sickPersonalHours: capacity.sickPersonalHours,
    ptoHours: capacity.ptoHours,
    laborEfficiency: {
      quoteGenerated: { quotedHours: 0, actualHours: 0, jobs: 0 },
      recurring: { quotedHours: 0, actualHours: 0, jobs: 0 },
    },
  }));
  const labor = emptyLaborAggregate();
  const gross = expected.reduce((sum, item) => sum + item.grossCapacityHours, 0);
  const adjusted = expected.reduce((sum, item) => sum + item.adjustedCapacityHours, 0);
  const coverage = {
    totalJobs: 0, jobsWithTimesheets: 0, jobsMissingTimesheets: 0, quoteSourcedJobs: 0, quoteGeneratedJobs: 0,
    recurringJobs: 0, jobsWithQuotedLabor: 0, quoteGeneratedJobsWithLabor: 0, recurringJobsWithLabor: 0,
    quoteSourcedJobsMissingLabor: 0, laborEfficiencyIncludedJobs: 0, individualLaborEfficiencyJobs: 0,
    crewLaborEfficiencyJobs: 0, grossCapacityHours: gross, adjustedCapacityHours: adjusted,
    holidayHours: 16, sickPersonalHours: 0, ptoHours: 8,
    scheduledVisits: 0, arrivalCoveredVisits: 0, uncoveredVisits: 0,
  };
  const coverageSource = { period_start: "2026-06-01", holiday_hours: 16, sick_personal_hours: 0, pto_hours: 8 };
  const matched: ValidationMismatch[] = [];
  validateTechnicians(readModel("technicians", { technicians, crewLaborEfficiency: [], coverage }), labor, capacityRows, coverageSource, matched);
  assert.deepEqual(matched, []);

  for (const omitted of ["7", "8"]) {
    const mismatches: ValidationMismatch[] = [];
    validateTechnicians(
      readModel("technicians", { technicians: technicians.filter((item) => item.employeeId !== omitted), crewLaborEfficiency: [], coverage }),
      labor, capacityRows, coverageSource, mismatches,
    );
    assert.ok(mismatches.some((item) => item.type === "missing_capacity_employee" && item.employeeId === omitted), omitted);
  }
});

function capacityRow(employeeId: string, availability: unknown): CapacitySourceRow {
  return {
    period_start: "2026-06-01",
    period_end: "2026-06-30",
    employee_id: employeeId,
    display_name: `Employee ${employeeId}`,
    date_of_hire: "2020-01-01",
    archived: false,
    availability_json: availability,
    holiday_hours: 8,
    sick_personal_hours: 0,
    pto_hours: 4,
  };
}

function emptyLaborAggregate(): LaborEfficiencySourceAggregate {
  return {
    period_start: "2026-06-01", total_jobs: 0, jobs_with_timesheets: 0, quote_generated_jobs: 0,
    recurring_jobs: 0, quote_generated_jobs_with_labor: 0, recurring_jobs_with_labor: 0,
    missing_labor_jobs: 0, included_jobs: 0, individual_jobs: 0, crew_jobs: 0,
    quote_quoted_hours: 0, quote_actual_hours: 0, quote_jobs: 0,
    recurring_quoted_hours: 0, recurring_actual_hours: 0, recurring_included_jobs: 0,
  };
}

function commissionFixture() {
  const inputs: CommissionInputRow[] = [
    { input_type: "job", source_identity: "101", input_json: { jobId: "101", sellValue: 100 } },
    { input_type: "job", source_identity: "102", input_json: { jobId: "102", sellValue: 50 } },
    { input_type: "timesheet", source_identity: "7:t1", input_json: { jobId: "101", employeeId: "7", hours: 2, mapped: true, fieldTechnician: true } },
  ];
  const employee_results: CommissionEmployeeResult[] = [{
    employee_id: "7",
    forfeited_bonus: 5,
    reallocation_received: 5,
    efficiency_json: { effect: 0 },
    outside_pool_adjustment: 10,
    final_bonus: 100,
    payroll_bonus: 110,
  }];
  const job_allocations: CommissionJobAllocation[] = [{
    job_id: "101", employee_id: "7", job_total: 100, allocated_value: 100,
  }];
  const allTrue = Object.fromEntries(COMMISSION_INVARIANTS.map((name) => [name, true]));
  const run = {
    run_id: "1",
    completed_jobs: 2,
    total_work_value: "150",
    pool_amount: "100",
    inside_pool_total: "100",
    outside_pool_total: "10",
    payroll_total: "110",
    source_complete: true,
    source_status: "complete",
    invariants_json: allTrue,
    inputs,
    employee_results,
    job_allocations,
  };
  const values = {
    completedJobs: 2,
    totalWorkValue: 150,
    poolAmount: 100,
    insidePoolTotal: 100,
    outsidePoolTotal: 10,
    payrollTotal: 110,
    invariants: allTrue,
  };
  return { run, values };
}

test("commission validation independently recomputes all seven invariants despite stored true booleans", () => {
  const { run, values } = commissionFixture();
  assert.deepEqual(recomputeCommissionInvariants(run), Object.fromEntries(COMMISSION_INVARIANTS.map((name) => [name, true])));
  const matched: ValidationMismatch[] = [];
  validateCommissions(readModel("commissions", values), run, matched);
  assert.deepEqual(matched, []);

  const mutations: Record<(typeof COMMISSION_INVARIANTS)[number], (copy: typeof run) => void> = {
    insidePoolReconciles: (copy) => { copy.employee_results[0].final_bonus = 99; },
    outsidePoolReconciles: (copy) => { copy.employee_results[0].payroll_bonus = 109; },
    jobAllocationsReconcile: (copy) => { copy.job_allocations[0].allocated_value = 99; },
    unsupportedJobsUnallocated: (copy) => { copy.job_allocations.push({ job_id: "102", employee_id: "7", job_total: 50, allocated_value: 50 }); },
    forfeitureReconciles: (copy) => { copy.employee_results[0].reallocation_received = 4; },
    efficiencyReconciles: (copy) => { copy.employee_results[0].efficiency_json = { effect: 1 }; },
    nonnegativePayroll: (copy) => { copy.employee_results[0].payroll_bonus = -1; },
  };
  for (const invariant of COMMISSION_INVARIANTS) {
    const mutated = structuredClone(run);
    mutations[invariant](mutated);
    assert.equal(recomputeCommissionInvariants(mutated)[invariant], false, invariant);
    const mismatches: ValidationMismatch[] = [];
    validateCommissions(readModel("commissions", values), mutated, mismatches);
    assert.ok(mismatches.some((item) => item.invariant === invariant && item.recomputed === false), invariant);
  }
});

test("payload source hash is recomputed from payload semantics", () => {
  const values = { completedJobCount: 2, generatedAt: "2026-07-01T00:00:00Z" };
  const row = readModel("jobs", values);
  const matched: ValidationMismatch[] = [];
  validatePayloadSourceHash(row, matched);
  assert.deepEqual(matched, []);

  row.values_json = { ...values, completedJobCount: 3 };
  const mismatches: ValidationMismatch[] = [];
  validatePayloadSourceHash(row, mismatches);
  assert.equal(mismatches[0]?.type, "payload_source_hash");
});

test("database validation uses a read-only REPEATABLE READ transaction", async () => {
  const source = await readFile(new URL("../../scripts/validate-dashboard-read-models.ts", import.meta.url), "utf8");
  assert.match(source, /begin transaction isolation level repeatable read read only/i);
  assert.match(source, /client\.query\("commit"\)/);
  assert.match(source, /client\.query\("rollback"\)/);
  assert.doesNotMatch(source, /j\.job_no\s*=\s*q\.job_no/);
  assert.doesNotMatch(source, /exact_job_no_match_id/);
});

function categoryRow(
  project_type: "job" | "quote",
  project_id: string,
  cost_center_id: string,
  configured_cost_center_id: number | null,
  category: string,
  parent_category: string,
): CostCenterCategorySourceRow {
  return {
    project_type,
    project_id,
    cost_center_id,
    configured_cost_center_id,
    category,
    sell_value: 100,
    parent_category,
  };
}

function productionOwnerEnvironment() {
  return {
    METRICS_AUTH_MODE: "easy-auth",
    METRICS_ADMIN_EMAILS: "asad@prostarmechanical.com,laila@prostarmechanical.com",
    METRICS_FINANCE_EMAILS: "laila@prostarmechanical.com,asad@prostarmechanical.com",
    METRICS_OPERATOR_EMAILS: "",
    METRICS_VIEWER_EMAILS: "",
  };
}

function valueAt(root: Record<string, unknown>, path: string): unknown {
  let value: unknown = root;
  for (const part of path.split(".")) value = (value as Record<string, unknown>)[part];
  return value;
}

function setNumberAt(root: Record<string, unknown>, path: string, value: number) {
  const parts = path.split(".");
  let target = root;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  target[parts.at(-1)!] = value;
}

import assert from "node:assert/strict";
import test from "node:test";
import type { FreshnessStatus } from "../../src/lib/metrics/freshness";
import {
  buildQuoteMetricsReadModel,
  buildQuoteMetricsReadModelFromPersistedRecords,
  buildPersistedQuoteDashboardRecords,
  getQuoteFollowUpQueue,
  getPersistedQuoteDashboard,
  getPersistedQuoteDashboardRecords,
  loadQuoteDashboardRows,
  type QuoteCanonicalRow,
} from "../../src/lib/store/quote-dashboard-read-model";

const freshness: FreshnessStatus = {
  pageKey: "quotes",
  state: "current",
  label: "Current",
  detail: "Test fixture",
  dataThrough: null,
  lastSuccessfulRunAt: null,
  lastFailedRunAt: null,
};

test("dashboard source query serves projected canonical conversion evidence", async () => {
  let capturedSql = "";
  await loadQuoteDashboardRows(async <T>(sql: string) => {
    capturedSql = sql;
    return { rows: [] as T[] };
  });

  assert.match(capturedSql, /q\.linked_job_id::text as linked_job_id/);
  assert.match(capturedSql, /j\.converted_from_type = 'Quote'/);
  assert.match(capturedSql, /select distinct on \(j\.converted_from_id\)/);
  assert.match(capturedSql, /inverse_job\.converted_from_id = q\.quote_id/);
  assert.match(capturedSql, /active_exclusions/);
  assert.match(capturedSql, /source_deleted_at is null/);
  assert.doesNotMatch(capturedSql, /quote_identity/);
  assert.doesNotMatch(capturedSql, /raw_simpro_snapshots/);
  assert.doesNotMatch(capturedSql, /Customer,CompanyName/);
  assert.doesNotMatch(capturedSql, /Site,Name/);
  assert.doesNotMatch(capturedSql, /authoritative_quote_linked_job_id/);
  assert.doesNotMatch(capturedSql, /authoritative_job_source_quote_id/);
  assert.doesNotMatch(capturedSql, /job_no\s*=/);
});

test("default quote dashboard reads the persisted serving model before canonical reconstruction", async () => {
  const dashboard = buildQuoteMetricsReadModel(freshness, [
    quoteRow({ id: 8, dateApproved: "2026-06-03", total: 800 }),
  ], undefined, {
    selectedMonth: "2026-06",
    now: new Date("2026-07-10T20:00:00Z"),
  });
  let capturedSql = "";
  let capturedValues: unknown[] | undefined;
  const persisted = await getPersistedQuoteDashboard("2026-06", async <T>(sql: string, values?: unknown[]) => {
    capturedSql = sql;
    capturedValues = values;
    return { rows: [{ dashboard }] as T[] };
  });

  assert.equal(persisted, dashboard);
  assert.match(capturedSql, /values_json -> 'dashboard' as dashboard/);
  assert.match(capturedSql, /metric_family = 'quotes'/);
  assert.match(capturedSql, /period_start = \$1::date/);
  assert.deepEqual(capturedValues, ["2026-06-01"]);
});

test("filtered quote dashboard preserves pagination semantics from persisted monthly quote records", () => {
  const rows = [
    ...Array.from({ length: 60 }, (_, index) => quoteRow({
      id: index + 1,
      dateApproved: `2026-06-${String(index % 28 + 1).padStart(2, "0")}`,
      dateIssued: "2026-06-01",
      total: index + 1,
      linkedMatch: true,
      linkedJobId: 10_000 + index,
      category: "HVAC",
    })),
    quoteRow({ id: 100, dateApproved: "2026-07-03", dateIssued: "2026-06-28", total: 9_999, category: "Water Heating" }),
  ];
  const options = {
    selectedMonth: "2026-06",
    now: new Date("2026-07-10T20:00:00Z"),
    category: "HVAC",
    tier: "Under $750",
    outcome: "accepted",
    acceptancePath: "converted_only",
    sort: "value-desc",
    page: 2,
  };
  const canonical = buildQuoteMetricsReadModel(freshness, rows, undefined, options);
  const persisted = buildQuoteMetricsReadModelFromPersistedRecords(
    freshness,
    [
      ...buildPersistedQuoteDashboardRecords(rows, "2026-06-01"),
      ...buildPersistedQuoteDashboardRecords(rows, "2026-07-01"),
    ],
    undefined,
    options,
  );

  assert.deepEqual(persisted.classificationRows, canonical.classificationRows);
  assert.deepEqual(persisted.pagination, canonical.pagination);
  assert.deepEqual(persisted.currentMonth, canonical.currentMonth);
  assert.deepEqual(persisted.sentMonthly, canonical.sentMonthly);
});

test("persisted quote records require every requested monthly serving model", async () => {
  let capturedSql = "";
  let capturedValues: unknown[] | undefined;
  const records = await getPersistedQuoteDashboardRecords("2023-02", async <T>(sql: string, values?: unknown[]) => {
    capturedSql = sql;
    capturedValues = values;
    return {
      rows: [
        { period_start: "2023-01-01", quote_records: [] },
        { period_start: "2023-02-01", quote_records: [] },
      ] as T[],
    };
  });
  assert.deepEqual(records, []);
  assert.match(capturedSql, /values_json -> 'quoteRecords' as quote_records/);
  assert.match(capturedSql, /period_start = any\(\$1::date\[\]\)/);
  assert.deepEqual(capturedValues, [["2023-01-01", "2023-02-01"]]);

  const missingMonth = await getPersistedQuoteDashboardRecords("2023-02", async <T>() => ({
    rows: [{ period_start: "2023-02-01", quote_records: [] }] as T[],
  }));
  assert.equal(missingMonth, null);
});

test("selected month classifies all evidence paths with exact denominators", () => {
  const model = buildQuoteMetricsReadModel(freshness, [
    quoteRow({ id: 1, dateApproved: "2026-06-01", total: 100, status: "Quote Accepted Online", category: "HVAC" }),
    quoteRow({ id: 2, dateApproved: "2026-06-02", total: 200, linkedMatch: true, linkedJobId: 8002, category: "Water Heating" }),
    quoteRow({ id: 3, dateApproved: "2026-06-03", total: 300, status: "Quote Accepted Online", inverseMatch: true, linkedJobId: 8003, category: null }),
    quoteRow({ id: 4, dateApproved: "2026-06-04", total: 400, canonicalOutcome: "won", overrideOutcome: "won", category: "HVAC" }),
    quoteRow({ id: 5, dateApproved: "2026-06-05", total: 500, status: "Quote Accepted Online", linkedMatch: true, linkedJobId: 8005, overrideOutcome: "excluded", category: "Water Heating" }),
    quoteRow({ id: 6, dateApproved: "2026-05-31", total: 600, linkedMatch: true, linkedJobId: 8006 }),
    quoteRow({ id: 7, dateApproved: null, total: 700, status: "Quote Accepted Online" }),
  ], { active_count: "2", latest_at: "2026-06-08T00:00:00Z" }, {
    selectedMonth: "2026-06",
    now: new Date("2026-07-10T20:00:00Z"),
  });

  assert.equal(model.currentMonth?.quoteCount, 4);
  assert.equal(model.currentMonth?.acceptedCount, 3);
  assert.equal(model.currentMonth?.notAcceptedCount, 1);
  assert.equal(model.currentMonth?.excludedCount, 1);
  assert.equal(model.currentMonth?.quoteValue, 1000);
  assert.equal(model.currentMonth?.acceptedValue, 600);
  assert.equal(model.currentMonth?.notAcceptedValue, 400);
  assert.equal(model.currentMonth?.acceptanceRateCount, 75);
  assert.equal(model.currentMonth?.acceptanceRateValue, 60);
  assert.equal(model.acceptanceSummary.denominatorCount, 5);

  assert.deepEqual(Object.fromEntries(model.classificationRows.map((row) => [row.quoteId, row.outcome])), {
    1: "accepted",
    2: "accepted",
    3: "accepted",
    4: "not_accepted",
    5: "excluded",
  });
  assert.deepEqual(model.acceptancePaths.map((row) => [row.path, row.count]), [
    ["accepted_online_and_converted", 1],
    ["accepted_online_only", 1],
    ["converted_only", 1],
    ["not_accepted", 1],
  ]);
  assert.equal(model.classificationRows.find((row) => row.quoteId === 4)?.override?.effective, false);
  assert.equal(model.largestNotAccepted[0]?.quoteId, 4);
  assert.deepEqual(model.acceptanceByCategory.map((row) => row.category), ["HVAC", "Water Heating", "Unclassified"]);
  assert.equal(model.methodology.overrides.activeCount, 2);
  assert.equal("openPipeline" in model, false);
});

test("acceptance-path filter covers every app-owned classification path", () => {
  const rows = [
    quoteRow({ id: 10, dateApproved: "2026-06-01", total: 100, status: "Quote Accepted Online", linkedMatch: true, linkedJobId: 8010 }),
    quoteRow({ id: 11, dateApproved: "2026-06-02", total: 200, status: "Quote Accepted Online" }),
    quoteRow({ id: 12, dateApproved: "2026-06-03", total: 300, linkedMatch: true, linkedJobId: 8012 }),
    quoteRow({ id: 13, dateApproved: "2026-06-04", total: 400 }),
    quoteRow({ id: 14, dateApproved: "2026-06-05", total: 500, overrideOutcome: "excluded" }),
  ];
  const expected = {
    accepted_online_and_converted: 10,
    accepted_online_only: 11,
    converted_only: 12,
    not_accepted: 13,
    excluded: 14,
  } as const;

  for (const [acceptancePath, quoteId] of Object.entries(expected)) {
    const model = buildQuoteMetricsReadModel(freshness, rows, undefined, {
      selectedMonth: "2026-06",
      now: new Date("2026-07-10T20:00:00Z"),
      acceptancePath,
    });
    assert.equal(model.filters.acceptancePath, acceptancePath);
    assert.deepEqual(model.classificationRows.map((row) => row.quoteId), [quoteId]);
    if (acceptancePath === "excluded") {
      assert.equal(model.currentMonth?.quoteCount, 0);
      assert.equal(model.currentMonth?.excludedCount, 1);
    }
  }

  const optionsModel = buildQuoteMetricsReadModel(freshness, rows, undefined, {
    selectedMonth: "2026-06",
    now: new Date("2026-07-10T20:00:00Z"),
  });
  assert.deepEqual(optionsModel.filterOptions.acceptancePaths, [
    { path: "accepted_online_and_converted", label: "Accepted online + converted" },
    { path: "accepted_online_only", label: "Accepted online only" },
    { path: "converted_only", label: "Converted only" },
    { path: "not_accepted", label: "Not Accepted" },
    { path: "excluded", label: "Excluded" },
  ]);
});

test("acceptance path composes with outcome and existing record filters", () => {
  const rows = [
    quoteRow({ id: 120, dateApproved: "2026-06-01", total: 1200, status: "Quote Accepted Online", category: "HVAC" }),
    quoteRow({ id: 121, dateApproved: "2026-06-02", total: 1200, status: "Quote Accepted Online", category: "Water Heating" }),
    quoteRow({ id: 122, dateApproved: "2026-06-03", total: 1200, linkedMatch: true, linkedJobId: 8122, category: "HVAC" }),
  ];
  const matching = buildQuoteMetricsReadModel(freshness, rows, undefined, {
    selectedMonth: "2026-06",
    now: new Date("2026-07-10T20:00:00Z"),
    search: "Q120",
    category: "HVAC",
    tier: "$750-$2K",
    outcome: "accepted",
    acceptancePath: "accepted_online_only",
  });
  assert.deepEqual(matching.classificationRows.map((row) => row.quoteId), [120]);

  const conflictingOutcome = buildQuoteMetricsReadModel(freshness, rows, undefined, {
    selectedMonth: "2026-06",
    now: new Date("2026-07-10T20:00:00Z"),
    outcome: "not_accepted",
    acceptancePath: "accepted_online_only",
  });
  assert.equal(conflictingOutcome.pagination.classificationTotal, 0);
});

test("Largest Not Accepted age is deterministic from DateApproved and the model as-of date", () => {
  const rows = [quoteRow({ id: 70, dateApproved: "2026-07-10", total: 2500 })];
  const beforeLosAngelesMidnight = buildQuoteMetricsReadModel(freshness, rows, undefined, {
    selectedMonth: "2026-07",
    now: new Date("2026-07-13T06:59:59Z"),
  });
  const afterLosAngelesMidnight = buildQuoteMetricsReadModel(freshness, rows, undefined, {
    selectedMonth: "2026-07",
    now: new Date("2026-07-13T07:00:00Z"),
  });

  assert.equal(beforeLosAngelesMidnight.largestNotAccepted[0]?.dateApproved, "2026-07-10");
  assert.equal(beforeLosAngelesMidnight.largestNotAccepted[0]?.ageDays, 2);
  assert.equal(afterLosAngelesMidnight.largestNotAccepted[0]?.ageDays, 3);
  assert.equal(beforeLosAngelesMidnight.largestNotAccepted[0]?.evidence, "No accepted-online status or exact converted-job relationship");
});

test("rolling count and value acceptance use aggregate denominators", () => {
  const rows: QuoteCanonicalRow[] = [
    quoteRow({ id: 20, dateApproved: "2026-01-05", total: 100, linkedMatch: true, linkedJobId: 9020 }),
    quoteRow({ id: 21, dateApproved: "2026-02-05", total: 900, linkedMatch: true, linkedJobId: 9021 }),
    ...Array.from({ length: 8 }, (_, index) => quoteRow({ id: 22 + index, dateApproved: `2026-02-${String(index + 6).padStart(2, "0")}`, total: 100 })),
  ];
  const model = buildQuoteMetricsReadModel(freshness, rows, undefined, {
    selectedMonth: "2026-03",
    now: new Date("2026-04-02T20:00:00Z"),
  });
  const march = model.trends.at(-1)!;
  assert.equal(march.acceptanceRateCount, null);
  assert.equal(march.acceptanceRateCount3Month, 20);
  assert.equal(march.acceptanceRateCount12Month, 20);
  assert.equal(march.acceptanceRateValue3Month, 1000 / 1800 * 100);
});

test("descriptive JobNo equality with a live job number is not conversion evidence", () => {
  const quoteJobNo = "8123";
  const liveJob = { jobId: 9001, jobNo: "8123" };
  assert.equal(quoteJobNo, liveJob.jobNo);

  const model = buildQuoteMetricsReadModel(freshness, [
    quoteRow({
      id: 19,
      dateApproved: "2026-06-10",
      total: 1200,
      jobNo: quoteJobNo,
      linkedJobId: null,
      linkedMatch: false,
    }),
  ], undefined, {
    selectedMonth: "2026-06",
    now: new Date("2026-07-10T20:00:00Z"),
  });

  assert.equal(model.classificationRows[0]?.linkedJobId, null);
  assert.equal(model.classificationRows[0]?.outcome, "not_accepted");
});

test("monthly tier trends expose quote volume and Accepted/Not Accepted rates only", () => {
  const model = buildQuoteMetricsReadModel(freshness, [
    quoteRow({ id: 40, dateApproved: "2026-06-01", total: 500, status: "  qUoTe AcCePtEd OnLiNe  " }),
    quoteRow({ id: 41, dateApproved: "2026-06-02", total: 600 }),
    quoteRow({ id: 42, dateApproved: "2026-06-03", total: 1000, linkedMatch: true, linkedJobId: 9042 }),
    quoteRow({ id: 43, dateApproved: "2026-06-04", total: 5000 }),
    quoteRow({ id: 44, dateApproved: "2026-06-05", total: 15_000, status: "Quote Accepted Online" }),
  ], undefined, {
    selectedMonth: "2026-06",
    now: new Date("2026-07-10T20:00:00Z"),
  });

  const june = model.monthlyTierTrends.find((month) => month.monthKey === "2026-06")!;
  assert.deepEqual(june.byTier, {
    "Under $750": { quoteCount: 2, acceptedCount: 1, notAcceptedCount: 1, acceptanceRateCount: 50 },
    "$750-$2K": { quoteCount: 1, acceptedCount: 1, notAcceptedCount: 0, acceptanceRateCount: 100 },
    "$2K-$10K": { quoteCount: 1, acceptedCount: 0, notAcceptedCount: 1, acceptanceRateCount: 0 },
    "$10K+": { quoteCount: 1, acceptedCount: 1, notAcceptedCount: 0, acceptanceRateCount: 100 },
  });
  assert.equal("open" in june.byTier["Under $750"], false);
  assert.equal("unknown" in june.byTier["Under $750"], false);
  assert.equal("salesperson" in june, false);
});

test("partial current month uses DateApproved same-day cohorts and stable trailing excludes it", () => {
  const model = buildQuoteMetricsReadModel(freshness, [
    quoteRow({ id: 30, dateApproved: "2026-07-05", total: 100, status: "Quote Accepted Online" }),
    quoteRow({ id: 31, dateApproved: "2026-07-08", total: 200 }),
    quoteRow({ id: 32, dateApproved: "2026-07-20", total: 900, linkedMatch: true, linkedJobId: 9032 }),
    quoteRow({ id: 33, dateApproved: "2026-06-08", total: 500, linkedMatch: true, linkedJobId: 9033 }),
    quoteRow({ id: 34, dateApproved: "2025-07-05", total: 80, status: "Quote Accepted Online" }),
    quoteRow({ id: 35, dateApproved: "2025-07-20", total: 500 }),
  ], undefined, { selectedMonth: "2026-07", now: new Date("2026-07-09T20:00:00Z") });

  assert.equal(model.provisional.isCurrentMonthPartial, true);
  assert.equal(model.currentMonth?.quoteCount, 2);
  assert.equal(model.priorYearSameDay?.quoteCount, 1);
  assert.equal(model.priorYearSameMonth?.quoteCount, 2);
  assert.equal(model.yoyRows.find((row) => row.label === "Quotes")?.changePercent, 100);
  assert.equal(model.trailingWindow.endMonth, "2026-06");
  assert.equal(model.trailingKpis.find((kpi) => kpi.key === "quoteCount")?.value, 3);
});

test("filters and pagination use acceptance dimensions without salesperson or open state", () => {
  const rows = [
    ...Array.from({ length: 60 }, (_, index) => quoteRow({
      id: 100 + index,
      dateApproved: `2026-06-${String(index % 28 + 1).padStart(2, "0")}`,
      total: index + 1,
      linkedMatch: true,
      linkedJobId: 10_000 + index,
      category: "HVAC",
    })),
    quoteRow({ id: 999, dateApproved: "2026-06-15", total: 10_000, category: "Water Heating" }),
  ];
  const model = buildQuoteMetricsReadModel(freshness, rows, undefined, {
    selectedMonth: "2026-06",
    now: new Date("2026-07-10T20:00:00Z"),
    category: "HVAC",
    tier: "Under $750",
    outcome: "accepted",
    acceptancePath: "converted_only",
    sort: "value-desc",
    page: 2,
  });

  assert.equal(model.currentMonth?.quoteCount, 60);
  assert.equal(model.currentMonth?.acceptedCount, 60);
  assert.equal(model.pagination.classificationTotal, 60);
  assert.equal(model.pagination.classificationPages, 2);
  assert.deepEqual(model.classificationRows.map((row) => row.value), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal("salesperson" in model.filters, false);
  assert.equal("stage" in model.filters, false);
  assert.equal("stages" in model.filterOptions, false);
  assert.equal("stage" in model.classificationRows[0]!, false);
  assert.equal("customerStage" in model.classificationRows[0]!, false);
  assert.deepEqual(model.filterOptions.outcomes, ["accepted", "not_accepted", "excluded"]);
  assert.equal(model.filters.acceptancePath, "converted_only");
});

test("dashboard source query loads customer/site identity and DateIssued-only records", async () => {
  let capturedSql = "";
  await loadQuoteDashboardRows(async <T>(sql: string) => {
    capturedSql = sql;
    return { rows: [] as T[] };
  });

  assert.match(capturedSql, /nullif\(btrim\(q\.customer_name\), ''\) as customer_name/);
  assert.match(capturedSql, /q\.site_id::text as site_id/);
  assert.match(capturedSql, /nullif\(btrim\(q\.site_name\), ''\) as site_name/);
  assert.match(capturedSql, /q\.date_approved is null and q\.date_issued >= date '2023-01-01'/);
});

test("follow-up queue source query stays on normalized quote/job tables", async () => {
  let capturedSql = "";
  await getQuoteFollowUpQueue("2026-06", {
    now: new Date("2026-07-10T20:00:00Z"),
    query: async <T>(sql: string) => {
      capturedSql = sql;
      return { rows: [] as T[] };
    },
  });

  assert.match(capturedSql, /from metrics\.metrics_quotes q/);
  assert.match(capturedSql, /nullif\(btrim\(q\.customer_name\), ''\) as customer_name/);
  assert.match(capturedSql, /nullif\(btrim\(q\.site_name\), ''\) as site_name/);
  assert.match(capturedSql, /from metrics\.metrics_jobs j/);
  assert.doesNotMatch(capturedSql, /raw_simpro_snapshots/);
  assert.doesNotMatch(capturedSql, /quote_identity/);
});

test("sent-basis monthly series counts by DateIssued alongside the DateApproved acceptance basis", () => {
  const model = buildQuoteMetricsReadModel(freshness, [
    quoteRow({ id: 70, dateApproved: "2026-06-05", dateIssued: "2026-06-03", total: 100 }),
    quoteRow({ id: 71, dateApproved: "2026-06-20", dateIssued: "2026-05-28", total: 200 }),
    quoteRow({ id: 72, dateApproved: null, dateIssued: "2026-06-10", total: 400 }),
    quoteRow({ id: 73, dateApproved: "2026-06-08", dateIssued: "2026-06-08", total: 800, overrideOutcome: "excluded" }),
    quoteRow({ id: 74, dateApproved: "2026-06-09", dateIssued: null, total: 1600 }),
  ], undefined, { selectedMonth: "2026-06", now: new Date("2026-07-10T20:00:00Z") });

  assert.equal(model.sentBasis, "DateIssued");
  const june = model.sentMonthly.find((month) => month.month === "2026-06");
  const may = model.sentMonthly.find((month) => month.month === "2026-05");
  assert.equal(june?.sentCount, 2, "DateIssued in June: quote 70 and the never-approved quote 72; excluded quote 73 stays out");
  assert.equal(june?.sentValue, 500);
  assert.equal(may?.sentCount, 1);
  assert.equal(may?.sentValue, 200);
  // The acceptance basis is untouched: quote 72 (no DateApproved) is outside monthly activity.
  assert.equal(model.currentMonth?.quoteCount, 3);
});

test("follow-up queue lists the not-accepted cohort oldest-first with customer rollup", () => {
  const model = buildQuoteMetricsReadModel(freshness, [
    quoteRow({ id: 80, dateApproved: "2026-06-01", total: 5000, customer: "Island Club", siteName: "Island Club" }),
    quoteRow({ id: 81, dateApproved: "2026-06-15", total: 700, customer: "Island Club", siteName: "Island Club" }),
    quoteRow({ id: 82, dateApproved: "2026-06-10", total: 900, customer: "Vive Luxe", siteName: "Vive Luxe" }),
    quoteRow({ id: 83, dateApproved: "2026-06-12", total: 40_000, status: "Quote Accepted Online" }),
    quoteRow({ id: 84, dateApproved: "2026-06-05", total: 800, overrideOutcome: "excluded" }),
  ], undefined, { selectedMonth: "2026-06", now: new Date("2026-07-15T20:00:00Z") });

  const queue = model.followUpQueue;
  assert.equal(queue.totalCount, 3, "accepted and excluded quotes never enter the queue");
  assert.equal(queue.totalValue, 6600);
  assert.deepEqual(queue.rows.map((row) => row.quoteId), [80, 82, 81], "oldest DateApproved first");
  assert.equal(queue.rows[0]?.ageDays, 44);
  assert.equal(queue.rows[0]?.sentDate, "2026-06-01");
  assert.equal(queue.rows[0]?.customer, "Island Club");
  assert.equal(queue.rows[0]?.site, "Island Club");
  assert.equal(queue.rows[0]?.status, "Other status");
  assert.equal(queue.asOf, "2026-07-15");
  assert.match(queue.scope, /2026-06 cohort/);
  assert.match(queue.scope, /DateApproved/);

  assert.deepEqual(queue.byCustomer.map((row) => row.customer), ["Island Club", "Vive Luxe"]);
  assert.equal(queue.byCustomer[0]?.count, 2);
  assert.equal(queue.byCustomer[0]?.totalValue, 5700);
  assert.equal(queue.byCustomer[0]?.oldestAgeDays, 44);
  assert.equal(queue.byCustomer[0]?.newestAgeDays, 30);
});

test("missing customer and site identity stays honest instead of fabricated", () => {
  const model = buildQuoteMetricsReadModel(freshness, [
    quoteRow({ id: 90, dateApproved: "2026-06-02", total: 100, customer: null, siteName: null }),
  ], undefined, { selectedMonth: "2026-06", now: new Date("2026-07-10T20:00:00Z") });

  assert.equal(model.followUpQueue.rows[0]?.customer, "Customer unavailable");
  assert.equal(model.followUpQueue.rows[0]?.site, "Site unavailable");
});

function quoteRow({
  id,
  dateApproved,
  dateIssued = "2026-01-01",
  total,
  status = "Other status",
  category = "HVAC",
  customer = null,
  siteName = null,
  jobNo = null,
  linkedJobId = null,
  linkedMatch = false,
  inverseMatch = false,
  canonicalOutcome = "lost",
  overrideOutcome = null,
}: {
  id: number;
  dateApproved: string | null;
  dateIssued?: string | null;
  total: number;
  status?: string;
  category?: string | null;
  customer?: string | null;
  siteName?: string | null;
  jobNo?: string | null;
  linkedJobId?: number | null;
  linkedMatch?: boolean;
  inverseMatch?: boolean;
  canonicalOutcome?: string;
  overrideOutcome?: string | null;
}): QuoteCanonicalRow {
  return {
    quote_id: id,
    quote_no: `Q${id}`,
    name: `Quote ${id}`,
    status_name: status,
    linked_job_id: linkedJobId,
    job_no: jobNo,
    linked_job_match: linkedMatch,
    inverse_conversion_match: inverseMatch,
    date_issued: dateIssued,
    date_approved: dateApproved,
    customer_name: customer,
    site_id: siteName ? id + 7000 : null,
    site_name: siteName,
    total_value: total,
    deal_tier: null,
    category,
    category_basis: "cost-center rule",
    outcome: canonicalOutcome,
    outcome_reason: "legacy persisted value",
    updated_at: "2026-07-09T12:00:00Z",
    override_id: overrideOutcome ? id + 5000 : null,
    override_outcome: overrideOutcome,
    legacy_won_override: overrideOutcome === "won" ? true : null,
    override_reason: overrideOutcome ? "Audited legacy request" : null,
    override_evidence_url: null,
    override_actor_email: overrideOutcome ? "operator@example.test" : null,
    override_revision: overrideOutcome ? 1 : null,
    override_created_at: overrideOutcome ? "2026-07-08T12:00:00Z" : null,
  };
}

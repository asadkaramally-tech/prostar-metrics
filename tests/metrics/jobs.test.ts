import assert from "node:assert/strict";
import test from "node:test";
import {
  buildJobMetricsDashboard,
  buildJobMonthlyReadModel,
  calculateLaborAccuracy,
  classifyLoss,
  DIAGNOSTIC_FEE_MAX_SELL,
  grossMarginPercent,
  isCompletedJobStage,
  JOB_ANALYTICS_FIELDS,
  type NormalizedJobSnapshot,
} from "../../src/lib/metrics/jobs";

test("calculateLaborAccuracy reports job variance and rejects unsupported denominators", () => {
  assert.deepEqual(calculateLaborAccuracy({ quotedHours: 10, actualHours: 12 }), {
    included: true,
    coverageReason: "quoted and actual hours present",
    varianceHours: 2,
    variancePercent: 20,
  });
  assert.equal(calculateLaborAccuracy({ quotedHours: null, actualHours: 5 }).coverageReason, "missing quoted hours");
  assert.equal(calculateLaborAccuracy({ quotedHours: 0, actualHours: 5 }).coverageReason, "quoted hours are not positive");
  assert.equal(calculateLaborAccuracy({ quotedHours: 4, actualHours: null }).coverageReason, "missing actual timesheet hours");
});

test("grossMarginPercent keeps zero denominators unavailable", () => {
  assert.equal(grossMarginPercent(0, 10), null);
  assert.equal(grossMarginPercent(200, 50), 25);
});

test("completion uses CompletedDate plus exact Complete/Archived Stage and never Status or Invoiced", () => {
  assert.equal(isCompletedJobStage(" Complete "), true);
  assert.equal(isCompletedJobStage("ARCHIVED"), true);
  assert.equal(isCompletedJobStage("Completed"), false);
  assert.equal(isCompletedJobStage("Invoiced"), false);

  const model = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({ jobId: 1, completedDate: "2026-06-02", stageName: "Complete", statusName: "Pending" }),
      job({ jobId: 2, completedDate: "2026-06-03", stageName: "Archived", statusName: "Cancelled" }),
      job({ jobId: 3, completedDate: "2026-06-04", stageName: "Invoiced", statusName: "Complete" }),
      job({ jobId: 4, completedDate: "2026-05-31", stageName: "Complete", statusName: "Complete" }),
    ],
  });

  assert.equal(model.completedJobCount, 2);
  assert.deepEqual(model.stageCounts, { Complete: 1, Archived: 1 });
  assert.deepEqual(model.records.map((row) => row.jobId), ["2", "1"]);
});

test("job drilldowns strip Simpro HTML instead of exposing markup", () => {
  const model = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [job({
      jobId: 5,
      name: "<div><strong>Boiler &amp; Tank Repair</strong></div>",
      description: "<div>Replace valve<br />Return to service&nbsp;today</div>",
    })],
  });
  assert.equal(model.records[0]?.name, "Boiler & Tank Repair");
  assert.equal(model.records[0]?.description, "Replace valve Return to service today");
});

test("financial margin and labor variance use covered aggregate numerators and denominators", () => {
  const model = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({
        jobId: 1,
        sellValue: 1000,
        grossProfitActual: 250,
        convertedFromType: "Quote",
        convertedFromId: 10,
        quotedHours: 5,
        actualHours: 6,
        quoteLabor: quoteLabor(5),
        timesheets: timesheets(6),
      }),
      job({
        jobId: 2,
        sellValue: 500,
        grossProfitActual: null,
        convertedFromType: "Quote",
        convertedFromId: 11,
        quotedHours: 10,
        actualHours: 5,
        quoteLabor: quoteLabor(10),
        timesheets: timesheets(5),
      }),
      job({
        jobId: 3,
        sellValue: 250,
        grossProfitActual: 50,
        convertedFromType: null,
        convertedFromId: null,
        quotedHours: 3,
        actualHours: 9,
        timesheets: timesheets(9),
      }),
    ],
  });

  assert.equal(model.totalSellValue, 1750);
  assert.equal(model.averageJobValue, 1750 / 3);
  assert.equal(model.grossProfitActual, 300);
  assert.equal(model.grossMarginActual, 24, "covered gross profit 300 / covered sell 1250");
  assert.equal(model.financialCoverage.grossMarginIncludedJobs, 2);
  assert.equal(model.labor.eligibleQuoteSourcedJobs, 2);
  assert.equal(model.labor.includedJobs, 2);
  assert.equal(model.labor.quotedHours, 15);
  assert.equal(model.labor.actualHours, 11);
  assert.equal(round(model.labor.variancePercent), round(-4 / 15 * 100));
  assert.equal(model.labor.laborOverrunHours, 1);
});

test("category and cost-center metrics retain real values, non-additive counts, primary counts, and Unallocated", () => {
  const model = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({
        jobId: 10,
        sellValue: 1000,
        grossProfitActual: 300,
        convertedFromType: "Quote",
        convertedFromId: 8,
        actualHours: 8,
        quoteLabor: quoteLabor(4),
        timesheets: timesheets(8),
        costCenters: [
          costCenter({ id: 1, name: "HVAC Service", category: "HVAC", sellValue: 600, grossProfitActual: 180, quotedHours: 3 }),
          costCenter({ id: 2, name: "Water Heaters", category: "Water Heating", sellValue: 300, grossProfitActual: 60, quotedHours: 1 }),
        ],
      }),
      job({
        jobId: 11,
        sellValue: 200,
        costCenters: [costCenter({ id: 3, name: "HVAC Service", category: "HVAC", sellValue: 200, grossProfitActual: 40, quotedHours: 2 })],
      }),
    ],
  });
  const categories = Object.fromEntries(model.categoryRows.map((row) => [row.label, row]));

  assert.equal(categories.HVAC.sellValue, 800);
  assert.equal(categories.HVAC.grossProfit, 220);
  assert.equal(categories.HVAC.distinctJobCount, 2);
  assert.equal(categories.HVAC.primaryJobCount, 2);
  assert.equal(categories.HVAC.actualHours, 6);
  assert.equal(round(categories.HVAC.grossMargin), 27.5, "category margin is weighted gross profit / covered sell");
  assert.equal(categories["Water Heating"].sellValue, 300);
  assert.equal(categories["Water Heating"].actualHours, 2);
  assert.equal(categories.Unallocated.sellValue, 100);
  const hvacCostCenter = model.costCenterRows.find((row) => row.label === "HVAC Service");
  assert.equal(hvacCostCenter?.sellValue, 800);
  assert.equal(round(hvacCostCenter?.grossMargin ?? null), 27.5);
  assert.equal(model.costCenterRows.find((row) => row.label === "Unallocated")?.sellValue, 100);
  assert.equal(model.categoryRows.reduce((sum, row) => sum + row.sellValue, 0), model.totalSellValue);
  assert.equal(model.costCenterRows.reduce((sum, row) => sum + row.sellValue, 0), model.totalSellValue);
});

test("quoted-vs-actual labor exposes every exclusion reason and all-timesheet coverage", () => {
  const model = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({ jobId: 1, sourceQuoteId: 100, quotedHours: 99, actualHours: 3, timesheets: timesheets(3) }),
      job({ jobId: 2, sourceQuoteId: 101, quotedHours: 99, actualHours: 3, quoteLabor: quoteLabor(0), timesheets: timesheets(3) }),
      job({ jobId: 3, sourceQuoteId: 102, quotedHours: 99, actualHours: 99, quoteLabor: quoteLabor(4) }),
      job({
        jobId: 4,
        sourceQuoteId: 103,
        quotedHours: 99,
        actualHours: 99,
        quoteLabor: quoteLabor(4),
        timesheets: [
          { timesheetId: "old", employeeId: 7, technicianName: "Alex", workDate: "2026-05-20", actualHours: 2 },
          { timesheetId: "new", employeeId: 7, technicianName: "Alex", workDate: "2026-07-02", actualHours: 3 },
        ],
      }),
    ],
  });

  assert.equal(model.labor.eligibleQuoteSourcedJobs, 4);
  assert.equal(model.labor.jobsWithQuotedHours, 3);
  assert.equal(model.labor.jobsWithActualHours, 3);
  assert.equal(model.labor.missingQuotedHours, 1);
  assert.equal(model.labor.nonPositiveQuotedHours, 1);
  assert.equal(model.labor.missingActualHours, 1);
  assert.equal(model.labor.includedJobs, 1);
  assert.equal(model.labor.actualHours, 5, "all timesheets linked to the completed job are included");
  assert.equal(model.labor.nestedQuoteLaborCoveredJobs, 3);
  assert.equal(model.labor.allJobTimesheetsCoveredJobs, 3);
  assert.equal(model.labor.exclusionReasons["missing active nested quote labor"], 1);
  assert.equal(model.labor.exclusionReasons["quoted hours are not positive"], 1);
  assert.equal(model.labor.exclusionReasons["missing active job timesheets"], 1);
});

test("canonical labor fields cannot override linked nested quote labor or all active job timesheets", () => {
  const model = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({
        jobId: 20,
        sourceQuoteId: 200,
        quotedHours: 999,
        laborHoursEstimate: 888,
        actualHours: 777,
        laborHoursActual: 666,
        quoteLabor: [
          { laborId: "active-a", quotedHours: 2 },
          { laborId: "active-b", quotedHours: 3 },
          { laborId: "deleted", quotedHours: 100, sourceDeletedAt: "2026-06-20T00:00:00Z" },
        ],
        timesheets: [
          { timesheetId: "may", workDate: "2026-05-31", actualHours: 2 },
          { timesheetId: "july", workDate: "2026-07-01", actualHours: 4 },
          { timesheetId: "deleted", workDate: "2026-06-10", actualHours: 100, sourceDeletedAt: "2026-06-20T00:00:00Z" },
        ],
      }),
      job({
        jobId: 21,
        sourceQuoteId: 201,
        quotedHours: 12,
        actualHours: 12,
        quoteLabor: [{ laborId: "deleted", quotedHours: 12, sourceDeletedAt: "2026-06-20T00:00:00Z" }],
        timesheets: timesheets(12),
      }),
      job({
        jobId: 22,
        sourceQuoteId: 202,
        quotedHours: 8,
        actualHours: 8,
        quoteLabor: quoteLabor(8),
        timesheets: [{ timesheetId: "deleted", actualHours: 8, sourceDeletedAt: "2026-06-20T00:00:00Z" }],
      }),
    ],
  });

  assert.equal(model.labor.includedJobs, 1);
  assert.equal(model.labor.quotedHours, 5);
  assert.equal(model.labor.actualHours, 6);
  assert.equal(model.labor.varianceHours, 1);
  assert.equal(model.records.find((row) => row.jobId === "20")?.laborCoverage, "quoted and actual hours present");
  assert.equal(model.records.find((row) => row.jobId === "21")?.laborCoverage, "missing active nested quote labor");
  assert.equal(model.records.find((row) => row.jobId === "22")?.laborCoverage, "missing active job timesheets");
});

test("missing linked quotes and invalid authoritative rows are explicit labor exclusions", () => {
  const model = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({ jobId: 23, jobSourceType: "Quote", quotedHours: 5, actualHours: 5, quoteLabor: quoteLabor(5), timesheets: timesheets(5) }),
      job({ jobId: 24, sourceQuoteId: 204, quoteLabor: [{ laborId: "bad", quotedHours: null }], timesheets: timesheets(5) }),
      job({ jobId: 25, sourceQuoteId: 205, quoteLabor: quoteLabor(5), timesheets: [{ timesheetId: "bad", actualHours: null }] }),
    ],
  });

  assert.equal(model.labor.includedJobs, 0);
  assert.equal(model.labor.exclusionReasons["missing linked quote"], 1);
  assert.equal(model.labor.exclusionReasons["invalid nested quote labor hours"], 1);
  assert.equal(model.labor.exclusionReasons["invalid job timesheet hours"], 1);
});

test("dashboard provides selected, prior, same-day prior-year, pace, and stable trailing comparisons", () => {
  const jobs: NormalizedJobSnapshot[] = [
    job({ jobId: 30, completedDate: "2026-07-05", sellValue: 100 }),
    job({ jobId: 31, completedDate: "2026-07-20", sellValue: 900 }),
    job({ jobId: 32, completedDate: "2026-06-08", sellValue: 200 }),
    job({ jobId: 33, completedDate: "2025-07-05", sellValue: 80 }),
    job({ jobId: 34, completedDate: "2025-07-20", sellValue: 500 }),
  ];
  const model = buildJobMetricsDashboard({
    jobs,
    selectedMonth: "2026-07",
    now: new Date("2026-07-09T20:00:00Z"),
  });

  assert.equal(model.selected.periodEnd, "2026-07-09");
  assert.equal(model.selected.completedJobCount, 1);
  assert.equal(model.priorMonth.completedJobCount, 1);
  assert.equal(model.priorYearSameDay.completedJobCount, 1);
  assert.equal(model.priorYearFull.completedJobCount, 2);
  assert.equal(round(model.provisional.pace.completedJobs), round(31 / 9));
  assert.equal(model.trailingWindow.endMonth, "2026-06");
  assert.equal(model.trailing.completedJobs, 3, "stable trailing 12 includes July 2025 through June 2026 and excludes July 2026");
});

test("every multi-month trend row carries count, financial, margin, and labor keys", () => {
  const model = buildJobMetricsDashboard({
    jobs: [job({
      jobId: 35,
      completedDate: "2026-06-10",
      sellValue: 500,
      grossProfitActual: 200,
      netProfitActual: 100,
      sourceQuoteId: 350,
      quoteLabor: quoteLabor(4),
      timesheets: timesheets(5),
    })],
    selectedMonth: "2026-06",
    now: new Date("2026-07-09T20:00:00Z"),
  });
  const required = [
    "completedJobs", "sellValue", "grossProfit", "netProfit", "grossMargin", "netMargin",
    "quotedHours", "actualHours", "laborVarianceHours", "laborVariancePercent",
  ];
  for (const row of model.trends) {
    for (const key of required) assert.ok(Object.hasOwn(row, key), `${row.month} is missing ${key}`);
  }
  const june = model.trends.find((row) => row.month === "2026-06");
  assert.equal(june?.laborVarianceHours, 1);
  assert.equal(june?.laborVariancePercent, 25);
});

test("category, cost-center, and supported technician filters recompute every dashboard surface", () => {
  const jobs = [
    job({
      jobId: 40,
      costCenters: [costCenter({ id: 1, name: "HVAC Service", category: "HVAC", sellValue: 100 })],
      timesheets: [{ timesheetId: "a", employeeId: 1, technicianName: "Alex", actualHours: 2 }],
    }),
    job({
      jobId: 41,
      costCenters: [costCenter({ id: 2, name: "Water Heaters", category: "Water Heating", sellValue: 100 })],
      timesheets: [{ timesheetId: "b", employeeId: 2, technicianName: "Pat", actualHours: 2 }],
    }),
  ];
  const model = buildJobMetricsDashboard({
    jobs,
    selectedMonth: "2026-06",
    filters: { category: "HVAC", costCenter: "HVAC Service", technician: "Alex" },
    now: new Date("2026-07-09T20:00:00Z"),
  });

  assert.equal(model.selected.completedJobCount, 1);
  assert.equal(model.selected.records[0]?.jobId, "40");
  assert.deepEqual(model.filterOptions.categories, ["HVAC", "Water Heating"]);
  assert.deepEqual(model.filterOptions.technicians, ["Alex", "Pat"]);
});

test("net profit, cost variance, work source, and owner profitability analytics use persisted Simpro fields", () => {
  const model = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({
        jobId: 60,
        sellValue: 1000,
        grossProfitActual: 400,
        netProfitActual: 250,
        netMarginActual: 25,
        materialsCostActual: 220,
        materialsCostEstimate: 200,
        laborCostActual: 180,
        laborCostEstimate: 150,
        laborHoursActual: 10,
        laborHoursEstimate: 8,
        sourceQuoteId: 900,
        quoteLabor: quoteLabor(8),
        timesheets: timesheets(10),
        overheadCostActual: 150,
        overheadCostEstimate: 140,
        totalResourceCostActual: 750,
        totalResourceCostEstimate: 700,
        commissionCostActual: 0,
        jobSourceType: "Quote",
        jobSourceId: 900,
        customerName: "Alpha Property",
        siteName: "Alpha Tower",
        costCenters: [{
          ...costCenter({ id: 1, name: "Service instance", category: "HVAC", sellValue: 1000, grossProfitActual: 400, quotedHours: 8 }),
          configuredCostCenterName: "HVAC Service",
          netProfitActual: 250,
        }],
      }),
      job({
        jobId: 61,
        sellValue: 500,
        grossProfitActual: 150,
        netProfitActual: 100,
        netMarginActual: 20,
        materialsCostActual: 80,
        materialsCostEstimate: 90,
        laborCostActual: 120,
        laborCostEstimate: 100,
        laborHoursActual: 5,
        laborHoursEstimate: 5,
        timesheets: timesheets(5),
        overheadCostActual: 200,
        overheadCostEstimate: 180,
        totalResourceCostActual: 400,
        totalResourceCostEstimate: 370,
        commissionCostActual: 0,
        jobSourceType: "Recurring Job",
        jobSourceId: 901,
        customerName: "Beta Holdings",
        siteName: "Beta Plant",
      }),
    ],
  });

  assert.equal(model.netProfitActual, 350);
  assert.equal(round(model.netMarginActual), round(350 / 1500 * 100));
  assert.equal(model.costVariance.materialsActual, 300);
  assert.equal(model.costVariance.materialsEstimate, 290);
  assert.equal(model.costVariance.totalActual, 1150);
  assert.equal(model.costVariance.totalEstimate, 1070);
  assert.equal(model.profitPerHourCoveredJobs, 2);
  assert.equal(model.netProfitPerActualHour, 350 / 15);

  const quote = model.jobSourceRows.find((row) => row.sourceType === "Quote-generated");
  const recurring = model.jobSourceRows.find((row) => row.sourceType === "Recurring");
  assert.equal(quote?.netProfit, 250);
  assert.equal(quote?.laborVariancePercent, 25);
  assert.equal(recurring?.netMargin, 20);
  assert.equal(recurring?.laborVariancePercent, 0);
  assert.equal(model.customerRows[0]?.label, "Alpha Property");
  assert.equal(model.siteRows[0]?.label, "Alpha Tower");
  assert.equal(model.costCenterRows[0]?.label, "HVAC Service");
  assert.equal(model.records[0]?.commissionCostActual, 0);
});

test("migration-026 formulas use paired costs, aggregate margins, and explicit null coverage", () => {
  const model = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({
        jobId: 70,
        sellValue: 100,
        netProfitActual: 50,
        netMarginActual: 50,
        materialsCostActual: 30,
        materialsCostEstimate: 20,
        laborCostActual: 10,
        laborCostEstimate: 8,
        laborHoursActual: 4,
        laborHoursEstimate: 2,
        overheadCostActual: 5,
        overheadCostEstimate: 4,
        totalResourceCostActual: 50,
        totalResourceCostEstimate: 40,
        commissionCostActual: 0,
        jobSourceType: "Quote",
        jobSourceId: 700,
        customerName: "Customer A",
        siteName: "Building A",
        costCenters: [costCenter({ id: 1, name: "Instance A", configuredName: "Service", category: "HVAC", sellValue: 100 })],
      }),
      job({
        jobId: 71,
        sellValue: 900,
        netProfitActual: 45,
        netMarginActual: 5,
        materialsCostActual: 999,
        materialsCostEstimate: null,
        laborCostActual: null,
        laborCostEstimate: null,
        laborHoursActual: null,
        laborHoursEstimate: null,
        overheadCostActual: null,
        overheadCostEstimate: null,
        totalResourceCostActual: null,
        totalResourceCostEstimate: null,
        commissionCostActual: null,
        jobSourceType: null,
        jobSourceId: null,
        customerName: null,
        siteName: null,
        costCenters: [costCenter({ id: 2, name: "Instance B", configuredName: null, category: "", sellValue: 900 })],
      }),
    ],
  });

  assert.equal(model.netMarginActual, 9.5, "aggregate margin is 95 / 1000, never an average of 50% and 5%");
  assert.equal(model.costVariance.materialsActual, 30, "unpaired actual values stay outside actual-vs-estimate comparison");
  assert.equal(model.costVariance.materialsEstimate, 20);
  assert.equal(model.costVariance.materialsPairedJobs, 1);
  assert.equal(model.jobSourceRows.find((row) => row.sourceType === "Direct service")?.jobs, 1);
  assert.equal(model.netMarginDistribution.find((row) => row.label === "Unclassified")?.jobs, 0);
  assert.equal(model.fieldCoverage.commissionCostActual.supported, 1, "persisted zero is supported");
  assert.equal(model.fieldCoverage.jobSourceId.missing, 1);
  assert.equal(model.fieldCoverage.customerName.missing, 1);
  assert.equal(model.fieldCoverage.configuredCostCenterName.total, 2);
  assert.equal(model.fieldCoverage.configuredCostCenterName.missing, 1);
  assert.deepEqual(Object.keys(model.fieldCoverage).sort(), [...JOB_ANALYTICS_FIELDS].sort());
});

test("configured cost-center name is the only grouping key and instance name stays in drilldown", () => {
  const model = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [job({
      jobId: 72,
      costCenters: [
        costCenter({ id: 1, name: "Instance North", configuredName: "Commercial Service", category: "HVAC", sellValue: 60 }),
        costCenter({ id: 2, name: "Instance South", configuredName: "Commercial Service", category: "HVAC", sellValue: 40 }),
        costCenter({ id: 3, name: "Instance Missing", configuredName: null, category: "", sellValue: 0 }),
      ],
    })],
  });

  assert.deepEqual(model.costCenterRows.map((row) => row.label).sort(), ["Commercial Service", "Unclassified"]);
  assert.ok(!model.costCenterRows.some((row) => row.label.startsWith("Instance")));
  assert.deepEqual(model.records[0]?.costCenters.map((row) => row.instanceName), ["Instance North", "Instance South", "Instance Missing"]);
});

test("history carries 2023-current reconciliation states without claiming missing months matched", () => {
  const model = buildJobMetricsDashboard({
    jobs: [job({ jobId: 50, completedDate: "2023-01-10", sellValue: 100 })],
    selectedMonth: "2023-02",
    reconciliations: [{
      periodStart: "2023-01-01",
      status: "matched",
      sourceCount: 1,
      sourceValue: 100,
      rollupCount: 1,
      rollupValue: 100,
      checkedAt: "2023-03-01T00:00:00Z",
    }],
    now: new Date("2026-07-09T20:00:00Z"),
  });

  assert.equal(model.history.length, 2);
  assert.equal(model.history[0].reconciliation.status, "matched");
  assert.equal(model.history[1].reconciliation.status, "missing");
  assert.ok(model.warnings.some((warning) => warning.includes("1 history months")));
});

test("loss classification splits diagnostic-fee tickets from execution losses at the verified boundary", () => {
  assert.equal(DIAGNOSTIC_FEE_MAX_SELL, 59);
  assert.equal(classifyLoss(59, -100), "diagnostic_fee");
  assert.equal(classifyLoss(1, -100), "diagnostic_fee");
  assert.equal(classifyLoss(59.01, -100), "execution");
  assert.equal(classifyLoss(0, -100), "execution", "zero-sell losses are execution, not pricing policy");
  assert.equal(classifyLoss(null, -100), "execution");
  assert.equal(classifyLoss(59, 0), null);
  assert.equal(classifyLoss(59, 5), null);
  assert.equal(classifyLoss(59, null), null);

  const model = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({ jobId: 1, sellValue: 59, netProfitActual: -200 }),
      job({ jobId: 2, sellValue: 0, netProfitActual: -50 }),
      job({ jobId: 3, sellValue: 800, netProfitActual: -30 }),
      job({ jobId: 4, sellValue: 59, netProfitActual: 10 }),
    ],
  });
  assert.equal(model.lossBreakdown.lossJobs, 3);
  assert.equal(model.lossBreakdown.netTotal, -280);
  assert.deepEqual(model.lossBreakdown.diagnosticFee, { jobs: 1, netTotal: -200 });
  assert.deepEqual(model.lossBreakdown.execution, { jobs: 2, netTotal: -80 });
  assert.match(model.lossBreakdown.rule, /\$59/);
  assert.equal(model.lossRecords.length, 3);
  assert.equal(model.records.find((row) => row.jobId === "1")?.lossClass, "diagnostic_fee");
  assert.equal(model.records.find((row) => row.jobId === "2")?.lossClass, "execution");
  assert.equal(model.records.find((row) => row.jobId === "4")?.lossClass, null);
});

test("quote-linked labor efficiency includes recurring conversions and keeps work-source classification separate", () => {
  const model = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({ jobId: 1, jobSourceType: "Quote", jobSourceId: 100, sourceQuoteId: 100, laborHoursEstimate: 10, laborHoursActual: 12 }),
      job({ jobId: 2, jobSourceType: "Recurring", jobSourceId: 200, convertedFromType: "Recurring", convertedFromId: 200, laborHoursEstimate: 4, laborHoursActual: 3 }),
      job({ jobId: 3, jobSourceType: "Quote", jobSourceId: 300, sourceQuoteId: 300, laborHoursEstimate: null, laborHoursActual: 5 }),
      job({ jobId: 4, jobSourceType: "Direct service", laborHoursEstimate: 9, laborHoursActual: 9 }),
      job({ jobId: 5, jobSourceType: "Quote", jobSourceId: 500, sourceQuoteId: 500, laborHoursEstimate: 6, laborHoursActual: null }),
    ],
  });

  const labor = model.quoteLinkedLabor;
  assert.equal(labor.quoteLinkedJobs, 4, "direct-service jobs never enter the quote-linked cohort");
  assert.equal(labor.coveredJobs, 2);
  assert.equal(labor.actualOnlyJobs, 1);
  assert.equal(labor.estimatedHours, 14);
  assert.equal(labor.actualHours, 15);
  assert.equal(round(labor.efficiencyRatio), round(14 / 15));
  assert.equal(round(labor.overrunPercent), round(100 / 14));
  assert.deepEqual(labor.perJob.map((row) => row.jobId), ["1", "2"], "overruns sort first");
  assert.equal(labor.perJob[0]?.varianceHours, 2);
  assert.match(labor.definition, /recurring/i);

  const sources = Object.fromEntries(model.jobSourceRows.map((row) => [row.sourceType, row.jobs]));
  assert.deepEqual(sources, { "Quote-generated": 3, "Recurring": 1, "Direct service": 1 },
    "work-source Quote-generated still excludes recurring conversions");
});

test("direct-service follow-up linkage matches same-site quotes in the disclosed windows", () => {
  const model = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({ jobId: 1, completedDate: "2026-06-10", siteId: 11, jobSourceType: "Direct service" }),
      job({ jobId: 2, completedDate: "2026-06-10", siteId: 22, jobSourceType: "Direct service" }),
      job({ jobId: 3, completedDate: "2026-06-10", siteId: 33, jobSourceType: "Direct service" }),
      job({ jobId: 4, completedDate: "2026-06-10", siteId: 44, jobSourceType: "Direct service" }),
      job({ jobId: 5, completedDate: "2026-06-10", siteId: 11, jobSourceType: "Quote", jobSourceId: 900, sourceQuoteId: 900 }),
    ],
    issuedQuotes: [
      { quoteId: 501, dateIssued: "2026-06-10", siteId: 11, totalValue: 4000 },
      { quoteId: 502, dateIssued: "2026-07-05", siteId: 22, totalValue: 900 },
      { quoteId: 503, dateIssued: "2026-07-11", siteId: 33, totalValue: 700 },
      { quoteId: 504, dateIssued: "2026-06-09", siteId: 44, totalValue: 100 },
    ],
  });

  const followUps = model.directServiceFollowUps;
  assert.equal(followUps.directServiceJobs, 4, "quote-generated jobs stay out of the denominator");
  assert.equal(followUps.jobsWithSameDayQuote, 1);
  assert.equal(followUps.jobsWithQuoteWithin30Days, 2, "31 days out and issued-before-completion never match");
  assert.deepEqual(followUps.links.map((link) => [link.jobId, link.quoteId, link.daysAfterCompletion, link.sameDay]), [
    ["1", "501", 0, true],
    ["2", "502", 25, false],
  ]);
  assert.equal(followUps.links[0]?.quoteValue, 4000);
  assert.equal(followUps.quoteEvidenceLoaded, true);
  assert.match(followUps.linkRule, /30 days/);
  assert.match(followUps.sameDayRule, /completion day/);

  const withoutEvidence = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [job({ jobId: 1, completedDate: "2026-06-10", siteId: 11, jobSourceType: "Direct service" })],
  });
  assert.equal(withoutEvidence.directServiceFollowUps.quoteEvidenceLoaded, false,
    "a model built without any issued-quote input discloses that instead of claiming zero follow-ups");
  const withEmptyEvidence = buildJobMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [job({ jobId: 1, completedDate: "2026-06-10", siteId: 11, jobSourceType: "Direct service" })],
    issuedQuotes: [],
  });
  assert.equal(withEmptyEvidence.directServiceFollowUps.quoteEvidenceLoaded, true, "a genuinely empty quote set is loaded evidence");
});

test("monthly trend serves Jan 2025 through the selected month with avgJobValue and reconciliation provenance", () => {
  const model = buildJobMetricsDashboard({
    jobs: [
      job({ jobId: 60, completedDate: "2025-01-15", sellValue: 300 }),
      job({ jobId: 61, completedDate: "2026-06-10", sellValue: 500 }),
      job({ jobId: 62, completedDate: "2026-06-12", sellValue: 100 }),
    ],
    selectedMonth: "2026-07",
    reconciliations: [{
      periodStart: "2026-06-01",
      status: "matched",
      sourceCount: 2,
      sourceValue: 600,
      rollupCount: 2,
      rollupValue: 600,
      checkedAt: "2026-07-01T00:00:00Z",
    }, {
      periodStart: "2026-05-01",
      status: "mismatch",
      sourceCount: 1,
      sourceValue: 1,
      rollupCount: 0,
      rollupValue: 0,
      checkedAt: "2026-07-01T00:00:00Z",
    }],
    now: new Date("2026-07-09T20:00:00Z"),
  });

  assert.equal(model.trends[0]?.month, "2025-01", "the served window always reaches back to Jan 2025");
  assert.equal(model.trends.at(-1)?.month, "2026-07");
  assert.equal(model.trends.length, 19);
  const january = model.trends.find((row) => row.month === "2025-01");
  assert.equal(january?.avgJobValue, 300);
  const june = model.trends.find((row) => row.month === "2026-06");
  assert.equal(june?.avgJobValue, 300);
  assert.equal(june?.provenance, "verified");
  assert.equal(model.trends.find((row) => row.month === "2026-05")?.provenance, "representative", "mismatch never claims verified");
  assert.equal(model.trends.find((row) => row.month === "2025-01")?.provenance, "representative", "missing reconciliation is representative");
  assert.equal(model.trends.at(-1)?.provenance, "representative", "the provisional live month is never verified");

  const eighteen = buildJobMetricsDashboard({
    jobs: [job({ jobId: 63, completedDate: "2024-02-10", sellValue: 100 })],
    selectedMonth: "2024-06",
    now: new Date("2026-07-09T20:00:00Z"),
  });
  assert.equal(eighteen.trends[0]?.month, "2023-01", "older selections keep the trailing-18 window clamped to history");
  assert.equal(eighteen.trends.length, 18);
});

function job(overrides: Partial<NormalizedJobSnapshot> & { jobId: number }): NormalizedJobSnapshot {
  return {
    jobNo: `J${overrides.jobId}`,
    name: `Job ${overrides.jobId}`,
    completedDate: "2026-06-10",
    stageName: "Complete",
    statusName: "Workflow status",
    sellValue: 100,
    grossProfitActual: 20,
    materialCoverage: "nested_items_complete",
    costCenters: [],
    timesheets: [],
    ...overrides,
  };
}

function costCenter({
  id,
  name,
  category,
  sellValue,
  grossProfitActual = null,
  quotedHours = null,
  configuredName = name,
}: {
  id: number;
  name: string;
  category: string;
  sellValue: number;
  grossProfitActual?: number | null;
  quotedHours?: number | null;
  configuredName?: string | null;
}) {
  return {
    sectionId: 1,
    costCenterId: id,
    configuredCostCenterId: id + 100,
    configuredCostCenterName: configuredName,
    name,
    category,
    sellValue,
    grossProfitActual,
    quotedHours,
  };
}

function quoteLabor(...hours: number[]) {
  return hours.map((quotedHours, index) => ({ laborId: `quote-labor-${index + 1}`, quotedHours }));
}

function timesheets(...hours: number[]) {
  return hours.map((actualHours, index) => ({ timesheetId: `timesheet-${index + 1}`, actualHours }));
}

function round(value: number | null) {
  return value === null ? null : Math.round(value * 10_000) / 10_000;
}

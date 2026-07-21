import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildBridgeSteps,
  buildCompletedJobsCsv,
  fetchAllCompletedJobs,
  filterCompletedJobs,
  JobsDashboard,
  netMarginDisplay,
  nextTrendSelection,
  pageList,
  recurringLaborFacts,
  sortBySellValue,
  ticketArticle,
} from "../../src/components/jobs-dashboard";
import {
  buildJobMetricsDashboard,
  type IssuedQuoteInput,
  type JobReconciliationInput,
  type NormalizedJobSnapshot,
} from "../../src/lib/metrics/jobs";
import type { JobDashboardReadModel } from "../../src/lib/store/job-dashboard-read-model";

/* Fixture: a small June 2026 cohort with every approved surface exercised —
   quote-linked labor with overruns, a recurring plan visit plus a no-estimate
   exclusion, losses (reachable only via the completed-jobs table now),
   direct-service work, prior-month/prior-year months for the deltas, and a
   Dec ’25 high for the trend annotations. Every rendered number must flow
   from this payload. The composition under test is the owner-approved
   docs/approved-design/mockups/jobs.html. */

const JUNE_JOBS: NormalizedJobSnapshot[] = [
  {
    jobId: 101,
    jobNo: "16614",
    name: "Consolidated water heating system replacement",
    completedDate: "2026-06-05",
    stageName: "Complete",
    sellValue: 64419,
    grossProfitActual: 42186,
    netProfitActual: 35000,
    netMarginActual: (35000 / 64419) * 100,
    materialsCostActual: 12000,
    laborCostActual: 9000,
    overheadCostActual: 6000,
    laborHoursEstimate: 39,
    laborHoursActual: 52,
    jobSourceType: "Quote",
    sourceQuoteId: 901,
    customerName: "Holiday Inn Express",
    siteId: 11,
    siteName: "Holiday Inn Express #1955",
    costCenters: [
      { sectionId: 1, costCenterId: 1, configuredCostCenterName: "Water Heating", category: "Water Heating", sellValue: 64419 },
    ],
    quoteLabor: [{ laborId: "q901", quotedHours: 39 }],
    timesheets: [{ timesheetId: "t101", technicianName: "Rob Sires", actualHours: 52 }],
  },
  {
    jobId: 102,
    jobNo: "17066",
    name: "MH-10, MB-2",
    completedDate: "2026-06-08",
    stageName: "Complete",
    sellValue: 4856,
    grossProfitActual: 3813,
    netProfitActual: 2000,
    netMarginActual: (2000 / 4856) * 100,
    materialsCostActual: 500,
    laborCostActual: 400,
    overheadCostActual: 300,
    laborHoursEstimate: 8.75,
    laborHoursActual: 34.5,
    jobSourceType: "Quote",
    sourceQuoteId: 902,
    customerName: "St Andrews Gardens HOA",
    siteId: 12,
    siteName: "St Andrews Gardens",
    costCenters: [{ sectionId: 1, costCenterId: 2, configuredCostCenterName: "HVAC", category: "HVAC", sellValue: 4856 }],
    quoteLabor: [{ laborId: "q902", quotedHours: 8.75 }],
    timesheets: [{ timesheetId: "t102", technicianName: "Juan Serrato", actualHours: 34.5 }],
  },
  {
    jobId: 103,
    jobNo: "17142",
    name: "MB-5 · boiler service",
    completedDate: "2026-06-12",
    stageName: "Complete",
    sellValue: 305,
    grossProfitActual: 100,
    netProfitActual: -1000,
    netMarginActual: (-1000 / 305) * 100,
    materialsCostActual: 200,
    laborCostActual: 700,
    overheadCostActual: 405,
    laborHoursEstimate: 7,
    laborHoursActual: 7.25,
    jobSourceType: "Recurring",
    jobSourceId: 55,
    customerName: "Monterey Villas Maintenance Assoc.",
    siteId: 13,
    siteName: "Monterey Villas",
    timesheets: [{ timesheetId: "t103", technicianName: "Cole Bender", actualHours: 7.25 }],
  },
  {
    jobId: 104,
    jobNo: "17054",
    name: "MH-13 preventive care",
    completedDate: "2026-06-15",
    stageName: "Complete",
    sellValue: 2000,
    grossProfitActual: 900,
    netProfitActual: 500,
    netMarginActual: 25,
    materialsCostActual: 400,
    laborCostActual: 700,
    overheadCostActual: 400,
    laborHoursEstimate: null,
    laborHoursActual: 29.8,
    jobSourceType: "Recurring",
    jobSourceId: 56,
    customerName: "Kittridge I",
    siteId: 14,
    siteName: "Kittridge I",
    timesheets: [{ timesheetId: "t104", technicianName: "Jim Ochoa", actualHours: 29.8 }],
  },
  {
    jobId: 105,
    jobNo: "17102",
    name: "Expansion Tanks for recent Installs",
    completedDate: "2026-06-18",
    stageName: "Complete",
    sellValue: 59,
    grossProfitActual: -1500,
    netProfitActual: -2000,
    netMarginActual: (-2000 / 59) * 100,
    materialsCostActual: 800,
    laborCostActual: 500,
    overheadCostActual: 259,
    laborHoursActual: 13.5,
    customerName: "Creekwood at River Run",
    siteId: 15,
    siteName: "Creekwood at River Run",
    timesheets: [{ timesheetId: "t105", technicianName: "Jeffrey Perry", actualHours: 13.5 }],
  },
  {
    jobId: 106,
    jobNo: "17040",
    name: "Two boilers down",
    completedDate: "2026-06-10",
    stageName: "Complete",
    sellValue: 59,
    grossProfitActual: -500,
    netProfitActual: -800,
    netMarginActual: (-800 / 59) * 100,
    materialsCostActual: 300,
    laborCostActual: 300,
    overheadCostActual: 259,
    laborHoursActual: 5.5,
    customerName: "Vive Luxe",
    siteId: 16,
    siteName: "Vive Luxe",
    timesheets: [{ timesheetId: "t106", technicianName: "Rob Sires", actualHours: 5.5 }],
  },
  {
    jobId: 107,
    jobNo: "17143",
    name: "Apt #184: No A/C",
    completedDate: "2026-06-05",
    stageName: "Complete",
    sellValue: 500,
    grossProfitActual: 200,
    netProfitActual: 100,
    netMarginActual: 20,
    materialsCostActual: 200,
    laborCostActual: 100,
    overheadCostActual: 100,
    laborHoursActual: 5.25,
    customerName: "Island Club",
    siteId: 17,
    siteName: "Island Club",
    timesheets: [{ timesheetId: "t107", technicianName: "Jeffrey Perry", actualHours: 5.25 }],
  },
];

const CONTEXT_JOBS: NormalizedJobSnapshot[] = [
  { jobId: 201, jobNo: "J201", name: "Prior-year June job", completedDate: "2025-06-15", stageName: "Complete", sellValue: 10000, grossProfitActual: 7000, netProfitActual: 5000, netMarginActual: 50 },
  { jobId: 301, jobNo: "J301", name: "May job", completedDate: "2026-05-10", stageName: "Complete", sellValue: 20000, grossProfitActual: 12000, netProfitActual: 8000, netMarginActual: 40 },
  { jobId: 401, jobNo: "J401", name: "December record", completedDate: "2025-12-05", stageName: "Complete", sellValue: 60000, grossProfitActual: 55000, netProfitActual: 50000, netMarginActual: 83.3 },
];

const ISSUED_QUOTES: IssuedQuoteInput[] = [
  { quoteId: 9001, dateIssued: "2026-06-10", siteId: 16, siteName: "Vive Luxe", totalValue: 4200 },
  { quoteId: 9002, dateIssued: "2026-06-20", siteId: 17, siteName: "Island Club", totalValue: 8000 },
];

const RECONCILIATIONS: JobReconciliationInput[] = [
  { periodStart: "2025-06-01", status: "matched" },
  { periodStart: "2026-06-01", status: "matched" },
];

function buildModel(overrides: {
  jobs?: NormalizedJobSnapshot[];
  selectedMonth?: string;
  loadError?: string | null;
} = {}): JobDashboardReadModel {
  const dashboard = buildJobMetricsDashboard({
    jobs: overrides.jobs ?? [...JUNE_JOBS, ...CONTEXT_JOBS],
    selectedMonth: overrides.selectedMonth ?? "2026-06",
    reconciliations: RECONCILIATIONS,
    issuedQuotes: ISSUED_QUOTES,
    now: new Date("2026-07-12T12:00:00Z"),
  });
  const total = dashboard.selected.records.length;
  return {
    ...dashboard,
    freshness: {},
    loadError: overrides.loadError ?? null,
    drilldownPagination: { page: 1, pageSize: 50, total, totalPages: Math.max(1, Math.ceil(total / 50)) },
  } as unknown as JobDashboardReadModel;
}

function render(model: JobDashboardReadModel, showStates = false): string {
  return renderToStaticMarkup(createElement(JobsDashboard, { model, showStates }));
}

/* ── Row 1: KPI band ───────────────────────────────────── */

test("primary card leads with net profit, labeled pills, honest margin and one bullet bar", () => {
  const html = render(buildModel());
  assert.match(html, /class="kpi primary" href="#trend"/);
  // Headline: Σ NetProfit Actual = 35000+2000-1000+500-2000-800+100.
  assert.match(html, /<span class="val">\$33,800<\/span>/);
  assert.match(html, /46\.8% net margin/);
  assert.doesNotMatch(html, /target \(example\)/);
  // Labeled pills — every comparison named.
  assert.match(html, /↑ 576\.0% vs Jun ’25/);
  assert.match(html, /↑ 322\.5% vs May/);
  // Bullet: ticks keyed to prior year and prior month with honest windows.
  assert.match(html, /Jun ’25 · full <b>\$5\.0K<\/b>/);
  assert.match(html, /May ’26 · full <b>\$8\.0K<\/b>/);
});

test("first served month does not fabricate pre-history comparisons", () => {
  const html = render(buildModel({
    selectedMonth: "2023-01",
    jobs: [{
      jobId: 1,
      jobNo: "J1",
      name: "First served month",
      completedDate: "2023-01-15",
      stageName: "Complete",
      sellValue: 1000,
      grossProfitActual: 600,
      netProfitActual: 400,
      netMarginActual: 40,
    }],
  }));
  assert.match(html, /Jan ’22 · full <b>unavailable<\/b>/);
  assert.match(html, /Dec ’22 · full <b>unavailable<\/b>/);
  assert.doesNotMatch(html, /vs Jan ’22|vs Dec/);
});

test("tiles chain revenue − expenses = gross and gross − overhead = net, from the payload", () => {
  const html = render(buildModel());
  // GROSS PROFIT with margin sub and labeled pill.
  assert.match(html, /Gross profit/);
  assert.match(html, /<span class="val">\$45,199<\/span>/);
  assert.match(html, /62\.6% margin/);
  assert.match(html, /↑ 545\.7% vs Jun ’25/);
  // CALCULATED EXPENSES = materials + labor (largest-remainder split).
  assert.match(html, /Calculated expenses/);
  assert.match(html, /<span class="val">\$26,999<\/span>/);
  assert.match(html, /materials \$14,896 · labor \$12,103/);
  // CALCULATED OVERHEAD = gross − net, with the chain sub.
  assert.match(html, /Calculated overhead/);
  assert.match(html, /<span class="val">\$11,399<\/span>/);
  assert.match(html, /gross − overhead = net/);
  // REVENUE with jobs count + avg sub.
  assert.match(html, /<span class="val">\$72,198<\/span>/);
  assert.match(html, /↑ 622\.0% vs Jun ’25/);
  assert.match(html, /7 completed jobs · avg \$10,314/);
  // Band footnote states the windows and the chain.
  assert.match(html, /All vs-comparisons are full-month\. The tiles chain: revenue − expenses = gross · gross − overhead = net\./);
});

/* ── Row 2: Monthly Trend (stacked single-axis panels) ─── */

test("trend card renders all eight chips, stacked $ and margin panels, and honest annotations", () => {
  const html = render(buildModel());
  for (const chip of [
    "Revenue",
    "Gross profit",
    "Net profit",
    "Avg job value",
    "Gross margin %",
    "Net margin %",
    "Completed jobs",
    "Net ’25 vs ’26",
  ]) {
    assert.ok(html.includes(chip), `missing metric chip ${chip}`);
  }
  assert.match(html, /Jan ’25 – Jun ’26 · pick up to four metrics/);
  // Net margin % chip carries the validated --series-2 color.
  assert.match(html, /style="--c:#0e9aae"/);
  // Stacked panels: the margin strip announces its own axis under the $ panel.
  assert.match(html, /class="striphead"/);
  assert.match(html, /Net margin %<\/span>/);
  assert.match(html, /own axis — mixed-unit picks always split into stacked panels, never share a \$ axis/);
  // Annotations from the payload: Dec ’25 high, Jun ’25 slowdown, current month.
  assert.match(html, /Dec ’25 · \$50K/);
  assert.match(html, /Jun · \$34K net/);
  // Prior-year net reference (label truncates at the em dash on narrow SSR width).
  assert.match(html, /Jun ’25 · \$5,000/);
  // Provenance footnote survives.
  assert.match(html, /Profit and margin series are <span class="repr">representative<\/span> pending Simpro verification/);
  assert.match(html, /Simpro-verified for all 18 months/);
});

test("metric-picker semantics: yoy exclusive, minimum one, mixed units allowed, cap four", () => {
  assert.deepEqual(nextTrendSelection(["np", "nm"], "yoy"), ["yoy"]);
  assert.deepEqual(nextTrendSelection(["yoy"], "yoy"), ["np", "nm"]);
  assert.deepEqual(nextTrendSelection(["yoy"], "rev"), ["rev"]);
  assert.deepEqual(nextTrendSelection(["np"], "np"), ["np"]);
  assert.deepEqual(nextTrendSelection(["np", "nm"], "nm"), ["np"]);
  // Mixed units are allowed — they render as stacked single-axis panels.
  assert.deepEqual(nextTrendSelection(["np", "nm"], "jobs"), ["np", "nm", "jobs"]);
  // Cap at four via shift.
  assert.deepEqual(nextTrendSelection(["rev", "gp", "np", "ajv"], "gm"), ["gp", "np", "ajv", "gm"]);
});

/* ── Cost chain math ───────────────────────────────────── */

test("bridge steps display-round with largest remainder so the chain sums exactly", () => {
  const steps = buildBridgeSteps(
    { revenue: 435978.61, materials: 88940.7, labor: 55397.2 },
    291641.4,
    211533.9,
    false,
  );
  assert.ok(steps);
  const [rev, mat, lab, gross, ovhd, net] = steps;
  assert.equal(rev.value - mat.value - lab.value, gross.value);
  assert.equal(gross.value - ovhd.value, net.value);
  assert.deepEqual(
    steps.map((s) => s.label),
    ["Revenue", "Materials", "Labor", "Gross profit", "Overhead", "Net profit"],
  );
  const compact = buildBridgeSteps({ revenue: 100, materials: 30, labor: 20 }, 50, 40, true);
  assert.deepEqual(compact?.map((s) => s.label), ["Rev", "Mat", "Labor", "Gross", "Ovhd", "Net"]);
  assert.equal(buildBridgeSteps({ revenue: 0, materials: 0, labor: 0 }, 0, 0, false), null);
});

/* ── Row 3: revenue story + work source ────────────────── */

test("Where Revenue Went renders ONE segmented bar with 2px gaps and the net label inline", () => {
  const html = render(buildModel());
  assert.match(html, /Where June Revenue Went/);
  assert.match(html, /one bar · segments sum to June revenue/);
  assert.match(html, /class="stacked tall"/);
  // Legend carries materials/labor/overhead dollars + shares.
  assert.match(html, /Materials \$14,896 · 20\.6%/);
  assert.match(html, /Labor \$12,103 · 16\.8%/);
  assert.match(html, /Overhead \$11,399 · 15\.8%/);
  // The net segment labels inline; segment widths are the revenue shares.
  assert.match(html, /Net profit \$33\.8K · 46\.8%/);
  assert.match(html, /width:20\.6/);
  assert.match(html, /width:46\.8/);
  assert.match(html, /Gross profit = revenue − materials − labor\./);
});

test("work source mix is a bar-list by revenue share with margin metas", () => {
  const html = render(buildModel());
  assert.match(html, /Work Source Mix/);
  assert.match(html, /June completed jobs by source · bar = revenue share/);
  assert.match(html, /Quote-generated/);
  assert.match(html, /2 <small>jobs<\/small>/);
  assert.match(html, /\$69,275 · \$37,000 net · 53\.4% margin/);
  assert.match(html, /Direct service/);
  assert.match(html, /\$618 · −\$2,700 net · −436\.9% margin/);
  assert.match(html, /Work source is classification only\. Negative rows elsewhere on this page require actual Simpro net profit below zero\./);
  assert.doesNotMatch(html, /diagnostic-fee|direct-service calls produced|jobsWithQuoteWithin30Days/);
});

/* ── Row 3: labor + overruns ───────────────────────────── */

test("quote-linked labor renders sums, coverage line, variance strip and headline", () => {
  const html = render(buildModel());
  assert.match(html, /Estimated vs Actual Labor/);
  // Σest 54.75h, Σact 93.75h (39+8.75+7 vs 52+34.5+7.25).
  assert.match(html, /54\.8h/);
  assert.match(html, /93\.8h/);
  assert.match(html, /\+71\.2%/);
  assert.match(html, /over estimate/i);
  assert.match(html, /3 of 4 quote-linked jobs covered/);
  assert.match(html, /1 more has actuals but no estimate/);
  assert.match(html, /Per-job variance — 3 covered jobs · 3 over \(\+39\.0h\) · 0 under \(−0\.0h\) · 0 on estimate/);
  assert.match(html, /Per-job hours variance, sorted/);
  // The def separates quote-linked from work-source Quote-generated.
  assert.match(html, /Quote-linked \(4\) counts every June job converted from a quote/);
  assert.match(html, /Quote-generated \(2\) excludes recurring conversions/);
});

test("largest overruns is its own card with red shared-scale bars", () => {
  const html = render(buildModel());
  assert.match(html, /Largest Overruns/);
  assert.match(html, /top 3 by hours over estimate · bars scaled to the largest \(\+25\.75h\)/);
  assert.match(html, /102 · St Andrews Gardens — MH-10, MB-2/);
  assert.match(html, /\+25\.75h/);
  assert.match(html, /8\.75h quoted · 34\.5h actual/);
  assert.match(html, /<i class="bad" style="width:100%"><\/i>/);
});

test("recurring labor facts are estimate-covered only, with honest exclusions", () => {
  const model = buildModel();
  const facts = recurringLaborFacts(model.selected.records);
  assert.equal(facts.coveredJobs, 1);
  assert.equal(facts.estimatedHours, 7);
  assert.equal(facts.actualHours, 7.25);
  assert.equal(facts.overrunPercent && Number(facts.overrunPercent.toFixed(1)), 3.6);
  assert.equal(facts.exclusions.length, 1);
  assert.equal(facts.exclusions[0].jobId, "104");
  assert.equal(facts.exclusions[0].actualHours, 29.8);
});

/* ── Row 4: profitability by site ──────────────────────── */

test("site profitability is a two-column bar list ranked by net profit", () => {
  const html = render(buildModel());
  assert.match(html, /Profitability by Site/);
  assert.match(html, /bars scaled to the largest row/);
  assert.match(html, /class="barlist cols2"/);
  assert.match(html, /Holiday Inn Express #1955/);
  assert.match(html, /54\.3% margin · 103\.6% of net/);
  assert.match(html, /All 7 sites by net profit/);
});

test("site list beyond eight rows collapses into a bar-less total row with the long-tail footer", () => {
  const extraSites: NormalizedJobSnapshot[] = Array.from({ length: 10 }, (_, i) => ({
    jobId: 500 + i,
    jobNo: `J${500 + i}`,
    name: `Small job ${i}`,
    completedDate: "2026-06-20",
    stageName: "Complete",
    sellValue: 1000 + i,
    grossProfitActual: 500,
    netProfitActual: 400 + i,
    netMarginActual: 40,
    siteName: `Longtail Site ${String.fromCharCode(65 + i)}`,
  }));
  const html = render(buildModel({ jobs: [...JUNE_JOBS, ...CONTEXT_JOBS, ...extraSites] }));
  assert.match(html, /Remaining 9 sites/);
  assert.match(html, /Top 8 of 17 sites by net profit · the long tail still carries [−\d.]+% of net/);
  assert.match(html, /class="blrow total"/);
  assert.match(html, /long-tail aggregate, not on the per-site bar scale/);
  // The total row carries no bar.
  const totalRow = html.slice(html.indexOf('class="blrow total"'), html.indexOf("long-tail aggregate"));
  assert.doesNotMatch(totalRow, /class="bar"/);
});

/* ── Row 5: completed jobs table ───────────────────────── */

test("completed jobs table renders sell-ordered rows, filters with the full roster, pager and CSV button", () => {
  const html = render(buildModel());
  assert.match(html, /All 7 June jobs by sell value · click a row for detail/);
  assert.match(html, /Download CSV/);
  assert.match(html, /All categories/);
  assert.match(html, /All sources/);
  for (const source of ["Quote-generated", "Recurring", "Direct service"]) {
    assert.ok(html.includes(source), `missing source option ${source}`);
  }
  assert.match(html, /All technicians/);
  for (const tech of ["Rob Sires", "Juan Serrato", "Cole Bender", "Jim Ochoa", "Jeffrey Perry"]) {
    assert.ok(html.includes(tech), `missing technician option ${tech}`);
  }
  assert.match(html, /Showing 1–7 of 7 by sell value/);
  const body = html.slice(html.indexOf("<tbody"));
  assert.ok(body.indexOf("Consolidated water heating system replacement") < body.indexOf("MH-10, MB-2"));
  // The n/m grammar protects fee-ticket margins; losses render red in-table.
  assert.match(body, />n\/m</);
  assert.match(body, /−\$2,000/);
});

test("client-side filtering and sell-value ordering operate on the drilldown cohort", () => {
  const model = buildModel();
  const rows = model.selected.records;
  const direct = filterCompletedJobs(rows, { category: "all", source: "Direct service", technician: "all", site: null });
  assert.deepEqual(direct.map((row) => row.jobId).sort(), ["105", "106", "107"]);
  const byTech = filterCompletedJobs(rows, { category: "all", source: "all", technician: "Cole Bender", site: null });
  assert.deepEqual(byTech.map((row) => row.jobId), ["103"]);
  const bySite = filterCompletedJobs(rows, { category: "all", source: "all", technician: "all", site: "Vive Luxe" });
  assert.deepEqual(bySite.map((row) => row.jobId), ["106"]);
  const byCategory = filterCompletedJobs(rows, { category: "HVAC", source: "all", technician: "all", site: null });
  assert.deepEqual(byCategory.map((row) => row.jobId), ["102"]);
  const sorted = sortBySellValue(rows);
  assert.equal(sorted[0].jobId, "101");
  assert.equal(sorted[sorted.length - 1].jobId, "106");
});

test("CSV export covers the filtered cohort with the drilldown fields", () => {
  const model = buildModel();
  const csv = buildCompletedJobsCsv(sortBySellValue(model.selected.records));
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 8);
  assert.equal(
    lines[0],
    "Job ID,Job Number,Name,Completed Date,Customer,Site,Work Source,Primary Category,Technicians,Sell Value,Gross Profit,Net Profit,Net Margin (%)",
  );
  const first = lines[1].split(",");
  assert.equal(first[0], "101");
  assert.equal(first[1], "16614");
  assert.equal(first[6], "Quote-generated");
  assert.equal(first[9], "64419");
  assert.equal(first[12], "54.3");
});

test("fetchAllCompletedJobs uses one narrow full-roster request", async () => {
  const model = buildModel();
  const allRows = model.selected.records;
  model.selected.records = allRows.slice(0, 3);
  model.drilldownPagination = { page: 1, pageSize: 3, total: 7, totalPages: 3 };

  const requested: string[] = [];
  const rows = await fetchAllCompletedJobs(model, async (input: string, init?: RequestInit) => {
    const url = new URL(input, "https://dashboard.test");
    assert.equal(url.pathname, "/api/jobs/records");
    assert.equal(url.searchParams.get("month"), "2026-06");
    assert.equal(init?.cache, "no-store");
    requested.push(url.pathname);
    return Response.json({
      records: allRows,
      total: 7,
    });
  });
  assert.deepEqual(requested, ["/api/jobs/records"]);
  assert.equal(rows.length, 7);

  await assert.rejects(
    fetchAllCompletedJobs(model, async () =>
      Response.json({ ...model, selected: { ...model.selected, records: [] } }),
    ),
    /complete job list could not be loaded/,
  );
});

test("full roster remains idle until a table, CSV, drill, or recurring-labor interaction needs it", () => {
  const source = readFileSync(path.join(process.cwd(), "src/components/jobs-dashboard.tsx"), "utf8");
  const hook = source.match(/function useFullCohort[\s\S]*?\n}\n\nfunction CompletedJobsCard/)?.[0] ?? "";
  assert.doesNotMatch(hook, /useEffect\(/, "mounting the dashboard must not start the roster request");
  assert.match(source, /if \(value === "recurring"\) void cohort\.load\(\)/);
  assert.match(source, /void cohort\.load\(\)\.catch\(\(\) => undefined\);/, "filters and drill-through request the roster on demand");
  assert.match(source, /rows = await cohort\.load\(\)/, "CSV waits for a complete roster before export");
  assert.match(source, /entry > 1/, "later table pages request the roster on demand");
});

test("pager layout keeps every numbered button a live page", () => {
  assert.deepEqual(pageList(3, 1), [1, 2, 3]);
  assert.deepEqual(pageList(30, 5), [1, 2, "gap", 4, 5, 6, "gap", 30]);
  assert.deepEqual(pageList(28, 1), [1, 2, "gap", 28]);
});

/* ── Drawer grammar ────────────────────────────────────── */

test("net-margin display uses the n/m treatment for fee tickets and N/A without a sell basis", () => {
  assert.deepEqual(netMarginDisplay(59, -2000), { kind: "nm", ticket: "$59" });
  assert.deepEqual(netMarginDisplay(1000, 250), { kind: "pct", text: "25.0%" });
  assert.deepEqual(netMarginDisplay(1000, -250), { kind: "pct", text: "−25.0%" });
  assert.deepEqual(netMarginDisplay(null, 100), { kind: "na" });
  assert.deepEqual(netMarginDisplay(0, -100), { kind: "na" });
});

test("ticket article matches the approved kit grammar", () => {
  assert.equal(ticketArticle(863), "an");
  assert.equal(ticketArticle(59), "a");
});

/* ── Honest states ─────────────────────────────────────── */

test("empty months state the fact instead of fabricating zeros", () => {
  const html = render(buildModel({ selectedMonth: "2026-04" }));
  assert.match(html, /No jobs were completed in this month\./);
  assert.doesNotMatch(html, /\$33,800/);
  // The trend card still serves history.
  assert.match(html, /Monthly Trend/);
  assert.match(html, /Source: Simpro completed jobs · Pacific-time months · net profit = Simpro NetProfit Actual/);
});

test("load errors render the honest error treatment instead of figures", () => {
  const html = render(buildModel({ loadError: "connection refused" }));
  assert.match(html, /Job data could not be loaded\./);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /\$33,800/);
});

test("unsupported financial values render as N/A, never as zero dollars", () => {
  const html = render(
    buildModel({
      jobs: [
        {
          jobId: 900,
          jobNo: "J900",
          name: "Unsupported job",
          completedDate: "2026-06-10",
          stageName: "Complete",
          sellValue: null,
          grossProfitActual: null,
          netProfitActual: null,
          netMarginActual: null,
        },
      ],
    }),
  );
  assert.match(html, /N\/A/);
  assert.match(html, /net margin unavailable/);
  assert.match(html, /no supported cost basis/);
  assert.match(html, /revenue n\/a/);
  assert.match(html, /no supported revenue and net-profit totals to split/);
  // The band never fabricates a $0 figure — every unsupported value reads N/A.
  const band = html.slice(html.indexOf('class="kpis hero"'), html.indexOf("kpiband-note"));
  assert.doesNotMatch(band, /\$0/);
  assert.doesNotMatch(html, /\$0 net/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("states strip renders only behind the ?states=1 gate", () => {
  const hidden = render(buildModel());
  assert.match(hidden, /class="states"/);
  assert.doesNotMatch(hidden, /class="states show"/);
  const shown = render(buildModel(), true);
  assert.match(shown, /class="states show"/);
  assert.match(shown, /State treatments \(design reference\)/);
  assert.match(shown, /Updated 3 hrs ago/);
});

/* ── Removed surfaces (owner rulings) ──────────────────── */

test("the net-negative card/tile is removed; losses stay reachable via the table only", () => {
  const html = render(buildModel());
  assert.doesNotMatch(html, /Net-Negative Jobs/);
  assert.doesNotMatch(html, /finished below zero actual net profit/);
  assert.doesNotMatch(html, /% of completed jobs/);
  // The loss rows themselves are still in the completed-jobs table.
  assert.match(html, /Expansion Tanks for recent Installs/);
});

test("rejected owner-facing surfaces stay deleted", () => {
  const html = render(buildModel());
  for (const removed of [
    "Methodology",
    "Material Source Coverage",
    "Quote-Generated Labor Coverage",
    "Net-Margin Distribution",
    "Customer Profitability",
    "Reconciliation",
    "Coverage unavailable",
    "jobs-metric-hero",
    "Gross-To-Net Job-Cost Waterfall",
    "nestedItemsComplete",
    "Revenue to Net Profit", // the old bridge card
    'class="focal"', // the 751px hero slab
  ]) {
    assert.ok(!html.includes(removed), `rejected surface leaked back into the owner UI: ${removed}`);
  }
});

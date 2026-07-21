import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  activityBuckets,
  activitySplitText,
  archivedTechnicianRows,
  deriveTeamFacts,
  punctualityBuckets,
  punctualityFnote,
  SCORE_SORT_KEYS,
  scoreSortValue,
  sortScoreRows,
  technicianPayload,
  technicianScoreRows,
  TechniciansDashboard,
  utilizationComparison,
} from "../../src/components/technicians-dashboard";
import {
  buildTechnicianPerformanceReadModel,
  type TechnicianPerformanceReadModel,
  type TechnicianPunctualityDistribution,
} from "../../src/lib/metrics/technicians";
import type { DashboardReadModel } from "../../src/lib/store/dashboard-read-models";

const source = readFileSync(path.join(process.cwd(), "src/components/technicians-dashboard.tsx"), "utf8");

/* Fixture: June 2026, three active roster technicians + one archived
   field-position worker with in-month work + one NON-roster employee (Otto)
   who worked a completed job. Every rendered figure must flow from this
   payload — never from the component. */
function juneFixture(): TechnicianPerformanceReadModel {
  return buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    roster: [
      { employeeId: "1", displayName: "Alice Field" },
      { employeeId: "2", displayName: "Bob Overtime" },
      { employeeId: "3", displayName: "Cara Quiet" },
      { employeeId: "9", displayName: "Vic Archived", archived: true, hasInPeriodWork: true },
    ],
    capacityProfiles: [
      { employeeId: "1", displayName: "Alice Field", dateOfHire: "2020-05-01" },
      { employeeId: "2", displayName: "Bob Overtime" },
      { employeeId: "3", displayName: "Cara Quiet" },
      { employeeId: "9", displayName: "Vic Archived", archived: true },
    ],
    recordedTimesheets: [
      { timesheetId: "t1", employeeId: "1", displayName: "Alice Field", workDate: "2026-06-05", hours: 100, referenceType: "job", referenceId: "j1", parseStatus: "parsed", jobSupported: true },
      { timesheetId: "t2", employeeId: "1", displayName: "Alice Field", workDate: "2026-06-06", hours: 60, referenceType: "activity", activityId: "45" },
      { timesheetId: "t3", employeeId: "2", displayName: "Bob Overtime", workDate: "2026-06-05", hours: 150, referenceType: "job", referenceId: "j2", parseStatus: "parsed", jobSupported: true },
      { timesheetId: "t4", employeeId: "2", displayName: "Bob Overtime", workDate: "2026-06-06", hours: 60, referenceType: "activity", activityId: "45" },
      { timesheetId: "t5", employeeId: "3", displayName: "Cara Quiet", workDate: "2026-06-05", hours: 8, referenceType: "job", referenceId: "j1", parseStatus: "parsed", jobSupported: true },
      { timesheetId: "t6", employeeId: "9", displayName: "Vic Archived", workDate: "2026-06-05", hours: 6, referenceType: "job", referenceId: "j5", parseStatus: "parsed", jobSupported: true },
      { timesheetId: "t7", employeeId: "77", displayName: "Otto Outsider", workDate: "2026-06-05", hours: 40, referenceType: "job", referenceId: "j4", parseStatus: "parsed", jobSupported: true },
    ],
    jobs: [
      {
        jobId: "j1", jobNo: "1001", jobName: "Boiler service", completedDate: "2026-06-10",
        sellValue: 1000, sellValueCovered: true, grossProfit: 400, netProfit: 200,
        quoteId: "q1", quotedHours: 10,
        timesheets: [{ employeeId: "1", displayName: "Alice Field", hours: 8, inPeriodHours: 8 }],
      },
      {
        jobId: "j2", jobNo: "1002", jobName: "Pump swap", completedDate: "2026-06-12",
        sellValue: 500, sellValueCovered: true, grossProfit: 200, netProfit: 100,
        quoteId: "q2", quotedHours: 6,
        timesheets: [{ employeeId: "2", displayName: "Bob Overtime", hours: 8, inPeriodHours: 8 }],
      },
      {
        jobId: "j3", jobNo: "1003", jobName: "PM visit", completedDate: "2026-06-15",
        sellValue: 300, sellValueCovered: true, grossProfit: 120, netProfit: 50,
        recurringJobId: "r1", quotedHours: 5,
        timesheets: [{ employeeId: "1", displayName: "Alice Field", hours: 5, inPeriodHours: 5 }],
      },
      {
        jobId: "j4", jobNo: "1004", jobName: "Outside work", completedDate: "2026-06-18",
        sellValue: 800, sellValueCovered: true, grossProfit: 350, netProfit: 300,
        timesheets: [{ employeeId: "77", displayName: "Otto Outsider", hours: 4, inPeriodHours: 4 }],
      },
      {
        jobId: "j5", jobNo: "1005", jobName: "History job", completedDate: "2026-06-20",
        sellValue: 400, sellValueCovered: true, grossProfit: 180, netProfit: 150,
        timesheets: [{ employeeId: "9", displayName: "Vic Archived", hours: 6, inPeriodHours: 6 }],
      },
      {
        jobId: "j6", jobNo: "1006", jobName: "Carry-over job", completedDate: "2026-06-25",
        sellValue: 200, sellValueCovered: true, grossProfit: 90, netProfit: 80,
        timesheets: [{ employeeId: "1", displayName: "Alice Field", hours: 10, inPeriodHours: 4 }],
      },
    ],
  });
}

function dashboardModel(payload: DashboardReadModel["payload"]): DashboardReadModel {
  return {
    scope: "technicians",
    freshness: {} as DashboardReadModel["freshness"],
    rollups: [],
    payload,
    kpis: [],
    warnings: [],
  };
}

function render(model: DashboardReadModel, props: { showStates?: boolean; initialDrillEmployeeId?: string } = {}) {
  return renderToStaticMarkup(createElement(TechniciansDashboard, { model, ...props }));
}

test("outside-roster and archived people are never promoted into the scorecard", () => {
  const payload = juneFixture();
  assert.equal(payload.rosterApplied, true);
  assert.deepEqual(payload.outsideRoster.map((entry) => entry.displayName), ["Otto Outsider"]);

  const rows = technicianScoreRows(payload);
  assert.deepEqual(rows.map((row) => row.name).sort(), ["Alice Field", "Bob Overtime", "Cara Quiet"]);
  assert.deepEqual(archivedTechnicianRows(payload).map((row) => row.name), ["Vic Archived"]);

  const html = render(dashboardModel(payload));
  assert.match(html, /data-tech="1"/);
  assert.match(html, /data-tech="2"/);
  assert.match(html, /data-tech="3"/);
  assert.doesNotMatch(html, /data-tech="77"/, "non-roster employee must not become a scorecard row");
  assert.doesNotMatch(html, /data-tech="9"/, "archived worker must not become a scorecard row");
  // Otto appears only as the economics disclosure, never as a table row.
  assert.match(html, /\$800 sits outside the 3-tech roster/);
  assert.match(html, /Otto Outsider \(\$800\) is not on the recorded-work roster/);
});

test("KPI band renders the payload's utilization, unbilled split and efficiency facts — no capacity model", () => {
  const payload = juneFixture();
  const html = render(dashboardModel(payload));

  // Primary card: 258h job of 378h recorded → 68% productive utilization.
  assert.match(html, /Productive utilization/);
  assert.match(html, /258h on jobs of 378h recorded/);
  assert.match(html, />68%</);
  // No supplied comparison data means unavailable, not permanently "pending".
  assert.match(html, /May ’26 unavailable · Jun ’25 unavailable/);
  assert.match(html, /No prior-period technician model is available for comparison\./);
  // Unbilled tile (spans 2): 120h with the REAL activity split, never lumped.
  assert.match(html, />120h</);
  assert.match(html, /Travel 120h/);
  // Quote labor efficiency tile: (10+6) ÷ (8+8) = 1.00× over 2 of 2 jobs.
  assert.match(html, /1\.00×/);
  assert.match(html, /team · 2 of 2 quote-linked jobs/);
  // No visit coverage in this fixture → the tile is "—", never 0% or 100%.
  assert.match(html, /no verified visits/);

  // OWNER RULINGS: the capacity model and the alert banners are gone.
  assert.doesNotMatch(html, /of capacity|Capacity Used|Capacity use|capacity 8h|above 115%|\(example\)|Target 65%/);
  assert.doesNotMatch(html, /is an active technician with|recorded 210h vs 176h capacity|archived but worked/);
});

test("lean comparison summaries render historical utilization without serializing employee history", () => {
  const payload = juneFixture();
  const model = dashboardModel(payload);
  model.technicianHistory = {
    availableFrom: "2023-01-01",
    comparisons: [
      { periodStart: "2025-06-01", jobHours: 75, recordedHours: 100 },
      { periodStart: "2026-05-01", jobHours: 60, recordedHours: 100 },
    ],
  };

  assert.deepEqual(utilizationComparison(model.technicianHistory, payload.periodStart, -1), {
    periodStart: "2026-05-01", utilizationPercent: 60,
  });
  assert.deepEqual(utilizationComparison(model.technicianHistory, payload.periodStart, -12), {
    periodStart: "2025-06-01", utilizationPercent: 75,
  });

  const html = render(model);
  assert.match(html, /May ’26 60% · Jun ’25 75%/);
  assert.match(html, /data is available from January 2023/);
  assert.doesNotMatch(html, /pending timesheet verification/);
});

test("recorded-time rows split job / travel / other unbilled and mark the primary visualization", () => {
  const payload = juneFixture();
  const html = render(dashboardModel(payload));

  assert.match(html, /Recorded Time vs Capacity/);
  assert.match(html, /sorted by job hours · click a row for the full activity split/);
  assert.match(html, /data-primary-viz/);
  // Legend carries the three fills; travel renders in --series-2.
  assert.match(html, /Job-assigned/);
  assert.match(html, /Travel/);
  assert.match(html, /Other unbilled/);
  assert.match(html, /#0e9aae/);
  // Right meta: job hours · utilization share (Bob 150h/210h → 71%).
  assert.match(html, /150h · 71% on jobs/);
  assert.match(html, /100h · 63% on jobs/);
  // Cara is inactive → faint row with recorded hours only.
  assert.match(html, /inactive · 8h/);
  // Rows are keyboard-activatable drills.
  assert.match(html, /open the full Alice Field drilldown/);
  // No capacity tick and no amber over-capacity rule anywhere in the card.
  assert.doesNotMatch(html, /dark tick|monthly capacity|amber = above/);
});

test("scorecard sorts every metric column both ways with null rows always last — no capacity column", () => {
  const payload = juneFixture();
  const rows = technicianScoreRows(payload);

  assert.deepEqual([...SCORE_SORT_KEYS], ["job", "unb", "util", "effQ", "ot"]);
  // Default: job hours descending.
  assert.deepEqual(sortScoreRows(rows, "job", -1).map((row) => row.name), ["Bob Overtime", "Alice Field", "Cara Quiet"]);
  assert.deepEqual(sortScoreRows(rows, "job", 1).map((row) => row.name), ["Cara Quiet", "Alice Field", "Bob Overtime"]);
  // Cara is inactive → null utilization sorts last in BOTH directions.
  assert.equal(scoreSortValue(rows.find((row) => row.name === "Cara Quiet")!, "util"), null);
  assert.equal(sortScoreRows(rows, "util", -1).at(-1)!.name, "Cara Quiet");
  assert.equal(sortScoreRows(rows, "util", 1).at(-1)!.name, "Cara Quiet");
  // Cara has no covered quote-linked jobs → null efficiency sorts last both ways.
  assert.equal(sortScoreRows(rows, "effQ", -1).at(-1)!.name, "Cara Quiet");
  assert.equal(sortScoreRows(rows, "effQ", 1).at(-1)!.name, "Cara Quiet");
  // On-time has no coverage anywhere → order is stable, values null.
  assert.ok(rows.every((row) => scoreSortValue(row, "ot") === null));

  const html = render(dashboardModel(payload));
  assert.match(html, /class="num sortable sorted" data-sort="job"/);
  assert.match(html, /sorted by job hours \(descending\) — click a column to re-sort/);
  assert.match(html, /Roster: 3 people with recorded work/);
  assert.match(html, /· inactive/);
  assert.match(html, />—</);
  // Capacity-use is gone from the table (owner ruling).
  assert.doesNotMatch(html, /Capacity Use/);
  // Computed team footer: 258h job, 120h unbilled, 68% util, 1.00× eff.
  assert.match(html, /Team · 3 technicians/);
  assert.match(html, /Team · 3 technicians<\/td>[\s\S]*?258h[\s\S]*?120h[\s\S]*?68%[\s\S]*?1\.00×/);
});

test("activity buckets derive from the real per-tech fields and never invent a type", () => {
  const payload = juneFixture();
  const alice = technicianScoreRows(payload).find((row) => row.name === "Alice Field")!;
  assert.deepEqual(activityBuckets(alice.tech), [{ label: "Travel", hours: 60 }]);
  assert.equal(activitySplitText(activityBuckets(alice.tech)), "Travel 60h");
  assert.equal(activitySplitText([]), "no unbilled activity recorded");
  assert.equal(
    activitySplitText(
      [
        { label: "Travel", hours: 240.5 },
        { label: "Holiday", hours: 72 },
        { label: "Support / office", hours: 29.8 },
        { label: "Lunch", hours: 24.5 },
        { label: "Sick / personal", hours: 13.8 },
        { label: "PTO", hours: 10.2 },
        { label: "Pickup parts", hours: 9.8 },
      ],
      5,
    ),
    "Travel 240.5h · Holiday 72h · Support / office 29.8h · Lunch 24.5h · Sick / personal 13.8h · 2 more types",
  );
});

test("drilldown keeps the full roster visible and opens per-technician facts in a drawer", () => {
  const payload = juneFixture();
  const html = render(dashboardModel(payload), { initialDrillEmployeeId: "1" });

  assert.match(html, /Technician Scorecard/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /← All technicians/);
  assert.match(html, /hired May 2020 · viewing June 2026/);
  // KPIs from the payload: 100h job, 60h unbilled, 160h recorded, 63% util, 3 jobs.
  assert.match(html, /Job hours<\/div><div class="v tnum">100h/);
  assert.match(html, /Unbilled<\/div><div class="v tnum">60h/);
  assert.match(html, /Recorded<\/div><div class="v tnum">160h/);
  assert.match(html, /Utilization<\/div><div class="v tnum">63%/);
  assert.match(html, /June jobs<\/div><div class="v tnum">3/);
  // No capacity fact anywhere in the drill (owner ruling).
  assert.doesNotMatch(html, /Capacity use/);
  // Real per-activity breakdown from the payload fields.
  assert.match(html, /June unbilled activity — per recorded type/);
  assert.match(html, /Travel<\/span><b class="tnum"[^>]*>60h/);
  assert.match(html, /Total unbilled<\/span><b class="tnum"[^>]*>60h/);
  // Covered quote-linked jobs table is honest per the payload (j1 only).
  assert.match(html, /June efficiency — quote-linked jobs/);
  assert.match(html, /1001 · Boiler service/);
  assert.match(html, /10h<\/td><td class="num tnum">8h/);
  assert.match(html, /1\.25×/);
  assert.match(html, /Alice’s <span[^>]*>1\.25× uses the hour-share allocation<\/span>; the team ratio is 1\.00× across 2 covered jobs\./);
  // Economics context prose incl. the pre-month-hours disclosure (6h outside June on j6).
  assert.match(html, /Completed-job economics — separate cohort/);
  assert.match(html, /\$1,500/);
  assert.match(html, /\$330/);
  assert.match(html, /6h of Alice’s allocation basis/);
  assert.match(html, /contribution context, not June earnings/);
});

test("drill shows the honest empty row when a technician has no covered quote-linked jobs", () => {
  const payload = juneFixture();
  const html = render(dashboardModel(payload), { initialDrillEmployeeId: "3" });
  assert.match(html, /No covered quote-linked jobs in June/);
  assert.match(html, /No jobs completed in June carry Cara’s hours — no allocation this month\./);
});

test("punctuality buckets keep early separate and merge the ≤15-minute bands", () => {
  const punctuality: TechnicianPunctualityDistribution = {
    early: 2, onTime: 3, late1To15: 4, late16To30: 5, lateOver30: 6, coveredVisits: 20, scheduledVisits: 22,
  };
  assert.deepEqual(punctualityBuckets(punctuality), [
    { label: "Early", count: 2 },
    { label: "≤ 15 min", count: 7 },
    { label: "16–30 min", count: 5, neg: true },
    { label: "30+ min", count: 6, neg: true },
  ]);
});

test("punctuality card offers the per-technician drill and the footnote states the verified rate", () => {
  const payload = juneFixture();
  const facts = {
    ...deriveTeamFacts(payload, technicianScoreRows(payload)),
    otPct: 89.2,
    otFloorPct: 79.4,
    verifiedVisits: 342,
    scheduledVisits: 384,
  };
  const punctuality: TechnicianPunctualityDistribution = {
    early: 153, onTime: 100, late1To15: 52, late16To30: 11, lateOver30: 26, coveredVisits: 342, scheduledVisits: 384,
  };
  assert.equal(
    punctualityFnote(punctuality, facts),
    "On-time counts verified visits only (79% if every uncovered visit were late) — the 26-visit 30+ tail outweighs the 16–30 band.",
  );
  const reversed = punctualityFnote({ ...punctuality, late16To30: 30, lateOver30: 4 }, facts);
  assert.match(reversed, /30-visit 16–30 band outweighs the 30\+ tail/);
  // The card always states its drill affordance; the fixture has no coverage so
  // the honest empty state renders instead of the distribution.
  const html = render(dashboardModel(payload));
  assert.match(html, /click for per-technician detail/);
  assert.match(html, /No verified arrivals in June — punctuality has no coverage/);
});

test("economics ranks roster technicians by allocated net with hatched single-series bars", () => {
  const payload = juneFixture();
  const html = render(dashboardModel(payload));

  // Ranked by allocated net profit: Alice ($330) before Bob ($100); hatched interim bars.
  const econStart = html.indexOf("Completed-Job Economics");
  assert.ok(econStart > -1);
  const econ = html.slice(econStart);
  const aliceAt = econ.indexOf("Alice Field");
  const bobAt = econ.indexOf("Bob Overtime");
  assert.ok(aliceAt > -1 && bobAt > -1 && aliceAt < bobAt);
  assert.match(econ, /class="hatch"/);
  assert.match(econ, /\$330<\/b> net · <b[^>]*>77%<\/b> of\s*team net/);
  assert.match(econ, /hatched = hours-share allocation/);
  assert.match(econ, /hours-share split/);
  // Single Net profit legend — the revenue series moved to the hover detail.
  assert.match(econ.slice(0, econ.indexOf("Alice Field")), /Net profit/);
  assert.doesNotMatch(econ.slice(0, econ.indexOf("Alice Field")), /Revenue/);
  // Disclosure line: real coverage total + names from outsideRoster[], archived and no-allocation members.
  assert.equal(payload.coverage.outsideRosterAllocatedSellValue, 800);
  assert.match(econ, /\$800 sits outside the 3-tech roster — Otto Outsider \(\$800\) is not on the recorded-work roster/);
  assert.match(econ, /Vic Archived \(\$400\)\s+is archived — history kept, not ranked/);
  assert.match(econ, /Cara Quiet has no June\s+allocation/);
  // Cara (no allocation) and Vic (archived) are not ranked rows.
  assert.doesNotMatch(econ.slice(0, econ.indexOf("Allocation is an")), /Cara Quiet|Vic Archived/);
});

test("labor efficiency renders payload-driven diverging bars", () => {
  const payload = juneFixture();
  const html = render(dashboardModel(payload));

  assert.match(html, /Labor Efficiency/);
  assert.match(html, /per-tech hour-share allocation/);
  assert.match(html, /1\.00× — estimate met exactly/);
  assert.match(html, /Quote-linked/);
  assert.match(html, /Recurring/);
  assert.match(html, /2 covered jobs \(team\)/);
  assert.match(html, /team and per-technician figures use the recorded-time allocation\./);
  // Only technicians with allocated jobs appear as efficiency bars: Alice 1.25×, Bob 0.75×.
  assert.match(html, /1\.25×/);
  assert.match(html, /0\.75×/);
});

test("states strip renders only with the ?states=1 gate and the footline names the sources", () => {
  const payload = juneFixture();
  const hidden = render(dashboardModel(payload));
  const shown = render(dashboardModel(payload), { showStates: true });
  assert.match(hidden, /class="states"/);
  assert.doesNotMatch(hidden, /class="states show"/);
  assert.match(shown, /class="states show"/);
  assert.match(shown, /State treatments \(design reference\)/);
  assert.match(shown, /never 0% or 100%/);
  assert.match(shown, /hours through the 13th only/);
  for (const html of [hidden, shown]) {
    assert.match(
      html,
      /Source: Simpro — roster is everyone with recorded work in June; work metrics use June-dated timesheets,\s+with completed-job economics labeled as a separate cohort\./,
    );
  }
});

test("payloads without the detailed contract render the honest error state, never synthetic zeros", () => {
  const legacyPayload = {
    technicians: [{ employeeId: "7", displayName: "Legacy Technician", allocatedSellValue: 0, actualJobHours: 0 }],
    coverage: { totalJobs: 0 },
  } as unknown as DashboardReadModel["payload"];
  for (const model of [dashboardModel(null), dashboardModel(legacyPayload)]) {
    assert.equal(technicianPayload(model), null);
    const html = render(model);
    assert.match(html, /Technician data could not be loaded\./);
    assert.match(html, /Try again/);
    assert.doesNotMatch(html, /Legacy Technician|Technician Scorecard|Productive utilization/);
  }
});

test("empty month technician payloads render an empty state, not a load error", () => {
  const emptyPayload = {
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    technicians: [],
    coverage: { totalJobs: 0 },
  } as unknown as DashboardReadModel["payload"];
  const html = render(dashboardModel(emptyPayload));
  const visible = html.slice(0, html.indexOf('<div class="states"'));
  assert.equal(technicianPayload(dashboardModel(emptyPayload)), null);
  assert.match(html, /No technician activity is recorded for August\. Pick another month\./);
  assert.doesNotMatch(visible, /Technician data could not be loaded\.|Try again|Technician Scorecard|Productive utilization/);
});

test("rejected surfaces stay deleted from the dashboard source", () => {
  for (const banned of [/heatmap/i, /reconciliation/i, /methodology/i, /diagnostic/i, /coverage table/i, /recharts/i]) {
    assert.doesNotMatch(source, banned);
  }
  // The capacity model and the alert-flag strip are owner-removed for good.
  for (const banned of [/grossCapacityHours\s*>\s*0\s*\?\s*\(rec \/ cap\)/, /CAP_TICK/, /deriveExceptionFlags/, /Flags/, /EXAMPLE_TARGET/, /184h/]) {
    assert.doesNotMatch(source, banned);
  }
  // The old gross-profit fallback patterns must not return.
  assert.doesNotMatch(source, /allocatedNetProfit\s*\?\?\s*.*allocatedGrossProfit/);
  assert.match(source, /netProfitBasis !== "simpro_job_net_profit_actual"/);
  assert.doesNotMatch(source, /label="On-time"[\s\S]{0,220}className="repr"/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  archivedTechnicianRows,
  deriveExceptionFlags,
  deriveTeamFacts,
  punctualityBuckets,
  punctualityFnote,
  scoreSortValue,
  sortScoreRows,
  technicianPayload,
  technicianScoreRows,
  TechniciansDashboard,
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

test("hero renders the payload's utilization, capacity, unbilled and efficiency facts", () => {
  const payload = juneFixture();
  const html = render(dashboardModel(payload));

  // Roster totals: job 258h, recorded 378h → 68% productive utilization.
  assert.match(html, /Productive Utilization/);
  assert.match(html, /258h on jobs of 378h recorded/);
  assert.match(html, />68%</);
  // Capacity: 22 workdays × 8h × 3 techs = 528h; 378/528 = 72%.
  assert.match(html, /3 technicians · 22 workdays · capacity 8h\/day \(Mon–Fri 8:30–5:00, 30-min lunch\) = 528h/);
  assert.match(html, /72%(<\/div>| of capacity)/);
  // Unbilled 120h at 31.7% of recorded.
  assert.match(html, />120h</);
  assert.match(html, /31\.7% of recorded/);
  // Bob is the only tech above 115% capacity (210/176 = 119%).
  assert.match(html, /1 tech <span class="c">above 115%<\/span>/);
  // Team quote-linked efficiency: (10+6) ÷ (8+8) = 1.00× over 2 of 2 jobs.
  assert.match(html, /1\.00×/);
  assert.match(html, /team · 2 of 2 quote-linked jobs/);
  // Honest no-history line and example target stay disclosed.
  assert.match(html, /No prior-period comparison yet — timesheet history verification is pending\./);
  assert.match(html, /Target 65% \(example\)/);
  // No visit coverage in this fixture → the stat is "—", never 0% or 100%.
  assert.match(html, /no verified visits/);
});

test("exception flags derive from the payload, not hardcoded names", () => {
  const payload = juneFixture();
  const flags = deriveExceptionFlags(technicianScoreRows(payload), archivedTechnicianRows(payload));
  assert.deepEqual(flags.map((flag) => flag.kind), ["over_capacity", "low_hours", "archived_with_work"]);
  assert.equal(flags[0].name, "Bob Overtime");
  assert.equal(flags[1].name, "Cara Quiet");
  assert.equal(flags[2].name, "Vic Archived");

  const html = render(dashboardModel(payload));
  assert.match(html, /Bob Overtime<\/b> recorded 210h vs 176h capacity/);
  assert.match(html, /\+34h over/);
  assert.match(html, /Cara Quiet<\/b> is an active technician with <b>8h<\/b> recorded in June/);
  assert.match(html, /Vic Archived<\/b> is archived but worked\s+1 June job\s+— history kept, no current capacity/);
});

test("scorecard sorts every metric column both ways with null rows always last", () => {
  const payload = juneFixture();
  const rows = technicianScoreRows(payload);

  // Default: job hours descending.
  assert.deepEqual(sortScoreRows(rows, "job", -1).map((row) => row.name), ["Bob Overtime", "Alice Field", "Cara Quiet"]);
  // Ascending job hours.
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
  // Default sort marker on the Job Hrs column, descending (no .asc).
  assert.match(html, /class="num sortable sorted" data-sort="job"/);
  assert.match(html, /sorted by job hours \(descending\) — click a column to re-sort/);
  assert.match(html, /Roster: 3 people with recorded work/);
  // Inactive row marker and em-dash cells render.
  assert.match(html, /· inactive/);
  assert.match(html, />—</);
  // Computed team footer: 258h job, 120h unbilled, 68% util, 72% capacity, 1.00× eff.
  assert.match(html, /Team · 3 technicians/);
  assert.match(html, /Team · 3 technicians<\/td>[\s\S]*?258h[\s\S]*?120h[\s\S]*?68%[\s\S]*?72%[\s\S]*?1\.00×/);
});

test("drilldown replaces the scorecard with per-technician facts from the payload", () => {
  const payload = juneFixture();
  const html = render(dashboardModel(payload), { initialDrillEmployeeId: "1" });

  // Drill card replaces the scorecard.
  assert.doesNotMatch(html, /Technician Scorecard/);
  assert.match(html, /← All technicians/);
  assert.match(html, /hired May 2020 · viewing June 2026/);
  // 8 KPIs from the payload: 100h job, 60h unbilled, 160h recorded, 63% util, 91% capacity, 3 jobs.
  assert.match(html, /Job hours<\/div><div class="v tnum">100h/);
  assert.match(html, /Unbilled<\/div><div class="v tnum">60h/);
  assert.match(html, /Recorded<\/div><div class="v tnum">160h/);
  assert.match(html, /Utilization<\/div><div class="v tnum">63%/);
  assert.match(html, /Capacity use<\/div><div class="v tnum">91%/);
  assert.match(html, /June jobs<\/div><div class="v tnum">3/);
  // Covered quote-linked jobs table is honest per the payload (j1 only).
  assert.match(html, /June efficiency — quote-linked jobs/);
  assert.match(html, /1001 · Boiler service/);
  assert.match(html, /10h<\/td><td class="num tnum">8h/);
  assert.match(html, /1\.25×/);
  assert.match(html, /Alice’s <span class="repr"[^>]*>1\.25× is representative<\/span>; the verified team ratio is 1\.00× across 2 covered jobs\./);
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

test("punctuality footnote states the verified rate, the uncovered floor and the heavier late band", () => {
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
    "On-time is 89% of verified visits (79% if every uncovered visit were late) — the 26-visit 30+ tail outweighs the 16–30 band.",
  );
  const reversed = punctualityFnote({ ...punctuality, late16To30: 30, lateOver30: 4 }, facts);
  assert.match(reversed, /30-visit 16–30 band outweighs the 30\+ tail/);
  // Fixture has no visit coverage: the card shows the honest no-coverage state.
  const html = render(dashboardModel(payload));
  assert.match(html, /No verified arrivals in June — punctuality has no coverage/);
});

test("economics ranks roster technicians by allocated net and discloses everyone else", () => {
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
  assert.match(econ, /hatched = interim allocation/);
  assert.match(econ, /interim hours-share split/);
  // Disclosure line: real coverage total + names from outsideRoster[], archived and no-allocation members.
  assert.equal(payload.coverage.outsideRosterAllocatedSellValue, 800);
  assert.match(econ, /\$800 sits outside the 3-tech roster — Otto Outsider \(\$800\) is not on the recorded-work roster/);
  assert.match(econ, /Vic Archived \(\$400\)\s+is archived — history kept, not ranked/);
  assert.match(econ, /Cara Quiet has no June\s+allocation/);
  // Cara (no allocation) and Vic (archived) are not ranked rows.
  assert.doesNotMatch(econ.slice(0, econ.indexOf("Allocation is an")), /Cara Quiet|Vic Archived/);
});

test("capacity and efficiency charts render payload-driven rows and defs", () => {
  const payload = juneFixture();
  const html = render(dashboardModel(payload));

  assert.match(html, /Recorded Time vs Capacity/);
  assert.match(html, /Sorted by job hours · dark tick = 176h monthly capacity · amber = above 115% · hover or tap any row/);
  assert.match(html, /inactive · 8h/);
  assert.match(html, /Labor Efficiency/);
  assert.match(html, /per-tech split representative/);
  assert.match(html, /1\.00× — estimate met exactly/);
  assert.match(html, /Quote-linked/);
  assert.match(html, /Recurring/);
  assert.match(html, /2 covered jobs \(team\)/);
  assert.match(html, /the team’s 1\.00× is verified, the per-tech split is not yet\./);
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
  assert.match(shown, /capacity accrues through the 13th only/);
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
    assert.doesNotMatch(html, /Legacy Technician|Technician Scorecard|Productive Utilization/);
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
  assert.doesNotMatch(visible, /Technician data could not be loaded\.|Try again|Technician Scorecard|Productive Utilization/);
});

test("rejected diagnostic surfaces stay deleted from the dashboard source", () => {
  for (const banned of [/heatmap/i, /reconciliation/i, /methodology/i, /diagnostic/i, /coverage table/i, /recharts/i]) {
    assert.doesNotMatch(source, banned);
  }
  // The old gross-profit fallback patterns must not return.
  assert.doesNotMatch(source, /allocatedNetProfit\s*\?\?\s*.*allocatedGrossProfit/);
  assert.match(source, /netProfitBasis !== "simpro_job_net_profit_actual"/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TodayDashboard } from "../../src/components/today-dashboard";
import type { TodayDashboardReadModel } from "../../src/lib/store/today-read-model";

/* Fixture mirrors the approved July-14 mockup snapshot so the rendered copy
   can be checked against the approved grammar — every number flows from this
   payload, none from the component. */

function cumulative(month: string, values: number[], jobsPerDay = 1) {
  return {
    month,
    days: values.map((cumulativeRevenue, index) => ({ day: index + 1, cumulativeRevenue, jobs: (index + 1) * jobsPerDay })),
  };
}

const model: TodayDashboardReadModel = {
  asOf: "2026-07-15T17:00:00.000Z",
  asOfDate: "2026-07-14",
  month: "2026-07",
  timezone: "America/Los_Angeles",
  elapsedDays: 14,
  daysInMonth: 31,
  today: {
    completedJobs: 2,
    revenue: 10459,
    revenueCoveredJobs: 2,
    grossProfit: 7400,
    grossMargin: 70.7515,
    netProfit: 5100,
    netMargin: 48.7618,
    averageJobValue: 5229.5,
    grossProfitCoveredJobs: 2,
    netProfitCoveredJobs: 2,
    netNegativeJobs: 1,
    netNegativeTotal: -300,
    jobs: [
      { jobId: "18002", jobNo: "18002", name: "Boiler repair", siteName: "North Tower", sellValue: 10000, grossProfit: 7000, grossMargin: 70, netProfit: 5400, netMargin: 54, updatedFromSourceAt: "2026-07-15T16:58:00.000Z" },
      { jobId: "18001", jobNo: "18001", name: "Diagnostic visit", siteName: "South Tower", sellValue: 459, grossProfit: 400, grossMargin: 87.1459, netProfit: -300, netMargin: -65.3595, updatedFromSourceAt: "2026-07-15T16:55:00.000Z" },
    ],
  },
  dailyCumulativeRevenue: {
    currentMonth: cumulative("2026-07", [11689, 123361, 123361, 125520, 126895, 147184, 160821, 184846, 207179, 223822, 225838, 225838, 246691, 261425]),
    priorMonth: cumulative("2026-06", Array.from({ length: 30 }, (_, i) => (i < 13 ? 16958 * (i + 1) : 16958 * 13)).map((v, i) => (i === 13 ? 220458 : i === 29 ? 435979 : v))),
    priorYearSameMonth: cumulative("2025-07", Array.from({ length: 31 }, (_, i) => (i === 13 ? 148640 : i === 30 ? 451054 : 10000 * (i + 1)))),
  },
  mtd: {
    revenue: 261425,
    netProfit: 139937,
    netProfitCoveredJobs: 101,
    jobsCount: 101,
    avgJobValue: 261425 / 101,
    quotesSent: 14,
    quotesSentValue: 91636,
    quotesSentBasis: "DateIssued assigns quotes-sent activity to the month.",
    poolSoFar: 1307.125,
    poolSoFarCents: 130713,
    poolPercent: 0.5,
    teamRecordedHours: 822.75,
    mtdCapacityHours: 720,
    capacityRule: "Flat capacity rule.",
    rosterSize: 9,
    rosterSource: "effective_technician_roster",
  },
  losses: {
    rule: "rule",
    count: 7,
    netTotal: -1460,
    diagnosticFee: { jobs: 5, netTotal: -900 },
    execution: { jobs: 2, netTotal: -560 },
    top: [
      { jobId: "1", name: "exhaust fan recalibration", siteName: "Citrus Crossing Senior Apartments", sellValue: 59, netProfit: -479, lossClass: "diagnostic_fee" },
      { jobId: "2", name: "burner replacement", siteName: "Embassy Suites #8425", sellValue: 0, netProfit: -457, lossClass: "execution" },
      { jobId: "3", name: "MUA-2 fault", siteName: "Aqua 488 HOA", sellValue: 59, netProfit: -272, lossClass: "diagnostic_fee" },
    ],
    remainder: { count: 4, netTotal: -252 },
  },
  biggestCompletions: [
    { jobId: "16709", name: "8-system boiler install", siteName: "Creekwood at River Run", completedDate: "2026-07-02", sellValue: 102986, netProfit: 47044 },
    { jobId: "17067", name: "MH-17 (recurring maintenance)", siteName: "Sunland Park", completedDate: "2026-07-06", sellValue: 15159, netProfit: 9673 },
    { jobId: "17236", name: "single boiler replacement", siteName: "JW Marriott Anaheim", completedDate: "2026-07-09", sellValue: 15141, netProfit: 11044 },
    { jobId: "17300", name: "water heater replacement", siteName: "De Soto Gardens", completedDate: "2026-07-08", sellValue: 10709, netProfit: 3865 },
  ],
  sameDayComparisons: {
    dayCount: 14,
    priorMonth: { month: "2026-06", cumulativeRevenue: 220458, jobs: 96 },
    priorYearSameMonth: { month: "2025-07", cumulativeRevenue: 148640, jobs: 117 },
  },
  freshness: {
    jobs: { pageKey: "jobs", state: "current", label: "Data current", detail: "d", dataThrough: null, lastSuccessfulRunAt: "2026-07-15T16:58:00.000Z", lastFailedRunAt: null },
    quotes: { pageKey: "quotes", state: "current", label: "Data current", detail: "d", dataThrough: null, lastSuccessfulRunAt: "2026-07-15T16:58:00.000Z", lastFailedRunAt: null },
  },
  loadError: null,
  lossesPriorMonth: { month: "2026-06", count: 111, netTotal: -25866 },
  rosterDetail: {
    technicians: [
      { employeeId: "1", name: "Roberto Villalta", mtdHours: 0, priorMonthHours: 8.5 },
      ...Array.from({ length: 8 }, (_, i) => ({
        employeeId: String(i + 2),
        name: `Tech ${i + 2}`,
        mtdHours: 102.84,
        priorMonthHours: 160,
      })),
    ],
  },
};

function render(overrides: Partial<Parameters<typeof TodayDashboard>[0]> = {}) {
  return renderToStaticMarkup(createElement(TodayDashboard, { model, ...overrides }));
}

test("today profitability band and completed-job table render from the daily payload", () => {
  const html = render();
  assert.match(html, /Net profit today/);
  assert.match(html, /\$5,100/);
  assert.match(html, /48\.8% net margin/);
  assert.match(html, /\$10,459/);
  assert.match(html, /Today&#x27;s Completed Jobs/);
  assert.match(html, /Boiler repair/);
  assert.match(html, /Diagnostic visit/);
  assert.match(html, /−\$300/);
});

test("today stays metrics-only, without action queues or loss lists", () => {
  const html = render();
  assert.match(html, /Cumulative Revenue Pace/);
  assert.match(html, /Revenue to Net/);
  assert.match(html, /Work Volume/);
  assert.match(html, /Team Capacity/);
  assert.match(html, /refreshes every minute/i);
  assert.doesNotMatch(html, /Needs a Decision|Losses So Far|Biggest Completions|Roster|quote 2457|diagnostic call|follow-up/i);
});

test("states block renders only when gated on", () => {
  const hidden = render();
  assert.match(hidden, /class="states"/);
  assert.doesNotMatch(hidden, /class="states show"/);

  const shown = render({ showStates: true });
  assert.match(shown, /class="states show"/);
  assert.match(shown, /State treatments \(design reference\)/);
  assert.match(shown, /No jobs have been completed today yet\. The screen will fill in as completions arrive\./);
});

test("load errors render the honest error treatment instead of fabricated figures", () => {
  const html = render({ model: { ...model, loadError: "boom", lossesPriorMonth: null, rosterDetail: null } });
  assert.match(html, /Today&#x27;s profitability feed could not be loaded\./);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /\$261,425/);
});

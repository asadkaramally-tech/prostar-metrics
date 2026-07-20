import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildTodayReadModel,
  DEFAULT_POOL_PERCENT,
  type TodayJobInput,
} from "../../src/lib/metrics/today";

/**
 * July 2026 MTD acceptance targets (verified live 2026-07-15, through Jul 14):
 * 101 jobs / $261,425 completed, net $139,937, 7 losses totaling -$1,460,
 * quotes sent 14 / $91,636, pool-so-far $1,307.13 at the saved 0.50% default,
 * team 822.75h vs 720h flat capacity (10 workdays x 8h x 9 roster),
 * June day-14 $220,458 / 147 jobs, Jul '25 day-14 $148,640 / 117 jobs.
 * The fixture is DB-shaped (metrics_jobs / metrics_quotes /
 * metrics_employee_timesheets rows) built from the live cohorts.
 */

type Fixture = {
  asOf: string;
  july: Array<{ id: number; name: string; completed: string; stage: string; sell: number | null; net: number; siteName: string }>;
  june: Array<{ id: number; completed: string; stage: string; sell: number | null }>;
  jul25: Array<{ id: number; completed: string; stage: string; sell: number | null }>;
  quotesSent: Array<{ id: number; approved: string; value: number }>;
  timesheets: Array<{ workDate: string; hours: number }>;
  rosterSize: number;
};

const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "tests/metrics/fixtures/today-july-2026.json"), "utf8")) as Fixture;

const jobs: TodayJobInput[] = [
  ...fixture.july.map((row) => ({
    jobId: row.id,
    name: row.name,
    completedDate: row.completed,
    stageName: row.stage,
    sellValue: row.sell,
    netProfitActual: row.net,
    siteName: row.siteName,
  })),
  ...[...fixture.june, ...fixture.jul25].map((row) => ({
    jobId: row.id,
    completedDate: row.completed,
    stageName: row.stage,
    sellValue: row.sell,
  })),
];

// 2026-07-14T19:00Z is 12:00 Pacific on July 14.
const now = new Date("2026-07-14T19:00:00Z");

const model = buildTodayReadModel({
  jobs,
  quotesSent: fixture.quotesSent.map((row) => ({ quoteId: row.id, dateApproved: row.approved, totalValue: row.value })),
  timesheets: fixture.timesheets,
  roster: { size: fixture.rosterSize, source: "effective_technician_roster" },
  now,
});

test("today model anchors on the live Pacific month", () => {
  assert.equal(model.month, "2026-07");
  assert.equal(model.asOfDate, "2026-07-14");
  assert.equal(model.elapsedDays, 14);
  assert.equal(model.daysInMonth, 31);
  assert.equal(model.timezone, "America/Los_Angeles");
  assert.equal(model.asOf, now.toISOString());
});

test("MTD KPIs reproduce the verified July figures", () => {
  assert.equal(model.mtd.jobsCount, 101);
  assert.equal(Math.round(model.mtd.revenue), 261425);
  assert.equal(Math.round(model.mtd.netProfit), 139937);
  assert.equal(Math.round((model.mtd.avgJobValue ?? 0) * 100) / 100, Math.round(model.mtd.revenue / 101 * 100) / 100);
  assert.equal(model.mtd.quotesSent, 14);
  assert.equal(Math.round(model.mtd.quotesSentValue), 91636);
  assert.match(model.mtd.quotesSentBasis, /DateApproved/);
  assert.equal(model.mtd.poolPercent, DEFAULT_POOL_PERCENT);
  assert.equal(model.mtd.poolSoFar, 1307.13);
  assert.equal(model.mtd.poolSoFarCents, 130713);
  assert.equal(model.mtd.teamRecordedHours, 822.75);
  assert.equal(model.mtd.mtdCapacityHours, 720, "10 July workdays x 8h x 9 technicians, flat rule");
  assert.match(model.mtd.capacityRule, /holidays are not deducted/i);
  assert.equal(model.mtd.rosterSize, 9);
  assert.equal(model.mtd.rosterSource, "effective_technician_roster");
});

test("daily cumulative revenue serves the live month plus both comparison months", () => {
  const { currentMonth, priorMonth, priorYearSameMonth } = model.dailyCumulativeRevenue;
  assert.equal(currentMonth.month, "2026-07");
  assert.equal(currentMonth.days.length, 14, "the live curve stops at the elapsed day");
  assert.equal(Math.round(currentMonth.days.at(-1)!.cumulativeRevenue), 261425);
  assert.equal(currentMonth.days.at(-1)!.jobs, 101);

  assert.equal(priorMonth.month, "2026-06");
  assert.equal(priorMonth.days.length, 30);
  assert.equal(Math.round(priorMonth.days[13]!.cumulativeRevenue), 220458);
  assert.equal(Math.round(priorMonth.days.at(-1)!.cumulativeRevenue), 435979);

  assert.equal(priorYearSameMonth.month, "2025-07");
  assert.equal(priorYearSameMonth.days.length, 31);
  assert.equal(Math.round(priorYearSameMonth.days[13]!.cumulativeRevenue), 148640);

  for (const series of [currentMonth.days, priorMonth.days, priorYearSameMonth.days]) {
    for (let index = 1; index < series.length; index += 1) {
      assert.ok(series[index]!.cumulativeRevenue >= series[index - 1]!.cumulativeRevenue, "cumulative curves never decrease");
    }
  }
});

test("same-day comparisons hold the prior month and prior year at the live day count", () => {
  assert.equal(model.sameDayComparisons.dayCount, 14);
  assert.equal(model.sameDayComparisons.priorMonth.month, "2026-06");
  assert.equal(Math.round(model.sameDayComparisons.priorMonth.cumulativeRevenue), 220458);
  assert.equal(model.sameDayComparisons.priorMonth.jobs, 147);
  assert.equal(model.sameDayComparisons.priorYearSameMonth.month, "2025-07");
  assert.equal(Math.round(model.sameDayComparisons.priorYearSameMonth.cumulativeRevenue), 148640);
  assert.equal(model.sameDayComparisons.priorYearSameMonth.jobs, 117);
});

test("MTD losses carry the shared classification and an honest remainder", () => {
  assert.equal(model.losses.count, 7);
  assert.equal(Math.round(model.losses.netTotal), -1460);
  assert.equal(model.losses.diagnosticFee.jobs, 2, "two $59 tickets");
  assert.equal(model.losses.execution.jobs, 5);
  assert.match(model.losses.rule, /\$59/);
  assert.equal(model.losses.top.length, 3);
  assert.equal(model.losses.top[0]?.jobId, "17221");
  assert.equal(model.losses.top[0]?.lossClass, "diagnostic_fee");
  assert.equal(model.losses.remainder.count, 4);
  assert.equal(Math.round(model.losses.remainder.netTotal), -252);
  assert.equal(Math.round(model.losses.top.reduce((sum, row) => sum + row.netProfit, 0) + model.losses.remainder.netTotal), -1460, "top rows plus remainder always sum to the total");
});

test("biggest completions rank MTD jobs by sell with net attached", () => {
  assert.equal(model.biggestCompletions.length, 5);
  assert.equal(model.biggestCompletions[0]?.jobId, "16709");
  assert.equal(model.biggestCompletions[0]?.sellValue, 102985.5);
  assert.equal(model.biggestCompletions[0]?.netProfit, 47044.24);
  for (let index = 1; index < model.biggestCompletions.length; index += 1) {
    assert.ok(model.biggestCompletions[index]!.sellValue <= model.biggestCompletions[index - 1]!.sellValue);
  }
});

test("cohort rules and windows stay honest under edge inputs", () => {
  const edge = buildTodayReadModel({
    jobs: [
      { jobId: 1, completedDate: "2026-07-05", stageName: "Complete", sellValue: 100, netProfitActual: 40 },
      { jobId: 2, completedDate: "2026-07-06", stageName: "Invoiced", sellValue: 900, netProfitActual: 40 },
      { jobId: 3, completedDate: "2026-07-20", stageName: "Complete", sellValue: 800, netProfitActual: 40 },
      { jobId: 4, completedDate: "2026-07-04", stageName: "Archived", sellValue: 50, netProfitActual: -10, sourceDeletedAt: "2026-07-05T00:00:00Z" },
    ],
    quotesSent: [
      { quoteId: 10, dateApproved: "2026-07-03", totalValue: 500 },
      { quoteId: 11, dateApproved: "2026-07-20", totalValue: 700 },
      { quoteId: 12, dateApproved: "2026-06-30", totalValue: 900 },
    ],
    timesheets: [
      { workDate: "2026-07-02", hours: 8 },
      { workDate: "2026-07-20", hours: 8 },
      { workDate: "2026-06-30", hours: 8 },
    ],
    roster: { size: 2, source: "capacity_profile_fallback" },
    now,
  });

  assert.equal(edge.mtd.jobsCount, 1, "Stage decides completion, never Status; future days and tombstones stay out");
  assert.equal(edge.mtd.revenue, 100);
  assert.equal(edge.mtd.quotesSent, 1, "quotes outside the MTD window stay out");
  assert.equal(edge.mtd.teamRecordedHours, 8);
  assert.equal(edge.mtd.mtdCapacityHours, 160, "10 workdays x 8h x 2");
  assert.equal(edge.mtd.rosterSource, "capacity_profile_fallback");
  assert.equal(edge.mtd.avgJobValue, 100);
  assert.equal(edge.losses.count, 0);
  assert.equal(edge.losses.remainder.count, 0);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildJobMonthlyReadModel,
  type IssuedQuoteInput,
  type NormalizedJobSnapshot,
} from "../../src/lib/metrics/jobs";

/**
 * June 2026 acceptance targets, verified against Simpro re-pulls (2026-07-15,
 * DEFECT-LEDGER "Verified data corrections" + per-job detail re-pull):
 *   - 272 completed jobs, $435,979 sell, $211,534 net;
 *   - 111 losses: 75 diagnostic-fee (-$16,523) vs 36 execution (-$9,342);
 *   - quote-linked labor: 73 covered of 85, 614.0h est vs 661.5h act (0.93x,
 *     +7.7% over), 12 actual-only;
 *   - direct service: 187 calls under the locked work-source rules (the
 *     mockup's "189" double-counted two recurring-plan conversions, jobs
 *     17064/16397); 39 produced a same-day quote for the same site.
 * The fixtures are DB-shaped rows (metrics_jobs post-026, metrics_quotes
 * post-041) captured from the live June cohort.
 */

type JuneJobFixture = {
  id: number;
  completed: string;
  stage: string;
  sell: number | null;
  net: number | null;
  src: "Quote" | "Recurring" | "Direct service";
  srcId: number | null;
  siteId: number | null;
  estH?: number;
  actH?: number;
};

type JuneQuoteFixture = { id: number; issued: string; siteId: number | null; value: number | null };

const fixtureDir = path.join(process.cwd(), "tests/metrics/fixtures");
const juneJobs = JSON.parse(readFileSync(path.join(fixtureDir, "june-2026-jobs.json"), "utf8")) as JuneJobFixture[];
const juneQuotes = JSON.parse(readFileSync(path.join(fixtureDir, "june-2026-issued-quotes.json"), "utf8")) as JuneQuoteFixture[];

const jobs: NormalizedJobSnapshot[] = juneJobs.map((row) => ({
  jobId: row.id,
  completedDate: row.completed,
  stageName: row.stage,
  sellValue: row.sell,
  netProfitActual: row.net,
  jobSourceType: row.src,
  jobSourceId: row.srcId,
  convertedFromType: row.src === "Direct service" ? "Direct service" : row.src,
  convertedFromId: row.srcId,
  sourceQuoteId: row.src === "Quote" ? row.srcId : null,
  siteId: row.siteId,
  laborHoursEstimate: row.estH ?? null,
  laborHoursActual: row.actH ?? null,
}));

const issuedQuotes: IssuedQuoteInput[] = juneQuotes.map((row) => ({
  quoteId: row.id,
  dateIssued: row.issued,
  siteId: row.siteId,
  totalValue: row.value,
}));

const model = buildJobMonthlyReadModel({
  jobs,
  issuedQuotes,
  periodStart: "2026-06-01",
  periodEnd: "2026-06-30",
});

test("June 2026 cohort reproduces the verified completion and financial totals", () => {
  assert.equal(model.completedJobCount, 272);
  assert.equal(Math.round(model.totalSellValue), 435979);
  assert.equal(Math.round(model.netProfitActual), 211534);
});

test("June 2026 loss classification reproduces the verified 75/36 split and dollar totals", () => {
  assert.equal(model.lossBreakdown.lossJobs, 111);
  assert.equal(Math.round(model.lossBreakdown.netTotal), -25866);
  assert.equal(model.lossBreakdown.diagnosticFee.jobs, 75);
  assert.equal(Math.round(model.lossBreakdown.diagnosticFee.netTotal), -16523);
  assert.equal(model.lossBreakdown.execution.jobs, 36);
  assert.equal(Math.round(model.lossBreakdown.execution.netTotal), -9342);
  assert.equal(model.lossRecords.length, 111);
  assert.ok(model.lossRecords.every((row) => row.lossClass === "diagnostic_fee" || row.lossClass === "execution"));
});

test("June 2026 quote-linked labor efficiency reproduces 73-of-85 at 614.0h/661.5h", () => {
  const labor = model.quoteLinkedLabor;
  assert.equal(labor.quoteLinkedJobs, 85);
  assert.equal(labor.coveredJobs, 73);
  assert.equal(labor.actualOnlyJobs, 12);
  assert.equal(Math.round(labor.estimatedHours * 10) / 10, 614.0);
  assert.equal(Math.round(labor.actualHours * 10) / 10, 661.5);
  assert.equal(Math.round((labor.efficiencyRatio ?? 0) * 100) / 100, 0.93);
  assert.equal(Math.round((labor.overrunPercent ?? 0) * 10) / 10, 7.7);
  assert.equal(labor.perJob.length, 73);
});

test("June 2026 work-source classification keeps recurring conversions out of Quote-generated", () => {
  const sources = Object.fromEntries(model.jobSourceRows.map((row) => [row.sourceType, row.jobs]));
  assert.deepEqual(sources, { "Quote-generated": 58, "Recurring": 27, "Direct service": 187 });
});

test("June 2026 follow-up conversion reproduces the verified 39 same-day quotes", () => {
  const followUps = model.directServiceFollowUps;
  assert.equal(followUps.quoteEvidenceLoaded, true);
  assert.equal(followUps.directServiceJobs, 187);
  assert.equal(followUps.jobsWithSameDayQuote, 39);
  assert.equal(followUps.jobsWithQuoteWithin30Days, 116);
  assert.equal(followUps.links.length, 116);
  assert.equal(followUps.links.filter((link) => link.sameDay).length, 39);
});

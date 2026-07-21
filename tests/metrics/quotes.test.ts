import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuoteMonthlyReadModel,
  classifyQuote,
  dealTier,
  isAcceptedOnlineStatus,
  normalizeQuoteStatusName,
  projectedMonthEndPace,
  rollingAverage,
  sameDayNormalizedYoY,
} from "../../src/lib/metrics/quotes";

test("online-only status is Accepted", () => {
  const result = classifyQuote({ quoteId: 1, totalValue: 500, statusName: " Quote Accepted Online " });
  assert.equal(result.acceptanceOutcome, "accepted");
  assert.equal(result.accepted, true);
  assert.equal(result.path, "accepted_online_only");
});

test("accepted-online normalization is exact after trim and case normalization", () => {
  assert.equal(normalizeQuoteStatusName("  QuOtE AcCePtEd OnLiNe  "), "quote accepted online");
  assert.equal(isAcceptedOnlineStatus("  QuOtE AcCePtEd OnLiNe  "), true);
  assert.equal(normalizeQuoteStatusName(" Quote: Quote Accepted Online "), "quote accepted online");
  assert.equal(isAcceptedOnlineStatus("Quote: Quote Accepted Online"), true);
  assert.equal(isAcceptedOnlineStatus("Quote Accepted Online - Pending"), false);
  assert.equal(isAcceptedOnlineStatus("Quote: Quote Accepted Online - Pending"), false);
  assert.equal(isAcceptedOnlineStatus("Accepted Online"), false);
  assert.equal(isAcceptedOnlineStatus(null), false);
});

test("converted-only direct and inverse relationships are Accepted", () => {
  for (const evidence of [
    { linkedJobId: 7001 },
    { convertedFromJobId: 7003 },
  ]) {
    const result = classifyQuote({ quoteId: 2, totalValue: 1200, ...evidence });
    assert.equal(result.acceptanceOutcome, "accepted");
    assert.equal(result.path, "converted_only");
  }
});

test("descriptive JobNo equality is never acceptance evidence", () => {
  const result = classifyQuote({
    quoteId: 22,
    totalValue: 1200,
    exactJobNoMatchId: 7002,
  });
  assert.equal(result.acceptanceOutcome, "not_accepted");
  assert.equal(result.path, "not_accepted");
});

test("online plus conversion evidence uses the combined path", () => {
  const result = classifyQuote({ quoteId: 3, totalValue: 2400, statusName: "Quote Accepted Online", linkedJobId: 9001 });
  assert.equal(result.acceptanceOutcome, "accepted");
  assert.equal(result.path, "accepted_online_and_converted");
});

test("neither evidence path is Not Accepted despite stage and legacy manual outcome", () => {
  const result = classifyQuote({
    quoteId: 4,
    totalValue: 4000,
    dateApproved: "2026-06-12",
    stageName: "Approved",
    customerStageName: "Accepted",
    outcomeOverride: "won",
    wonOverride: true,
  });
  assert.equal(result.acceptanceOutcome, "not_accepted");
  assert.equal(result.accepted, false);
  assert.equal(result.path, "not_accepted");
});

test("explicit Excluded override takes precedence over acceptance evidence", () => {
  const result = classifyQuote({
    quoteId: 5,
    totalValue: 900,
    statusName: "Quote Accepted Online",
    linkedJobId: 9100,
    outcomeOverride: "excluded",
  });
  assert.equal(result.acceptanceOutcome, "excluded");
  assert.equal(result.path, "excluded");
});

test("monthly model uses DateIssued and the exact non-excluded denominator", () => {
  const model = buildQuoteMonthlyReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    quotes: [
      { quoteId: 1, totalValue: 100, dateIssued: "2026-06-01", dateApproved: "2026-07-01", statusName: "Quote Accepted Online" },
      { quoteId: 2, totalValue: 200, dateIssued: "2026-06-02", linkedJobId: 80 },
      { quoteId: 3, totalValue: 300, dateIssued: "2026-06-03", dateApproved: "2026-05-03" },
      { quoteId: 4, totalValue: 400, dateIssued: "2026-06-04", statusName: "Quote Accepted Online", outcomeOverride: "excluded" },
      { quoteId: 5, totalValue: 500, dateIssued: "2026-06-05", statusName: "Quote Accepted Online" },
      { quoteId: 6, totalValue: 600, dateIssued: "2026-05-31", linkedJobId: 81 },
      { quoteId: 7, totalValue: 700, dateApproved: "2026-06-07", linkedJobId: 82 },
    ],
  });

  assert.equal(model.dateBasis, "DateIssued");
  assert.equal(model.quoteCount, 4);
  assert.equal(model.acceptedCount, 3);
  assert.equal(model.notAcceptedCount, 1);
  assert.equal(model.acceptanceDenominatorCount, 4);
  assert.equal(model.quoteValue, 1100);
  assert.equal(model.acceptedValue, 800);
  assert.equal(model.notAcceptedValue, 300);
  assert.equal(model.acceptanceRateByCount, 75);
  assert.equal(model.acceptanceRateByValue, 800 / 1100 * 100);
  assert.equal(model.excludedCount, 1);
  assert.equal(model.excludedWithoutDateIssued, 1);
  assert.equal(model.acceptancePaths.not_accepted, 1);
});

test("deal tiers and time helpers preserve locked boundaries", () => {
  assert.equal(dealTier(749.99), "Under $750");
  assert.equal(dealTier(750), "$750-$2K");
  assert.equal(dealTier(2000), "$2K-$10K");
  assert.equal(dealTier(10000), "$10K+");
  assert.equal(projectedMonthEndPace({ actualToDate: 10, elapsedDays: 5, daysInMonth: 30 }), 60);
  assert.equal(sameDayNormalizedYoY(15, 10), 50);
  assert.deepEqual(rollingAverage([10, 20, 30, 40], 3), [null, null, 20, 30]);
});

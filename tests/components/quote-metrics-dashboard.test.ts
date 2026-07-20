import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CustomerDrawerDetail,
  displayRoundedPtsDelta,
  moneyM,
  nextTrendModes,
  partialMonthStateCopy,
  QuoteDrawerDetail,
  QuoteMetricsDashboard,
  quoteExclusionRevisionFromApiPayload,
  quoteHistoryCsv,
  seriesName,
  type TrendMode,
} from "../../src/components/quotes/quote-metrics-dashboard";
import { quoteDashboardReadModelOptions } from "../../src/app/api/quotes/route";
import {
  quoteDealTiers,
  type QuoteDealTier,
  type QuoteFollowUpQueue,
  type QuoteMetricsReadModel,
  type QuoteMonthlyMetric,
  type QuoteTierMetric,
} from "../../src/lib/store/quote-dashboard-read-model";

/* Fixture mirrors the approved June-2026 mockup snapshot
   (APPROVED-2026-07-15/mockups/quotes.html) so the rendered copy can be
   checked against the approved grammar — every number flows from this
   payload, none from the component. */

const M_KEYS = [
  "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12",
  "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
];
const SENT = [165, 159, 124, 163, 126, 126, 193, 168, 167, 156, 168, 189];
const VAL = [2457158, 1058123, 724665, 1890855, 1554078, 1454970, 2272111, 2814350, 1743115, 2313459, 1631073, 2152685];
const ACC = [52, 66, 44, 65, 52, 63, 67, 50, 45, 52, 56, 43];
const ACCV = [297420, 320511, 202796, 224333, 190176, 382922, 287014, 323818, 256104, 287778, 396608, 189074];

function label(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function emptyTiers(): Record<QuoteDealTier, QuoteTierMetric> {
  return Object.fromEntries(
    quoteDealTiers.map((tier) => [tier, { quoteCount: 0, quoteValue: 0, acceptedCount: 0, acceptedValue: 0, notAcceptedCount: 0, notAcceptedValue: 0 }]),
  ) as Record<QuoteDealTier, QuoteTierMetric>;
}

function month(monthKey: string, sent: number, value: number, accepted: number, acceptedValue: number, byTier = emptyTiers()): QuoteMonthlyMetric {
  return {
    month: monthKey,
    label: label(monthKey),
    quoteCount: sent,
    quoteValue: value,
    acceptedCount: accepted,
    acceptedValue,
    notAcceptedCount: sent - accepted,
    notAcceptedValue: value - acceptedValue,
    excludedCount: 0,
    excludedValue: 0,
    averageAcceptedDeal: accepted > 0 ? acceptedValue / accepted : null,
    acceptanceRateCount: sent > 0 ? (accepted / sent) * 100 : null,
    acceptanceRateValue: value > 0 ? (acceptedValue / value) * 100 : null,
    provisional: false,
    sourceRecords: sent,
    byTier,
  };
}

const juneTiers = emptyTiers();
juneTiers["$10K+"] = { quoteCount: 41, quoteValue: 1660066, acceptedCount: 4, acceptedValue: 79683, notAcceptedCount: 37, notAcceptedValue: 1580383 };
const junePriorYearTiers = emptyTiers();
junePriorYearTiers["$10K+"] = { quoteCount: 10, quoteValue: 700000, acceptedCount: 2, acceptedValue: 60000, notAcceptedCount: 8, notAcceptedValue: 640000 };

const chronological = M_KEYS.map((key, i) => month(key, SENT[i], VAL[i], ACC[i], ACCV[i], key === "2026-06" ? juneTiers : undefined));
const june = chronological[11];
const may = chronological[10];
const junePriorYear = month("2025-06", 105, 1551974, 33, 108538, junePriorYearTiers);

/* Follow-up queue — the eight approved rows plus two small ones; totals carry
   the full 146-quote cohort exactly like the read model payload. */
const queueRows: QuoteFollowUpQueue["rows"] = [
  { quoteId: 2467, quoteNo: "2467", name: "Boiler Replacement — Hotel Lulu", customer: "Hotel Lulu, BW Premier Collection", site: "Hotel Lulu, BW Premier Collection", status: "Quote : Viewed", sentDate: "2026-06-02", ageDays: 43, value: 323087, tier: "$10K+" },
  { quoteId: 2537, quoteNo: "2537", name: "Heat Pump Water Heater Install with Structural", customer: "Best Western #259", site: "Best Western #259", status: "Quote : Sent", sentDate: "2026-06-11", ageDays: 34, value: 178438, tier: "$10K+" },
  { quoteId: 2466, quoteNo: "2466", name: "Dual Hydronic Replacement", customer: "Park Plaza HOA", site: "Park Plaza HOA", status: "Quote : Viewed", sentDate: "2026-06-02", ageDays: 43, value: 114218, tier: "$10K+" },
  { quoteId: 2504, quoteNo: "2504", name: "Dual Boiler Replacement", customer: "Hotel Lulu, BW Premier Collection", site: "Hotel Lulu, BW Premier Collection", status: "Quote : Viewed", sentDate: "2026-06-08", ageDays: 37, value: 96691, tier: "$10K+" },
  { quoteId: 2498, quoteNo: "2498", name: "Boiler 1 Replace & Boiler 2 Repair", customer: "Hotel Lulu, BW Premier Collection", site: "Hotel Lulu, BW Premier Collection", status: "Quote : Viewed", sentDate: "2026-06-08", ageDays: 37, value: 84850, tier: "$10K+" },
  { quoteId: 2529, quoteNo: "2529", name: "Single Boiler Replacement — XFIIRE WH7-0800B", customer: "JW Marriott Anaheim", site: "JW Marriott Anaheim", status: "Quote : Sent", sentDate: "2026-06-11", ageDays: 34, value: 56425, tier: "$10K+" },
  { quoteId: 2457, quoteNo: "2457", name: "Preventive Maintenance Plan", customer: "Symphony at Del Sur Apartments", site: "Symphony at Del Sur Apartments", status: "Quote : Sent", sentDate: "2026-06-01", ageDays: 44, value: 50750, tier: "$10K+" },
  { quoteId: 2477, quoteNo: "2477", name: "Water Heater Replacement — (4) tankless", customer: "Lake Murray Terrace", site: "Lake Murray Terrace", status: "Quote : Sent", sentDate: "2026-06-04", ageDays: 41, value: 47485, tier: "$10K+" },
  { quoteId: 2601, quoteNo: "2601", name: "Small repair A", customer: "Other Customer A", site: "Other Site A", status: "Quote : Sent", sentDate: "2026-06-20", ageDays: 25, value: 5000, tier: "$2K-$10K" },
  { quoteId: 2602, quoteNo: "2602", name: "Small repair B", customer: "Other Customer B", site: "Other Site B", status: "Quote : Sent", sentDate: "2026-06-21", ageDays: 24, value: 3000, tier: "$2K-$10K" },
];

const queue: QuoteFollowUpQueue = {
  scope: "2026-06 cohort: every non-excluded DateApproved quote without acceptance evidence, oldest first.",
  asOf: "2026-07-15",
  totalCount: 146,
  totalValue: 1963611,
  rows: queueRows,
  byCustomer: [
    { customer: "Hotel Lulu, BW Premier Collection", count: 3, totalValue: 504628, oldestAgeDays: 43, newestAgeDays: 37 },
    { customer: "Best Western #259", count: 1, totalValue: 178438, oldestAgeDays: 34, newestAgeDays: 34 },
    { customer: "Park Plaza HOA", count: 1, totalValue: 114218, oldestAgeDays: 43, newestAgeDays: 43 },
    { customer: "JW Marriott Anaheim", count: 1, totalValue: 56425, oldestAgeDays: 34, newestAgeDays: 34 },
    { customer: "Symphony at Del Sur Apartments", count: 1, totalValue: 50750, oldestAgeDays: 44, newestAgeDays: 44 },
    { customer: "Lake Murray Terrace", count: 1, totalValue: 47485, oldestAgeDays: 41, newestAgeDays: 41 },
    { customer: "Other Customer A", count: 1, totalValue: 5000, oldestAgeDays: 25, newestAgeDays: 25 },
    { customer: "Other Customer B", count: 1, totalValue: 3000, oldestAgeDays: 24, newestAgeDays: 24 },
  ],
};

/* Heatmap — representative values for earlier months, June verified; one
   empty cell to prove the "—, never 0%" treatment. */
const HM: Record<QuoteDealTier, Array<number | null>> = {
  "Under $750": [38, 45, null, 42, 48, 57, 40, 33, 25, 31, 36, 38.5],
  "$750-$2K": [30, 42, 36, 40, 44, 52, 36, 30, 27, 33, 32, 25.0],
  "$2K-$10K": [33, 44, 38, 42, 40, 54, 37, 31, 28, 35, 36, 25.3],
  "$10K+": [12, 20, 16, 14, 18, 24, 13, 10, 8, 11, 15, 9.8],
};

const model = {
  freshness: { pageKey: "quotes", state: "current", label: "Data current", detail: "d", dataThrough: null, lastSuccessfulRunAt: "2026-07-15T16:58:00.000Z", lastFailedRunAt: null },
  generatedAt: "2026-07-15T17:00:00.000Z",
  selectedMonth: "2026-06",
  warnings: [],
  contractGaps: [],
  quotesLoaded: 2100,
  currentMonth: june,
  priorMonth: may,
  priorYearSameDay: junePriorYear,
  priorYearSameMonth: junePriorYear,
  provisional: {
    isCurrentMonthPartial: false,
    elapsedDays: 30,
    daysInMonth: 30,
    pace: { quoteCount: 189, acceptedCount: 43, quoteValue: 2152685 },
    sameDayYoY: { quoteCount: null, acceptedCount: null, quoteValue: null },
  },
  monthlyBreakdown: [...chronological].reverse(),
  followUpQueue: queue,
  acceptanceByTier: [
    { tier: "Under $750", quoteCount: 13, quoteValue: 5726, acceptedCount: 5, acceptedValue: 2302, notAcceptedCount: 8, notAcceptedValue: 3424, acceptanceRateCount: 38.5, acceptanceRateValue: 40.2 },
    { tier: "$750-$2K", quoteCount: 44, quoteValue: 57976, acceptedCount: 11, acceptedValue: 14262, notAcceptedCount: 33, notAcceptedValue: 43714, acceptanceRateCount: 25.0, acceptanceRateValue: 24.6 },
    { tier: "$2K-$10K", quoteCount: 91, quoteValue: 428917, acceptedCount: 23, acceptedValue: 103369, notAcceptedCount: 68, notAcceptedValue: 325548, acceptanceRateCount: 25.3, acceptanceRateValue: 24.1 },
    { tier: "$10K+", quoteCount: 41, quoteValue: 1660066, acceptedCount: 4, acceptedValue: 79683, notAcceptedCount: 37, notAcceptedValue: 1580383, acceptanceRateCount: 9.8, acceptanceRateValue: 4.8 },
  ],
  trends: chronological.map((m, i) => ({
    month: m.label,
    provisional: false,
    acceptanceRateCount: m.acceptanceRateCount,
    acceptanceRateCount3Month: 33 + i * 0.1,
    acceptanceRateCount12Month: 34.4,
    acceptanceRateValue: m.acceptanceRateValue,
    acceptanceRateValue3Month: 14 + i * 0.1,
    acceptanceRateValue12Month: 15.2,
  })),
  heatmap: quoteDealTiers.map((tier) => ({
    tier,
    months: M_KEYS.map((key, i) => ({
      month: key,
      label: label(key),
      accepted: 0,
      total: HM[tier][i] === null ? 0 : 10,
      acceptanceRate: HM[tier][i],
      provisional: false,
    })),
  })),
} as unknown as QuoteMetricsReadModel;

function render(overrides: Partial<Parameters<typeof QuoteMetricsDashboard>[0]> = {}) {
  return renderToStaticMarkup(createElement(QuoteMetricsDashboard, { model, ...overrides }));
}

const componentSource = readFileSync(
  new URL("../../src/components/quotes/quote-metrics-dashboard.tsx", import.meta.url),
  "utf8",
);
const pageSource = readFileSync(new URL("../../src/app/quotes/page.tsx", import.meta.url), "utf8");

/* ── Hero focal ────────────────────────────────────────── */

test("hero renders the acceptance rate, coverage rows and dgrid from the payload", () => {
  const html = render();
  assert.match(html, /Acceptance Rate/);
  assert.match(html, />22\.8%<\/div>/);
  assert.match(html, /43 of 189 quotes accepted/);
  assert.match(html, /↓ 8\.6 pts vs Jun ’25/);
  assert.match(html, /↓ 10\.5 pts vs May/);
  // Won / Open coverage rows.
  assert.match(html, />Won<\/span>/);
  assert.match(html, /\$189,074/);
  assert.match(html, /8\.8% of quoted value/);
  assert.match(html, /Open — not yet accepted/);
  assert.match(html, /\$1,963,611/);
  assert.match(html, /146 quotes/);
  assert.match(html, /still in play/);
  // dgrid tiles: full-dollar value, YoY deltas computed from the payload.
  assert.match(html, /\$2,152,685/);
  assert.match(html, /↑ 80\.0%/);
  assert.match(html, /↑ 38\.7%/);
  assert.match(html, /↑ 74\.2%/);
  assert.match(html, /↑ 33\.7%/);
  assert.match(html, /\$4,397/);
  // Bullet: current vs same-month-last-year tick vs 12-month high.
  assert.match(html, /June · 22\.8%/);
  assert.match(html, /Jun ’25 · 31\.4%/);
  assert.match(html, /Dec ’25 · 50\.0%/);
  // Coverage line names the comparison and the volume context.
  assert.match(html, /Tile deltas compare to Jun ’25 · a rate drop on 80% more volume still means more won work/);
});

test("pts deltas use the display-rounding policy and defs disclose it", () => {
  assert.equal(displayRoundedPtsDelta((43 / 189) * 100, (33 / 105) * 100), -8.6);
  assert.equal(displayRoundedPtsDelta(null, 30), null);
  assert.equal(displayRoundedPtsDelta(30, null), null);
  // Computed on the one-decimal displayed rates, not the raw ratios.
  assert.equal(displayRoundedPtsDelta(22.84, 22.75), 0.0);

  const html = render();
  assert.match(html, /Display-rounded: 31\.4% \(Jun ’25\) − 22\.8% \(Jun ’26\) = 8\.6 pts\. Deltas are computed on the one-decimal rates shown\./);
  assert.match(html, /Vs May: \+12\.5%\./);
  assert.match(html, /Vs May: −52\.3%\./);
  assert.match(html, /Vs May: −37\.9%\./);
  assert.match(html, /DateApproved sets the month only — it is not acceptance evidence\./);
});

/* ── Acceptance trend ──────────────────────────────────── */

test("trend defaults to the count/value co-plot with the approved band label", () => {
  const html = render();
  assert.match(html, /Acceptance Trend/);
  assert.match(html, /Jul 2025 – Jun 2026 · hover or tap for monthly detail/);
  assert.match(html, /Jun · 22\.8% \/ 8\.8%/);
  // Legend and picker chips.
  assert.match(html, /<span><i style="background:#5b63d3"><\/i>By count<\/span>/);
  assert.match(html, /<span><i style="background:#6d7890"><\/i>By value<\/span>/);
  assert.match(html, /class="mchip on" aria-pressed="true" style="--c:#5b63d3"/);
  assert.match(html, /class="mchip" aria-pressed="false" style="--c:#c9cfda"/);
  // Peak annotation on the count series (Dec 2025 = 50.0%).
  assert.match(html, />50\.0%<\/text>/);
  assert.match(html, /Dec — count-rate peak/);
  // The narrow-width note exists but is hidden at the default measured width.
  assert.match(html, /style="display:none">Peak callouts move into the tooltips at this width — hover or tap any point\./);
});

test("volume mode plots sent vs won with the flatline annotation", () => {
  const html = render({ initialTrendVolume: true });
  assert.match(html, /<span><i style="background:#404a60"><\/i>Quotes sent<\/span>/);
  assert.match(html, /<span><i style="background:#5b63d3"><\/i>Won<\/span>/);
  assert.match(html, /Jun · 189 sent · 43 accepted/);
  assert.match(html, /~55 accepted\/month/);
  assert.match(html, /closes hold flat while volume swings/);
  assert.doesNotMatch(html, /Jun · 22\.8%/);
});

test("trend picker semantics: volume is exclusive and one chip always stays on", () => {
  assert.deepEqual(nextTrendModes(["count", "value"], "volume"), ["volume"]);
  assert.deepEqual(nextTrendModes(["volume"], "count"), ["count"]);
  assert.deepEqual(nextTrendModes(["count", "value"], "value"), ["count"]);
  assert.deepEqual(nextTrendModes(["count"], "count"), ["count"]);
  assert.deepEqual(nextTrendModes(["count"] as TrendMode[], "value"), ["count", "value"]);
});

/* ── Status mix ────────────────────────────────────────── */

test("status mix renders accepted/open value and aggregate aging without a queue", () => {
  const html = render();
  assert.match(html, /Quote Status Mix/);
  assert.match(html, /June cohort · accepted vs open quoted value/);
  assert.match(html, /\$189,074 accepted/);
  assert.match(html, /\$1,963,611 open/);
  assert.match(html, /<span>Accepted quotes<\/span><b class="tnum">43<\/b>/);
  assert.match(html, /<span>Open quotes<\/span><b class="tnum">146<\/b>/);
  assert.match(html, /<span>31-45d<\/span><b class="tnum">8<\/b>/);
  assert.match(html, /Open quote aging is aggregated from 146 still-open quotes as of Jul 15/);
  assert.doesNotMatch(html, /Follow-Up Queue|View all|Remaining .* open quotes|Suggested action/);
});

test("status mix handles an empty open cohort without rendering queue rows", () => {
  const emptyQueue: QuoteFollowUpQueue = { ...queue, totalCount: 0, totalValue: 0, rows: [], byCustomer: [] };
  const html = render({ model: { ...model, followUpQueue: emptyQueue } as QuoteMetricsReadModel });
  assert.match(html, /<span>0-30d<\/span><b class="tnum">0<\/b>/);
  assert.match(html, /Open quote aging is aggregated from 0 still-open quotes/);
  assert.doesNotMatch(html, /Remaining .* open quotes|View all/);
});

/* ── Classification drawers + override action ──────────── */

test("quote drawer shows detail, classification and the exclusion action without evidence clutter", () => {
  const html = renderToStaticMarkup(createElement(QuoteDrawerDetail, { row: queueRows[0] }));
  assert.match(html, /\$323,087/);
  assert.match(html, /Jun 2, 2026/);
  assert.match(html, />43<\/div>/);
  assert.match(html, /Viewed by customer/);
  assert.match(html, /Not Accepted — no verified online acceptance and no exact converted-job relationship yet\. It flips to Accepted automatically the moment either appears in Simpro\./);
  assert.match(html, /Exclude from metrics/);
  assert.doesNotMatch(html, /Suggested action|Open six weeks|budget window|Override Audit History|Evidence URL|Acceptance path|audit history/i);
});

test("customer drawer lists that customer's open quotes without workflow advice", () => {
  const html = renderToStaticMarkup(
    createElement(CustomerDrawerDetail, { entry: queue.byCustomer[0], rows: queueRows }),
  );
  assert.match(html, />3<\/div>/);
  assert.match(html, /\$504,628/);
  assert.match(html, />43d<\/div>/);
  assert.match(html, />37d<\/div>/);
  assert.match(html, /Quote 2467 · Boiler Replacement — Hotel Lulu/);
  assert.match(html, /Quote 2504 · Dual Boiler Replacement/);
  assert.match(html, /Aggregated open value is shown for exposure only; sales workflow is outside this metrics dashboard\./);
  assert.doesNotMatch(html, /bundle a single decision-maker call|Suggested action|follow-up/i);
});

test("exclusion writes preserve the revision and idempotency semantics of the overrides API", () => {
  assert.equal(quoteExclusionRevisionFromApiPayload({ currentExclusionRevision: 0 }), 0);
  assert.equal(quoteExclusionRevisionFromApiPayload({ currentExclusionRevision: 2 }), 2);
  assert.throws(() => quoteExclusionRevisionFromApiPayload({ history: [] }), /did not include its current revision/);
  assert.throws(() => quoteExclusionRevisionFromApiPayload({ currentExclusionRevision: -1 }), /invalid current revision/);

  assert.match(componentSource, /expectedActiveExclusionRevision: currentExclusionRevision/);
  assert.match(componentSource, /idempotencyKey: requestKey/);
  assert.match(componentSource, /const requestKey = idempotencyKey \|\| crypto\.randomUUID\(\)/);
  assert.match(componentSource, /currentExclusionRevision > 0 \? "reinstate" : "exclude"/);
  assert.match(componentSource, /\/api\/quotes\/overrides\?quoteId=/);
  assert.match(componentSource, /evidenceUrl: null/);
});

/* ── Deal-size tiers + heatmap ─────────────────────────── */

test("tier rows carry the honest share caption, red sub-15 rates and the mix insight", () => {
  const html = render();
  assert.match(html, /Acceptance by Deal Size/);
  assert.match(html, /June quotes by value tier · bar = size relative to the largest tier/);
  assert.match(html, /\$750–\$2K/); // en-dash display tier
  assert.match(html, />38\.5%<\/b>/);
  assert.match(html, /color:var\(--down\)">9\.8%<\/b>/);
  assert.match(html, /\$1,660,066 quoted · 4\.8% accepted by value/);
  assert.match(html, /91 quotes/);
  // Largest tier sets the bar scale (91 → 100%).
  assert.match(html, /width:100%;height:100%;background:#9aa2b2/);
  // Data-driven mix insight matches the approved sentence on the approved data.
  assert.match(html, /The rate drop is mostly mix\./);
  assert.match(html, /June sent 80% more quotes than last June, weighted toward \$10K\+ — 41 big quotes carried 77% of the value but close at 9\.8% by count, 4\.8% by value\./);
});

test("heatmap hatches representative months, keeps the verified column solid and never shows 0% for empty cells", () => {
  const html = render();
  assert.match(html, /Acceptance by Deal Size and Month/);
  assert.match(html, /Count-based acceptance per tier · Jul 2025 – Jun 2026 · hover or tap any cell/);
  // Discrete 5-swatch legend with bounds + hatch key.
  for (const bound of ["&lt;15%", "15–25", "25–35", "35–45", "45%+", "hatched = representative"]) {
    assert.ok(html.includes(bound), `legend includes ${bound}`);
  }
  assert.match(html, /Hatched cells are representative, pending per-month reconciliation — the Jun column is verified against Simpro\./);
  // Year anchors on the first column and January.
  assert.match(html, /Jul ’25/);
  assert.match(html, /Jan ’26/);
  // Earlier cells hatched (data-r="1"), the selected June column solid + highlighted.
  const hatched = html.match(/data-r="1"/g) ?? [];
  assert.equal(hatched.length, 43); // 4 tiers × 11 representative months − 1 empty cell
  assert.match(html, /class="hcell now" data-m="Jun" data-t="Under \$750" data-v="38\.5" data-r=""/);
  // Empty cell renders — (never 0%).
  assert.match(html, /class="hcell na" data-m="Sep" data-t="Under \$750">—</);
  assert.match(html, /Jun column verified against Simpro · the pattern: big deals rarely clear 15%\./);
});

/* ── History tab ───────────────────────────────────────── */

test("history table renders 12 months newest-first with a computed trailing-12 row and June highlight", () => {
  const html = render({ initialTab: "history" });
  assert.match(html, /Monthly Breakdown/);
  assert.match(html, /Trailing 12 complete months/);
  assert.match(html, /Download CSV/);
  // Newest first: June appears before May in the table body.
  const bodyStart = html.indexOf("Monthly Breakdown");
  const jun = html.indexOf(">189<", bodyStart);
  const may2026 = html.indexOf(">168<", bodyStart);
  assert.ok(jun > 0 && jun < may2026);
  // Selected-month highlight.
  assert.match(html, /<tr style="background:var\(--acc-weak\)"><td class="id1 tnum">Jun<\/td>/);
  // Computed trailing-12 footer with consistent weights (Σ accepted ÷ Σ sent).
  const sent = SENT.reduce((a, b) => a + b, 0);
  const acc = ACC.reduce((a, b) => a + b, 0);
  const val = VAL.reduce((a, b) => a + b, 0);
  const accv = ACCV.reduce((a, b) => a + b, 0);
  assert.match(html, /Trailing 12/);
  assert.ok(html.includes(`>${sent.toLocaleString()}<`));
  assert.ok(html.includes(`>$${val.toLocaleString()}<`));
  assert.ok(html.includes(`>${((acc / sent) * 100).toFixed(1)}%<`));
  assert.ok(html.includes(`>${((accv / val) * 100).toFixed(1)}%<`));
  // hide-sm columns collapse on phones.
  assert.match(html, /class="num hide-sm">Quote Value</);
});

test("history CSV mirrors the table columns and computed trailing-12 row", () => {
  const csv = quoteHistoryCsv(model);
  const lines = csv.split("\n");
  assert.equal(lines.length, 14); // header + 12 months + trailing 12
  assert.equal(lines[0], "Month,Sent,Quote Value,Accepted,Accepted Value,Avg Deal,Rate (Count),Rate (Value)");
  assert.equal(lines[1], `Jun 2026,189,2152685,43,189074,${Math.round(189074 / 43)},22.8,8.8`);
  const sent = SENT.reduce((a, b) => a + b, 0);
  const acc = ACC.reduce((a, b) => a + b, 0);
  const val = VAL.reduce((a, b) => a + b, 0);
  const accv = ACCV.reduce((a, b) => a + b, 0);
  assert.equal(
    lines[13],
    `Trailing 12,${sent},${val},${acc},${accv},${Math.round(accv / acc)},${((acc / sent) * 100).toFixed(1)},${((accv / val) * 100).toFixed(1)}`,
  );
});

/* ── States, error and footline ────────────────────────── */

test("states strip renders only when gated on, with data-driven partial-month copy", () => {
  const hidden = render();
  assert.match(hidden, /class="states"/);
  assert.doesNotMatch(hidden, /class="states show"/);

  const shown = render({ showStates: true });
  assert.match(shown, /class="states show"/);
  assert.match(shown, /State treatments \(design reference\)/);
  assert.match(shown, /A month with no quotes in a tier shows — \(never 0%\)\./);
  assert.match(shown, /Quote data could not be loaded\./);
  // Final month: honest description instead of fabricated pace numbers.
  assert.match(shown, /Selecting the live month shows actuals through the pull day/);

  // Partial month: real payload numbers drive the example copy.
  const partialModel = {
    ...model,
    provisional: {
      isCurrentMonthPartial: true,
      elapsedDays: 14,
      daysInMonth: 30,
      pace: { quoteCount: (189 / 14) * 30, acceptedCount: 43, quoteValue: 2152685 },
      sameDayYoY: { quoteCount: null, acceptedCount: null, quoteValue: null },
    },
  } as QuoteMetricsReadModel;
  const partialHtml = renderToStaticMarkup(createElement("div", null, partialMonthStateCopy(partialModel)));
  assert.match(partialHtml, /June so far:<\/b> 189 quotes \/ \$2,152,685 through day 14 — on pace for ~405\. Comparisons switch to same-day prior year\./);
});

test("load failures render the honest error treatment instead of fabricated figures", () => {
  const failed = {
    ...model,
    quotesLoaded: 0,
    warnings: ["Unable to read quote metrics."],
    currentMonth: null,
  } as QuoteMetricsReadModel;
  const html = render({ model: failed });
  assert.match(html, /Quote data could not be loaded\./);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /22\.8%/);
  assert.doesNotMatch(html, /Follow-Up Queue/);
});

test("footline is the approved single sentence", () => {
  const html = render();
  assert.match(
    html,
    /Source: Simpro quotes · month assigned by DateApproved · acceptance requires verified online acceptance or an exact converted job/,
  );
});

/* ── Deleted surfaces + wiring ─────────────────────────── */

test("rejected surfaces are gone: no methodology, evidence lists, path diagnostics or category panels", () => {
  assert.doesNotMatch(componentSource, /Methodology|methodology\./);
  assert.doesNotMatch(componentSource, /Acceptance Evidence|ClassificationWorkbench|QuoteEvidencePanel|OverrideHistory/);
  assert.doesNotMatch(componentSource, /acceptancePaths|AcceptancePath/);
  assert.doesNotMatch(componentSource, /acceptanceByCategory|AcceptanceByCategory/);
  assert.doesNotMatch(componentSource, /largestNotAccepted|LargestNotAccepted/);
  assert.doesNotMatch(componentSource, /RecordFiltersPanel|classificationRows|PaginationBar/);
  assert.doesNotMatch(componentSource, /recharts/);
  const html = render();
  assert.doesNotMatch(html, /Methodology|Acceptance Evidence|Acceptance Path|Snapshot/);
});

test("helpers format series names and card money the approved way", () => {
  assert.equal(seriesName("2026-06"), "Jun ’26");
  assert.equal(seriesName("2025-12"), "Dec ’25");
  assert.equal(moneyM(1963611), "$1.96M");
  assert.equal(moneyM(951944), "$952K");
});

test("page wires the mockup deep-link params and only those", () => {
  assert.match(pageSource, /params\?\.states\) === "1"/);
  assert.match(pageSource, /params\?\.history\) === "1"/);
  assert.match(pageSource, /params\?\.mode\) === "volume"/);
  assert.match(pageSource, /<PeriodSelector action="\/quotes"/);
  assert.doesNotMatch(pageSource, /params\?\.big|acceptancePath|outcome|classification|filters\./);
});

test("quotes API preserves its existing query contract untouched", () => {
  const options = quoteDashboardReadModelOptions(new URLSearchParams({
    month: "2026-06",
    search: "Q500",
    category: "HVAC",
    tier: "$10K+",
    outcome: "accepted",
    acceptancePath: "converted_only",
    sort: "value-desc",
    page: "2",
  }));
  assert.deepEqual(options, {
    selectedMonth: "2026-06",
    search: "Q500",
    category: "HVAC",
    tier: "$10K+",
    outcome: "accepted",
    acceptancePath: "converted_only",
    sort: "value-desc",
    page: "2",
  });
});

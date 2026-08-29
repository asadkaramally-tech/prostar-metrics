import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  monthlySalesAxisLabel,
  MonthlySalesColumns,
  monthlySalesMonthName,
  monthlySalesStatusText,
  monthlySalesTargetLabel,
  nextMonthlySalesFocus,
  niceMonthlySalesAxisMax,
  type MonthlySalesPoint,
} from "../../src/components/charts/monthly-sales-columns";

function history(count: number): MonthlySalesPoint[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2023, index, 1));
    return {
      periodStart: date.toISOString().slice(0, 10),
      sales: 95000 + index * 2000,
      status: "complete" as const,
    };
  });
}

const POINTS: MonthlySalesPoint[] = [
  { periodStart: "2026-01-01", sales: 100000, status: "complete" },
  { periodStart: "2026-02-01", sales: null, status: "missing" },
  { periodStart: "2026-03-01", sales: null, status: "failed" },
  {
    periodStart: "2026-04-01", sales: 120000, status: "complete", partial: true, elapsedDays: 18, daysInMonth: 30,
    comparatorLabel: "April 2025, day 18", comparatorSales: 90000,
  },
];

test("monthly sales columns render one monetary series, selected emphasis, partial hatch, and honest coverage gaps", () => {
  const html = renderToStaticMarkup(createElement(MonthlySalesColumns, {
    points: POINTS,
    selectedPeriodStart: "2026-04-01",
    onSelectPeriod: () => {},
    width: 560,
  }));

  assert.match(html, /aria-label="Monthly material sales"/);
  assert.match(html, /<svg[^>]*role="group"[^>]*aria-label="Monthly material sales"/,
    "interactive month controls remain exposed inside a group, not hidden under an image role");
  assert.doesNotMatch(html, /<svg[^>]*role="img"/);
  assert.match(html, /Monthly material sales in dollars/, "the chart describes its sole monetary series");
  assert.match(html, /monthly-sales-hatch-/, "partial months use a visible hatch rather than a full-month fill");
  assert.match(html, /fill="rgba\(91,99,211,.07\)"/, "selected month gets a contextual selection band");
  assert.match(html, /Data walk failed/, "failed month has a semantic coverage state");
  assert.match(html, /No completed data/, "missing month is not rendered as zero sales");
  assert.match(html, /Monthly sales data \(4 months\)/, "an accessible disclosure is always available");
  assert.match(html, /<table class="msc-table">/, "disclosure contains real tabular data");
  assert.match(html, /April 2025, day 18 · \$90,000/, "the comparison is disclosed outside the hover tooltip");
  assert.doesNotMatch(html, /Quantity sold|quantity/i, "the component cannot accidentally reintroduce a mixed-unit series");
});

test("monthly targets have exact names including selection, coverage, and partial-day context", () => {
  assert.equal(
    monthlySalesTargetLabel(POINTS[3], true),
    "Select April 2026, $120,000 month to date (day 18 of 30), selected, compared with April 2025, day 18: $90,000",
  );
  assert.equal(monthlySalesTargetLabel(POINTS[1], false), "Select February 2026, No completed data");
  assert.equal(monthlySalesTargetLabel(POINTS[2], false), "Select March 2026, Data walk failed");
  assert.equal(monthlySalesStatusText(POINTS[0]), "$100,000 full month");

  const html = renderToStaticMarkup(createElement(MonthlySalesColumns, {
    points: POINTS,
    selectedPeriodStart: "2026-04-01",
    onSelectPeriod: () => {},
    width: 560,
  }));
  assert.match(html, /role="button" tabindex="0" aria-label="Select April 2026, \$120,000 month to date \(day 18 of 30\), selected, compared with April 2025, day 18: \$90,000" aria-current="true"/);
  const tabStops = html.match(/tabindex="0"/g) ?? [];
  assert.equal(tabStops.length, 1, "only the selected target is in the tab order");
});

test("arrow-key focus movement stays inside the supplied range and Enter/Space remain separate selection actions", () => {
  assert.equal(nextMonthlySalesFocus(1, "ArrowRight", 4), 2);
  assert.equal(nextMonthlySalesFocus(1, "ArrowLeft", 4), 0);
  assert.equal(nextMonthlySalesFocus(0, "ArrowLeft", 4), 0);
  assert.equal(nextMonthlySalesFocus(3, "ArrowRight", 4), 3);
  assert.equal(nextMonthlySalesFocus(2, "Home", 4), 0);
  assert.equal(nextMonthlySalesFocus(1, "End", 4), 3);
  assert.equal(nextMonthlySalesFocus(1, "Enter", 4), 1);
});

test("labels preserve year separators while staying sparse and the monetary domain remains stable", () => {
  assert.equal(monthlySalesAxisLabel("2026-01-01"), "Jan ’26");
  assert.equal(monthlySalesAxisLabel("2026-04-01"), "Apr");
  assert.equal(monthlySalesAxisLabel("2026-04-01", true), "Apr ’26");
  assert.equal(niceMonthlySalesAxisMax([120000, 600000, null]), 800000);
  assert.equal(niceMonthlySalesAxisMax([null, 0]), 1);
});

test("unmeasured first render is desktop-first, not the mobile fallback geometry", () => {
  const html = renderToStaticMarkup(createElement(MonthlySalesColumns, {
    points: history(24),
    selectedPeriodStart: "2024-12-01",
    onSelectPeriod: () => {},
  }));
  assert.match(html, /viewBox="0 0 960 300"/);
  assert.match(html, /aria-current="true"/, "the selected month is emphatic before client measurement");
});

test("12-, 24-, and 43-month supplied ranges retain an accessible selected target and thin labels", () => {
  const complete = history(43);
  for (const range of [complete.slice(-12), complete.slice(-24), complete]) {
    const selected = range[Math.floor(range.length / 2)]!;
    const html = renderToStaticMarkup(createElement(MonthlySalesColumns, {
      points: range,
      selectedPeriodStart: selected.periodStart,
      onSelectPeriod: () => {},
      width: 960,
    }));
    assert.match(html, new RegExp(`aria-label="Select ${monthlySalesMonthName(selected.periodStart)}`));
    assert.match(html, /aria-current="true"/);
    const labels = html.match(/text-anchor="middle">(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/g) ?? [];
    assert.ok(labels.length <= 7, "all-history labels remain sparse enough to read");
  }
});

test("mobile width preserves target semantics and switches only the chart geometry", () => {
  const html = renderToStaticMarkup(createElement(MonthlySalesColumns, {
    points: POINTS,
    selectedPeriodStart: "2026-04-01",
    onSelectPeriod: () => {},
    width: 390,
  }));
  assert.match(html, /viewBox="0 0 390 230"/);
  assert.match(html, /role="button" tabindex="0"/);
  assert.match(html, /Select April 2026, \$120,000 month to date/);
  assert.match(html, /Monthly material sales data/);
});

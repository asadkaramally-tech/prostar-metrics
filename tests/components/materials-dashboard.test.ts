import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MaterialsDashboard, qtyDelta } from "../../src/components/materials-dashboard";
import { buildMaterialsReadModel, type MaterialLineInput } from "../../src/lib/metrics/materials";
import { toMaterialsPageReadModel, type MaterialsTrendPoint } from "../../src/lib/store/materials-read-model";

function line(overrides: Partial<MaterialLineInput>): MaterialLineInput {
  return { jobId: 900, completedDate: "2026-07-10", lineType: "catalog", catalogId: null, prebuildId: null, name: "Fixture material", partNo: null, qty: 1, extendedExTax: 100, groupName: null, parentGroupName: null, ...overrides };
}
const selected = [
  line({ jobId: 901, lineType: "one_off", name: "Cupronickel Heat Exchanger", qty: 8, extendedExTax: 53360 }),
  line({ jobId: 902, catalogId: 71, name: "IGNITER HSI 120V-KIT", partNo: "007400F", qty: 24, extendedExTax: 2784, groupName: "Raypak Cheat Sheet", parentGroupName: "Raypak Cheat Sheet" }),
  line({ jobId: 903, catalogId: 72, name: "Copper Pipe Type L - 2", partNo: "COP-PIPE-200", qty: 80, extendedExTax: 4047, groupName: "Copper Pipe", parentGroupName: "Plumbing - Copper" }),
  line({ jobId: 904, catalogId: 73, name: "Taco CIRC", partNo: "111-8S", qty: 1, extendedExTax: 3049 }),
  line({ jobId: 905, catalogId: 74, name: "Agreement Billing", qty: 1, extendedExTax: 9999, groupName: "Service Contract", parentGroupName: "Service Contract" }),
];
const priorMonth = [line({ completedDate: "2026-06-10", catalogId: 72, name: "Copper Pipe Type L - 2", qty: 185, extendedExTax: 9357 })];
const priorYear = [
  line({ jobId: 701, completedDate: "2025-07-03", lineType: "one_off", name: "Cupronickel Heat Exchanger", qty: 2, extendedExTax: 30000 }),
  line({ jobId: 702, completedDate: "2025-07-12", catalogId: 99, name: "Prior-year-only material", qty: 1, extendedExTax: 5000 }),
  line({ jobId: 703, completedDate: "2025-07-25", catalogId: 98, name: "After cutoff", qty: 1, extendedExTax: 9000 }),
];
const coverage = (periodStart: string, status: "complete" | "failed" | "missing" = "complete") => ({ periodStart, status, walkedAt: status === "complete" ? "2026-07-18T12:00:00Z" : null, jobCount: 7, lineCount: 7 });
function model(status: "complete" | "failed" | "missing" = "complete") {
  return buildMaterialsReadModel({ periodStart: "2026-07-01", selectedLines: selected, priorMonthLines: priorMonth, priorYearLines: priorYear, coverage: { selectedMonth: coverage("2026-07-01", status), priorMonth: coverage("2026-06-01"), priorYearMonth: coverage("2025-07-01") }, freshness: { pageKey: "materials", state: "current", label: "Updated today", detail: "Complete", dataThrough: "2026-07-18", lastSuccessfulRunAt: "2026-07-18", lastFailedRunAt: null }, now: new Date("2026-07-18T20:00:00Z") });
}
const trend: MaterialsTrendPoint[] = [
  { periodStart: "2023-01-01", sales: 18000, spend: 18000, quantity: null, status: "complete", isPartial: false, elapsedDays: null, daysInMonth: null, sameMonthLastYearSales: null, comparisonLabel: null },
  { periodStart: "2026-06-01", sales: 20019, spend: 20019, quantity: null, status: "complete", isPartial: false, elapsedDays: null, daysInMonth: null, sameMonthLastYearSales: 16000, comparisonLabel: "vs Jun ’25 full month" },
  { periodStart: "2026-07-01", sales: 63240, spend: 63240, quantity: null, status: "complete", isPartial: true, elapsedDays: 18, daysInMonth: 31, sameMonthLastYearSales: 35000, comparisonLabel: "vs Jul ’25 through Jul 18" },
];
function render(status: "complete" | "failed" | "missing" = "complete") { return renderToStaticMarkup(createElement(MaterialsDashboard, { model: toMaterialsPageReadModel(model(status)), trend })); }

test("renders the redesigned unified overview with one valid monetary history", () => {
  const html = render();
  assert.match(html, /Materials performance briefing/);
  assert.match(html, /Selected period/);
  assert.match(html, /Material sales · MTD/);
  assert.match(html, /Extended sell, ex-tax/);
  assert.match(html, /All history/);
  assert.match(html, /Monthly material sales/);
  assert.doesNotMatch(html, /Quantity sold|Bullet|Sold value split by category/);
});

test("uses one exact day-aligned YoY contract and prior month only as context", () => {
  const built = model();
  const html = render();
  assert.equal(built.comparison.label, "vs Jul ’25 through Jul 18");
  assert.match(html, /vs Jul ’25 through Jul 18/);
  assert.match(html, /Jun ’26 closed/);
  assert.match(html, /Calendar-day run-rate pace/);
  assert.doesNotMatch(html, /change vs Jun|pace.*ahead of|pace.*behind/);
});

test("separates signed change drivers from selected-period review rows", () => {
  const built = model();
  const html = render();
  assert.ok(built.topSignedDollarChangeDrivers.some((item) => item.name === "Prior-year-only material" && item.comparisonSalesDelta === -5000));
  assert.ok(!built.items.some((item) => item.name === "Prior-year-only material"));
  assert.match(html, /What changed/);
  assert.match(html, /Prior-year-only material/);
  const review = html.slice(html.indexOf("Material review"));
  assert.doesNotMatch(review, /Prior-year-only material/);
});

test("renders ranked category bars, exposures, and matched table columns", () => {
  const html = render();
  assert.match(html, /Where sales are concentrated/);
  assert.match(html, /Historical category change is unavailable until category mapping is versioned/);
  assert.match(html, /Special order \/ non-stock/);
  assert.match(html, /Largest material/);
  assert.match(html, /Ungrouped/);
  assert.match(html, /Jul ’25 through Jul 18/);
  assert.match(html, /Material review/);
  assert.doesNotMatch(html, /Service Contract/);
});

test("review controls and CSV preserve URL-backed state", () => {
  const page = toMaterialsPageReadModel(model(), { q: "copper", category: "Plumbing - Copper", sort: "dollar-change", page: 1 });
  const html = renderToStaticMarkup(createElement(MaterialsDashboard, { model: page, trend }));
  assert.match(html, /name="q" value="copper"/);
  assert.match(html, /name="category"/);
  assert.match(html, /name="sort"/);
  assert.match(html, /api\/materials\/csv\?month=2026-07&amp;q=copper&amp;category=Plumbing\+-\+Copper&amp;sort=dollar-change/);
});

test("unavailable coverage suppresses comparisons rather than inventing zeros", () => {
  const built = model("failed");
  built.coverage.priorYearMonth = coverage("2025-07-01", "missing");
  built.comparison.available = false;
  built.comparison.comparable = false;
  built.comparison.sales = null;
  built.items.forEach((item) => { item.comparisonSales = null; item.comparisonExtended = null; item.comparisonSalesDelta = null; });
  const html = renderToStaticMarkup(createElement(MaterialsDashboard, { model: toMaterialsPageReadModel(built), trend: [] }));
  assert.match(html, /Selected-period coverage is failed/);
  assert.match(html, /Comparison unavailable/);
  assert.doesNotMatch(html, /\$0/);
});

test("quantity delta helper retains explicit unavailable and signed states", () => {
  assert.deepEqual(qtyDelta(5, null), { kind: "unavailable", text: "—" });
  assert.deepEqual(qtyDelta(5, 0), { kind: "new", text: "new" });
  assert.deepEqual(qtyDelta(3, 5), { kind: "down", text: "−2" });
});

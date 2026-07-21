import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildMaterialsCsv,
  categorySegments,
  MaterialsDashboard,
  paceComparison,
  paceText,
  qtyDelta,
} from "../../src/components/materials-dashboard";
import {
  buildMaterialsReadModel,
  type MaterialLineInput,
  type MaterialsReadModel,
} from "../../src/lib/metrics/materials";

/* Fixture: a small July 2026 cohort exercising every approved surface — a
   dominant Special order / non-stock category (warn tint + in-fill label),
   a Raypak Cheat Sheet line merged into Raypak Parts, an excluded Service
   Contract line, a prebuild, a declining item (red Δ), a new item ("new" Δ),
   plus prior-month and prior-year months for the pill/bullet/pace. Every
   rendered number must flow from this payload. The composition under test is
   the owner-approved docs/approved-design/mockups/materials.html. */

function line(overrides: Partial<MaterialLineInput>): MaterialLineInput {
  return {
    jobId: 900,
    completedDate: "2026-07-10",
    lineType: "catalog",
    catalogId: null,
    prebuildId: null,
    name: "Fixture material",
    partNo: null,
    qty: 1,
    extendedExTax: 100,
    groupName: null,
    parentGroupName: null,
    ...overrides,
  };
}

const JULY_LINES: MaterialLineInput[] = [
  // Dominant one-off: Special order / non-stock (never "uncatalogued").
  line({ jobId: 901, lineType: "one_off", name: "Cupronickel Heat Exchanger", qty: 8, extendedExTax: 53360 }),
  // Raypak Cheat Sheet merges into Raypak Parts (one category).
  line({ jobId: 902, catalogId: 71, name: "IGNITER HSI 120V-KIT", partNo: "007400F", qty: 24, extendedExTax: 2784, groupName: "Raypak Cheat Sheet", parentGroupName: "Raypak Cheat Sheet" }),
  // Declining catalog item vs June (red Δ).
  line({ jobId: 903, catalogId: 72, name: "Copper Pipe Type L - 2", partNo: "COP-PIPE-200", qty: 70, extendedExTax: 3541, groupName: "Copper Pipe", parentGroupName: "Plumbing - Copper" }),
  line({ jobId: 904, catalogId: 72, name: "Copper Pipe Type L - 2", partNo: "COP-PIPE-200", qty: 10, extendedExTax: 506, groupName: "Copper Pipe", parentGroupName: "Plumbing - Copper" }),
  // Prebuild assembly line.
  line({ jobId: 905, lineType: "prebuild", prebuildId: 31, name: '3/4" Gas', qty: 8, extendedExTax: 2000 }),
  // Ungrouped catalog line, new this month.
  line({ jobId: 906, catalogId: 73, name: "Taco 111/8s CIRC", partNo: "111-8S", qty: 1, extendedExTax: 3049 }),
  // Service Contract group line — excluded from every total (owner ruling).
  line({ jobId: 907, catalogId: 74, name: "PM Agreement Billing", qty: 1, extendedExTax: 9999, groupName: "Service Contract", parentGroupName: "Service Contract" }),
];

const JUNE_LINES: MaterialLineInput[] = [
  line({ jobId: 801, completedDate: "2026-06-05", catalogId: 72, name: "Copper Pipe Type L - 2", partNo: "COP-PIPE-200", qty: 185, extendedExTax: 9357, groupName: "Copper Pipe", parentGroupName: "Plumbing - Copper" }),
  line({ jobId: 802, completedDate: "2026-06-09", catalogId: 71, name: "IGNITER HSI 120V-KIT", partNo: "007400F", qty: 24, extendedExTax: 2784, groupName: "Raypak Cheat Sheet", parentGroupName: "Raypak Cheat Sheet" }),
  line({ jobId: 803, completedDate: "2026-06-12", lineType: "prebuild", prebuildId: 31, name: '3/4" Gas', qty: 1, extendedExTax: 250 }),
  line({ jobId: 804, completedDate: "2026-06-15", lineType: "one_off", name: "Replacement Water Heater", qty: 1, extendedExTax: 7628 }),
];

const JULY_2025_LINES: MaterialLineInput[] = [
  line({ jobId: 701, completedDate: "2025-07-03", lineType: "one_off", name: "Legacy special order", qty: 2, extendedExTax: 30000 }),
  // Completed after the aligned day 18 — excluded from the day-aligned total.
  line({ jobId: 702, completedDate: "2025-07-25", lineType: "one_off", name: "Late July item", qty: 1, extendedExTax: 5000 }),
];

function coverage(periodStart: string, status: "complete" | "failed" | "missing" = "complete") {
  return { periodStart, status, walkedAt: status === "complete" ? "2026-07-18T12:00:00Z" : null, jobCount: 7, lineCount: 7 };
}

function buildModel(overrides: Partial<Parameters<typeof buildMaterialsReadModel>[0]> = {}): MaterialsReadModel {
  return buildMaterialsReadModel({
    periodStart: "2026-07-01",
    selectedLines: JULY_LINES,
    priorMonthLines: JUNE_LINES,
    priorYearLines: JULY_2025_LINES,
    coverage: {
      selectedMonth: coverage("2026-07-01"),
      priorMonth: coverage("2026-06-01"),
      priorYearMonth: coverage("2025-07-01"),
    },
    freshness: {
      pageKey: "materials",
      state: "current",
      label: "Updated today",
      detail: "Completed a full live Simpro materials walk for 2026-07.",
      dataThrough: "2026-07-18T12:00:00Z",
      lastSuccessfulRunAt: "2026-07-18T12:00:00Z",
      lastFailedRunAt: null,
    },
    // Day 18 of a 31-day July → partial month with pace + day-aligned YoY.
    now: new Date("2026-07-18T20:00:00Z"),
    ...overrides,
  });
}

function render(model: MaterialsReadModel): string {
  return renderToStaticMarkup(createElement(MaterialsDashboard, { model }));
}

test("band renders the MTD primary stat with labeled day-aligned pill, pace sub, and both bullet ticks", () => {
  const model = buildModel();
  const html = render(model);

  // $65,240 included (service-contract $9,999 excluded), rendered once in the band.
  assert.equal(model.totals.current, 65240);
  assert.match(html, /Materials sold · MTD/);
  assert.match(html, /\$65,240/);
  // Day-aligned prior year: only the day≤18 line ($30,000) counts → +117.5%.
  assert.equal(model.totals.priorYearSameDay, 30000);
  assert.match(html, /↑ 117\.5% vs Jul ’25/);
  assert.doesNotMatch(html, /↑ 117\.5%</); // pill is never a bare percentage
  // Pace: 65240 / 18 × 31 ≈ $112K, behind June ($20,019 full month… ahead of).
  assert.equal(model.totals.paceProjection, 112357.78);
  assert.match(html, /on pace for ≈\$112K full-month — ahead of June/);
  // ONE bullet with both comparison ticks keyed in the caption.
  assert.match(html, /Jul ’25 · d18/);
  assert.match(html, /Jun ’26 · full/);
  // No KPI tile grid on this page (owner ruling).
  assert.doesNotMatch(html, /ktiles/);
});

test("category card is the primary viz: one segmented bar, warn-tinted special order, values in the legend", () => {
  const model = buildModel();
  const html = render(model);
  const segments = categorySegments(model);

  assert.match(html, /data-primary-viz/);
  assert.match(html, /Materials Value by Category/);
  assert.match(html, /July · Simpro product groups/);
  // Rank order from the fixture: special order leads and takes the warn tint.
  assert.equal(segments[0].name, "Special order / non-stock");
  assert.equal(segments[0].fill, "color-mix(in srgb, var(--warn), #fff 55%)");
  // Raypak Cheat Sheet is reported as Raypak Parts; Service Contract never appears.
  assert.ok(segments.some((seg) => seg.name === "Raypak Parts"));
  assert.match(html, /Raypak Parts/);
  assert.doesNotMatch(html, /Raypak Cheat Sheet/);
  // The Service Contract group never appears as rendered content (the only
  // mention is the primary card's exclusion tooltip, which the brief allows).
  assert.doesNotMatch(html, />Service Contract</);
  assert.doesNotMatch(html, /uncatalogued/i);
  // Legend carries the values: dominant slice $53,360 · 81.8%.
  assert.match(html, /\$53,360/);
  assert.match(html, /81\.8%/);
  // In-fill label only on the leading segment.
  assert.match(html, /Special order \/ non-stock · 82%/);
  // Six named categories in this fixture → no "more categories" remainder.
  assert.doesNotMatch(html, /more categor/);
});

test("all-materials table is ordered by total sold value with Δ grammar, unit sell, and pagination", () => {
  const model = buildModel();
  const html = render(model);

  assert.match(html, /All Materials Sold — July/);
  assert.match(html, /Ordered by total sold value · Δ = qty change vs Jun/);
  // Ranked by extended: the $53,360 special order leads.
  assert.equal(model.items[0].extended, 53360);
  assert.equal(model.items[0].name, "Cupronickel Heat Exchanger");
  // Copper pipe aggregated across two jobs: qty 80, June qty 185 → red −105.
  const copper = model.items.find((item) => item.key === "catalog:72");
  assert.ok(copper);
  assert.equal(copper.qty, 80);
  assert.equal(copper.priorMonthQty, 185);
  assert.equal(copper.jobCount, 2);
  assert.deepEqual(qtyDelta(copper.qty, copper.priorMonthQty), { kind: "down", text: "−105" });
  assert.match(html, /−105/);
  assert.match(html, /var\(--state-failed-fg\)/);
  // New item (no June sales) reads "new", never "+1".
  assert.deepEqual(qtyDelta(1, 0), { kind: "new", text: "new" });
  assert.match(html, />new</);
  // Unchanged igniter qty reads 0; unit sell renders with cents.
  assert.deepEqual(qtyDelta(24, 24), { kind: "zero", text: "0" });
  assert.match(html, /\$116\.00/);
  // CSV + pager + count line (5 ranked items: the two copper lines aggregate).
  assert.equal(model.items.length, 5);
  assert.match(html, /Download CSV/);
  assert.match(html, /Showing 1–5 of 5 by total sold value/);
  assert.match(html, /aria-label="Next page"/);
});

test("no narrative callouts, methodology footnotes, or source lines exist on the page", () => {
  const html = render(buildModel());
  // Owner ruling: the data carries the page. The only micro-copy is the Δ key.
  assert.doesNotMatch(html, /footline/);
  assert.doesNotMatch(html, /Source:/);
  assert.doesNotMatch(html, /methodology/i);
  assert.doesNotMatch(html, /drove July/i);
  const deltaKeys = html.match(/Δ = qty change vs Jun/g) ?? [];
  assert.equal(deltaKeys.length, 1);
});

test("closed months drop MTD/pace wording and compare full month to the prior month", () => {
  const model = buildModel({ now: new Date("2026-08-15T20:00:00Z") });
  const html = render(model);
  assert.equal(model.totals.elapsedDays, model.totals.daysInMonth);
  assert.match(html, /Materials sold/);
  assert.doesNotMatch(html, /· MTD/);
  assert.doesNotMatch(html, /on pace for/);
  assert.match(html, /full month · ahead of June/);
});

test("missing prior walks ghost their ticks instead of inventing zeros", () => {
  const model = buildModel({
    priorYearLines: [],
    coverage: {
      selectedMonth: coverage("2026-07-01"),
      priorMonth: coverage("2026-06-01"),
      priorYearMonth: coverage("2025-07-01", "missing"),
    },
  });
  const html = render(model);
  assert.doesNotMatch(html, /vs Jul ’25/);
  assert.match(html, /no data/);
  assert.match(html, /Jun ’26 · full/);
});

test("missing prior-month coverage renders unavailable quantities and deltas, never zero or new", () => {
  const model = buildModel({
    priorMonthLines: [],
    coverage: {
      selectedMonth: coverage("2026-07-01"),
      priorMonth: coverage("2026-06-01", "missing"),
      priorYearMonth: coverage("2025-07-01"),
    },
  });
  const html = render(model);

  assert.equal(model.items[0]?.priorMonthQty, null);
  assert.deepEqual(qtyDelta(model.items[0]!.qty, model.items[0]!.priorMonthQty), { kind: "unavailable", text: "—" });
  assert.doesNotMatch(html, />new</);
  assert.match(html, /Jun qty<\/th>/);
  assert.match(html, /Jun comparison unavailable/);
  assert.match(html, /—/);

  const csv = buildMaterialsCsv(model.items, "Jun");
  assert.match(csv, /Cupronickel Heat Exchanger,,Special order \/ non-stock,8,,,6670,53360,1,901/);
});

test("empty months render a truthful coverage state, not a zero dashboard", () => {
  const missing = buildModel({
    selectedLines: [],
    coverage: {
      selectedMonth: coverage("2026-07-01", "missing"),
      priorMonth: coverage("2026-06-01"),
      priorYearMonth: coverage("2025-07-01"),
    },
  });
  assert.match(render(missing), /No completed materials walk exists for July yet\./);

  const empty = buildModel({ selectedLines: [] });
  assert.match(render(empty), /No materials were billed on jobs completed in July\./);
  assert.doesNotMatch(render(empty), /\$0/);
});

test("pace helpers: even-with band, whole-K text, and CSV escapes the ranked list", () => {
  assert.equal(paceComparison(237000, 253182), "even with");
  assert.equal(paceComparison(300000, 253182), "ahead of");
  assert.equal(paceComparison(200000, 253182), "behind");
  assert.equal(paceComparison(100, null), "");
  assert.equal(paceText(236903), "≈$237K");
  assert.equal(paceText(1250000), "≈$1.25M");

  const model = buildModel();
  const csv = buildMaterialsCsv(model.items, "Jun");
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, model.items.length + 1);
  assert.match(lines[0], /Item,Part No,Category,Qty,Jun Qty,Qty Change,Unit Sell,Extended \(Ex-Tax\),Jobs,Job IDs/);
  assert.match(csv, /Cupronickel Heat Exchanger,,Special order \/ non-stock,8,0,new,6670,53360,1,901/);
  assert.match(csv, /"3\/4"" Gas"/);
});

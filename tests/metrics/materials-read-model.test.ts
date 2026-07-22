import assert from "node:assert/strict";
import test from "node:test";
import type { FreshnessStatus } from "../../src/lib/metrics/freshness";
import {
  addMonthsToPeriodStart,
  buildMaterialsReadModel,
  isMaterialLine,
  materialItemKey,
  materialLineCategory,
  normalizeMaterialsPeriodStart,
  PREBUILD_CATEGORY,
  SPECIAL_ORDER_CATEGORY,
  UNGROUPED_CATEGORY,
  type MaterialLineInput,
  type MaterialsMonthCoverage,
} from "../../src/lib/metrics/materials";

const freshness: FreshnessStatus = {
  pageKey: "materials",
  state: "current",
  label: "Current",
  detail: "Test fixture",
  dataThrough: null,
  lastSuccessfulRunAt: null,
  lastFailedRunAt: null,
};

// 2026-07-18 13:00 in America/Los_Angeles: elapsed day 18 of a 31-day month.
const JULY_18 = new Date("2026-07-18T20:00:00Z");

function line(overrides: Partial<MaterialLineInput>): MaterialLineInput {
  return {
    jobId: 100,
    completedDate: "2026-07-10",
    lineType: "catalog",
    catalogId: 1,
    prebuildId: null,
    name: "Widget",
    partNo: "W-1",
    qty: 1,
    extendedExTax: 100,
    groupName: null,
    parentGroupName: null,
    ...overrides,
  };
}

function coverage(periodStart: string, overrides: Partial<MaterialsMonthCoverage> = {}): MaterialsMonthCoverage {
  return { periodStart, status: "complete", walkedAt: "2026-07-18T00:00:00Z", jobCount: 1, lineCount: 1, ...overrides };
}

function buildParams(overrides: Partial<Parameters<typeof buildMaterialsReadModel>[0]> = {}) {
  return {
    periodStart: "2026-07-01",
    selectedLines: [] as MaterialLineInput[],
    priorMonthLines: [] as MaterialLineInput[],
    priorYearLines: [] as MaterialLineInput[],
    coverage: {
      selectedMonth: coverage("2026-07-01"),
      priorMonth: coverage("2026-06-01"),
      priorYearMonth: coverage("2025-07-01"),
    },
    freshness,
    now: JULY_18,
    ...overrides,
  };
}

test("owner category rules: parent group first, Raypak merge, one-off and prebuild labels", () => {
  assert.equal(materialLineCategory(line({ parentGroupName: "Plumbing - Copper", groupName: "Pipe" })), "Plumbing - Copper");
  assert.equal(materialLineCategory(line({ parentGroupName: null, groupName: "Pumps & Misc" })), "Pumps & Misc");
  assert.equal(materialLineCategory(line({ parentGroupName: null, groupName: null })), UNGROUPED_CATEGORY);
  assert.equal(materialLineCategory(line({ parentGroupName: "Raypak Cheat Sheet", groupName: "Ignition" })), "Raypak Parts");
  assert.equal(materialLineCategory(line({ parentGroupName: null, groupName: "Raypak Cheat Sheet" })), "Raypak Parts");
  assert.equal(materialLineCategory(line({ lineType: "one_off", catalogId: null })), SPECIAL_ORDER_CATEGORY);
  assert.equal(materialLineCategory(line({ lineType: "prebuild", catalogId: null, prebuildId: 9 })), PREBUILD_CATEGORY);
});

test("Service Contract lines are excluded whether the group or the parent group matches", () => {
  assert.equal(isMaterialLine(line({ parentGroupName: "Service Contract" })), false);
  assert.equal(isMaterialLine(line({ groupName: "service contract" })), false);
  assert.equal(isMaterialLine(line({ parentGroupName: "Raypak Parts" })), true);
  // One-offs and prebuilds are never Service Contract catalog lines.
  assert.equal(isMaterialLine(line({ lineType: "one_off", groupName: "Service Contract" })), true);
});

test("item keys: catalog id, prebuild id, and one-off normalized name", () => {
  assert.equal(materialItemKey(line({ catalogId: 42 })), "catalog:42");
  assert.equal(materialItemKey(line({ lineType: "prebuild", catalogId: null, prebuildId: 7 })), "prebuild:7");
  assert.equal(materialItemKey(line({ lineType: "one_off", catalogId: null, name: "  Replacement Heater " })), "one-off:replacement heater");
  assert.equal(materialItemKey(line({ lineType: "one_off", catalogId: null, name: null })), "one-off:unnamed");
});

test("aggregates categories and items with exclusions, ordering, and job drill", () => {
  const model = buildMaterialsReadModel(buildParams({
    selectedLines: [
      line({ jobId: 1, catalogId: 10, name: "Igniter", partNo: "007400F", parentGroupName: "Raypak Cheat Sheet", qty: 2, extendedExTax: 232 }),
      line({ jobId: 2, catalogId: 10, name: "Igniter", partNo: "007400F", parentGroupName: "Raypak Cheat Sheet", qty: 1, extendedExTax: 116 }),
      line({ jobId: 1, catalogId: 11, name: "Flow Switch", partNo: "007142F", parentGroupName: "Raypak Parts", qty: 1, extendedExTax: 402 }),
      line({ jobId: 3, catalogId: 12, name: "Contract Visit", parentGroupName: "Service Contract", qty: 1, extendedExTax: 5000 }),
      line({ jobId: 3, lineType: "one_off", catalogId: null, name: "Replacement Heater", partNo: null, qty: 1, extendedExTax: 7627.5 }),
      line({ jobId: 4, lineType: "prebuild", catalogId: null, prebuildId: 9, name: '3/4" Gas', qty: 8, extendedExTax: 2000 }),
      line({ jobId: 4, catalogId: 13, name: "Mystery Part", qty: 3, extendedExTax: 300 }),
    ],
    priorMonthLines: [
      line({ jobId: 90, catalogId: 10, parentGroupName: "Raypak Cheat Sheet", qty: 24, extendedExTax: 2784, completedDate: "2026-06-15" }),
    ],
  }));

  // Service Contract line excluded from every surface.
  assert.equal(model.totals.current, 232 + 116 + 402 + 7627.5 + 2000 + 300);
  assert.equal(model.coverage.excludedServiceContractLineCount, 1);
  assert.equal(model.coverage.includedLineCount, 6);

  assert.deepEqual(model.categories.map((category) => category.name), [
    SPECIAL_ORDER_CATEGORY,
    PREBUILD_CATEGORY,
    "Raypak Parts",
    UNGROUPED_CATEGORY,
  ]);
  const raypak = model.categories.find((category) => category.name === "Raypak Parts");
  assert.deepEqual(raypak, {
    name: "Raypak Parts", value: 750, qty: 4, lines: 3,
    comparisonValue: 0, comparisonQty: 0, valueDelta: 750, changeValue: 750, qtyDelta: 4, comparisonAvailable: true,
    taxonomyComparable: false,
  });

  // Items ordered by extended value, catalog lines merged across jobs.
  assert.deepEqual(model.items.map((item) => item.key), [
    "one-off:replacement heater",
    "prebuild:9",
    "catalog:11",
    "catalog:10",
    "catalog:13",
  ]);
  const igniter = model.items.find((item) => item.key === "catalog:10");
  assert.deepEqual(igniter, {
    key: "catalog:10",
    name: "Igniter",
    partNo: "007400F",
    category: "Raypak Parts",
    qty: 3,
    priorMonthQty: 24,
    priorMonthExtended: 2784,
    comparisonSales: 0,
    comparisonExtended: 0,
    comparisonQty: 0,
    comparisonSalesDelta: 348,
    comparisonQtyDelta: 3,
    unitSell: 116,
    extended: 348,
    jobCount: 2,
    jobIds: [1, 2],
  });
  const mystery = model.items.find((item) => item.key === "catalog:13");
  assert.equal(mystery?.priorMonthQty, 0);
  assert.equal(mystery?.category, UNGROUPED_CATEGORY);
});

test("current-month totals: pace projection and day-aligned prior year", () => {
  const model = buildMaterialsReadModel(buildParams({
    selectedLines: [line({ extendedExTax: 1800, completedDate: "2026-07-05" })],
    priorMonthLines: [line({ extendedExTax: 900, completedDate: "2026-06-20" })],
    priorYearLines: [
      line({ extendedExTax: 400, completedDate: "2025-07-18" }),
      line({ extendedExTax: 999, completedDate: "2025-07-19" }),
    ],
  }));

  assert.equal(model.totals.elapsedDays, 18);
  assert.equal(model.totals.daysInMonth, 31);
  assert.equal(model.totals.current, 1800);
  assert.equal(model.totals.priorMonth, 900);
  // Day-aligned: only prior-year lines completed on or before day 18 count.
  assert.equal(model.totals.priorYearSameDay, 400);
  assert.equal(model.totals.paceProjection, 3100);
  assert.deepEqual(model.comparison, {
    basis: "day-aligned-yoy", periodStart: "2026-07-01", comparatorPeriodStart: "2025-07-01",
    label: "vs Jul ’25 through Jul 18", shortLabel: "Jul ’25", columnLabel: "Jul ’25 through Jul 18",
    partial: true, elapsedDays: 18, available: true, comparable: true,
    sales: 400, salesDelta: 1400, salesDeltaPct: 3.5,
  });
  assert.equal(model.items[0]?.comparisonSales, 400);
  assert.equal(model.items[0]?.comparisonQty, 1);
  assert.equal(model.items[0]?.comparisonSalesDelta, 1400);
  assert.equal(model.categories[0]?.comparisonValue, 400);
  assert.equal(model.categories[0]?.valueDelta, 1400);
  assert.equal(model.topSignedDollarChangeDrivers[0]?.salesDelta, 1400);
});

test("closed months use the full month for elapsed days, pace, and prior year", () => {
  const model = buildMaterialsReadModel(buildParams({
    periodStart: "2026-06-01",
    selectedLines: [line({ extendedExTax: 500, completedDate: "2026-06-02" })],
    priorYearLines: [line({ extendedExTax: 777, completedDate: "2025-06-30" })],
    coverage: {
      selectedMonth: coverage("2026-06-01"),
      priorMonth: coverage("2026-05-01"),
      priorYearMonth: coverage("2025-06-01"),
    },
  }));
  assert.equal(model.totals.elapsedDays, 30);
  assert.equal(model.totals.paceProjection, 500);
  assert.equal(model.totals.priorYearSameDay, 777);
  assert.equal(model.comparison.basis, "full-yoy");
  assert.equal(model.comparison.label, "vs Jun ’25 full month");
  assert.equal(model.comparison.sales, 777);
  assert.equal(model.comparison.salesDelta, -277);
});

test("comparator-only records stay out of selected-period review data but remain signed change drivers", () => {
  const model = buildMaterialsReadModel(buildParams({
    selectedLines: [line({ catalogId: 10, name: "Current igniter", extendedExTax: 200 })],
    priorYearLines: [
      line({ catalogId: 10, name: "Current igniter", extendedExTax: 50, completedDate: "2025-07-10" }),
      line({ catalogId: 99, name: "Retired pump", parentGroupName: "Pumps", extendedExTax: 600, completedDate: "2025-07-10" }),
    ],
  }));
  assert.deepEqual(model.items.map((item) => item.key), ["catalog:10"]);
  assert.deepEqual(model.categories.map((category) => category.name), [UNGROUPED_CATEGORY]);
  const retired = model.topSignedDollarChangeDrivers.find((item) => item.key === "catalog:99");
  assert.deepEqual(retired, {
    key: "catalog:99", name: "Retired pump", partNo: "W-1", category: "Pumps",
    extended: 0, comparisonExtended: 600, comparisonSalesDelta: -600,
    sales: 0, comparisonSales: 600, salesDelta: -600,
  });
});

test("incomplete or missing walks surface loud warnings", () => {
  const model = buildMaterialsReadModel(buildParams({
    coverage: {
      selectedMonth: coverage("2026-07-01", { status: "failed" }),
      priorMonth: coverage("2026-06-01"),
      priorYearMonth: coverage("2025-07-01", { status: "missing", walkedAt: null, jobCount: 0, lineCount: 0 }),
    },
  }));
  assert.equal(model.warnings.length, 2);
  assert.match(model.warnings[0], /2026-07 materials walk is failed/);
  assert.match(model.warnings[1], /prior-year materials walk is missing/);
  assert.match(model.warnings[1], /comparison is unavailable/);
});

test("a missing prior-month walk stays unavailable instead of becoming a real zero", () => {
  const model = buildMaterialsReadModel(buildParams({
    selectedLines: [line({ catalogId: 42, qty: 3 })],
    coverage: {
      selectedMonth: coverage("2026-07-01"),
      priorMonth: coverage("2026-06-01", { status: "missing", walkedAt: null, jobCount: 0, lineCount: 0 }),
      priorYearMonth: coverage("2025-07-01"),
    },
  }));

  assert.equal(model.items[0]?.priorMonthQty, null);
  assert.match(model.warnings.join("\n"), /prior-month materials walk is missing; prior-month context is unavailable/);
});

test("period helpers normalize and step months across year boundaries", () => {
  assert.equal(normalizeMaterialsPeriodStart("2026-07-01"), "2026-07-01");
  assert.equal(normalizeMaterialsPeriodStart(undefined, JULY_18), "2026-07-01");
  assert.equal(normalizeMaterialsPeriodStart("garbage", JULY_18), "2026-07-01");
  assert.equal(addMonthsToPeriodStart("2026-01-01", -1), "2025-12-01");
  assert.equal(addMonthsToPeriodStart("2026-07-01", -12), "2025-07-01");
  assert.throws(() => buildMaterialsReadModel(buildParams({ periodStart: "2026-07-15" })), /first-of-month/);
});

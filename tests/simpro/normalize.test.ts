import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  allocateJobGrossProfitToCostCenters,
  extractCostCenterRollups,
  extractJobFinancialTotals,
  extractJobSource,
  jobCategoryFromCostCenters,
  normalizeEmployeeCapacity,
} from "../../src/lib/simpro/normalize";

const emptyFinancialTotals = {
  nettProfitActual: null,
  nettProfitEstimate: null,
  nettMarginActual: null,
  nettMarginEstimate: null,
  grossProfitActual: null,
  grossProfitEstimate: null,
  grossMarginActual: null,
  grossMarginEstimate: null,
  materialsCostActual: null,
  materialsCostEstimate: null,
  laborCostActual: null,
  laborCostEstimate: null,
  laborHoursActual: null,
  laborHoursEstimate: null,
  overheadActual: null,
  overheadEstimate: null,
  resourceTotalActual: null,
  resourceTotalEstimate: null,
  commissionActual: null,
};

test("extractCostCenterRollups reads Simpro quote detail cost-center category, labor, and materials", () => {
  const rollups = extractCostCenterRollups({
    Sections: [
      {
        ID: 52993,
        Name: "",
        CostCenters: [
          {
            ID: 30241,
            Name: "HVAC Service",
            CostCenter: { ID: 7, Name: "HVAC Service" },
            Total: { ExTax: 1256.39, Tax: 30.61, IncTax: 1287 },
            Items: {
              Labors: [
                {
                  Total: {
                    Qty: 4,
                    Amount: { ExTax: 800, IncTax: 800 },
                  },
                },
              ],
              ServiceFees: [
                {
                  Total: {
                    Qty: 1,
                    Amount: { ExTax: 59, IncTax: 59 },
                  },
                },
              ],
              OneOffs: [
                {
                  Type: "Material",
                  Total: {
                    Qty: 1,
                    Amount: { ExTax: 310, IncTax: 335.575 },
                  },
                },
                {
                  Type: "Material",
                  Total: {
                    Qty: 1,
                    Amount: { ExTax: 50, IncTax: 54.125 },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.equal(rollups.length, 1);
  assert.deepEqual(rollups[0], {
    sectionId: 52993,
    costCenterId: 30241,
    configuredCostCenterId: 7,
    configuredCostCenterName: "HVAC Service",
    name: "HVAC Service",
    category: "HVAC",
    laborHours: 4,
    sellValue: 1256.39,
    costValue: null,
    materialSellValue: 419,
    materialCostValue: null,
    totals: emptyFinancialTotals,
  });
});

test("extractCostCenterRollups keeps cost-center rows even when job detail omits item quantities", () => {
  const rollups = extractCostCenterRollups({
    Sections: [
      {
        ID: 61120,
        Name: "",
        CostCenters: [
          {
            ID: 58890,
            Name: "Water Heating Service",
            CostCenter: { ID: 6, Name: "Water Heating Service" },
          },
        ],
      },
    ],
  });

  assert.deepEqual(rollups, [
    {
      sectionId: 61120,
      costCenterId: 58890,
      configuredCostCenterId: 6,
      configuredCostCenterName: "Water Heating Service",
      name: "Water Heating Service",
      category: "Water Heating",
      laborHours: null,
      sellValue: null,
      costValue: null,
      materialSellValue: null,
      materialCostValue: null,
      totals: emptyFinancialTotals,
    },
  ]);
});

test("cost-center detail separates instance identity and uses Totals instead of sparse child costs", () => {
  const [costCenter] = extractCostCenterRollups({
    Sections: [{
      ID: 10,
      CostCenters: [{
        ID: 20,
        Name: "Instance 20",
        CostCenter: { ID: 6, Name: "Configured HVAC" },
        Totals: {
          NettProfitLoss: { Actual: 10.125, Estimate: 9.75 },
          GrossProfitLoss: { Actual: 12.5, Estimate: 11 },
          MaterialsCost: { Actual: 0, Estimate: 2.25 },
          ResourcesCost: {
            Labor: { Actual: 3.125, Estimate: 4 },
            LaborHours: { Actual: 1.25, Estimate: 2 },
            Overhead: { Actual: 0.5, Estimate: 0.75 },
            Total: { Actual: 3.625, Estimate: 4.75 },
            Commission: { Actual: 0 },
          },
        },
        Items: { Catalogs: [{ Cost: 9999 }] },
      }],
    }],
  });

  assert.equal(costCenter.name, "Instance 20");
  assert.equal(costCenter.configuredCostCenterId, 6);
  assert.equal(costCenter.configuredCostCenterName, "Configured HVAC");
  assert.equal(costCenter.materialCostValue, 0);
  assert.equal(costCenter.costValue, 3.625);
  assert.equal(costCenter.totals.commissionActual, 0);
});

test("job category uses configured cost-center IDs and keeps unknown contribution visible", () => {
  const rollups = extractCostCenterRollups({
    Category: { ID: 7, Name: "HVAC" },
    Name: "HVAC water heater boiler replacement",
    Sections: [{
      ID: 1,
      CostCenters: [
        { ID: 11, CostCenter: { ID: 4, Name: "Misleading HVAC name" }, Total: { ExTax: 100 } },
        { ID: 12, CostCenter: { ID: 5, Name: "Misleading water heater name" }, Total: { ExTax: 50 } },
        { ID: 13, CostCenter: { ID: 999, Name: "HVAC" }, Total: { ExTax: 200 } },
        { ID: 14, CostCenter: null, Name: "Water Heating", Total: { ExTax: 25 } },
      ],
    }],
  });

  assert.deepEqual(rollups.map((row) => row.category), [
    "Water Heating",
    "HVAC",
    "Unclassified",
    "Unclassified",
  ]);
  assert.equal(jobCategoryFromCostCenters(rollups), "Unclassified");
  assert.equal(jobCategoryFromCostCenters([]), "Unclassified");
});

test("extractJobFinancialTotals reads authoritative Simpro actual and estimate totals", () => {
  const totals = extractJobFinancialTotals({
    Totals: {
      NettProfitLoss: { Actual: 1500.1234, Estimate: 900.25 },
      NettMargin: { Actual: 76.54321, Estimate: 45.25 },
      GrossProfitLoss: {
        Actual: 1776.03,
        Estimate: 958.75,
      },
      GrossMargin: {
        Actual: 90.67,
        Estimate: 48.95,
      },
      MaterialsCost: { Actual: 0, Estimate: 425.125 },
      ResourcesCost: {
        Labor: { Actual: 300.1234567, Estimate: 275.75 },
        LaborHours: { Actual: 12.25, Estimate: 14.5 },
        Overhead: { Actual: 80.25, Estimate: 75 },
        Total: { Actual: 425.125, Estimate: 390.875 },
        Commission: { Actual: 55.4321 },
      },
    },
  });

  assert.deepEqual(totals, {
    nettProfitActual: 1500.1234,
    nettProfitEstimate: 900.25,
    nettMarginActual: 76.54321,
    nettMarginEstimate: 45.25,
    grossProfitActual: 1776.03,
    grossProfitEstimate: 958.75,
    grossMarginActual: 90.67,
    grossMarginEstimate: 48.95,
    materialsCostActual: 0,
    materialsCostEstimate: 425.125,
    laborCostActual: 300.1234567,
    laborCostEstimate: 275.75,
    laborHoursActual: 12.25,
    laborHoursEstimate: 14.5,
    overheadActual: 80.25,
    overheadEstimate: 75,
    resourceTotalActual: 425.125,
    resourceTotalEstimate: 390.875,
    commissionActual: 55.4321,
  });
});

test("authoritative totals preserve explicit zero and missing null", () => {
  const totals = extractJobFinancialTotals({
    Totals: {
      MaterialsCost: { Actual: 0 },
      ResourcesCost: { Labor: { Actual: 0 } },
    },
  });
  assert.equal(totals.materialsCostActual, 0);
  assert.equal(totals.laborCostActual, 0);
  assert.equal(totals.overheadActual, null);
  assert.equal(totals.grossProfitActual, null);
});

test("job source preserves recurring and otherwise classifies direct service", () => {
  assert.deepEqual(extractJobSource({
    ConvertedFrom: { Type: "Recurring", ID: 445, Date: "2026-05-01T09:30:00-07:00" },
  }), {
    type: "Recurring",
    id: 445,
    convertedAt: "2026-05-01T16:30:00.000Z",
  });
  assert.deepEqual(extractJobSource({ Status: { ID: 88, Name: "Recurring" } }), {
    type: "Direct service",
    id: null,
    convertedAt: null,
  });
});

test("employee capacity defaults to eight-hour weekdays and explicit availability overrides", () => {
  const fallback = normalizeEmployeeCapacity(null);
  assert.equal(fallback.capacitySource, "default_business_hours");
  assert.equal(fallback.weekdayCapacityHours, 8);
  assert.equal(fallback.weeklyCapacityHours, 40);
  assert.deepEqual(
    (fallback.schedule.weekdays as Record<string, unknown>).Monday,
    { start: "08:30", end: "17:00", lunchMinutes: 30, workingHours: 8 },
  );

  const explicit = normalizeEmployeeCapacity(["Weekdays 09:00-16:00"]);
  assert.equal(explicit.capacitySource, "simpro_availability");
  assert.equal(explicit.weekdayCapacityHours, 7);
  assert.equal(explicit.weeklyCapacityHours, 35);
});

test("persisted cost-center GP allocation reconciles exactly to the job-level Simpro total", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema metrics;
      create table metrics.metrics_jobs (
        job_id bigint primary key,
        gross_profit_actual numeric(14,2)
      );
      create table metrics.metrics_job_cost_centers (
        job_id bigint not null,
        section_id bigint not null,
        cost_center_id bigint not null,
        sell_value numeric(14,2),
        gross_profit_actual numeric(14,2),
        gross_margin_actual numeric(8,4),
        totals_authoritative boolean not null default false,
        source_deleted_at timestamptz,
        updated_from_source_at timestamptz not null default now(),
        primary key (job_id, section_id, cost_center_id)
      );
      insert into metrics.metrics_jobs values (10, 100);
      insert into metrics.metrics_job_cost_centers (job_id, section_id, cost_center_id, sell_value)
      values (10, 20, 30, 200), (10, 20, 31, 100)
    `);
    const query = async <T = Record<string, unknown>>(text: string, values?: unknown[]) => {
      const result = await db.query<T>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? null };
    };
    await allocateJobGrossProfitToCostCenters(10, query);
    const result = await db.query<{ cost_center_id: string; profit: string; margin: string }>(`
      select cost_center_id::text, gross_profit_actual::text as profit,
             gross_margin_actual::text as margin
        from metrics.metrics_job_cost_centers
       order by cost_center_id
    `);
    assert.deepEqual(result.rows, [
      { cost_center_id: "30", profit: "66.67", margin: "33.3350" },
      { cost_center_id: "31", profit: "33.33", margin: "33.3300" },
    ]);
  } finally {
    await db.close();
  }
});

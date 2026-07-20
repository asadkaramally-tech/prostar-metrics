import assert from "node:assert/strict";
import test from "node:test";
import {
  mapCostCenterFact,
  mapItemFact,
  mapLaborFact,
  mapWorkOrderFact,
  persistProjectItem,
  persistProjectLabor,
  persistProjectWorkOrder,
  persistScheduleBlocks,
} from "../../src/lib/simpro/normalize-nested";
import type { PostgresQuery } from "../../src/lib/store/postgres";

test("quote cost-center mapping uses tenant-verified estimate paths", () => {
  const fact = mapCostCenterFact(55435, {
    ID: 30408,
    CostCenter: { ID: 6, Name: "Water Heating Service" },
    Name: "Return Line Repair",
    Total: { ExTax: 3401.77, IncTax: 3508.22 },
    Totals: {
      MaterialsCost: { Estimate: 519.89 },
      ResourcesCost: {
        Total: { Estimate: 978 },
        LaborHours: { Estimate: 6 },
      },
    },
  });

  assert.equal(fact.costCenterId, 30408);
  assert.equal(fact.configuredCostCenterId, 6);
  assert.equal(fact.category, "Water Heating");
  assert.equal(fact.laborHours, 6);
  assert.equal(fact.sellValue, 3401.77);
  assert.equal(fact.costValue, 1497.89);
});

test("job cost-center mapping keeps quoted hours separate from actual cost", () => {
  const fact = mapCostCenterFact(90716, {
    ID: 60576,
    CostCenter: { ID: 6, Name: "Water Heating Service" },
    Name: "Water Heating Service",
    Total: { ExTax: 968.86, IncTax: 980.91 },
    Totals: {
      MaterialsCost: { Actual: 0, Estimate: 58.86 },
      ResourcesCost: {
        Total: { Actual: 165.61, Estimate: 489 },
        LaborHours: { Actual: 1, Estimate: 3 },
      },
    },
  });

  assert.equal(fact.laborHours, 3);
  assert.equal(fact.materialCostValue, 0);
  assert.equal(fact.costValue, 165.61);
});

test("nested labor and one-off mappings preserve quantity, sell, and cost basis", () => {
  const labor = mapLaborFact(55435, 30408, {
    ID: 56701,
    LaborType: { ID: 12, Name: "Technician Normal Time" },
    LaborRate: 163,
    Total: { Qty: 6, Amount: { ExTax: 2100, IncTax: 2100 } },
  });
  const oneOff = mapItemFact(55435, 30408, "one_off", {
    ID: 43744,
    Type: "Material",
    Description: "Pressure Gauge",
    BillableStatus: "Billable",
    EstimatedCost: 18,
    ActualCost: 0,
    Total: { Qty: 2, Amount: { ExTax: 72, IncTax: 79.02 } },
  });

  assert.deepEqual(labor, {
    sectionId: 55435,
    costCenterId: 30408,
    laborId: 56701,
    laborTypeId: 12,
    laborTypeName: "Technician Normal Time",
    quantityHours: 6,
    sellExTax: 2100,
    actualCost: 978,
  });
  assert.equal(oneOff.estimatedCost, 36);
  assert.equal(oneOff.actualCost, 0);
  assert.equal(oneOff.sellExTax, 72);
});

test("every quote child upsert takes the category lock before writing", async () => {
  const statements: string[] = [];
  const query = (async <T>(sql: string) => {
    statements.push(sql);
    return { rows: [] as T[], rowCount: 1 };
  }) as PostgresQuery;
  const provenance = { sourceSnapshotId: 1, sourceHash: "source", fetchedAt: "2026-07-12T00:00:00Z" };

  await persistProjectLabor({
    projectType: "quote",
    projectId: 1,
    fact: mapLaborFact(1, 11, { ID: 101, Total: { Qty: 2 } }),
    provenance,
    traversalGeneration: 1,
    query,
  });
  await persistProjectItem({
    projectType: "quote",
    projectId: 1,
    fact: mapItemFact(1, 11, "catalog", { ID: 201, Total: { Qty: 1 } }),
    provenance,
    traversalGeneration: 1,
    query,
  });
  await persistProjectWorkOrder({
    projectType: "quote",
    projectId: 1,
    fact: mapWorkOrderFact(1, 11, { ID: 301 }),
    provenance,
    traversalGeneration: 1,
    query,
  });
  await persistScheduleBlocks({
    scheduleId: 401,
    payload: { Staff: { ID: 9 }, Blocks: [{ Hrs: 2 }] },
    provenance,
    referenceType: "quote",
    referenceId: 1,
    traversalGeneration: 1,
    query,
  });

  assert.equal(statements.length, 5);
  for (const sql of statements) {
    assert.match(sql, /with category_serialization as materialized/);
    assert.match(sql, /pg_advisory_xact_lock/);
    assert.match(sql, /project_nested_traversals/);
    assert.match(sql, /for update of traversal/);
    const mutationIndex = Math.max(sql.indexOf("insert into"), sql.indexOf("update metrics"));
    assert.ok(sql.indexOf("pg_advisory_xact_lock") < mutationIndex);
  }
});

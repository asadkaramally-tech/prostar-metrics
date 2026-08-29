import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  extractHistoricalMaterialLines,
  importMaterialsHistoryMonth,
  loadMaterialsHistoryMonthPlan,
  type MaterialsHistoryQuery,
} from "../../src/lib/store/materials-history-import";
import type { PostgresQuery } from "../../src/lib/store/postgres";

const migrations = new URL("../../infra/db/migrations/", import.meta.url);

async function database() {
  const db = new PGlite();
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(await readFile(new URL(file, migrations), "utf8"));
  }
  return db;
}

function queryFor(db: PGlite): MaterialsHistoryQuery {
  return async <T>(text: string, values?: unknown[]) => ({ rows: (await db.query<T>(text, values)).rows });
}

function transactionFor(db: PGlite) {
  const query: PostgresQuery = async <T>(text: string, values?: unknown[]) => {
    const result = await db.query<T>(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? null };
  };
  return async <T>(callback: (query: PostgresQuery) => Promise<T>) => callback(query);
}

function jobPayload() {
  return {
    ID: 101,
    CompletedDate: "2026-05-15",
    Sections: [{
      ID: 10,
      CostCenters: [{
        ID: 20,
        Items: {
          Catalogs: [{ ID: 1, Catalog: { ID: 1001, Name: "Igniter", PartNo: "IGN", Group: { Name: "Ignition", ParentGroup: { Name: "Raypak Cheat Sheet" } } }, Total: { Qty: 2, Amount: { ExTax: 232 } }, BasePrice: 58 }],
          OneOffs: [
            { ID: 2, Type: "Material", Description: "Special valve", Total: { Qty: 1, Amount: { ExTax: 500 } } },
            { ID: 3, Type: "Labor", Description: "Do not import", Total: { Qty: 5, Amount: { ExTax: 900 } } },
          ],
          Prebuilds: [{ ID: 4, Prebuild: { ID: 2001, Name: "Gas assembly" }, Total: { Qty: 3, Amount: { ExTax: 750 } } }],
          ServiceFees: [{ ID: 5, Total: { Qty: 1, Amount: { ExTax: 99 } } }],
        },
      }],
    }],
  };
}

test("raw bulk job parser keeps only billable material collections and Material one-offs", () => {
  const result = extractHistoricalMaterialLines(jobPayload(), 101);
  assert.deepEqual(result.lines.map((line) => [line.lineType, line.lineId, line.extendedExTax]), [
    ["catalog", 1, 232],
    ["one_off", 2, 500],
    ["prebuild", 4, 750],
  ]);
  assert.deepEqual(result.catalogGroups, [{
    catalogId: 1001,
    name: "Igniter",
    partNo: "IGN",
    groupName: "Ignition",
    parentGroupName: "Raypak Cheat Sheet",
  }]);
});

test("history import requires complete raw coverage and authoritatively replaces one month", async () => {
  const db = await database();
  const query = queryFor(db);
  try {
    await db.query(
      `insert into metrics.metrics_jobs (job_id, completed_date, stage, total, category, source_hash, source_version, fetched_at)
       values (101, '2026-05-15', 'Complete', 1000, 'Service', 'job-101', 'test', now())`,
    );
    await db.query(
      `insert into metrics.raw_simpro_snapshots (
         entity_type, entity_id, source_path, payload, source_hash, complete_traversal, source_version
       ) values ('jobs', '101', 'bulk', $1::jsonb, 'raw-101', true, 'bulk-test')`,
      [JSON.stringify(jobPayload())],
    );
    await db.query(
      `insert into metrics.metrics_material_lines (
         job_id, section_id, cost_center_id, line_type, line_id, period_start, completed_date, qty, extended_ex_tax
       ) values (101, 99, 99, 'one_off', 99, '2026-05-01', '2026-05-15', 1, 999)`,
    );

    const plan = await loadMaterialsHistoryMonthPlan("2026-05-01", query);
    assert.equal(plan.jobCount, 1);
    assert.equal(plan.lines.length, 3);
    await importMaterialsHistoryMonth(plan, 0, transactionFor(db));

    const lines = await db.query<{ line_id: string; extended_ex_tax: string }>(
      `select line_id::text, extended_ex_tax::text
         from metrics.metrics_material_lines
        where period_start = '2026-05-01'
        order by line_id`,
    );
    assert.deepEqual(lines.rows.map((row) => row.line_id), ["1", "2", "4"]);
    const walk = await db.query<{ status: string; job_count: number; line_count: number }>(
      `select status, job_count, line_count from metrics.materials_month_walks where period_start = '2026-05-01'`,
    );
    assert.deepEqual(walk.rows[0], { status: "complete", job_count: 1, line_count: 3 });
  } finally {
    await db.close();
  }
});

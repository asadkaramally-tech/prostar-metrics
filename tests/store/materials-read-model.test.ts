import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PostgresQuery } from "../../src/lib/store/postgres";
import {
  finishMaterialsMonthWalk,
  listChangedOlderMaterialJobs,
  needsAuthoritativeMaterialsMonthWalk,
  removeJobMaterialLines,
  recordMaterialsMonthWalkFailure,
  replaceJobMaterialLines,
  upsertCatalogGroups,
  getCatalogGroupCache,
  type MaterialsIngestQuery,
  type MaterialsIngestTransaction,
} from "../../src/lib/store/materials-ingest";
import {
  buildMaterialsReadModelPayload,
  getMaterialsTrend,
  getPersistedMaterialsReadModel,
  loadMaterialLineInputs,
  materialsFreshnessForSelectedPeriod,
  materialsPageParam,
  toMaterialsPageReadModel,
  type MaterialsRowsQuery,
} from "../../src/lib/store/materials-read-model";
import type { MaterialsReadModel } from "../../src/lib/metrics/materials";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);

async function migratedDatabase(): Promise<PGlite> {
  const db = new PGlite();
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
  return db;
}

function pgliteQuery(db: PGlite): MaterialsRowsQuery & MaterialsIngestQuery {
  return async <T>(text: string, values?: unknown[]) => {
    const result = await db.query<T>(text, values);
    return { rows: result.rows };
  };
}

function pgliteTransaction(db: PGlite): MaterialsIngestTransaction {
  const query: PostgresQuery = async <T>(text: string, values?: unknown[]) => {
    const result = await db.query<T>(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? null };
  };
  return async (callback) => callback(query);
}

function walkedLine(overrides: Record<string, unknown> = {}) {
  return {
    sectionId: 1,
    costCenterId: 2,
    lineType: "catalog" as const,
    lineId: 501,
    catalogId: 10,
    prebuildId: null,
    name: "Igniter",
    partNo: "007400F",
    qty: 2,
    extendedExTax: 232,
    basePrice: 58,
    oneOffType: null,
    ...overrides,
  };
}

test("materials mirror round trip: replace, group join, aggregation, and walk sealing", async () => {
  const db = await migratedDatabase();
  const query = pgliteQuery(db);
  const transaction = pgliteTransaction(db);
  try {
    await upsertCatalogGroups([
      { catalogId: 10, name: "IGNITER HSI 120V-KIT", partNo: "007400F", groupName: "Ignition", parentGroupName: "Raypak Cheat Sheet" },
      { catalogId: 11, name: "Contract Visit", partNo: null, groupName: "Service Contract", parentGroupName: null },
    ], query);
    const cache = await getCatalogGroupCache([10, 11, 999], query);
    assert.equal(cache.size, 2);
    assert.equal(cache.get(10)?.parentGroupName, "Raypak Cheat Sheet");

    await replaceJobMaterialLines({
      jobId: 7001,
      periodStart: "2026-07-01",
      completedDate: "2026-07-10",
      lines: [
        walkedLine(),
        walkedLine({ lineId: 502, catalogId: 11, name: null, partNo: null, qty: 1, extendedExTax: 5000 }),
        walkedLine({ lineId: 503, lineType: "one_off", catalogId: null, name: "Replacement Heater", partNo: null, qty: 1, extendedExTax: 7627.5, basePrice: null, oneOffType: "Material" }),
        walkedLine({ lineId: 504, lineType: "prebuild", catalogId: null, prebuildId: 9, name: '3/4" Gas', partNo: null, qty: 8, extendedExTax: 2000, basePrice: null }),
      ],
      fetchedAt: new Date(),
    }, transaction);
    await replaceJobMaterialLines({
      jobId: 7002,
      periodStart: "2026-06-01",
      completedDate: "2026-06-20",
      lines: [walkedLine({ lineId: 601, qty: 24, extendedExTax: 2784 })],
      fetchedAt: new Date(),
    }, transaction);
    await replaceJobMaterialLines({
      jobId: 7003,
      periodStart: "2025-07-01",
      completedDate: "2025-07-25",
      lines: [walkedLine({ lineId: 701, qty: 1, extendedExTax: 999 })],
      fetchedAt: new Date(),
    }, transaction);

    await finishMaterialsMonthWalk({ periodStart: "2026-07-01", walkStartedAt: new Date(Date.now() - 60_000), jobCount: 1, lineCount: 4, requestsUsed: 12 }, transaction);
    await finishMaterialsMonthWalk({ periodStart: "2026-06-01", walkStartedAt: new Date(Date.now() - 60_000), jobCount: 1, lineCount: 1, requestsUsed: 5 }, transaction);
    await recordMaterialsMonthWalkFailure({ periodStart: "2025-07-01", error: new Error("simulated outage") }, query);

    const inputs = await loadMaterialLineInputs(["2026-07-01", "2026-06-01", "2025-07-01"], query);
    const july = inputs.get("2026-07-01") ?? [];
    assert.equal(july.length, 4);
    const contractLine = july.find((row) => row.catalogId === 11);
    // Name and group facts come from the persistent catalog cache when the
    // line itself carries none.
    assert.equal(contractLine?.name, "Contract Visit");
    assert.equal(contractLine?.groupName, "Service Contract");

    const payload = await buildMaterialsReadModelPayload("2026-07-01", {
      query,
      now: new Date("2026-07-18T20:00:00Z"),
    });
    // The Service Contract catalog line is excluded from the total.
    assert.equal(payload.totals.current, 232 + 7627.5 + 2000);
    assert.equal(payload.totals.priorMonth, 2784);
    // 2025-07-25 falls outside the day-18 aligned window.
    assert.equal(payload.totals.priorYearSameDay, 0);
    assert.equal(payload.coverage.selectedMonth.status, "complete");
    assert.equal(payload.coverage.priorYearMonth.status, "failed");
    assert.equal(payload.coverage.excludedServiceContractLineCount, 1);
    const igniter = payload.items.find((item) => item.key === "catalog:10");
    assert.equal(igniter?.category, "Raypak Parts");
    assert.equal(igniter?.priorMonthQty, 24);
    assert.deepEqual(igniter?.jobIds, [7001]);

    // Replacing a job's walk drops lines the source no longer has.
    await replaceJobMaterialLines({
      jobId: 7001,
      periodStart: "2026-07-01",
      completedDate: "2026-07-10",
      lines: [walkedLine()],
      fetchedAt: new Date(),
    }, transaction);
    const rows = await query<{ line_id: string }>(
      `select line_id::text from metrics.metrics_material_lines where job_id = 7001 order by line_id`,
    );
    assert.deepEqual(rows.rows.map((row) => row.line_id), ["501"]);
  } finally {
    await db.close();
  }
});

test("sealing a month walk removes lines the walk did not observe", async () => {
  const db = await migratedDatabase();
  const query = pgliteQuery(db);
  const transaction = pgliteTransaction(db);
  try {
    await replaceJobMaterialLines({
      jobId: 8001,
      periodStart: "2026-07-01",
      completedDate: "2026-07-02",
      lines: [walkedLine()],
      fetchedAt: new Date("2026-07-01T00:00:00Z"),
    }, transaction);
    const walkStartedAt = new Date("2026-07-15T00:00:00Z");
    await replaceJobMaterialLines({
      jobId: 8002,
      periodStart: "2026-07-01",
      completedDate: "2026-07-03",
      lines: [walkedLine({ lineId: 777 })],
      fetchedAt: new Date("2026-07-15T01:00:00Z"),
    }, transaction);
    await finishMaterialsMonthWalk({ periodStart: "2026-07-01", walkStartedAt, jobCount: 1, lineCount: 1, requestsUsed: 3 }, transaction);

    const rows = await query<{ job_id: string }>(
      `select job_id::text from metrics.metrics_material_lines where period_start = '2026-07-01' order by job_id`,
    );
    // Job 8001 left the completion window, so its stale lines are gone.
    assert.deepEqual(rows.rows.map((row) => row.job_id), ["8002"]);

    const walk = await query<{ status: string; job_count: number }>(
      `select status, job_count from metrics.materials_month_walks where period_start = '2026-07-01'`,
    );
    assert.equal(walk.rows[0]?.status, "complete");
  } finally {
    await db.close();
  }
});

test("automatic prior-month close retries missing or stale walks and skips a completed close", async () => {
  const db = await migratedDatabase();
  const query = pgliteQuery(db);
  try {
    assert.equal(await needsAuthoritativeMaterialsMonthWalk("2026-06-01", "2026-07-01", query), true);
    await query(
      `insert into metrics.materials_month_walks (
         period_start, status, walked_at, job_count, line_count, requests_used
       ) values ('2026-06-01', 'complete', '2026-06-30T20:00:00Z', 1, 1, 1)`,
    );
    assert.equal(await needsAuthoritativeMaterialsMonthWalk("2026-06-01", "2026-07-01", query), true);
    await query(
      `update metrics.materials_month_walks
          set walked_at = '2026-07-01T13:00:00Z'
        where period_start = '2026-06-01'`,
    );
    assert.equal(await needsAuthoritativeMaterialsMonthWalk("2026-06-01", "2026-07-01", query), false);
    await query(
      `update metrics.materials_month_walks
          set status = 'failed'
        where period_start = '2026-06-01'`,
    );
    assert.equal(await needsAuthoritativeMaterialsMonthWalk("2026-06-01", "2026-07-01", query), true);
  } finally {
    await db.close();
  }
});

test("incremental materials selects only durable job-log changes for already-mirrored older jobs", async () => {
  const db = await migratedDatabase();
  const query = pgliteQuery(db);
  const transaction = pgliteTransaction(db);
  try {
    await replaceJobMaterialLines({
      jobId: 8101,
      periodStart: "2026-05-01",
      completedDate: "2026-05-20",
      lines: [walkedLine()],
      fetchedAt: new Date(),
    }, transaction);
    await replaceJobMaterialLines({
      jobId: 8102,
      periodStart: "2026-07-01",
      completedDate: "2026-07-17",
      lines: [walkedLine({ lineId: 502 })],
      fetchedAt: new Date(),
    }, transaction);
    await query(
      `insert into metrics.source_change_events (
         source_family, log_id, date_logged, source_entity_type, source_entity_id, payload, payload_hash
       ) values
         ('job_logs', 14, '2026-07-18T01:00:00Z', 'job', '8101', '{}'::jsonb, 'older'),
         ('job_logs', 15, '2026-07-18T01:01:00Z', 'job', '8102', '{}'::jsonb, 'hot'),
         ('job_logs', 16, '2026-07-18T01:02:00Z', 'job', null, '{}'::jsonb, 'unmapped')`,
    );

    const changed = await listChangedOlderMaterialJobs({
      after: { dateLogged: "2026-07-18T00:00:00Z", logId: 13 },
      through: { dateLogged: "2026-07-18T01:02:00Z", logId: 16 },
      olderThan: "2026-07-12",
    }, query);
    assert.deepEqual(changed, [{ jobId: 8101, previousPeriodStarts: ["2026-05-01"] }]);

    // The strict tuple cursor prevents a successful run from refreshing the
    // same older job again on the next bounded scheduled pass.
    assert.deepEqual(await listChangedOlderMaterialJobs({
      after: { dateLogged: "2026-07-18T01:00:00Z", logId: 14 },
      through: { dateLogged: "2026-07-18T01:02:00Z", logId: 16 },
      olderThan: "2026-07-12",
    }, query), []);

    await removeJobMaterialLines(8101, query);
    const retained = await query<{ job_id: string }>(
      `select job_id::text from metrics.metrics_material_lines order by job_id`,
    );
    assert.deepEqual(retained.rows.map((row) => row.job_id), ["8102"]);
  } finally {
    await db.close();
  }
});

test("persisted materials read model round-trips through dashboard_read_models", async () => {
  const db = await migratedDatabase();
  const query = pgliteQuery(db);
  try {
    const payload = await buildMaterialsReadModelPayload("2026-07-01", {
      query,
      now: new Date("2026-07-18T20:00:00Z"),
    });
    await db.query(
      `insert into metrics.dashboard_read_models (
         metric_family, period_grain, period_start, dimensions_json, values_json, status, rebuilt_at
       ) values ('materials', 'month', '2026-07-01', '{}'::jsonb, $1::jsonb, 'ready', now())`,
      [JSON.stringify(payload)],
    );

    const persisted = await getPersistedMaterialsReadModel("2026-07-01", query);
    assert.ok(persisted);
    assert.equal(persisted.periodStart, "2026-07-01");
    assert.deepEqual(persisted.totals, payload.totals);

    // A different month never serves the persisted July payload.
    assert.equal(await getPersistedMaterialsReadModel("2026-06-01", query), null);
  } finally {
    await db.close();
  }
});

test("materials trend loads one bounded scalar history and preserves missing coverage", async () => {
  const db = await migratedDatabase();
  const query = pgliteQuery(db);
  try {
    const value = (status: "complete" | "failed", spend: number, quantities: number[]) => ({
      totals: { current: spend },
      categories: quantities.map((qty) => ({ qty })),
      coverage: { selectedMonth: { status } },
      // A deliberately large field proves the trend contract never returns it.
      items: [{ key: "catalog:1", jobIds: [1, 2, 3] }],
    });
    await db.query(
      `insert into metrics.dashboard_read_models (
         metric_family, period_grain, period_start, dimensions_json, values_json, status, rebuilt_at
       ) values
         ('materials', 'month', '2026-05-01', '{}'::jsonb, $1::jsonb, 'ready', now()),
         ('materials', 'month', '2026-06-01', '{}'::jsonb, $2::jsonb, 'ready', now())`,
      [JSON.stringify(value("complete", 12500, [3.5, 8])), JSON.stringify(value("failed", 99999, [99]))],
    );

    const trend = await getMaterialsTrend(["2026-05-01", "2026-06-01", "2026-07-01"], query);
    assert.deepEqual(trend, [
      { periodStart: "2026-05-01", status: "complete", spend: 12500, quantity: 11.5 },
      { periodStart: "2026-06-01", status: "failed", spend: null, quantity: null },
      { periodStart: "2026-07-01", status: "missing", spend: null, quantity: null },
    ]);
    assert.equal("items" in trend[0]!, false);
  } finally {
    await db.close();
  }
});

test("materials page transport is bounded and omits job rosters", () => {
  const item = (index: number) => ({
    key: `catalog:${index}`,
    name: `Material ${index}`,
    partNo: null,
    category: "Fixture",
    qty: index,
    priorMonthQty: 0,
    unitSell: 10,
    extended: index * 10,
    jobCount: 2,
    jobIds: [index * 10, index * 10 + 1],
  });
  const model: MaterialsReadModel = {
    periodStart: "2026-07-01",
    generatedAt: "2026-07-20T00:00:00.000Z",
    totals: { current: 60, priorMonth: 0, priorYearSameDay: 0, paceProjection: 60, elapsedDays: 31, daysInMonth: 31 },
    categories: [],
    items: [item(1), item(2), item(3)],
    freshness: { pageKey: "materials", state: "current", label: "Current", detail: "", dataThrough: null, lastSuccessfulRunAt: null, lastFailedRunAt: null },
    coverage: {
      selectedMonth: { periodStart: "2026-07-01", status: "complete", walkedAt: null, jobCount: 2, lineCount: 3 },
      priorMonth: { periodStart: "2026-06-01", status: "complete", walkedAt: null, jobCount: 0, lineCount: 0 },
      priorYearMonth: { periodStart: "2025-07-01", status: "complete", walkedAt: null, jobCount: 0, lineCount: 0 },
      includedLineCount: 3,
      excludedServiceContractLineCount: 0,
    },
    warnings: [],
  };

  const page = toMaterialsPageReadModel(model, 2, 2);
  assert.deepEqual(page.itemPagination, { page: 2, pageSize: 2, total: 3, totalPages: 2 });
  assert.deepEqual(page.items.map((row) => row.key), ["catalog:3"]);
  assert.equal("jobIds" in page.items[0]!, false);
  assert.equal(model.items[2]?.jobIds.join(","), "30,31");

  for (const value of [undefined, "", "0", "-1", "1.5", "bad", "9007199254740992"]) {
    assert.equal(materialsPageParam(value), 1);
  }
  assert.equal(materialsPageParam("3"), 3);
});

test("historical materials freshness comes from the selected month walk, not the global hot window", () => {
  const global = {
    pageKey: "materials",
    state: "failed" as const,
    label: "Latest ingestion failed",
    detail: "The current month refresh failed.",
    dataThrough: "2026-07-20T00:00:00.000Z",
    lastSuccessfulRunAt: "2026-07-20T00:00:00.000Z",
    lastFailedRunAt: "2026-07-21T00:00:00.000Z",
  };
  const historical = materialsFreshnessForSelectedPeriod(global, {
    periodStart: "2026-06-01",
    status: "complete",
    walkedAt: "2026-07-01T08:00:00.000Z",
    jobCount: 12,
    lineCount: 40,
  }, new Date("2026-07-21T12:00:00-07:00"));

  assert.equal(historical.state, "current");
  assert.equal(historical.lastFailedRunAt, null);
  assert.match(historical.detail, /2026-06 materials walk is complete/);

  const current = materialsFreshnessForSelectedPeriod(global, {
    periodStart: "2026-07-01",
    status: "complete",
    walkedAt: "2026-07-21T08:00:00.000Z",
    jobCount: 2,
    lineCount: 3,
  }, new Date("2026-07-21T12:00:00-07:00"));
  assert.equal(current, global);
});

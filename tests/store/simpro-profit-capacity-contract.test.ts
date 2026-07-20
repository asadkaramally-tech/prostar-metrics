import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  enqueueProfitCapacityBackfill,
  estimateProfitCapacityBackfill,
  type ProfitCapacityBackfillQuery,
} from "../../src/lib/store/simpro-profit-capacity-backfill";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);
const migrationUrl = new URL(
  "../../infra/db/migrations/026_simpro_profit_capacity_contract.sql",
  import.meta.url,
);

test("migration 026 exposes only the locked Simpro profit/capacity column contract", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const column of [
    "net_profit_actual", "net_margin_actual", "materials_cost_actual", "materials_cost_estimate",
    "labor_cost_actual", "labor_cost_estimate", "labor_hours_actual", "labor_hours_estimate",
    "overhead_cost_actual", "overhead_cost_estimate", "total_resource_cost_actual",
    "total_resource_cost_estimate", "commission_cost_actual", "job_source_type", "job_source_id",
    "customer_name", "site_name", "configured_cost_center_name", "date_of_hire", "archived",
    "availability_json",
  ]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`));
  }
  assert.doesNotMatch(sql, /\bnett_profit_actual\b|\boverhead_actual\b|\bcommission_actual\b/);
  assert.match(sql, /create or replace function metrics\.apply_authoritative_job_cost_center_totals/);
  assert.match(sql, /create trigger metrics_job_cost_centers_authoritative_totals/);
  assert.match(sql, /snapshot\.entity_type = 'job_cost_center_detail'/);
  assert.match(sql, /not evidence that a commission was paid/i);
});

test("migration 026 applies and reruns resume failures without duplicating active queue rows", async () => {
  const db = new PGlite();
  try {
    const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));

    const columns = await db.query<{ table_name: string; column_name: string; numeric_scale: number | null }>(`
      select table_name, column_name, numeric_scale
        from information_schema.columns
       where table_schema = 'metrics'
         and (
           (table_name = 'metrics_jobs' and column_name in ('net_profit_actual', 'commission_cost_actual', 'job_source_type'))
           or (table_name = 'metrics_job_cost_centers' and column_name in ('configured_cost_center_name', 'labor_hours_estimate'))
           or (table_name = 'dim_people' and column_name in ('date_of_hire', 'archived', 'availability_json'))
         )
       order by table_name, column_name
    `);
    assert.equal(columns.rows.length, 8);
    assert.equal(columns.rows.find((row) => row.column_name === "net_profit_actual")?.numeric_scale, null);

    await db.exec(`
      insert into metrics.backfill_source_month_ledger (
        source_family, month_start, month_end_exclusive, depends_on, status,
        expected_pages, expected_records, estimated_nested_requests, estimated_requests,
        daily_request_ceiling, approved_by, approved_at, plan_hash
      ) values
        ('jobs', '2023-01-01', '2023-02-01', '{}', 'queued', 2, 10, 0, 2,
         10000, 'prior@example.test', now(), repeat('a', 64)),
        ('job_nested', '2023-01-01', '2023-02-01', '{jobs}', 'queued', 0, 10, 30, 30,
         10000, 'prior@example.test', now(), repeat('a', 64));

      insert into metrics.backfill_traversal_manifests (
        work_unit_id, generation, contract_version, manifest_status, filter_contract,
        as_of_watermark, observed_boundary
      )
      select id, 1, 1, 'collecting', '{}'::jsonb, now(), '{}'::jsonb
        from metrics.backfill_source_month_ledger;
    `);

    const query = pgliteQuery(db);
    const estimate = await estimateProfitCapacityBackfill("2023-01", "2023-01", query);
    assert.deepEqual(estimate, {
      startMonth: "2023-01-01",
      throughMonth: "2023-01-01",
      throughDate: "2023-01-31",
      months: 1,
      approvedWorkUnits: 2,
      expectedRecords: 20,
      approvedEstimatedRequests: 32,
      discoveryDays: 31,
      missingJobDetails: 0,
      missingCostCenterDetails: 0,
      missingEmployeeDetails: 0,
      minimumRequests: 31,
    });

    const queued = await enqueueProfitCapacityBackfill({
      startMonth: "2023-01",
      throughMonth: "2023-01",
      approvedBy: "Owner@Example.Test",
      query,
    });
    assert.deepEqual(queued.queued, { discovery: 31, jobDetails: 0, employees: 0 });
    assert.equal(queued.idempotent, false);

    const state = await db.query<{ discovery: number; generation: number; audits: number }>(`
      select
        (select count(*)::integer from metrics.ingestion_jobs
          where idempotency_key like 'jobs:%:simpro-profit-capacity-026') as discovery,
        (select min(generation)::integer from metrics.backfill_traversal_manifests) as generation,
        (select count(*)::integer from metrics.audit_events where action = 'simpro_profit_capacity_backfill_queued') as audits
    `);
    assert.deepEqual(state.rows[0], { discovery: 31, generation: 1, audits: 1 });

    const repeated = await enqueueProfitCapacityBackfill({
      startMonth: "2023-01",
      throughMonth: "2023-01",
      approvedBy: "owner@example.test",
      query,
    });
    assert.equal(repeated.idempotent, true);
    assert.deepEqual(repeated.queued, { discovery: 0, jobDetails: 0, employees: 0 });
    assert.equal(repeated.generation, 2);

    await db.exec(`
      update metrics.ingestion_jobs
         set status = 'failed', attempts = max_attempts, dead_lettered_at = now(),
             continuation_token = '{"page":3}'::jsonb, page_cursor = '{"page":3}'::jsonb
       where idempotency_key = 'jobs:2023-01-01:simpro-profit-capacity-026';
      update metrics.ingestion_jobs
         set status = 'running', locked_by = 'other-worker', locked_at = now(),
             lock_expires_at = now() + interval '10 minutes'
       where idempotency_key = 'jobs:2023-01-02:simpro-profit-capacity-026';
      update metrics.ingestion_jobs
         set status = 'succeeded', completed_at = now(), requests_used = 4
       where idempotency_key = 'jobs:2023-01-03:simpro-profit-capacity-026';
    `);

    const resumed = await enqueueProfitCapacityBackfill({
      startMonth: "2023-01",
      throughMonth: "2023-01",
      approvedBy: "owner@example.test",
      query,
    });
    assert.deepEqual(resumed.queued, { discovery: 2, jobDetails: 0, employees: 0 });
    assert.equal(resumed.generation, 3);

    const resumedRows = await db.query<{
      idempotency_key: string;
      status: string;
      generation: number;
      continuation_token: { page: number } | null;
      dead_lettered: boolean;
    }>(`
      select idempotency_key, status::text, generation, continuation_token,
             dead_lettered_at is not null as dead_lettered
        from metrics.ingestion_jobs
       where idempotency_key in (
         'jobs:2023-01-01:simpro-profit-capacity-026',
         'jobs:2023-01-02:simpro-profit-capacity-026',
         'jobs:2023-01-03:simpro-profit-capacity-026'
       )
       order by idempotency_key
    `);
    assert.deepEqual(resumedRows.rows, [
      {
        idempotency_key: "jobs:2023-01-01:simpro-profit-capacity-026",
        status: "queued",
        generation: 1,
        continuation_token: { page: 3 },
        dead_lettered: false,
      },
      {
        idempotency_key: "jobs:2023-01-02:simpro-profit-capacity-026",
        status: "running",
        generation: 1,
        continuation_token: null,
        dead_lettered: false,
      },
      {
        idempotency_key: "jobs:2023-01-03:simpro-profit-capacity-026",
        status: "queued",
        generation: 2,
        continuation_token: null,
        dead_lettered: false,
      },
    ]);
  } finally {
    await db.close();
  }
});

function pgliteQuery(db: PGlite): ProfitCapacityBackfillQuery {
  return async <T = Record<string, unknown>>(text: string, values?: unknown[]) => {
    const result = await db.query<T>(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? null };
  };
}

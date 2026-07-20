import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  completedJobDiscoveryParams,
  enqueueProfitCapacityBackfill,
} from "../../src/lib/store/simpro-profit-capacity-backfill";

const migrationPath = new URL(
  "../../infra/db/migrations/026_simpro_profit_capacity_contract.sql",
  import.meta.url,
);
const completenessMigrationPath = new URL(
  "../../infra/db/migrations/027_profit_capacity_completeness_gate.sql",
  import.meta.url,
);

test("completed job discovery is CompletedDate plus Complete/Archived Stage and never Status", () => {
  const params = completedJobDiscoveryParams("2026-07-12");
  assert.deepEqual(params, {
    CompletedDate: "2026-07-12",
    Stage: "in(Complete,Archived)",
    orderby: "ID",
  });
  assert.equal("Status" in params, false);
});

test("resumable seeder queues explicit completed-stage discovery and missing details by generation", async () => {
  const statements: string[] = [];
  const query = async <T = Record<string, unknown>>(text: string) => {
    statements.push(text);
    if (statements.length === 1) {
      return {
        rows: [{
          approved_work_units: 2,
          expected_records: "3",
          approved_estimated_requests: "10",
          discovery_days: 31,
          missing_job_details: 2,
          missing_cost_center_details: 4,
          missing_employee_details: 1,
        }] as T[],
        rowCount: 1,
      };
    }
    return {
      rows: [{ generation: 2, discovery_queued: 31, job_details_queued: 2, employees_queued: 1 }] as T[],
      rowCount: 1,
    };
  };

  const result = await enqueueProfitCapacityBackfill({
    startMonth: "2023-01-01",
    throughMonth: "2023-01-01",
    approvedBy: "OWNER@EXAMPLE.COM",
    query,
  });
  assert.equal(result.estimate.approvedEstimatedRequests, 10);
  assert.deepEqual(result.queued, { discovery: 31, jobDetails: 2, employees: 1 });
  assert.equal(result.generation, 2);
  assert.match(statements[0], /source_family in \('jobs', 'job_nested'\)/);
  assert.match(statements[1], /simpro_profit_capacity_backfill_queued/);
  assert.match(statements[1], /'CompletedDate'/);
  assert.match(statements[1], /'Stage', 'in\(Complete,Archived\)'/);
  assert.doesNotMatch(statements[1], /'Status'/);
  assert.match(statements[1], /'job_nested'::metrics\.ingestion_entity_type/);
  assert.match(statements[1], /:simpro-profit-capacity-026/);
  assert.match(statements[1], /profit_capacity_normalized_at is null/);
  assert.match(statements[1], /capacity_normalized_at is null/);
  assert.match(statements[1], /insert into metrics\.audit_events/);
  assert.match(statements[1], /pg_advisory_xact_lock/);
  assert.match(statements[1], /status in \('failed', 'cancelled', 'succeeded'\)/);
  assert.match(statements[1], /when metrics\.ingestion_jobs\.status = 'succeeded' then metrics\.ingestion_jobs\.generation \+ 1/);
  assert.match(statements[1], /dead_lettered_at = null/);
  assert.match(statements[1], /else metrics\.ingestion_jobs\.continuation_token/);
  assert.doesNotMatch(statements[1], /status in \('queued', 'running'/);
});

test("migration 026 defines lossless authoritative profit and capacity storage", async () => {
  const sql = await readFile(migrationPath, "utf8");
  const completenessSql = await readFile(completenessMigrationPath, "utf8");
  for (const field of [
    "net_profit_actual",
    "net_margin_actual",
    "materials_cost_actual",
    "materials_cost_estimate",
    "labor_cost_actual",
    "labor_hours_actual",
    "overhead_cost_actual",
    "total_resource_cost_actual",
    "commission_cost_actual",
    "job_source_type",
    "configured_cost_center_name",
    "totals_authoritative",
    "profit_capacity_normalized_at",
    "capacity_source",
    "date_of_hire",
    "availability_json",
  ]) {
    assert.match(sql, new RegExp(field));
  }
  assert.match(sql, /alter column total drop not null/);
  assert.match(sql, /alter column total drop default/);
  assert.match(sql, /type numeric using/);
  assert.doesNotMatch(sql, /numeric\(20, 6\)/);
  assert.match(sql, /Direct service/);
  assert.match(sql, /Recurring/);
  assert.match(sql, /not evidence that (?:a )?commission was paid/i);
  assert.match(sql, /child item sparsity is never treated as actual cost/i);
  assert.match(sql, /08:30-17:00/);
  assert.match(completenessSql, /create or replace view metrics\.simpro_profit_capacity_completeness/);
  assert.match(completenessSql, /completed_jobs_missing/);
  assert.match(completenessSql, /active_completed_cost_centers_missing/);
  assert.match(completenessSql, /people_missing/);
});

test("migration trigger normalizes existing raw cost-center detail without rounding", async () => {
  const db = new PGlite();
  try {
    const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);
    const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
    for (const migration of migrations) {
      await db.exec(await readFile(new URL(migration, migrationDirectory), "utf8"));
    }
    await db.exec(`
      insert into metrics.metrics_jobs (
        job_id, converted_from_type, converted_from_id, job_source_type, job_source_id
      ) values (101, 'Recurring', 77, 'Recurring', 77);

      insert into metrics.raw_simpro_snapshots (
        entity_type, entity_id, source_path, source_hash, payload, parent_identity
      ) values (
        'job_cost_center_detail', '101:2:3:costCenter:3', '/jobs/101/sections/2/costCenters/3',
        repeat('a', 64),
        '{
          "ID": 3,
          "Name": "Instance name",
          "CostCenter": {"ID": 9, "Name": "Configured name"},
          "Totals": {
            "NettProfitLoss": {"Actual": 123.123456789},
            "MaterialsCost": {"Actual": 0},
            "ResourcesCost": {
              "Labor": {"Actual": 10.000000001},
              "Total": {"Actual": 20.25},
              "Commission": {"Actual": 0}
            }
          }
        }'::jsonb,
        '{"projectType":"job","projectId":101,"sectionId":2,"costCenterId":3}'::jsonb
      );

      insert into metrics.metrics_job_cost_centers (
        job_id, section_id, cost_center_id, name, category
      ) values (101, 2, 3, 'stale', 'Unclassified');
    `);

    const result = await db.query<{
      source_type: string;
      source_id: string;
      instance_name: string;
      configured_name: string;
      net_profit: string;
      material_cost: string;
      commission_cost: string;
      authoritative: boolean;
    }>(`
      select job.job_source_type as source_type, job.job_source_id::text as source_id,
             cost_center.name as instance_name,
             cost_center.configured_cost_center_name as configured_name,
             cost_center.net_profit_actual::text as net_profit,
             cost_center.materials_cost_actual::text as material_cost,
             cost_center.commission_cost_actual::text as commission_cost,
             cost_center.totals_authoritative as authoritative
        from metrics.metrics_jobs job
        join metrics.metrics_job_cost_centers cost_center on cost_center.job_id = job.job_id
       where job.job_id = 101
    `);
    assert.deepEqual(result.rows[0], {
      source_type: "Recurring",
      source_id: "77",
      instance_name: "Instance name",
      configured_name: "Configured name",
      net_profit: "123.123456789",
      material_cost: "0",
      commission_cost: "0",
      authoritative: true,
    });
  } finally {
    await db.close();
  }
});

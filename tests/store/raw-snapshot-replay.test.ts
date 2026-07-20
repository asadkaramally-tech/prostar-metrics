import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  replayRawSimproSnapshots,
  type RawSnapshotNormalizer,
  type RawSnapshotReplayQuery,
} from "../../src/lib/store/raw-snapshot-replay";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);

test("replay batches only newest live job and employee detail snapshots and is idempotent", async () => {
  const db = await createReplayDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      insert into metrics.metrics_jobs (job_id) values (101);
      insert into metrics.dim_people (simpro_employee_id) values (7), (8);

      insert into metrics.raw_simpro_snapshots (
        entity_type, entity_id, source_hash, source_version, extracted_at, payload
      ) values
        ('job_details', '101', 'job-old', 'current', '2026-07-01T00:00:00Z', '{"ID":101,"version":"old"}'),
        ('job_details', '101', 'job-new', 'historical-v2', '2026-07-02T00:00:00Z', '{"ID":101,"version":"new"}'),
        ('employee_details', '7', 'employee-7-old', 'current', '2026-07-01T00:00:00Z', '{"ID":7,"version":"old"}'),
        ('employee_details', '7', 'employee-7-new', 'current', '2026-07-03T00:00:00Z', '{"ID":7,"version":"new"}'),
        ('employee_details', '8', 'employee-8', 'current', '2026-07-04T00:00:00Z', '{"ID":8,"version":"only"}');

      update metrics.raw_simpro_snapshots
         set source_deleted_at = now()
       where source_hash = 'employee-7-old';
    `);

    const normalized: Array<Parameters<RawSnapshotNormalizer>[0]> = [];
    const normalize: RawSnapshotNormalizer = async (params) => {
      normalized.push(params);
      if (params.entity === "jobs") {
        await query(
          `update metrics.metrics_jobs
              set source_snapshot_id = $1, profit_capacity_normalized_at = now()
            where job_id = $2`,
          [params.sourceSnapshotId, params.entityId],
        );
      } else {
        await query(
          `insert into metrics.employee_snapshots (employee_id, source_snapshot_id)
           values ($1, $2)
           on conflict (employee_id) do update set source_snapshot_id = excluded.source_snapshot_id`,
          [params.entityId, params.sourceSnapshotId],
        );
        await query(
          `update metrics.dim_people set capacity_normalized_at = now()
            where simpro_employee_id = $1`,
          [params.entityId],
        );
      }
      return { entity: params.entity, normalized: true, affectedPeriods: [] };
    };

    const first = await replayRawSimproSnapshots({
      query,
      normalize,
      batchSize: 2,
      maxItems: 2,
      runId: "first-run",
    });
    assert.deepEqual(first, {
      runId: "first-run",
      processed: 2,
      succeeded: 2,
      failed: 0,
      remaining: 1,
    });

    const resumed = await replayRawSimproSnapshots({
      query,
      normalize,
      batchSize: 2,
      maxItems: 10,
      runId: "resume-run",
    });
    assert.deepEqual(resumed, {
      runId: "resume-run",
      processed: 1,
      succeeded: 1,
      failed: 0,
      remaining: 0,
    });
    assert.deepEqual(
      normalized.map((item) => ({
        entity: item.entity,
        entityId: item.entityId,
        hash: item.sourceHash,
        sourceVersion: item.sourceVersion,
        version: item.payload.version,
      })),
      [
        { entity: "jobs", entityId: "101", hash: "job-new", sourceVersion: "historical-v2", version: "new" },
        { entity: "employees", entityId: "7", hash: "employee-7-new", sourceVersion: "current", version: "new" },
        { entity: "employees", entityId: "8", hash: "employee-8", sourceVersion: "current", version: "only" },
      ],
    );

    const progress = await db.query<{ batch_processed: number }>(`
      select (after_value->>'batchProcessed')::integer as batch_processed
        from metrics.audit_events
       where action = 'raw_snapshot_replay_progress'
         and entity_id in ('first-run', 'resume-run')
       order by id
    `);
    assert.deepEqual(progress.rows, [{ batch_processed: 2 }, { batch_processed: 1 }]);

    const second = await replayRawSimproSnapshots({
      query,
      normalize: async () => {
        throw new Error("idempotent replay must not normalize again");
      },
      batchSize: 1,
      maxItems: 10,
      runId: "second-run",
    });
    assert.deepEqual(second, {
      runId: "second-run",
      processed: 0,
      succeeded: 0,
      failed: 0,
      remaining: 0,
    });
  } finally {
    await db.close();
  }
});

test("cost-center replay uses migration 026 trigger totals and newest raw provenance", async () => {
  const db = new PGlite();
  const query = pgliteQuery(db);
  try {
    const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
    for (const migration of migrations) {
      await db.exec(await readFile(new URL(migration, migrationDirectory), "utf8"));
    }
    await db.exec(`
      insert into metrics.metrics_jobs (job_id) values (202);
      insert into metrics.metrics_job_cost_centers (
        job_id, section_id, cost_center_id, name, category
      ) values (202, 3, 4, 'stale', 'Unclassified');

      insert into metrics.raw_simpro_snapshots (
        entity_type, entity_id, source_path, source_hash, source_version,
        extracted_at, payload, parent_identity
      ) values
        (
          'job_cost_center_detail', '202:3:4:costCenter:4', '/jobs/202/sections/3/costCenters/4',
          'cost-old', 'current', '2026-07-01T00:00:00Z',
          '{"ID":4,"Name":"Old","Totals":{"NettProfitLoss":{"Actual":1.25}}}',
          '{"projectType":"job","projectId":202,"sectionId":3,"costCenterId":4}'
        ),
        (
          'job_cost_center_detail', '202:3:4:costCenter:4', '/jobs/202/sections/3/costCenters/4',
          'cost-new', 'current', '2026-07-02T00:00:00Z',
          '{"ID":4,"Name":"Newest","CostCenter":{"ID":44,"Name":"Configured"},"Totals":{"NettProfitLoss":{"Actual":99.123456789}}}',
          '{"projectType":"job","projectId":202,"sectionId":3,"costCenterId":4}'
        );
    `);

    const result = await replayRawSimproSnapshots({
      query,
      normalize: async () => {
        throw new Error("cost-center replay must not call a network-backed normalizer");
      },
      batchSize: 1,
      maxItems: 5,
      runId: "cost-center-run",
    });
    assert.equal(result.processed, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.remaining, 0);

    const canonical = await db.query<{
      name: string;
      configured_name: string;
      net_profit: string;
      source_hash: string;
      selected_newest: boolean;
      totals_authoritative: boolean;
    }>(`
      select cost_center.name,
             cost_center.configured_cost_center_name as configured_name,
             cost_center.net_profit_actual::text as net_profit,
             cost_center.source_hash,
             cost_center.source_snapshot_id = raw.id as selected_newest,
             cost_center.totals_authoritative
        from metrics.metrics_job_cost_centers cost_center
        join metrics.raw_simpro_snapshots raw on raw.source_hash = 'cost-new'
       where cost_center.job_id = 202 and cost_center.section_id = 3 and cost_center.cost_center_id = 4
    `);
    assert.deepEqual(canonical.rows[0], {
      name: "Newest",
      configured_name: "Configured",
      net_profit: "99.123456789",
      source_hash: "cost-new",
      selected_newest: true,
      totals_authoritative: true,
    });
  } finally {
    await db.close();
  }
});

test("local replay worker has no Simpro client or HTTP request dependency", async () => {
  const moduleSource = await readFile(
    new URL("../../src/lib/store/raw-snapshot-replay.ts", import.meta.url),
    "utf8",
  );
  const workerSource = await readFile(
    new URL("../../workers/replay-raw-snapshots.ts", import.meta.url),
    "utf8",
  );
  for (const source of [moduleSource, workerSource]) {
    assert.doesNotMatch(source, /SimproClient|SimproEndpoints|loadSimproConfig|requestBudget|fetch\s*\(/);
  }
  assert.match(moduleSource, /from metrics\.raw_simpro_snapshots snapshot/);
});

async function createReplayDatabase() {
  const db = new PGlite();
  await db.exec(`
    create schema metrics;
    create table metrics.raw_simpro_snapshots (
      id bigserial primary key,
      entity_type text not null,
      entity_id text not null,
      source_hash text not null,
      source_version text not null default 'current',
      extracted_at timestamptz not null default now(),
      payload jsonb not null,
      parent_identity jsonb not null default '{}',
      source_deleted_at timestamptz
    );
    create table metrics.metrics_jobs (
      job_id bigint primary key,
      source_snapshot_id bigint,
      profit_capacity_normalized_at timestamptz
    );
    create table metrics.employee_snapshots (
      employee_id bigint primary key,
      source_snapshot_id bigint
    );
    create table metrics.dim_people (
      simpro_employee_id bigint unique,
      capacity_normalized_at timestamptz
    );
    create table metrics.metrics_job_cost_centers (
      job_id bigint not null,
      section_id bigint not null,
      cost_center_id bigint not null,
      source_snapshot_id bigint,
      source_hash text,
      fetched_at timestamptz,
      updated_from_source_at timestamptz,
      totals_authoritative boolean not null default false,
      primary key (job_id, section_id, cost_center_id)
    );
    create table metrics.audit_events (
      id bigserial primary key,
      actor_email text not null,
      action text not null,
      entity_type text not null,
      entity_id text not null,
      after_value jsonb,
      reason text
    );
  `);
  return db;
}

function pgliteQuery(db: PGlite): RawSnapshotReplayQuery {
  return async <T = Record<string, unknown>>(text: string, values?: unknown[]) => {
    const result = await db.query<T>(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? null };
  };
}

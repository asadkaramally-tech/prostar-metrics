import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("migrations 031 and 037 are twice-safe and accept independently proven source generations", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema metrics;
      create table metrics.simpro_rate_limit_buckets (
        bucket_key text primary key, window_started_at timestamptz not null,
        request_count integer not null default 0, limit_per_second integer not null,
        updated_at timestamptz not null default now()
      );
      create table metrics.source_period_manifests (
        source_family text not null, period_start date not null, period_end date not null,
        coverage_status text not null, reconciliation_status text not null,
        listed_count integer, detail_count integer, normalized_count integer,
        source_id_hash text, normalized_id_hash text, source_value numeric(18,2),
        normalized_value numeric(18,2), continuation_token jsonb,
        evidence_as_of timestamptz not null, completed_at timestamptz,
        evidence_json jsonb not null default '{}', updated_at timestamptz not null default now(),
        primary key (source_family, period_start)
      );
      create table metrics.reconciliation_checks (
        id bigserial primary key, scope text not null, period_start date not null,
        period_end date not null, rollup_value numeric(18,4), snapshot_value numeric(18,4),
        upstream_sample_value numeric(18,4), status text not null,
        detail jsonb not null default '{}', checked_at timestamptz not null default now()
      );
      create table metrics.reconciliation_runs (id bigserial primary key);
      create table metrics.reconciliation_differences (id bigserial primary key);
      insert into metrics.reconciliation_checks (
        scope, period_start, period_end, status
      ) values ('jobs', '2026-06-01', '2026-06-30', 'matched');
    `);
    const migration = await readFile(
      new URL("../../infra/db/migrations/031_platform_data_trust_contract.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);
    await db.exec(migration);
    const independentGenerations = await readFile(
      new URL("../../infra/db/migrations/037_independent_reconciliation_source_generations.sql", import.meta.url),
      "utf8",
    );
    await db.exec(independentGenerations);
    await db.exec(independentGenerations);

    const legacy = await db.query<{ complete_traversal: boolean }>(`
      select complete_traversal from metrics.reconciliation_checks where id = 1
    `);
    assert.equal(legacy.rows[0]?.complete_traversal, false);
    for (const [generation, generationMap] of [
      [null, '{"jobs":1}'],
      [0, '{"jobs":0}'],
      [1, '{}'],
    ] as const) {
      await assert.rejects(
        db.query(`
          insert into metrics.reconciliation_checks (
            scope, period_start, period_end, status, generation,
            complete_traversal, source_manifest_generations
          ) values ('jobs', '2026-06-01', '2026-06-30', 'matched', $1, true, $2::jsonb)
        `, [generation, generationMap]),
        /reconciliation_complete_generation_proof_check/,
      );
    }

    for (const family of ["jobs", "job_nested"]) {
      await db.query(`
        insert into metrics.source_period_manifests (
          source_family, period_start, period_end, coverage_status, reconciliation_status,
          listed_count, detail_count, normalized_count, source_id_hash, normalized_id_hash,
          continuation_token, evidence_as_of, completed_at, evidence_json,
          manifest_generation, reconciliation_generation, expected_page_count,
          completed_page_count, reconciled_at
        ) values (
          $1, '2026-06-01', '2026-06-30', 'complete', 'matched',
          1, 1, 1, 'same', 'same', null, now(), now(), '{}', 7, 7, 1, 1, now()
        )
      `, [family]);
    }
    await db.exec(`
      insert into metrics.reconciliation_checks (
        scope, period_start, period_end, status, generation, complete_traversal,
        source_manifest_generations
      ) values ('jobs', '2026-06-01', '2026-06-30', 'matched', 7, true, '{"jobs":7}')
    `);
    const missingNestedMap = await db.query<{ count: number }>(`
      select count(*)::integer as count from metrics.authoritative_reconciliation_checks
    `);
    assert.equal(missingNestedMap.rows[0]?.count, 0);
    await db.exec(`
      insert into metrics.reconciliation_checks (
        scope, period_start, period_end, status, generation, complete_traversal,
        source_manifest_generations, source_count, source_value,
        normalized_count, normalized_value
      ) values (
        'jobs', '2026-06-01', '2026-06-30', 'matched', 7, true,
        '{"jobs":7,"job_nested":7}', 1, 100, 1, 100
      )
    `);
    const authoritative = await db.query<{
      generation: number;
      complete_traversal: boolean;
      source_count: string;
      normalized_count: string;
      compatibility_count: number;
    }>(`
      select generation::int, complete_traversal, source_count::text, normalized_count::text,
             (select count(*)::integer from metrics.authoritative_reconciliation_results) as compatibility_count
        from metrics.authoritative_reconciliation_checks
       where scope = 'jobs' and period_start = '2026-06-01'
    `);
    assert.deepEqual(authoritative.rows, [{
      generation: 7,
      complete_traversal: true,
      source_count: "1.0000",
      normalized_count: "1.0000",
      compatibility_count: 1,
    }]);

    for (const family of ["employees", "timesheets", "jobs_from_timesheets", "schedules", "mobile_status"]) {
      await db.query(`
        insert into metrics.source_period_manifests (
          source_family, period_start, period_end, coverage_status, reconciliation_status,
          listed_count, detail_count, normalized_count, source_id_hash, normalized_id_hash,
          continuation_token, evidence_as_of, completed_at, evidence_json,
          manifest_generation, reconciliation_generation, expected_page_count,
          completed_page_count, reconciled_at
        ) values (
          $1, '2026-06-01', '2026-06-30', 'complete', 'matched',
          1, 1, 1, 'same', 'same', null, now(), now(), '{}', 9, 9, 1, 1, now()
        )
      `, [family]);
    }
    await db.exec(`
      insert into metrics.reconciliation_checks (
        scope, period_start, period_end, status, generation, complete_traversal,
        source_manifest_generations
      ) values (
        'technicians', '2026-06-01', '2026-06-30', 'matched', 7, true,
        '{
          "jobs":7,"job_nested":7,"employees":9,"timesheets":9,
          "jobs_from_timesheets":9,"schedules":9,"mobile_status":9
        }'
      )
    `);
    const mixedGenerationAuthority = await db.query<{ count: number }>(`
      select count(*)::integer as count
        from metrics.authoritative_reconciliation_checks
       where scope = 'technicians'
    `);
    assert.equal(mixedGenerationAuthority.rows[0]?.count, 1);

    await db.exec(`
      update metrics.source_period_manifests
         set completed_page_count = 0
       where source_family = 'job_nested' and period_start = '2026-06-01'
    `);
    const invalidated = await db.query<{ count: number }>(`
      select count(*)::integer as count from metrics.authoritative_reconciliation_checks
    `);
    assert.equal(invalidated.rows[0]?.count, 0);
  } finally {
    await db.close();
  }
});

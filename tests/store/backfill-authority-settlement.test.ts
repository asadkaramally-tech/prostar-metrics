import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  claimNextBackfillWorkUnit,
  settleAuthoritativeBackfillWorkUnits,
  type BackfillQuery,
} from "../../src/lib/store/backfill-ledger";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);

test("claim maintenance settles later source-period authority and never reopens or claims it", async () => {
  const db = await migratedDatabase();
  const query = pgliteQuery(db);
  try {
    const quoteId = await seedLedger(db, "quotes", "2026-07-01", 100, {
      continuation: { targetIndex: 30, sourceContinuation: { page: 95 } },
      lastError: "backfill lease expired; resumed from the last committed continuation",
      deadLetteredAt: "2026-07-21T12:00:00Z",
    });
    await seedProvisionalTraversal(db, quoteId);
    await seedManifest(db, "quotes", "2026-07-01", {
      generation: 17,
      reconciliationGeneration: 17,
      expectedPages: 62,
      completedPages: 62,
      count: 2434,
    });
    await seedLedger(db, "jobs", "2026-07-01", 200);

    const claimed = await claimNextBackfillWorkUnit("worker-a", "2026-07-22", query);
    assert.equal(claimed?.source_family, "jobs");

    const quote = await db.query<{
      status: string;
      work_phase: string;
      reconciliation_status: string;
      reconciled_source_records: number;
      reconciled_normalized_records: number;
      normalized_coverage: string;
      reconciliation_detail: Record<string, unknown>;
      continuation_token: unknown;
      last_error: string | null;
      dead_lettered_at: string | null;
      completed_at: string | null;
      generation: number;
      manifest_status: string;
    }>(`
      select ledger.status, ledger.work_phase, ledger.reconciliation_status,
             ledger.reconciled_source_records, ledger.reconciled_normalized_records,
             ledger.normalized_coverage::text, ledger.reconciliation_detail,
             ledger.continuation_token, ledger.last_error, ledger.dead_lettered_at::text,
             ledger.completed_at::text, traversal.generation, traversal.manifest_status
        from metrics.backfill_source_month_ledger ledger
        join metrics.backfill_traversal_manifests traversal on traversal.work_unit_id = ledger.id
       where ledger.id = $1
    `, [quoteId]);
    assert.deepEqual(quote.rows[0], {
      status: "completed",
      work_phase: "reconcile",
      reconciliation_status: "matched",
      reconciled_source_records: 2434,
      reconciled_normalized_records: 2434,
      normalized_coverage: "100.0000",
      reconciliation_detail: {
        authority: "source_period_manifest",
        settledBy: "backfill_claim_maintenance",
        listedCount: 2434,
        detailCount: 2434,
        normalizedCount: 2434,
        manifestGeneration: 17,
        reconciliationGeneration: 17,
        expectedPageCount: 62,
        completedPageCount: 62,
        reconciledAt: quote.rows[0].reconciliation_detail.reconciledAt,
      },
      continuation_token: null,
      last_error: null,
      dead_lettered_at: null,
      completed_at: quote.rows[0].completed_at,
      generation: 1,
      manifest_status: "provisional",
    });
    assert.ok(quote.rows[0].completed_at);
    assert.ok(quote.rows[0].reconciliation_detail.reconciledAt);

    const audits = await settlementAudits(db);
    assert.deepEqual(audits, [{
      source_family: "quotes",
      before_status: "queued",
      after_status: "completed",
      actor_email: "system:backfill-authority-settlement",
    }]);

    assert.deepEqual(await settleAuthoritativeBackfillWorkUnits(query), { completed: 0 });
    assert.deepEqual(await settlementAudits(db), audits);
  } finally {
    await db.close();
  }
});

test("settlement fails closed for stale generations and incomplete page proof", async () => {
  const db = await migratedDatabase();
  const query = pgliteQuery(db);
  try {
    await seedLedger(db, "schedules", "2026-07-01", 100);
    await seedManifest(db, "schedules", "2026-07-01", {
      generation: 17,
      reconciliationGeneration: 16,
      expectedPages: 10,
      completedPages: 10,
      count: 50,
    });
    await seedLedger(db, "employees", "2026-07-01", 110);
    await seedManifest(db, "employees", "2026-07-01", {
      generation: 17,
      reconciliationGeneration: 17,
      expectedPages: 10,
      completedPages: 9,
      count: 50,
    });

    assert.deepEqual(await settleAuthoritativeBackfillWorkUnits(query), { completed: 0 });
    const statuses = await db.query<{ source_family: string; status: string }>(`
      select source_family, status
        from metrics.backfill_source_month_ledger
       order by source_family
    `);
    assert.deepEqual(statuses.rows, [
      { source_family: "employees", status: "queued" },
      { source_family: "schedules", status: "queued" },
    ]);
    assert.deepEqual(await settlementAudits(db), []);
  } finally {
    await db.close();
  }
});

test("claim skips authority published after the maintenance settlement snapshot", async () => {
  const db = await migratedDatabase();
  const baseQuery = pgliteQuery(db);
  try {
    await seedLedger(db, "quotes", "2026-07-01", 100);
    await seedLedger(db, "jobs", "2026-07-01", 200);
    let authorityPublished = false;
    const racingQuery = (async <T>(sql: string, values: unknown[] = []) => {
      if (!authorityPublished && sql.includes("with candidate as materialized")) {
        authorityPublished = true;
        await seedManifest(db, "quotes", "2026-07-01", {
          generation: 17,
          reconciliationGeneration: 17,
          expectedPages: 62,
          completedPages: 62,
          count: 2434,
        });
      }
      return baseQuery<T>(sql, values);
    }) as BackfillQuery;

    const claimed = await claimNextBackfillWorkUnit("worker-race", "2026-07-22", racingQuery);
    assert.equal(authorityPublished, true);
    assert.equal(claimed?.source_family, "jobs");
    const quote = await db.query<{ status: string }>(`
      select status
        from metrics.backfill_source_month_ledger
       where source_family = 'quotes' and month_start = date '2026-07-01'
    `);
    assert.equal(quote.rows[0].status, "queued");
  } finally {
    await db.close();
  }
});

async function migratedDatabase() {
  const db = new PGlite();
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
  return db;
}

function pgliteQuery(db: PGlite): BackfillQuery {
  return (async <T>(sql: string, values: unknown[] = []) => {
    const result = await db.query<T>(sql, values as never[]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }) as BackfillQuery;
}

async function seedLedger(
  db: PGlite,
  sourceFamily: string,
  monthStart: string,
  queuePriority: number,
  options: {
    continuation?: Record<string, unknown>;
    lastError?: string;
    deadLetteredAt?: string;
  } = {},
) {
  const result = await db.query<{ id: string }>(`
    insert into metrics.backfill_source_month_ledger (
      source_family, month_start, month_end_exclusive, status,
      expected_pages, expected_records, estimated_nested_requests, estimated_requests,
      daily_request_ceiling, queue_priority, request_slice_limit,
      continuation_token, last_error, dead_lettered_at,
      approved_by, approved_at, plan_hash
    ) values (
      $1, $2::date, ($2::date + interval '1 month')::date, 'queued',
      100, 100, 0, 100, 10000, $3, 250,
      $4::jsonb, $5, $6::timestamptz,
      'test@example.com', now(), repeat('a', 64)
    ) returning id::text
  `, [
    sourceFamily,
    monthStart,
    queuePriority,
    options.continuation ? JSON.stringify(options.continuation) : null,
    options.lastError ?? null,
    options.deadLetteredAt ?? null,
  ]);
  return Number(result.rows[0].id);
}

async function seedProvisionalTraversal(db: PGlite, workUnitId: number) {
  await db.query(`
    insert into metrics.backfill_traversal_manifests (
      work_unit_id, generation, contract_version, manifest_status, filter_contract,
      as_of_watermark, observed_boundary, exact_source_ids, listed_source_ids,
      detailed_source_ids, page_count, record_count, completed_at
    ) values (
      $1, 1, 1, 'provisional', '{"provisional":true}'::jsonb, now(),
      '{"effectiveEndInclusive":"2026-07-01","provisional":true}'::jsonb,
      '["101"]'::jsonb, '["101"]'::jsonb, '["101"]'::jsonb, 1, 1, now()
    )
  `, [workUnitId]);
}

async function seedManifest(
  db: PGlite,
  sourceFamily: string,
  monthStart: string,
  options: {
    generation: number;
    reconciliationGeneration: number;
    expectedPages: number;
    completedPages: number;
    count: number;
  },
) {
  await db.query(`
    insert into metrics.source_period_manifests (
      source_family, period_start, period_end, coverage_status, reconciliation_status,
      listed_count, detail_count, normalized_count, source_id_hash, normalized_id_hash,
      continuation_token, evidence_as_of, completed_at, manifest_generation,
      reconciliation_generation, expected_page_count, completed_page_count, reconciled_at
    ) values (
      $1, $2::date, ($2::date + interval '1 month - 1 day')::date, 'complete', 'matched',
      $3, $3, $3, repeat('b', 64), repeat('b', 64), null, now(), now(), $4, $5, $6, $7, now()
    )
  `, [
    sourceFamily,
    monthStart,
    options.count,
    options.generation,
    options.reconciliationGeneration,
    options.expectedPages,
    options.completedPages,
  ]);
}

async function settlementAudits(db: PGlite) {
  const result = await db.query<{
    source_family: string;
    before_status: string;
    after_status: string;
    actor_email: string;
  }>(`
    select before_value->>'source_family' as source_family,
           before_value->>'status' as before_status,
           after_value->>'status' as after_status,
           actor_email
      from metrics.audit_events
     where actor_email = 'system:backfill-authority-settlement'
     order by source_family
  `);
  return result.rows;
}

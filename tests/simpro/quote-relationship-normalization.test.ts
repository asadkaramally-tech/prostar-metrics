import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { normalizeSimproSnapshot } from "../../src/lib/simpro/normalize";
import {
  beginProjectNestedTraversal,
  emptyNestedTraversalSeen,
  finalizeProjectNestedTraversal,
} from "../../src/lib/simpro/normalize-nested";
import {
  inspectQuoteClassificationRebuild,
  quoteClassificationRebuildSql,
  type QuoteClassificationRebuildTransaction,
} from "../../src/lib/store/quote-classification-rebuild";
import { loadQuoteDashboardRows } from "../../src/lib/store/quote-dashboard-read-model";
import type { PostgresQuery } from "../../src/lib/store/postgres";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);

test("incremental quote and job normalization reconciles raw relationships atomically", async () => {
  const db = await migratedDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      insert into metrics.metrics_jobs (
        job_id, job_no, converted_from_type, converted_from_id,
        job_source_type, job_source_id, category
      ) values
        (400, 'LIVE-400', 'Direct service', null, 'Direct service', null, 'Unclassified'),
        (500, 'LIVE-500', 'Direct service', null, 'Direct service', null, 'Unclassified');
      insert into metrics.job_snapshots (job_id, job_no, source_quote_id)
      values (400, 'LIVE-400', null), (500, 'LIVE-500', null);
      insert into metrics.raw_simpro_snapshots (
        entity_type, entity_id, source_path, payload, source_hash,
        extracted_at, complete_traversal
      ) values
        ('job_details', '400', '/jobs/400', '{"ID":400,"ConvertedFrom":null}',
         'job-400-authority', timestamptz '2026-07-01 00:00:00+00', true),
        ('job_details', '500', '/jobs/500', '{"ID":500,"ConvertedFrom":null}',
         'job-500-authority', timestamptz '2026-07-01 00:00:01+00', true)
    `);

    await normalizeInTransaction(db, query, "quotes", 900, quotePayload({ LinkedJobID: 400 }));
    assert.deepEqual(await quoteState(db, 900), {
      canonical_linked_job_id: 400,
      snapshot_linked_job_id: 400,
      outcome: "won",
      won: true,
    });

    await normalizeInTransaction(db, query, "quotes", 900, quotePayload({ LinkedJobID: null }));
    assert.deepEqual(await quoteState(db, 900), {
      canonical_linked_job_id: null,
      snapshot_linked_job_id: null,
      outcome: "lost",
      won: false,
    });

    await normalizeInTransaction(db, query, "quotes", 900, quotePayload({ LinkedJobID: 500 }));
    assert.deepEqual(await quoteState(db, 900), {
      canonical_linked_job_id: 500,
      snapshot_linked_job_id: 500,
      outcome: "won",
      won: true,
    });

    const beforeConflict = await persistedQuoteState(db, 900);
    await assert.rejects(
      normalizeInTransaction(db, query, "quotes", 900, quotePayload({
        LinkedJobID: 400,
        linkedJobId: 500,
      })),
      /direct-link scalar fields conflict/,
    );
    assert.deepEqual(await persistedQuoteState(db, 900), beforeConflict);

    await normalizeInTransaction(db, query, "quotes", 901, quotePayload({ LinkedJobID: null }));
    await db.exec(`
      insert into metrics.raw_simpro_snapshots (
        entity_type, entity_id, source_path, payload, source_hash,
        extracted_at, complete_traversal
      ) values (
        'quote_details', '901', '/quotes/901',
        '{"ID":901,"LinkedJobID":null}', 'quote-901-authority',
        timestamptz '2026-07-02 00:00:00+00', true
      )
    `);
    await normalizeInTransaction(db, query, "jobs", 703, jobPayload({
      ConvertedFrom: { Type: "Quote", ID: 901 },
    }));
    assert.equal((await quoteState(db, 901))?.outcome, "won");
    assert.deepEqual(await inverseState(db, 703), {
      converted_from_type: "Quote",
      converted_from_id: 901,
      source_quote_id: 901,
    });

    await normalizeInTransaction(db, query, "jobs", 703, jobPayload({ ConvertedFrom: null }));
    assert.equal((await quoteState(db, 901))?.outcome, "lost");
    assert.deepEqual(await inverseState(db, 703), {
      converted_from_type: "Direct service",
      converted_from_id: null,
      source_quote_id: null,
    });

    const beforeInverseConflict = await inverseState(db, 703);
    await assert.rejects(
      normalizeInTransaction(db, query, "jobs", 703, jobPayload({
        ConvertedFrom: { Type: "Quote", ID: 901 },
        convertedFrom: { Type: "Quote", ID: 902 },
      })),
      /ConvertedFrom ID aliases conflict/,
    );
    assert.deepEqual(await inverseState(db, 703), beforeInverseConflict);

    await db.exec(`
      insert into metrics.quote_classification_overrides (
        quote_id, category, action, outcome, previous_outcome, reason,
        actor_email, revision, idempotency_key, active
      ) values (
        900, 'Unclassified', 'exclude', 'excluded', 'won',
        'Reviewer attack exclusion.', 'reviewer@example.test', 1,
        'normalization-exclusion-900', true
      )
    `);
    await normalizeInTransaction(db, query, "quotes", 900, quotePayload({
      LinkedJobID: 500,
      Status: { ID: 99, Name: "Quote Accepted Online" },
    }));
    assert.deepEqual(await quoteState(db, 900), {
      canonical_linked_job_id: 500,
      snapshot_linked_job_id: 500,
      outcome: "excluded",
      won: false,
    });
  } finally {
    await db.close();
  }
});

test("incomplete quote roots retain complete direct authority until completion atomically adds or removes it", async () => {
  const db = await migratedDatabase();
  const query = pgliteQuery(db);
  const transaction = pgliteTransaction(db, query);
  try {
    await db.exec(`
      insert into metrics.metrics_jobs (
        job_id, job_no, converted_from_type, converted_from_id,
        job_source_type, job_source_id, category
      ) values
        (400, 'LIVE-400', 'Direct service', null, 'Direct service', null, 'Unclassified'),
        (500, 'LIVE-500', 'Direct service', null, 'Direct service', null, 'Unclassified');
      insert into metrics.job_snapshots (job_id, job_no, source_quote_id)
      values (400, 'LIVE-400', null), (500, 'LIVE-500', null);
      insert into metrics.raw_simpro_snapshots (
        entity_type, entity_id, source_path, payload, source_hash,
        extracted_at, complete_traversal
      ) values
        ('job_details', '400', '/jobs/400', '{"ID":400,"ConvertedFrom":null}',
         'job-400-complete', timestamptz '2026-07-01 00:00:00+00', true),
        ('job_details', '500', '/jobs/500', '{"ID":500,"ConvertedFrom":null}',
         'job-500-complete', timestamptz '2026-07-01 00:00:01+00', true)
    `);

    await writeRootAndNormalize(db, query, {
      entity: "quotes",
      entityId: 900,
      payload: quotePayload({ LinkedJobID: 400 }),
      completeTraversal: true,
      sourceHash: "quote-900-complete-400",
      extractedAt: "2026-07-01T00:01:00.000Z",
    });

    const replacementGeneration = await beginProjectNestedTraversal("quote", 900, transaction);
    await db.query(
      `insert into metrics.metrics_quote_cost_centers (
         quote_id, section_id, cost_center_id, configured_cost_center_id,
         category, sell_value, traversal_generation
       ) values (900, 1, 1, 7, 'HVAC', 1000, $1)`,
      [replacementGeneration],
    );
    const replacementSnapshotId = await writeRootAndNormalize(db, query, {
      entity: "quotes",
      entityId: 900,
      payload: quotePayload({ LinkedJobID: 500 }),
      completeTraversal: false,
      sourceHash: "quote-900-incomplete-500",
      extractedAt: "2026-07-02T00:00:00.000Z",
    });

    assert.deepEqual(await quoteState(db, 900), {
      canonical_linked_job_id: 400,
      snapshot_linked_job_id: 400,
      outcome: "won",
      won: true,
    });
    assert.equal((await loadQuoteDashboardRows(query))[0]?.linked_job_id, "400");
    assert.equal((await inspectQuoteClassificationRebuild(query)).changedQuoteCount, 0);

    await finalizeProjectNestedTraversal({
      projectType: "quote",
      projectId: 900,
      generation: replacementGeneration,
      rootSnapshotId: replacementSnapshotId,
      seen: emptyNestedTraversalSeen(),
      query,
      transaction,
    });
    assert.deepEqual(await quoteState(db, 900), {
      canonical_linked_job_id: 500,
      snapshot_linked_job_id: 500,
      outcome: "won",
      won: true,
    });

    const removalGeneration = await beginProjectNestedTraversal("quote", 900, transaction);
    await db.query(
      `update metrics.metrics_quote_cost_centers
          set traversal_generation = $2, source_deleted_at = null
        where quote_id = $1`,
      [900, removalGeneration],
    );
    const removalSnapshotId = await writeRootAndNormalize(db, query, {
      entity: "quotes",
      entityId: 900,
      payload: quotePayload({ LinkedJobID: null }),
      completeTraversal: false,
      sourceHash: "quote-900-incomplete-removed",
      extractedAt: "2026-07-03T00:00:00.000Z",
    });
    assert.equal((await quoteState(db, 900))?.canonical_linked_job_id, 500);

    await finalizeProjectNestedTraversal({
      projectType: "quote",
      projectId: 900,
      generation: removalGeneration,
      rootSnapshotId: removalSnapshotId,
      seen: emptyNestedTraversalSeen(),
      query,
      transaction,
    });
    assert.deepEqual(await quoteState(db, 900), {
      canonical_linked_job_id: null,
      snapshot_linked_job_id: null,
      outcome: "lost",
      won: false,
    });
    assert.equal((await inspectQuoteClassificationRebuild(query)).changedQuoteCount, 0);
  } finally {
    await db.close();
  }
});

test("incomplete job roots retain complete inverse authority until completion atomically adds or removes it", async () => {
  const db = await migratedDatabase();
  const query = pgliteQuery(db);
  const transaction = pgliteTransaction(db, query);
  try {
    for (const quoteId of [901, 902]) {
      await writeRootAndNormalize(db, query, {
        entity: "quotes",
        entityId: quoteId,
        payload: quotePayload({ ID: quoteId, QuoteNo: `Q-${quoteId}`, LinkedJobID: null }),
        completeTraversal: true,
        sourceHash: `quote-${quoteId}-complete`,
        extractedAt: `2026-07-01T00:0${quoteId - 900}:00.000Z`,
      });
    }
    await writeRootAndNormalize(db, query, {
      entity: "jobs",
      entityId: 703,
      payload: jobPayload({ ConvertedFrom: null }),
      completeTraversal: true,
      sourceHash: "job-703-complete-direct",
      extractedAt: "2026-07-01T00:03:00.000Z",
    });

    const additionGeneration = await beginProjectNestedTraversal("job", 703, transaction);
    const additionSnapshotId = await writeRootAndNormalize(db, query, {
      entity: "jobs",
      entityId: 703,
      payload: jobPayload({ ConvertedFrom: { Type: "Quote", ID: 901 } }),
      completeTraversal: false,
      sourceHash: "job-703-incomplete-quote-901",
      extractedAt: "2026-07-02T00:00:00.000Z",
    });
    assert.deepEqual(await inverseState(db, 703), {
      converted_from_type: "Direct service",
      converted_from_id: null,
      source_quote_id: null,
    });
    assert.equal((await quoteState(db, 901))?.outcome, "lost");

    await finalizeProjectNestedTraversal({
      projectType: "job",
      projectId: 703,
      generation: additionGeneration,
      rootSnapshotId: additionSnapshotId,
      seen: emptyNestedTraversalSeen(),
      query,
      transaction,
    });
    assert.deepEqual(await inverseState(db, 703), {
      converted_from_type: "Quote",
      converted_from_id: 901,
      source_quote_id: 901,
    });
    assert.equal((await quoteState(db, 901))?.outcome, "won");

    const removalGeneration = await beginProjectNestedTraversal("job", 703, transaction);
    const removalSnapshotId = await writeRootAndNormalize(db, query, {
      entity: "jobs",
      entityId: 703,
      payload: jobPayload({ ConvertedFrom: null }),
      completeTraversal: false,
      sourceHash: "job-703-incomplete-removed",
      extractedAt: "2026-07-03T00:00:00.000Z",
    });
    assert.deepEqual(await inverseState(db, 703), {
      converted_from_type: "Quote",
      converted_from_id: 901,
      source_quote_id: 901,
    });
    assert.equal((await quoteState(db, 901))?.outcome, "won");

    await finalizeProjectNestedTraversal({
      projectType: "job",
      projectId: 703,
      generation: removalGeneration,
      rootSnapshotId: removalSnapshotId,
      seen: emptyNestedTraversalSeen(),
      query,
      transaction,
    });
    assert.deepEqual(await inverseState(db, 703), {
      converted_from_type: "Direct service",
      converted_from_id: null,
      source_quote_id: null,
    });
    assert.equal((await quoteState(db, 901))?.outcome, "lost");
    assert.equal((await inspectQuoteClassificationRebuild(query)).changedQuoteCount, 0);
  } finally {
    await db.close();
  }
});

test("bulk rebuild clears stale inverse values for normalized legacy Quote type variants", async () => {
  const db = await migratedDatabase();
  try {
    await db.exec(`
      insert into metrics.metrics_jobs (
        job_id, job_no, converted_from_type, converted_from_id,
        job_source_type, job_source_id, category
      ) values
        (801, 'J-801', ' quote ', 901, 'qUoTe', 901, 'Unclassified'),
        (802, 'J-802', 'Direct service', null, ' QUOTE ', 902, 'Unclassified');
      insert into metrics.job_snapshots (job_id, job_no, source_quote_id)
      values (801, 'J-801', 901), (802, 'J-802', 902);
      insert into metrics.raw_simpro_snapshots (
        entity_type, entity_id, source_path, payload, source_hash,
        extracted_at, complete_traversal
      ) values
        ('job_details', '801', '/jobs/801', '{"ID":801,"ConvertedFrom":null}',
         'job-801-complete-direct', timestamptz '2026-07-01 00:00:00+00', true),
        ('job_details', '802', '/jobs/802', '{"ID":802,"ConvertedFrom":null}',
         'job-802-complete-direct', timestamptz '2026-07-01 00:00:01+00', true)
    `);

    await db.query(quoteClassificationRebuildSql);

    const result = await db.query<{
      job_id: number;
      converted_from_type: string;
      converted_from_id: number | null;
      job_source_type: string;
      job_source_id: number | null;
      snapshot_source_quote_id: number | null;
    }>(`
      select job.job_id::integer, job.converted_from_type, job.converted_from_id::integer,
             job.job_source_type, job.job_source_id::integer,
             snapshot.source_quote_id::integer as snapshot_source_quote_id
        from metrics.metrics_jobs job
        join metrics.job_snapshots snapshot using (job_id)
       where job.job_id in (801, 802)
       order by job.job_id
    `);
    assert.deepEqual(result.rows, [
      {
        job_id: 801,
        converted_from_type: "Direct service",
        converted_from_id: null,
        job_source_type: "Direct service",
        job_source_id: null,
        snapshot_source_quote_id: null,
      },
      {
        job_id: 802,
        converted_from_type: "Direct service",
        converted_from_id: null,
        job_source_type: "Direct service",
        job_source_id: null,
        snapshot_source_quote_id: null,
      },
    ]);
  } finally {
    await db.close();
  }
});

function quotePayload(overrides: Record<string, unknown>) {
  return {
    ID: 900,
    QuoteNo: "Q-900",
    Name: "Relationship attack quote",
    DateIssued: "2026-06-01",
    DateApproved: "2026-06-02",
    Status: { ID: 1, Name: "Pending" },
    Stage: { ID: 1, Name: "Pending" },
    Total: { ExTax: 1_000 },
    ...overrides,
  };
}

function jobPayload(overrides: Record<string, unknown>) {
  return {
    ID: 703,
    JobNo: "J-703",
    Name: "Relationship attack job",
    Status: { ID: 1, Name: "Pending" },
    Stage: { ID: 1, Name: "Pending" },
    Total: { ExTax: 1_000 },
    ...overrides,
  };
}

async function normalizeInTransaction(
  db: PGlite,
  query: PostgresQuery,
  entity: "quotes" | "jobs",
  entityId: number,
  payload: Record<string, unknown>,
) {
  await db.exec("begin");
  try {
    const source = JSON.stringify(payload);
    const snapshot = await query<{ id: string }>(
      `insert into metrics.raw_simpro_snapshots (
         entity_type, entity_id, source_path, payload, source_hash,
         extracted_at, complete_traversal
       ) values ($1, $2, $3, $4::jsonb, $5, now(), true)
       returning id::text`,
      [
        entity === "quotes" ? "quote_details" : "job_details",
        String(entityId),
        `/${entity}/${entityId}`,
        source,
        `${entity}-${entityId}-${source}`,
      ],
    );
    const result = await normalizeSimproSnapshot({
      entity,
      entityId: String(entityId),
      payload,
      sourceSnapshotId: Number(snapshot.rows[0]?.id),
      sourceHash: `${entity}-${entityId}-${JSON.stringify(payload)}`,
      fetchedAt: "2026-07-13T00:00:00.000Z",
      query,
    });
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

async function writeRootAndNormalize(
  db: PGlite,
  query: PostgresQuery,
  params: {
    entity: "quotes" | "jobs";
    entityId: number;
    payload: Record<string, unknown>;
    completeTraversal: boolean;
    sourceHash: string;
    extractedAt: string;
  },
): Promise<number> {
  await db.exec("begin");
  try {
    const entityType = params.entity === "quotes" ? "quote_details" : "job_details";
    const snapshot = await query<{ id: string }>(
      `insert into metrics.raw_simpro_snapshots (
         entity_type, entity_id, source_path, payload, source_hash,
         extracted_at, complete_traversal
       ) values ($1, $2, $3, $4::jsonb, $5, $6::timestamptz, $7)
       returning id::text`,
      [
        entityType,
        String(params.entityId),
        `/${params.entity}/${params.entityId}`,
        JSON.stringify(params.payload),
        params.sourceHash,
        params.extractedAt,
        params.completeTraversal,
      ],
    );
    const snapshotId = Number(snapshot.rows[0]?.id);
    assert.ok(Number.isSafeInteger(snapshotId) && snapshotId > 0);
    await normalizeSimproSnapshot({
      entity: params.entity,
      entityId: String(params.entityId),
      payload: params.payload,
      sourceSnapshotId: snapshotId,
      sourceHash: params.sourceHash,
      fetchedAt: params.extractedAt,
      query,
    });
    await db.exec("commit");
    return snapshotId;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

async function migratedDatabase() {
  const db = new PGlite();
  const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const migration of migrations) {
    await db.exec(await readFile(new URL(migration, migrationDirectory), "utf8"));
  }
  return db;
}

function pgliteQuery(db: PGlite): PostgresQuery {
  return async <T>(sql: string, values: unknown[] = []) => {
    const result = await db.query<T>(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
}

function pgliteTransaction(
  db: PGlite,
  query: PostgresQuery,
): QuoteClassificationRebuildTransaction {
  return async <T>(callback: (transactionQuery: PostgresQuery) => Promise<T>) => {
    await db.exec("begin");
    try {
      const result = await callback(query);
      await db.exec("commit");
      return result;
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  };
}

async function quoteState(db: PGlite, quoteId: number) {
  const result = await db.query<{
    canonical_linked_job_id: number | null;
    snapshot_linked_job_id: number | null;
    outcome: string;
    won: boolean;
  }>(`
    select quote.linked_job_id::integer as canonical_linked_job_id,
           snapshot.linked_job_id::integer as snapshot_linked_job_id,
           quote.outcome, snapshot.won
      from metrics.metrics_quotes quote
      join metrics.quote_snapshots snapshot using (quote_id)
     where quote.quote_id = $1
  `, [quoteId]);
  return result.rows[0];
}

async function persistedQuoteState(db: PGlite, quoteId: number) {
  const result = await db.query(`
    select quote.linked_job_id::text, quote.outcome, quote.outcome_reason,
           quote.updated_from_source_at::text,
           snapshot.linked_job_id::text as snapshot_linked_job_id,
           snapshot.won, snapshot.win_loss_reason, snapshot.updated_at::text
      from metrics.metrics_quotes quote
      join metrics.quote_snapshots snapshot using (quote_id)
     where quote.quote_id = $1
  `, [quoteId]);
  return result.rows[0];
}

async function inverseState(db: PGlite, jobId: number) {
  const result = await db.query<{
    converted_from_type: string;
    converted_from_id: number | null;
    source_quote_id: number | null;
  }>(`
    select job.converted_from_type, job.converted_from_id::integer,
           snapshot.source_quote_id::integer
      from metrics.metrics_jobs job
      join metrics.job_snapshots snapshot using (job_id)
     where job.job_id = $1
  `, [jobId]);
  return result.rows[0];
}

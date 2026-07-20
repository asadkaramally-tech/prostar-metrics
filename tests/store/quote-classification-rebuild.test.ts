import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  executeQuoteClassificationRebuild,
  inspectQuoteClassificationRebuild,
  QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
  quoteClassificationRebuildSql,
  reclassifyPersistedQuote,
  type QuoteClassificationRebuildTransaction,
} from "../../src/lib/store/quote-classification-rebuild";
import type { PostgresQuery } from "../../src/lib/store/postgres";
import { parseReclassifyQuoteArgs } from "../../workers/reclassify-quotes";

test("dry-run reports exact current/projected counts, changed IDs, and periods without writing", async () => {
  const db = await rebuildDatabase();
  try {
    const before = await persistedState(db);
    const preview = await inspectQuoteClassificationRebuild(pgliteQuery(db));

    assert.deepEqual(preview.servingWindow, {
      firstApprovedDate: "2025-05-02",
      lastApprovedDate: "2025-06-10",
      firstPeriod: "2025-05-01",
      lastPeriod: "2025-06-01",
    });
    assert.equal(preview.activeQuoteCount, 10);
    assert.deepEqual(preview.currentOutcomeCounts, [
      { outcome: "lost", count: 1 },
      { outcome: "unknown", count: 9 },
    ]);
    assert.deepEqual(preview.projectedOutcomeCounts, [
      { outcome: "excluded", count: 1 },
      { outcome: "lost", count: 5 },
      { outcome: "won", count: 4 },
    ]);
    assert.equal(preview.canonicalQuotesNeedingProjection, 9);
    assert.equal(preview.snapshotsNeedingProjection, 9);
    assert.equal(preview.changedQuoteCount, 9);
    assert.deepEqual(preview.changedQuoteIds, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(preview.affectedPeriods, ["2025-05-01", "2025-06-01"]);
    assert.deepEqual(await persistedState(db), before);
  } finally {
    await db.close();
  }
});

test("classification uses normalized exact online status and direct/inverse conversion paths only", async () => {
  const db = await rebuildDatabase();
  try {
    const preview = await inspectQuoteClassificationRebuild(pgliteQuery(db));
    const projected = new Map(preview.quoteStates.map((state) => [state.quoteId, state]));

    assert.equal(projected.get(1)?.projected.outcome, "won");
    assert.equal(projected.get(1)?.evidence.acceptedOnlineExact, true);

    assert.equal(projected.get(2)?.projected.outcome, "won");
    assert.equal(projected.get(2)?.evidence.acceptedOnlineExact, true);
    assert.equal(projected.get(2)?.evidence.statusName, " Quote Accepted Online ");

    assert.equal(projected.get(3)?.projected.outcome, "won");
    assert.equal(projected.get(3)?.evidence.authoritativeLinkedJobId, 300);
    assert.equal(projected.get(3)?.evidence.linkedJobMatchId, 300);

    assert.equal(projected.get(4)?.projected.outcome, "lost");
    assert.equal(projected.get(4)?.evidence.authoritativeLinkedJobId, null);
    assert.equal(projected.get(4)?.evidence.inverseConversionMatchId, null);

    assert.equal(projected.get(5)?.projected.outcome, "lost");

    assert.equal(projected.get(6)?.projected.outcome, "won");
    assert.equal(projected.get(6)?.evidence.inverseConversionMatchId, 600);

    assert.equal(projected.get(7)?.projected.outcome, "excluded");
    assert.equal(projected.get(7)?.evidence.manualExcludedOverrideId, 1);

    assert.equal(projected.get(8)?.projected.outcome, "lost");
    assert.equal(projected.get(8)?.evidence.manualExcludedOverrideId, null);

    assert.equal(projected.get(9)?.projected.outcome, "lost");
    assert.equal(projected.get(9)?.evidence.linkedJobMatchId, null);

    assert.doesNotMatch(quoteClassificationRebuildSql, /customer_stage|salesperson|is_closed/);
    assert.match(quoteClassificationRebuildSql, /lower\(trim\(coalesce\(q\.status_name, ''\)\)\) = 'quote accepted online'/);
    assert.doesNotMatch(quoteClassificationRebuildSql, /q\.status_name = 'Quote Accepted Online'/);
    assert.doesNotMatch(quoteClassificationRebuildSql, /q\.job_no/);
    assert.doesNotMatch(quoteClassificationRebuildSql, /j\.job_no/);
    assert.match(quoteClassificationRebuildSql, /authoritative_quote_linked_job_id/);
    assert.match(quoteClassificationRebuildSql, /authoritative_job_source_quote_id/);
    assert.match(quoteClassificationRebuildSql, /set linked_job_id\s*=/);
  } finally {
    await db.close();
  }
});

test("execute updates only changed canonical/snapshot rows, audits each quote, and queues each month", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    const unchangedTimestamp = await db.query<{ canonical_at: string; snapshot_at: string }>(`
      select q.updated_from_source_at::text canonical_at, s.updated_at::text snapshot_at
        from metrics.metrics_quotes q join metrics.quote_snapshots s using (quote_id)
       where q.quote_id = 10
    `);
    const result = await executeQuoteClassificationRebuild({
      actorEmail: "Owner@Example.com",
      confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
    }, { query, transaction: pgliteTransaction(db, query) });

    assert.equal(result.canonicalQuotesUpdated, 9);
    assert.equal(result.snapshotsUpdated, 9);
    assert.equal(result.auditIds.length, 9);
    assert.equal(result.rollupsQueued, 2);
    assert.equal(result.after.changedQuoteCount, 0);
    assert.deepEqual(result.after.currentOutcomeCounts, result.after.projectedOutcomeCounts);

    const unchangedAfter = await db.query<{ canonical_at: string; snapshot_at: string }>(`
      select q.updated_from_source_at::text canonical_at, s.updated_at::text snapshot_at
        from metrics.metrics_quotes q join metrics.quote_snapshots s using (quote_id)
       where q.quote_id = 10
    `);
    assert.deepEqual(unchangedAfter.rows, unchangedTimestamp.rows);

    const parity = await db.query<{ mismatches: number }>(`
      select count(*)::integer mismatches
        from metrics.metrics_quotes q
        join metrics.quote_snapshots s using (quote_id)
       where q.source_deleted_at is null and q.date_approved is not null
         and (s.linked_job_id is distinct from q.linked_job_id
           or s.won is distinct from (q.outcome = 'won')
           or s.won_value is distinct from (case when q.outcome = 'won' then q.total else 0 end)
           or s.win_loss_reason is distinct from q.outcome_reason)
    `);
    assert.equal(parity.rows[0]?.mismatches, 0);

    const audits = await db.query<{
      entity_id: string;
      actor_email: string;
      before_value: AuditValue;
      after_value: AuditValue;
    }>(`
      select entity_id, actor_email, before_value, after_value
        from metrics.audit_events order by entity_id::bigint
    `);
    assert.equal(audits.rows.length, 9);
    assert.equal(audits.rows[0]?.actor_email, "Owner@Example.com");
    const jobNumberOnlyAudit = audits.rows.find((row) => row.entity_id === "4");
    assert.equal(jobNumberOnlyAudit?.before_value.canonical.outcome, "unknown");
    assert.equal(jobNumberOnlyAudit?.after_value.canonical.outcome, "lost");
    assert.equal(jobNumberOnlyAudit?.after_value.snapshot.won, false);
    assert.equal(jobNumberOnlyAudit?.after_value.snapshot.wonValue, "0.00");

    const rollups = await db.query<{ period_start: string; metric_family: string; status: string }>(`
      select period_start::text, metric_family, status::text
        from metrics.rollup_rebuild_queue order by period_start
    `);
    assert.deepEqual(rollups.rows, [
      { period_start: "2025-05-01", metric_family: "quotes", status: "queued" },
      { period_start: "2025-06-01", metric_family: "quotes", status: "queued" },
    ]);
  } finally {
    await db.close();
  }
});

test("a rerun dry-run converges to zero changes", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await executeQuoteClassificationRebuild({
      actorEmail: "owner@example.com",
      confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
    }, { query, transaction: pgliteTransaction(db, query) });

    const preview = await inspectQuoteClassificationRebuild(query);
    assert.equal(preview.changedQuoteCount, 0);
    assert.deepEqual(preview.changedQuoteIds, []);
    assert.deepEqual(preview.affectedPeriods, []);
    assert.equal(preview.canonicalQuotesNeedingProjection, 0);
    assert.equal(preview.snapshotsNeedingProjection, 0);
    assert.deepEqual(preview.currentOutcomeCounts, preview.projectedOutcomeCounts);
  } finally {
    await db.close();
  }
});

test("JobNo-only equality remains Not Accepted before and after the descriptive match disappears", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await reclassifyPersistedQuote(4, query);
    assert.deepEqual(await quoteOutcomeAndLinks(db, 4), {
      outcome: "lost",
      canonical_linked_job_id: null,
      snapshot_linked_job_id: null,
    });

    await db.exec("update metrics.metrics_jobs set job_no = 'renumbered-400' where job_id = 400");
    await reclassifyPersistedQuote(4, query);

    assert.deepEqual(await quoteOutcomeAndLinks(db, 4), {
      outcome: "lost",
      canonical_linked_job_id: null,
      snapshot_linked_job_id: null,
    });
  } finally {
    await db.close();
  }
});

test("inverse-only acceptance becomes Not Accepted when the current inverse link disappears", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await reclassifyPersistedQuote(6, query);
    assert.deepEqual(await quoteOutcomeAndLinks(db, 6), {
      outcome: "won",
      canonical_linked_job_id: null,
      snapshot_linked_job_id: null,
    });

    await db.exec(`
      insert into metrics.raw_simpro_snapshots (
        id, entity_type, entity_id, payload, source_hash, extracted_at, complete_traversal
      ) values (560, 'job_details', '600', '{"ID":600,"ConvertedFrom":null}'::jsonb,
                'job-600-removed', timestamptz '2025-07-01 00:00:00+00', true)
    `);
    await reclassifyPersistedQuote(6, query);

    assert.deepEqual(await quoteOutcomeAndLinks(db, 6), {
      outcome: "lost",
      canonical_linked_job_id: null,
      snapshot_linked_job_id: null,
    });
    assert.deepEqual(await jobInverseState(db, 600), {
      converted_from_type: "Direct service",
      converted_from_id: null,
      job_source_type: "Direct service",
      job_source_id: null,
      snapshot_source_quote_id: null,
    });
  } finally {
    await db.close();
  }
});

test("single-record ingestion finds raw inverse evidence without loading unrelated jobs", async () => {
  const db = await rebuildDatabase();
  const baseQuery = pgliteQuery(db);
  const statements: string[] = [];
  const query = (async <T>(sql: string, values: unknown[] = []) => {
    statements.push(sql);
    return baseQuery<T>(sql, values);
  }) as PostgresQuery;
  try {
    await db.exec(`
      insert into metrics.metrics_quotes (
        quote_id, date_issued, date_approved, status_name, total,
        outcome, outcome_reason, won_reason
      ) values (11, date '2025-04-15', date '2025-07-02', 'Pending', 1100,
                'lost', 'no_acceptance_evidence', 'no_acceptance_evidence');
      insert into metrics.quote_snapshots (
        quote_id, date_issued, date_approved, total_value, won, won_value, win_loss_reason
      ) values (11, date '2025-03-15', date '2025-07-02', 1100, false, 0, 'no_acceptance_evidence');
      insert into metrics.metrics_jobs (
        job_id, job_no, converted_from_type, converted_from_id,
        job_source_type, job_source_id
      ) values
        (703, 'J-703', 'Direct service', null, 'Direct service', null),
        (704, 'J-704', 'Direct service', null, 'Direct service', null);
      insert into metrics.job_snapshots (job_id, source_quote_id) values (703, null), (704, null);
      insert into metrics.raw_simpro_snapshots (
        id, entity_type, entity_id, payload, source_hash, extracted_at, complete_traversal
      ) values
        (111, 'quote_details', '11', '{"ID":11,"LinkedJobID":null}', 'quote-11',
         timestamptz '2025-07-03 00:00:00+00', true),
        (570, 'job_details', '703', '{"ID":703,"ConvertedFrom":{"Type":"Quote","ID":11}}',
         'job-703', timestamptz '2025-07-03 00:00:01+00', true),
        (571, 'job_details', '704', '{"ID":704,"ConvertedFrom":null}',
         'job-704', timestamptz '2025-07-03 00:00:02+00', true)
    `);

    await reclassifyPersistedQuote(11, query);

    assert.match(statements[1] ?? "", /candidate_jobs as materialized/);
    assert.match(statements[1] ?? "", /metrics\.authoritative_job_source_quote_id\(latest_raw\.payload\) = any\(\$1::bigint\[\]\)/);
    assert.deepEqual(await jobInverseState(db, 703), {
      converted_from_type: "Quote",
      converted_from_id: 11,
      job_source_type: "Quote",
      job_source_id: 11,
      snapshot_source_quote_id: 11,
    });
    assert.deepEqual(await jobInverseState(db, 704), {
      converted_from_type: "Direct service",
      converted_from_id: null,
      job_source_type: "Direct service",
      job_source_id: null,
      snapshot_source_quote_id: null,
    });
    assert.equal((await quoteOutcomeAndLinks(db, 11))?.outcome, "won");
  } finally {
    await db.close();
  }
});

test("single-record ingestion classification keeps genuine source linked_job_id accepted and untouched", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await reclassifyPersistedQuote(3, query);

    assert.deepEqual(await quoteOutcomeAndLinks(db, 3), {
      outcome: "won",
      canonical_linked_job_id: 300,
      snapshot_linked_job_id: 300,
    });
  } finally {
    await db.close();
  }
});

test("bulk rebuild clears non-authoritative links while retaining inverse relationship evidence", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      update metrics.metrics_quotes
         set linked_job_id = case quote_id when 4 then 4004 when 6 then 6006 end
       where quote_id in (4, 6);
      update metrics.quote_snapshots
         set linked_job_id = case quote_id when 4 then 4004 when 6 then 6006 end
       where quote_id in (4, 6)
    `);
    const before = await derivedMatchLinks(db);
    const result = await executeQuoteClassificationRebuild({
      actorEmail: "owner@example.com",
      confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
    }, { query, transaction: pgliteTransaction(db, query) });

    assert.equal(result.after.quoteStates.find((state) => state.quoteId === 4)?.evidence.linkedJobMatchId, null);
    assert.equal(result.after.quoteStates.find((state) => state.quoteId === 4)?.projected.outcome, "lost");
    assert.equal(result.after.quoteStates.find((state) => state.quoteId === 6)?.evidence.linkedJobMatchId, null);
    assert.equal(result.after.quoteStates.find((state) => state.quoteId === 6)?.evidence.inverseConversionMatchId, 600);
    assert.deepEqual(before, [
      { quote_id: 4, canonical_linked_job_id: 4004, snapshot_linked_job_id: 4004 },
      { quote_id: 6, canonical_linked_job_id: 6006, snapshot_linked_job_id: 6006 },
    ]);
    assert.deepEqual(await derivedMatchLinks(db), [
      { quote_id: 4, canonical_linked_job_id: null, snapshot_linked_job_id: null },
      { quote_id: 6, canonical_linked_job_id: null, snapshot_linked_job_id: null },
    ]);
  } finally {
    await db.close();
  }
});

test("legacy derived IDs equal to live jobs clear and become Not Accepted after derived evidence disappears", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      update metrics.metrics_quotes
         set linked_job_id = case quote_id when 4 then 400 when 6 then 600 end,
             outcome = 'won', outcome_reason = 'converted_job', won_reason = 'converted_job'
       where quote_id in (4, 6);
      update metrics.quote_snapshots
         set linked_job_id = case quote_id when 4 then 400 when 6 then 600 end,
             won = true, won_value = total_value, win_loss_reason = 'converted_job'
       where quote_id in (4, 6);
      update metrics.metrics_jobs set job_no = 'renumbered-400' where job_id = 400;
      insert into metrics.raw_simpro_snapshots (
        id, entity_type, entity_id, payload, source_hash, extracted_at, complete_traversal
      ) values (560, 'job_details', '600', '{"ID":600,"ConvertedFrom":null}'::jsonb,
                'job-600-removed', timestamptz '2025-07-01 00:00:00+00', true)
    `);

    const result = await executeQuoteClassificationRebuild({
      actorEmail: "owner@example.com",
      confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
    }, { query, transaction: pgliteTransaction(db, query) });

    assert.equal(result.before.quoteStates.find((state) => state.quoteId === 4)?.canonical.linkedJobId, 400);
    assert.equal(result.before.quoteStates.find((state) => state.quoteId === 6)?.canonical.linkedJobId, 600);
    assert.deepEqual(await quoteOutcomeAndLinks(db, 4), {
      outcome: "lost",
      canonical_linked_job_id: null,
      snapshot_linked_job_id: null,
    });
    assert.deepEqual(await quoteOutcomeAndLinks(db, 6), {
      outcome: "lost",
      canonical_linked_job_id: null,
      snapshot_linked_job_id: null,
    });
  } finally {
    await db.close();
  }
});

test("newest complete raw snapshot restores and preserves a genuine direct LinkedJobID", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      insert into metrics.raw_simpro_snapshots (
        id, entity_type, entity_id, payload, source_hash, extracted_at,
        complete_traversal, source_deleted_at
      ) values
        (301, 'quote_details', '3', '{"ID":3,"LinkedJobID":301}'::jsonb,
         'quote-3-incomplete', timestamptz '2025-07-01 00:00:00+00', false, null),
        (302, 'quote_details', '3', '{"ID":3,"LinkedJobID":302}'::jsonb,
         'quote-3-deleted', timestamptz '2025-08-01 00:00:00+00', true,
         timestamptz '2025-08-02 00:00:00+00');
      update metrics.metrics_quotes set linked_job_id = null where quote_id = 3;
      update metrics.quote_snapshots set linked_job_id = null where quote_id = 3
    `);

    const result = await executeQuoteClassificationRebuild({
      actorEmail: "owner@example.com",
      confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
    }, { query, transaction: pgliteTransaction(db, query) });

    const state = result.after.quoteStates.find((quote) => quote.quoteId === 3);
    assert.equal(state?.evidence.authoritativeSourceSnapshotId, 103);
    assert.equal(state?.evidence.authoritativeLinkedJobId, 300);
    assert.equal(state?.evidence.linkedJobMatchId, 300);
    assert.deepEqual(await quoteOutcomeAndLinks(db, 3), {
      outcome: "won",
      canonical_linked_job_id: 300,
      snapshot_linked_job_id: 300,
    });
  } finally {
    await db.close();
  }
});

test("bulk rebuild restores raw inverse relationship 703 and reconciles canonical plus snapshot fields", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      insert into metrics.metrics_quotes (
        quote_id, date_issued, date_approved, status_name, total,
        outcome, outcome_reason, won_reason
      ) values (11, date '2025-04-15', date '2025-07-02', 'Pending', 1100,
                'lost', 'no_acceptance_evidence', 'no_acceptance_evidence');
      insert into metrics.quote_snapshots (
        quote_id, date_issued, date_approved, total_value, won, won_value, win_loss_reason
      ) values (11, date '2025-03-15', date '2025-07-02', 1100, false, 0, 'no_acceptance_evidence');
      insert into metrics.metrics_jobs (
        job_id, job_no, converted_from_type, converted_from_id,
        job_source_type, job_source_id
      ) values (703, 'J-703', 'Direct service', null, 'Direct service', null);
      insert into metrics.job_snapshots (job_id, source_quote_id) values (703, null);
      insert into metrics.raw_simpro_snapshots (
        id, entity_type, entity_id, payload, source_hash, extracted_at, complete_traversal
      ) values
        (111, 'quote_details', '11', '{"ID":11,"LinkedJobID":null}', 'quote-11',
         timestamptz '2025-07-03 00:00:00+00', true),
        (570, 'job_details', '703', '{"ID":703,"ConvertedFrom":{"Type":"Quote","ID":11}}',
         'job-703', timestamptz '2025-07-03 00:00:01+00', true)
    `);

    const preview = await inspectQuoteClassificationRebuild(query);
    const quote = preview.quoteStates.find((state) => state.quoteId === 11);
    assert.equal(quote?.projected.outcome, "won");
    assert.equal(quote?.evidence.inverseConversionMatchId, 703);
    assert.deepEqual(quote?.evidence.relationshipDriftJobIds, [703]);

    const result = await executeQuoteClassificationRebuild({
      actorEmail: "owner@example.com",
      confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
    }, { query, transaction: pgliteTransaction(db, query) });
    assert.equal(result.canonicalJobRelationshipsUpdated, 1);
    assert.equal(result.jobSnapshotRelationshipsUpdated, 1);
    assert.deepEqual(await jobInverseState(db, 703), {
      converted_from_type: "Quote",
      converted_from_id: 11,
      job_source_type: "Quote",
      job_source_id: 11,
      snapshot_source_quote_id: 11,
    });
    assert.equal((await quoteOutcomeAndLinks(db, 11))?.outcome, "won");
    assert.ok(result.before.affectedPeriods.includes("2025-03-01"));
    assert.ok(result.before.affectedPeriods.includes("2025-04-01"));
    assert.ok(result.before.affectedPeriods.includes("2025-07-01"));
  } finally {
    await db.close();
  }
});

test("bulk inverse resolver ignores incomplete and deleted newer job snapshots", async () => {
  const db = await rebuildDatabase();
  try {
    await db.exec(`
      insert into metrics.raw_simpro_snapshots (
        id, entity_type, entity_id, payload, source_hash, extracted_at,
        complete_traversal, source_deleted_at
      ) values
        (570, 'job_details', '600', '{"ID":600,"ConvertedFrom":null}', 'job-600-incomplete',
         timestamptz '2025-07-01 00:00:00+00', false, null),
        (571, 'job_details', '600', '{"ID":600,"ConvertedFrom":null}', 'job-600-deleted',
         timestamptz '2025-08-01 00:00:00+00', true, timestamptz '2025-08-02 00:00:00+00')
    `);
    const preview = await inspectQuoteClassificationRebuild(pgliteQuery(db));
    const quote = preview.quoteStates.find((state) => state.quoteId === 6);
    assert.equal(quote?.projected.outcome, "won");
    assert.equal(quote?.evidence.inverseConversionMatchId, 600);
    assert.deepEqual(quote?.evidence.relationshipDriftJobIds, []);
  } finally {
    await db.close();
  }
});

test("bulk inverse resolver fails closed atomically on conflicting aliases", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      insert into metrics.raw_simpro_snapshots (
        id, entity_type, entity_id, payload, source_hash, extracted_at, complete_traversal
      ) values (
        570, 'job_details', '600',
        '{"ID":600,"ConvertedFrom":{"Type":"Quote","ID":6},"convertedFrom":{"Type":"Quote","ID":5}}',
        'job-600-conflict', timestamptz '2025-07-01 00:00:00+00', true
      )
    `);
    const before = await persistedState(db);
    await assert.rejects(
      executeQuoteClassificationRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
      }, { query, transaction: pgliteTransaction(db, query) }),
      /job 600 is invalid: Raw job ConvertedFrom ID aliases conflict/,
    );
    assert.deepEqual(await persistedState(db), before);
    assert.deepEqual(await writeCounts(db), { audits: 0, rollups: 0 });
  } finally {
    await db.close();
  }
});

test("rebuild fails closed without complete active raw quote provenance and writes nothing", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec("delete from metrics.raw_simpro_snapshots where entity_id = '5'");
    const before = await persistedState(db);

    await assert.rejects(
      executeQuoteClassificationRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
      }, { query, transaction: pgliteTransaction(db, query) }),
      /authoritative latest complete live raw quote provenance \(missing: 5\)/,
    );

    assert.deepEqual(await persistedState(db), before);
    assert.deepEqual(await writeCounts(db), { audits: 0, rollups: 0 });
  } finally {
    await db.close();
  }
});

test("rebuild fails closed on conflicting scalar direct-link fields", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.query(
      `insert into metrics.raw_simpro_snapshots (
         id, entity_type, entity_id, payload, source_hash, extracted_at, complete_traversal
       ) values (205, 'quote_details', '5', $1::jsonb, 'quote-5-conflict',
                 timestamptz '2025-07-01 00:00:00+00', true)`,
      [JSON.stringify({ ID: 5, LinkedJobID: 500, linkedJobId: 501 })],
    );
    const before = await persistedState(db);

    await assert.rejects(
      executeQuoteClassificationRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
      }, { query, transaction: pgliteTransaction(db, query) }),
      /quote 5 is invalid: Raw quote direct-link scalar fields conflict/,
    );

    assert.deepEqual(await persistedState(db), before);
    assert.deepEqual(await writeCounts(db), { audits: 0, rollups: 0 });
  } finally {
    await db.close();
  }
});

test("rebuild fails closed on non-scalar direct-link provenance", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.query(
      `insert into metrics.raw_simpro_snapshots (
         id, entity_type, entity_id, payload, source_hash, extracted_at, complete_traversal
       ) values (205, 'quote_details', '5', $1::jsonb, 'quote-5-malformed',
                 timestamptz '2025-07-01 00:00:00+00', true)`,
      [JSON.stringify({ ID: 5, LinkedJobID: { ID: 500 } })],
    );
    const before = await persistedState(db);

    await assert.rejects(
      executeQuoteClassificationRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
      }, { query, transaction: pgliteTransaction(db, query) }),
      /quote 5 is invalid: Raw quote direct-link LinkedJobID is not a numeric or string scalar ID/,
    );

    assert.deepEqual(await persistedState(db), before);
    assert.deepEqual(await writeCounts(db), { audits: 0, rollups: 0 });
  } finally {
    await db.close();
  }
});

test("worker is dry-run by default and gates execute on actor plus the exact token", () => {
  assert.deepEqual(parseReclassifyQuoteArgs([]), {
    execute: false,
    actorEmail: "",
    confirmation: "",
  });
  assert.throws(() => parseReclassifyQuoteArgs(["--execute"]), /--actor is required/);
  assert.throws(
    () => parseReclassifyQuoteArgs([
      "--execute", "--actor", "not-an-email", "--confirm", QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
    ]),
    /valid email/,
  );
  assert.throws(
    () => parseReclassifyQuoteArgs([
      "--execute", "--actor", "owner@example.com", "--confirm", "wrong",
    ]),
    /--confirm must equal/,
  );
  assert.deepEqual(parseReclassifyQuoteArgs([
    "--execute", "--actor", "owner@example.com", "--confirm", QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
  ]), {
    execute: true,
    actorEmail: "owner@example.com",
    confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
  });
});

test("execute API validates gating before opening a transaction", async () => {
  let transactions = 0;
  const transaction: QuoteClassificationRebuildTransaction = async <T>(
    callback: (query: PostgresQuery) => Promise<T>,
  ) => {
    transactions += 1;
    return callback(async () => ({ rows: [], rowCount: 0 }));
  };

  await assert.rejects(
    executeQuoteClassificationRebuild({ actorEmail: "bad", confirmation: "wrong" }, { transaction }),
    /valid email/,
  );
  await assert.rejects(
    executeQuoteClassificationRebuild({
      actorEmail: "owner@example.com",
      confirmation: "wrong",
    }, { transaction }),
    /confirmation must equal/,
  );
  assert.equal(transactions, 0);
});

test("audit failure rolls canonical, snapshot, audit, and queue writes back", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    const before = await persistedState(db);
    await db.exec(`
      alter table metrics.audit_events
      add constraint reject_reclassification check (action <> 'quote_outcome_reclassified')
    `);
    await assert.rejects(
      executeQuoteClassificationRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
      }, { query, transaction: pgliteTransaction(db, query) }),
      /reject_reclassification/,
    );

    assert.deepEqual(await persistedState(db), before);
    assert.deepEqual(await writeCounts(db), { audits: 0, rollups: 0 });
  } finally {
    await db.close();
  }
});

test("rollup queue failure rolls canonical, snapshot, and audit writes back", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    const before = await persistedState(db);
    await db.exec(`
      alter table metrics.rollup_rebuild_queue
      add constraint reject_quote_rollup check (metric_family <> 'quotes')
    `);
    await assert.rejects(
      executeQuoteClassificationRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
      }, { query, transaction: pgliteTransaction(db, query) }),
      /reject_quote_rollup/,
    );

    assert.deepEqual(await persistedState(db), before);
    assert.deepEqual(await writeCounts(db), { audits: 0, rollups: 0 });
  } finally {
    await db.close();
  }
});

test("execute fails closed on a missing snapshot before changing canonical rows", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec("delete from metrics.quote_snapshots where quote_id = 2");
    const before = await persistedState(db);
    await assert.rejects(
      executeQuoteClassificationRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
      }, { query, transaction: pgliteTransaction(db, query) }),
      /lack quote snapshots: 2/,
    );
    assert.deepEqual(await persistedState(db), before);
    assert.deepEqual(await writeCounts(db), { audits: 0, rollups: 0 });
  } finally {
    await db.close();
  }
});

test("captured serving-set drift aborts and rolls every write back", async () => {
  const db = await rebuildDatabase();
  const baseQuery = pgliteQuery(db);
  let injected = false;
  const query = (async <T>(sql: string, values: unknown[] = []) => {
    if (!injected && sql.startsWith("update metrics.metrics_quotes q")) {
      injected = true;
      await db.exec(`
        insert into metrics.metrics_quotes (
          quote_id, date_approved, total, outcome, outcome_reason, won_reason
        ) values (44, date '2025-06-12', 44, 'unknown', 'seed', 'seed');
        insert into metrics.quote_snapshots (
          quote_id, date_approved, total_value, won_value, won, win_loss_reason
        ) values (44, date '2025-06-12', 44, 0, false, 'seed')
      `);
    }
    return baseQuery<T>(sql, values);
  }) as PostgresQuery;
  try {
    const before = await persistedState(db);
    await assert.rejects(
      executeQuoteClassificationRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
      }, { query, transaction: pgliteTransaction(db, query) }),
      /served quote set changed/,
    );
    assert.equal(injected, true);
    assert.deepEqual(await persistedState(db), before);
    assert.deepEqual(await writeCounts(db), { audits: 0, rollups: 0 });
    const added = await db.query<{ count: number }>(
      "select count(*)::integer count from metrics.metrics_quotes where quote_id = 44",
    );
    assert.equal(added.rows[0]?.count, 0);
  } finally {
    await db.close();
  }
});

test("execute rejects a mismatched transaction query before lock, read, or write", async () => {
  const db = await rebuildDatabase();
  const baseQuery = pgliteQuery(db);
  const suppliedSql: string[] = [];
  const transactionSql: string[] = [];
  const suppliedQuery = (async <T>(sql: string, values: unknown[] = []) => {
    suppliedSql.push(sql);
    return baseQuery<T>(sql, values);
  }) as PostgresQuery;
  const transactionQuery = (async <T>(sql: string, values: unknown[] = []) => {
    transactionSql.push(sql);
    return baseQuery<T>(sql, values);
  }) as PostgresQuery;
  try {
    const before = await persistedState(db);
    await assert.rejects(
      executeQuoteClassificationRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION,
      }, { query: suppliedQuery, transaction: pgliteTransaction(db, transactionQuery) }),
      /must use the query supplied by its transaction/,
    );
    assert.deepEqual(suppliedSql, []);
    assert.deepEqual(transactionSql, []);
    assert.deepEqual(await persistedState(db), before);
  } finally {
    await db.close();
  }
});

test("single-record ingestion remains ungated and uses the supplied transaction query atomically", async () => {
  const db = await rebuildDatabase();
  const baseQuery = pgliteQuery(db);
  const statements: string[] = [];
  const query = (async <T>(sql: string, values: unknown[] = []) => {
    statements.push(sql);
    return baseQuery<T>(sql, values);
  }) as PostgresQuery;
  try {
    await db.exec("begin");
    const periods = await reclassifyPersistedQuote(4, query);
    await db.exec("commit");

    assert.equal(statements.length, 3);
    assert.deepEqual(periods, [{ period_start: "2025-05-01", quote_count: 1 }]);
    const state = await db.query<{
      outcome: string;
      linked_job_id: number | null;
      won: boolean;
      won_value: string;
    }>(`
      select q.outcome, q.linked_job_id::integer, s.won, s.won_value::text
        from metrics.metrics_quotes q join metrics.quote_snapshots s using (quote_id)
       where q.quote_id = 4
    `);
    assert.deepEqual(state.rows[0], {
      outcome: "lost",
      linked_job_id: null,
      won: false,
      won_value: "0.00",
    });
    assert.deepEqual(await writeCounts(db), { audits: 0, rollups: 0 });
  } finally {
    await db.close();
  }
});

type AuditValue = {
  canonical: { outcome: string };
  snapshot: { won: boolean; wonValue: string };
};

async function rebuildDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema metrics;
    create type metrics.rollup_rebuild_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
    create table metrics.raw_simpro_snapshots (
      id bigint primary key,
      entity_type text not null,
      entity_id text not null,
      payload jsonb not null,
      source_hash text not null,
      extracted_at timestamptz not null default now(),
      complete_traversal boolean not null default false,
      source_deleted_at timestamptz
    );
    create table metrics.metrics_quotes (
      quote_id bigint primary key,
      date_issued date,
      date_approved date,
      status_name text,
      stage text,
      customer_stage text,
      salesperson_name text,
      total numeric(14, 2) not null default 0,
      linked_job_id bigint,
      job_no text,
      outcome text not null default 'unknown',
      outcome_reason text not null default 'unclassified',
      won_reason text not null default 'not_won',
      source_deleted_at timestamptz,
      updated_from_source_at timestamptz not null default timestamptz '2025-01-01 00:00:00+00'
    );
    create table metrics.metrics_jobs (
      job_id bigint primary key,
      job_no text,
      converted_from_type text,
      converted_from_id bigint,
      job_source_type text,
      job_source_id bigint,
      source_deleted_at timestamptz,
      updated_from_source_at timestamptz not null default timestamptz '2025-01-01 00:00:00+00'
    );
    create table metrics.job_snapshots (
      job_id bigint primary key,
      source_quote_id bigint,
      updated_at timestamptz not null default timestamptz '2025-01-01 00:00:00+00'
    );
    create table metrics.quote_snapshots (
      quote_id bigint primary key,
      date_issued date,
      date_approved date,
      total_value numeric(14, 2),
      linked_job_id bigint,
      won boolean,
      won_value numeric(14, 2),
      win_loss_reason text,
      updated_at timestamptz not null default timestamptz '2025-01-01 00:00:00+00'
    );
    create table metrics.quote_classification_overrides (
      id bigserial primary key,
      quote_id bigint not null,
      outcome text,
      active boolean not null default true,
      created_at timestamptz not null default now()
    );
    create table metrics.audit_events (
      id bigserial primary key,
      actor_email text not null,
      action text not null,
      entity_type text not null,
      entity_id text not null,
      before_value jsonb,
      after_value jsonb,
      reason text,
      created_at timestamptz not null default now()
    );
    create table metrics.rollup_rebuild_queue (
      id bigserial primary key,
      metric_family text not null,
      period_grain text not null,
      period_start date not null,
      dimensions_json jsonb not null default '{}'::jsonb,
      reason text not null,
      status metrics.rollup_rebuild_status not null default 'queued',
      idempotency_key text not null unique
    );
    create function metrics.authoritative_job_source_quote_id(payload jsonb)
    returns bigint language sql immutable as $$
      select case
        when payload #>> '{ConvertedFrom,Type}' = 'Quote'
          then (payload #>> '{ConvertedFrom,ID}')::bigint
        else null
      end
    $$;

    insert into metrics.metrics_quotes (
      quote_id, date_approved, status_name, stage, customer_stage, salesperson_name,
      total, linked_job_id, job_no, outcome, outcome_reason, won_reason
    ) values
      (1, date '2025-05-02', 'Quote Accepted Online', 'Pending', 'Pending', 'Nobody', 100, null, null, 'unknown', 'seed', 'seed'),
      (2, date '2025-05-03', ' Quote Accepted Online ', 'Accepted', 'Won', 'Top Seller', 200, null, null, 'unknown', 'seed', 'seed'),
      (3, date '2025-05-04', 'Pending', 'Lost', 'Lost', 'Nobody', 300, 300, null, 'unknown', 'seed', 'seed'),
      (4, date '2025-05-05', 'Pending', 'Lost', 'Lost', 'Nobody', 400, null, '400', 'unknown', 'seed', 'seed'),
      (5, date '2025-05-06', 'Pending', 'Accepted', 'Won', 'Top Seller', 500, null, 'A500', 'unknown', 'seed', 'seed'),
      (6, date '2025-06-02', 'Pending', 'Lost', 'Lost', 'Nobody', 600, null, null, 'unknown', 'seed', 'seed'),
      (7, date '2025-06-03', 'Quote Accepted Online', 'Accepted', 'Won', 'Top Seller', 700, null, null, 'unknown', 'seed', 'seed'),
      (8, date '2025-06-04', 'Pending', 'Accepted', 'Won', 'Top Seller', 800, null, null, 'unknown', 'seed', 'seed'),
      (9, date '2025-06-05', 'Pending', 'Accepted', 'Won', 'Top Seller', 900, 900, null, 'unknown', 'seed', 'seed'),
      (10, date '2025-06-10', 'Pending', 'Pending', 'Pending', 'Nobody', 1000, null, null, 'lost', 'no_acceptance_evidence', 'no_acceptance_evidence');

    insert into metrics.metrics_jobs (
      job_id, job_no, converted_from_type, converted_from_id,
      job_source_type, job_source_id, source_deleted_at
    ) values
      (300, 'J-300', null, null, 'Direct service', null, null),
      (400, '400', null, null, 'Direct service', null, null),
      (500, 'A500', null, null, 'Direct service', null, null),
      (600, 'J-600', 'Quote', 6, 'Quote', 6, null),
      (900, 'J-900', null, null, 'Direct service', null, timestamptz '2025-06-06 00:00:00+00');

    insert into metrics.job_snapshots (job_id, source_quote_id) values
      (300, null), (400, null), (500, null), (600, 6);

    insert into metrics.raw_simpro_snapshots (
      id, entity_type, entity_id, payload, source_hash, extracted_at, complete_traversal
    ) values
      (91, 'quotes', '3', '{"ID":3,"LinkedJobID":999}'::jsonb, 'quote-3-old', timestamptz '2025-01-01 00:00:00+00', true),
      (101, 'quote_details', '1', '{"ID":1,"LinkedJobID":null}'::jsonb, 'quote-1', timestamptz '2025-06-01 00:00:01+00', true),
      (102, 'quote_details', '2', '{"ID":2,"LinkedJobID":null}'::jsonb, 'quote-2', timestamptz '2025-06-01 00:00:02+00', true),
      (103, 'quote_details', '3', '{"ID":3,"LinkedJobID":300}'::jsonb, 'quote-3', timestamptz '2025-06-01 00:00:03+00', true),
      (104, 'quote_details', '4', '{"ID":4,"LinkedJobID":null}'::jsonb, 'quote-4', timestamptz '2025-06-01 00:00:04+00', true),
      (105, 'quote_details', '5', '{"ID":5,"LinkedJobID":null}'::jsonb, 'quote-5', timestamptz '2025-06-01 00:00:05+00', true),
      (106, 'quote_details', '6', '{"ID":6,"LinkedJobID":null}'::jsonb, 'quote-6', timestamptz '2025-06-01 00:00:06+00', true),
      (107, 'quote_details', '7', '{"ID":7,"LinkedJobID":null}'::jsonb, 'quote-7', timestamptz '2025-06-01 00:00:07+00', true),
      (108, 'quote_details', '8', '{"ID":8,"LinkedJobID":null}'::jsonb, 'quote-8', timestamptz '2025-06-01 00:00:08+00', true),
      (109, 'quote_details', '9', '{"ID":9,"LinkedJobID":900}'::jsonb, 'quote-9', timestamptz '2025-06-01 00:00:09+00', true),
      (110, 'quote_details', '10', '{"ID":10,"LinkedJobID":null}'::jsonb, 'quote-10', timestamptz '2025-06-01 00:00:10+00', true),
      (501, 'job_details', '300', '{"ID":300,"ConvertedFrom":null}'::jsonb, 'job-300', timestamptz '2025-06-01 00:01:00+00', true),
      (502, 'job_details', '400', '{"ID":400,"ConvertedFrom":null}'::jsonb, 'job-400', timestamptz '2025-06-01 00:01:01+00', true),
      (503, 'job_details', '500', '{"ID":500,"ConvertedFrom":null}'::jsonb, 'job-500', timestamptz '2025-06-01 00:01:02+00', true),
      (504, 'job_details', '600', '{"ID":600,"ConvertedFrom":{"Type":"Quote","ID":6}}'::jsonb, 'job-600', timestamptz '2025-06-01 00:01:03+00', true);

    insert into metrics.quote_snapshots (
      quote_id, date_approved, total_value, linked_job_id, won, won_value, win_loss_reason
    )
    select quote_id, date_approved, total, linked_job_id, null, null, 'seed'
      from metrics.metrics_quotes where quote_id < 10;
    insert into metrics.quote_snapshots (
      quote_id, date_approved, total_value, linked_job_id, won, won_value, win_loss_reason
    ) values (10, date '2025-06-10', 1000, null, false, 0, 'no_acceptance_evidence');

    insert into metrics.quote_classification_overrides (quote_id, outcome, active, created_at)
    values
      (7, 'excluded', true, timestamptz '2025-06-07 00:00:00+00'),
      (8, 'won', true, timestamptz '2025-06-08 00:00:00+00')
  `);
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

async function persistedState(db: PGlite) {
  const result = await db.query<{
    quote_id: number;
    outcome: string;
    outcome_reason: string;
    won_reason: string;
    canonical_linked_job_id: number | null;
    snapshot_linked_job_id: number | null;
    won: boolean | null;
    won_value: string | null;
    win_loss_reason: string | null;
  }>(`
    select q.quote_id::integer, q.outcome, q.outcome_reason, q.won_reason,
           q.linked_job_id::integer canonical_linked_job_id,
           s.linked_job_id::integer snapshot_linked_job_id,
           s.won, s.won_value::text, s.win_loss_reason
      from metrics.metrics_quotes q
      left join metrics.quote_snapshots s using (quote_id)
     order by q.quote_id
  `);
  return result.rows;
}

async function writeCounts(db: PGlite) {
  const result = await db.query<{ audits: number; rollups: number }>(`
    select (select count(*)::integer from metrics.audit_events) audits,
           (select count(*)::integer from metrics.rollup_rebuild_queue) rollups
  `);
  return result.rows[0];
}

async function quoteOutcomeAndLinks(db: PGlite, quoteId: number) {
  const result = await db.query<{
    outcome: string;
    canonical_linked_job_id: number | null;
    snapshot_linked_job_id: number | null;
  }>(`
    select q.outcome,
           q.linked_job_id::integer canonical_linked_job_id,
           s.linked_job_id::integer snapshot_linked_job_id
      from metrics.metrics_quotes q
      join metrics.quote_snapshots s using (quote_id)
     where q.quote_id = $1
  `, [quoteId]);
  return result.rows[0];
}

async function derivedMatchLinks(db: PGlite) {
  const result = await db.query<{
    quote_id: number;
    canonical_linked_job_id: number | null;
    snapshot_linked_job_id: number | null;
  }>(`
    select q.quote_id::integer,
           q.linked_job_id::integer canonical_linked_job_id,
           s.linked_job_id::integer snapshot_linked_job_id
      from metrics.metrics_quotes q
      join metrics.quote_snapshots s using (quote_id)
     where q.quote_id in (4, 6)
     order by q.quote_id
  `);
  return result.rows;
}

async function jobInverseState(db: PGlite, jobId: number) {
  const result = await db.query<{
    converted_from_type: string;
    converted_from_id: number | null;
    job_source_type: string;
    job_source_id: number | null;
    snapshot_source_quote_id: number | null;
  }>(`
    select job.converted_from_type, job.converted_from_id::integer,
           job.job_source_type, job.job_source_id::integer,
           snapshot.source_quote_id::integer as snapshot_source_quote_id
      from metrics.metrics_jobs job
      join metrics.job_snapshots snapshot using (job_id)
     where job.job_id = $1
  `, [jobId]);
  return result.rows[0];
}

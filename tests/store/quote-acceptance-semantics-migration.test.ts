import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);
const migrationName = "035_remove_job_no_quote_acceptance.sql";

test("migration 035 repairs raw-authoritative relationships and historical classifications twice-safely", async () => {
  const db = await databaseBeforeMigration035();
  try {
    await db.exec(`
      insert into metrics.metrics_jobs (
        job_id, job_no, converted_from_type, converted_from_id, job_source_type, job_source_id
      ) values
        (5001, 'SAME-JOB-NO', 'Quote', 101, 'Quote', 101),
        (5002, 'DIRECT', null, null, 'Direct service', null),
        (5003, 'INVERSE', null, null, 'Direct service', null),
        (5004, 'EXCLUDED', null, null, 'Direct service', null);

      insert into metrics.job_snapshots (job_id, job_no, source_quote_id)
      values
        (5001, 'SAME-JOB-NO', 101),
        (5002, 'DIRECT', null),
        (5003, 'INVERSE', null),
        (5004, 'EXCLUDED', null);

      insert into metrics.metrics_quotes (
        quote_id, date_issued, date_approved, status_name, total, linked_job_id, job_no,
        outcome, outcome_reason, won_reason
      ) values
        (101, date '2025-04-15', date '2025-06-01', 'Pending', 101, 5001, 'SAME-JOB-NO',
         'won', 'converted_job', 'converted_job'),
        (102, date '2025-06-01', date '2025-06-02', 'Pending', 102, null, null,
         'lost', 'no_acceptance_evidence', 'no_acceptance_evidence'),
        (103, date '2025-06-01', date '2025-06-03', 'Pending', 103, null, null,
         'lost', 'no_acceptance_evidence', 'no_acceptance_evidence'),
        (104, date '2025-06-01', date '2025-06-04', 'Quote Accepted Online', 104, 5004, null,
         'won', 'accepted_online_and_converted', 'accepted_online_and_converted'),
        (105, date '2025-06-01', date '2025-06-05', 'Pending', 105, 5001, 'SAME-JOB-NO',
         'won', 'converted_job', 'converted_job'),
        (106, date '2025-06-01', date '2025-06-06', 'Pending', 106, 5001, 'SAME-JOB-NO',
         'won', 'converted_job', 'converted_job');

      insert into metrics.quote_snapshots (
        quote_id, date_issued, date_approved, total_value, linked_job_id,
        won, won_value, win_loss_reason
      )
      select quote_id, date_issued, date_approved, total, linked_job_id,
             outcome = 'won', case when outcome = 'won' then total else 0 end, outcome_reason
        from metrics.metrics_quotes
       where quote_id between 101 and 106;

      update metrics.quote_snapshots
         set date_issued = date '2025-03-15', date_approved = date '2025-05-15'
       where quote_id = 101;

      insert into metrics.raw_simpro_snapshots (
        id, entity_type, entity_id, source_path, source_hash, extracted_at,
        payload, complete_traversal
      ) values
        (1001, 'quotes', '101', '/quotes/101', 'quote-101-old',
         timestamptz '2025-07-01 00:00:00+00', '{"ID":101,"LinkedJobID":5001}', true),
        (1002, 'quote_details', '101', '/quotes/101', 'quote-101-latest',
         timestamptz '2025-07-02 00:00:00+00', '{"ID":101,"LinkedJobID":null}', true),
        (1003, 'quotes', '102', '/quotes/102', 'quote-102-old',
         timestamptz '2025-07-01 00:00:00+00', '{"ID":102,"LinkedJobID":null}', true),
        (1004, 'quote_details', '102', '/quotes/102', 'quote-102-latest',
         timestamptz '2025-07-02 00:00:00+00', '{"ID":102,"LinkedJobID":5002}', true),
        (1005, 'quote_details', '103', '/quotes/103', 'quote-103',
         timestamptz '2025-07-02 00:00:00+00', '{"ID":103,"LinkedJobID":null}', true),
        (1006, 'quote_details', '104', '/quotes/104', 'quote-104',
         timestamptz '2025-07-02 00:00:00+00', '{"ID":104,"LinkedJobID":5004}', true),
        (1007, 'quote_details', '105', '/quotes/105', 'quote-105',
         timestamptz '2025-07-02 00:00:00+00', '{"ID":105,"LinkedJobID":null}', true),
        (1008, 'quote_details', '106', '/quotes/106', 'quote-106',
         timestamptz '2025-07-02 00:00:00+00', '{"ID":106,"LinkedJobID":null}', true),
        (2001, 'job_details', '5001', '/jobs/5001', 'job-5001',
         timestamptz '2025-07-03 00:00:00+00', '{"ID":5001,"ConvertedFrom":null}', true),
        (2002, 'job_details', '5002', '/jobs/5002', 'job-5002',
         timestamptz '2025-07-03 00:00:00+00', '{"ID":5002,"ConvertedFrom":null}', true),
        (2003, 'job_details', '5003', '/jobs/5003', 'job-5003',
         timestamptz '2025-07-03 00:00:00+00',
         '{"ID":5003,"ConvertedFrom":{"Type":"Quote","ID":103}}', true),
        (2004, 'job_details', '5004', '/jobs/5004', 'job-5004',
         timestamptz '2025-07-03 00:00:00+00', '{"ID":5004,"ConvertedFrom":null}', true);

      insert into metrics.quote_classification_overrides (
        quote_id, category, action, outcome, previous_outcome, reason,
        actor_email, revision, idempotency_key, active
      ) values (
        104, 'Unclassified', 'exclude', 'excluded', 'won',
        'Active exclusion must win over every source path.',
        'owner@example.test', 1, 'attack-active-exclusion-104', true
      );

      insert into metrics.reviewed_quote_exclusion_seeds (
        quote_id, reason, actor_email, reviewed_on, evidence_sha256,
        idempotency_key, provenance
      ) values (
        105, 'Reviewed attack fixture exclusion.', 'owner@example.test', date '2026-07-13',
        repeat('a', 64), 'attack-reviewed-seed-105',
        jsonb_build_object('source', 'quote-acceptance-semantics-test')
      );
    `);

    const migrationSql = await readMigration035();
    assert.doesNotMatch(migrationSql, /\b(?:q|j|job)\.job_no\b/i);
    assert.match(migrationSql, /raw\.complete_traversal = true/);
    assert.match(migrationSql, /order by raw\.extracted_at desc, raw\.id desc/);
    await applyMigration(db, migrationSql);

    assert.deepEqual(await classificationRows(db), [
      {
        quote_id: 101,
        linked_job_id: null,
        snapshot_linked_job_id: null,
        outcome: "lost",
        outcome_reason: "no_acceptance_evidence",
        won: false,
      },
      {
        quote_id: 102,
        linked_job_id: 5002,
        snapshot_linked_job_id: 5002,
        outcome: "won",
        outcome_reason: "converted_job",
        won: true,
      },
      {
        quote_id: 103,
        linked_job_id: null,
        snapshot_linked_job_id: null,
        outcome: "won",
        outcome_reason: "converted_job",
        won: true,
      },
      {
        quote_id: 104,
        linked_job_id: 5004,
        snapshot_linked_job_id: 5004,
        outcome: "excluded",
        outcome_reason: "manual_excluded",
        won: false,
      },
      {
        quote_id: 105,
        linked_job_id: null,
        snapshot_linked_job_id: null,
        outcome: "lost",
        outcome_reason: "no_acceptance_evidence",
        won: false,
      },
      {
        quote_id: 106,
        linked_job_id: null,
        snapshot_linked_job_id: null,
        outcome: "lost",
        outcome_reason: "no_acceptance_evidence",
        won: false,
      },
    ]);

    const repairs = await repairAudits(db);
    assert.equal(repairs.length, 6);
    const cleared = repairs.find((row) => row.entity_id === "101");
    assert.equal(cleared?.before_value.canonical_linked_job_id, 5001);
    assert.equal(cleared?.before_value.snapshot_linked_job_id, 5001);
    assert.equal(cleared?.after_value.canonical_linked_job_id, null);
    assert.equal(cleared?.after_value.snapshot_linked_job_id, null);
    assert.equal(cleared?.after_value.outcome, "lost");
    const clearedInverse = await db.query<{
      converted_from_type: string;
      converted_from_id: number | null;
      source_quote_id: number | null;
    }>(`
      select job.converted_from_type, job.converted_from_id::integer,
             snapshot.source_quote_id::integer
        from metrics.metrics_jobs job
        join metrics.job_snapshots snapshot using (job_id)
       where job.job_id = 5001
    `);
    assert.deepEqual(clearedInverse.rows[0], {
      converted_from_type: "Direct service",
      converted_from_id: null,
      source_quote_id: null,
    });

    const restored = repairs.find((row) => row.entity_id === "102");
    assert.equal(restored?.before_value.canonical_linked_job_id, null);
    assert.equal(restored?.after_value.canonical_linked_job_id, 5002);
    assert.equal(restored?.after_value.direct_conversion_job_id, 5002);
    assert.equal(restored?.after_value.outcome, "won");

    const inverse = repairs.find((row) => row.entity_id === "103");
    assert.equal(inverse?.after_value.inverse_conversion_job_id, 5003);
    assert.equal(inverse?.after_value.inverse_source_snapshot_id, 2003);
    assert.equal(inverse?.after_value.outcome, "won");

    const cleared106 = repairs.find((row) => row.entity_id === "106");
    assert.equal(cleared106?.after_value.direct_provenance_state, "present_without_direct_link");
    assert.equal(cleared106?.after_value.canonical_linked_job_id, null);
    assert.equal(cleared106?.after_value.outcome, "lost");

    const inverseParity = await db.query<{
      converted_from_type: string;
      converted_from_id: number;
      source_quote_id: number;
    }>(`
      select job.converted_from_type, job.converted_from_id::integer,
             snapshot.source_quote_id::integer
        from metrics.metrics_jobs job
        join metrics.job_snapshots snapshot using (job_id)
       where job.job_id = 5003
    `);
    assert.deepEqual(inverseParity.rows[0], {
      converted_from_type: "Quote",
      converted_from_id: 103,
      source_quote_id: 103,
    });

    const affected101 = await db.query<{ period_start: string }>(`
      select period_start::text
        from metrics.rollup_rebuild_queue
       where reason = 'quote_acceptance_semantics_repair'
         and idempotency_key like 'migration-035:quote:101:%'
       order by period_start
    `);
    assert.deepEqual(affected101.rows.map((row) => row.period_start), [
      "2025-03-01",
      "2025-04-01",
      "2025-05-01",
      "2025-06-01",
    ]);

    const applied = await db.query<{ applied_count: number }>(
      "select applied_count from metrics.apply_reviewed_quote_exclusion_seeds(array[105]::bigint[])",
    );
    assert.equal(applied.rows[0]?.applied_count, 1);
    const seeded = await db.query<{ previous_outcome: string; outcome: string }>(`
      select previous_outcome, outcome
        from metrics.quote_classification_overrides
       where idempotency_key = 'attack-reviewed-seed-105'
    `);
    assert.deepEqual(seeded.rows[0], { previous_outcome: "lost", outcome: "excluded" });

    const beforeRerun = {
      writes: await migrationWriteCounts(db),
      state: await persistedState(db),
    };
    await applyMigration(db, migrationSql);
    assert.deepEqual(await migrationWriteCounts(db), beforeRerun.writes);
    assert.deepEqual(await persistedState(db), beforeRerun.state);
  } finally {
    await db.close();
  }
});

for (const attack of [
  {
    name: "conflicting direct-link aliases",
    payload: { ID: 201, LinkedJobID: 7001, linkedJobId: 7002 },
    error: /direct-link scalar fields conflict/i,
  },
  {
    name: "malformed direct-link provenance",
    payload: { ID: 201, LinkedJobID: { ID: 7001 } },
    error: /not a numeric or string scalar ID/i,
  },
]) {
  test(`migration 035 fails closed atomically on ${attack.name}`, async () => {
    const db = await databaseBeforeMigration035();
    try {
      await db.exec(`
         insert into metrics.metrics_jobs (job_id, job_no) values (7001, 'ONE'), (7002, 'TWO');
         insert into metrics.metrics_quotes (
           quote_id, date_issued, date_approved, status_name, total, linked_job_id,
           outcome, outcome_reason, won_reason
         ) values (201, date '2025-06-01', date '2025-06-02', 'Pending', 201, null,
                   'lost', 'no_acceptance_evidence', 'no_acceptance_evidence');
         insert into metrics.quote_snapshots (
           quote_id, date_issued, date_approved, total_value, linked_job_id,
           won, won_value, win_loss_reason
         ) values (201, date '2025-06-01', date '2025-06-02', 201, null,
                   false, 0, 'no_acceptance_evidence');
      `);
      await db.query(
        `insert into metrics.raw_simpro_snapshots (
           entity_type, entity_id, source_path, source_hash, extracted_at, payload, complete_traversal
         ) values ('quote_details', '201', '/quotes/201', 'quote-201-attack',
                   timestamptz '2025-07-02 00:00:00+00', $1::jsonb, true)`,
        [JSON.stringify(attack.payload)],
      );
      const before = await persistedState(db);

      await assert.rejects(applyMigration(db, await readMigration035()), attack.error);

      assert.deepEqual(await persistedState(db), before);
      assert.deepEqual(await migrationWriteCounts(db), { audits: 0, rollups: 0 });
      const helper = await db.query<{ helper: string | null }>(
        "select to_regprocedure('metrics.authoritative_quote_linked_job_id(jsonb)')::text as helper",
      );
      assert.equal(helper.rows[0]?.helper, null);
    } finally {
      await db.close();
    }
  });
}

test("migration 035 fails closed atomically on conflicting inverse aliases", async () => {
  const db = await databaseBeforeMigration035();
  try {
    await db.exec(`
      insert into metrics.metrics_quotes (
        quote_id, date_issued, date_approved, status_name, total,
        outcome, outcome_reason, won_reason
      ) values (301, date '2025-06-01', date '2025-06-02', 'Pending', 301,
                'lost', 'no_acceptance_evidence', 'no_acceptance_evidence');
      insert into metrics.quote_snapshots (
        quote_id, date_issued, date_approved, total_value, won, won_value, win_loss_reason
      ) values (301, date '2025-06-01', date '2025-06-02', 301,
                false, 0, 'no_acceptance_evidence');
      insert into metrics.metrics_jobs (
        job_id, job_no, converted_from_type, converted_from_id,
        job_source_type, job_source_id
      ) values (8001, 'J-8001', 'Direct service', null, 'Direct service', null);
      insert into metrics.job_snapshots (job_id, job_no, source_quote_id)
      values (8001, 'J-8001', null);
      insert into metrics.raw_simpro_snapshots (
        entity_type, entity_id, source_path, source_hash, extracted_at,
        payload, complete_traversal
      ) values
        ('quote_details', '301', '/quotes/301', 'quote-301', timestamptz '2025-07-01',
         '{"ID":301,"LinkedJobID":null}', true),
        ('job_details', '8001', '/jobs/8001', 'job-8001-conflict', timestamptz '2025-07-01',
         '{"ID":8001,"ConvertedFrom":{"Type":"Quote","ID":301},"convertedFrom":{"Type":"Quote","ID":302}}', true)
    `);
    const before = await db.query(`
      select quote.outcome, quote.linked_job_id::text,
             job.converted_from_type, job.converted_from_id::text,
             snapshot.source_quote_id::text
        from metrics.metrics_quotes quote
        cross join metrics.metrics_jobs job
        join metrics.job_snapshots snapshot using (job_id)
       where quote.quote_id = 301 and job.job_id = 8001
    `);

    await assert.rejects(
      applyMigration(db, await readMigration035()),
      /ConvertedFrom ID aliases conflict/,
    );
    const after = await db.query(`
      select quote.outcome, quote.linked_job_id::text,
             job.converted_from_type, job.converted_from_id::text,
             snapshot.source_quote_id::text
        from metrics.metrics_quotes quote
        cross join metrics.metrics_jobs job
        join metrics.job_snapshots snapshot using (job_id)
       where quote.quote_id = 301 and job.job_id = 8001
    `);
    assert.deepEqual(after.rows, before.rows);
    assert.deepEqual(await migrationWriteCounts(db), { audits: 0, rollups: 0 });
  } finally {
    await db.close();
  }
});

async function databaseBeforeMigration035() {
  const db = new PGlite();
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files.filter((name) => name < migrationName)) {
    await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
  }
  return db;
}

async function readMigration035() {
  return readFile(new URL(migrationName, migrationDirectory), "utf8");
}

async function applyMigration(db: PGlite, sql: string) {
  await db.exec("begin");
  try {
    await db.exec(sql);
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

async function classificationRows(db: PGlite) {
  const result = await db.query<{
    quote_id: number;
    linked_job_id: number | null;
    snapshot_linked_job_id: number | null;
    outcome: string;
    outcome_reason: string;
    won: boolean;
  }>(`
    select q.quote_id::integer, q.linked_job_id::integer,
           snapshot.linked_job_id::integer as snapshot_linked_job_id,
           q.outcome, q.outcome_reason, snapshot.won
      from metrics.metrics_quotes q
      join metrics.quote_snapshots snapshot using (quote_id)
     where q.quote_id between 101 and 106
     order by q.quote_id
  `);
  return result.rows;
}

async function repairAudits(db: PGlite) {
  const result = await db.query<{
    entity_id: string;
    before_value: Record<string, unknown>;
    after_value: Record<string, unknown>;
  }>(`
    select entity_id, before_value, after_value
      from metrics.audit_events
     where action = 'quote_acceptance_semantics_repaired'
     order by entity_id
  `);
  return result.rows;
}

async function persistedState(db: PGlite) {
  const result = await db.query(`
    select q.quote_id::integer, q.linked_job_id::integer, q.outcome, q.outcome_reason,
           q.won_reason, q.updated_from_source_at::text,
           snapshot.linked_job_id::integer as snapshot_linked_job_id,
           snapshot.won, snapshot.won_value::text, snapshot.win_loss_reason,
           snapshot.updated_at::text
      from metrics.metrics_quotes q
      join metrics.quote_snapshots snapshot using (quote_id)
     where q.quote_id between 101 and 201
     order by q.quote_id
  `);
  return result.rows;
}

async function migrationWriteCounts(db: PGlite) {
  const result = await db.query<{ audits: number; rollups: number }>(`
    select
      (select count(*)::integer from metrics.audit_events
        where action in ('quote_acceptance_semantics_repaired', 'quote_acceptance_semantics_locked')) as audits,
      (select count(*)::integer from metrics.rollup_rebuild_queue
        where reason = 'quote_acceptance_semantics_repair') as rollups
  `);
  return result.rows[0] ?? { audits: 0, rollups: 0 };
}

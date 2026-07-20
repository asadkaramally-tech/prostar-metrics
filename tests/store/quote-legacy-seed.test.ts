import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);
const wonIds = [
  116, 298, 459, 481, 519, 532, 534, 555, 564, 595, 652, 675, 732, 780, 787, 891,
  936, 1029, 1045, 1136, 1209, 1217, 1271, 1287, 1305, 1506, 1521, 1643, 1748, 1771, 1882,
];
const lostIds = [602, 796, 797];
const excludedIds = [470, 757, 762, 768, 1867];

test("reviewed quote history converges through 035 with complete raw no-link provenance", async () => {
  const db = new PGlite();
  try {
    const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const migrations = await Promise.all(
      files.map(async (name) => ({ name, sql: await readFile(new URL(name, migrationDirectory), "utf8") })),
    );
    const seedIndex = migrations.findIndex((migration) => migration.name === "017_seed_reviewed_quote_decisions.sql");
    assert.notEqual(seedIndex, -1);
    for (const migration of migrations.slice(0, seedIndex)) await db.exec(migration.sql);
    const ids = [...wonIds, ...lostIds, ...excludedIds];
    await db.query(`
      insert into metrics.metrics_quotes (quote_id, date_approved, stage, customer_stage, total)
      select quote_id, '2025-06-15'::date, 'Complete', 'Pending', 100
        from unnest($1::bigint[]) quote_id
    `, [ids]);
    await db.query(`
      insert into metrics.raw_simpro_snapshots (
        entity_type, entity_id, source_path, payload, source_hash,
        extracted_at, complete_traversal
      )
      select 'quote_details', quote_id::text, '/quotes/' || quote_id,
             jsonb_build_object('ID', quote_id, 'LinkedJobID', null),
             'legacy-authoritative-quote-' || quote_id,
             timestamptz '2026-03-07 00:00:00+00', true
        from unnest($1::bigint[]) quote_id
    `, [ids]);

    const seed = migrations[seedIndex]!;
    await db.exec(seed.sql);
    await db.exec(seed.sql);
    for (const migration of migrations.slice(seedIndex + 1)) await db.exec(migration.sql);
    const cleanup = migrations.find((migration) => migration.name === "033_quote_reinstatement_scope_cleanup.sql");
    assert.ok(cleanup);
    await db.exec(cleanup.sql);
    const registry = migrations.find((migration) => migration.name === "034_reviewed_quote_exclusion_registry.sql");
    assert.ok(registry);
    await db.exec(registry.sql);

    const counts = await db.query<{ outcome: string; count: number }>(`
      select outcome, count(*)::int
        from metrics.metrics_quotes
       where quote_id = any($1::bigint[])
       group by outcome
       order by outcome
    `, [ids]);
    assert.deepEqual(counts.rows, [
      { outcome: "excluded", count: excludedIds.length },
      { outcome: "lost", count: wonIds.length + lostIds.length },
    ]);

    const evidence = await db.query<{
      overrides: number;
      active: number;
      legacy_inactive: number;
      won_history: number;
      lost_history: number;
      exclusion_history: number;
      audits: number;
      cleanup_audits: number;
      rollups: number;
      hashes: number;
      registry_rows: number;
      registry_enabled: number;
    }>(`
      select
        (select count(*)::int from metrics.quote_classification_overrides
          where idempotency_key like 'legacy-quote-review-2026-03-06:%') as overrides,
        (select count(*)::int from metrics.quote_classification_overrides
          where idempotency_key like 'legacy-quote-review-2026-03-06:%' and active) as active,
        (select count(*)::int from metrics.quote_classification_overrides
          where idempotency_key like 'legacy-quote-review-2026-03-06:%'
            and outcome in ('won', 'lost') and not active) as legacy_inactive,
        (select count(*)::int from metrics.quote_classification_overrides
          where idempotency_key like 'legacy-quote-review-2026-03-06:%' and outcome = 'won') as won_history,
        (select count(*)::int from metrics.quote_classification_overrides
          where idempotency_key like 'legacy-quote-review-2026-03-06:%' and outcome = 'lost') as lost_history,
        (select count(*)::int from metrics.quote_classification_overrides
          where idempotency_key like 'legacy-quote-review-2026-03-06:%' and outcome = 'excluded') as exclusion_history,
        (select count(*)::int from metrics.audit_events where action = 'quote_review_seeded') as audits,
        (select count(*)::int from metrics.audit_events where action = 'quote_override_deactivated') as cleanup_audits,
        (select count(*)::int from metrics.rollup_rebuild_queue
          where reason = 'reviewed_quote_decision_seed') as rollups,
        (select count(*)::int from metrics.audit_events
          where after_value ->> 'evidence_sha256' =
            '151ed4a3c6b186f6aaa6a26e4219b23163d8d0a91b5f40b22386c17f0585fa06') as hashes,
        (select count(*)::int from metrics.reviewed_quote_exclusion_seeds) as registry_rows,
        (select count(*)::int from metrics.reviewed_quote_exclusion_seeds where enabled) as registry_enabled
    `);
    assert.deepEqual(evidence.rows[0], {
      overrides: ids.length,
      active: excludedIds.length,
      legacy_inactive: wonIds.length + lostIds.length,
      won_history: wonIds.length,
      lost_history: lostIds.length,
      exclusion_history: excludedIds.length,
      audits: ids.length,
      cleanup_audits: wonIds.length + lostIds.length,
      rollups: ids.length,
      hashes: ids.length,
      registry_rows: excludedIds.length,
      registry_enabled: excludedIds.length,
    });

    await assert.rejects(
      db.query(`
        insert into metrics.quote_classification_overrides (
          quote_id, category, outcome, previous_outcome, reason, actor_email,
          revision, idempotency_key, active
        ) values (9999, 'Unclassified', 'won', 'lost', 'invalid active legacy outcome',
                  'test@example.com', 1, 'invalid-active-won', true)
      `),
      /quote_override_active_exclusion_check/,
    );
  } finally {
    await db.close();
  }
});

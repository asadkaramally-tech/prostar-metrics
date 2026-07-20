import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  claimCommissionInitializationRebuild,
  checkCommissionInitializationPrerequisites,
  commissionInitializationRepairConfirmationToken,
  getCommissionInitializationQueueStatus,
  repairFailedCommissionInitializationRebuild,
} from "@/lib/store/commission-initialization-queue";
import {
  COMMISSION_INITIALIZATION_VERSION,
  LOCKED_COMMISSION_CONFIG,
  LOCKED_COMMISSION_CONFIG_HASH,
  LOCKED_COMMISSION_POLICY_EVIDENCE,
  commissionInitializationConfirmationToken,
  currentPacificMonth,
  initializeHistoricalCommissionPeriods,
  normalizeCommissionInitializationActor,
  resolveCommissionInitializationMonth,
} from "@/lib/store/commission-period-initialization";
import { commissionHashJson, commissionStableJson } from "@/lib/store/commission-integrity";
import type { PostgresQuery } from "@/lib/store/postgres";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);
const throughMonth = "2026-07";
const confirmation = "INITIALIZE-COMMISSION-PERIODS-2023-01-THROUGH-2026-07";

test("Pacific month, actor, range, and confirmation gates fail closed", async () => {
  assert.equal(currentPacificMonth(new Date("2026-07-01T06:59:59.000Z")), "2026-06");
  assert.equal(currentPacificMonth(new Date("2026-07-01T07:00:00.000Z")), "2026-07");
  assert.equal(resolveCommissionInitializationMonth("current", new Date("2026-07-13T12:00:00.000Z")), "2026-07");
  assert.equal(normalizeCommissionInitializationActor(" ASAD@PROSTARMECHANICAL.COM "), "asad@prostarmechanical.com");
  assert.equal(commissionInitializationConfirmationToken(throughMonth), confirmation);
  assert.throws(() => normalizeCommissionInitializationActor("outsider@prostarmechanical.com"), /Asad.*Laila/i);
  assert.throws(() => resolveCommissionInitializationMonth("2022-12", new Date("2026-07-13T12:00:00.000Z")), /2023-01/);
  assert.throws(() => resolveCommissionInitializationMonth("2026-08", new Date("2026-07-13T12:00:00.000Z")), /current Pacific month/);

  let transactions = 0;
  const transaction = async <T>(callback: (query: PostgresQuery) => Promise<T>) => {
    void callback;
    transactions += 1;
    throw new Error("transaction should not open");
  };
  await assert.rejects(initializeHistoricalCommissionPeriods({
    throughMonth, actorEmail: "asad@prostarmechanical.com", execute: true, confirmation: "wrong",
  }, transaction), new RegExp(confirmation));
  assert.equal(transactions, 0);
});

test("dry-run and execute initialize 43 exact periods atomically and remain idempotent", async () => {
  const fixture = await migratedDatabase();
  try {
    await seedAcceptedPrerequisites(fixture.db, throughMonth);
    const periodId = await insertPeriod(fixture.db, { month: "2023-01" });
    await insertAuditedOverride(fixture.db, {
      periodId, employeeId: "17", field: "notes", value: "preserve this override",
      valueType: "string", poolTreatment: "neutral", actor: "asad@prostarmechanical.com",
    });

    const dryRun = await initializeHistoricalCommissionPeriods({
      throughMonth, actorEmail: "asad@prostarmechanical.com",
    }, fixture.transaction);
    assert.equal(dryRun.mode, "dry-run");
    assert.equal(dryRun.monthCount, 43);
    assert.equal(dryRun.summary.periodsToCreate, 42);
    assert.equal(dryRun.summary.configsToEvidence, 43);
    assert.equal(dryRun.summary.evidenceAuditsToWrite, 43);
    assert.equal(dryRun.summary.rebuildsToQueue, 43);
    assert.equal(dryRun.summary.overridesPreserved, 1);
    assert.equal(dryRun.summary.writesApplied, 0);
    assert.equal(dryRun.periods[0].effectiveOverrides, 1);
    assert.match(dryRun.periods[0].overrideHash, /^[0-9a-f]{64}$/);
    assert.equal((await fixture.db.query("select 1 from metrics.commission_period_configs")).rows.length, 0);

    const executed = await initializeHistoricalCommissionPeriods({
      throughMonth,
      actorEmail: "ASAD@PROSTARMECHANICAL.COM",
      execute: true,
      confirmation,
    }, fixture.transaction);
    assert.equal(executed.mode, "execute");
    assert.equal(executed.summary.writesApplied, 214);

    const inventory = await fixture.db.query<{
      periods: number; configs: number; queues: number; audits: number; overrides: number;
      min_period: string; max_period: string; max_period_end: string;
    }>(`
      select (select count(*)::int from metrics.commission_periods) as periods,
             (select count(*)::int from metrics.commission_period_configs where active) as configs,
             (select count(*)::int from metrics.rollup_rebuild_queue where metric_family = 'commissions') as queues,
             (select count(*)::int from metrics.audit_events where action = 'commission_period_historical_initialization_evidenced') as audits,
             (select count(*)::int from metrics.commission_overrides) as overrides,
             (select min(period_start)::text from metrics.commission_periods) as min_period,
             (select max(period_start)::text from metrics.commission_periods) as max_period,
             (select max(period_end)::text from metrics.commission_periods) as max_period_end
    `);
    assert.deepEqual(inventory.rows[0], {
      periods: 43, configs: 43, queues: 43, audits: 43, overrides: 1,
      min_period: "2023-01-01", max_period: "2026-07-01", max_period_end: "2026-07-31",
    });
    const configState = await fixture.db.query<{ hashes: number; efficiency_enabled: boolean }>(`
      select count(distinct c.config_hash)::int as hashes, bool_or(c.efficiency_enabled) as efficiency_enabled
        from metrics.commission_periods p
        join metrics.commission_period_configs c on c.period_id = p.id and c.active
       where p.period_start between date '2023-01-01' and date '2026-07-01'
    `);
    assert.deepEqual(configState.rows[0], { hashes: 1, efficiency_enabled: false });
    const evidence = await fixture.db.query<{ version: string; source_hash: string; plan_hash: string; queue_key: string }>(`
      select a.after_value ->> 'initializationVersion' as version,
             a.after_value #>> '{evidence,priorDashboard,sha256}' as source_hash,
             a.after_value #>> '{evidence,lockedPlan,sha256}' as plan_hash,
             a.after_value #>> '{rebuildQueue,idempotencyKey}' as queue_key
        from metrics.audit_events a
        join metrics.commission_periods p on p.id::text = a.entity_id
       where p.period_start = date '2023-01-01'
         and a.action = 'commission_period_historical_initialization_evidenced'
    `);
    assert.deepEqual(evidence.rows, [{
      version: COMMISSION_INITIALIZATION_VERSION,
      source_hash: "037b1f6e0e5b7a4156a8eee8180307e92dfc3f0f17b8f19b5ea7011f2852538b",
      plan_hash: "7392ad68fb810b840175604291a9b43cb57a3a4dce23de546f3e1c057abca3e5",
      queue_key: "commissions:month:2023-01-01:commission-period-initialization-v2",
    }]);
    const canonical = await fixture.db.query<{ audits: number; queues: number }>(`
      select
        (select count(*)::int from metrics.commission_initialization_v2_audit_records) as audits,
        (select count(*)::int from metrics.commission_initialization_v2_queue_records) as queues
    `);
    assert.deepEqual(canonical.rows[0], { audits: 43, queues: 43 });

    const repeated = await initializeHistoricalCommissionPeriods({
      throughMonth, actorEmail: "asad@prostarmechanical.com", execute: true, confirmation,
    }, fixture.transaction);
    assert.equal(repeated.summary.periodsToCreate, 0);
    assert.equal(repeated.summary.configsToEvidence, 0);
    assert.equal(repeated.summary.evidenceAuditsToWrite, 0);
    assert.equal(repeated.summary.rebuildsToQueue, 0);
    assert.equal(repeated.summary.rebuildsAlreadyQueued, 43);
    assert.equal(repeated.summary.writesApplied, 0);
  } finally {
    await fixture.db.close();
  }
});

test("config, roster, migration, and protected-period conflicts roll back the complete range", async (t) => {
  await t.test("missing migration 009 roster audit", async () => {
    const fixture = await migratedDatabase();
    try {
      await fixture.db.exec(`delete from metrics.audit_events where action = 'commission_roster_seeded' and entity_id = (
        select id::text from metrics.commission_roster where employee_id = 17
      )`);
      await assertNoInitializationWrites(fixture, /roster row.*conflicts/i);
    } finally { await fixture.db.close(); }
  });

  await t.test("missing or changed parent migration hash", async () => {
    const fixture = await migratedDatabase();
    try {
      await fixture.db.exec("update metrics.schema_migrations set sha256 = repeat('0', 64) where filename = '009_commission_roster_seed.sql'");
      await assertNoInitializationWrites(fixture, /009_commission_roster_seed.*hash conflicts/i);
      await fixture.db.exec("delete from metrics.schema_migrations where filename = '025_upgrade_verified_commission_tier_config.sql'");
      await assert.rejects(runInitialization(fixture, "2023-01"), /required applied migration 025.*missing/i);
    } finally { await fixture.db.close(); }
  });

  await t.test("exported or locked period with missing config is never mutated", async () => {
    const fixture = await migratedDatabase();
    try {
      await insertPeriod(fixture.db, { month: "2023-01", status: "exported" });
      await assert.rejects(runInitialization(fixture, "2023-02"), /exported period lacks active locked config evidence/i);
      const state = await fixture.db.query<{ periods: number; configs: number; queues: number; audits: number }>(`
        select (select count(*)::int from metrics.commission_periods) periods,
               (select count(*)::int from metrics.commission_period_configs) configs,
               (select count(*)::int from metrics.rollup_rebuild_queue) queues,
               (select count(*)::int from metrics.audit_events where action = 'commission_period_historical_initialization_evidenced') audits
      `);
      assert.deepEqual(state.rows[0], { periods: 1, configs: 0, queues: 0, audits: 0 });
    } finally { await fixture.db.close(); }
  });

  await t.test("locked period with inconsistent active config is never repaired in place", async () => {
    const fixture = await migratedDatabase();
    const deviating = { ...LOCKED_COMMISSION_CONFIG, poolPercent: 0.55 };
    try {
      const periodId = await insertPeriod(fixture.db, { month: "2023-01", status: "locked" });
      await insertConfig(fixture.db, periodId, deviating, {
        actor: "asad@prostarmechanical.com", poolPercent: 0.55,
      });
      await assert.rejects(runInitialization(fixture, "2023-01"), /not the locked migration-025 formula|not the exact migration-019/i);
      assert.equal((await fixture.db.query("select 1 from metrics.rollup_rebuild_queue")).rows.length, 0);
      assert.equal((await fixture.db.query("select 1 from metrics.audit_events where action = 'commission_period_historical_initialization_evidenced'")).rows.length, 0);
    } finally { await fixture.db.close(); }
  });

  await t.test("owner email does not approve pool or efficiency deviation", async () => {
    const fixture = await migratedDatabase();
    const deviating = { ...LOCKED_COMMISSION_CONFIG, poolPercent: 0.55, efficiencyEnabled: true };
    try {
      const periodId = await insertPeriod(fixture.db, { month: "2023-01", config: deviating, configRevision: 3 });
      await insertConfig(fixture.db, periodId, deviating, {
        revision: 3, actor: "laila@prostarmechanical.com", poolPercent: 0.55, efficiencyEnabled: true,
      });
      await assert.rejects(runInitialization(fixture, "2023-02"), /not the exact migration-019 to migration-025|actor identity alone is not approval|unsupported owner/i);
      assert.equal((await fixture.db.query("select 1 from metrics.commission_periods")).rows.length, 1);
      assert.equal((await fixture.db.query("select 1 from metrics.rollup_rebuild_queue")).rows.length, 0);
    } finally { await fixture.db.close(); }
  });
});

test("production-shaped migration-019 predecessor and migration-025 locked config chain is preserved", async () => {
  const fixture = await migratedDatabase();
  try {
    await seedAcceptedPrerequisites(fixture.db, "2023-01");
    const periodId = await insertPeriod(fixture.db, { month: "2023-01" });
    await insertConfig(fixture.db, periodId, LOCKED_COMMISSION_CONFIG);
    const report = await initializeHistoricalCommissionPeriods({
      throughMonth: "2023-01",
      actorEmail: "asad@prostarmechanical.com",
    }, fixture.transaction);
    assert.equal(report.periods[0].configAction, "preserve");
    assert.equal(report.periods[0].configHash, LOCKED_COMMISSION_CONFIG_HASH);
    assert.equal(report.periods[0].configEvidenceActor, "system:migration-025");
  } finally {
    await fixture.db.close();
  }
});

test("override authority, recipient, typed semantics, chains, and immutable audits fail closed", async (t) => {
  await t.test("outsider final_bonus 999999", async () => {
    const fixture = await migratedDatabase();
    try {
      const periodId = await insertPeriod(fixture.db, { month: "2023-01" });
      await insertAuditedOverride(fixture.db, {
        periodId, employeeId: "17", field: "final_bonus", value: 999999,
        valueType: "number", poolTreatment: "inside_pool", actor: "outsider@prostarmechanical.com",
      });
      await assert.rejects(runInitialization(fixture, "2023-01"), /override .*actor outsider.*not Asad or Laila/i);
    } finally { await fixture.db.close(); }
  });

  await t.test("unaudited owner override and out-of-roster recipient", async () => {
    const fixture = await migratedDatabase();
    try {
      const periodId = await insertPeriod(fixture.db, { month: "2023-01" });
      await fixture.db.query(
        `insert into metrics.commission_overrides (
           period_id, employee_id, field_name, before_value, after_value, value_type,
           reason, actor_email, pool_treatment, revision, active, idempotency_key
         ) values ($1, 99999, 'final_bonus', null, '0.55'::jsonb, 'number',
                   'Unaudited arbitrary payout.', 'asad@prostarmechanical.com', 'inside_pool', 1, true, $2)`,
        [periodId, commissionHashJson({ orphan: true })],
      );
      await assert.rejects(runInitialization(fixture, "2023-01"), /out-of-roster|0 matching immutable/i);
    } finally { await fixture.db.close(); }
  });

  await t.test("tampered audit, orphan audit, and noncontiguous chain", async () => {
    const fixture = await migratedDatabase();
    try {
      const periodId = await insertPeriod(fixture.db, { month: "2023-01" });
      const overrideId = await insertAuditedOverride(fixture.db, {
        periodId, employeeId: "17", field: "notes", value: "approved",
        valueType: "string", poolTreatment: "neutral", actor: "asad@prostarmechanical.com",
        revision: 2, before: "missing revision one", tamperAudit: true,
      });
      await fixture.db.query(
        `insert into metrics.audit_events (
           actor_email, action, entity_type, entity_id, before_value, after_value, reason
         ) values ('asad@prostarmechanical.com', 'commission_override_revised', 'commission_period', $1,
                   '{"field":"notes","value":null}',
                   '{"field":"notes","value":"orphan","override_id":999999,"override_revision":1}',
                   'Orphan approval record.')`,
        [periodId],
      );
      await assert.rejects(runInitialization(fixture, "2023-01"), new RegExp(`override ${overrideId} approval audit.*tampered|orphaned|not contiguous`, "i"));
      await assert.rejects(
        fixture.db.query("update metrics.audit_events set reason = 'changed' where action = 'commission_override_revised'"),
        /immutable/i,
      );
    } finally { await fixture.db.close(); }
  });
});

test("foreign current_run_id and incomplete initialization audit are never publishable", async (t) => {
  await t.test("foreign current run is queued for exact rebuild", async () => {
    const fixture = await migratedDatabase();
    try {
      await seedAcceptedPrerequisites(fixture.db, "2023-02");
      const januaryId = await insertPeriod(fixture.db, { month: "2023-01" });
      await insertConfig(fixture.db, januaryId, LOCKED_COMMISSION_CONFIG);
      const februaryId = await insertPeriod(fixture.db, { month: "2023-02" });
      await insertConfig(fixture.db, februaryId, LOCKED_COMMISSION_CONFIG);
      const run = await fixture.db.query<{ id: string }>(
        `insert into metrics.commission_calculation_runs (
           period_id, config, source_watermarks, override_hash, employee_results,
           job_allocations, calculation_hash, created_by, immutable
         ) values ($1, $2::jsonb, '{}'::jsonb, $3, '[]'::jsonb, '[]'::jsonb, repeat('a',64), 'runtime', true)
         returning id::text`,
        [februaryId, commissionStableJson(LOCKED_COMMISSION_CONFIG), commissionHashJson([])],
      );
      await fixture.db.query("update metrics.commission_periods set current_run_id = $1 where id = $2", [run.rows[0].id, januaryId]);
      const report = await initializeHistoricalCommissionPeriods({ throughMonth: "2023-02", actorEmail: "asad@prostarmechanical.com" }, fixture.transaction);
      assert.equal(report.periods[0].runIntegrity, "invalid");
      assert.match(report.periods[0].runIntegrityDetail ?? "", /belongs to period/);
      assert.equal(report.periods[0].rebuildAction, "enqueue");
    } finally { await fixture.db.close(); }
  });

  await t.test("same-period corrupt run is rejected by the canonical verifier and queued", async () => {
    const fixture = await migratedDatabase();
    try {
      await seedAcceptedPrerequisites(fixture.db, "2023-01");
      const periodId = await insertPeriod(fixture.db, { month: "2023-01" });
      await insertConfig(fixture.db, periodId, LOCKED_COMMISSION_CONFIG);
      const run = await fixture.db.query<{ id: string }>(
        `insert into metrics.commission_calculation_runs (
           period_id, config, source_watermarks, override_hash, employee_results,
           job_allocations, calculation_hash, created_by, immutable, run_status,
           source_complete, config_hash, source_hash, input_manifest_hash
         ) values ($1, $2::jsonb, '{}'::jsonb, $3, '[]'::jsonb, '[]'::jsonb,
                   repeat('a',64), 'runtime', true, 'succeeded', true, $4, repeat('b',64), repeat('c',64))
         returning id::text`,
        [periodId, commissionStableJson(LOCKED_COMMISSION_CONFIG), commissionHashJson([]), LOCKED_COMMISSION_CONFIG_HASH],
      );
      await fixture.db.query(
        "update metrics.commission_periods set current_run_id = $1, calculation_stale = false where id = $2",
        [run.rows[0].id, periodId],
      );
      const report = await initializeHistoricalCommissionPeriods({
        throughMonth: "2023-01", actorEmail: "asad@prostarmechanical.com",
      }, fixture.transaction);
      assert.equal(report.periods[0].runIntegrity, "invalid");
      assert.match(report.periods[0].runIntegrityDetail ?? "", /config revision|evidence|manifest|read model|override hash/i);
      assert.equal(report.periods[0].rebuildAction, "enqueue");
    } finally { await fixture.db.close(); }
  });

  await t.test("tampered incomplete initialization audit conflicts", async () => {
    const fixture = await migratedDatabase();
    try {
      const periodId = await insertPeriod(fixture.db, { month: "2023-01" });
      await insertConfig(fixture.db, periodId, LOCKED_COMMISSION_CONFIG);
      await fixture.db.query(
        `insert into metrics.audit_events (
           actor_email, action, entity_type, entity_id, after_value, reason
         ) values ('asad@prostarmechanical.com', 'commission_period_historical_initialization_evidenced',
                   'commission_period', $1, '{"initializationVersion":"commission-period-initialization-v2"}', 'tampered')`,
        [periodId],
      );
      await seedAcceptedPrerequisites(fixture.db, "2023-01");
      const forgedQueue = await fixture.db.query<{ id: string }>(`
        insert into metrics.rollup_rebuild_queue (
          metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
        ) values (
          'commissions', 'month', '2023-01-01', '{}',
          'Historical commission period initialization v2 from locked evidence',
          'commissions:month:2023-01-01:commission-period-initialization-v2'
        ) returning id::text
      `);
      const status = await getCommissionInitializationQueueStatus("2023-01", fixture.query);
      assert.deepEqual(status.statuses, { missing_audit: 1 });
      assert.equal(status.auditedPeriods, 0);
      assert.equal(status.linkedQueues, 0);
      assert.equal(await claimCommissionInitializationRebuild({
        throughMonth: "2023-01", workerId: "forged-audit-worker",
      }, fixture.query), null);
      await fixture.db.query(
        "update metrics.rollup_rebuild_queue set status = 'failed', finished_at = now() where id = $1",
        [forgedQueue.rows[0].id],
      );
      await assert.rejects(repairFailedCommissionInitializationRebuild({
        month: "2023-01",
        actorEmail: "laila@prostarmechanical.com",
        reason: "A forged audit must never authorize queue repair.",
        confirmation: commissionInitializationRepairConfirmationToken("2023-01"),
      }, fixture.transaction), /exactly one complete initialization-v2 rebuild queue identity/i);
      await assert.rejects(runInitialization(fixture, "2023-01"), /invalid action evidence|missing\/tampered/i);
      await assert.rejects(
        fixture.db.query("delete from metrics.audit_events where action = 'commission_period_historical_initialization_evidenced'"),
        /immutable/i,
      );
    } finally { await fixture.db.close(); }
  });

  await t.test("full-shaped foreign config forgery with arbitrary evidence hashes is not canonical", async () => {
    const fixture = await migratedDatabase();
    try {
      await seedAcceptedPrerequisites(fixture.db, "2023-01");
      const periodId = await insertPeriod(fixture.db, { month: "2023-01" });
      const foreignWriter = "foreign.config.writer@example.test";
      await insertConfig(fixture.db, periodId, LOCKED_COMMISSION_CONFIG, { actor: foreignWriter });
      const queue = (await fixture.db.query<{ id: string; created_at: string }>(`
        insert into metrics.rollup_rebuild_queue (
          metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
        ) values (
          'commissions', 'month', '2023-01-01', '{}',
          'Historical commission period initialization v2 from locked evidence',
          'commissions:month:2023-01-01:commission-period-initialization-v2'
        )
        returning id::text,
                  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
      `)).rows[0];
      const roster = await fixture.db.query<{ id: string }>(`
        select id::text
          from metrics.commission_roster
         where effective_start <= date '2023-01-31'
           and (effective_end is null or effective_end >= date '2023-01-01')
         order by employee_id, effective_start, id
      `);
      const afterValue = {
        initializationVersion: COMMISSION_INITIALIZATION_VERSION,
        periodAction: "preserve",
        configAction: "preserve",
        periodStart: "2023-01-01",
        periodEnd: "2023-01-31",
        periodRevision: 1,
        configHash: LOCKED_COMMISSION_CONFIG_HASH,
        configEvidenceActor: foreignWriter,
        rosterHash: "a".repeat(64),
        rosterRowIds: roster.rows.map((row) => row.id),
        rosterEntries: roster.rows.length,
        overrideCount: 0,
        effectiveOverrideCount: 0,
        overrideHash: "b".repeat(64),
        overrideRowIds: [],
        overrideAuditIds: [],
        rebuildAction: "use_existing",
        rebuildQueue: {
          id: queue.id,
          metricFamily: "commissions",
          periodGrain: "month",
          periodStart: "2023-01-01",
          dimensions: {},
          reason: "Historical commission period initialization v2 from locked evidence",
          idempotencyKey: "commissions:month:2023-01-01:commission-period-initialization-v2",
          createdAt: queue.created_at,
        },
        evidence: { ...LOCKED_COMMISSION_POLICY_EVIDENCE, lockedConfigHash: LOCKED_COMMISSION_CONFIG_HASH },
      };
      await fixture.db.query(
        `insert into metrics.audit_events (
           actor_email, action, entity_type, entity_id, before_value, after_value, reason
         ) values ($1, 'commission_period_historical_initialization_evidenced', 'commission_period', $2,
                   $3::jsonb, $4::jsonb,
                   'Initialize the monthly commission period from locked prior-dashboard config and effective-dated roster evidence without changing existing commission policy or overrides.')`,
        [
          "asad@prostarmechanical.com",
          periodId,
          JSON.stringify({ periodPreserved: true, configPreserved: true, overridesPreserved: 0 }),
          JSON.stringify(afterValue),
        ],
      );

      const canonical = await fixture.db.query<{ audits: number; queues: number }>(`
        select
          (select count(*)::int from metrics.commission_initialization_v2_audit_records) as audits,
          (select count(*)::int from metrics.commission_initialization_v2_queue_records) as queues
      `);
      assert.deepEqual(canonical.rows[0], { audits: 0, queues: 0 });
      const status = await getCommissionInitializationQueueStatus("2023-01", fixture.query);
      assert.deepEqual(status.statuses, { missing_audit: 1 });
      assert.equal(await claimCommissionInitializationRebuild({
        throughMonth: "2023-01",
        workerId: "full-shaped-forgery-worker",
      }, fixture.query), null);
    } finally {
      await fixture.db.close();
    }
  });
});

test("queue scope, failed repair, partial rollback, and serialization retry are explicit", async () => {
  const fixture = await migratedDatabase();
  try {
    const prerequisites = await checkCommissionInitializationPrerequisites("2023-01", fixture.query);
    assert.deepEqual({
      ready: prerequisites.ready,
      sourceUnitsExpected: prerequisites.sourceUnitsExpected,
      reconciliationsExpected: prerequisites.reconciliationsExpected,
      rejected: prerequisites.rejected.length,
    }, { ready: false, sourceUnitsExpected: 5, reconciliationsExpected: 2, rejected: 7 });
    await assert.rejects(runInitialization(fixture, "2023-01"), /source reconciliation prerequisite/i);
    assert.equal((await fixture.db.query("select 1 from metrics.commission_periods")).rows.length, 0);
    await seedAcceptedPrerequisites(fixture.db, "2023-01");
    await fixture.db.exec(`insert into metrics.rollup_rebuild_queue (
      metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
    ) values ('commissions', 'month', '2023-01-01', '{}', 'unrelated', 'unrelated-commission-job')`);
    await initializeHistoricalCommissionPeriods({
      throughMonth: "2023-01", actorEmail: "asad@prostarmechanical.com", execute: true,
      confirmation: commissionInitializationConfirmationToken("2023-01"),
    }, fixture.transaction);
    const exactQueue = (await fixture.db.query<{ id: string; created_at: string }>(
      `select id::text, created_at::text from metrics.rollup_rebuild_queue
        where idempotency_key = 'commissions:month:2023-01-01:commission-period-initialization-v2'`,
    )).rows[0];
    await fixture.db.query("update metrics.rollup_rebuild_queue set reason = 'tampered reason' where id = $1", [exactQueue.id]);
    assert.equal((await getCommissionInitializationQueueStatus("2023-01", fixture.query)).statuses.invalid_queue, 1);
    assert.equal(await claimCommissionInitializationRebuild({
      throughMonth: "2023-01", workerId: "tampered-reason-test",
    }, fixture.query), null);
    await assert.rejects(runInitialization(fixture, "2023-01"), /conflicting key, reason, scope, creation bound, or dimensions identity/i);
    await fixture.db.query(
      `update metrics.rollup_rebuild_queue
          set reason = 'Historical commission period initialization v2 from locked evidence'
        where id = $1`,
      [exactQueue.id],
    );
    await fixture.db.query(
      `update metrics.rollup_rebuild_queue
          set created_at = (select applied_at - interval '1 second' from metrics.schema_migrations
                             where filename = '036_commission_initialization_integrity.sql')
        where id = $1`,
      [exactQueue.id],
    );
    assert.equal((await getCommissionInitializationQueueStatus("2023-01", fixture.query)).statuses.invalid_queue, 1);
    await fixture.db.query("update metrics.rollup_rebuild_queue set created_at = $2::timestamptz where id = $1", [exactQueue.id, exactQueue.created_at]);
    await fixture.db.query("update metrics.rollup_rebuild_queue set idempotency_key = 'tampered-v2-key' where id = $1", [exactQueue.id]);
    assert.equal((await getCommissionInitializationQueueStatus("2023-01", fixture.query)).statuses.invalid_queue, 1);
    await fixture.db.query(
      `update metrics.rollup_rebuild_queue
          set idempotency_key = 'commissions:month:2023-01-01:commission-period-initialization-v2'
        where id = $1`,
      [exactQueue.id],
    );
    const claimed = await claimCommissionInitializationRebuild({
      throughMonth: "2023-01", workerId: "bounded-test",
    }, fixture.query);
    assert.ok(claimed);
    assert.notEqual(claimed.id, Number((await fixture.db.query<{ id: string }>(
      "select id::text from metrics.rollup_rebuild_queue where idempotency_key = 'unrelated-commission-job'",
    )).rows[0].id));
    await fixture.db.query(
      `update metrics.rollup_rebuild_queue
          set status = 'failed', locked_by = null, locked_until = null,
              error_message = 'source reconciliation incomplete', finished_at = now()
        where id = $1`,
      [claimed.id],
    );
    await assert.rejects(runInitialization(fixture, "2023-01"), /explicit commission initialization queue repair/i);
    await fixture.db.exec(`update metrics.backfill_source_month_ledger
      set status = 'reconciliation_pending', reconciliation_status = 'mismatch'
      where month_start = date '2023-01-01' and source_family = 'jobs'`);
    assert.equal(await claimCommissionInitializationRebuild({
      throughMonth: "2023-01", workerId: "prerequisite-race-test",
    }, fixture.query), null);
    await assert.rejects(repairFailedCommissionInitializationRebuild({
      month: "2023-01",
      actorEmail: "laila@prostarmechanical.com",
      reason: "Source reconciliation was corrected and independently accepted.",
      confirmation: commissionInitializationRepairConfirmationToken("2023-01"),
    }, fixture.transaction), /prerequisites are not accepted/i);
    assert.equal((await fixture.db.query<{ status: string }>(
      "select status::text from metrics.rollup_rebuild_queue where id = $1", [claimed.id],
    )).rows[0].status, "failed");
    await fixture.db.exec(`update metrics.backfill_source_month_ledger
      set status = 'completed', reconciliation_status = 'matched'
      where month_start = date '2023-01-01' and source_family = 'jobs'`);
    const repaired = await repairFailedCommissionInitializationRebuild({
      month: "2023-01",
      actorEmail: "laila@prostarmechanical.com",
      reason: "Source reconciliation was corrected and independently accepted.",
      confirmation: commissionInitializationRepairConfirmationToken("2023-01"),
    }, fixture.transaction);
    assert.equal(repaired.queueId, String(claimed.id));
    assert.equal((await getCommissionInitializationQueueStatus("2023-01", fixture.query)).statuses.queued, 1);
    assert.equal((await fixture.db.query<{ status: string }>(
      "select status::text from metrics.rollup_rebuild_queue where idempotency_key = 'unrelated-commission-job'",
    )).rows[0].status, "queued");
    await fixture.db.exec("update metrics.rollup_rebuild_queue set status = 'cancelled' where idempotency_key = 'unrelated-commission-job'");

    let attempts = 0;
    const retryingTransaction = async <T>(callback: (query: PostgresQuery) => Promise<T>) => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("serialization conflict"), { code: "40001" });
      return fixture.transaction(callback);
    };
    const retried = await initializeHistoricalCommissionPeriods({
      throughMonth: "2023-01", actorEmail: "asad@prostarmechanical.com", execute: true,
      confirmation: commissionInitializationConfirmationToken("2023-01"),
    }, retryingTransaction);
    assert.equal(attempts, 3);
    assert.equal(retried.summary.writesApplied, 0);

    const fork = await fixture.db.query<{ id: string }>(`
      insert into metrics.commission_periods (
        period_start, period_end, status, config, source_watermarks, override_hash,
        revision, edit_revision, config_revision, created_by, supersedes_period_id,
        revision_reason, calculation_stale
      ) select period_start, period_end, 'draft', config, source_watermarks, override_hash,
               2, edit_revision + 1, config_revision, 'asad@prostarmechanical.com', id,
               'Approved protected-period revision.', true
          from metrics.commission_periods
         where period_start = date '2023-01-01' and revision = 1
      returning id::text
    `);
    await insertConfig(fixture.db, fork.rows[0].id, LOCKED_COMMISSION_CONFIG, {
      revision: 2,
      actor: "system:migration-025",
    });
    assert.equal(await claimCommissionInitializationRebuild({
      throughMonth: "2023-01", workerId: "stale-audit-test",
    }, fixture.query), null);
    assert.equal((await getCommissionInitializationQueueStatus("2023-01", fixture.query)).auditedPeriods, 0);
  } finally { await fixture.db.close(); }
});

test("execute rechecks prerequisites inside the serializable transaction immediately before writes", async () => {
  const fixture = await migratedDatabase();
  try {
    await seedAcceptedPrerequisites(fixture.db, "2023-01");
    let prerequisiteProbes = 0;
    const racingTransaction = async <T>(callback: (query: PostgresQuery) => Promise<T>) => {
      await fixture.db.exec("begin");
      const query: PostgresQuery = async <R>(sql: string, values?: unknown[]) => {
        if (sql.includes("commission_initialization_prerequisite_status")) {
          prerequisiteProbes += 1;
          if (prerequisiteProbes === 2) {
            await fixture.db.exec(`update metrics.backfill_source_month_ledger
              set status = 'reconciliation_pending', reconciliation_status = 'mismatch'
              where month_start = date '2023-01-01' and source_family = 'jobs'`);
          }
        }
        return fixture.query<R>(sql, values);
      };
      try {
        const result = await callback(query);
        await fixture.db.exec("commit");
        return result;
      } catch (error) {
        await fixture.db.exec("rollback");
        throw error;
      }
    };
    await assert.rejects(initializeHistoricalCommissionPeriods({
      throughMonth: "2023-01",
      actorEmail: "asad@prostarmechanical.com",
      execute: true,
      confirmation: commissionInitializationConfirmationToken("2023-01"),
    }, racingTransaction), /source reconciliation prerequisite backfill:jobs is not accepted/i);
    assert.equal(prerequisiteProbes, 2);
    assert.equal((await fixture.db.query("select 1 from metrics.commission_periods")).rows.length, 0);
    assert.equal((await fixture.db.query("select 1 from metrics.rollup_rebuild_queue")).rows.length, 0);
  } finally {
    await fixture.db.close();
  }
});

test("additive commission integrity migration is twice-safe without changing prior migrations", async () => {
  const fixture = await migratedDatabase();
  try {
    const migration = await readFile(new URL("036_commission_initialization_integrity.sql", migrationDirectory), "utf8");
    await fixture.db.exec(migration);
    await fixture.db.exec(migration);
    const hashes = await fixture.db.query<{ filename: string; sha256: string }>(`
      select filename, sha256 from metrics.schema_migrations
       where filename in ('009_commission_roster_seed.sql', '019_seed_verified_commission_period_configs.sql', '025_upgrade_verified_commission_tier_config.sql')
       order by filename
    `);
    assert.deepEqual(hashes.rows.map((row) => row.filename), [
      "009_commission_roster_seed.sql",
      "019_seed_verified_commission_period_configs.sql",
      "025_upgrade_verified_commission_tier_config.sql",
    ]);
    assert.ok(hashes.rows.every((row) => /^[0-9a-f]{64}$/.test(row.sha256)));
  } finally { await fixture.db.close(); }
});

async function assertNoInitializationWrites(fixture: Awaited<ReturnType<typeof migratedDatabase>>, pattern: RegExp) {
  await assert.rejects(runInitialization(fixture, "2023-02"), pattern);
  assert.equal((await fixture.db.query("select 1 from metrics.commission_periods")).rows.length, 0);
  assert.equal((await fixture.db.query("select 1 from metrics.rollup_rebuild_queue")).rows.length, 0);
}

function runInitialization(fixture: Awaited<ReturnType<typeof migratedDatabase>>, through: string) {
  return initializeHistoricalCommissionPeriods({
    throughMonth: through,
    actorEmail: "asad@prostarmechanical.com",
    execute: true,
    confirmation: commissionInitializationConfirmationToken(through),
  }, fixture.transaction);
}

async function insertPeriod(db: PGlite, params: {
  month: string;
  status?: "draft" | "reviewed" | "exported" | "locked";
  config?: unknown;
  configRevision?: number;
}) {
  const [year, month] = params.month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const inserted = await db.query<{ id: string }>(
    `insert into metrics.commission_periods (
       period_start, period_end, status, config, source_watermarks, override_hash,
       revision, edit_revision, config_revision, created_by, calculation_stale
     ) values ($1::date, $2::date, $3::metrics.commission_period_status, $4::jsonb, '{}'::jsonb, $5,
               1, 0, $6, 'fixture', true)
     returning id::text`,
    [
      `${params.month}-01`, `${params.month}-${String(lastDay).padStart(2, "0")}`,
      params.status ?? "draft", commissionStableJson(params.config ?? LOCKED_COMMISSION_CONFIG),
      commissionHashJson([]), params.configRevision ?? 1,
    ],
  );
  return inserted.rows[0].id;
}

async function insertConfig(
  db: PGlite,
  periodId: string,
  config: typeof LOCKED_COMMISSION_CONFIG,
  options: { revision?: number; actor?: string; poolPercent?: number; efficiencyEnabled?: boolean } = {},
) {
  const revision = options.revision ?? 1;
  const configJson = commissionStableJson(config);
  const isProductionLockedFixture = Object.keys(options).length === 0
    && configJson === commissionStableJson(LOCKED_COMMISSION_CONFIG);
  if (isProductionLockedFixture) {
    const period = (await db.query<{ period_start: string; period_end: string }>(
      "select period_start::text, period_end::text from metrics.commission_periods where id = $1",
      [periodId],
    )).rows[0];
    const predecessor = {
      poolPercent: 0.5,
      minBonusPercent: 5,
      efficiencyEnabled: false,
      maxEfficiencyAdjustmentPercent: 20,
    };
    await db.query(
      `insert into metrics.commission_period_configs (
         period_id, revision, pool_pct, min_bonus_pct, efficiency_enabled,
         max_efficiency_adjustment_pct, on_time_threshold_minutes, config_json,
         config_hash, actor_email, active, superseded_at, idempotency_key
       ) values
         ($1, 1, 0.5, 5, false, 20, 15, $2::jsonb, $3,
          'system:migration-019', false, now(), 'verified-prior-dashboard-config:' || $4),
         ($1, 2, 0.5, 5, false, 20, 15, $5::jsonb, $6,
          'system:migration-025', true, null, 'verified-tier-config:025:' || $1::text)`,
      [
        periodId,
        commissionStableJson(predecessor),
        "5966f042954aea4d9e8d7499655b76f7d4df9748693972cd386a8a7fb6735553",
        period.period_start,
        configJson,
        LOCKED_COMMISSION_CONFIG_HASH,
      ],
    );
    await db.query("update metrics.commission_periods set config_revision = 2 where id = $1", [periodId]);
    await db.query(
      `insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason
       ) values
       ('system:migration-019', 'commission_period_config_evidence_seeded', 'commission_period', $1,
        null,
        jsonb_build_object(
          'periodStart', $2::date, 'periodEnd', $3::date, 'configRevision', 1,
          'configHash', $4::text, 'config', $5::jsonb,
          'evidence', jsonb_build_object(
            'source', 'docs/prostar-metrics/reference/commissions-dashboard.html',
            'sourceSha256', '037b1f6e0e5b7a4156a8eee8180307e92dfc3f0f17b8f19b5ea7011f2852538b',
            'sourceLines', '604-610',
            'planSection', '6.4 Technician Commissions / Base calculation order',
            'historicalBasis', 'The prior dashboard declares one global CONFIG used by its monthly calculations.'
          )
        ),
        'Persist period-effective evidence for the commission config already specified by the authoritative prior dashboard and locked implementation plan.'),
       ('system:migration-025', 'commission_tier_config_upgraded', 'commission_period', $1,
        jsonb_build_object('configHash', $4::text, 'tierMultipliers', null),
        jsonb_build_object(
          'configRevision', 2, 'configHash', $6::text,
          'tierMultipliers', $7::jsonb -> 'tierMultipliers', 'rebuildQueued', false
        ),
        'Added the locked default tier multipliers to the verified prior-dashboard config and queued an immutable recalculation.')`,
      [
        periodId,
        period.period_start,
        period.period_end,
        "5966f042954aea4d9e8d7499655b76f7d4df9748693972cd386a8a7fb6735553",
        commissionStableJson(predecessor),
        LOCKED_COMMISSION_CONFIG_HASH,
        configJson,
      ],
    );
    return;
  }
  await db.query(
    `insert into metrics.commission_period_configs (
       period_id, revision, pool_pct, min_bonus_pct, efficiency_enabled,
       max_efficiency_adjustment_pct, on_time_threshold_minutes, config_json,
       config_hash, actor_email, active, idempotency_key
     ) values ($1, $2, $3, 5, $4, 20, 15, $5::jsonb, $6, $7, true, $8)`,
    [
      periodId, revision, options.poolPercent ?? 0.5, options.efficiencyEnabled ?? false,
      configJson, commissionHashJson(config), options.actor ?? "system:migration-025", `fixture-config-${periodId}-${revision}`,
    ],
  );
}

async function seedAcceptedPrerequisites(db: PGlite, through: string) {
  await db.query(
    `insert into metrics.backfill_source_month_ledger (
       source_family, month_start, month_end_exclusive, status,
       expected_pages, expected_records, estimated_nested_requests, estimated_requests,
       daily_request_ceiling, reconciliation_status, approved_by, approved_at,
       plan_hash, completed_at
     )
     select source_family, month_start, (month_start + interval '1 month')::date,
            'planned', 1, 1, 0, 1, 1000, 'pending',
            'asad@prostarmechanical.com', now(), repeat('a', 64), null
       from generate_series(date '2023-01-01', $1::date, interval '1 month') month(month_start)
       cross join unnest(array[
         'jobs', 'job_nested', 'employees', 'timesheets', 'jobs_from_timesheets'
       ]::text[]) family(source_family)
     on conflict (source_family, month_start) do nothing`,
    [`${through}-01`],
  );
  await db.exec(
    `insert into metrics.backfill_traversal_manifests (
       work_unit_id, generation, contract_version, manifest_status, filter_contract,
       as_of_watermark, observed_boundary, page_count, record_count, completed_at
     )
     select id, 1, 1, 'completed', '{}'::jsonb, now(), '{}'::jsonb, 1, 1, now()
       from metrics.backfill_source_month_ledger
      where month_start between date '2023-01-01' and date '${through}-01'
        and source_family in ('jobs', 'job_nested', 'employees', 'timesheets', 'jobs_from_timesheets')
     on conflict (work_unit_id) do nothing`,
  );
  await db.exec(
    `update metrics.backfill_source_month_ledger
        set status = 'completed', reconciliation_status = 'matched',
            continuation_token = null, required_for_completion = true,
            plan_hash = repeat('a', 64), completed_at = now()
      where month_start between date '2023-01-01' and date '${through}-01'
        and source_family in ('jobs', 'job_nested', 'employees', 'timesheets', 'jobs_from_timesheets')`,
  );
  await db.query(
    `insert into metrics.source_period_manifests (
       source_family, period_start, period_end, coverage_status, reconciliation_status,
       listed_count, detail_count, normalized_count, source_id_hash, normalized_id_hash,
       evidence_as_of, completed_at, manifest_generation, reconciliation_generation,
       expected_page_count, completed_page_count, reconciled_at
     )
     select source_family, month_start, (month_start + interval '1 month - 1 day')::date,
            'complete', 'matched', 1, 1, 1, repeat('b', 64), repeat('b', 64),
            now(), now(), 1, 1, 1, 1, now()
       from generate_series(date '2023-01-01', $1::date, interval '1 month') month(month_start)
       cross join unnest(array[
         'jobs', 'job_nested', 'employees', 'timesheets', 'jobs_from_timesheets',
         'schedules', 'mobile_status'
       ]::text[]) family(source_family)`,
    [`${through}-01`],
  );
  await db.query(
    `insert into metrics.reconciliation_checks (
       scope, period_start, period_end, status, complete_traversal, generation,
       source_manifest_generations
     )
     select scope, month_start, (month_start + interval '1 month - 1 day')::date,
            'matched', true, 1,
            case scope
              when 'jobs' then '{"jobs":1,"job_nested":1}'::jsonb
              else '{"jobs":1,"job_nested":1,"employees":1,"timesheets":1,"jobs_from_timesheets":1,"schedules":1,"mobile_status":1}'::jsonb
            end
       from generate_series(date '2023-01-01', $1::date, interval '1 month') month(month_start)
       cross join unnest(array['jobs', 'technicians']::text[]) required(scope)`,
    [`${through}-01`],
  );
}

async function insertAuditedOverride(db: PGlite, params: {
  periodId: string;
  employeeId: string;
  field: string;
  value: unknown;
  valueType: string;
  poolTreatment: string;
  actor: string;
  revision?: number;
  before?: unknown;
  tamperAudit?: boolean;
}) {
  const revision = params.revision ?? 1;
  const reason = "Approved historical commission override evidence.";
  const inserted = await db.query<{ id: string }>(
    `insert into metrics.commission_overrides (
       period_id, employee_id, field_name, before_value, after_value, value_type,
       reason, actor_email, pool_treatment, revision, active, idempotency_key
     ) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, true, $11)
     returning id::text`,
    [
      params.periodId, params.employeeId, params.field, JSON.stringify(params.before ?? null),
      JSON.stringify(params.value), params.valueType, reason, params.actor, params.poolTreatment,
      revision, commissionHashJson({ ...params, reason }),
    ],
  );
  const id = inserted.rows[0].id;
  await db.query(
    `insert into metrics.audit_events (
       actor_email, action, entity_type, entity_id, before_value, after_value, reason
     ) values ($1, 'commission_override_revised', 'commission_period', $2,
               jsonb_build_object('field', $3::text, 'value', $4::jsonb),
               jsonb_build_object('field', $3::text, 'value', $5::jsonb,
                                  'override_id', $6::bigint, 'override_revision', $7::int), $8)`,
    [
      params.actor, params.periodId, params.field, JSON.stringify(params.before ?? null),
      JSON.stringify(params.tamperAudit ? "tampered" : params.value), id, revision, reason,
    ],
  );
  return id;
}

async function migratedDatabase() {
  const db = new PGlite();
  const migrations = await loadMigrations();
  for (const migration of migrations) await db.exec(migration.sql);
  await db.exec(`create table if not exists metrics.schema_migrations (
    filename text primary key, sha256 text not null, applied_at timestamptz not null default now()
  )`);
  for (const migration of migrations) {
    await db.query(
      "insert into metrics.schema_migrations (filename, sha256) values ($1, $2)",
      [migration.name, createHash("sha256").update(migration.sql).digest("hex")],
    );
  }
  const query: PostgresQuery = async <T>(sql: string, values?: unknown[]) => {
    const result = await db.query<T>(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? null };
  };
  const transaction = async <T>(callback: (transactionQuery: PostgresQuery) => Promise<T>) => {
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
  return { db, query, transaction };
}

async function loadMigrations() {
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  return Promise.all(files.map(async (name) => ({ name, sql: await readFile(new URL(name, migrationDirectory), "utf8") })));
}

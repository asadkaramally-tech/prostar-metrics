import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { buildCommissionReadModel } from "../../src/lib/metrics/commissions";
import {
  createOrGetCommissionExport,
  downloadCommissionExport,
  getCurrentCommissionRunForExport,
} from "../../src/lib/store/commission-exports";
import {
  parseCommissionOverride,
  persistCommissionConfig,
  persistCommissionOverride,
  queueCommissionRebuild,
  transitionCommissionPeriod,
  type CommissionQuery,
} from "../../src/lib/store/commission-lifecycle";
import type { CommissionRebuildArtifact } from "../../src/lib/store/commission-rebuild";
import { commissionHashJson, type CommissionHashManifestEntry } from "../../src/lib/store/commission-integrity";
import {
  publishCommissionReadModelForJob,
  type RollupRebuildJob,
} from "../../src/lib/store/read-model-rebuilds";
import {
  buildCommissionServingRow,
  commissionArtifactFromServingRow,
} from "../helpers/commission-serving";

test("commission commands execute an immutable draft-review-export-lock revision workflow", async () => {
  const db = new PGlite();
  const query: CommissionQuery = async <T>(sql: string, values: unknown[] = []) => {
    const result = await db.query(sql, values);
    return { rows: result.rows as T[], rowCount: result.rows.length };
  };
  const transaction = pgliteTransaction(db, query);
  try {
    const directory = new URL("../../infra/db/migrations/", import.meta.url);
    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".sql") && file <= "015_commission_manifest_evidence.sql")
      .sort();
    for (const file of files) await db.exec(await readFile(new URL(file, directory), "utf8"));
    const config = { poolPercent: 0.5, minBonusPercent: 5, efficiencyEnabled: false, maxEfficiencyAdjustmentPercent: 20 };
    await db.query(`
      insert into metrics.commission_periods (
        id, period_start, period_end, status, config, source_watermarks, override_hash,
        revision, edit_revision, config_revision, created_by, calculation_stale
      ) values (1, '2026-06-01', '2026-06-30', 'draft', $1, '{}', 'empty', 1, 0, 1, 'seed', true)
    `, [JSON.stringify(config)]);
    await db.exec("select setval('metrics.commission_periods_id_seq', 1, true)");

    const overrideResult = await persistCommissionOverride({
      periodStart: "2026-06-01", expectedRevision: 0,
      override: parseCommissionOverride({ employeeId: 10, field: "notes", value: "Reviewed source note", reason: "Document source evidence." }),
      actorEmail: "admin@example.test",
    }, query);
    assert.equal(overrideResult.period.editRevision, 1);
    const activeConfig = {
      ...config, minBonusPercent: 6,
      tierMultipliers: { Gold: 1.3, Silver: 1.2, Bronze: 1.1, Standard: 1 },
    };
    const configResult = await persistCommissionConfig({
      periodStart: "2026-06-01", expectedRevision: 1,
      config: activeConfig,
      reason: "Approve verified payout configuration.", actorEmail: "admin@example.test",
    }, query);
    assert.equal(configResult.editRevision, 2);

    const configSourceResult = await db.query<Record<string, unknown>>(`
      select period_id::text, revision, pool_pct::text, min_bonus_pct::text,
             efficiency_enabled, max_efficiency_adjustment_pct::text,
             config_json, config_hash, actor_email, active, created_at::text
        from metrics.commission_period_configs
       where period_id = 1 and revision = 2 and active
    `);
    const artifact = calculationArtifact(activeConfig, configSourceResult.rows[0]);
    await db.exec(`
      insert into metrics.rollup_rebuild_queue (
        id, metric_family, period_grain, period_start, dimensions_json, reason,
        idempotency_key, status, locked_by, locked_until
      ) values (
        50, 'commissions', 'month', '2026-06-01', '{}', 'workflow test',
        'commission-workflow-test:50', 'running', 'commission-worker-50', now() + interval '10 minutes'
      )
    `);
    const job: RollupRebuildJob = {
      id: 50,
      metric_family: "commissions",
      period_grain: "month",
      period_start: "2026-06-01",
      dimensions_json: {},
      locked_by: "commission-worker-50",
    };
    await publishCommissionReadModelForJob({
      artifact,
      job,
      actorEmail: "worker@example.test",
    }, transaction);
    const persistedRun = (await db.query<{ run_id: string; revision: number }>(`
      select r.id::text as run_id, r.revision
        from metrics.commission_periods p
        join metrics.commission_calculation_runs r on r.id = p.current_run_id
       where p.id = 1
    `)).rows[0];
    assert.equal(persistedRun.revision, 1);
    const manifestCount = await db.query<{ count: number }>("select count(*)::integer as count from metrics.commission_run_inputs where run_id=$1", [persistedRun.run_id]);
    assert.equal(manifestCount.rows[0].count, artifact.manifest.length);
    const publication = await db.query<{ queue_status: string; dashboard_job_id: string; current_run_id: string }>(`
      select q.status::text as queue_status,
             dashboard.rebuilt_by_job_id::text as dashboard_job_id,
             period.current_run_id::text
        from metrics.rollup_rebuild_queue q
        join metrics.dashboard_read_models dashboard on dashboard.rebuilt_by_job_id = q.id
        join metrics.commission_periods period on period.period_start = q.period_start
       where q.id = 50
    `);
    assert.deepEqual(publication.rows[0], {
      queue_status: "succeeded",
      dashboard_job_id: "50",
      current_run_id: persistedRun.run_id,
    });

    const reviewed = await transitionCommissionPeriod({
      periodStart: "2026-06-01", expectedRevision: 2, action: "review",
      reason: "Reviewed all immutable payout evidence.", actorEmail: "finance@example.test",
    }, query);
    assert.equal(reviewed.status, "reviewed");
    assert.equal(reviewed.editRevision, 3);

    const run = await getCurrentCommissionRunForExport("2026-06-01", query);
    assert.ok(run);
    const exported = await createOrGetCommissionExport({
      run, expectedRevision: 3, exportType: "payroll_csv", actorEmail: "finance@example.test",
    }, query);
    assert.equal(exported.periodStatus, "exported");
    assert.equal(exported.editRevision, 4);
    const retryRun = await getCurrentCommissionRunForExport("2026-06-01", query);
    assert.ok(retryRun);
    const retry = await createOrGetCommissionExport({
      run: retryRun, expectedRevision: 4, exportType: "payroll_csv", actorEmail: "finance@example.test",
    }, query);
    assert.equal(retry.export.id, exported.export.id);
    assert.equal(retry.idempotent, true);
    const download = await downloadCommissionExport({ exportId: exported.export.id, actorEmail: "finance@example.test" }, query);
    assert.equal(download.export.downloadCount, 1);
    assert.deepEqual(download.bytes, exported.bytes);

    const locked = await transitionCommissionPeriod({
      periodStart: "2026-06-01", expectedRevision: 4, action: "lock",
      reason: "Locked after approved payroll export.", actorEmail: "finance@example.test",
    }, query);
    assert.equal(locked.status, "locked");
    assert.equal(locked.editRevision, 5);

    const revised = await persistCommissionOverride({
      periodStart: "2026-06-01", expectedRevision: 5,
      override: parseCommissionOverride({ employeeId: 10, field: "outside_pool_adjustment", value: 25, reason: "Approved later payroll correction." }),
      actorEmail: "finance@example.test",
    }, query);
    assert.equal(revised.period.revision, 2);
    assert.equal(revised.period.status, "draft");
    assert.equal(revised.period.forkedFromRevision, 1);
    const inheritedConfig = await db.query<{
      period_id: number;
      revision: number;
      config_revision: number;
      config_hash: string;
      actor_email: string;
      active: boolean;
      matches_source: boolean;
    }>(`
      select c.period_id::integer, c.revision, p.config_revision, c.config_hash,
             c.actor_email, c.active,
             c.config_hash = (
               select source.config_hash
                 from metrics.commission_period_configs source
                where source.period_id = p.supersedes_period_id
                  and source.revision = p.config_revision
                  and source.active
             ) as matches_source
        from metrics.commission_periods p
        join metrics.commission_period_configs c
          on c.period_id = p.id
         and c.revision = p.config_revision
         and c.active
       where p.id = $1
    `, [revised.period.periodId]);
    assert.equal(inheritedConfig.rows.length, 1);
    assert.deepEqual(
      { ...inheritedConfig.rows[0], config_hash: "<verified>" },
      {
        period_id: revised.period.periodId,
        revision: 2,
        config_revision: 2,
        config_hash: "<verified>",
        actor_email: "admin@example.test",
        active: true,
        matches_source: true,
      },
    );
    assert.match(inheritedConfig.rows[0].config_hash, /^[0-9a-f]{64}$/);
    const protectedRevision = await db.query<{ status: string; export_count: number; source_changed: boolean }>(`
      select p.status::text, count(e.id)::integer as export_count
             ,bool_or(n.source_changed_after_export) as source_changed
        from metrics.commission_periods p
        left join metrics.commission_periods n on n.supersedes_period_id=p.id
        left join metrics.commission_calculation_runs r on r.period_id=p.id
        left join metrics.commission_exports e on e.calculation_run_id=r.id
       where p.id=1 group by p.id
    `);
    assert.deepEqual(protectedRevision.rows[0], { status: "locked", export_count: 1, source_changed: true });
  } finally {
    await db.close();
  }
});

test("lease expiry or replacement at every commission publication boundary rolls back all writes", async (t) => {
  for (const boundary of ["before-run", "before-dashboard", "before-completion"] as const) {
    for (const leaseFailure of ["expiry", "replacement"] as const) {
      await t.test(`${boundary}:${leaseFailure}`, async () => {
        const fixture = await commissionPublicationFixture();
        try {
          const transaction = adversarialPublicationTransaction(fixture, { boundary, leaseFailure });
          await assert.rejects(
            publishCommissionReadModelForJob({
              job: fixture.job,
              artifact: fixture.artifact,
              actorEmail: "worker@example.test",
            }, transaction),
            /lost rollup lease/i,
          );
          await assertNoCommissionPublicationWrites(fixture.db);
        } finally {
          await fixture.db.close();
        }
      });
    }
  }
});

test("dashboard or completion failure rolls back commission run, current assignment, dashboard, and queue writes", async (t) => {
  for (const failureBoundary of ["dashboard", "completion"] as const) {
    await t.test(failureBoundary, async () => {
      const fixture = await commissionPublicationFixture();
      try {
        const transaction = adversarialPublicationTransaction(fixture, { failureBoundary });
        await assert.rejects(
          publishCommissionReadModelForJob({
            job: fixture.job,
            artifact: fixture.artifact,
            actorEmail: "worker@example.test",
          }, transaction),
          new RegExp(`forced ${failureBoundary} failure`, "i"),
        );
        await assertNoCommissionPublicationWrites(fixture.db);
      } finally {
        await fixture.db.close();
      }
    });
  }
});

test("commission publication rejects mismatched queue scope before opening a transaction", async () => {
  const fixture = await commissionPublicationFixture();
  let transactionOpened = false;
  try {
    await assert.rejects(
      publishCommissionReadModelForJob({
        job: { ...fixture.job, dimensions_json: { forged: true } },
        artifact: fixture.artifact,
        actorEmail: "worker@example.test",
      }, async () => {
        transactionOpened = true;
        throw new Error("transaction should not open");
      }),
      /scope does not exactly match/i,
    );
    assert.equal(transactionOpened, false);
    await assertNoCommissionPublicationWrites(fixture.db);
  } finally {
    await fixture.db.close();
  }
});

test("manual rebuild fork resolves inherited config evidence on the new period", async () => {
  const db = new PGlite();
  const query: CommissionQuery = async <T>(sql: string, values: unknown[] = []) => {
    const result = await db.query(sql, values);
    return { rows: result.rows as T[], rowCount: result.rows.length };
  };
  try {
    const directory = new URL("../../infra/db/migrations/", import.meta.url);
    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".sql") && file <= "015_commission_manifest_evidence.sql")
      .sort();
    for (const file of files) await db.exec(await readFile(new URL(file, directory), "utf8"));
    const config = { poolPercent: 0.5, minBonusPercent: 5, efficiencyEnabled: false, maxEfficiencyAdjustmentPercent: 20 };
    const configHash = "a".repeat(64);
    await db.query(`
      insert into metrics.commission_periods (
        id, period_start, period_end, status, config, source_watermarks, override_hash,
        revision, edit_revision, config_revision, created_by, calculation_stale
      ) values (10, '2026-05-01', '2026-05-31', 'locked', $1, '{}', 'empty', 1, 5, 3, 'seed', false)
    `, [JSON.stringify(config)]);
    await db.query(`
      insert into metrics.commission_period_configs (
        period_id, revision, pool_pct, min_bonus_pct, efficiency_enabled,
        max_efficiency_adjustment_pct, config_json, config_hash, actor_email
      ) values (10, 3, 0.5, 5, false, 20, $1, $2, 'evidence@example.test')
    `, [JSON.stringify(config), configHash]);
    await db.exec("select setval('metrics.commission_periods_id_seq', 10, true)");

    const forked = await queueCommissionRebuild({
      periodStart: "2026-05-01",
      expectedRevision: 5,
      reason: "Manual rebuild with inherited configuration evidence.",
      actorEmail: "finance@example.test",
    }, query);
    const resolved = await db.query<{
      period_id: number;
      revision: number;
      config_revision: number;
      config_hash: string;
      actor_email: string;
      active: boolean;
      source_status: string;
      source_config_active: boolean;
    }>(`
      select p.id::integer as period_id, p.revision, p.config_revision,
             c.config_hash, c.actor_email, c.active,
             source.status::text as source_status,
             source_config.active as source_config_active
        from metrics.commission_periods p
        join metrics.commission_period_configs c
          on c.period_id = p.id and c.revision = p.config_revision and c.active
        join metrics.commission_periods source on source.id = p.supersedes_period_id
        join metrics.commission_period_configs source_config
          on source_config.period_id = source.id
         and source_config.revision = source.config_revision
       where p.id = $1
    `, [forked.periodId]);

    assert.deepEqual(resolved.rows, [{
      period_id: forked.periodId,
      revision: 2,
      config_revision: 3,
      config_hash: configHash,
      actor_email: "evidence@example.test",
      active: true,
      source_status: "locked",
      source_config_active: true,
    }]);
  } finally {
    await db.close();
  }
});

async function commissionPublicationFixture() {
  const db = new PGlite();
  const query: CommissionQuery = async <T>(sql: string, values: unknown[] = []) => {
    const result = await db.query(sql, values);
    return { rows: result.rows as T[], rowCount: result.affectedRows ?? result.rows.length };
  };
  const directory = new URL("../../infra/db/migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql") && file <= "015_commission_manifest_evidence.sql")
    .sort();
  for (const file of files) await db.exec(await readFile(new URL(file, directory), "utf8"));

  const config = {
    poolPercent: 0.5,
    minBonusPercent: 6,
    efficiencyEnabled: false,
    maxEfficiencyAdjustmentPercent: 20,
    tierMultipliers: { Gold: 1.3, Silver: 1.2, Bronze: 1.1, Standard: 1 },
  };
  const configHash = commissionHashJson(config);
  await db.query(`
    insert into metrics.commission_periods (
      id, period_start, period_end, status, config, source_watermarks, override_hash,
      revision, edit_revision, config_revision, created_by, calculation_stale
    ) values (1, '2026-06-01', '2026-06-30', 'draft', $1, '{}', 'empty', 1, 2, 2, 'seed', true)
  `, [JSON.stringify(config)]);
  await db.query(`
    insert into metrics.commission_period_configs (
      period_id, revision, pool_pct, min_bonus_pct, efficiency_enabled,
      max_efficiency_adjustment_pct, config_json, config_hash, actor_email
    ) values (1, 2, 0.5, 6, false, 20, $1, $2, 'admin@example.test')
  `, [JSON.stringify(config), configHash]);
  await db.exec(`
    insert into metrics.rollup_rebuild_queue (
      id, metric_family, period_grain, period_start, dimensions_json, reason,
      idempotency_key, status, locked_by, locked_until
    ) values (
      50, 'commissions', 'month', '2026-06-01', '{}', 'lease adversary test',
      'commission-publication-adversary:50', 'running', 'commission-owner', now() + interval '10 minutes'
    )
  `);
  const configSource = (await db.query<Record<string, unknown>>(`
    select period_id::text, revision, pool_pct::text, min_bonus_pct::text,
           efficiency_enabled, max_efficiency_adjustment_pct::text,
           config_json, config_hash, actor_email, active, created_at::text
      from metrics.commission_period_configs where period_id = 1 and revision = 2
  `)).rows[0];
  const artifact = calculationArtifact(config, configSource);
  const job: RollupRebuildJob = {
    id: 50,
    metric_family: "commissions",
    period_grain: "month",
    period_start: "2026-06-01",
    dimensions_json: {},
    locked_by: "commission-owner",
  };
  return { db, query, artifact, job };
}

function adversarialPublicationTransaction(
  fixture: Awaited<ReturnType<typeof commissionPublicationFixture>>,
  options: {
    boundary?: "before-run" | "before-dashboard" | "before-completion";
    leaseFailure?: "expiry" | "replacement";
    failureBoundary?: "dashboard" | "completion";
  },
) {
  return async <T>(callback: (transactionQuery: CommissionQuery) => Promise<T>) => {
    await fixture.db.exec("begin");
    const loseLease = async () => {
      if (options.leaseFailure === "expiry") {
        await fixture.db.exec("update metrics.rollup_rebuild_queue set locked_until = clock_timestamp() - interval '1 second' where id = 50");
      } else {
        await fixture.db.exec("update metrics.rollup_rebuild_queue set locked_by = 'replacement-owner', locked_until = clock_timestamp() + interval '10 minutes' where id = 50");
      }
    };
    try {
      if (options.boundary === "before-run") await loseLease();
      const transactionQuery: CommissionQuery = async <R>(sql: string, values: unknown[] = []) => {
        if (options.failureBoundary === "dashboard" && sql.includes("insert into metrics.dashboard_read_models")) {
          throw new Error("forced dashboard failure");
        }
        if (options.failureBoundary === "completion" && sql.includes("with completed as")) {
          throw new Error("forced completion failure");
        }
        const result = await fixture.query<R>(sql, values);
        const finalRunLeaseProbe = sql.trimStart().startsWith("select id::text")
          && sql.includes("and metric_family = 'commissions'")
          && !sql.includes("for update");
        if (options.boundary === "before-dashboard" && finalRunLeaseProbe) await loseLease();
        if (options.boundary === "before-completion" && sql.includes("insert into metrics.dashboard_read_models")) await loseLease();
        return result;
      };
      const result = await callback(transactionQuery);
      await fixture.db.exec("commit");
      return result;
    } catch (error) {
      await fixture.db.exec("rollback");
      throw error;
    }
  };
}

async function assertNoCommissionPublicationWrites(db: PGlite) {
  const state = await db.query<{
    runs: number;
    inputs: number;
    employees: number;
    allocations: number;
    audits: number;
    dashboards: number;
    current_run_id: string | null;
    queue_status: string;
    queue_owner: string | null;
  }>(`
    select
      (select count(*)::int from metrics.commission_calculation_runs) as runs,
      (select count(*)::int from metrics.commission_run_inputs) as inputs,
      (select count(*)::int from metrics.commission_employee_results) as employees,
      (select count(*)::int from metrics.commission_job_allocations) as allocations,
      (select count(*)::int from metrics.audit_events where action = 'commission_run_created') as audits,
      (select count(*)::int from metrics.dashboard_read_models) as dashboards,
      (select current_run_id::text from metrics.commission_periods where id = 1) as current_run_id,
      (select status::text from metrics.rollup_rebuild_queue where id = 50) as queue_status,
      (select locked_by from metrics.rollup_rebuild_queue where id = 50) as queue_owner
  `);
  assert.deepEqual(state.rows[0], {
    runs: 0,
    inputs: 0,
    employees: 0,
    allocations: 0,
    audits: 0,
    dashboards: 0,
    current_run_id: null,
    queue_status: "running",
    queue_owner: "commission-owner",
  });
}

function calculationArtifact(
  config: CommissionRebuildArtifact["config"],
  configSource: Record<string, unknown>,
): CommissionRebuildArtifact {
  const override = {
    period_id: "1", employee_id: "10", field_name: "notes", before_value: null,
    after_value: "Reviewed source note", value_type: "string", reason: "Document source evidence.",
    evidence_url: null, actor_email: "admin@example.test", pool_treatment: "neutral",
    revision: 1, id: "1", active: true, created_at: "2026-07-01T00:00:00Z", lineage_depth: 0,
  };
  const readModel = buildCommissionReadModel({
    periodStart: "2026-06-01", periodEnd: "2026-06-30", config,
    roster: [{ employeeId: "10", displayName: "Alex Rivera", included: true }],
    jobs: [{
      jobId: "100", completedDate: "2026-06-10", stageName: "Complete",
      sellValue: 100_000, quoteId: null, quotedHours: null,
      timesheets: [{ employeeId: "10", hours: 10, mapped: true, fieldTechnician: true }],
    }],
    overrides: [{ employeeId: "10", field: "notes", value: "Reviewed source note", reason: "Document source evidence.", poolTreatment: "neutral" }],
  });
  const inputRows: CommissionHashManifestEntry[] = [
    manifestInput("job", "100", {
      jobId: "100", completedDate: "2026-06-10", stageName: "Complete",
      sellValue: 100_000, quoteId: null, quotedHours: null,
    }),
    manifestInput("timesheet", "10:1", {
      jobId: "100", timesheetId: "1", employeeId: "10", hours: 10,
      mapped: true, fieldTechnician: true,
    }),
    manifestInput("override", "1", override),
  ];
  return commissionArtifactFromServingRow(buildCommissionServingRow({
    readModel, inputRows, configSource,
    overrides: {
      period_id: "1", revision: 1, edit_revision: 2,
      period_config_revision: 2, run_config_revision: 2,
      status: "draft", current_run_id: "1", run_id: "1",
      period_watermarks: { jobs: { status: "current" } },
      run_watermarks: { jobs: { status: "current" } },
    },
  }));
}

function manifestInput(inputType: string, sourceIdentity: string, value: unknown): CommissionHashManifestEntry {
  return { inputType, sourceIdentity, sourceVersion: `v:${sourceIdentity}`, sourceHash: commissionHashJson(value), input: value };
}

function pgliteTransaction(db: PGlite, query: CommissionQuery) {
  return async <T>(callback: (transactionQuery: CommissionQuery) => Promise<T>) => {
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

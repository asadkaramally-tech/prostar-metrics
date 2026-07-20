import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);

test("commission migration applies clean and remains twice-safe", async () => {
  const db = new PGlite();
  try {
    const migrations = await loadMigrations();
    for (const migration of migrations) await db.exec(migration.sql);
    for (const migration of migrations.filter((entry) => entry.name >= "004_metrics_canonical_contract.sql")) await db.exec(migration.sql);
    const result = await db.query<{ edit_revision: boolean; content_bytes: boolean; immutable_trigger: boolean }>(`
      select
        exists(select 1 from information_schema.columns where table_schema='metrics' and table_name='commission_periods' and column_name='edit_revision') as edit_revision,
        exists(select 1 from information_schema.columns where table_schema='metrics' and table_name='commission_exports' and column_name='content_bytes') as content_bytes,
        exists(select 1 from pg_trigger where tgname='commission_runs_immutable') as immutable_trigger
    `);
    assert.deepEqual(result.rows[0], { edit_revision: true, content_bytes: true, immutable_trigger: true });
  } finally {
    await db.close();
  }
});

test("commission migration upgrades legacy revisions, supersedes active rows, and protects history", async () => {
  const db = new PGlite();
  try {
    const migrations = await loadMigrations();
    for (const migration of migrations.filter((entry) => entry.name < "008_commission_lifecycle.sql")) await db.exec(migration.sql);
    await db.exec(`
      insert into metrics.commission_periods (
        id, period_start, period_end, status, config, source_watermarks, override_hash, revision, created_by
      ) values (
        700, '2026-06-01', '2026-06-30', 'exported',
        '{"poolPercent":0.5,"minBonusPercent":5,"efficiencyEnabled":false,"maxEfficiencyAdjustmentPercent":20}',
        '{}', 'legacy-overrides', 1, 'legacy-worker'
      );
      insert into metrics.commission_period_configs (
        period_id, revision, pool_pct, min_bonus_pct, efficiency_enabled,
        max_efficiency_adjustment_pct, config_json, config_hash, actor_email
      ) values
        (700, 1, 0.5, 5, false, 20, '{}', 'config-1', 'admin@example.test'),
        (700, 2, 0.55, 5, true, 25, '{}', 'config-2', 'admin@example.test');
      insert into metrics.commission_overrides (
        period_id, employee_id, field_name, before_value, after_value, reason,
        actor_email, pool_treatment, revision
      ) values
        (700, 10, 'final_bonus', '100', '110', 'First approved value.', 'admin@example.test', 'included', 1),
        (700, 10, 'final_bonus', '110', '120', 'Revised approved value.', 'admin@example.test', 'included', 2),
        (700, 20, 'outside_pool_adjustment', '0', '25', 'Payroll correction.', 'admin@example.test', 'excluded', 1);
      insert into metrics.commission_calculation_runs (
        id, period_id, config, source_watermarks, override_hash, employee_results,
        job_allocations, calculation_hash, created_by, immutable, revision
      ) values (900, 700, '{}', '{}', 'legacy-overrides', '[]', '[]', 'legacy-run', 'legacy-worker', true, 1);
    `);
    const migration = migrations.find((entry) => entry.name === "008_commission_lifecycle.sql");
    assert.ok(migration);
    await db.exec(migration.sql);

    const configs = await db.query<{ revision: number; active: boolean }>("select revision, active from metrics.commission_period_configs where period_id=700 order by revision");
    assert.deepEqual(configs.rows, [{ revision: 1, active: false }, { revision: 2, active: true }]);
    const overrides = await db.query<{ revision: number; active: boolean; pool_treatment: string }>("select revision, active, pool_treatment from metrics.commission_overrides where period_id=700 order by employee_id, revision");
    assert.deepEqual(overrides.rows, [
      { revision: 1, active: false, pool_treatment: "inside_pool" },
      { revision: 2, active: true, pool_treatment: "inside_pool" },
      { revision: 1, active: true, pool_treatment: "outside_pool" },
    ]);
    await assert.rejects(db.exec("update metrics.commission_calculation_runs set calculation_hash='changed' where id=900"), /immutable/);
    await assert.rejects(db.exec("update metrics.commission_periods set config='{}' where id=700"), /require a new draft revision/);
    await db.exec(migration.sql);
  } finally {
    await db.close();
  }
});

async function loadMigrations() {
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  return Promise.all(files.map(async (name) => ({ name, sql: await readFile(new URL(name, migrationDirectory), "utf8") })));
}

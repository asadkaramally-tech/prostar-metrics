import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../../infra/db/migrations/019_seed_verified_commission_period_configs.sql", import.meta.url),
  "utf8",
);
const queueMigration = readFileSync(
  new URL("../../infra/db/migrations/020_queue_verified_commission_config_rebuilds.sql", import.meta.url),
  "utf8",
);
const tierUpgradeMigration = readFileSync(
  new URL("../../infra/db/migrations/025_upgrade_verified_commission_tier_config.sql", import.meta.url),
  "utf8",
);

test("historical commission config seed is tied to locked prior-dashboard evidence", () => {
  assert.match(migration, /period_start >= date '2023-01-01'/);
  assert.match(migration, /pool_pct.*min_bonus_pct.*efficiency_enabled/s);
  assert.match(migration, /0\.50, 5\.00, false, 20\.00/);
  assert.match(migration, /5966f042954aea4d9e8d7499655b76f7d4df9748693972cd386a8a7fb6735553/);
  assert.match(migration, /037b1f6e0e5b7a4156a8eee8180307e92dfc3f0f17b8f19b5ea7011f2852538b/);
  assert.match(migration, /commission_period_config_evidence_seeded/);
  assert.match(migration, /refusing historical config evidence seed/);
});

test("verified config evidence queues incomplete commission periods idempotently", () => {
  assert.match(queueMigration, /not r\.source_complete/);
  assert.match(queueMigration, /metric_family, period_grain, period_start/);
  assert.match(queueMigration, /verified-config-evidence:019/);
  assert.match(queueMigration, /where not exists/);
  assert.match(queueMigration, /commission_config_evidence_rebuild_queued/);
});

test("legacy verified config is upgraded with tier multipliers and recalculated", () => {
  assert.match(tierUpgradeMigration, /actor_email = 'system:migration-019'/);
  assert.match(tierUpgradeMigration, /config_hash = '5966f042954aea4d9e8d7499655b76f7d4df9748693972cd386a8a7fb6735553'/);
  assert.match(tierUpgradeMigration, /'tierMultipliers'/);
  assert.match(tierUpgradeMigration, /'Gold', 1\.3/);
  assert.match(tierUpgradeMigration, /'Silver', 1\.2/);
  assert.match(tierUpgradeMigration, /'Bronze', 1\.1/);
  assert.match(tierUpgradeMigration, /'Standard', 1/);
  assert.match(tierUpgradeMigration, /set active = false/);
  assert.match(tierUpgradeMigration, /old\.revision \+ 1/);
  assert.match(tierUpgradeMigration, /actor_email, active, idempotency_key/);
  assert.match(tierUpgradeMigration, /config_revision = u\.revision/);
  assert.match(tierUpgradeMigration, /calculation_stale = true/);
  assert.match(tierUpgradeMigration, /verified-tier-config:025/);
  assert.match(tierUpgradeMigration, /commission_tier_config_upgraded/);
});

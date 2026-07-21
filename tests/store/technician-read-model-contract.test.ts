import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  assertCurrentTechnicianReadModel,
  assertServeableTechnicianReadModel,
  technicianReadModelContractStatus,
} from "../../src/lib/store/technician-read-model-contract";

const structurallyComplete = {
  netProfitBasis: "simpro_job_net_profit_actual",
  rosterApplied: true,
  outsideRoster: [],
  technicians: [],
  coverage: {},
};

test("current technician payloads require the explicit schema and verified roster fields", () => {
  const payload = { ...structurallyComplete, schemaVersion: 1 };
  assert.deepEqual(technicianReadModelContractStatus(payload), { current: true, serveable: true });
  assert.equal(assertCurrentTechnicianReadModel(payload, "technicians/2026-07-01"), payload);
  assert.doesNotThrow(() => assertServeableTechnicianReadModel(payload, "technicians/2026-07-01"));
});

test("versionless but structurally complete models remain readable only during the queued upgrade", () => {
  const status = technicianReadModelContractStatus(structurallyComplete);
  assert.equal(status.current, false);
  assert.equal(status.serveable, true);
  assert.match(status.current ? "" : status.reason, /schemaVersion missing is not 1/);
  assert.throws(
    () => assertCurrentTechnicianReadModel(structurallyComplete, "technicians/2026-04-01"),
    /Stale technician read model.*schemaVersion missing is not 1/,
  );
  assert.doesNotThrow(() =>
    assertServeableTechnicianReadModel(structurallyComplete, "technicians/2026-04-01"),
  );
});

test("legacy models missing roster evidence are rejected instead of synthesized", () => {
  const legacy = {
    netProfitBasis: "simpro_job_net_profit_actual",
    technicians: [{ employeeId: "253" }],
    coverage: {},
  };
  const status = technicianReadModelContractStatus(legacy);
  assert.equal(status.current, false);
  assert.equal(status.serveable, false);
  assert.match(status.current ? "" : status.reason, /rosterApplied is missing or invalid/);
  assert.throws(
    () => assertServeableTechnicianReadModel(legacy, "technicians/2026-02-01"),
    /Rebuild this month before serving it/,
  );
  assert.equal("outsideRoster" in legacy, false);
  assert.equal("rosterApplied" in legacy, false);
});

test("migration 048 queues every active served technician month without the current contract", () => {
  const migration = readFileSync(
    path.join(process.cwd(), "infra/db/migrations/048_rebuild_legacy_technician_read_models.sql"),
    "utf8",
  );
  for (const required of [
    "schemaVersion",
    "netProfitBasis",
    "rosterApplied",
    "outsideRoster",
    "technicians",
    "coverage",
  ]) assert.match(migration, new RegExp(required));
  assert.match(migration, /model\.period_start >= date '2023-01-01'/);
  assert.match(migration, /date_trunc\('month', current_timestamp at time zone 'America\/Los_Angeles'\)/);
  assert.match(migration, /model\.status = 'ready'/);
  assert.match(migration, /model\.superseded_at is null/);
  assert.match(migration, /migration-048:technicians:month:/);
  assert.match(migration, /now\(\) \+ interval '2 hours'/);
  assert.doesNotMatch(migration, /update\s+metrics\.dashboard_read_models|delete\s+from\s+metrics\.dashboard_read_models/i);
});

test("migration 048 is idempotent and leaves current, superseded, and out-of-window models alone", async () => {
  const db = new PGlite();
  await db.exec(`
    create schema metrics;
    create type metrics.rollup_rebuild_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
    create table metrics.dashboard_read_models (
      metric_family text not null,
      period_grain text not null,
      period_start date not null,
      status text not null,
      values_json jsonb not null,
      superseded_at timestamptz
    );
    create table metrics.rollup_rebuild_queue (
      metric_family text not null,
      period_grain text not null,
      period_start date not null,
      dimensions_json jsonb not null default '{}'::jsonb,
      reason text not null,
      idempotency_key text not null unique,
      status metrics.rollup_rebuild_status not null default 'queued',
      attempts integer not null default 0,
      locked_by text,
      locked_until timestamptz,
      finished_at timestamptz,
      error_message text
    );
  `);
  const current = JSON.stringify({ ...structurallyComplete, schemaVersion: 1 });
  const compatibleLegacy = JSON.stringify(structurallyComplete);
  const unsafeLegacy = JSON.stringify({
    netProfitBasis: "simpro_job_net_profit_actual",
    technicians: [],
    coverage: {},
  });
  await db.query(
    `insert into metrics.dashboard_read_models values
       ('technicians', 'month', '2023-01-01', 'ready', $1::jsonb, null),
       ('technicians', 'month', '2026-03-01', 'ready', $2::jsonb, null),
       ('technicians', 'month', '2026-04-01', 'ready', $3::jsonb, null),
       ('technicians', 'month', '2026-02-01', 'ready', $2::jsonb, now()),
       ('technicians', 'month', '2022-12-01', 'ready', $2::jsonb, null),
       ('technicians', 'month', '2099-01-01', 'ready', $2::jsonb, null)`,
    [unsafeLegacy, compatibleLegacy, current],
  );
  const migration = readFileSync(
    path.join(process.cwd(), "infra/db/migrations/048_rebuild_legacy_technician_read_models.sql"),
    "utf8",
  );
  await db.exec(migration);
  await db.exec(migration);
  const result = await db.query<{ period_start: string }>(
    "select period_start::text from metrics.rollup_rebuild_queue order by period_start",
  );
  assert.deepEqual(result.rows, [
    { period_start: "2023-01-01" },
    { period_start: "2026-03-01" },
  ]);
  await db.close();
});

test("technician publication and reads enforce the versioned contract", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/store/read-model-rebuilds.ts"), "utf8");
  assert.match(source, /assertCurrentTechnicianReadModel\(payload, `\$\{job\.metric_family\}\/\$\{job\.period_start\}`\)/);
  assert.match(source, /assertServeableTechnicianReadModel\(row\.values_json, `\$\{scope\}\/\$\{row\.period_start\}`\)/);
});

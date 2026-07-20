import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  importVerifiedOperationalArtifact,
  verifyOperationalBulkArtifact,
  type OperationalBootstrapManifest,
} from "../../src/lib/store/bulk-operational-bootstrap";

test("operational artifact verifies every checksum and exact identity set", async () => {
  const directory = await fixtureArtifact();
  try {
    const artifact = await verifyOperationalBulkArtifact(directory);
    assert.equal(artifact.manifest.requestsUsed, 5);
    assert.deepEqual(artifact.manifest.sources.map((source) => source.rowCount), [1, 1, 1, 1]);
    assert.match(artifact.manifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(artifact), true);
    assert.equal(Object.isFrozen(artifact.sources.employees.rows), true);
    assert.equal(Object.isFrozen(artifact.sources.employees.rows[0]), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("operational artifact rejects a post-manifest file mutation", async () => {
  const directory = await fixtureArtifact();
  try {
    await writeFile(path.join(directory, "employees.jsonl"), `${JSON.stringify({ ID: 99 })}\n`, "utf8");
    await assert.rejects(() => verifyOperationalBulkArtifact(directory), /artifact checksum mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("coordinated operational source mutation cannot change verified or imported rows", async () => {
  const directory = await fixtureArtifact();
  const db = new PGlite();
  try {
    let mutated = false;
    const artifact = await verifyOperationalBulkArtifact(directory, {
      afterSourceBytesRead: async ({ family, filePath }) => {
        if (family !== "employees" || mutated) return;
        mutated = true;
        await writeFile(filePath, `${JSON.stringify({ ID: 99, Name: "Mutated" })}\n`, "utf8");
      },
    });
    assert.equal(mutated, true);
    assert.equal(artifact.sources.employees.rows[0]?.ID, 1);

    await migrate(db);
    await importVerifiedOperationalArtifact({ query: pgliteQuery(db) }, artifact);
    const employees = await db.query<{ employee_id: number }>(
      "select employee_id::int employee_id from metrics.employee_snapshots order by employee_id",
    );
    assert.deepEqual(employees.rows, [{ employee_id: 1 }]);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("operational import is atomic, idempotent, and preserves commission configuration", async () => {
  const directory = await fixtureArtifact();
  const db = new PGlite();
  try {
    await migrate(db);
    const artifact = await verifyOperationalBulkArtifact(directory);
    const query = { query: pgliteQuery(db) };
    const first = await importVerifiedOperationalArtifact(query, artifact);
    assert.deepEqual(first.imported, {
      employees: 1,
      timesheets: 1,
      schedules: 1,
      mobile_status: 1,
    });

    await db.exec(`
      insert into metrics.commission_roster (
        employee_id, display_name, included, tier, effective_start
      ) values (1, 'Alex Tech', false, 'standard', '2023-01-01');
      insert into metrics.metrics_employee_timesheets (
        timesheet_id, employee_id, work_date, total_hours, source_deleted_at
      ) values ('absent', 1, '2026-07-09', 1, null);
    `);
    const second = await importVerifiedOperationalArtifact(query, artifact);
    assert.equal(second.tombstoned.timesheets, 1);

    const facts = await db.query<{
      employees: number;
      timesheets: number;
      schedules: number;
      blocks: number;
      mobile: number;
      roster_included: boolean;
      absent_deleted: boolean;
    }>(`
      select
        (select count(*)::int from metrics.employee_snapshots) employees,
        (select count(*)::int from metrics.metrics_employee_timesheets where source_deleted_at is null) timesheets,
        (select count(*)::int from metrics.metrics_schedules where source_deleted_at is null) schedules,
        (select count(*)::int from metrics.metrics_schedule_blocks where source_deleted_at is null) blocks,
        (select count(*)::int from metrics.metrics_mobile_status_logs) mobile,
        (select included from metrics.commission_roster where employee_id = 1) roster_included,
        (select source_deleted_at is not null from metrics.metrics_employee_timesheets where timesheet_id = 'absent') absent_deleted
    `);
    assert.deepEqual(facts.rows[0], {
      employees: 1,
      timesheets: 1,
      schedules: 1,
      blocks: 1,
      mobile: 1,
      roster_included: false,
      absent_deleted: true,
    });

    const failedDb = new PGlite();
    try {
      await migrate(failedDb);
      const baseQuery = pgliteQuery(failedDb);
      await assert.rejects(
        () => importVerifiedOperationalArtifact({
          query: async <T = Record<string, unknown>>(sql: string, values?: unknown[]) => {
            if (sql.includes("insert into metrics.metrics_schedules")) throw new Error("injected failure");
            return baseQuery<T>(sql, values);
          },
        }, artifact),
        /injected failure/,
      );
      const rolledBack = await failedDb.query<{ count: number }>("select count(*)::int count from metrics.employee_snapshots");
      assert.equal(rolledBack.rows[0]?.count, 0);
    } finally {
      await failedDb.close();
    }
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixtureArtifact() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prostar-operational-bootstrap-"));
  const completedAt = "2026-07-10T18:30:00.000Z";
  const employee = {
    ID: 1,
    Name: "Alex Tech",
    Position: "Technician",
    PrimaryContact: { Email: "alex@example.com" },
    DateCreated: "2022-01-01T08:00:00-08:00",
    DateModified: "2026-07-09T08:00:00-07:00",
    Archived: false,
  };
  const timesheet = {
    EmployeeID: 1,
    UID: "ts-1",
    ScheduleType: "Job",
    Reference: "10-20",
    _href: "/api/v1.0/companies/0/jobs/10/sections/11/costCenters/20",
    Date: "2026-07-09",
    StartTime: "08:00",
    EndTime: "10:00",
    TotalHrs: 2,
    TotalCost: 100,
  };
  const schedule = {
    ID: 30,
    Type: "Job",
    Reference: "10-20",
    Project: { ProjectID: 10, SectionID: 11, CostCenterID: 20 },
    Staff: { ID: 1, Name: "Alex Tech", Type: "employee", TypeId: 1 },
    Date: "2026-07-09",
    TotalHours: 2,
    Blocks: [{
      Hrs: 2,
      StartTime: "08:00",
      EndTime: "10:00",
      ISO8601StartTime: "2026-07-09T08:00:00-07:00",
      ISO8601EndTime: "2026-07-09T10:00:00-07:00",
    }],
  };
  const mobile = {
    ID: 40,
    Staff: { ID: 1, Name: "Alex Tech", Type: "employee", TypeId: 1 },
    WorkOrder: { ID: 50, Type: "Job", ProjectID: 10, CostCenterID: 20 },
    Status: { ID: 2, Name: "Complete" },
    DateLogged: "2026-07-09T10:00:00-07:00",
  };
  const payloads: Array<[string, Record<string, unknown>[], Array<number | string>, number]> = [
    ["employees", [employee], [1], 2],
    ["timesheets", [timesheet], ["1:ts-1"], 1],
    ["schedules", [schedule], [30], 1],
    ["mobile_status", [mobile], [40], 1],
  ];
  const sources: OperationalBootstrapManifest["sources"] = [];
  for (const [family, rows, exactIds, requestCount] of payloads) {
    const file = `${family}.jsonl`;
    const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(path.join(directory, file), text, "utf8");
    const source: OperationalBootstrapManifest["sources"][number] = {
      family: family as OperationalBootstrapManifest["sources"][number]["family"],
      file,
      sha256: sha256(text),
      rowCount: rows.length,
      requestCount,
      exactIds,
    };
    if (family === "timesheets") {
      source.targetCount = 1;
      source.completedTargetCount = 1;
      source.perMonthIds = { "2026-07-01": ["1:ts-1"] };
    }
    sources.push(source);
  }
  const manifest: OperationalBootstrapManifest = {
    version: 1,
    source: "test",
    companyId: "0",
    startDate: "2023-01-01",
    asOfDate: "2026-07-10",
    timezone: "America/Los_Angeles",
    startedAt: "2026-07-10T18:00:00.000Z",
    completedAt,
    requestsUsed: 5,
    sources,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(directory, "manifest.json"), manifestText, "utf8");
  await writeFile(path.join(directory, "manifest.sha256"), `${sha256(manifestText)}  manifest.json\n`, "utf8");
  return directory;
}

async function migrate(db: PGlite) {
  const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);
  const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const migration of migrations) {
    await db.exec(await readFile(new URL(migration, migrationDirectory), "utf8"));
  }
}

function pgliteQuery(db: PGlite) {
  return async <T = Record<string, unknown>>(sql: string, values?: unknown[]) => {
    const result = await db.query<T>(sql, values ?? []);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

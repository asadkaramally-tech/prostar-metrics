import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  getCommissionSourceJobs,
  type CommissionSourceQuery,
} from "../../src/lib/store/technician-read-model-inputs";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);

test("commission source query snapshots individual source rows and classifies from in-period technician roster", async () => {
  const db = new PGlite();
  const query: CommissionSourceQuery = async <T>(sql: string, values: unknown[] = []) => {
    const result = await db.query(sql, values);
    return { rows: result.rows as T[] };
  };
  try {
    const files = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith(".sql") && (
        file <= "012_pacific_serving_window.sql"
        || ["023_canonical_job_source_quotes.sql", "026_simpro_profit_capacity_contract.sql", "039_effective_technician_roster.sql", "042_roster_from_recorded_work.sql"].includes(file)
      ))
      .sort();
    for (const file of files) await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
    await db.exec(`
      insert into metrics.dim_people (
        person_id, simpro_employee_id, display_name, role_type, active, position,
        source_modified_at, last_seen_at
      ) values
        (1, 10, 'Stale Excluded Tech', 'employee', true, 'Installer', '2026-05-01', '2026-07-01'),
        (2, 20, 'New Unseeded Tech', 'employee', true, 'Warehouse', '2026-05-01', '2026-07-01'),
        (3, 30, 'Office User With Work', 'employee', true, 'Dispatcher', '2026-05-01', '2026-07-01');
      insert into metrics.commission_roster (
        id, employee_id, display_name, included, effective_start, effective_end
      ) values (700, 10, 'Stale Excluded Tech', false, '2026-01-01', null);
      insert into metrics.metrics_quotes (quote_id, total, linked_job_id) values (50, 0, 100), (51, 0, 101);
      insert into metrics.metrics_jobs (
        job_id, job_no, name, completed_date, stage, total,
        converted_from_type, converted_from_id, source_hash, source_version,
        fetched_at, updated_from_source_at
      ) values (
        100, 'J-100', 'Archived job', '2026-06-15', 'Archived', 1200,
        'Quote', 50, 'job-hash', 'job-v4', '2026-07-01', '2026-07-01'
      ), (
        101, 'J-101', 'Linked quote job', '2026-06-16', 'Complete', 800,
        null, null, 'job-hash-2', 'job-v4', '2026-07-01', '2026-07-01'
      );
      insert into metrics.metrics_employee_timesheets (
        timesheet_id, employee_id, person_id, reference_type, reference_id,
        work_date, total_hours, source_hash, fetched_at, updated_from_source_at
      ) values
        ('ts-field-1', 10, 1, 'Job', 100, '2026-06-14', 1, 'ts-field-1-hash', '2026-07-01', '2026-07-01'),
        ('ts-field-2', 10, 1, 'Job', 100, '2026-06-14', 2, 'ts-field-2-hash', '2026-07-01', '2026-07-01'),
        ('ts-new-tech', 20, 2, 'Job', 100, '2026-06-14', 3, 'ts-new-tech-hash', '2026-07-01', '2026-07-01'),
        ('ts-office', 30, 3, 'Job', 100, '2026-06-14', 2, 'ts-office-hash', '2026-07-01', '2026-07-01');
      insert into metrics.metrics_quote_labor (
        quote_id, section_id, cost_center_id, labor_id, quantity_hours,
        source_hash, fetched_at
      ) values
        (50, 1, 2, 3, 6, 'labor-hash', '2026-07-01'),
        (51, 1, 2, 4, 4, 'labor-hash-2', '2026-07-01');
    `);

    const jobs = await getCommissionSourceJobs("2026-06-01", "2026-06-30", query);
    assert.equal(jobs.length, 2);
    const converted = jobs.find((job) => job.jobId === "100");
    const linked = jobs.find((job) => job.jobId === "101");
    assert.equal(converted?.stageName, "Archived");
    assert.equal(converted?.timesheets.length, 4);
    assert.deepEqual(converted?.timesheets.map((row) => row.timesheetId), ["ts-field-1", "ts-field-2", "ts-new-tech", "ts-office"]);
    assert.equal(converted?.timesheets[0].fieldTechnician, true);
    assert.equal(converted?.timesheets[0].fieldClassification.rosterIncluded, true);
    assert.equal(converted?.timesheets[2].fieldTechnician, true);
    assert.equal(converted?.timesheets[3].fieldTechnician, true);
    assert.equal(converted?.quotedHours, 6);
    assert.equal(converted?.quoteLabor[0].source.upstreamSourceHash, "labor-hash");
    assert.equal(linked?.quoteId, "51");
    assert.equal(linked?.quotedHours, 4);
  } finally {
    await db.close();
  }
});

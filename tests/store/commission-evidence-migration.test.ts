import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { completeCommissionSourceEvidence } from "./commission-evidence-fixture";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);

test("migration 015 stores evidence and validates every required unit and reconciliation hash", async () => {
  const db = new PGlite();
  try {
    const files = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith(".sql") && (file <= "012_pacific_serving_window.sql" || file === "015_commission_manifest_evidence.sql"))
      .sort();
    for (const file of files) await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
    await db.exec(await readFile(new URL("015_commission_manifest_evidence.sql", migrationDirectory), "utf8"));

    const complete = completeCommissionSourceEvidence({ efficiencyEnabled: true });
    const valid = await db.query<{ valid: boolean }>(
      "select metrics.commission_source_evidence_complete($1::jsonb) as valid",
      [JSON.stringify(complete)],
    );
    assert.equal(valid.rows[0].valid, true);

    complete.units.quoteLabor.status = "loading";
    const incomplete = await db.query<{ valid: boolean }>(
      "select metrics.commission_source_evidence_complete($1::jsonb) as valid",
      [JSON.stringify(complete)],
    );
    assert.equal(incomplete.rows[0].valid, false);

    const legacy = await db.query<{ valid: boolean }>(`
      select metrics.commission_source_evidence_complete(source_evidence) as valid
        from metrics.commission_calculation_runs
       limit 1
    `);
    assert.equal(legacy.rows.length, 0);
  } finally {
    await db.close();
  }
});

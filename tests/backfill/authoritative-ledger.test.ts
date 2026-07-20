import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("database gate rejects local equality and accepts an authoritative empty traversal", async () => {
  const db = new PGlite();
  try {
    const migrationDirectory = fileURLToPath(new URL("../../infra/db/migrations/", import.meta.url));
    const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
    for (const migration of migrations) {
      await db.exec(await readFile(`${migrationDirectory}/${migration}`, "utf8"));
    }

    await db.exec(`
      insert into metrics.backfill_source_month_ledger (
        source_family, month_start, month_end_exclusive, expected_pages, expected_records,
        estimated_nested_requests, estimated_requests, daily_request_ceiling,
        approved_by, approved_at, plan_hash, status
      ) values (
        'employees', '2023-01-01', '2023-02-01', 1, 0, 0, 1, 10000,
        'test@example.com', now(), repeat('a', 64), 'queued'
      )
    `);

    await assert.rejects(
      db.exec(`update metrics.backfill_source_month_ledger set reconciliation_status = 'matched' where id = 1`),
      /cannot match or complete without an authoritative traversal manifest/,
    );

    const pages = [{
      ordinal: 1,
      target_key: "employees:identity-snapshot",
      source_method: "listEmployees",
      page_number: 1,
      page_size: 20,
      row_count: 0,
      exact_ids: [],
      request_query: {},
      terminal: true,
      continuation_page: null,
      observed_min_date: null,
      observed_max_date: null,
      response_hash: "0".repeat(64),
      synthetic: false,
    }];
    const traversal = {
      version: 1,
      generation: 1,
      asOfWatermark: "2026-07-09T19:00:00.000Z",
      filterContract: {
        version: 1,
        sourceFamily: "employees",
        provisional: false,
        requiredTargetKeys: ["employees:identity-snapshot"],
      },
      observedBoundary: { effectiveEndInclusive: "2023-01-31", provisional: false },
      sourceIds: [],
      listedSourceIds: [],
      detailedSourceIds: [],
      completedTargetKeys: ["employees:identity-snapshot"],
      exclusions: [],
      continuation: null,
      valid: true,
      violations: [],
      detailCoverageRequired: true,
      emptyProof: null,
      openQuoteDiscovery: { required: false, status: "not_required" },
    };
    await db.query(
      `select * from metrics.record_authoritative_backfill_slice($1, $2, $3::jsonb, $4::jsonb, $5)`,
      [1, null, JSON.stringify(pages), JSON.stringify(traversal), true],
    );
    await db.exec(`
      update metrics.backfill_source_month_ledger
         set reconciliation_status = 'matched', status = 'completed'
       where id = 1
    `);

    const result = await db.query<{
      manifest_status: string;
      page_count: number;
      record_count: number;
      empty_proven: boolean;
    }>(`
      select manifest_status, page_count, record_count, empty_proof is not null as empty_proven
        from metrics.backfill_traversal_manifests
       where work_unit_id = 1
    `);
    assert.deepEqual(result.rows[0], {
      manifest_status: "completed",
      page_count: 1,
      record_count: 0,
      empty_proven: true,
    });

    const pacificParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const part = (type: Intl.DateTimeFormatPartTypes) => pacificParts.find((item) => item.type === type)?.value;
    const pacificDate = `${part("year")}-${part("month")}-${part("day")}`;
    const currentMonth = `${part("year")}-${part("month")}-01`;
    const priorBoundary = new Date(`${pacificDate}T00:00:00.000Z`);
    priorBoundary.setUTCDate(priorBoundary.getUTCDate() - 1);

    await db.query(`
      insert into metrics.backfill_source_month_ledger (
        source_family, month_start, month_end_exclusive, expected_pages, expected_records,
        estimated_nested_requests, estimated_requests, daily_request_ceiling,
        approved_by, approved_at, plan_hash, status
      ) values (
        'employees', $1::date, ($1::date + interval '1 month')::date, 1, 0, 0, 1, 10000,
        'test@example.com', now(), repeat('b', 64), 'queued'
      )
    `, [currentMonth]);
    await db.query(`
      insert into metrics.backfill_traversal_manifests (
        work_unit_id, generation, contract_version, manifest_status, filter_contract,
        as_of_watermark, observed_boundary, page_count, record_count, empty_proof
      ) values (
        2, 1, 1, 'provisional', '{"provisional":true}'::jsonb, now(),
        jsonb_build_object('effectiveEndInclusive', $1::text), 1, 0, '{}'::jsonb
      )
    `, [priorBoundary.toISOString().slice(0, 10)]);
    await db.exec(`
      update metrics.backfill_source_month_ledger
         set reconciliation_status = 'matched', status = 'completed'
       where id = 2
    `);

    const ledgerSource = await readFile(
      fileURLToPath(new URL("../../src/lib/store/backfill-ledger.ts", import.meta.url)),
      "utf8",
    );
    const reopenFunction = ledgerSource.indexOf("async function reopenAdvancedProvisionalBackfills");
    const reopenMarker = ledgerSource.indexOf("with boundary as (", reopenFunction);
    const reopenSql = ledgerSource.slice(
      ledgerSource.lastIndexOf("`", reopenMarker) + 1,
      ledgerSource.indexOf("`,", reopenMarker),
    );
    await db.exec(reopenSql);

    const reopened = await db.query<{
      status: string;
      reconciliation_status: string;
      generation: number;
      manifest_status: string;
    }>(`
      select l.status, l.reconciliation_status, m.generation, m.manifest_status
        from metrics.backfill_source_month_ledger l
        join metrics.backfill_traversal_manifests m on m.work_unit_id = l.id
       where l.id = 2
    `);
    assert.deepEqual(reopened.rows[0], {
      status: "queued",
      reconciliation_status: "pending",
      generation: 2,
      manifest_status: "collecting",
    });

    await db.exec(`
      insert into metrics.backfill_source_month_ledger (
        source_family, month_start, month_end_exclusive, expected_pages, expected_records,
        estimated_nested_requests, estimated_requests, daily_request_ceiling,
        approved_by, approved_at, plan_hash
      ) values (
        'schedules', '2023-02-01', '2023-03-01', 1, 1, 0, 2, 10000,
        'test@example.com', now(), repeat('c', 64)
      )
    `);
    const invalidTraversal = {
      ...traversal,
      generation: 1,
      filterContract: { version: 1, sourceFamily: "schedules", provisional: false, requiredTargetKeys: [] },
      observedBoundary: { effectiveEndInclusive: "2023-02-28", provisional: false },
      exclusions: [{ targetKey: "schedules:month", entityId: "77", reason: "detail_request_failed_after_list_discovery" }],
      valid: false,
      violations: ["listed schedule 77 had no committed detail"],
    };
    await db.query(
      `select * from metrics.record_authoritative_backfill_slice($1, $2, $3::jsonb, $4::jsonb, $5)`,
      [3, null, "[]", JSON.stringify(invalidTraversal), false],
    );
    const repairPlans = await db.query<{ action: string; entity_ids: string[]; destructive_write_performed: boolean }>(`
      select action, entity_ids, destructive_write_performed
        from metrics.backfill_repair_plans
       where work_unit_id = 3
       order by action
    `);
    assert.deepEqual(repairPlans.rows, [
      { action: "tombstone_after_authoritative_confirmation", entity_ids: ["77"], destructive_write_performed: false },
      { action: "verify_deletion_or_window_move", entity_ids: ["77"], destructive_write_performed: false },
    ]);
  } finally {
    await db.close();
  }
});

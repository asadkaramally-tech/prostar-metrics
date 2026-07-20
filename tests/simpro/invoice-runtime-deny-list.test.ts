import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  claimNextIngestionJob,
  enqueueIngestionJob,
  type IngestionJob,
} from "../../src/lib/store/ingestion-jobs";

const repositoryRoot = process.cwd();
const activeEntityFiles = [
  "src/lib/simpro/endpoints.ts",
  "src/lib/simpro/ingest.ts",
  "src/lib/simpro/ingest-change-logs.ts",
  "src/lib/simpro/ingest-nested.ts",
  "src/lib/simpro/normalize-nested.ts",
  "src/lib/simpro/schemas.ts",
  "src/lib/simpro/bulk-operational-export.ts",
  "src/lib/backfill/plan.ts",
  "src/lib/backfill/manifest.ts",
  "src/lib/backfill/orchestration.ts",
  "src/lib/store/backfill-reconciliation.ts",
  "src/lib/store/bulk-operational-bootstrap.ts",
  "src/lib/store/ingestion-claim-strategy.ts",
  "workers/ingest-simpro.ts",
  "workers/repair-ingestion-queue.ts",
  "scripts/export-simpro-operational-bulk.ts",
  "scripts/publish-bulk-bootstrap-evidence.ts",
  "scripts/validate-simpro-operational-bulk.ts",
];

test("runtime source contains no Simpro invoice request or typed endpoint path", () => {
  const runtimeFiles = [
    ...typescriptFiles(path.join(repositoryRoot, "src")),
    ...typescriptFiles(path.join(repositoryRoot, "workers")),
    ...typescriptFiles(path.join(repositoryRoot, "scripts")),
  ];

  for (const file of runtimeFiles) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\/(?:logs\/customerInvoices|customerInvoices|invoices)(?:\/|\b)/i, file);
    assert.doesNotMatch(
      source,
      /\b(?:list|get)(?:Job|Customer)?Invoice(?:s|Logs?)?\b/,
      file,
    );
  }
});

test("invoice entities are absent from every active dispatch, backfill, and bootstrap family", () => {
  for (const relativePath of activeEntityFiles) {
    const source = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    assert.doesNotMatch(source, /\b(?:invoices|customer_invoice_logs)\b/i, relativePath);
  }
});

test("queue APIs reject retired invoice entities before executing SQL", async () => {
  let queryCalled = false;
  const query = async <T>() => {
    queryCalled = true;
    return { rows: [] as T[], rowCount: 0 };
  };

  await assert.rejects(
    enqueueIngestionJob({
      entity: "invoices" as never,
      idempotencyKey: "retired-invoice-enqueue",
    }, query),
    /retired and cannot be enqueued or claimed/,
  );
  await assert.rejects(
    claimNextIngestionJob("test-worker", "customer_invoice_logs" as never, undefined, query),
    /retired and cannot be enqueued or claimed/,
  );
  assert.equal(queryCalled, false);
});

test("generic claims retain a database deny-list for legacy invoice enum rows", async () => {
  let claimSql = "";
  const query = async <T>(sql: string) => {
    claimSql = sql;
    return { rows: [] as T[], rowCount: 0 };
  };

  const claimed = await claimNextIngestionJob("test-worker", undefined, undefined, query);
  assert.equal(claimed, null as IngestionJob | null);
  assert.match(claimSql, /entity_type::text not in \('invoices', 'customer_invoice_logs'\)/);
});

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(file);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}

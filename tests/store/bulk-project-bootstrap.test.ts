import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { flattenBulkProjectPage } from "../../src/lib/simpro/bulk-project-export";
import { sourceHash } from "../../src/lib/simpro/client";
import {
  allocateJobGrossProfit,
  BulkArtifactFinancialValidationError,
  importVerifiedBulkArtifact,
  verifyBulkArtifact,
  type BulkBootstrapManifest,
  type BulkSourceManifest,
} from "../../src/lib/store/bulk-project-bootstrap";
import {
  persistQuoteOverrideAction,
  type QuoteOverrideQuery,
} from "../../src/lib/store/quote-overrides";

const reviewedExclusionIds = [470, 757, 762, 768, 1867];

test("verified bulk artifact proves exact rows, pages, nested counts, and checksums", async () => {
  const directory = await fixtureArtifact();
  try {
    const artifact = await verifyBulkArtifact(directory);
    assert.equal(artifact.manifest.sources.find((source) => source.family === "jobs")?.rowCount, 1);
    assert.equal(artifact.manifest.sources.find((source) => source.family === "quotes")?.nestedCounts.labor, 1);
    assert.deepEqual(artifact.sources.jobs.exactIds, [10]);
    assert.deepEqual(artifact.sources.jobs.activityPeriodIds, { "2026-07-01": [10] });
    assert.deepEqual(artifact.sources.jobs.secondaryPeriodIds, {});
    assert.equal(Object.isFrozen(artifact.sources.jobs.activityPeriodIds), true);
    assert.equal(Object.isFrozen(artifact.sources.jobs.activityPeriodIds["2026-07-01"]), true);
    assert.deepEqual(artifact.financialCoverage.jobs, {
      family: "jobs",
      requiredField: "Total.ExTax",
      acceptedSource: "explicit_simpro_total_ex_tax",
      incTaxSubstitutionAllowed: false,
      expectedRows: 1,
      validRows: 1,
      invalidRows: 0,
      disposition: "verified_for_import",
    });
    assert.match(artifact.manifestSha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified bulk artifact rejects a missing project Total.ExTax with source coverage evidence", async () => {
  const directory = await fixtureArtifact({ jobTotal: null });
  try {
    await assert.rejects(
      () => verifyBulkArtifact(directory),
      financialRejection({ family: "jobs", sourceId: 10, reason: "missing", incTaxPresent: false }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified bulk artifact rejects a nonnumeric project Total.ExTax instead of substituting IncTax", async () => {
  const directory = await fixtureArtifact({ jobTotal: { ExTax: "not-money", IncTax: 140 } });
  try {
    await assert.rejects(
      () => verifyBulkArtifact(directory),
      financialRejection({ family: "jobs", sourceId: 10, reason: "non_numeric", incTaxPresent: true }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified bulk artifact rejects an IncTax-only quote with the exact source ID", async () => {
  const directory = await fixtureArtifact({ quoteTotal: { IncTax: 220, Tax: 20 } });
  try {
    await assert.rejects(
      () => verifyBulkArtifact(directory),
      financialRejection({ family: "quotes", sourceId: 20, reason: "missing", incTaxPresent: true }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bulk verification rejects tampered financial coverage before import opens a transaction", async () => {
  const invalidDirectory = await fixtureArtifact({ quoteTotal: { IncTax: 220 } });
  try {
    let queryCount = 0;
    const query = {
      async query<T = Record<string, unknown>>() {
        queryCount += 1;
        return { rows: [] as T[], rowCount: 0 };
      },
    };
    await assert.rejects(
      async () => {
        const artifact = await verifyBulkArtifact(invalidDirectory);
        await importVerifiedBulkArtifact(query, artifact);
      },
      financialRejection({ family: "quotes", sourceId: 20, reason: "missing", incTaxPresent: true }),
    );
    assert.equal(queryCount, 0);
  } finally {
    await rm(invalidDirectory, { recursive: true, force: true });
  }
});

test("verified bulk artifact rejects missing, extra, and misplaced period-map evidence", async (t) => {
  const cases: Array<{
    name: string;
    mutate: (manifest: BulkBootstrapManifest) => void;
    expected: RegExp;
  }> = [
    {
      name: "missing activity month",
      mutate: (manifest) => { requiredManifestSource(manifest, "jobs").activityPeriodIds = {}; },
      expected: /jobs activityPeriodIds month coverage mismatch: missing=2026-07-01/,
    },
    {
      name: "extra activity ID",
      mutate: (manifest) => { requiredManifestSource(manifest, "jobs").activityPeriodIds["2026-07-01"] = [10, 999]; },
      expected: /jobs activityPeriodIds\/2026-07-01 contains extra ID 999/,
    },
    {
      name: "misplaced activity month",
      mutate: (manifest) => {
        requiredManifestSource(manifest, "quotes").activityPeriodIds = { "2026-06-01": [20] };
      },
      expected: /quotes activityPeriodIds misplaces ID 20 in 2026-06-01.*2026-07-01/,
    },
    {
      name: "wrong family date field",
      mutate: (manifest) => {
        requiredManifestSource(manifest, "jobs").secondaryPeriodIds = { "2026-07-01": [10] };
      },
      expected: /jobs secondaryPeriodIds\/2026-07-01 contains extra ID 10 for this family\/date field/,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const directory = await fixtureArtifact();
      try {
        await mutateManifest(directory, scenario.mutate);
        await assert.rejects(() => verifyBulkArtifact(directory), scenario.expected);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("verified bulk artifact rejects duplicate root IDs explicitly", async () => {
  const directory = await fixtureArtifact();
  try {
    const jobs = await readJsonlRows(path.join(directory, "jobs.jsonl"));
    await replaceSourceRows(directory, "jobs", [jobs[0]!, structuredClone(jobs[0]!)]);
    await assert.rejects(() => verifyBulkArtifact(directory), /jobs artifact contains duplicate source ID 10/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("coordinated source mutation cannot change verified rows or imported facts", async () => {
  const directory = await fixtureArtifact();
  const db = await migratedDatabase();
  try {
    let mutationRan = false;
    const artifact = await verifyBulkArtifact(directory, {
      afterSourceBytesRead: async ({ family, filePath }) => {
        if (family !== "jobs") return;
        mutationRan = true;
        await writeFile(filePath, `${JSON.stringify({
          ID: 999,
          CompletedDate: "2026-07-09",
          Stage: "Complete",
          Total: { ExTax: 999 },
          Sections: [],
        })}\n`, "utf8");
      },
    });
    assert.equal(mutationRan, true);
    assert.equal(artifact.sources.jobs.rows[0]?.ID, 10);
    assert.equal(Object.isFrozen(artifact.sources.jobs.rows), true);
    assert.equal(Object.isFrozen(artifact.sources.jobs.rows[0]?.Total), true);

    await importVerifiedBulkArtifact(pgliteQuery(db), artifact);
    const imported = await db.query<{ job_id: string; total: string }>(
      "select job_id::text, total::text from metrics.metrics_jobs",
    );
    assert.deepEqual(imported.rows, [{ job_id: "10", total: "100" }]);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified bulk artifact rejects post-manifest mutation", async () => {
  const directory = await fixtureArtifact();
  try {
    await writeFile(path.join(directory, "quotes.jsonl"), `${JSON.stringify({ ID: 99, Sections: [] })}\n`, "utf8");
    await assert.rejects(() => verifyBulkArtifact(directory), /artifact checksum mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job gross profit allocation reconciles to the authoritative job total", () => {
  const flattened = flattenBulkProjectPage("job", [{
    ID: 10,
    CompletedDate: "2026-07-09",
    Stage: "Complete",
    Total: { ExTax: 300, IncTax: 300, Tax: 0 },
    Totals: { GrossProfitLoss: { Actual: 100 }, GrossMargin: { Actual: 33.33 } },
    Sections: [{
      ID: 20,
      Name: "",
      CostCenters: [
        { ID: 30, CostCenter: { ID: 1, Name: "HVAC" }, Name: "A", Total: { ExTax: 200 }, Items: emptyItems() },
        { ID: 31, CostCenter: { ID: 2, Name: "Water Heating" }, Name: "B", Total: { ExTax: 100 }, Items: emptyItems() },
      ],
    }],
  }], "2026-07-10T16:00:00.000Z");

  const allocated = allocateJobGrossProfit(flattened.projects, flattened.costCenters, flattened.items);
  assert.deepEqual(allocated.map((row) => row.grossProfitAllocated), [66.67, 33.33]);
  assert.equal(allocated.reduce((sum, row) => sum + (row.grossProfitAllocated ?? 0), 0), 100);
});

test("bulk import is atomic, idempotent, preserves overrides, and cancels replaced detail work", async () => {
  const directory = await fixtureArtifact();
  const db = await migratedDatabase();
  try {
    await db.exec(`
      insert into metrics.ingestion_jobs (entity_type, idempotency_key, params)
      values ('quote_nested', 'test-detail-20', '{"entityId":20}'::jsonb)
    `);
    const artifact = await verifyBulkArtifact(directory);
    const query = pgliteQuery(db);
    const first = await importVerifiedBulkArtifact(query, artifact);
    assert.deepEqual(first.imported, { jobs: 1, quotes: 1 });
    assert.equal(first.cancelledNestedJobs, 1);

    await db.exec(`
      insert into metrics.quote_classification_overrides (
        quote_id, category, outcome, reason, actor_email, active
      ) values (20, 'Water Heating', 'excluded', 'test decision', 'test@prostarmechanical.com', true)
      ;
      update metrics.metrics_quote_cost_centers
         set category = 'HVAC'
       where quote_id = 20 and cost_center_id = 22
    `);
    await importVerifiedBulkArtifact(query, artifact);

    const facts = await db.query<{ quotes: number; jobs: number; quote_cc: number; outcome: string; detail_status: string; child_category: string }>(`
      select
        (select count(*)::int from metrics.metrics_quotes where source_deleted_at is null) as quotes,
        (select count(*)::int from metrics.metrics_jobs where source_deleted_at is null) as jobs,
        (select count(*)::int from metrics.metrics_quote_cost_centers where source_deleted_at is null) as quote_cc,
        (select outcome from metrics.metrics_quotes where quote_id = 20) as outcome,
        (select status::text from metrics.ingestion_jobs where idempotency_key = 'test-detail-20') as detail_status,
        (select category from metrics.metrics_quote_cost_centers
          where quote_id = 20 and cost_center_id = 22) as child_category
    `);
    assert.deepEqual(facts.rows[0], {
      quotes: 1,
      jobs: 1,
      quote_cc: 1,
      outcome: "excluded",
      detail_status: "cancelled",
      child_category: "Water Heating",
    });
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bulk import preserves valid explicit real-zero totals", async () => {
  const directory = await fixtureArtifact({
    jobTotal: { ExTax: 0, IncTax: 110, Tax: 10 },
    quoteTotal: { ExTax: 0, IncTax: 220, Tax: 20 },
  });
  const db = await migratedDatabase();
  try {
    const artifact = await verifyBulkArtifact(directory);
    await importVerifiedBulkArtifact(pgliteQuery(db), artifact);
    const values = await db.query<{ job_total: string; quote_total: string; deal_tier: string }>(`
      select
        (select total::text from metrics.metrics_jobs where job_id = 10) as job_total,
        (select total::text from metrics.metrics_quotes where quote_id = 20) as quote_total,
        (select deal_tier from metrics.metrics_quotes where quote_id = 20) as deal_tier
    `);
    assert.deepEqual(values.rows[0], { job_total: "0", quote_total: "0.00", deal_tier: "Under $750" });
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrations-first bulk import applies five reviewed exclusions and owner reinstatement is durable", async () => {
  const directory = await fixtureArtifact({ quoteIds: reviewedExclusionIds });
  const db = await migratedDatabase();
  try {
    const artifact = await verifyBulkArtifact(directory);
    const client = pgliteQuery(db);
    await importVerifiedBulkArtifact(client, artifact);

    const seeded = await db.query<{ quote_id: number; action: string; outcome: string; revision: number; active: boolean }>(`
      select quote_id::int, action::text, outcome, revision, active
        from metrics.quote_classification_overrides
       where quote_id = any($1::bigint[])
       order by quote_id, revision
    `, [reviewedExclusionIds]);
    assert.deepEqual(seeded.rows, reviewedExclusionIds.map((quoteId) => ({
      quote_id: quoteId,
      action: "exclude",
      outcome: "excluded",
      revision: 1,
      active: true,
    })));
    const initial = await db.query<{ excluded: number; legacy_outcomes: number; seed_audits: number }>(`
      select
        (select count(*)::int from metrics.metrics_quotes
          where quote_id = any($1::bigint[]) and outcome = 'excluded') as excluded,
        (select count(*)::int from metrics.quote_classification_overrides
          where quote_id = any($1::bigint[]) and outcome in ('won', 'lost')) as legacy_outcomes,
        (select count(*)::int from metrics.audit_events
          where action = 'reviewed_quote_exclusion_seed_applied') as seed_audits
    `, [reviewedExclusionIds]);
    assert.deepEqual(initial.rows[0], { excluded: 5, legacy_outcomes: 0, seed_audits: 5 });

    const quoteQuery: QuoteOverrideQuery = async <T>(text: string, values?: unknown[]) => {
      const result = await db.query<T>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    };
    await persistQuoteOverrideAction({
      quoteId: 470,
      action: "reinstate",
      expectedActiveExclusionRevision: 1,
      idempotencyKey: "owner-reinstate-seeded-quote-470",
      reason: "Owner explicitly reinstated the reviewed source quote.",
      actorEmail: "owner@prostarmechanical.com",
    }, quoteQuery);
    await importVerifiedBulkArtifact(client, artifact);

    const afterReimport = await db.query<{ enabled: boolean; active_exclusions: number; outcome: string }>(`
      select seed.enabled,
             (select count(*)::int from metrics.quote_classification_overrides o
               where o.quote_id = seed.quote_id and o.active and o.outcome = 'excluded') as active_exclusions,
             (select outcome from metrics.metrics_quotes q where q.quote_id = seed.quote_id) as outcome
        from metrics.reviewed_quote_exclusion_seeds seed
       where seed.quote_id = 470
    `);
    assert.deepEqual(afterReimport.rows[0], { enabled: false, active_exclusions: 0, outcome: "lost" });
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bulk importer reprojects parent and snapshot from Unclassified child contribution", async () => {
  const directory = await fixtureArtifact({
    quoteTotal: { ExTax: 1_100, IncTax: 1_100, Tax: 0 },
    quoteCostCenters: [
      fixtureCostCenter(22, 7, 100),
      fixtureCostCenter(24, 999, 1_000),
    ],
  });
  const db = await migratedDatabase();
  try {
    await importVerifiedBulkArtifact(pgliteQuery(db), await verifyBulkArtifact(directory));
    const parity = await db.query<{ canonical: string; snapshot: string; child_categories: string[] }>(`
      select q.category as canonical, snapshot.category as snapshot,
             array_agg(child.category order by child.cost_center_id) as child_categories
        from metrics.metrics_quotes q
        join metrics.quote_snapshots snapshot using (quote_id)
        join metrics.metrics_quote_cost_centers child using (quote_id)
       where q.quote_id = 20 and child.source_deleted_at is null
       group by q.category, snapshot.category
    `);
    assert.deepEqual(parity.rows[0], {
      canonical: "Unclassified",
      snapshot: "Unclassified",
      child_categories: ["HVAC", "Unclassified"],
    });
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

type FixtureArtifactOptions = {
  jobTotal?: unknown;
  quoteTotal?: unknown;
  quoteIds?: readonly number[];
  quoteCostCenters?: Record<string, unknown>[];
};

async function fixtureArtifact(options: FixtureArtifactOptions = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prostar-bulk-bootstrap-"));
  const jobs = [{
    ID: 10,
    CompletedDate: "2026-07-09",
    Stage: "Complete",
    Total: Object.hasOwn(options, "jobTotal") ? options.jobTotal : { ExTax: 100, IncTax: 100, Tax: 0 },
    Totals: { GrossProfitLoss: { Actual: 40 } },
    Sections: [],
  }];
  const quoteIds = options.quoteIds ?? [20];
  const quotes = quoteIds.map((quoteId) => ({
    ID: quoteId,
    DateApproved: "2026-07-08",
    Stage: "Complete",
    IsClosed: true,
    Total: Object.hasOwn(options, "quoteTotal") ? options.quoteTotal : { ExTax: 200, IncTax: 200, Tax: 0 },
    Totals: {},
    Sections: options.quoteIds ? [] : [{
      ID: 21,
      CostCenters: options.quoteCostCenters ?? [fixtureCostCenter(22, 6, 200, true)],
    }],
  }));
  const completedAt = "2026-07-10T16:00:00.000Z";
  const sources = [sourceManifest("jobs", jobs), sourceManifest("quotes", quotes)];
  for (const source of sources) {
    const rows = source.family === "jobs" ? jobs : quotes;
    await writeFile(path.join(directory, source.file), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  }
  const manifest: BulkBootstrapManifest = {
    version: 1,
    source: "test",
    companyId: "0",
    startDate: "2023-01-01",
    timezone: "America/Los_Angeles",
    startedAt: "2026-07-10T15:59:00.000Z",
    completedAt,
    requestsUsed: 2,
    sources,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(directory, "manifest.json"), manifestText, "utf8");
  await writeFile(path.join(directory, "manifest.sha256"), `${sha(manifestText)}  manifest.json\n`, "utf8");
  return directory;
}

async function mutateManifest(
  directory: string,
  mutate: (manifest: BulkBootstrapManifest) => void,
) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as BulkBootstrapManifest;
  mutate(manifest);
  await writeManifest(directory, manifest);
}

async function replaceSourceRows(
  directory: string,
  family: "jobs" | "quotes",
  rows: Record<string, unknown>[],
) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as BulkBootstrapManifest;
  const replacement = sourceManifest(family, rows);
  manifest.sources = manifest.sources.map((source) => source.family === family ? replacement : source);
  await writeFile(path.join(directory, replacement.file), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  await writeManifest(directory, manifest);
}

async function readJsonlRows(filePath: string) {
  return (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function writeManifest(directory: string, manifest: BulkBootstrapManifest) {
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(directory, "manifest.json"), manifestText, "utf8");
  await writeFile(path.join(directory, "manifest.sha256"), `${sha(manifestText)}  manifest.json\n`, "utf8");
}

function requiredManifestSource(manifest: BulkBootstrapManifest, family: "jobs" | "quotes") {
  const source = manifest.sources.find((candidate) => candidate.family === family);
  if (!source) throw new Error(`Missing ${family} fixture source`);
  return source;
}

function financialRejection(expected: {
  family: "jobs" | "quotes";
  sourceId: number;
  reason: "missing" | "non_numeric";
  incTaxPresent: boolean;
}) {
  return (error: unknown) => {
    assert.ok(error instanceof BulkArtifactFinancialValidationError);
    assert.deepEqual(error.evidence, {
      family: expected.family,
      requiredField: "Total.ExTax",
      acceptedSource: "explicit_simpro_total_ex_tax",
      incTaxSubstitutionAllowed: false,
      expectedRows: 1,
      validRowsBeforeFailure: 0,
      invalidRows: 1,
      invalidSourceId: expected.sourceId,
      reason: expected.reason,
      incTaxPresent: expected.incTaxPresent,
      disposition: "rejected_before_transaction",
    });
    return true;
  };
}

async function migratedDatabase() {
  const db = new PGlite();
  const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);
  const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const migration of migrations) {
    await db.exec(await readFile(new URL(migration, migrationDirectory), "utf8"));
  }
  return db;
}

function sourceManifest(family: "jobs" | "quotes", rows: Record<string, unknown>[]): BulkSourceManifest {
  const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const firstId = Number(rows[0].ID);
  const nestedCounts = rows.reduce<{ sections: number; costCenters: number; labor: number; items: number }>((counts, row) => {
    for (const section of Array.isArray(row.Sections) ? row.Sections as Record<string, unknown>[] : []) {
      counts.sections += 1;
      for (const costCenter of Array.isArray(section.CostCenters) ? section.CostCenters as Record<string, unknown>[] : []) {
        counts.costCenters += 1;
        const items = costCenter.Items as Record<string, unknown>;
        counts.labor += Array.isArray(items?.Labors) ? items.Labors.length : 0;
        for (const key of ["Catalogs", "Prebuilds", "ServiceFees", "OneOffs", "Stock", "Stocks"]) {
          counts.items += Array.isArray(items?.[key]) ? items[key].length : 0;
        }
      }
    }
    return counts;
  }, { sections: 0, costCenters: 0, labor: 0, items: 0 });
  return {
    family,
    file: `${family}.jsonl`,
    sha256: sha(text),
    rowCount: rows.length,
    exactIds: rows.map((row) => Number(row.ID)),
    activityPeriodIds: { "2026-07-01": rows.map((row) => Number(row.ID)) },
    secondaryPeriodIds: {},
    nestedCounts,
    query: { display: "all", orderby: "ID" },
    pageSize: 250,
    pages: [{ page: 1, rowCount: rows.length, firstId, lastId: Number(rows.at(-1)?.ID), responseHash: sourceHash(rows), terminal: true }],
  };
}

function fixtureCostCenter(id: number, configuredId: number | null, total: number, withLabor = false) {
  return {
    ID: id,
    CostCenter: configuredId === null ? null : { ID: configuredId, Name: `Configured ${configuredId}` },
    Name: `Cost center ${id}`,
    Total: { ExTax: total },
    Items: {
      Labors: withLabor
        ? [{ ID: 23, LaborType: { ID: 12, Name: "Normal" }, Total: { Qty: 1, Amount: { ExTax: 100, IncTax: 100 } } }]
        : [],
      Catalogs: [], Prebuilds: [], ServiceFees: [], OneOffs: [],
    },
  };
}

function emptyItems() {
  return { Labors: [], Catalogs: [], Prebuilds: [], ServiceFees: [], OneOffs: [] };
}

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function pgliteQuery(db: PGlite) {
  return {
    async query<T = Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await db.query<T>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? null };
    },
  };
}

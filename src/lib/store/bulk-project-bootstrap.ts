import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BulkProjectFinancialValidationError,
  flattenBulkProjectPage,
  requireBulkProjectTotalExTax,
  type BulkProjectCostCenterRow,
  type BulkProjectItemRow,
  type BulkProjectRow,
  type FlattenedBulkProjectPage,
} from "@/lib/simpro/bulk-project-export";
import { sourceHash } from "@/lib/simpro/client";
import {
  QUOTE_CLASSIFICATION_LOCK_KEY,
  quoteClassificationRebuildSql,
} from "@/lib/store/quote-classification-rebuild";
import {
  QUOTE_CATEGORY_ADVISORY_LOCK_KEY,
  reprojectImportedQuoteCategories,
} from "@/lib/store/quote-category-rebuild";
import { reprojectImportedJobCategories } from "@/lib/store/job-category-rebuild";
import { applyReviewedQuoteExclusionSeeds } from "@/lib/store/reviewed-quote-exclusions";

export type BulkBootstrapQueryClient = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
};

export type BulkSourceManifest = {
  family: "jobs" | "quotes";
  file: string;
  sha256: string;
  rowCount: number;
  exactIds: number[];
  activityPeriodIds: Record<string, number[]>;
  secondaryPeriodIds: Record<string, number[]>;
  nestedCounts: { sections: number; costCenters: number; labor: number; items: number };
  query: Record<string, unknown>;
  pageSize: number;
  pages: Array<{
    page: number;
    rowCount: number;
    firstId: number | null;
    lastId: number | null;
    responseHash: string;
    terminal: boolean;
  }>;
};

export type BulkBootstrapManifest = {
  version: number;
  source: string;
  companyId: string;
  startDate: string;
  timezone: string;
  startedAt: string;
  completedAt: string;
  requestsUsed: number;
  sources: BulkSourceManifest[];
};

export type VerifiedBulkPeriodIds = Readonly<Record<string, readonly number[]>>;

export type VerifiedBulkSource = Readonly<
  Omit<
    BulkSourceManifest,
    "exactIds" | "activityPeriodIds" | "secondaryPeriodIds" | "nestedCounts" | "query" | "pages"
  > & {
    exactIds: readonly number[];
    activityPeriodIds: VerifiedBulkPeriodIds;
    secondaryPeriodIds: VerifiedBulkPeriodIds;
    nestedCounts: Readonly<BulkSourceManifest["nestedCounts"]>;
    query: Readonly<Record<string, unknown>>;
    pages: readonly Readonly<BulkSourceManifest["pages"][number]>[];
    rows: readonly Readonly<Record<string, unknown>>[];
  }
>;

export type VerifiedBulkArtifact = Readonly<{
  directory: string;
  manifestSha256: string;
  manifest: Readonly<BulkBootstrapManifest>;
  sources: Readonly<Record<"jobs" | "quotes", VerifiedBulkSource>>;
  financialCoverage: Readonly<Record<"jobs" | "quotes", BulkArtifactFinancialCoverage>>;
}>;

export type BulkArtifactVerificationOptions = {
  afterSourceBytesRead?: (source: { family: "jobs" | "quotes"; filePath: string }) => void | Promise<void>;
};

export type BulkArtifactFinancialCoverage = {
  family: "jobs" | "quotes";
  requiredField: "Total.ExTax";
  acceptedSource: "explicit_simpro_total_ex_tax";
  incTaxSubstitutionAllowed: false;
  expectedRows: number;
  validRows: number;
  invalidRows: 0;
  disposition: "verified_for_import";
};

export type BulkArtifactFinancialRejectionEvidence = Omit<
  BulkArtifactFinancialCoverage,
  "validRows" | "invalidRows" | "disposition"
> & {
  validRowsBeforeFailure: number;
  invalidRows: 1;
  invalidSourceId: number;
  reason: "missing" | "non_numeric";
  incTaxPresent: boolean;
  disposition: "rejected_before_transaction";
};

export class BulkArtifactFinancialValidationError extends Error {
  readonly evidence: BulkArtifactFinancialRejectionEvidence;

  constructor(evidence: BulkArtifactFinancialRejectionEvidence) {
    super(
      `${evidence.family} artifact financial validation rejected source ID ${evidence.invalidSourceId} before transaction: `
      + `Total.ExTax is ${evidence.reason === "missing" ? "missing" : "not numeric"}; `
      + `coverage=${evidence.validRowsBeforeFailure}/${evidence.expectedRows} valid rows before failure; `
      + `IncTax present=${evidence.incTaxPresent}; IncTax substitution allowed=false.`,
    );
    this.name = "BulkArtifactFinancialValidationError";
    this.evidence = evidence;
  }
}

export type BulkBootstrapResult = {
  manifestSha256: string;
  imported: Record<"jobs" | "quotes", number>;
  cancelledNestedJobs: number;
  rollupsQueued: number;
  canonicalCounts: Record<string, number>;
};

type BootstrapRun = {
  family: "jobs" | "quotes";
  jobId: number;
  runId: number;
  requestCount: number;
  rowCount: number;
};

type AllocatedCostCenterRow = BulkProjectCostCenterRow & {
  grossProfitAllocated: number | null;
  grossMarginAllocated: number | null;
  materialSellValue: number | null;
};

const BATCH_SIZE = 250;
const verifiedArtifacts = new WeakSet<VerifiedBulkArtifact>();

export async function verifyBulkArtifact(
  directory: string,
  options: BulkArtifactVerificationOptions = {},
): Promise<VerifiedBulkArtifact> {
  const resolvedDirectory = path.resolve(directory);
  const manifestPath = path.join(resolvedDirectory, "manifest.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const expectedManifestHash = parseChecksumFile(
    await readFile(path.join(resolvedDirectory, "manifest.sha256"), "utf8"),
    "manifest.json",
  );
  const manifestSha256 = sha256(manifestText);
  if (manifestSha256 !== expectedManifestHash) {
    throw new Error(`Manifest checksum mismatch: expected ${expectedManifestHash}, received ${manifestSha256}`);
  }

  const manifest = JSON.parse(manifestText) as BulkBootstrapManifest;
  assertManifestContract(manifest);
  const financialCoverage = {} as Record<"jobs" | "quotes", BulkArtifactFinancialCoverage>;
  const sources = {} as Record<"jobs" | "quotes", VerifiedBulkSource>;
  for (const source of manifest.sources) {
    const verified = await verifySourceArtifact(resolvedDirectory, manifest, source, options);
    financialCoverage[source.family] = verified.financialCoverage;
    sources[source.family] = verified.source;
  }
  const verifiedManifest: BulkBootstrapManifest = {
    ...manifest,
    sources: manifest.sources.map((source) => manifestSourceFromVerified(sources[source.family])),
  };
  const artifact = deepFreeze({
    directory: resolvedDirectory,
    manifestSha256,
    manifest: deepFreeze(verifiedManifest),
    sources,
    financialCoverage,
  }) as VerifiedBulkArtifact;
  verifiedArtifacts.add(artifact);
  return artifact;
}

function manifestSourceFromVerified(source: VerifiedBulkSource): BulkSourceManifest {
  return {
    family: source.family,
    file: source.file,
    sha256: source.sha256,
    rowCount: source.rowCount,
    exactIds: [...source.exactIds],
    activityPeriodIds: copyPeriodIds(source.activityPeriodIds),
    secondaryPeriodIds: copyPeriodIds(source.secondaryPeriodIds),
    nestedCounts: { ...source.nestedCounts },
    query: { ...source.query },
    pageSize: source.pageSize,
    pages: source.pages.map((page) => ({ ...page })),
  };
}

function copyPeriodIds(value: VerifiedBulkPeriodIds): Record<string, number[]> {
  return Object.fromEntries(Object.entries(value).map(([month, ids]) => [month, [...ids]]));
}

export async function importVerifiedBulkArtifact(
  client: BulkBootstrapQueryClient,
  artifact: VerifiedBulkArtifact,
): Promise<BulkBootstrapResult> {
  if (!verifiedArtifacts.has(artifact)) {
    throw new Error("Bulk import requires the immutable result returned by verifyBulkArtifact.");
  }
  const imported = { jobs: 0, quotes: 0 };
  const runs: BootstrapRun[] = [];
  let cancelledNestedJobs = 0;
  let rollupsQueued = 0;

  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock($1::bigint)", [QUOTE_CLASSIFICATION_LOCK_KEY]);
    await client.query("select pg_advisory_xact_lock($1::bigint)", [QUOTE_CATEGORY_ADVISORY_LOCK_KEY]);
    await client.query("select pg_advisory_xact_lock(hashtext('prostar-metrics-bulk-bootstrap'))");
    const sources = Object.values(artifact.sources)
      .sort((left, right) => left.family === right.family ? 0 : left.family === "quotes" ? -1 : 1);

    for (const source of sources) {
      const run = await startBootstrapRun(client, artifact, source);
      runs.push(run);
      const projectType = source.family === "quotes" ? "quote" : "job";
      for (let offset = 0; offset < source.rows.length; offset += BATCH_SIZE) {
        const payloads = source.rows.slice(offset, offset + BATCH_SIZE) as Record<string, unknown>[];
        const flattened = flattenBulkProjectPage(projectType, payloads, artifact.manifest.completedAt);
        assertBatchIdentity(payloads, flattened.projects, source.family);
        await importProjectBatch(client, artifact, run, payloads, flattened);
        imported[source.family] += flattened.projects.length;
      }
      if (imported[source.family] !== source.rowCount) {
        throw new Error(`${source.family} import count ${imported[source.family]} does not match manifest ${source.rowCount}`);
      }
      cancelledNestedJobs += await finalizeAuthoritativeSource(client, artifact, source);
      await completeBootstrapRun(client, run, source.sha256);
    }

    await client.query(quoteClassificationRebuildSql);
    rollupsQueued = await enqueueBootstrapRollups(client, artifact);
    const canonicalCounts = await readCanonicalCounts(client);
    await client.query("commit");
    return {
      manifestSha256: artifact.manifestSha256,
      imported,
      cancelledNestedJobs,
      rollupsQueued,
      canonicalCounts,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function verifySourceArtifact(
  directory: string,
  manifest: BulkBootstrapManifest,
  source: BulkSourceManifest,
  options: BulkArtifactVerificationOptions,
) {
  if (source.file !== `${source.family}.jsonl` || path.basename(source.file) !== source.file) {
    throw new Error(`Unsafe or unexpected ${source.family} artifact filename: ${source.file}`);
  }
  const filePath = path.join(directory, source.file);
  const fileBytes = await readFile(filePath);
  await options.afterSourceBytesRead?.({ family: source.family, filePath });
  const actualHash = createHash("sha256").update(fileBytes).digest("hex");
  if (actualHash !== source.sha256) {
    throw new Error(`${source.family} artifact checksum mismatch: expected ${source.sha256}, received ${actualHash}`);
  }

  const ids: number[] = [];
  const seenIds = new Set<number>();
  const activityPeriodIds: Record<string, number[]> = {};
  const secondaryPeriodIds: Record<string, number[]> = {};
  const nestedCounts = { sections: 0, costCenters: 0, labor: 0, items: 0 };
  const pages = source.pages;
  let pageIndex = 0;
  let financiallyValidRows = 0;
  let pageRows: Record<string, unknown>[] = [];
  const rows = parseJsonlBytes(fileBytes, source.file);
  for (const row of rows) {
    const id = positiveInteger(row.ID, `${source.family} ID`);
    try {
      requireBulkProjectTotalExTax(row, source.family === "jobs" ? "job" : "quote", id);
      financiallyValidRows += 1;
    } catch (error) {
      if (!(error instanceof BulkProjectFinancialValidationError)) throw error;
      throw new BulkArtifactFinancialValidationError({
        family: source.family,
        requiredField: "Total.ExTax",
        acceptedSource: "explicit_simpro_total_ex_tax",
        incTaxSubstitutionAllowed: false,
        expectedRows: source.rowCount,
        validRowsBeforeFailure: financiallyValidRows,
        invalidRows: 1,
        invalidSourceId: id,
        reason: error.evidence.reason,
        incTaxPresent: error.evidence.incTaxPresent,
        disposition: "rejected_before_transaction",
      });
    }
    if (seenIds.has(id)) {
      throw new Error(`${source.family} artifact contains duplicate source ID ${id}`);
    }
    if (ids.length > 0 && id < ids[ids.length - 1]) {
      throw new Error(`${source.family} artifact is not strictly ordered at ID ${id}`);
    }
    if (!Array.isArray(row.Sections)) {
      throw new Error(`${source.family} ${id} lacks the required embedded Sections array`);
    }
    if (source.family === "jobs") {
      const completedDate = dateText(row.CompletedDate);
      if (!completedDate || completedDate < manifest.startDate) {
        throw new Error(`Job ${id} falls outside the declared CompletedDate window`);
      }
    }
    seenIds.add(id);
    ids.push(id);
    recordPeriodIds(source.family, row, id, activityPeriodIds, secondaryPeriodIds);
    countNested(row, nestedCounts);
    pageRows.push(row);
    const expectedPage = pages[pageIndex];
    if (!expectedPage) throw new Error(`${source.family} artifact contains more pages than its manifest`);
    if (pageRows.length === expectedPage.rowCount) {
      assertPageEvidence(source.family, expectedPage, pageRows);
      pageRows = [];
      pageIndex += 1;
    }
  }
  if (pageRows.length > 0) throw new Error(`${source.family} final page does not match its declared row count`);
  if (pageIndex !== pages.length) throw new Error(`${source.family} artifact contains fewer pages than its manifest`);
  if (ids.length !== source.rowCount || !sameIds(ids, source.exactIds)) {
    throw new Error(`${source.family} exact ID evidence does not match the JSONL artifact`);
  }
  assertPeriodIdsMatch(source.family, "activityPeriodIds", activityPeriodIds, source.activityPeriodIds);
  assertPeriodIdsMatch(source.family, "secondaryPeriodIds", secondaryPeriodIds, source.secondaryPeriodIds);
  if (JSON.stringify(nestedCounts) !== JSON.stringify(source.nestedCounts)) {
    throw new Error(`${source.family} nested counts do not match the JSONL artifact`);
  }
  const financialCoverage = {
    family: source.family,
    requiredField: "Total.ExTax",
    acceptedSource: "explicit_simpro_total_ex_tax",
    incTaxSubstitutionAllowed: false,
    expectedRows: source.rowCount,
    validRows: financiallyValidRows,
    invalidRows: 0,
    disposition: "verified_for_import",
  } satisfies BulkArtifactFinancialCoverage;
  const verifiedSource = deepFreeze({
    ...source,
    exactIds: [...ids],
    activityPeriodIds: sortedPeriodIds(activityPeriodIds),
    secondaryPeriodIds: sortedPeriodIds(secondaryPeriodIds),
    nestedCounts: { ...nestedCounts },
    query: { ...source.query },
    pages: source.pages.map((page) => ({ ...page })),
    rows,
  }) as VerifiedBulkSource;
  return { source: verifiedSource, financialCoverage };
}

function assertManifestContract(manifest: BulkBootstrapManifest) {
  if (manifest.version !== 1) throw new Error(`Unsupported bulk manifest version: ${manifest.version}`);
  if (manifest.timezone !== "America/Los_Angeles") throw new Error(`Unexpected manifest timezone: ${manifest.timezone}`);
  if (manifest.startDate !== "2023-01-01") throw new Error(`Unexpected manifest start date: ${manifest.startDate}`);
  if (!validTimestamp(manifest.startedAt) || !validTimestamp(manifest.completedAt)) {
    throw new Error("Manifest timestamps are invalid");
  }
  const families = manifest.sources.map((source) => source.family).sort();
  if (JSON.stringify(families) !== JSON.stringify(["jobs", "quotes"])) {
    throw new Error("Bulk manifest must contain exactly jobs and quotes");
  }
  for (const source of manifest.sources) {
    if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error(`${source.family} checksum is invalid`);
    if (source.pageSize !== 250 || source.rowCount <= 0 || source.exactIds.length !== source.rowCount) {
      throw new Error(`${source.family} row/page contract is invalid`);
    }
    if (source.query.display !== "all" || source.query.orderby !== "ID") {
      throw new Error(`${source.family} was not captured with display=all and deterministic ID ordering`);
    }
    if (!source.pages.length || !source.pages.at(-1)?.terminal || source.pages.slice(0, -1).some((page) => page.terminal)) {
      throw new Error(`${source.family} lacks one terminal page`);
    }
    if (source.pages.reduce((sum, page) => sum + page.rowCount, 0) !== source.rowCount) {
      throw new Error(`${source.family} page counts do not reconcile to its row count`);
    }
  }
}

async function startBootstrapRun(
  client: BulkBootstrapQueryClient,
  artifact: VerifiedBulkArtifact,
  source: VerifiedBulkSource,
): Promise<BootstrapRun> {
  const workerId = `bulk-bootstrap:${process.pid}`;
  const idempotencyKey = `bulk-bootstrap:${artifact.manifestSha256}:${source.family}`;
  const params = {
    transport: "simpro-display-all-jsonl",
    manifestSha256: artifact.manifestSha256,
    artifactSha256: source.sha256,
    exactRowCount: source.rowCount,
    completeTraversal: true,
  };
  const job = await client.query<{ id: string; generation: number }>(
    `insert into metrics.ingestion_jobs (
       entity_type, status, priority, idempotency_key, request_budget, requests_used,
       params, operation, source_window_start, source_window_end, locked_by, locked_at,
       lock_expires_at, heartbeat_at, attempts, next_attempt_at, updated_at
     ) values (
       $1::metrics.ingestion_entity_type, 'running', 1, $2, $3, 0,
       $4::jsonb, 'bulk_bootstrap', $5::timestamptz, $6::timestamptz, $7, now(),
       now() + interval '30 minutes', now(), 1, now(), now()
     )
     on conflict (entity_type, idempotency_key) do update set
       status = 'running'::metrics.ingestion_job_status,
       priority = 1,
       request_budget = excluded.request_budget,
       requests_used = 0,
       params = excluded.params,
       operation = excluded.operation,
       source_window_start = excluded.source_window_start,
       source_window_end = excluded.source_window_end,
       locked_by = excluded.locked_by,
       locked_at = now(),
       lock_expires_at = excluded.lock_expires_at,
       heartbeat_at = now(),
       attempts = metrics.ingestion_jobs.attempts + 1,
       generation = metrics.ingestion_jobs.generation + 1,
       continuation_token = null,
       page_cursor = null,
       last_error = null,
       dead_lettered_at = null,
       completed_at = null,
       updated_at = now()
     returning id::text, generation`,
    [
      source.family,
      idempotencyKey,
      source.pages.length,
      JSON.stringify(params),
      artifact.manifest.startDate,
      artifact.manifest.completedAt,
      workerId,
    ],
  );
  const jobRow = job.rows[0];
  if (!jobRow) throw new Error(`Unable to start ${source.family} bootstrap job`);
  const run = await client.query<{ id: string }>(
    `insert into metrics.ingestion_runs (
       job_id, entity_type, source_family, source_window_start, source_window_end,
       status, worker_id, job_generation, source_hash
     ) values ($1, $2::metrics.ingestion_entity_type, $2, $3::timestamptz, $4::timestamptz,
       'running', $5, $6, $7)
     returning id::text`,
    [jobRow.id, source.family, artifact.manifest.startDate, artifact.manifest.completedAt, workerId, jobRow.generation, source.sha256],
  );
  const runRow = run.rows[0];
  if (!runRow) throw new Error(`Unable to start ${source.family} bootstrap run`);
  return {
    family: source.family,
    jobId: positiveInteger(jobRow.id, `${source.family} bootstrap job ID`),
    runId: positiveInteger(runRow.id, `${source.family} bootstrap run ID`),
    requestCount: source.pages.length,
    rowCount: source.rowCount,
  };
}

async function importProjectBatch(
  client: BulkBootstrapQueryClient,
  artifact: VerifiedBulkArtifact,
  run: BootstrapRun,
  payloads: Record<string, unknown>[],
  flattened: FlattenedBulkProjectPage,
) {
  const allLabor = dedupeBy(flattened.labor, (row) => `${row.projectId}:${row.sectionId}:${row.costCenterId}:${row.laborId}`);
  const allItems = dedupeBy(flattened.items, itemIdentity);
  const allCostCenters = allocateJobGrossProfit(flattened.projects, flattened.costCenters, allItems);
  const reusable = await reusableProjectIds(
    client,
    run.family,
    flattened.projects,
    allCostCenters,
    allLabor,
    allItems,
  );
  const changedIds = new Set(
    flattened.projects
      .map((project) => project.projectId)
      .filter((projectId) => !reusable.has(projectId)),
  );
  if (changedIds.size === 0) return;

  const changedProjects = flattened.projects.filter((row) => changedIds.has(row.projectId));
  const rawRows = payloads
    .map((payload, index) => ({ payload, project: flattened.projects[index] }))
    .filter((row) => changedIds.has(row.project.projectId));
  const people = dedupeBy(
    flattened.people.filter((row) => changedIds.has(row.projectId)),
    (row) => String(row.personId),
  );
  const labor = allLabor.filter((row) => changedIds.has(row.projectId));
  const items = allItems.filter((row) => changedIds.has(row.projectId));
  const costCenters = allCostCenters.filter((row) => changedIds.has(row.projectId));
  const projectIds = [...changedIds];

  await insertRawSnapshots(client, artifact, run, rawRows);
  if (people.length > 0) await upsertPeople(client, people);
  if (run.family === "quotes") await upsertQuotes(client, artifact, changedProjects);
  else await upsertJobs(client, artifact, changedProjects);
  await markExistingNestedRowsDeleted(client, run.family, projectIds);
  if (costCenters.length > 0) await upsertCostCenters(client, run.family, costCenters);
  if (labor.length > 0) await upsertLabor(client, run.family, labor);
  if (items.length > 0) await upsertItems(client, run.family, items);
  if (run.family === "quotes") {
    await reprojectImportedQuoteCategories(projectIds, client.query.bind(client));
    await applyReviewedQuoteExclusionSeeds(projectIds, client.query.bind(client));
  } else {
    await reprojectImportedJobCategories(projectIds, client.query.bind(client));
  }
}

async function reusableProjectIds(
  client: BulkBootstrapQueryClient,
  family: "jobs" | "quotes",
  projects: BulkProjectRow[],
  costCenters: AllocatedCostCenterRow[],
  labor: FlattenedBulkProjectPage["labor"],
  items: BulkProjectItemRow[],
) {
  // Quote import is also the source-backed repair path for mutable category
  // projections and reviewed exclusions, so it must remain fully replayable.
  if (family === "quotes") return new Set<number>();

  const counts = new Map<number, { costCenters: number; labor: number; items: number }>();
  for (const project of projects) {
    counts.set(project.projectId, { costCenters: 0, labor: 0, items: 0 });
  }
  for (const row of costCenters) counts.get(row.projectId)!.costCenters += 1;
  for (const row of labor) counts.get(row.projectId)!.labor += 1;
  for (const row of items) counts.get(row.projectId)!.items += 1;

  const expected = projects.map((project) => ({
    project_id: project.projectId,
    source_hash: project.sourceHash,
    cost_centers: counts.get(project.projectId)!.costCenters,
    labor: counts.get(project.projectId)!.labor,
    items: counts.get(project.projectId)!.items,
  }));
  const idColumn = family === "jobs" ? "job_id" : "quote_id";
  const rootTable = family === "jobs" ? "metrics.metrics_jobs" : "metrics.metrics_quotes";
  const snapshotTable = family === "jobs" ? "metrics.job_snapshots" : "metrics.quote_snapshots";
  const costCenterTable = family === "jobs" ? "metrics.metrics_job_cost_centers" : "metrics.metrics_quote_cost_centers";
  const laborTable = family === "jobs" ? "metrics.metrics_job_labor" : "metrics.metrics_quote_labor";
  const itemTable = family === "jobs" ? "metrics.metrics_job_items" : "metrics.metrics_quote_items";
  const result = await client.query<{ project_id: string }>(
    `with expected as materialized (
       select project_id, source_hash, cost_centers, labor, items
         from jsonb_to_recordset($1::jsonb) as row(
           project_id bigint, source_hash text, cost_centers integer, labor integer, items integer
         )
     ), cost_center_counts as (
       select ${idColumn} as project_id, count(*)::integer as count
         from ${costCenterTable}
        where source_deleted_at is null and ${idColumn} = any($2::bigint[])
        group by ${idColumn}
     ), labor_counts as (
       select ${idColumn} as project_id, count(*)::integer as count
         from ${laborTable}
        where source_deleted_at is null and ${idColumn} = any($2::bigint[])
        group by ${idColumn}
     ), item_counts as (
       select ${idColumn} as project_id, count(*)::integer as count
         from ${itemTable}
        where source_deleted_at is null and ${idColumn} = any($2::bigint[])
        group by ${idColumn}
     )
     select expected.project_id::text
       from expected
       join ${rootTable} root
         on root.${idColumn} = expected.project_id
        and root.source_deleted_at is null
       join metrics.raw_simpro_snapshots current_raw
         on current_raw.id = root.source_snapshot_id
        and current_raw.source_deleted_at is null
       join metrics.raw_simpro_snapshots bulk_raw
         on bulk_raw.entity_type = $3
        and bulk_raw.entity_id = expected.project_id::text
        and bulk_raw.source_hash = expected.source_hash
        and bulk_raw.complete_traversal = true
        and bulk_raw.source_deleted_at is null
       join ${snapshotTable} snapshot
         on snapshot.${idColumn} = expected.project_id
        and snapshot.source_snapshot_id = current_raw.id
       left join cost_center_counts on cost_center_counts.project_id = expected.project_id
       left join labor_counts on labor_counts.project_id = expected.project_id
       left join item_counts on item_counts.project_id = expected.project_id
      where coalesce(cost_center_counts.count, 0) = expected.cost_centers
        and coalesce(labor_counts.count, 0) = expected.labor
        and coalesce(item_counts.count, 0) = expected.items`,
    [JSON.stringify(expected), projects.map((project) => project.projectId), family],
  );
  return new Set(result.rows.map((row) => Number(row.project_id)));
}

async function insertRawSnapshots(
  client: BulkBootstrapQueryClient,
  artifact: VerifiedBulkArtifact,
  run: BootstrapRun,
  rows: Array<{ payload: Record<string, unknown>; project: BulkProjectRow }>,
) {
  await client.query(
    `insert into metrics.raw_simpro_snapshots (
       entity_type, entity_id, source_path, payload, source_hash, source_updated_at,
       source_version, ingestion_run_id, complete_traversal, parent_identity, page_window
     )
     select $2, entry->'project'->>'projectId', $3, entry->'payload',
            entry->'project'->>'sourceHash', nullif(entry->'project'->>'sourceModifiedAt', '')::timestamptz,
            $4, $5, true,
            jsonb_build_object('projectType', entry->'project'->>'projectType', 'projectId', entry->'project'->>'projectId'),
            $6::jsonb
       from jsonb_array_elements($1::jsonb) entry
     on conflict (entity_type, entity_id, source_hash) do update set
       ingestion_run_id = excluded.ingestion_run_id,
       complete_traversal = true,
       parent_identity = excluded.parent_identity,
       page_window = excluded.page_window,
       source_deleted_at = null`,
    [
      JSON.stringify(rows),
      run.family,
      `simpro:/${run.family}/?display=all`,
      `bulk-bootstrap:${artifact.manifestSha256}`,
      run.runId,
      JSON.stringify({
        manifestSha256: artifact.manifestSha256,
        artifactSha256: artifact.sources[run.family].sha256,
        completeTraversal: true,
      }),
    ],
  );
}

async function upsertPeople(client: BulkBootstrapQueryClient, rows: FlattenedBulkProjectPage["people"]) {
  await client.query(
    `insert into metrics.dim_people (simpro_employee_id, display_name, role_type, active, last_seen_at)
     select (entry->>'personId')::bigint,
            coalesce(nullif(entry->>'personName', ''), 'Employee ' || (entry->>'personId')),
            entry->>'role', true, now()
       from jsonb_array_elements($1::jsonb) entry
     on conflict (simpro_employee_id) do update set
       display_name = case
         when excluded.display_name ~* '^Employee [0-9]+$'
           and metrics.dim_people.display_name !~* '^Employee [0-9]+$' then metrics.dim_people.display_name
         else excluded.display_name
       end,
       role_type = case when metrics.dim_people.role_type = 'unknown' then excluded.role_type else metrics.dim_people.role_type end,
       active = true,
       last_seen_at = now()`,
    [JSON.stringify(rows)],
  );
}

async function upsertQuotes(
  client: BulkBootstrapQueryClient,
  artifact: VerifiedBulkArtifact,
  rows: BulkProjectRow[],
) {
  const version = `bulk-bootstrap:${artifact.manifestSha256}`;
  await client.query(
    `with source_rows as (
       select entry as row from jsonb_array_elements($1::jsonb) entry
     ), facts as (
       select row,
              (row->>'projectId')::bigint as quote_id,
              (row->>'totalExTax')::numeric as total,
              snapshot.id as snapshot_id
         from source_rows
         join metrics.raw_simpro_snapshots snapshot
           on snapshot.entity_type = 'quotes'
          and snapshot.entity_id = row->>'projectId'
          and snapshot.source_hash = row->>'sourceHash'
     )
     insert into metrics.metrics_quotes (
       quote_id, quote_no, date_issued, date_approved, stage, customer_stage,
       salesperson_id, salesperson_name, total, linked_job_id, job_no, won_reason,
       category, source_snapshot_id, source_hash, source_version, fetched_at,
       name, description, status_id, status_name, is_closed, outcome, outcome_reason,
       deal_tier, category_basis, source_deleted_at, updated_from_source_at
     )
     select quote_id, coalesce(nullif(row->>'quoteNo', ''), row->>'projectNo'),
            nullif(row->>'dateIssued', '')::date, nullif(row->>'dateApproved', '')::date,
            nullif(row->>'stageName', ''), nullif(row->>'customerStageName', ''),
            nullif(row->>'salespersonId', '')::bigint, nullif(row->>'salespersonName', ''),
            total,
            coalesce(nullif(row->>'linkedJobId', '')::bigint, nullif(row->>'conversionJobId', '')::bigint),
            nullif(row->>'jobNo', ''), coalesce(nullif(row->>'quoteOutcomeReason', ''), 'unknown_stage'),
            coalesce(nullif(row->>'category', ''), 'Unclassified'), snapshot_id,
            row->>'sourceHash', $2, nullif(row->>'fetchedAt', '')::timestamptz,
            coalesce(nullif(row->>'name', ''), nullif(row->>'description', ''), 'Quote ' || quote_id),
            nullif(row->>'description', ''), nullif(row->>'statusId', '')::bigint,
            nullif(row->>'statusName', ''), nullif(row->>'isClosed', '')::boolean,
            coalesce(nullif(row->>'quoteOutcome', ''), 'unknown'),
            coalesce(nullif(row->>'quoteOutcomeReason', ''), 'unknown_stage'),
            case when total < 750 then 'Under $750'
                 when total < 2000 then '$750-$2K'
                 when total < 10000 then '$2K-$10K' else '$10K+' end,
            'complete Simpro display=all nested traversal', null, now()
       from facts
     on conflict (quote_id) do update set
       quote_no = excluded.quote_no,
       date_issued = excluded.date_issued,
       date_approved = excluded.date_approved,
       stage = excluded.stage,
       customer_stage = excluded.customer_stage,
       salesperson_id = excluded.salesperson_id,
       salesperson_name = excluded.salesperson_name,
       total = excluded.total,
       linked_job_id = excluded.linked_job_id,
       job_no = excluded.job_no,
       won_reason = case when exists (
         select 1 from metrics.quote_classification_overrides o
          where o.quote_id = excluded.quote_id and o.active = true
       ) then metrics.metrics_quotes.won_reason else excluded.won_reason end,
       category = excluded.category,
       source_snapshot_id = excluded.source_snapshot_id,
       source_hash = excluded.source_hash,
       source_version = excluded.source_version,
       fetched_at = excluded.fetched_at,
       name = excluded.name,
       description = excluded.description,
       status_id = excluded.status_id,
       status_name = excluded.status_name,
       is_closed = excluded.is_closed,
       outcome = case when exists (
         select 1 from metrics.quote_classification_overrides o
          where o.quote_id = excluded.quote_id and o.active = true
       ) then metrics.metrics_quotes.outcome else excluded.outcome end,
       outcome_reason = case when exists (
         select 1 from metrics.quote_classification_overrides o
          where o.quote_id = excluded.quote_id and o.active = true
       ) then metrics.metrics_quotes.outcome_reason else excluded.outcome_reason end,
       deal_tier = excluded.deal_tier,
       category_basis = excluded.category_basis,
       source_deleted_at = null,
       updated_from_source_at = now()`,
    [JSON.stringify(rows), version],
  );
  await client.query(
    `insert into metrics.quote_snapshots (
       quote_id, quote_no, name, status_name, stage_name, customer_stage_name,
       salesperson_id, salesperson_name, owner_name, linked_job_id, job_no,
       date_issued, date_approved, total_value, won_value, deal_tier, category,
       category_basis, won, win_loss_reason, source_snapshot_id, updated_at
     )
     select quote_id, quote_no, name, status_name, stage, customer_stage,
            salesperson_id, salesperson_name, null, linked_job_id, job_no,
            date_issued, date_approved, total,
            case when outcome = 'won' then total else 0 end,
            deal_tier, category, category_basis, outcome = 'won', outcome_reason,
            source_snapshot_id, now()
       from metrics.metrics_quotes
      where quote_id = any($1::bigint[])
     on conflict (quote_id) do update set
       quote_no = excluded.quote_no, name = excluded.name, status_name = excluded.status_name,
       stage_name = excluded.stage_name, customer_stage_name = excluded.customer_stage_name,
       salesperson_id = excluded.salesperson_id, salesperson_name = excluded.salesperson_name,
       owner_name = null, linked_job_id = excluded.linked_job_id, job_no = excluded.job_no,
       date_issued = excluded.date_issued, date_approved = excluded.date_approved,
       total_value = excluded.total_value, won_value = excluded.won_value,
       deal_tier = excluded.deal_tier, category = excluded.category,
       category_basis = excluded.category_basis, won = excluded.won,
       win_loss_reason = excluded.win_loss_reason, source_snapshot_id = excluded.source_snapshot_id,
       updated_at = now()`,
    [rows.map((row) => row.projectId)],
  );
}

async function upsertJobs(
  client: BulkBootstrapQueryClient,
  artifact: VerifiedBulkArtifact,
  rows: BulkProjectRow[],
) {
  const version = `bulk-bootstrap:${artifact.manifestSha256}`;
  await client.query(
    `with source_rows as (
       select entry as row from jsonb_array_elements($1::jsonb) entry
     ), facts as (
       select row, (row->>'projectId')::bigint as job_id, snapshot.id as snapshot_id
         from source_rows
         join metrics.raw_simpro_snapshots snapshot
           on snapshot.entity_type = 'jobs'
          and snapshot.entity_id = row->>'projectId'
          and snapshot.source_hash = row->>'sourceHash'
     )
     insert into metrics.metrics_jobs (
       job_id, job_no, completed_date, stage, customer_id, site_id, total,
       gross_profit_actual, gross_margin_actual, converted_from_type, converted_from_id,
       category, source_snapshot_id, source_hash, source_version, fetched_at,
       name, description, status_id, status_name, converted_from_at,
       source_deleted_at, updated_from_source_at
     )
     select job_id, coalesce(nullif(row->>'jobNo', ''), row->>'projectNo'),
            nullif(row->>'completedDate', '')::date, nullif(row->>'stageName', ''),
            nullif(row->>'customerId', '')::bigint, nullif(row->>'siteId', '')::bigint,
            (row->>'totalExTax')::numeric,
            nullif(row->>'grossProfitActual', '')::numeric,
            nullif(row->>'grossMarginActual', '')::numeric,
            case when nullif(row->>'sourceQuoteId', '') is null then null else 'quote' end,
            nullif(row->>'sourceQuoteId', '')::bigint,
            coalesce(nullif(row->>'category', ''), 'Unclassified'), snapshot_id,
            row->>'sourceHash', $2, nullif(row->>'fetchedAt', '')::timestamptz,
            coalesce(nullif(row->>'name', ''), nullif(row->>'description', ''), 'Job ' || job_id),
            nullif(row->>'description', ''), nullif(row->>'statusId', '')::bigint,
            nullif(row->>'statusName', ''), nullif(row->>'convertedFromAt', '')::timestamptz,
            null, now()
       from facts
     on conflict (job_id) do update set
       job_no = excluded.job_no, completed_date = excluded.completed_date, stage = excluded.stage,
       customer_id = excluded.customer_id, site_id = excluded.site_id, total = excluded.total,
       gross_profit_actual = excluded.gross_profit_actual, gross_margin_actual = excluded.gross_margin_actual,
       converted_from_type = excluded.converted_from_type, converted_from_id = excluded.converted_from_id,
       category = excluded.category, source_snapshot_id = excluded.source_snapshot_id,
       source_hash = excluded.source_hash, source_version = excluded.source_version,
       fetched_at = excluded.fetched_at, name = excluded.name, description = excluded.description,
       status_id = excluded.status_id, status_name = excluded.status_name,
       converted_from_at = excluded.converted_from_at, source_deleted_at = null,
       updated_from_source_at = now()`,
    [JSON.stringify(rows), version],
  );
  await client.query(
    `with source_rows as (
       select entry as row from jsonb_array_elements($1::jsonb) entry
     )
     insert into metrics.job_snapshots (
       job_id, job_no, name, status_name, stage_name, completed_date,
       customer_id, customer_name, site_id, site_name, source_quote_id,
       sell_value, cost_value, gross_profit, gross_margin_percent,
       labor_quoted_hours, labor_actual_hours, labor_coverage, material_coverage,
       source_snapshot_id, updated_at
     )
     select j.job_id, j.job_no, j.name, j.status_name, j.stage, j.completed_date,
            j.customer_id, nullif(row->>'customerName', ''), j.site_id, nullif(row->>'siteName', ''),
            j.converted_from_id, j.total,
            case when nullif(row->>'materialsCostActual', '') is null
                   and nullif(row->>'resourcesCostActual', '') is null then null
                 else coalesce(nullif(row->>'materialsCostActual', '')::numeric, 0)
                    + coalesce(nullif(row->>'resourcesCostActual', '')::numeric, 0) end,
            j.gross_profit_actual, j.gross_margin_actual,
            nullif(row->>'laborHoursEstimate', '')::numeric,
            nullif(row->>'laborHoursActual', '')::numeric,
            case when nullif(row->>'laborHoursEstimate', '') is null then 'unknown' else 'nested_labor_complete' end,
            'nested_items_complete', j.source_snapshot_id, now()
       from source_rows
       join metrics.metrics_jobs j on j.job_id = (row->>'projectId')::bigint
     on conflict (job_id) do update set
       job_no = excluded.job_no, name = excluded.name, status_name = excluded.status_name,
       stage_name = excluded.stage_name, completed_date = excluded.completed_date,
       customer_id = excluded.customer_id, customer_name = excluded.customer_name,
       site_id = excluded.site_id, site_name = excluded.site_name,
       source_quote_id = excluded.source_quote_id, sell_value = excluded.sell_value,
       cost_value = excluded.cost_value, gross_profit = excluded.gross_profit,
       gross_margin_percent = excluded.gross_margin_percent,
       labor_quoted_hours = excluded.labor_quoted_hours, labor_actual_hours = excluded.labor_actual_hours,
       labor_coverage = excluded.labor_coverage, material_coverage = excluded.material_coverage,
       source_snapshot_id = excluded.source_snapshot_id, updated_at = now()`,
    [JSON.stringify(rows)],
  );
}

async function markExistingNestedRowsDeleted(
  client: BulkBootstrapQueryClient,
  family: "jobs" | "quotes",
  projectIds: number[],
) {
  const idColumn = family === "jobs" ? "job_id" : "quote_id";
  const costCenterTable = family === "jobs" ? "metrics.metrics_job_cost_centers" : "metrics.metrics_quote_cost_centers";
  const laborTable = family === "jobs" ? "metrics.metrics_job_labor" : "metrics.metrics_quote_labor";
  const itemTable = family === "jobs" ? "metrics.metrics_job_items" : "metrics.metrics_quote_items";
  await client.query(
    `update ${costCenterTable}
        set source_deleted_at = coalesce(source_deleted_at, now()), updated_from_source_at = now()
      where ${idColumn} = any($1::bigint[])`,
    [projectIds],
  );
  await client.query(
    `update ${laborTable}
        set source_deleted_at = coalesce(source_deleted_at, now()), fetched_at = now()
      where ${idColumn} = any($1::bigint[])`,
    [projectIds],
  );
  await client.query(
    `update ${itemTable}
        set source_deleted_at = coalesce(source_deleted_at, now()), fetched_at = now()
      where ${idColumn} = any($1::bigint[])`,
    [projectIds],
  );
}

async function upsertCostCenters(
  client: BulkBootstrapQueryClient,
  family: "jobs" | "quotes",
  rows: AllocatedCostCenterRow[],
) {
  if (family === "quotes") {
    await client.query(
      `with rows as (select entry as row from jsonb_array_elements($1::jsonb) entry)
       insert into metrics.metrics_quote_cost_centers (
         quote_id, section_id, cost_center_id, configured_cost_center_id, name, category,
         labor_hours, sell_value, cost_value, gross_profit_actual, gross_margin_actual,
         source_snapshot_id, source_hash, source_deleted_at, fetched_at, updated_from_source_at
       )
       select (row->>'projectId')::bigint, (row->>'sectionId')::bigint,
              (row->>'costCenterId')::bigint, nullif(row->>'configuredCostCenterId', '')::bigint,
              nullif(row->>'costCenterName', ''), coalesce(nullif(row->>'category', ''), 'Unclassified'),
              nullif(row->>'laborHours', '')::numeric, nullif(row->>'sellValue', '')::numeric,
              nullif(row->>'costValue', '')::numeric, null, null,
              snapshot.id, row->>'sourceHash', null, nullif(row->>'fetchedAt', '')::timestamptz, now()
         from rows
         join metrics.raw_simpro_snapshots snapshot
           on snapshot.entity_type = 'quotes' and snapshot.entity_id = row->>'projectId'
          and snapshot.source_hash = row->>'projectSourceHash'
       on conflict (quote_id, section_id, cost_center_id) do update set
         configured_cost_center_id = excluded.configured_cost_center_id, name = excluded.name,
         category = excluded.category, labor_hours = excluded.labor_hours,
         sell_value = excluded.sell_value, cost_value = excluded.cost_value,
         gross_profit_actual = excluded.gross_profit_actual, gross_margin_actual = excluded.gross_margin_actual,
         source_snapshot_id = excluded.source_snapshot_id, source_hash = excluded.source_hash,
         source_deleted_at = null, fetched_at = excluded.fetched_at, updated_from_source_at = now()`,
      [JSON.stringify(rows)],
    );
    return;
  }
  await client.query(
    `with rows as (select entry as row from jsonb_array_elements($1::jsonb) entry)
     insert into metrics.metrics_job_cost_centers (
       job_id, section_id, cost_center_id, configured_cost_center_id, name, category,
       labor_quoted_hours, material_sell_value, material_cost_value, sell_value, cost_value,
       gross_profit_actual, gross_margin_actual, source_snapshot_id, source_hash,
       source_deleted_at, fetched_at, updated_from_source_at
     )
     select (row->>'projectId')::bigint, (row->>'sectionId')::bigint,
            (row->>'costCenterId')::bigint, nullif(row->>'configuredCostCenterId', '')::bigint,
            nullif(row->>'costCenterName', ''), coalesce(nullif(row->>'category', ''), 'Unclassified'),
            nullif(row->>'laborHours', '')::numeric, nullif(row->>'materialSellValue', '')::numeric,
            nullif(row->>'materialCostValue', '')::numeric, nullif(row->>'sellValue', '')::numeric,
            nullif(row->>'costValue', '')::numeric, nullif(row->>'grossProfitAllocated', '')::numeric,
            nullif(row->>'grossMarginAllocated', '')::numeric, snapshot.id, row->>'sourceHash',
            null, nullif(row->>'fetchedAt', '')::timestamptz, now()
       from rows
       join metrics.raw_simpro_snapshots snapshot
         on snapshot.entity_type = 'jobs' and snapshot.entity_id = row->>'projectId'
        and snapshot.source_hash = row->>'projectSourceHash'
     on conflict (job_id, section_id, cost_center_id) do update set
       configured_cost_center_id = excluded.configured_cost_center_id, name = excluded.name,
       category = excluded.category, labor_quoted_hours = excluded.labor_quoted_hours,
       material_sell_value = excluded.material_sell_value, material_cost_value = excluded.material_cost_value,
       sell_value = excluded.sell_value, cost_value = excluded.cost_value,
       gross_profit_actual = excluded.gross_profit_actual, gross_margin_actual = excluded.gross_margin_actual,
       source_snapshot_id = excluded.source_snapshot_id, source_hash = excluded.source_hash,
       source_deleted_at = null, fetched_at = excluded.fetched_at, updated_from_source_at = now()`,
    [JSON.stringify(rows)],
  );
}

async function upsertLabor(
  client: BulkBootstrapQueryClient,
  family: "jobs" | "quotes",
  rows: FlattenedBulkProjectPage["labor"],
) {
  const table = family === "jobs" ? "metrics.metrics_job_labor" : "metrics.metrics_quote_labor";
  const idColumn = family === "jobs" ? "job_id" : "quote_id";
  await client.query(
    `with rows as (select entry as row from jsonb_array_elements($1::jsonb) entry)
     insert into ${table} (
       ${idColumn}, section_id, cost_center_id, labor_id, labor_type_id, labor_type_name,
       quantity_hours, sell_ex_tax, actual_cost, source_snapshot_id, source_hash,
       source_deleted_at, fetched_at
     )
     select (row->>'projectId')::bigint, (row->>'sectionId')::bigint,
            (row->>'costCenterId')::bigint, (row->>'laborId')::bigint,
            nullif(row->>'laborTypeId', '')::bigint, nullif(row->>'laborTypeName', ''),
            nullif(row->>'quantityHours', '')::numeric, nullif(row->>'sellExTax', '')::numeric,
            nullif(row->>'actualCost', '')::numeric, snapshot.id, row->>'sourceHash',
            null, nullif(row->>'fetchedAt', '')::timestamptz
       from rows
       join metrics.raw_simpro_snapshots snapshot
         on snapshot.entity_type = $2 and snapshot.entity_id = row->>'projectId'
        and snapshot.source_hash = row->>'projectSourceHash'
     on conflict (${idColumn}, section_id, cost_center_id, labor_id) do update set
       labor_type_id = excluded.labor_type_id, labor_type_name = excluded.labor_type_name,
       quantity_hours = excluded.quantity_hours, sell_ex_tax = excluded.sell_ex_tax,
       actual_cost = excluded.actual_cost, source_snapshot_id = excluded.source_snapshot_id,
       source_hash = excluded.source_hash, source_deleted_at = null, fetched_at = excluded.fetched_at`,
    [JSON.stringify(rows), family],
  );
}

async function upsertItems(
  client: BulkBootstrapQueryClient,
  family: "jobs" | "quotes",
  rows: BulkProjectItemRow[],
) {
  const table = family === "jobs" ? "metrics.metrics_job_items" : "metrics.metrics_quote_items";
  const idColumn = family === "jobs" ? "job_id" : "quote_id";
  await client.query(
    `with rows as (select entry as row from jsonb_array_elements($1::jsonb) entry)
     insert into ${table} (
       ${idColumn}, section_id, cost_center_id, item_type, item_id, source_item_id,
       description, quantity, billable_status, sell_ex_tax, estimated_cost, actual_cost,
       source_snapshot_id, source_hash, source_deleted_at, fetched_at
     )
     select (row->>'projectId')::bigint, (row->>'sectionId')::bigint,
            (row->>'costCenterId')::bigint, row->>'itemType', row->>'itemId',
            nullif(row->>'sourceItemId', '')::bigint,
            coalesce(nullif(row->>'description', ''), nullif(row->>'sourceItemName', ''), nullif(row->>'sourceItemPartNo', '')),
            nullif(row->>'quantity', '')::numeric, nullif(row->>'billableStatus', ''),
            nullif(row->>'sellExTax', '')::numeric, nullif(row->>'estimatedCost', '')::numeric,
            nullif(row->>'actualCost', '')::numeric, snapshot.id, row->>'sourceHash',
            null, nullif(row->>'fetchedAt', '')::timestamptz
       from rows
       join metrics.raw_simpro_snapshots snapshot
         on snapshot.entity_type = $2 and snapshot.entity_id = row->>'projectId'
        and snapshot.source_hash = row->>'projectSourceHash'
     on conflict (${idColumn}, section_id, cost_center_id, item_type, item_id) do update set
       source_item_id = excluded.source_item_id, description = excluded.description,
       quantity = excluded.quantity, billable_status = excluded.billable_status,
       sell_ex_tax = excluded.sell_ex_tax, estimated_cost = excluded.estimated_cost,
       actual_cost = excluded.actual_cost, source_snapshot_id = excluded.source_snapshot_id,
       source_hash = excluded.source_hash, source_deleted_at = null, fetched_at = excluded.fetched_at`,
    [JSON.stringify(rows), family],
  );
}

async function finalizeAuthoritativeSource(
  client: BulkBootstrapQueryClient,
  artifact: VerifiedBulkArtifact,
  source: VerifiedBulkSource,
): Promise<number> {
  const idColumn = source.family === "jobs" ? "job_id" : "quote_id";
  const rootTable = source.family === "jobs" ? "metrics.metrics_jobs" : "metrics.metrics_quotes";
  const snapshotTable = source.family === "jobs" ? "metrics.job_snapshots" : "metrics.quote_snapshots";
  const nestedFamily = source.family === "jobs" ? "job_nested" : "quote_nested";
  const windowPredicate = source.family === "jobs" ? "and completed_date >= $2::date" : "";
  await client.query(
    `with deleted as (
       update ${rootTable}
          set source_deleted_at = coalesce(source_deleted_at, now()), updated_from_source_at = now()
        where source_deleted_at is null
          ${windowPredicate}
          and not (${idColumn} = any($1::bigint[]))
        returning ${idColumn}
     )
     delete from ${snapshotTable} snapshot
      using deleted
      where snapshot.${idColumn} = deleted.${idColumn}`,
    source.family === "jobs" ? [source.exactIds, artifact.manifest.startDate] : [source.exactIds],
  );
  await client.query(
    `update metrics.raw_simpro_snapshots raw
        set source_deleted_at = coalesce(raw.source_deleted_at, now())
      where raw.entity_type = $1
        and exists (
          select 1 from ${rootTable} root
           where root.${idColumn}::text = raw.entity_id and root.source_deleted_at is not null
        )`,
    [source.family],
  );
  const cancelled = await client.query(
    `update metrics.ingestion_jobs
        set status = 'cancelled'::metrics.ingestion_job_status,
            locked_by = null, locked_at = null, lock_expires_at = null, heartbeat_at = null,
            completed_at = coalesce(completed_at, now()),
            last_error = $3, updated_at = now()
      where entity_type = $1::metrics.ingestion_entity_type
        and status = 'queued'
        and params->>'entityId' ~ '^[0-9]+$'
        and (params->>'entityId')::bigint = any($2::bigint[])`,
    [nestedFamily, source.exactIds, `Superseded by verified bulk bootstrap ${artifact.manifestSha256}`],
  );
  if (source.family !== "jobs") {
    return requiredRowCount(cancelled.rowCount, `${source.family} covered nested cancellation`);
  }
  const outOfScope = await client.query(
    `update metrics.ingestion_jobs queued
        set status = 'cancelled'::metrics.ingestion_job_status,
            locked_by = null, locked_at = null, lock_expires_at = null, heartbeat_at = null,
            completed_at = coalesce(completed_at, now()),
            last_error = $2, updated_at = now()
      where queued.entity_type = 'job_nested'
        and queued.status = 'queued'
        and queued.params->>'entityId' ~ '^[0-9]+$'
        and not exists (
          select 1 from metrics.metrics_jobs job
           where job.job_id = (queued.params->>'entityId')::bigint
             and job.source_deleted_at is null
             and job.completed_date >= $1::date
        )`,
    [artifact.manifest.startDate, `Outside approved serving window after bulk bootstrap ${artifact.manifestSha256}`],
  );
  return requiredRowCount(cancelled.rowCount, "jobs covered nested cancellation")
    + requiredRowCount(outOfScope.rowCount, "jobs out-of-scope nested cancellation");
}

async function completeBootstrapRun(
  client: BulkBootstrapQueryClient,
  run: BootstrapRun,
  sourceSha256: string,
) {
  await client.query(
    `update metrics.ingestion_runs
        set status = 'succeeded'::metrics.ingestion_job_status,
            finished_at = now(), request_count = $2, snapshot_count = $3,
            normalized_count = $3, source_hash = $4, error_message = null
      where id = $1`,
    [run.runId, run.requestCount, run.rowCount, sourceSha256],
  );
  await client.query(
    `update metrics.ingestion_jobs
        set status = 'succeeded'::metrics.ingestion_job_status,
            requests_used = $2, locked_by = null, locked_at = null,
            lock_expires_at = null, heartbeat_at = null, attempts = 0,
            last_error = null, dead_lettered_at = null, completed_at = now(), updated_at = now()
      where id = $1`,
    [run.jobId, run.requestCount],
  );
}

async function enqueueBootstrapRollups(
  client: BulkBootstrapQueryClient,
  artifact: VerifiedBulkArtifact,
): Promise<number> {
  const result = await client.query(
    `with periods as (
       select generate_series(
         date_trunc('month', $1::date),
         date_trunc('month', now() at time zone 'America/Los_Angeles'),
         interval '1 month'
       )::date as period_start
     ), requests as (
       select scope, period_start
         from periods
         cross join unnest(array['quotes','jobs','technicians','commissions']) scope
     )
     insert into metrics.rollup_rebuild_queue (
       metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
     )
     select scope, 'month', period_start, '{}'::jsonb,
            'verified Simpro bulk bootstrap',
            'bulk-bootstrap:' || $2 || ':' || scope || ':' || period_start::text
       from requests
     on conflict (idempotency_key) do nothing`,
    [artifact.manifest.startDate, artifact.manifestSha256],
  );
  return requiredRowCount(result.rowCount, "bootstrap rollup enqueue");
}

async function readCanonicalCounts(client: BulkBootstrapQueryClient) {
  const result = await client.query<Record<string, number>>(
    `select
       (select count(*)::int from metrics.metrics_quotes where source_deleted_at is null) as quotes,
       (select count(*)::int from metrics.metrics_jobs where source_deleted_at is null and completed_date >= date '2023-01-01') as jobs,
       (select count(*)::int from metrics.metrics_quote_cost_centers where source_deleted_at is null) as quote_cost_centers,
       (select count(*)::int from metrics.metrics_job_cost_centers where source_deleted_at is null) as job_cost_centers,
       (select count(*)::int from metrics.metrics_quote_labor where source_deleted_at is null) as quote_labor,
       (select count(*)::int from metrics.metrics_job_labor where source_deleted_at is null) as job_labor,
       (select count(*)::int from metrics.metrics_quote_items where source_deleted_at is null) as quote_items,
       (select count(*)::int from metrics.metrics_job_items where source_deleted_at is null) as job_items`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("Canonical count query returned no row");
  return row;
}

export function allocateJobGrossProfit(
  projects: BulkProjectRow[],
  costCenters: BulkProjectCostCenterRow[],
  items: BulkProjectItemRow[],
): AllocatedCostCenterRow[] {
  const projectById = new Map(projects.map((project) => [project.projectId, project]));
  const itemsByCostCenter = new Map<string, BulkProjectItemRow[]>();
  for (const item of items) {
    const key = `${item.projectId}:${item.sectionId}:${item.costCenterId}`;
    const existing = itemsByCostCenter.get(key) ?? [];
    existing.push(item);
    itemsByCostCenter.set(key, existing);
  }
  const rowsByProject = new Map<number, BulkProjectCostCenterRow[]>();
  for (const row of costCenters) {
    const existing = rowsByProject.get(row.projectId) ?? [];
    existing.push(row);
    rowsByProject.set(row.projectId, existing);
  }

  const allocated = new Map<string, { profit: number | null; margin: number | null }>();
  for (const [projectId, rows] of rowsByProject) {
    const project = projectById.get(projectId);
    if (project?.projectType !== "job" || project.grossProfitActual === null) continue;
    const sellRows = rows.filter(
      (row): row is BulkProjectCostCenterRow & { sellValue: number } => row.sellValue !== null,
    );
    const totalSell = sellRows.reduce((sum, row) => sum + row.sellValue, 0);
    if (sellRows.length === 0) continue;
    let assigned = 0;
    for (let index = 0; index < sellRows.length; index += 1) {
      const row = sellRows[index];
      const isLast = index === sellRows.length - 1;
      const profit = totalSell === 0
        ? rows.length === 1 ? project.grossProfitActual : null
        : isLast
          ? roundMoney(project.grossProfitActual - assigned)
          : roundMoney(project.grossProfitActual * row.sellValue / totalSell);
      if (profit !== null) assigned = roundMoney(assigned + profit);
      allocated.set(costCenterIdentity(row), {
        profit,
        margin: profit !== null && row.sellValue !== null && row.sellValue !== 0
          ? roundMoney(profit / row.sellValue * 100)
          : null,
      });
    }
  }

  return costCenters.map((row) => {
    const itemRows = itemsByCostCenter.get(`${row.projectId}:${row.sectionId}:${row.costCenterId}`) ?? [];
    const itemSellValues = itemRows.map((item) => item.sellExTax).filter((value): value is number => value !== null);
    const allocation = allocated.get(costCenterIdentity(row));
    return {
      ...row,
      grossProfitAllocated: allocation?.profit ?? null,
      grossMarginAllocated: allocation?.margin ?? null,
      materialSellValue: itemSellValues.length > 0 ? roundMoney(itemSellValues.reduce((sum, value) => sum + value, 0)) : null,
    };
  });
}

function assertBatchIdentity(
  payloads: Record<string, unknown>[],
  projects: BulkProjectRow[],
  family: "jobs" | "quotes",
) {
  if (payloads.length !== projects.length) throw new Error(`${family} flattening changed the project row count`);
  for (let index = 0; index < payloads.length; index += 1) {
    if (positiveInteger(payloads[index].ID, `${family} ID`) !== projects[index].projectId) {
      throw new Error(`${family} flattening changed project order at batch index ${index}`);
    }
  }
}

function assertPageEvidence(
  family: string,
  page: BulkSourceManifest["pages"][number],
  rows: Record<string, unknown>[],
) {
  const firstId = positiveInteger(rows[0]?.ID, `${family} page first ID`);
  const lastId = positiveInteger(rows.at(-1)?.ID, `${family} page last ID`);
  if (page.firstId !== firstId || page.lastId !== lastId || page.responseHash !== sourceHash(rows)) {
    throw new Error(`${family} page ${page.page} evidence does not match its artifact rows`);
  }
}

function countNested(
  row: Record<string, unknown>,
  counts: { sections: number; costCenters: number; labor: number; items: number },
) {
  for (const section of records(row.Sections)) {
    counts.sections += 1;
    for (const costCenter of records(section.CostCenters)) {
      counts.costCenters += 1;
      const items = record(costCenter.Items) ?? costCenter;
      counts.labor += records(items.Labors).length;
      counts.items += ["Catalogs", "Prebuilds", "ServiceFees", "OneOffs", "Stock", "Stocks"]
        .reduce((sum, key) => sum + records(items[key]).length, 0);
    }
  }
}

function recordPeriodIds(
  family: "jobs" | "quotes",
  row: Record<string, unknown>,
  id: number,
  activity: Record<string, number[]>,
  secondary: Record<string, number[]>,
) {
  if (family === "jobs") {
    addPeriodId(activity, row.CompletedDate, id);
    return;
  }
  addPeriodId(activity, row.DateApproved, id);
  addPeriodId(secondary, row.DateIssued, id);
}

function addPeriodId(target: Record<string, number[]>, value: unknown, id: number) {
  const date = dateText(value);
  if (!date) return;
  const month = `${date.slice(0, 7)}-01`;
  (target[month] ??= []).push(id);
}

function assertPeriodIdsMatch(
  family: "jobs" | "quotes",
  field: "activityPeriodIds" | "secondaryPeriodIds",
  derived: Record<string, number[]>,
  declared: Record<string, number[]>,
) {
  if (!record(declared)) throw new Error(`${family} ${field} must be a month-to-ID map`);
  const expected = sortedPeriodIds(derived);
  const actual: Record<string, number[]> = {};
  const expectedMonthById = new Map<number, string[]>();
  for (const [month, ids] of Object.entries(expected)) {
    for (const id of ids) expectedMonthById.set(id, [...(expectedMonthById.get(id) ?? []), month]);
  }

  for (const [month, values] of Object.entries(declared)) {
    if (!/^\d{4}-\d{2}-01$/.test(month) || Number.isNaN(Date.parse(`${month}T00:00:00.000Z`))) {
      throw new Error(`${family} ${field} contains invalid month ${month}`);
    }
    if (!Array.isArray(values)) throw new Error(`${family} ${field}/${month} must be an ID array`);
    const ids = values.map((value) => positiveInteger(value, `${family} ${field}/${month} ID`));
    if (new Set(ids).size !== ids.length) {
      throw new Error(`${family} ${field}/${month} contains duplicate IDs`);
    }
    const sorted = [...ids].sort((left, right) => left - right);
    if (!sameIds(ids, sorted)) throw new Error(`${family} ${field}/${month} IDs are not sorted`);
    for (const id of ids) {
      const expectedMonths = expectedMonthById.get(id);
      if (!expectedMonths) {
        throw new Error(`${family} ${field}/${month} contains extra ID ${id} for this family/date field`);
      }
      if (!expectedMonths.includes(month)) {
        throw new Error(
          `${family} ${field} misplaces ID ${id} in ${month}; parsed JSONL places it in ${expectedMonths.join(", ")}`,
        );
      }
    }
    actual[month] = ids;
  }

  const expectedMonths = Object.keys(expected);
  const actualMonths = Object.keys(actual).sort();
  const missingMonths = expectedMonths.filter((month) => !Object.hasOwn(actual, month));
  const extraMonths = actualMonths.filter((month) => !Object.hasOwn(expected, month));
  if (missingMonths.length > 0 || extraMonths.length > 0) {
    throw new Error(
      `${family} ${field} month coverage mismatch: missing=${missingMonths.join(",") || "none"}; extra=${extraMonths.join(",") || "none"}`,
    );
  }
  for (const month of expectedMonths) {
    if (!sameIds(expected[month], actual[month])) {
      const missingIds = expected[month].filter((id) => !actual[month].includes(id));
      const extraIds = actual[month].filter((id) => !expected[month].includes(id));
      throw new Error(
        `${family} ${field}/${month} ID mismatch: missing=${missingIds.join(",") || "none"}; extra=${extraIds.join(",") || "none"}`,
      );
    }
  }
}

function sortedPeriodIds(value: Record<string, number[]>): Record<string, number[]> {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([month, ids]) => [month, [...ids].sort((left, right) => left - right)]),
  );
}

function parseJsonlBytes(bytes: Uint8Array, file: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const [index, line] of Buffer.from(bytes).toString("utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const value: unknown = JSON.parse(line);
    const row = record(value);
    if (!row) throw new Error(`${file} line ${index + 1} contains a non-object root row`);
    rows.push(row);
  }
  return rows;
}

function itemIdentity(row: BulkProjectItemRow) {
  return `${row.projectId}:${row.sectionId}:${row.costCenterId}:${row.itemType}:${row.itemId}`;
}

function costCenterIdentity(row: BulkProjectCostCenterRow) {
  return `${row.projectId}:${row.sectionId}:${row.costCenterId}`;
}

function dedupeBy<T>(rows: T[], identity: (row: T) => string): T[] {
  return [...new Map(rows.map((row) => [identity(row), row])).values()];
}

function parseChecksumFile(value: string, expectedFile: string) {
  const match = value.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/);
  if (!match || match[2] !== expectedFile) throw new Error(`Invalid checksum file for ${expectedFile}`);
  return match[1];
}

function sameIds(left: readonly number[], right: readonly number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function positiveInteger(value: unknown, label: string) {
  if (
    value === null
    || value === undefined
    || typeof value === "boolean"
    || (typeof value === "string" && !value.trim())
    || (typeof value !== "number" && typeof value !== "string")
  ) {
    throw new Error(`${label} must be a positive integer`);
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function requiredRowCount(value: number | null | undefined, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} did not return a nonnegative row count`);
  }
  return Number(value);
}

function dateText(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function validTimestamp(value: string) {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => record(item) !== null) : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

import { createHash } from "node:crypto";
import {
  bulkEvidencePageSha256,
  bulkEvidenceRequestSha256,
} from "@/lib/store/bulk-bootstrap-evidence";
import { exactSourceIdHash, sortExactSourceIds } from "@/lib/store/exact-source-identities";
import { queryPostgres } from "@/lib/store/postgres";

const SCOPES = ["jobs", "quotes", "technicians"] as const;
const AUDIT_ACTOR = "bulk-dashboard-reconciliation@prostarmechanical.com";
const AUDIT_ACTION = "bulk_dashboard_reconciliations_published";
const AUDIT_ENTITY_TYPE = "dashboard_reconciliation_batch";
const PROJECTION_PROVENANCE = "checksum_verified_full_universe_artifact_projection";
const REQUIRED_SOURCE_MANIFESTS: Record<BulkDashboardReconciliationScope, readonly string[]> = {
  jobs: ["jobs", "job_nested"],
  quotes: ["quotes", "quote_nested"],
  technicians: ["jobs", "job_nested", "employees", "timesheets", "jobs_from_timesheets", "schedules", "mobile_status"],
};
const SOURCE_LIST_METHODS: Record<string, string> = {
  jobs: "listJobs",
  job_nested: "listJobs",
  quotes: "listQuotes",
  quote_nested: "listQuotes",
  employees: "listEmployees",
  timesheets: "listEmployeeTimesheets",
  jobs_from_timesheets: "listEmployeeTimesheets",
  schedules: "listSchedules",
  mobile_status: "listMobileStatus",
};

export type BulkDashboardReconciliationScope = (typeof SCOPES)[number];

export type BulkDashboardReconciliationUnit = {
  scope: BulkDashboardReconciliationScope;
  periodStart: string;
  periodEnd: string;
  rollupValue: number;
  snapshotValue: number;
  upstreamSampleValue: number | null;
  readModelVersion: {
    metricFamily: BulkDashboardReconciliationScope;
    periodGrain: "month";
    periodStart: string;
    dimensionsJson: Record<string, unknown>;
    sourceHash: string | null;
    rebuiltAt: string;
    rebuiltByJobId: string | null;
  };
  detail: Record<string, unknown> & {
    verificationStatus: "matched";
    projectManifestSha256: string;
    operationalManifestSha256: string;
  };
};

export type BulkDashboardReconciliationResult = {
  batchSha256: string;
  periods: number;
  checksPublished: number;
  commissionRollupsQueued: number;
  idempotent: boolean;
};

export type BulkDashboardReconciliationQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: T[]; rowCount?: number | null }>;

export type BulkDashboardReconciliationQueryClient = {
  query: BulkDashboardReconciliationQuery;
};

export type BulkDashboardReconciliationPublicationOptions = {
  transaction?: "managed" | "existing";
};

type SourceManifestRow = {
  work_unit_id: unknown;
  source_family: string;
  coverage_status: string;
  reconciliation_status: string;
  listed_count: unknown;
  detail_count: unknown;
  normalized_count: unknown;
  source_id_hash: string | null;
  normalized_id_hash: string | null;
  manifest_generation: unknown;
  reconciliation_generation: unknown;
  expected_page_count: unknown;
  completed_page_count: unknown;
  reconciled_at: string | null;
  evidence_json: unknown;
  traversal_generation: unknown;
  traversal_status: string;
  traversal_required_target_keys: unknown;
  traversal_completed_target_keys: unknown;
  traversal_exact_source_ids: unknown;
  traversal_listed_source_ids: unknown;
  traversal_detailed_source_ids: unknown;
  traversal_continuation_token: unknown;
  traversal_detail_coverage_required: boolean;
  traversal_page_count: unknown;
  traversal_record_count: unknown;
  traversal_empty_proof: unknown;
  traversal_violations: unknown;
};

type TraversalPageRow = {
  generation: unknown;
  ordinal: unknown;
  target_key: string;
  source_method: string;
  page_number: unknown;
  page_size: unknown;
  row_count: unknown;
  exact_ids: unknown;
  request_query: unknown;
  terminal: boolean;
  continuation_page: unknown;
  response_hash: string;
  synthetic: boolean;
};

/**
 * Publishes only already-verified artifact/canonical/read-model comparisons. Callers
 * that read the source facts in an existing serializable transaction can keep those
 * reads and this compare-and-set publication in one database snapshot.
 */
export async function publishBulkDashboardReconciliations(
  input: readonly BulkDashboardReconciliationUnit[],
  client: BulkDashboardReconciliationQuery | BulkDashboardReconciliationQueryClient = queryPostgres,
  options: BulkDashboardReconciliationPublicationOptions = {},
): Promise<BulkDashboardReconciliationResult> {
  const normalizedUnits = normalizeUnits(input);
  const query = normalizeQuery(client);
  const managedTransaction = options.transaction !== "existing";
  if (managedTransaction) await query("begin isolation level serializable");
  try {
    const units = [];
    for (const unit of normalizedUnits) {
      const authority = await resolveSourceManifestAuthority(query, unit.scope, unit.periodStart);
      units.push({ ...unit, ...authority });
    }
    const batchSha256 = sha256(stableJson(units));
    const periods = [...new Set(units.map((unit) => unit.periodStart))];
    const result: BulkDashboardReconciliationResult = {
      batchSha256,
      periods: periods.length,
      checksPublished: units.length,
      commissionRollupsQueued: periods.length,
      idempotent: false,
    };
    await query("select pg_advisory_xact_lock(hashtext($1))", [`${AUDIT_ENTITY_TYPE}:${batchSha256}`]);
    const existing = await query<{ after_value: unknown }>(
      `select after_value
         from metrics.audit_events
        where action = $1 and entity_type = $2 and entity_id = $3
        order by id desc limit 1`,
      [AUDIT_ACTION, AUDIT_ENTITY_TYPE, batchSha256],
    );
    if (existing.rows[0]) {
      if (managedTransaction) await query("commit");
      return { ...storedResult(existing.rows[0].after_value, result), idempotent: true };
    }

    for (const unit of units) {
      await query(
        `insert into metrics.reconciliation_checks (
           scope, period_start, period_end, rollup_value, snapshot_value,
           upstream_sample_value, status, detail, generation, complete_traversal,
           source_manifest_generations
         ) values (
           $1, $2::date, $3::date, $4, $5, $6, 'matched', $7::jsonb,
           $8, true, $9::jsonb
         )`,
        [
          unit.scope,
          unit.periodStart,
          unit.periodEnd,
          unit.rollupValue,
          unit.snapshotValue,
          unit.upstreamSampleValue,
          JSON.stringify({
            ...unit.detail,
            authority: "checksum_verified_bulk_artifacts",
            batchSha256,
            sourceManifestGenerations: unit.sourceManifestGenerations,
          }),
          unit.generation,
          JSON.stringify(unit.sourceManifestGenerations),
        ],
      );
      const published = await query<{ metric_family: string }>(
        `update metrics.dashboard_read_models
            set last_reconciled_at = now(), suspect_reason = null
          where metric_family = $1
            and period_grain = $2
            and period_start = $3::date
            and dimensions_json = $4::jsonb
            and source_hash is not distinct from $5::text
            and rebuilt_at = $6::timestamptz
            and rebuilt_by_job_id is not distinct from $7::bigint
            and superseded_at is null
          returning metric_family`,
        [
          unit.readModelVersion.metricFamily,
          unit.readModelVersion.periodGrain,
          unit.readModelVersion.periodStart,
          JSON.stringify(unit.readModelVersion.dimensionsJson),
          unit.readModelVersion.sourceHash,
          unit.readModelVersion.rebuiltAt,
          unit.readModelVersion.rebuiltByJobId,
        ],
      );
      if (!published.rows[0]) {
        throw new Error(
          `${unit.scope}/${unit.periodStart} dashboard read model changed after verification or is no longer active.`,
        );
      }
    }

    for (const periodStart of periods) {
      await query(
        `insert into metrics.rollup_rebuild_queue (
           metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
         ) values (
           'commissions', 'month', $1::date, '{}'::jsonb,
           'Verified bulk dashboard reconciliation evidence published', $2
         )
         on conflict (idempotency_key) do update set
           status = case
             when metrics.rollup_rebuild_queue.status = 'running'
              and metrics.rollup_rebuild_queue.locked_until > now()
             then metrics.rollup_rebuild_queue.status
             else 'queued'::metrics.rollup_rebuild_status
           end,
           attempts = case
             when metrics.rollup_rebuild_queue.status = 'running'
              and metrics.rollup_rebuild_queue.locked_until > now()
             then metrics.rollup_rebuild_queue.attempts else 0 end,
           locked_by = case
             when metrics.rollup_rebuild_queue.status = 'running'
              and metrics.rollup_rebuild_queue.locked_until > now()
             then metrics.rollup_rebuild_queue.locked_by else null end,
           locked_until = case
             when metrics.rollup_rebuild_queue.status = 'running'
              and metrics.rollup_rebuild_queue.locked_until > now()
             then metrics.rollup_rebuild_queue.locked_until else null end,
           finished_at = null,
           error_message = null`,
        [periodStart, `commissions:month:${periodStart}:bulk-reconciliation:${batchSha256}`],
      );
    }

    await query(
      `insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason
       ) values ($1, $2, $3, $4, null, $5::jsonb, $6)`,
      [
        AUDIT_ACTOR,
        AUDIT_ACTION,
        AUDIT_ENTITY_TYPE,
        batchSha256,
        JSON.stringify(result),
        "Published month-level checks only after checksum-verified artifacts, canonical tables, snapshots, and dashboard read models matched.",
      ],
    );
    if (managedTransaction) await query("commit");
    return result;
  } catch (error) {
    if (managedTransaction) await query("rollback").catch(() => undefined);
    throw error;
  }
}

async function resolveSourceManifestAuthority(
  query: BulkDashboardReconciliationQuery,
  scope: BulkDashboardReconciliationScope,
  periodStart: string,
) {
  const requiredFamilies = REQUIRED_SOURCE_MANIFESTS[scope];
  const result = await query<SourceManifestRow>(
    `select ledger.id as work_unit_id,
            sp.source_family, sp.coverage_status, sp.reconciliation_status,
            sp.listed_count, sp.detail_count, sp.normalized_count,
            sp.source_id_hash, sp.normalized_id_hash,
            sp.manifest_generation, sp.reconciliation_generation,
            sp.expected_page_count, sp.completed_page_count,
            sp.reconciled_at::text, sp.evidence_json,
            traversal.generation as traversal_generation,
            traversal.manifest_status as traversal_status,
            traversal.required_target_keys as traversal_required_target_keys,
            traversal.completed_target_keys as traversal_completed_target_keys,
            traversal.exact_source_ids as traversal_exact_source_ids,
            traversal.listed_source_ids as traversal_listed_source_ids,
            traversal.detailed_source_ids as traversal_detailed_source_ids,
            traversal.continuation_token as traversal_continuation_token,
            traversal.detail_coverage_required as traversal_detail_coverage_required,
            traversal.page_count as traversal_page_count,
            traversal.record_count as traversal_record_count,
            traversal.empty_proof as traversal_empty_proof,
            traversal.violations as traversal_violations
       from metrics.source_period_manifests sp
       join metrics.backfill_source_month_ledger ledger
         on ledger.source_family = sp.source_family
        and ledger.month_start = sp.period_start
       join metrics.backfill_traversal_manifests traversal
         on traversal.work_unit_id = ledger.id
      where sp.period_start = $1::date
        and sp.source_family = any($2::text[])
      order by sp.source_family
      for share of sp, ledger, traversal`,
    [periodStart, requiredFamilies],
  );
  const byFamily = new Map(result.rows.map((row) => [row.source_family, row]));
  const sourceManifestGenerations: Record<string, number> = {};

  for (const family of requiredFamilies) {
    const row = byFamily.get(family);
    if (!row) throw new Error(`${scope}/${periodStart} is missing required ${family} source-manifest proof.`);
    const manifestGeneration = requiredInteger(row.manifest_generation, `${family} manifest_generation`, 1);
    const reconciliationGeneration = requiredInteger(
      row.reconciliation_generation,
      `${family} reconciliation_generation`,
      1,
    );
    if (manifestGeneration !== reconciliationGeneration) {
      throw new Error(
        `${scope}/${periodStart}/${family} source manifest is stale: `
        + `manifest_generation=${manifestGeneration}, reconciliation_generation=${reconciliationGeneration}.`,
      );
    }
    const expectedPages = requiredInteger(row.expected_page_count, `${family} expected_page_count`, 1);
    const completedPages = requiredInteger(row.completed_page_count, `${family} completed_page_count`, 1);
    if (expectedPages !== completedPages) {
      throw new Error(
        `${scope}/${periodStart}/${family} traversal is incomplete: expected ${expectedPages} pages, completed ${completedPages}.`,
      );
    }
    if (row.coverage_status !== "complete" || row.reconciliation_status !== "matched") {
      throw new Error(
        `${scope}/${periodStart}/${family} source manifest is not complete/matched: `
        + `${row.coverage_status}/${row.reconciliation_status}.`,
      );
    }
    if (!row.reconciled_at || !Number.isFinite(Date.parse(row.reconciled_at))) {
      throw new Error(`${scope}/${periodStart}/${family} source manifest lacks reconciled_at authority.`);
    }
    await validateExactSourceEvidence(
      query,
      scope,
      periodStart,
      family,
      row,
      manifestGeneration,
      expectedPages,
      completedPages,
    );
    sourceManifestGenerations[family] = manifestGeneration;
  }

  const generations = [...new Set(Object.values(sourceManifestGenerations))];
  if (generations.length !== 1) {
    throw new Error(`${scope}/${periodStart} source manifests do not share one reconciled generation.`);
  }
  const generation = generations[0];
  if (!generation || Object.keys(sourceManifestGenerations).length === 0) {
    throw new Error(`${scope}/${periodStart} source-manifest generation proof is empty.`);
  }
  return { generation, sourceManifestGenerations };
}

async function validateExactSourceEvidence(
  query: BulkDashboardReconciliationQuery,
  scope: BulkDashboardReconciliationScope,
  periodStart: string,
  family: string,
  row: SourceManifestRow,
  generation: number,
  expectedPages: number,
  completedPages: number,
) {
  const label = `${scope}/${periodStart}/${family}`;
  if (!isRecord(row.evidence_json)) throw new Error(`${label} evidence_json is not an object.`);
  const evidence = row.evidence_json;
  const exactIds = requiredSourceIds(evidence.exactSourceIds, `${label} exactSourceIds`);
  const listedIds = requiredSourceIds(evidence.listedSourceIds, `${label} listedSourceIds`);
  const detailIds = requiredSourceIds(evidence.periodDetailIds, `${label} periodDetailIds`);
  const normalizedIds = requiredSourceIds(evidence.normalizedSourceIds, `${label} normalizedSourceIds`);
  const listedCount = requiredInteger(row.listed_count, `${family} listed_count`, 0);
  const detailCount = requiredInteger(row.detail_count, `${family} detail_count`, 0);
  const normalizedCount = requiredInteger(row.normalized_count, `${family} normalized_count`, 0);
  if (
    exactIds.length !== listedCount
    || listedIds.length !== listedCount
    || detailIds.length !== detailCount
    || normalizedIds.length !== normalizedCount
  ) {
    throw new Error(`${label} exact ID counts do not match persisted manifest counts.`);
  }
  const exactHash = exactSourceIdHash(exactIds);
  const normalizedHash = exactSourceIdHash(normalizedIds);
  if (
    row.source_id_hash !== exactHash
    || evidence.exactSourceIdHash !== exactHash
    || row.normalized_id_hash !== normalizedHash
    || evidence.normalizedIdHash !== normalizedHash
    || exactHash !== normalizedHash
  ) {
    throw new Error(`${label} exact source ID hashes are missing or inconsistent.`);
  }
  if (
    evidence.manifestGeneration !== generation
    || evidence.reconciliationGeneration !== generation
    || evidence.expectedPageCount !== expectedPages
    || evidence.completedPageCount !== completedPages
    || evidence.publicationState !== "matched"
    || (evidence.manifestStatus !== "completed" && evidence.manifestStatus !== "provisional")
    || typeof evidence.reconciledAt !== "string"
    || Date.parse(evidence.reconciledAt) !== Date.parse(row.reconciled_at!)
    || evidence.authority !== PROJECTION_PROVENANCE
    || !isSha256(evidence.artifactSha256)
    || !isSha256(evidence.manifestSha256)
    || evidence.checksumVerifiedFullUniverseArtifact !== true
    || evidence.fabricatedApiResponse !== false
  ) {
    throw new Error(`${label} generation/page authority does not match its immutable evidence.`);
  }
  if (!Array.isArray(evidence.artifactPages) || evidence.artifactPages.length !== expectedPages) {
    throw new Error(`${label} immutable artifact page proof is absent or incomplete.`);
  }
  const artifactPages = evidence.artifactPages;
  const requiredTargetKeys = requiredSourceIds(evidence.requiredTargetKeys, `${label} requiredTargetKeys`);
  const completedTargetKeys = requiredSourceIds(evidence.completedTargetKeys, `${label} completedTargetKeys`);
  if (
    requiredTargetKeys.length === 0
    || requiredTargetKeys.length !== completedTargetKeys.length
    || requiredTargetKeys.some((key) => !completedTargetKeys.includes(key))
  ) {
    throw new Error(`${label} immutable artifact traversal targets are incomplete.`);
  }
  for (const [index, value] of artifactPages.entries()) {
    if (!isRecord(value)) throw new Error(`${label} artifactPages[${index}] is not an object.`);
    if (
      value.sourceMethod !== SOURCE_LIST_METHODS[family]
      || typeof value.targetKey !== "string"
      || !requiredTargetKeys.includes(value.targetKey)
      || typeof value.pageIdentity !== "string"
      || !value.pageIdentity.trim()
      || !isSha256(value.requestSha256)
      || !isSha256(value.pageSha256)
      || requiredInteger(value.pageNumber, `${label} artifact page number`, 1) < 1
      || requiredInteger(value.rowCount, `${label} artifact row count`, 0) < 0
      || typeof value.terminal !== "boolean"
    ) {
      throw new Error(`${label} artifactPages[${index}] is not immutable list-response evidence.`);
    }
  }

  const traversalGeneration = requiredInteger(
    row.traversal_generation,
    `${label} traversal generation`,
    1,
  );
  if (traversalGeneration !== generation) {
    throw new Error(
      `${label} persisted traversal generation ${traversalGeneration} does not match source generation ${generation}.`,
    );
  }
  if (row.traversal_status !== "completed" && row.traversal_status !== "provisional") {
    throw new Error(`${label} persisted traversal status is not authoritative: ${row.traversal_status}.`);
  }
  if (row.traversal_continuation_token !== null) {
    throw new Error(`${label} persisted traversal retains a continuation token.`);
  }
  const traversalPageCount = requiredInteger(row.traversal_page_count, `${label} traversal page_count`, 1);
  const traversalRecordCount = requiredInteger(row.traversal_record_count, `${label} traversal record_count`, 0);
  if (traversalPageCount !== expectedPages || traversalPageCount !== completedPages) {
    throw new Error(`${label} persisted traversal page count does not match source-manifest authority.`);
  }
  const traversalRequiredTargets = requiredSourceIds(
    row.traversal_required_target_keys,
    `${label} traversal required_target_keys`,
  );
  const traversalCompletedTargets = requiredSourceIds(
    row.traversal_completed_target_keys,
    `${label} traversal completed_target_keys`,
  );
  const traversalExactIds = requiredSourceIds(
    row.traversal_exact_source_ids,
    `${label} traversal exact_source_ids`,
  );
  const traversalListedIds = requiredSourceIds(
    row.traversal_listed_source_ids,
    `${label} traversal listed_source_ids`,
  );
  const traversalDetailedIds = requiredSourceIds(
    row.traversal_detailed_source_ids,
    `${label} traversal detailed_source_ids`,
  );
  if (
    !sameValues(traversalRequiredTargets, requiredTargetKeys)
    || !sameValues(traversalCompletedTargets, completedTargetKeys)
    || !sameValues(traversalExactIds, exactIds)
    || !sameValues(traversalListedIds, listedIds)
    || traversalRecordCount !== exactIds.length
  ) {
    throw new Error(`${label} persisted traversal manifest does not match exact source-manifest evidence.`);
  }
  const expectedTraversalDetailIds = row.traversal_detail_coverage_required
    ? traversalDetailedIds
    : traversalListedIds;
  if (
    (row.traversal_detail_coverage_required && !sameValues(traversalDetailedIds, traversalListedIds))
    || !sameValues(expectedTraversalDetailIds, detailIds)
  ) {
    throw new Error(`${label} persisted traversal detail coverage does not match source-manifest evidence.`);
  }
  const violations = requiredArray(row.traversal_violations, `${label} traversal violations`);
  if (violations.length !== 0) throw new Error(`${label} persisted traversal has unresolved violations.`);

  const pagesResult = await query<TraversalPageRow>(
    `select generation, ordinal, target_key, source_method, page_number, page_size,
            row_count, exact_ids, request_query, terminal, continuation_page,
            response_hash, synthetic
       from metrics.backfill_traversal_pages
      where work_unit_id = $1
        and generation = $2
      order by target_key, page_number, ordinal, id
      for share`,
    [requiredInteger(row.work_unit_id, `${label} work_unit_id`, 1), generation],
  );
  if (pagesResult.rows.length !== traversalPageCount) {
    throw new Error(
      `${label} persisted traversal declares ${traversalPageCount} pages but has ${pagesResult.rows.length}.`,
    );
  }
  validatePersistedPages(
    label,
    family,
    pagesResult.rows,
    artifactPages,
    traversalRequiredTargets,
    traversalCompletedTargets,
    traversalExactIds,
    generation,
    String(evidence.artifactSha256),
    String(evidence.manifestSha256),
  );
  if (traversalExactIds.length === 0) {
    if (!isRecord(row.traversal_empty_proof)
        || row.traversal_empty_proof.authoritative !== true
        || row.traversal_empty_proof.fullUniverseArtifact !== true) {
      throw new Error(`${label} empty traversal lacks authoritative real terminal-page proof.`);
    }
    const terminalTargets = requiredSourceIds(
      row.traversal_empty_proof.terminalTargetKeys,
      `${label} empty terminalTargetKeys`,
    );
    if (!sameValues(terminalTargets, traversalCompletedTargets)) {
      throw new Error(`${label} empty traversal terminal targets do not match completed targets.`);
    }
  }
}

function validatePersistedPages(
  label: string,
  family: string,
  rows: TraversalPageRow[],
  artifactPages: unknown[],
  requiredTargets: string[],
  completedTargets: string[],
  declaredExactIds: string[],
  generation: number,
  artifactSha256: string,
  manifestSha256: string,
) {
  const embeddedByIdentity = new Map<string, Record<string, unknown>>();
  for (const [index, value] of artifactPages.entries()) {
    if (!isRecord(value) || typeof value.pageIdentity !== "string" || !value.pageIdentity.trim()) {
      throw new Error(`${label} artifactPages[${index}] lacks a page identity.`);
    }
    if (embeddedByIdentity.has(value.pageIdentity)) {
      throw new Error(`${label} contains duplicate artifact page identity ${value.pageIdentity}.`);
    }
    embeddedByIdentity.set(value.pageIdentity, value);
  }

  const byTarget = new Map<string, Array<{ row: TraversalPageRow; pageNumber: number; ordinal: number }>>();
  const pageExactIds: string[] = [];
  const pageIdentities = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const pageLabel = `${label} persisted page ${index + 1}`;
    if (requiredInteger(row.generation, `${pageLabel} generation`, 1) !== generation) {
      throw new Error(`${pageLabel} generation does not match traversal generation ${generation}.`);
    }
    const ordinal = requiredInteger(row.ordinal, `${pageLabel} ordinal`, 1);
    const pageNumber = requiredInteger(row.page_number, `${pageLabel} page_number`, 1);
    const pageSize = requiredInteger(row.page_size, `${pageLabel} page_size`, 1);
    const rowCount = requiredInteger(row.row_count, `${pageLabel} row_count`, 0);
    if (typeof row.target_key !== "string" || !row.target_key.trim()) {
      throw new Error(`${pageLabel} target_key is blank.`);
    }
    if (row.source_method !== `${PROJECTION_PROVENANCE}:${SOURCE_LIST_METHODS[family]}`) {
      throw new Error(`${pageLabel} does not use the canonical ${SOURCE_LIST_METHODS[family]} list method.`);
    }
    if (row.synthetic !== true) throw new Error(`${pageLabel} is not an immutable artifact projection.`);
    if (typeof row.terminal !== "boolean") throw new Error(`${pageLabel} terminal is not boolean.`);
    const exactIds = requiredSourceIds(row.exact_ids, `${pageLabel} exact_ids`);
    if (rowCount !== exactIds.length || pageSize < rowCount) {
      throw new Error(`${pageLabel} rowCount/pageSize does not match its exact IDs.`);
    }
    pageExactIds.push(...exactIds);
    if (!isRecord(row.request_query)) {
      throw new Error(`${pageLabel} lacks immutable artifact request provenance.`);
    }
    const requestQuery = row.request_query;
    const requestEvidenceValue = requestQuery._bulkArtifactEvidence;
    if (!isRecord(requestEvidenceValue)) {
      throw new Error(`${pageLabel} lacks immutable artifact request provenance.`);
    }
    const requestEvidence = requestEvidenceValue;
    const requestIdentity = requiredString(requestEvidence.requestIdentity, `${pageLabel} requestIdentity`);
    const pageIdentity = requiredString(requestEvidence.pageIdentity, `${pageLabel} pageIdentity`);
    if (pageIdentities.has(pageIdentity)) throw new Error(`${label} has duplicate persisted page identity ${pageIdentity}.`);
    pageIdentities.add(pageIdentity);
    if (
      requestEvidence.provenance !== PROJECTION_PROVENANCE
      || requestEvidence.fabricatedApiResponse !== false
      || requestEvidence.originalSourceMethod !== SOURCE_LIST_METHODS[family]
      || requestEvidence.artifactSha256 !== artifactSha256
      || requestEvidence.manifestSha256 !== manifestSha256
      || !isSha256(requestEvidence.requestSha256)
      || !isSha256(requestEvidence.pageSha256)
      || row.response_hash !== requestEvidence.pageSha256
    ) {
      throw new Error(`${pageLabel} immutable artifact provenance is missing or inconsistent.`);
    }
    const originalQuery = { ...requestQuery };
    delete originalQuery._bulkArtifactEvidence;
    if (bulkEvidenceRequestSha256(originalQuery) !== requestEvidence.requestSha256) {
      throw new Error(`${pageLabel} request hash does not match its persisted request query.`);
    }
    if (bulkEvidencePageSha256(pageIdentity, exactIds) !== requestEvidence.pageSha256) {
      throw new Error(`${pageLabel} page hash does not match its persisted identity and exact IDs.`);
    }
    const embedded = embeddedByIdentity.get(pageIdentity);
    if (!embedded) throw new Error(`${pageLabel} is absent from source-manifest artifact page evidence.`);
    const embeddedIds = requiredSourceIds(embedded.exactIds, `${pageLabel} embedded exactIds`);
    if (
      embedded.targetKey !== row.target_key
      || embedded.sourceMethod !== SOURCE_LIST_METHODS[family]
      || embedded.requestIdentity !== requestIdentity
      || embedded.requestSha256 !== requestEvidence.requestSha256
      || embedded.pageSha256 !== requestEvidence.pageSha256
      || requiredInteger(embedded.pageNumber, `${pageLabel} embedded pageNumber`, 1) !== pageNumber
      || requiredInteger(embedded.rowCount, `${pageLabel} embedded rowCount`, 0) !== rowCount
      || embedded.terminal !== row.terminal
      || (embedded.continuationPage ?? null) !== (row.continuation_page ?? null)
      || !sameValues(embeddedIds, exactIds)
    ) {
      throw new Error(`${pageLabel} does not match source-manifest artifact page evidence.`);
    }
    embeddedByIdentity.delete(pageIdentity);
    const targetPages = byTarget.get(row.target_key) ?? [];
    targetPages.push({ row, pageNumber, ordinal });
    byTarget.set(row.target_key, targetPages);
  }
  if (embeddedByIdentity.size !== 0) throw new Error(`${label} source manifest declares unpersisted artifact pages.`);

  const derivedTargets = sortExactSourceIds([...byTarget.keys()]);
  if (!sameValues(derivedTargets, requiredTargets)) {
    throw new Error(`${label} persisted page targets do not equal declared required targets.`);
  }
  const derivedCompletedTargets: string[] = [];
  for (const [target, targetPages] of byTarget) {
    targetPages.sort((left, right) => left.pageNumber - right.pageNumber || left.ordinal - right.ordinal);
    for (let index = 0; index < targetPages.length; index += 1) {
      const current = targetPages[index];
      const expectedPage = index + 1;
      if (current.pageNumber !== expectedPage) {
        throw new Error(
          `${label}/${target} persisted traversal must start at page 1 and be sequential; found page ${current.pageNumber}.`,
        );
      }
      const isLast = index === targetPages.length - 1;
      if (current.row.terminal !== isLast) {
        throw new Error(`${label}/${target} terminal page state does not match traversal order.`);
      }
      const continuation = current.row.continuation_page;
      if (isLast ? continuation !== null : continuation !== expectedPage + 1) {
        throw new Error(`${label}/${target} continuation page state is not sequential.`);
      }
    }
    derivedCompletedTargets.push(target);
  }
  const sortedCompletedTargets = sortExactSourceIds(derivedCompletedTargets);
  if (!sameValues(sortedCompletedTargets, completedTargets)) {
    throw new Error(`${label} terminal pages do not equal declared completed targets.`);
  }
  const exactPageIds = requiredSourceIds(pageExactIds, `${label} persisted page exact IDs`);
  if (!sameValues(exactPageIds, declaredExactIds)) {
    throw new Error(`${label} persisted page exact IDs do not equal declared exact IDs.`);
  }
}

function requiredSourceIds(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const ids = value.map((id) => {
    if ((typeof id !== "string" && typeof id !== "number") || !String(id).trim()) {
      throw new Error(`${label} contains an invalid identity.`);
    }
    return String(id);
  });
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate identities.`);
  return sortExactSourceIds(ids);
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonblank string.`);
  return value;
}

function sameValues(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requiredInteger(value: unknown, label: string, minimum: number) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}.`);
  }
  return parsed;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function normalizeUnits(input: readonly BulkDashboardReconciliationUnit[]) {
  if (input.length === 0) throw new Error("At least one dashboard reconciliation unit is required.");
  const units = input.map((unit) => {
    if (!SCOPES.includes(unit.scope)) throw new Error(`Unsupported reconciliation scope ${unit.scope}.`);
    assertMonth(unit.periodStart, unit.periodEnd);
    assertFinite(unit.rollupValue, "rollupValue");
    assertFinite(unit.snapshotValue, "snapshotValue");
    if (unit.upstreamSampleValue !== null) assertFinite(unit.upstreamSampleValue, "upstreamSampleValue");
    if (unit.detail.verificationStatus !== "matched") {
      throw new Error(`${unit.scope}/${unit.periodStart} was not independently verified as matched.`);
    }
    assertSha256(unit.detail.projectManifestSha256, "projectManifestSha256");
    assertSha256(unit.detail.operationalManifestSha256, "operationalManifestSha256");
    const readModelVersion = normalizeReadModelVersion(unit);
    return {
      ...unit,
      readModelVersion,
      rollupValue: round(unit.rollupValue),
      snapshotValue: round(unit.snapshotValue),
      upstreamSampleValue: unit.upstreamSampleValue === null ? null : round(unit.upstreamSampleValue),
    };
  }).sort((left, right) => left.periodStart.localeCompare(right.periodStart) || left.scope.localeCompare(right.scope));

  const keys = new Set<string>();
  const scopesByPeriod = new Map<string, Set<string>>();
  for (const unit of units) {
    const key = `${unit.scope}:${unit.periodStart}`;
    if (keys.has(key)) throw new Error(`Duplicate dashboard reconciliation unit ${key}.`);
    keys.add(key);
    const scopes = scopesByPeriod.get(unit.periodStart) ?? new Set<string>();
    scopes.add(unit.scope);
    scopesByPeriod.set(unit.periodStart, scopes);
  }
  for (const [periodStart, scopes] of scopesByPeriod) {
    const missing = SCOPES.filter((scope) => !scopes.has(scope));
    if (missing.length > 0) throw new Error(`${periodStart} is missing reconciliation scopes: ${missing.join(", ")}.`);
  }
  return units;
}

function normalizeReadModelVersion(unit: BulkDashboardReconciliationUnit) {
  const version = unit.readModelVersion;
  if (!version || typeof version !== "object" || Array.isArray(version)) {
    throw new Error(`${unit.scope}/${unit.periodStart} requires a captured dashboard read-model version.`);
  }
  if (
    version.metricFamily !== unit.scope
    || version.periodGrain !== "month"
    || version.periodStart !== unit.periodStart
  ) {
    throw new Error(`${unit.scope}/${unit.periodStart} read-model key does not match its reconciliation unit.`);
  }
  if (!isRecord(version.dimensionsJson)) {
    throw new Error(`${unit.scope}/${unit.periodStart} read-model dimensions must be an object.`);
  }
  if (version.sourceHash !== null && (typeof version.sourceHash !== "string" || !version.sourceHash.trim())) {
    throw new Error(`${unit.scope}/${unit.periodStart} read-model source hash must be a nonblank string or null.`);
  }
  if (typeof version.rebuiltAt !== "string" || !Number.isFinite(Date.parse(version.rebuiltAt))) {
    throw new Error(`${unit.scope}/${unit.periodStart} read-model rebuilt_at must be a timestamp.`);
  }
  if (
    version.rebuiltByJobId !== null
    && (typeof version.rebuiltByJobId !== "string" || !/^\d+$/.test(version.rebuiltByJobId))
  ) {
    throw new Error(`${unit.scope}/${unit.periodStart} read-model current run must be an integer string or null.`);
  }
  return {
    ...version,
    dimensionsJson: { ...version.dimensionsJson },
    rebuiltAt: version.rebuiltAt.trim(),
  };
}

function normalizeQuery(client: BulkDashboardReconciliationQuery | BulkDashboardReconciliationQueryClient) {
  return typeof client === "function" ? client : client.query.bind(client);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertMonth(periodStart: string, periodEnd: string) {
  if (!/^\d{4}-\d{2}-01$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    throw new Error(`Invalid monthly period ${periodStart}/${periodEnd}.`);
  }
  const start = new Date(`${periodStart}T00:00:00.000Z`);
  const expectedEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  if (periodEnd !== expectedEnd) throw new Error(`Period end ${periodEnd} does not match ${periodStart}.`);
}

function assertFinite(value: number, field: string) {
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite.`);
}

function assertSha256(value: string, field: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be a lowercase SHA-256 hash.`);
}

function storedResult(value: unknown, fallback: BulkDashboardReconciliationResult) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  return {
    batchSha256: String(record.batchSha256 ?? fallback.batchSha256),
    periods: Number(record.periods ?? fallback.periods),
    checksPublished: Number(record.checksPublished ?? fallback.checksPublished),
    commissionRollupsQueued: Number(record.commissionRollupsQueued ?? fallback.commissionRollupsQueued),
    idempotent: Boolean(record.idempotent),
  };
}

function round(value: number) {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

import { createHash } from "node:crypto";
import type { BackfillSourceFamily } from "@/lib/backfill/plan";
import { compareExactSourceIds, exactSourceIdHash, sortExactSourceIds } from "@/lib/store/exact-source-identities";
import { queryPostgres } from "@/lib/store/postgres";

const PROJECTION_PROVENANCE = "checksum_verified_full_universe_artifact_projection";
const AUDIT_ACTION = "bulk_bootstrap_evidence_published";
const AUDIT_ENTITY_TYPE = "backfill_evidence_batch";
const AUDIT_ACTOR = "bulk-bootstrap-evidence@prostarmechanical.com";

const SOURCE_FAMILIES = new Set<BackfillSourceFamily>([
  "quotes",
  "quote_nested",
  "jobs",
  "job_nested",
  "employees",
  "timesheets",
  "jobs_from_timesheets",
  "schedules",
  "mobile_status",
]);

const ARTIFACT_LIST_METHODS: Partial<Record<BackfillSourceFamily, string>> = {
  quotes: "listQuotes",
  quote_nested: "listQuotes",
  jobs: "listJobs",
  job_nested: "listJobs",
  employees: "listEmployees",
  timesheets: "listEmployeeTimesheets",
  jobs_from_timesheets: "listEmployeeTimesheets",
  schedules: "listSchedules",
  mobile_status: "listMobileStatus",
};

export type BulkBootstrapEvidenceQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: T[]; rowCount: number | null }>;

export type BulkBootstrapEvidenceQueryClient = {
  query: BulkBootstrapEvidenceQuery;
};

export type BulkBootstrapEvidencePage = {
  targetKey: string;
  sourceMethod: string;
  requestIdentity: string;
  requestSha256: string;
  pageIdentity: string;
  pageSha256: string;
  pageNumber: number;
  pageSize: number;
  rowCount: number;
  exactIds: Array<string | number>;
  requestQuery: Record<string, unknown>;
  terminal: boolean;
  continuationPage?: number | null;
  observedMinDate?: string | null;
  observedMaxDate?: string | null;
};

export type BulkBootstrapEvidenceUnit = {
  sourceFamily: BackfillSourceFamily;
  periodStart: string;
  periodEnd: string;
  exactSourceIds: Array<string | number>;
  listedSourceIds: Array<string | number>;
  detailedSourceIds: Array<string | number>;
  normalizedSourceIds: Array<string | number>;
  sourceValue: number | null;
  normalizedValue: number | null;
  pages: BulkBootstrapEvidencePage[];
  artifactSha256: string;
  manifestSha256: string;
  evidenceAsOf: Date | string;
  currentMonth: boolean;
  detailCoverageRequired: boolean;
  openQuoteDiscovery?: Record<string, unknown>;
  state?: "partial" | "unavailable";
  stateReason?: string;
  continuationToken?: Record<string, unknown> | null;
};

export type BulkBootstrapEvidencePublicationResult = {
  manifestSha256: string;
  batchEvidenceSha256: string;
  publishedUnits: number;
  completedUnits: number;
  partialUnits: number;
  unavailableUnits: number;
  pageCount: number;
  reconciliationCount: number;
  idempotent: boolean;
};

type NormalizedPage = Omit<BulkBootstrapEvidencePage, "exactIds" | "continuationPage" | "observedMinDate" | "observedMaxDate"> & {
  exactIds: string[];
  continuationPage: number | null;
  observedMinDate: string | null;
  observedMaxDate: string | null;
};

type NormalizedUnit = Omit<
  BulkBootstrapEvidenceUnit,
  | "exactSourceIds"
  | "listedSourceIds"
  | "detailedSourceIds"
  | "normalizedSourceIds"
  | "pages"
  | "evidenceAsOf"
  | "openQuoteDiscovery"
  | "continuationToken"
> & {
  exactSourceIds: string[];
  listedSourceIds: string[];
  detailedSourceIds: string[];
  normalizedSourceIds: string[];
  periodDetailIds: string[];
  pages: NormalizedPage[];
  evidenceAsOf: string;
  openQuoteDiscovery: Record<string, unknown>;
  continuationToken: Record<string, unknown> | null;
  requiredTargetKeys: string[];
  completedTargetKeys: string[];
  gateFailures: string[];
  exactComplete: boolean;
};

type LedgerRow = {
  id: number | string;
  month_end_exclusive: string;
  required_for_completion: boolean;
  status: string;
};

type ExistingManifestRow = {
  generation: unknown;
  as_of_watermark: string;
};

type ExistingSourcePeriodRow = {
  evidence_as_of: string;
  manifest_generation: unknown;
  reconciliation_generation: unknown;
};

type StoredAuditRow = {
  after_value: unknown;
};

/**
 * Publishes evidence projected from an already checksum-verified full-universe artifact.
 * It does not call Simpro and contains no source-fact write statements.
 */
export async function publishVerifiedBulkBootstrapEvidence(
  evidenceUnits: readonly BulkBootstrapEvidenceUnit[],
  client: BulkBootstrapEvidenceQuery | BulkBootstrapEvidenceQueryClient = queryPostgres,
): Promise<BulkBootstrapEvidencePublicationResult> {
  const units = normalizeBatch(evidenceUnits);
  const query = normalizeQueryClient(client);
  const manifestSha256 = units[0].manifestSha256;
  const batchEvidenceSha256 = sha256(stableJson(units));
  const baseResult = publicationResult(units, manifestSha256, batchEvidenceSha256, false);

  await query("begin");
  try {
    await query("select pg_advisory_xact_lock(hashtext($1))", [`${AUDIT_ENTITY_TYPE}:${manifestSha256}`]);

    const currentMonthResult = await query<{ current_month: string }>(
      `select date_trunc('month', now() at time zone 'America/Los_Angeles')::date::text as current_month`,
    );
    const currentMonth = currentMonthResult.rows[0]?.current_month;
    if (!currentMonth) throw new Error("Unable to resolve the current Pacific month.");

    const ledgers = new Map<string, LedgerRow>();
    for (const unit of units) {
      const result = await query<LedgerRow>(
        `select id, month_end_exclusive::text, required_for_completion, status
           from metrics.backfill_source_month_ledger
          where source_family = $1 and month_start = $2::date
          for update`,
        [unit.sourceFamily, unit.periodStart],
      );
      const ledger = result.rows[0];
      if (!ledger) {
        throw new Error(`No existing backfill ledger unit for ${unit.sourceFamily}/${unit.periodStart}.`);
      }
      if (ledger.month_end_exclusive !== addUtcMonths(unit.periodStart, 1)) {
        throw new Error(`Ledger window mismatch for ${unit.sourceFamily}/${unit.periodStart}.`);
      }
      if (ledger.status === "running") {
        throw new Error(`Cannot publish bulk evidence while ${unit.sourceFamily}/${unit.periodStart} is running.`);
      }
      if (unit.currentMonth !== (unit.periodStart === currentMonth)) {
        throw new Error(`Current-month declaration mismatch for ${unit.sourceFamily}/${unit.periodStart}.`);
      }
      if (!unit.exactComplete && ledger.status === "completed") {
        throw new Error(`Partial evidence cannot replace completed ledger evidence for ${unit.sourceFamily}/${unit.periodStart}.`);
      }
      ledgers.set(unitKey(unit), ledger);
    }

    const priorAudit = await query<StoredAuditRow>(
      `select after_value
         from metrics.audit_events
        where action = $1 and entity_type = $2 and entity_id = $3
          and after_value->>'batchEvidenceSha256' = $4
        order by id desc
        limit 1`,
      [AUDIT_ACTION, AUDIT_ENTITY_TYPE, manifestSha256, batchEvidenceSha256],
    );
    if (priorAudit.rows[0]) {
      const stored = storedPublicationResult(priorAudit.rows[0].after_value);
      if (stored.batchEvidenceSha256 !== batchEvidenceSha256) {
        throw new Error(`Manifest ${manifestSha256} was already published with different evidence.`);
      }
      await query("commit");
      return { ...stored, idempotent: true };
    }

    const publicationGeneration = await resolvePublicationGeneration(query, units, ledgers);
    for (const unit of units) {
      const ledger = ledgers.get(unitKey(unit));
      if (!ledger) throw new Error(`Lost locked ledger unit ${unitKey(unit)}.`);
      await publishUnit(query, unit, ledger, publicationGeneration);
    }

    await query(
      `insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason
       ) values ($1, $2, $3, $4, null, $5::jsonb, $6)`,
      [
        AUDIT_ACTOR,
        AUDIT_ACTION,
        AUDIT_ENTITY_TYPE,
        manifestSha256,
        JSON.stringify({
          ...baseResult,
          artifactSha256s: [...new Set(units.map((unit) => unit.artifactSha256))].sort(),
          provenance: PROJECTION_PROVENANCE,
        }),
        "Published checksum-verified full-universe artifact projections into existing backfill evidence records; no API response or source fact was created.",
      ],
    );
    await query("commit");
    return baseResult;
  } catch (error) {
    await query("rollback").catch(() => undefined);
    throw error;
  }
}

async function publishUnit(
  query: BulkBootstrapEvidenceQuery,
  unit: NormalizedUnit,
  ledger: LedgerRow,
  generation: number,
) {
  const workUnitId = ledger.id;
  const manifestResult = await query<ExistingManifestRow>(
    `select generation, as_of_watermark::text
       from metrics.backfill_traversal_manifests
      where work_unit_id = $1
      for update`,
    [workUnitId],
  );
  const existingManifest = manifestResult.rows[0];
  rejectStaleEvidence(unit, existingManifest?.as_of_watermark, "traversal manifest");

  const sourcePeriodResult = await query<ExistingSourcePeriodRow>(
    `select evidence_as_of::text, manifest_generation, reconciliation_generation
       from metrics.source_period_manifests
      where source_family = $1 and period_start = $2::date
      for update`,
    [unit.sourceFamily, unit.periodStart],
  );
  const existingSourcePeriod = sourcePeriodResult.rows[0];
  rejectStaleEvidence(unit, existingSourcePeriod?.evidence_as_of, "source-period manifest");

  const minimumGeneration = nextGeneration(
    existingManifest?.generation,
    existingSourcePeriod?.manifest_generation,
    existingSourcePeriod?.reconciliation_generation,
  );
  if (generation < minimumGeneration) {
    throw new Error(
      `Bulk evidence generation ${generation} cannot replace ${unitKey(unit)}; at least ${minimumGeneration} is required.`,
    );
  }
  const manifestStatus = unit.exactComplete
    ? unit.currentMonth ? "provisional" : "completed"
    : unit.state === "unavailable" ? "unavailable" : "collecting";
  const reconciliationStatus = unit.exactComplete ? "matched" : unit.state!;
  const sourceMaxDate = observedSourceMaxDate(unit.pages);
  const missingSourceIds = difference(unit.exactSourceIds, unit.normalizedSourceIds);
  const extraNormalizedIds = difference(unit.normalizedSourceIds, unit.exactSourceIds);
  const detail = reconciliationDetail(unit, generation);

  for (let index = 0; index < unit.pages.length; index += 1) {
    const page = unit.pages[index];
    const requestEvidence = {
      ...page.requestQuery,
      _bulkArtifactEvidence: {
        provenance: PROJECTION_PROVENANCE,
        declaration: "Projection from a checksum-verified full-universe artifact; not a fabricated API response.",
        fabricatedApiResponse: false,
        artifactSha256: unit.artifactSha256,
        manifestSha256: unit.manifestSha256,
        requestIdentity: page.requestIdentity,
        requestSha256: page.requestSha256,
        pageIdentity: page.pageIdentity,
        pageSha256: page.pageSha256,
        originalSourceMethod: page.sourceMethod,
      },
    };
    await query(
      `insert into metrics.backfill_traversal_pages (
         work_unit_id, generation, ordinal, target_key, source_method, page_number,
         page_size, row_count, exact_ids, request_query, terminal, continuation_page,
         observed_min_date, observed_max_date, response_hash, synthetic, observed_at
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12,
         $13::date, $14::date, $15, true, $16::timestamptz
       )`,
      [
        workUnitId,
        generation,
        index + 1,
        page.targetKey,
        `${PROJECTION_PROVENANCE}:${page.sourceMethod}`,
        page.pageNumber,
        page.pageSize,
        page.rowCount,
        JSON.stringify(page.exactIds),
        JSON.stringify(requestEvidence),
        page.terminal,
        page.continuationPage,
        page.observedMinDate,
        page.observedMaxDate,
        page.pageSha256,
        unit.evidenceAsOf,
      ],
    );
  }

  const filterContract = {
    version: 1,
    sourceFamily: unit.sourceFamily,
    monthStart: unit.periodStart,
    monthEndExclusive: addUtcMonths(unit.periodStart, 1),
    effectiveEndInclusive: effectiveEndInclusive(unit),
    provisional: unit.currentMonth,
    identityContract: PROJECTION_PROVENANCE,
    requiredTargetKeys: unit.requiredTargetKeys,
    targets: unit.pages.map((page) => ({
      key: page.targetKey,
      purpose: "artifact_projection",
      sourceMethod: page.sourceMethod,
      requestIdentity: page.requestIdentity,
      requestSha256: page.requestSha256,
      query: page.requestQuery,
    })),
    openQuoteDiscoveryRequired: quoteDiscoveryRequired(unit),
    artifactEvidence: artifactEvidence(unit),
  };
  const observedBoundary = {
    pacificBoundaryDate: pacificDate(unit.evidenceAsOf),
    effectiveEndInclusive: effectiveEndInclusive(unit),
    monthEndExclusive: addUtcMonths(unit.periodStart, 1),
    provisional: unit.currentMonth,
    evidenceAsOf: unit.evidenceAsOf,
    ...artifactEvidence(unit),
  };
  const emptyProof = unit.exactComplete && unit.exactSourceIds.length === 0
    ? {
        authoritative: true,
        fullUniverseArtifact: true,
        projection: true,
        terminalTargetKeys: unit.completedTargetKeys,
        evidenceAsOf: unit.evidenceAsOf,
        ...artifactEvidence(unit),
      }
    : null;
  const violations = unit.exactComplete
    ? []
    : [
        `bulk_artifact_publication_${unit.state}`,
        ...unit.gateFailures.map((failure) => `completeness_gate:${failure}`),
      ];

  await query(
    `insert into metrics.backfill_traversal_manifests (
       work_unit_id, generation, contract_version, manifest_status, filter_contract,
       as_of_watermark, observed_boundary, required_target_keys, completed_target_keys,
       exact_source_ids, listed_source_ids, detailed_source_ids, exclusions,
       continuation_token, detail_coverage_required, page_count, record_count,
       empty_proof, open_quote_discovery, violations, completed_at, reopened_at
     ) values (
       $1, $2, 1, $3, $4::jsonb, $5::timestamptz, $6::jsonb, $7::jsonb, $8::jsonb,
       $9::jsonb, $10::jsonb, $11::jsonb, '[]'::jsonb, $12::jsonb, $13, $14, $15,
       $16::jsonb, $17::jsonb, $18::jsonb,
       case when $3 in ('completed', 'provisional') then now() else null end,
       case when $19 then now() else null end
     )
     on conflict (work_unit_id) do update set
       generation = excluded.generation,
       contract_version = excluded.contract_version,
       manifest_status = excluded.manifest_status,
       filter_contract = excluded.filter_contract,
       as_of_watermark = excluded.as_of_watermark,
       observed_boundary = excluded.observed_boundary,
       required_target_keys = excluded.required_target_keys,
       completed_target_keys = excluded.completed_target_keys,
       exact_source_ids = excluded.exact_source_ids,
       listed_source_ids = excluded.listed_source_ids,
       detailed_source_ids = excluded.detailed_source_ids,
       exclusions = excluded.exclusions,
       continuation_token = excluded.continuation_token,
       detail_coverage_required = excluded.detail_coverage_required,
       page_count = excluded.page_count,
       record_count = excluded.record_count,
       empty_proof = excluded.empty_proof,
       open_quote_discovery = excluded.open_quote_discovery,
       violations = excluded.violations,
       completed_at = excluded.completed_at,
       reopened_at = now(),
       updated_at = now()`,
    [
      workUnitId,
      generation,
      manifestStatus,
      JSON.stringify(filterContract),
      unit.evidenceAsOf,
      JSON.stringify(observedBoundary),
      JSON.stringify(unit.requiredTargetKeys),
      JSON.stringify(unit.completedTargetKeys),
      JSON.stringify(unit.exactSourceIds),
      JSON.stringify(unit.listedSourceIds),
      JSON.stringify(unit.detailedSourceIds),
      unit.continuationToken ? JSON.stringify(unit.continuationToken) : null,
      unit.detailCoverageRequired,
      unit.pages.length,
      unit.exactSourceIds.length,
      emptyProof ? JSON.stringify(emptyProof) : null,
      JSON.stringify(unit.openQuoteDiscovery),
      JSON.stringify(violations),
      Boolean(existingManifest),
    ],
  );

  await query(
    `insert into metrics.backfill_reconciliation_results (
       work_unit_id, status, source_record_count, normalized_record_count, source_max_date,
       missing_source_ids, extra_normalized_ids, detail, checked_at
     ) values ($1, $2, $3, $4, $5::date, $6::jsonb, $7::jsonb, $8::jsonb, $9::timestamptz)`,
    [
      workUnitId,
      reconciliationStatus,
      unit.exactSourceIds.length,
      unit.normalizedSourceIds.length,
      sourceMaxDate,
      JSON.stringify(missingSourceIds),
      JSON.stringify(extraNormalizedIds),
      JSON.stringify(detail),
      unit.evidenceAsOf,
    ],
  );

  const sourceIdHash = exactSourceIdHash(unit.exactSourceIds);
  const normalizedIdHash = exactSourceIdHash(unit.normalizedSourceIds);
  const sourcePeriodEvidence = {
    authority: PROJECTION_PROVENANCE,
    authoritativeSource: "checksum_verified_full_universe_artifact",
    workUnitId,
    manifestGeneration: generation,
    reconciliationGeneration: unit.exactComplete ? generation : null,
    expectedPageCount: unit.pages.length,
    completedPageCount: unit.pages.length,
    reconciledAt: unit.exactComplete ? unit.evidenceAsOf : null,
    manifestStatus,
    publicationState: unit.exactComplete ? "matched" : unit.state,
    stateReason: unit.stateReason ?? null,
    exactSourceIdHash: exactSourceIdHash(unit.exactSourceIds),
    listedSourceIdHash: exactSourceIdHash(unit.listedSourceIds),
    detailIdHash: exactSourceIdHash(unit.periodDetailIds),
    normalizedIdHash,
    exactSourceIds: unit.exactSourceIds,
    listedSourceIds: unit.listedSourceIds,
    detailedSourceIds: unit.detailedSourceIds,
    periodDetailIds: unit.periodDetailIds,
    normalizedSourceIds: unit.normalizedSourceIds,
    requiredTargetKeys: unit.requiredTargetKeys,
    completedTargetKeys: unit.completedTargetKeys,
    artifactPages: unit.pages.map((page) => ({
      targetKey: page.targetKey,
      sourceMethod: page.sourceMethod,
      requestIdentity: page.requestIdentity,
      requestSha256: page.requestSha256,
      pageIdentity: page.pageIdentity,
      pageSha256: page.pageSha256,
      pageNumber: page.pageNumber,
      rowCount: page.rowCount,
      exactIds: page.exactIds,
      terminal: page.terminal,
      continuationPage: page.continuationPage,
    })),
    gateFailures: unit.gateFailures,
    ...artifactEvidence(unit),
  };
  await query(
    `insert into metrics.source_period_manifests (
       source_family, period_start, period_end, coverage_status, reconciliation_status,
       listed_count, detail_count, normalized_count, source_id_hash, normalized_id_hash,
       source_value, normalized_value, continuation_token, evidence_as_of, completed_at,
       evidence_json, manifest_generation, reconciliation_generation,
       expected_page_count, completed_page_count, reconciled_at
     ) values (
       $1, $2::date, $3::date, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13::jsonb, $14::timestamptz,
       case when $4 = 'complete' then $14::timestamptz else null end, $15::jsonb,
       $16::bigint, case when $4::text = 'complete' then $16::bigint else null end,
       $17::integer, $18::integer,
       case when $4::text = 'complete' then $14::timestamptz else null end
     )
     on conflict (source_family, period_start) do update set
       period_end = excluded.period_end,
       coverage_status = excluded.coverage_status,
       reconciliation_status = excluded.reconciliation_status,
       listed_count = excluded.listed_count,
       detail_count = excluded.detail_count,
       normalized_count = excluded.normalized_count,
       source_id_hash = excluded.source_id_hash,
       normalized_id_hash = excluded.normalized_id_hash,
       source_value = excluded.source_value,
       normalized_value = excluded.normalized_value,
       continuation_token = excluded.continuation_token,
       evidence_as_of = excluded.evidence_as_of,
       completed_at = excluded.completed_at,
       evidence_json = excluded.evidence_json,
       manifest_generation = excluded.manifest_generation,
       reconciliation_generation = excluded.reconciliation_generation,
       expected_page_count = excluded.expected_page_count,
       completed_page_count = excluded.completed_page_count,
       reconciled_at = excluded.reconciled_at,
       updated_at = now()
     where excluded.evidence_as_of >= metrics.source_period_manifests.evidence_as_of`,
    [
      unit.sourceFamily,
      unit.periodStart,
      unit.periodEnd,
      unit.exactComplete ? "complete" : "partial",
      unit.exactComplete ? "matched" : "unavailable",
      unit.listedSourceIds.length,
      unit.periodDetailIds.length,
      unit.normalizedSourceIds.length,
      sourceIdHash,
      normalizedIdHash,
      unit.sourceValue,
      unit.normalizedValue,
      unit.continuationToken ? JSON.stringify(unit.continuationToken) : null,
      unit.evidenceAsOf,
      JSON.stringify(sourcePeriodEvidence),
      generation,
      unit.pages.length,
      unit.pages.length,
    ],
  );

  if (unit.exactComplete) {
    await query(
      `update metrics.backfill_source_month_ledger
          set status = 'completed',
              work_phase = 'reconcile',
              reconciliation_status = 'matched',
              reconciled_source_records = $2::integer,
              reconciled_normalized_records = $3::integer,
              source_max_date = $4::date,
              normalized_coverage = case when $2::integer = 0 then 100 else round(($3::numeric / $2::numeric) * 100, 4) end,
              reconciliation_detail = $5::jsonb,
              continuation_token = null,
              locked_by = null,
              locked_at = null,
              lease_expires_at = null,
              heartbeat_at = null,
              reserved_capacity_date = null,
              reserved_requests = 0,
              last_error = null,
              dead_lettered_at = null,
              completed_at = now(),
              updated_at = now()
        where id = $1`,
      [workUnitId, unit.exactSourceIds.length, unit.normalizedSourceIds.length, sourceMaxDate, JSON.stringify(detail)],
    );
  } else {
    await query(
      `update metrics.backfill_source_month_ledger
          set work_phase = 'reconcile',
              reconciliation_status = $2,
              reconciled_source_records = $3::integer,
              reconciled_normalized_records = $4::integer,
              source_max_date = $5::date,
              normalized_coverage = case when $3::integer = 0 then 0 else round(($4::numeric / $3::numeric) * 100, 4) end,
              reconciliation_detail = $6::jsonb,
              continuation_token = $7::jsonb,
              last_error = $8,
              updated_at = now()
        where id = $1`,
      [
        workUnitId,
        unit.state,
        unit.exactSourceIds.length,
        unit.normalizedSourceIds.length,
        sourceMaxDate,
        JSON.stringify(detail),
        unit.continuationToken ? JSON.stringify(unit.continuationToken) : null,
        `Verified bulk artifact evidence is ${unit.state}${unit.stateReason ? `: ${unit.stateReason}` : "."}`,
      ],
    );
  }
}

async function resolvePublicationGeneration(
  query: BulkBootstrapEvidenceQuery,
  units: readonly NormalizedUnit[],
  ledgers: ReadonlyMap<string, LedgerRow>,
) {
  const workUnitIds = units.map((unit) => Number(ledgers.get(unitKey(unit))?.id));
  if (workUnitIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Bulk evidence publication cannot resolve every work-unit ID.");
  }
  const periods = units.map((unit) => unit.periodStart).sort();
  const firstPeriod = periods[0];
  const lastPeriod = periods.at(-1);
  if (!firstPeriod || !lastPeriod) throw new Error("Bulk evidence publication requires at least one period.");

  const sameManifest = await query<{ generation: unknown }>(
    `select distinct manifest_generation as generation
       from metrics.source_period_manifests
      where source_family = any($1::text[])
        and period_start >= $2::date and period_start <= $3::date
        and evidence_json->>'manifestSha256' = $4
        and manifest_generation is not null
      order by manifest_generation`,
    [[...SOURCE_FAMILIES], firstPeriod, lastPeriod, units[0]!.manifestSha256],
  );
  const matchingGenerations = sameManifest.rows.map((row) => finiteGeneration(row.generation));
  const targetMaximum = await maximumGeneration(query, workUnitIds);
  if (matchingGenerations.length === 1 && matchingGenerations[0]! > targetMaximum) {
    return matchingGenerations[0]!;
  }

  const globalMaximum = await query<{ generation: unknown }>(
    `select greatest(
       coalesce(max(traversal.generation), 0),
       coalesce(max(source.manifest_generation), 0),
       coalesce(max(source.reconciliation_generation), 0)
     ) as generation
       from metrics.backfill_source_month_ledger ledger
       left join metrics.backfill_traversal_manifests traversal on traversal.work_unit_id = ledger.id
       left join metrics.source_period_manifests source
         on source.source_family = ledger.source_family and source.period_start = ledger.month_start
      where ledger.source_family = any($1::text[])
        and ledger.month_start >= $2::date and ledger.month_start <= $3::date`,
    [[...SOURCE_FAMILIES], firstPeriod, lastPeriod],
  );
  return finiteGeneration(globalMaximum.rows[0]?.generation, true) + 1;
}

async function maximumGeneration(query: BulkBootstrapEvidenceQuery, workUnitIds: number[]) {
  const result = await query<{ generation: unknown }>(
    `select greatest(
       coalesce(max(traversal.generation), 0),
       coalesce(max(source.manifest_generation), 0),
       coalesce(max(source.reconciliation_generation), 0)
     ) as generation
       from metrics.backfill_source_month_ledger ledger
       left join metrics.backfill_traversal_manifests traversal on traversal.work_unit_id = ledger.id
       left join metrics.source_period_manifests source
         on source.source_family = ledger.source_family and source.period_start = ledger.month_start
      where ledger.id = any($1::bigint[])`,
    [workUnitIds],
  );
  return finiteGeneration(result.rows[0]?.generation, true);
}

function finiteGeneration(value: unknown, allowZero = false) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Bulk evidence generation must be an integer of at least ${minimum}.`);
  }
  return parsed;
}

function normalizeBatch(evidenceUnits: readonly BulkBootstrapEvidenceUnit[]) {
  if (!Array.isArray(evidenceUnits) || evidenceUnits.length === 0) {
    throw new Error("At least one bulk bootstrap evidence unit is required.");
  }
  const units = evidenceUnits.map(normalizeUnit).sort((left, right) => unitKey(left).localeCompare(unitKey(right)));
  const keys = new Set<string>();
  const manifestSha256 = units[0].manifestSha256;
  for (const unit of units) {
    const key = unitKey(unit);
    if (keys.has(key)) throw new Error(`Duplicate bulk bootstrap evidence unit ${key}.`);
    keys.add(key);
    if (unit.manifestSha256 !== manifestSha256) {
      throw new Error("A publication batch must use one verified manifest SHA-256.");
    }
  }
  return units;
}

function normalizeUnit(unit: BulkBootstrapEvidenceUnit): NormalizedUnit {
  if (!SOURCE_FAMILIES.has(unit.sourceFamily)) throw new Error(`Unsupported source family: ${unit.sourceFamily}.`);
  assertCanonicalMonth(unit.periodStart, unit.periodEnd);
  assertSha256(unit.artifactSha256, "artifactSha256");
  assertSha256(unit.manifestSha256, "manifestSha256");
  if (typeof unit.currentMonth !== "boolean") throw new Error("currentMonth must be boolean.");
  if (typeof unit.detailCoverageRequired !== "boolean") throw new Error("detailCoverageRequired must be boolean.");
  if (unit.state !== undefined && unit.state !== "partial" && unit.state !== "unavailable") {
    throw new Error(`Invalid evidence state for ${unit.sourceFamily}/${unit.periodStart}.`);
  }
  if (unit.continuationToken !== undefined && unit.continuationToken !== null && !isRecord(unit.continuationToken)) {
    throw new Error("continuationToken must be an object or null.");
  }

  const evidenceAsOf = new Date(unit.evidenceAsOf);
  if (Number.isNaN(evidenceAsOf.getTime())) throw new Error("A valid evidenceAsOf timestamp is required.");
  const exactSourceIds = canonicalIds(unit.exactSourceIds, "exactSourceIds");
  const listedSourceIds = canonicalIds(unit.listedSourceIds, "listedSourceIds");
  const detailedSourceIds = canonicalIds(unit.detailedSourceIds, "detailedSourceIds");
  const normalizedSourceIds = canonicalIds(unit.normalizedSourceIds, "normalizedSourceIds");
  const pages = normalizePages(unit.pages, unit.sourceFamily);
  const requiredTargetKeys = [...new Set(pages.map((page) => page.targetKey))].sort();
  const completedTargetKeys = requiredTargetKeys.filter((targetKey) => targetComplete(pages, targetKey));
  const pageSourceIds = canonicalIds(pages.flatMap((page) => page.exactIds), "page exactIds", true);
  const openQuoteDiscovery = normalizeOpenQuoteDiscovery(unit);
  const periodDetailIds = unit.detailCoverageRequired ? detailedSourceIds : listedSourceIds;
  const gateFailures: string[] = [];

  if (!sameIds(pageSourceIds, exactSourceIds)) gateFailures.push("page IDs do not equal exact source IDs");
  if (completedTargetKeys.length !== requiredTargetKeys.length) gateFailures.push("one or more traversal targets lack a terminal page");
  if (!sameIds(listedSourceIds, exactSourceIds)) gateFailures.push("listed IDs do not equal exact source IDs");
  if (unit.detailCoverageRequired && !sameIds(detailedSourceIds, listedSourceIds)) {
    gateFailures.push("required detail IDs do not equal listed IDs");
  }
  if (!sameIds(normalizedSourceIds, exactSourceIds)) gateFailures.push("normalized IDs do not equal exact source IDs");
  const sourceValue = finiteValue(unit.sourceValue, "sourceValue");
  const normalizedValue = finiteValue(unit.normalizedValue, "normalizedValue");
  if (sourceValue === null || normalizedValue === null) {
    gateFailures.push("source and normalized values must both be finite numbers");
  } else if (sourceValue !== normalizedValue) {
    gateFailures.push("source and normalized values do not match");
  }
  if (unit.continuationToken) gateFailures.push("continuation token remains");
  const asOfPacificDate = pacificDate(evidenceAsOf);
  const requiredAsOfDate = unit.currentMonth ? unit.periodStart : addUtcMonths(unit.periodStart, 1);
  if (asOfPacificDate < requiredAsOfDate) gateFailures.push("evidenceAsOf does not cover the declared period boundary");
  const openQuoteDiscoveryRequired = unit.sourceFamily === "quotes" && unit.currentMonth
    || openQuoteDiscovery.required === true;
  if (openQuoteDiscoveryRequired && openQuoteDiscovery.status !== "complete") {
    gateFailures.push("current quote open-discovery evidence is incomplete");
  }

  const exactComplete = unit.state === undefined && gateFailures.length === 0;
  if (unit.state === undefined && !exactComplete) {
    throw new Error(
      `Bulk evidence mismatch for ${unit.sourceFamily}/${unit.periodStart}: ${gateFailures.join("; ")}. Mark the unit partial or unavailable to fail closed.`,
    );
  }

  return {
    ...unit,
    exactSourceIds,
    listedSourceIds,
    detailedSourceIds,
    normalizedSourceIds,
    periodDetailIds,
    sourceValue,
    normalizedValue,
    pages,
    evidenceAsOf: evidenceAsOf.toISOString(),
    openQuoteDiscovery,
    continuationToken: unit.continuationToken ?? null,
    requiredTargetKeys,
    completedTargetKeys,
    gateFailures,
    exactComplete,
  };
}

function normalizePages(pages: BulkBootstrapEvidencePage[], sourceFamily: BackfillSourceFamily) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("Each evidence unit requires at least one projected traversal page.");
  }
  const pageIdentities = new Set<string>();
  const requiredSourceMethod = ARTIFACT_LIST_METHODS[sourceFamily];
  if (!requiredSourceMethod) throw new Error(`Unsupported source family: ${sourceFamily}.`);
  return pages.map((page) => {
    for (const [field, value] of [
      ["targetKey", page.targetKey],
      ["sourceMethod", page.sourceMethod],
      ["requestIdentity", page.requestIdentity],
      ["pageIdentity", page.pageIdentity],
    ] as const) {
      if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required for every evidence page.`);
    }
    if (pageIdentities.has(page.pageIdentity)) throw new Error(`Duplicate page identity ${page.pageIdentity}.`);
    pageIdentities.add(page.pageIdentity);
    if (page.sourceMethod !== requiredSourceMethod) {
      throw new Error(
        `${sourceFamily} page ${page.pageIdentity} must be immutable ${requiredSourceMethod} list-response evidence; `
        + `received ${page.sourceMethod}.`,
      );
    }
    assertSha256(page.requestSha256, "requestSha256");
    assertSha256(page.pageSha256, "pageSha256");
    assertInteger(page.pageNumber, "pageNumber", 1);
    assertInteger(page.pageSize, "pageSize", 1);
    assertInteger(page.rowCount, "rowCount", 0);
    if (!isRecord(page.requestQuery)) throw new Error("requestQuery must be an object.");
    if (typeof page.terminal !== "boolean") throw new Error("terminal must be boolean.");
    const exactIds = canonicalIds(page.exactIds, `page ${page.pageIdentity} exactIds`);
    const expectedRequestSha256 = bulkEvidenceRequestSha256(page.requestQuery);
    if (page.requestSha256 !== expectedRequestSha256) {
      throw new Error(
        `Page ${page.pageIdentity} requestSha256 does not match its immutable request query.`,
      );
    }
    const expectedPageSha256 = bulkEvidencePageSha256(page.pageIdentity, exactIds);
    if (page.pageSha256 !== expectedPageSha256) {
      throw new Error(
        `Page ${page.pageIdentity} pageSha256 does not match its immutable page identity and exact IDs.`,
      );
    }
    if (page.rowCount !== exactIds.length) {
      throw new Error(`Page ${page.pageIdentity} rowCount does not equal its exact ID count.`);
    }
    if (page.pageSize < page.rowCount) {
      throw new Error(`Page ${page.pageIdentity} pageSize is smaller than rowCount.`);
    }
    const continuationPage = page.continuationPage ?? null;
    if (page.terminal && continuationPage !== null) {
      throw new Error(`Terminal page ${page.pageIdentity} cannot have a continuation page.`);
    }
    if (!page.terminal) {
      assertInteger(continuationPage, "continuationPage", 1);
      if (continuationPage !== page.pageNumber + 1) {
        throw new Error(`Page ${page.pageIdentity} has a non-sequential continuation page.`);
      }
    }
    assertOptionalDate(page.observedMinDate, "observedMinDate");
    assertOptionalDate(page.observedMaxDate, "observedMaxDate");
    return {
      ...page,
      exactIds,
      continuationPage,
      observedMinDate: page.observedMinDate ?? null,
      observedMaxDate: page.observedMaxDate ?? null,
    };
  });
}

function normalizeOpenQuoteDiscovery(unit: BulkBootstrapEvidenceUnit) {
  const required = unit.sourceFamily === "quotes" && unit.currentMonth;
  const supplied = unit.openQuoteDiscovery;
  if (supplied !== undefined && !isRecord(supplied)) throw new Error("openQuoteDiscovery must be an object.");
  const value = supplied ?? { required, status: required ? "pending" : "not_required" };
  return {
    ...value,
    required: value.required === true || required,
    status: typeof value.status === "string" ? value.status : required ? "pending" : "not_required",
    evidenceSource: PROJECTION_PROVENANCE,
  };
}

function targetComplete(pages: NormalizedPage[], targetKey: string) {
  const targetPages = pages.filter((page) => page.targetKey === targetKey).sort((left, right) => left.pageNumber - right.pageNumber);
  if (targetPages.some((page, index) => page.pageNumber !== index + 1)) return false;
  return targetPages.filter((page) => page.terminal).length === 1 && targetPages.at(-1)?.terminal === true;
}

function reconciliationDetail(unit: NormalizedUnit, generation: number) {
  return {
    basis: "checksum-verified full-universe bulk artifact projection",
    authority: PROJECTION_PROVENANCE,
    manifestGeneration: generation,
    publicationState: unit.exactComplete ? "matched" : unit.state,
    stateReason: unit.stateReason ?? null,
    gateFailures: unit.gateFailures,
    pageCount: unit.pages.length,
    exactSourceCount: unit.exactSourceIds.length,
    listedCount: unit.listedSourceIds.length,
    detailedCount: unit.detailedSourceIds.length,
    normalizedCount: unit.normalizedSourceIds.length,
    sourceValue: unit.sourceValue,
    normalizedValue: unit.normalizedValue,
    ...artifactEvidence(unit),
  };
}

function artifactEvidence(unit: Pick<NormalizedUnit, "artifactSha256" | "manifestSha256">) {
  return {
    provenance: PROJECTION_PROVENANCE,
    artifactSha256: unit.artifactSha256,
    manifestSha256: unit.manifestSha256,
    checksumVerifiedFullUniverseArtifact: true,
    fabricatedApiResponse: false,
  };
}

function quoteDiscoveryRequired(unit: Pick<NormalizedUnit, "sourceFamily" | "currentMonth" | "openQuoteDiscovery">) {
  return unit.sourceFamily === "quotes" && unit.currentMonth
    || unit.openQuoteDiscovery.required === true;
}

function publicationResult(
  units: NormalizedUnit[],
  manifestSha256: string,
  batchEvidenceSha256: string,
  idempotent: boolean,
): BulkBootstrapEvidencePublicationResult {
  return {
    manifestSha256,
    batchEvidenceSha256,
    publishedUnits: units.length,
    completedUnits: units.filter((unit) => unit.exactComplete).length,
    partialUnits: units.filter((unit) => unit.state === "partial").length,
    unavailableUnits: units.filter((unit) => unit.state === "unavailable").length,
    pageCount: units.reduce((count, unit) => count + unit.pages.length, 0),
    reconciliationCount: units.length,
    idempotent,
  };
}

function storedPublicationResult(value: unknown): BulkBootstrapEvidencePublicationResult {
  const record = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!isRecord(record)
      || typeof record.manifestSha256 !== "string"
      || typeof record.batchEvidenceSha256 !== "string") {
    throw new Error("Stored bulk evidence audit result is invalid.");
  }
  const numericFields = [
    "publishedUnits",
    "completedUnits",
    "partialUnits",
    "unavailableUnits",
    "pageCount",
    "reconciliationCount",
  ] as const;
  for (const field of numericFields) {
    if (!Number.isInteger(record[field]) || Number(record[field]) < 0) {
      throw new Error("Stored bulk evidence audit result is invalid.");
    }
  }
  return {
    manifestSha256: record.manifestSha256,
    batchEvidenceSha256: record.batchEvidenceSha256,
    publishedUnits: Number(record.publishedUnits),
    completedUnits: Number(record.completedUnits),
    partialUnits: Number(record.partialUnits),
    unavailableUnits: Number(record.unavailableUnits),
    pageCount: Number(record.pageCount),
    reconciliationCount: Number(record.reconciliationCount),
    idempotent: false,
  };
}

function normalizeQueryClient(client: BulkBootstrapEvidenceQuery | BulkBootstrapEvidenceQueryClient) {
  return typeof client === "function" ? client : client.query.bind(client) as BulkBootstrapEvidenceQuery;
}

function rejectStaleEvidence(unit: NormalizedUnit, existingAsOf: string | undefined, target: string) {
  if (existingAsOf && Date.parse(existingAsOf) > Date.parse(unit.evidenceAsOf)) {
    throw new Error(`Bulk evidence for ${unitKey(unit)} is older than the existing ${target}.`);
  }
}

function nextGeneration(...values: unknown[]) {
  let current = 0;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid existing bulk evidence generation: ${String(value)}.`);
    current = Math.max(current, parsed);
  }
  if (current >= Number.MAX_SAFE_INTEGER) throw new Error("Bulk evidence generation cannot be incremented safely.");
  return current + 1;
}

function canonicalIds(values: Array<string | number>, field: string, allowDuplicates = false) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  const mapped = values.map((value) => {
    if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) {
      throw new Error(`${field} contains an invalid source identity.`);
    }
    return String(value);
  });
  const unique = [...new Set(mapped)];
  if (!allowDuplicates && unique.length !== mapped.length) throw new Error(`${field} contains duplicate identities.`);
  return unique.sort(compareExactSourceIds);
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function difference(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function observedSourceMaxDate(pages: NormalizedPage[]) {
  return pages.map((page) => page.observedMaxDate).filter((date): date is string => Boolean(date)).sort().at(-1) ?? null;
}

function effectiveEndInclusive(unit: Pick<NormalizedUnit, "currentMonth" | "evidenceAsOf" | "periodEnd">) {
  return unit.currentMonth ? minDate(unit.periodEnd, pacificDate(unit.evidenceAsOf)) : unit.periodEnd;
}

function pacificDate(value: Date | string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function minDate(left: string, right: string) {
  return left < right ? left : right;
}

function finiteValue(value: unknown, field: string) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number or null.`);
  return Math.round(value * 100) / 100;
}

function assertCanonicalMonth(start: string, end: string) {
  if (!/^\d{4}-\d{2}-01$/.test(start)) throw new Error(`Invalid period start: ${start}.`);
  const expectedEnd = new Date(`${addUtcMonths(start, 1)}T00:00:00.000Z`);
  expectedEnd.setUTCDate(expectedEnd.getUTCDate() - 1);
  if (end !== expectedEnd.toISOString().slice(0, 10)) {
    throw new Error(`Period end ${end} does not match month ${start}.`);
  }
}

function addUtcMonths(value: string, count: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}.`);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 10);
}

function assertSha256(value: string, field: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be a lowercase SHA-256.`);
}

function assertInteger(value: unknown, field: string, minimum: number): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < minimum) throw new Error(`${field} must be an integer of at least ${minimum}.`);
}

function assertOptionalDate(value: string | null | undefined, field: string) {
  if (value !== undefined && value !== null && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must be an ISO date or null.`);
  }
}

function unitKey(unit: Pick<NormalizedUnit, "sourceFamily" | "periodStart">) {
  return `${unit.sourceFamily}:${unit.periodStart}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function bulkEvidenceRequestSha256(requestQuery: Record<string, unknown>) {
  return sha256(stableJson(requestQuery));
}

export function bulkEvidencePageSha256(pageIdentity: string, exactIds: readonly string[]) {
  return sha256(stableJson({ pageIdentity, ids: sortExactSourceIds(exactIds) }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

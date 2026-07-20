import { businessCurrentMonth } from "@/lib/backfill/plan";
import type {
  BackfillRepairPlan,
  BackfillReconciliationEvidence,
  BackfillWorkUnit,
} from "@/lib/store/backfill-ledger";
import { queryPostgres } from "@/lib/store/postgres";
import { buildSourcePeriodManifestEvidence } from "@/lib/store/source-period-manifests";

type EvidenceRow = {
  id: string;
  source_date: string | null;
};

export type AuthoritativeBackfillManifest = {
  generation: number;
  manifest_status: "collecting" | "completed" | "provisional" | "invalid" | "unavailable";
  filter_contract: Record<string, unknown>;
  as_of_watermark: string;
  observed_boundary: Record<string, unknown>;
  exact_source_ids: string[];
  listed_source_ids: string[];
  detailed_source_ids: string[];
  completed_target_keys: string[];
  required_target_keys: string[];
  continuation_token: Record<string, unknown> | null;
  detail_coverage_required: boolean;
  page_count: number;
  record_count: number;
  empty_proof: Record<string, unknown> | null;
  open_quote_discovery: Record<string, unknown>;
  exclusions: unknown[];
  violations: unknown[];
  source_max_date: string | null;
};

export async function reconcileBackfillWorkUnit(
  workUnit: BackfillWorkUnit,
): Promise<BackfillReconciliationEvidence> {
  const manifest = await loadAuthoritativeManifest(workUnit.id);
  authoritativeTraversalGeneration(workUnit, manifest);
  const authorityFailure = authoritativeManifestFailure(workUnit, manifest);
  let evidence: BackfillReconciliationEvidence;
  if (authorityFailure) {
    evidence = authorityFailure;
  } else switch (workUnit.source_family) {
    case "quotes":
      evidence = await reconcileQuotes(workUnit, manifest!);
      break;
    case "jobs":
      evidence = await reconcileJobs(workUnit, manifest!);
      break;
    case "quote_nested":
    case "job_nested":
      evidence = await reconcileNested(workUnit, manifest!);
      break;
    case "employees":
      evidence = await reconcileEmployees(workUnit, manifest!);
      break;
    case "timesheets":
      evidence = await reconcileTimesheets(workUnit, manifest!);
      break;
    case "jobs_from_timesheets":
      evidence = await reconcileTimesheetJobReferences(workUnit, manifest!);
      break;
    case "schedules":
      evidence = await reconcileSchedules(workUnit, manifest!);
      break;
    case "mobile_status":
      evidence = await reconcileMobileCoverage(workUnit, manifest!);
      break;
    default:
      assertNever(workUnit.source_family);
  }
  return {
    ...evidence,
    sourcePeriodManifest: buildBackfillSourcePeriodProjection(workUnit, manifest, evidence),
  };
}

async function reconcileQuotes(workUnit: BackfillWorkUnit, manifest: AuthoritativeBackfillManifest) {
  const openDiscoveryRequired = manifest.open_quote_discovery.required === true;
  const normalized = await queryPostgres<EvidenceRow>(
    openDiscoveryRequired
      ? `select quote_id::text as id, coalesce(date_approved, date_issued)::text as source_date
           from metrics.metrics_quotes
          where source_deleted_at is null
          order by quote_id`
      : `select quote_id::text as id,
                case when date_approved >= $1::date and date_approved < $2::date
                     then date_approved::text else date_issued::text end as source_date
           from metrics.metrics_quotes
          where ((date_approved >= $1::date and date_approved < $2::date)
                 or (date_issued >= $1::date and date_issued < $2::date))
            and source_deleted_at is null
          order by quote_id`,
    openDiscoveryRequired ? [] : [workUnit.month_start, manifestEndExclusive(manifest)],
  );
  const open = await queryPostgres<{ id: string }>(
    `select quote_id::text as id
       from metrics.metrics_quotes
      where outcome = 'open' and source_deleted_at is null
      order by quote_id`,
  );
  const evidence = compareManifestRows(
    workUnit,
    manifest,
    normalized.rows,
    openDiscoveryRequired
      ? "Authoritative current quote universe, including required open-quote discovery"
      : "Authoritative DateApproved/DateIssued source-page union",
  );
  const sourceIds = new Set(manifest.exact_source_ids);
  const missingOpenIds = open.rows.map((row) => row.id).filter((id) => !sourceIds.has(id));
  if (openDiscoveryRequired && (manifest.open_quote_discovery.status !== "complete" || missingOpenIds.length > 0)) {
    evidence.status = "mismatch";
  }
  evidence.detail.openQuoteDiscovery = {
    required: openDiscoveryRequired,
    manifestStatus: manifest.open_quote_discovery.status,
    normalizedOpenQuoteCount: open.rows.length,
    missingOpenQuoteIds: missingOpenIds,
  };
  return evidence;
}

async function reconcileJobs(workUnit: BackfillWorkUnit, manifest: AuthoritativeBackfillManifest) {
  const normalized = await queryPostgres<EvidenceRow>(
    `select job_id::text as id, completed_date::text as source_date
       from metrics.metrics_jobs
      where completed_date >= $1::date and completed_date < $2::date
        and source_deleted_at is null
      order by job_id`,
    [workUnit.month_start, manifestEndExclusive(manifest)],
  );
  return compareManifestRows(workUnit, manifest, normalized.rows, "Authoritative CompletedDate source-page facts");
}

async function reconcileNested(workUnit: BackfillWorkUnit, manifest: AuthoritativeBackfillManifest) {
  const quote = workUnit.source_family === "quote_nested";
  const completedRows = await queryPostgres<EvidenceRow>(
    `with latest as (
       select distinct on (entity_id) entity_id, complete_traversal
         from metrics.raw_simpro_snapshots
        where entity_type = any($1::text[]) and source_deleted_at is null
        order by entity_id, extracted_at desc, id desc
     )
     select entity_id as id, null::text as source_date
       from latest
      where complete_traversal = true
        and entity_id = any($2::text[])
      order by entity_id::bigint`,
    [quote ? ["quote_details", "quotes"] : ["job_details", "jobs"], manifest.exact_source_ids],
  );
  return compareManifestRows(
    workUnit,
    manifest,
    completedRows.rows,
    "Every authoritative parent ID has a committed complete nested traversal; empty child collections remain explicit in page evidence.",
    true,
  );
}

async function reconcileEmployees(workUnit: BackfillWorkUnit, manifest: AuthoritativeBackfillManifest) {
  const normalized = await queryPostgres<EvidenceRow>(
    `select employee_id::text as id, null::text as source_date
       from metrics.employee_snapshots
      order by employee_id`,
  );
  return compareManifestRows(workUnit, manifest, normalized.rows, "Authoritative employee identity snapshot");
}

async function reconcileTimesheets(workUnit: BackfillWorkUnit, manifest: AuthoritativeBackfillManifest) {
  const normalized = await queryPostgres<EvidenceRow>(
    `select employee_id::text || ':' || timesheet_id as id, work_date::text as source_date
       from metrics.metrics_employee_timesheets
      where work_date >= $1::date and work_date < $2::date
        and source_deleted_at is null
      order by employee_id, timesheet_id`,
    [workUnit.month_start, manifestEndExclusive(manifest)],
  );
  return compareManifestRows(workUnit, manifest, normalized.rows, "Authoritative EmployeeID/UID timesheet identity");
}

async function reconcileTimesheetJobReferences(workUnit: BackfillWorkUnit, manifest: AuthoritativeBackfillManifest) {
  const normalized = await queryPostgres<EvidenceRow>(
    `select j.job_id::text as id, max(t.work_date)::text as source_date
       from metrics.metrics_employee_timesheets t
       join metrics.metrics_jobs j on j.job_id = t.reference_id and j.source_deleted_at is null
      where t.reference_type = 'job'
        and t.reference_id is not null
        and t.work_date >= $1::date and t.work_date < $2::date
        and t.source_deleted_at is null
      group by j.job_id
      order by j.job_id`,
    [workUnit.month_start, manifestEndExclusive(manifest)],
  );
  return compareManifestRows(
    workUnit,
    manifest,
    normalized.rows,
    "Timesheet job references derived only from a completed authoritative timesheet dependency manifest",
  );
}

async function reconcileSchedules(workUnit: BackfillWorkUnit, manifest: AuthoritativeBackfillManifest) {
  const normalized = await queryPostgres<EvidenceRow>(
    `select schedule_id::text as id, schedule_date::text as source_date
       from metrics.metrics_schedules
      where schedule_date >= $1::date and schedule_date < $2::date
        and source_deleted_at is null
      order by schedule_id`,
    [workUnit.month_start, manifestEndExclusive(manifest)],
  );
  return compareManifestRows(workUnit, manifest, normalized.rows, "Authoritative schedule ID and source date");
}

async function reconcileMobileCoverage(
  workUnit: BackfillWorkUnit,
  manifest: AuthoritativeBackfillManifest,
): Promise<BackfillReconciliationEvidence> {
  if (manifest.manifest_status !== "unavailable") {
    const normalized = await queryPostgres<EvidenceRow>(
      `select simpro_log_id::text as id,
              (date_logged at time zone 'America/Los_Angeles')::date::text as source_date
         from metrics.metrics_mobile_status_logs
        where date_logged >= ($1::date::timestamp at time zone 'America/Los_Angeles')
          and date_logged < ($2::date::timestamp at time zone 'America/Los_Angeles')
        order by simpro_log_id`,
      [workUnit.month_start, manifestEndExclusive(manifest)],
    );
    return compareManifestRows(
      workUnit,
      manifest,
      normalized.rows,
      "Exact mobile-status IDs from the checksum-verified full historical traversal",
    );
  }

  const result = await queryPostgres<{ count: number; source_max_date: string | null }>(
    `select count(*)::int as count, max((date_logged at time zone 'America/Los_Angeles')::date)::text as source_max_date
       from metrics.metrics_mobile_status_logs
      where date_logged >= ($1::date::timestamp at time zone 'America/Los_Angeles')
        and date_logged < ($2::date::timestamp at time zone 'America/Los_Angeles')`,
    [workUnit.month_start, manifestEndExclusive(manifest)],
  );
  const count = result.rows[0]?.count ?? 0;
  return {
    status: count > 0 ? "partial" : "unavailable",
    sourceRecordCount: count,
    normalizedRecordCount: count,
    sourceMaxDate: result.rows[0]?.source_max_date ?? null,
    missingSourceIds: [],
    extraNormalizedIds: [],
    repairPlans: [],
    detail: {
      basis: "The authoritative manifest explicitly records historical mobile traversal as unavailable.",
      authoritativeManifest: manifestSummary(manifest),
      requiredForSourceFactCompletion: false,
    },
  };
}

function compareManifestRows(
  workUnit: BackfillWorkUnit,
  manifest: AuthoritativeBackfillManifest,
  normalizedRows: EvidenceRow[],
  basis: string,
  nested = false,
): BackfillReconciliationEvidence {
  const sourceIds = new Set(manifest.exact_source_ids);
  const normalizedIds = new Set(normalizedRows.map((row) => row.id));
  const missingSourceIds = [...sourceIds].filter((id) => !normalizedIds.has(id)).sort(idSort);
  const extraNormalizedIds = [...normalizedIds].filter((id) => !sourceIds.has(id)).sort(idSort);
  const repairPlans = buildRepairPlans(missingSourceIds, extraNormalizedIds, nested);
  return {
    status: missingSourceIds.length === 0 && extraNormalizedIds.length === 0 ? "matched" : "mismatch",
    sourceRecordCount: sourceIds.size,
    normalizedRecordCount: normalizedIds.size,
    sourceMaxDate: manifest.source_max_date,
    missingSourceIds,
    extraNormalizedIds,
    repairPlans,
    detail: {
      basis,
      authoritativeManifest: manifestSummary(manifest),
      expectedPagesEstimate: workUnit.expected_pages,
      expectedRecordsEstimate: workUnit.expected_records,
      estimatedNestedRequests: workUnit.estimated_nested_requests,
      actualRequests: workUnit.actual_requests,
      snapshotsWritten: workUnit.snapshot_count,
      normalizedWrites: workUnit.normalized_count,
      countDrift: normalizedIds.size - sourceIds.size,
      exactIdComparison: true,
      authorityBasis: "persisted Simpro traversal manifest, not local raw-snapshot equality",
      domainRollupsChecked: false,
      commissionRunsChecked: false,
      destructiveWritesPerformed: false,
    },
  };
}

function buildRepairPlans(missing: string[], extra: string[], nested: boolean): BackfillRepairPlan[] {
  const plans: BackfillRepairPlan[] = [];
  if (missing.length > 0) {
    plans.push({
      action: nested ? "repair_nested_traversal" : "refresh_or_normalize",
      entityIds: missing,
      rationale: nested
        ? "Authoritative parent IDs lack a committed complete nested traversal."
        : "Authoritative source IDs are absent from the normalized source facts.",
      evidence: { automaticWrite: false, direction: "source_to_normalized" },
    });
  }
  if (extra.length > 0) {
    plans.push({
      action: "verify_deletion_or_window_move",
      entityIds: extra,
      rationale: "Normalized IDs were not present in the authoritative source traversal; verify deletion, archive, or date-window movement.",
      evidence: { automaticWrite: false, tombstoneCandidate: true },
    });
    plans.push({
      action: "tombstone_after_authoritative_confirmation",
      entityIds: extra,
      rationale: "Apply tombstones only after an independent detail lookup or a second complete authoritative traversal confirms source deletion.",
      evidence: { automaticWrite: false, confirmationRequired: true },
    });
  }
  return plans;
}

async function loadAuthoritativeManifest(workUnitId: number): Promise<AuthoritativeBackfillManifest | null> {
  const result = await queryPostgres<AuthoritativeBackfillManifest>(
    `select m.generation,
            m.manifest_status,
            m.filter_contract,
            m.as_of_watermark::text,
            m.observed_boundary,
            m.exact_source_ids,
            m.listed_source_ids,
            m.detailed_source_ids,
            m.completed_target_keys,
            m.required_target_keys,
            m.continuation_token,
            m.detail_coverage_required,
            m.page_count,
            m.record_count,
            m.empty_proof,
            m.open_quote_discovery,
            m.exclusions,
            m.violations,
            max(p.observed_max_date)::text as source_max_date
       from metrics.backfill_traversal_manifests m
       left join metrics.backfill_traversal_pages p
         on p.work_unit_id = m.work_unit_id and p.generation = m.generation
      where m.work_unit_id = $1
      group by m.work_unit_id, m.generation, m.manifest_status, m.filter_contract,
               m.as_of_watermark, m.observed_boundary, m.exact_source_ids,
               m.listed_source_ids, m.detailed_source_ids,
               m.completed_target_keys, m.required_target_keys, m.page_count,
               m.continuation_token, m.detail_coverage_required,
               m.record_count, m.empty_proof, m.open_quote_discovery,
               m.exclusions, m.violations`,
    [workUnitId],
  );
  return result.rows[0] ?? null;
}

function authoritativeManifestFailure(
  workUnit: BackfillWorkUnit,
  manifest: AuthoritativeBackfillManifest | null,
): BackfillReconciliationEvidence | null {
  const provisionalIsCurrent = manifest?.manifest_status === "provisional"
    && workUnit.month_start === businessCurrentMonth();
  const usable = manifest
    && (manifest.manifest_status === "completed" || provisionalIsCurrent
      || (!workUnit.required_for_completion && manifest.manifest_status === "unavailable"));
  if (usable) return null;

  return {
    status: "mismatch",
    sourceRecordCount: manifest?.record_count ?? 0,
    normalizedRecordCount: 0,
    sourceMaxDate: manifest?.source_max_date ?? null,
    missingSourceIds: [],
    extraNormalizedIds: [],
    repairPlans: [],
    detail: {
      basis: "Authoritative traversal manifest gate",
      authoritativeManifestPresent: Boolean(manifest),
      manifestStatus: manifest?.manifest_status ?? "missing",
      reason: manifest
        ? "Manifest is not completed for the current Pacific boundary."
        : "Local raw and normalized rows cannot certify a source/month without upstream traversal evidence.",
    },
  };
}

function manifestSummary(manifest: AuthoritativeBackfillManifest) {
  return {
    generation: manifest.generation,
    status: manifest.manifest_status,
    asOfWatermark: manifest.as_of_watermark,
    observedBoundary: manifest.observed_boundary,
    pageCount: manifest.page_count,
    recordCount: manifest.record_count,
    exactSourceIdsPersisted: manifest.exact_source_ids.length,
    completedTargetKeys: manifest.completed_target_keys,
    requiredTargetKeys: manifest.required_target_keys,
    emptyProof: manifest.empty_proof,
    exclusions: manifest.exclusions,
    violations: manifest.violations,
  };
}

function manifestEndExclusive(manifest: AuthoritativeBackfillManifest) {
  const value = manifest.observed_boundary.effectiveEndInclusive;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Authoritative manifest is missing its effective Pacific end boundary.");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function buildBackfillSourcePeriodProjection(
  workUnit: BackfillWorkUnit,
  manifest: AuthoritativeBackfillManifest | null,
  evidence: BackfillReconciliationEvidence,
) {
  const manifestGeneration = authoritativeTraversalGeneration(workUnit, manifest);
  const sourceIds = manifest?.exact_source_ids ?? [];
  const missing = new Set(evidence.missingSourceIds);
  const normalizedIds = sourceIds
    .filter((id) => !missing.has(id))
    .concat(evidence.extraNormalizedIds);
  const detailIds = manifest?.detail_coverage_required
    ? manifest.detailed_source_ids
    : sourceIds;
  return buildSourcePeriodManifestEvidence({
    sourceFamily: workUnit.source_family,
    periodStart: workUnit.month_start,
    periodEnd: monthEndInclusive(workUnit.month_end_exclusive),
    listedIds: sourceIds,
    detailIds,
    normalizedIds,
    continuationToken: manifest?.continuation_token ?? null,
    authoritativeListComplete: manifest?.manifest_status === "completed"
      || manifest?.manifest_status === "provisional",
    listRequestCount: manifest?.page_count ?? 0,
    manifestGeneration,
    reconciliationGeneration: evidence.status === "matched" ? manifestGeneration : null,
    reconciliationStatus: evidence.status === "partial" ? "unavailable" : evidence.status,
    evidenceAsOf: manifest?.as_of_watermark ?? new Date(),
    evidence: {
      authority: "backfill_traversal_manifest",
      workUnitId: workUnit.id,
      manifestGeneration: manifest?.generation ?? null,
      manifestStatus: manifest?.manifest_status ?? "missing",
      provisional: manifest?.manifest_status === "provisional",
      filterContract: manifest?.filter_contract ?? null,
      observedBoundary: manifest?.observed_boundary ?? null,
      reconciliationBasis: evidence.detail.basis ?? null,
    },
  });
}

function authoritativeTraversalGeneration(
  workUnit: BackfillWorkUnit,
  manifest: AuthoritativeBackfillManifest | null,
) {
  const claimedGeneration = workUnit.manifest_generation;
  if (
    manifest
    && claimedGeneration !== null
    && claimedGeneration !== undefined
    && manifest.generation !== claimedGeneration
  ) {
    throw new Error(
      `Claimed backfill traversal generation ${claimedGeneration} is stale; authoritative work unit ${workUnit.id} is generation ${manifest.generation}.`,
    );
  }
  const generation = manifest?.generation ?? claimedGeneration ?? 1;
  if (!Number.isInteger(generation) || generation <= 0) {
    throw new Error(`Backfill work unit ${workUnit.id} has no valid authoritative traversal generation.`);
  }
  return generation;
}

function monthEndInclusive(monthEndExclusive: string) {
  const end = new Date(`${monthEndExclusive}T00:00:00.000Z`);
  if (Number.isNaN(end.getTime())) throw new Error(`Invalid month end: ${monthEndExclusive}`);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

function idSort(left: string, right: string) {
  return left.localeCompare(right, "en", { numeric: true });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled backfill reconciliation source: ${value}`);
}

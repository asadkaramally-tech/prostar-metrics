import { buildFreshnessStatus, type FreshnessState, type FreshnessStatus } from "@/lib/metrics/freshness";
import {
  evaluatePageFreshness,
  historicalPageFreshnessRequirements,
  isAggregateFreshnessPageKey,
  pageFreshnessRequirements,
  type AggregateFreshnessEvaluation,
  type AggregateFreshnessPageKey,
  type ProfitCapacityCompletenessEvidence,
  type ReconciliationFreshnessEvidence,
  type RollupFreshnessEvidence,
  type SourceFreshnessEvidence,
} from "@/lib/store/freshness-evaluator";
import { queryPostgres } from "@/lib/store/postgres";

type FreshnessRow = {
  page_key: string;
  data_through: Date | string | null;
  last_successful_run_at: Date | string | null;
  last_failed_run_at: Date | string | null;
  max_age_hours: number | null;
  status: FreshnessState | null;
  coverage_json: unknown;
  reconciliation_status: string | null;
  last_reconciled_at: Date | string | null;
  updated_at: Date | string;
};

type SourceEvidenceRow = {
  source_family: string;
  last_successful_run_at: Date | string | null;
  last_failed_run_at: Date | string | null;
  last_change_at: Date | string | null;
  data_through: Date | string | null;
  pending_count: number | string;
  failed_count: number | string;
  complete_window: boolean | null;
  serving_window_complete: boolean | null;
  manifest_generation: number | string | null;
  reconciliation_generation: number | string | null;
  expected_page_count: number | string | null;
  completed_page_count: number | string | null;
  manifest_completed_at: Date | string | null;
  manifest_reconciled_at: Date | string | null;
  suspect_reason: string | null;
};

type ReconciliationRow = {
  status: "matched" | "mismatch" | "sample_missing";
  checked_at: Date | string;
};

export type RollupFreshnessRow = {
  rebuilt_at: Date | string | null;
  suspect_reason: string | null;
  pending_count: number | string;
  failed_count: number | string;
};

type ProfitCapacityCompletenessRow = {
  completed_jobs_missing: number | string;
  active_completed_cost_centers_missing: number | string;
  people_missing: number | string;
};

const pageMaxAgeHours: Record<AggregateFreshnessPageKey, number> = {
  quotes: 1,
  jobs: 1,
  technicians: 1,
  commissions: 1,
};

const statusLabels: Record<Exclude<FreshnessState, "missing">, string> = {
  current: "Data current",
  partial: "Partial source coverage",
  building: "Data is building",
  stale: "Data is stale",
  suspect: "Data reconciliation is suspect",
  failed: "Latest ingestion failed",
};

export async function getPageFreshness(pageKey: string, periodStart?: string): Promise<FreshnessStatus> {
  try {
    const row = await getFreshnessRow(pageKey);
    if (!row) {
      return buildFreshnessStatus({ pageKey, maxAgeHours: 24 });
    }

    if (isAggregateFreshnessPageKey(pageKey) && periodStart && periodStart < currentPacificMonth()) {
      const evaluation = await evaluateStoredPageFreshness(pageKey, row, periodStart);
      return freshnessStatusFromEvaluation(pageKey, row, evaluation, false);
    }

    return buildStoredFreshnessStatus(row);
  } catch (error) {
    return {
      pageKey,
      state: "missing",
      label: "Store unavailable",
      detail: error instanceof Error ? error.message : "Unable to read app-owned freshness state.",
      dataThrough: null,
      lastSuccessfulRunAt: null,
      lastFailedRunAt: null,
    };
  }
}

export function reconciliationScopeForPage(pageKey: AggregateFreshnessPageKey) {
  return pageKey === "commissions" ? "jobs" : pageKey;
}

export async function refreshPageFreshness(pageKey: string): Promise<FreshnessStatus | null> {
  return refreshPageFreshnessAttempt(pageKey, 0);
}

async function refreshPageFreshnessAttempt(pageKey: string, attempt: number): Promise<FreshnessStatus | null> {
  if (!isAggregateFreshnessPageKey(pageKey)) return null;
  const row = await getFreshnessRow(pageKey);
  if (!row) return null;

  const evaluation = await evaluateStoredPageFreshness(pageKey, row);
  const updated = await queryPostgres<{ updated_at: string }>(
    `update metrics.metrics_freshness
        set data_through = coalesce($3::timestamptz, data_through),
            last_successful_run_at = case
              when $2 in ('current', 'partial') then coalesce($4::timestamptz, last_successful_run_at)
              else last_successful_run_at
            end,
            last_failed_run_at = case
              when $5::timestamptz is null then last_failed_run_at
              else greatest(coalesce(last_failed_run_at, $5::timestamptz), $5::timestamptz)
            end,
            continuation_count = $6,
            coverage_json = coverage_json || $7::jsonb,
            reconciliation_status = $8,
            last_reconciled_at = $9::timestamptz,
            last_error = case when $2 in ('current', 'partial') then null else last_error end,
            status = $2,
            max_age_hours = $10,
            updated_at = now()
      where page_key = $1
        and updated_at = $11::timestamptz
      returning updated_at::text`,
    [
      pageKey,
      evaluation.state,
      evaluation.dataThrough,
      evaluation.lastSuccessfulRunAt,
      evaluation.lastFailedRunAt,
      evaluation.continuationCount,
      JSON.stringify({ detail: evaluation.detail, aggregate: evaluation.coverage }),
      evaluation.coverage.reconciliation.status,
      evaluation.coverage.reconciliation.checkedAt,
      pageMaxAgeHours[pageKey],
      row.updated_at,
    ],
  );

  if (updated.rowCount !== 1) {
    if (attempt < 2) return refreshPageFreshnessAttempt(pageKey, attempt + 1);
    return getPageFreshness(pageKey);
  }

  return freshnessStatusFromEvaluation(pageKey, row, evaluation);
}

export async function upsertFreshness(params: {
  pageKey: string;
  dataThrough?: Date | null;
  ingestionRunId?: number;
  status: Exclude<FreshnessState, "missing">;
  errorMessage?: string;
  sourceFamily?: string;
  sourceWindowStart?: Date | null;
  sourceWindowEnd?: Date | null;
  expectedThrough?: Date | null;
  continuationCount?: number;
  maxAgeHours?: number;
  reconciliationStatus?: string | null;
  lastReconciledAt?: Date | null;
  coverage?: Record<string, unknown>;
}) {
  const maxAgeHours = params.maxAgeHours
    ?? (isAggregateFreshnessPageKey(params.pageKey) ? pageMaxAgeHours[params.pageKey] : 24);
  await queryPostgres(
    `insert into metrics.metrics_freshness (
       page_key, data_through, last_successful_run_at, last_failed_run_at, last_ingestion_run_id,
       last_error, source_family, source_window_start, source_window_end, expected_through,
       continuation_count, coverage_json, reconciliation_status, status, last_reconciled_at,
       max_age_hours
     )
     values (
       $1, $2,
       case when $3 in ('current', 'partial') then now() else null end,
       case when $3 = 'failed' then now() else null end,
       $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $3, $13, $14
     )
     on conflict (page_key) do update set
       data_through = coalesce(excluded.data_through, metrics.metrics_freshness.data_through),
       last_successful_run_at = coalesce(excluded.last_successful_run_at, metrics.metrics_freshness.last_successful_run_at),
       last_failed_run_at = coalesce(excluded.last_failed_run_at, metrics.metrics_freshness.last_failed_run_at),
       last_ingestion_run_id = coalesce(excluded.last_ingestion_run_id, metrics.metrics_freshness.last_ingestion_run_id),
       last_error = case
         when metrics.metrics_freshness.status in ('failed', 'suspect', 'stale')
           and excluded.status in ('building', 'partial')
           then metrics.metrics_freshness.last_error
         else excluded.last_error
       end,
       source_family = coalesce(excluded.source_family, metrics.metrics_freshness.source_family),
       source_window_start = coalesce(excluded.source_window_start, metrics.metrics_freshness.source_window_start),
       source_window_end = coalesce(excluded.source_window_end, metrics.metrics_freshness.source_window_end),
       expected_through = coalesce(excluded.expected_through, metrics.metrics_freshness.expected_through),
       continuation_count = excluded.continuation_count,
       coverage_json = metrics.metrics_freshness.coverage_json || excluded.coverage_json,
       reconciliation_status = coalesce(excluded.reconciliation_status, metrics.metrics_freshness.reconciliation_status),
       last_reconciled_at = coalesce(excluded.last_reconciled_at, metrics.metrics_freshness.last_reconciled_at),
       status = case
         when metrics.metrics_freshness.status in ('failed', 'suspect', 'stale')
           and excluded.status in ('building', 'partial')
           then metrics.metrics_freshness.status
         else excluded.status
       end,
       max_age_hours = excluded.max_age_hours,
       updated_at = now()`,
    [
      params.pageKey,
      params.dataThrough ?? null,
      params.status,
      params.ingestionRunId ?? null,
      params.errorMessage ?? null,
      params.sourceFamily ?? null,
      params.sourceWindowStart ?? null,
      params.sourceWindowEnd ?? null,
      params.expectedThrough ?? null,
      params.continuationCount ?? 0,
      JSON.stringify(params.coverage ?? {}),
      params.reconciliationStatus ?? null,
      params.lastReconciledAt ?? null,
      maxAgeHours,
    ],
  );
}

async function getFreshnessRow(pageKey: string) {
  const result = await queryPostgres<FreshnessRow>(
    `select page_key, data_through, last_successful_run_at, last_failed_run_at, max_age_hours,
            status, coverage_json, reconciliation_status, last_reconciled_at,
            updated_at::text as updated_at
       from metrics.metrics_freshness
      where page_key = $1`,
    [pageKey],
  );
  return result.rows[0] ?? null;
}

async function evaluateStoredPageFreshness(
  pageKey: AggregateFreshnessPageKey,
  row: FreshnessRow,
  periodStart?: string,
) {
  const historical = Boolean(periodStart && periodStart < currentPacificMonth());
  const requirements = historical
    ? historicalPageFreshnessRequirements(pageKey)
    : pageFreshnessRequirements(pageKey);
  const sourceFamilies = requirements.map((item) => item.sourceFamily);
  const selectedPeriod = periodStart ?? currentPacificMonth();
  const sourceEvidencePromise = queryPostgres<SourceEvidenceRow>(
    `with requested as (
       select unnest($1::text[]) as source_family
     ), run_state as (
       select coalesce(source_family, entity_type::text) as source_family,
              max(finished_at) filter (where status = 'succeeded') as last_successful_run_at,
              max(finished_at) filter (where status = 'failed') as last_failed_run_at
         from metrics.ingestion_runs
        where coalesce(source_family, entity_type::text) = any($1::text[])
        group by coalesce(source_family, entity_type::text)
     ), queue_state as (
       select entity_type::text as source_family,
              count(*) filter (where status in ('queued', 'running'))::integer as pending_count,
              count(*) filter (where status = 'failed')::integer as failed_count
         from metrics.ingestion_jobs
        where entity_type::text = any($1::text[])
        group by entity_type::text
     ), watermark_state as (
       select distinct on (coalesce(source_family, entity))
              coalesce(source_family, entity) as source_family,
              status, last_success_at, last_attempt_at, expected_through,
              committed_date_logged, complete_window, gap_detected, updated_at
         from metrics.ingestion_watermarks
        where coalesce(source_family, entity) = any($1::text[])
          and window_key = 'incremental'
        order by coalesce(source_family, entity), updated_at desc
     )
     select requested.source_family,
            case when $3::boolean
              then case when manifest.coverage_status = 'complete' then manifest.completed_at end
              else coalesce(watermark.last_success_at, runs.last_successful_run_at,
                            case when manifest.coverage_status = 'complete' then manifest.completed_at end)
            end as last_successful_run_at,
            case when $3::boolean
              then case when manifest.coverage_status = 'failed' then manifest.updated_at end
              else greatest(runs.last_failed_run_at,
                            case when watermark.status = 'failed' then watermark.updated_at end,
                            case when manifest.coverage_status = 'failed' then manifest.updated_at end)
            end as last_failed_run_at,
            coalesce(manifest.completed_at, manifest.evidence_as_of) as last_change_at,
            case when $3::boolean
              then case when manifest.coverage_status = 'complete' then manifest.evidence_as_of end
              else coalesce(
                case when watermark.last_success_at is not null and not watermark.gap_detected then
                  coalesce(watermark.committed_date_logged, watermark.last_success_at)
                end,
                runs.last_successful_run_at,
                case when manifest.coverage_status = 'complete' then manifest.evidence_as_of end
              )
            end as data_through,
            case when $3::boolean
              then case when manifest.source_family is not null and manifest.coverage_status <> 'complete' then 1 else 0 end
              else coalesce(queue.pending_count, 0)
                + case when manifest.source_family is not null and manifest.coverage_status <> 'complete' then 1 else 0 end
                + case when watermark.status = 'running' then 1 else 0 end
            end::integer as pending_count,
            case when $3::boolean
              then case when manifest.coverage_status = 'failed' then 1 else 0 end
              else coalesce(queue.failed_count, 0)
                + case when manifest.coverage_status = 'failed' then 1 else 0 end
                + case when watermark.status = 'failed' then 1 else 0 end
            end::integer as failed_count,
            case
              when $3::boolean then manifest.coverage_status = 'complete' and manifest.continuation_token is null
              when watermark.source_family is not null and manifest.source_family is not null then
                watermark.complete_window
                and not watermark.gap_detected
                and manifest.coverage_status = 'complete'
                and manifest.continuation_token is null
              when watermark.source_family is not null then watermark.complete_window and not watermark.gap_detected
              else manifest.coverage_status = 'complete' and manifest.continuation_token is null
            end as complete_window,
            case
              when $3::boolean then manifest.coverage_status = 'complete' and manifest.continuation_token is null
              when watermark.source_family is not null then watermark.last_success_at is not null and not watermark.gap_detected
              else manifest.coverage_status = 'complete' and manifest.continuation_token is null
            end as serving_window_complete,
            manifest.manifest_generation,
            manifest.reconciliation_generation,
            manifest.expected_page_count,
            manifest.completed_page_count,
            manifest.completed_at as manifest_completed_at,
            manifest.reconciled_at as manifest_reconciled_at,
            case
              when $3::boolean and manifest.coverage_status = 'suspect'
                then coalesce(manifest.evidence_json ->> 'reason', 'Source-period manifest is suspect.')
              when $3::boolean and manifest.reconciliation_status = 'mismatch'
                then coalesce(manifest.evidence_json ->> 'reason', 'Source-period reconciliation mismatched.')
              when $3::boolean then null
              when watermark.gap_detected then 'The incremental source watermark reports a gap.'
              when manifest.coverage_status = 'suspect' then coalesce(manifest.evidence_json ->> 'reason', 'Source-period manifest is suspect.')
              when manifest.reconciliation_status = 'mismatch' then coalesce(manifest.evidence_json ->> 'reason', 'Source-period reconciliation mismatched.')
              else null
            end as suspect_reason
       from requested
       left join metrics.source_period_manifests manifest
         on manifest.source_family = requested.source_family
        and manifest.period_start = $2::date
       left join run_state runs on runs.source_family = requested.source_family
       left join queue_state queue on queue.source_family = requested.source_family
       left join watermark_state watermark on watermark.source_family = requested.source_family
      order by requested.source_family`,
    [sourceFamilies, selectedPeriod, historical],
  );
  const [sourceRows, reconciliationResult, rollupResult, completenessResult] = await Promise.all([
    sourceEvidencePromise,
    queryPostgres<ReconciliationRow>(
      `select status, checked_at
         from metrics.authoritative_reconciliation_results
        where scope = $1
          and period_start = $2::date
        order by checked_at desc, id desc
        limit 1`,
      [reconciliationScopeForPage(pageKey), selectedPeriod],
    ),
    queryPostgres<RollupFreshnessRow>(
      `with queue_state as (
         select count(*) filter (where status in ('queued', 'running'))::integer as pending_count,
                count(*) filter (where status = 'failed')::integer as failed_count
           from metrics.rollup_rebuild_queue
          where metric_family = $1
            and period_start = $2::date
       ), latest_model as (
         select rebuilt_at, suspect_reason
           from metrics.dashboard_read_models
          where metric_family = $1
            and period_grain = 'month'
            and period_start = $2::date
            and superseded_at is null
          order by rebuilt_at desc
          limit 1
       ), latest_successful_rebuild as (
         select max(finished_at) as finished_at
           from metrics.rollup_rebuild_queue
          where metric_family = $1
            and period_start = $2::date
            and status = 'succeeded'
       )
       select greatest(latest_model.rebuilt_at, latest_successful_rebuild.finished_at) as rebuilt_at,
              latest_model.suspect_reason,
              queue_state.pending_count, queue_state.failed_count
         from queue_state
         left join latest_model on true
         left join latest_successful_rebuild on true`,
      [pageKey, selectedPeriod],
    ),
    !historical && (pageKey === "jobs" || pageKey === "technicians")
      ? queryPostgres<ProfitCapacityCompletenessRow>(
          `select completed_jobs_missing, active_completed_cost_centers_missing, people_missing
             from metrics.simpro_profit_capacity_completeness`,
        )
      : Promise.resolve({ rows: [], rowCount: 0 }),
  ]);

  const reconciliationRow = reconciliationResult.rows[0];
  const rollupRow = rollupResult.rows[0];
  return evaluatePageFreshness({
    pageKey,
    requirements,
    sources: sourceRows.rows.map(sourceEvidence),
    reconciliation: reconciliationEvidence(reconciliationRow),
    rollup: rollupEvidence(rollupRow),
    profitCapacityCompleteness: completenessEvidence(completenessResult.rows[0]),
    explicitState: historical ? null : row.status,
    explicitDetail: historical ? null : coverageDetail(row.coverage_json),
    explicitFailedAt: historical ? null : row.last_failed_run_at,
    explicitReconciledAt: historical ? null : row.last_reconciled_at,
    sealedHistoricalPeriod: historical,
  });
}

function completenessEvidence(
  row: ProfitCapacityCompletenessRow | undefined,
): ProfitCapacityCompletenessEvidence | null {
  if (!row) return null;
  return {
    completedJobsMissing: numericCount(row.completed_jobs_missing),
    activeCompletedCostCentersMissing: numericCount(row.active_completed_cost_centers_missing),
    peopleMissing: numericCount(row.people_missing),
  };
}

function currentPacificMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}-01`;
}

function sourceEvidence(row: SourceEvidenceRow): SourceFreshnessEvidence {
  return {
    sourceFamily: row.source_family,
    lastSuccessfulRunAt: row.last_successful_run_at,
    lastFailedRunAt: row.last_failed_run_at,
    lastChangeAt: row.last_change_at,
    dataThrough: row.data_through,
    pendingCount: numericCount(row.pending_count),
    failedCount: numericCount(row.failed_count),
    completeWindow: row.complete_window,
    servingWindowComplete: row.serving_window_complete,
    manifestGeneration: nullableNumericCount(row.manifest_generation),
    reconciliationGeneration: nullableNumericCount(row.reconciliation_generation),
    expectedPageCount: nullableNumericCount(row.expected_page_count),
    completedPageCount: nullableNumericCount(row.completed_page_count),
    manifestCompletedAt: row.manifest_completed_at,
    manifestReconciledAt: row.manifest_reconciled_at,
    suspectReason: row.suspect_reason,
  };
}

function reconciliationEvidence(row: ReconciliationRow | undefined): ReconciliationFreshnessEvidence {
  return row
    ? { status: row.status, checkedAt: row.checked_at }
    : { status: "missing", checkedAt: null };
}

export function rollupEvidence(row: RollupFreshnessRow | undefined): RollupFreshnessEvidence {
  if (!row) return { status: "missing", detail: "No current-period rollup state is recorded." };
  if (numericCount(row.failed_count) > 0) {
    return {
      status: "failed",
      rebuiltAt: row.rebuilt_at,
      pendingCount: numericCount(row.pending_count),
      failedCount: numericCount(row.failed_count),
      detail: row.rebuilt_at
        ? "A later rollup rebuild attempt is dead-lettered; the prior ready read model remains available."
        : "A current-period rollup rebuild is dead-lettered.",
    };
  }
  if (row.suspect_reason) return {
    status: "suspect",
    rebuiltAt: row.rebuilt_at,
    pendingCount: numericCount(row.pending_count),
    failedCount: numericCount(row.failed_count),
    detail: row.suspect_reason,
  };
  if (numericCount(row.pending_count) > 0) {
    return row.rebuilt_at
      ? {
          status: "ready",
          rebuiltAt: row.rebuilt_at,
          pendingCount: numericCount(row.pending_count),
          failedCount: numericCount(row.failed_count),
          detail: `Serving the latest ready read model while ${numericCount(row.pending_count)} rollup rebuild ${numericCount(row.pending_count) === 1 ? "is" : "jobs are"} queued or running.`,
        }
      : {
          status: "building",
          rebuiltAt: row.rebuilt_at,
          pendingCount: numericCount(row.pending_count),
          failedCount: numericCount(row.failed_count),
          detail: "A current-period rollup rebuild is queued or running, with no ready read model.",
        };
  }
  if (!row.rebuilt_at) return { status: "missing", detail: "No current-period read model has been built." };
  return {
    status: "ready",
    rebuiltAt: row.rebuilt_at,
    pendingCount: numericCount(row.pending_count),
    failedCount: numericCount(row.failed_count),
  };
}

function freshnessStatusFromEvaluation(
  pageKey: AggregateFreshnessPageKey,
  row: FreshnessRow,
  evaluation: AggregateFreshnessEvaluation,
  useStoredFallback = true,
): FreshnessStatus {
  const servingDetail = evaluation.coverage.rollup.status === "ready" && evaluation.coverage.rollup.detail
    ? `${evaluation.detail} ${evaluation.coverage.rollup.detail}`
    : evaluation.detail;
  return {
    pageKey,
    state: evaluation.state,
    label: statusLabels[evaluation.state],
    detail: servingDetail,
    dataThrough: evaluation.dataThrough ?? (useStoredFallback ? toIso(row.data_through) : null),
    lastSuccessfulRunAt: evaluation.state === "current" || evaluation.state === "partial"
      ? evaluation.lastSuccessfulRunAt
      : useStoredFallback ? toIso(row.last_successful_run_at) : evaluation.lastSuccessfulRunAt,
    lastFailedRunAt: useStoredFallback
      ? latestIso(evaluation.lastFailedRunAt, row.last_failed_run_at)
      : evaluation.lastFailedRunAt,
  };
}

function buildStoredFreshnessStatus(row: FreshnessRow) {
  return buildFreshnessStatus({
    pageKey: row.page_key,
    dataThrough: row.data_through,
    lastSuccessfulRunAt: row.last_successful_run_at,
    lastFailedRunAt: row.last_failed_run_at,
    // Aggregate rows were already evaluated source-by-source by the health
    // publisher. Re-aging their oldest data-through timestamp here with a
    // generic page SLA can contradict that authoritative stored result.
    maxAgeHours: isAggregateFreshnessPageKey(row.page_key)
      ? Number.POSITIVE_INFINITY
      : row.max_age_hours ?? 24,
    explicitState: row.status,
    coverageDetail: coverageDetail(row.coverage_json),
  });
}

function numericCount(value: number | string) {
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

function nullableNumericCount(value: number | string | null) {
  if (value === null) return null;
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : null;
}

function latestIso(left: Date | string | null, right: Date | string | null) {
  const dates = [left, right]
    .map((value) => value ? new Date(value) : null)
    .filter((value): value is Date => value !== null && !Number.isNaN(value.getTime()));
  return dates.length > 0 ? new Date(Math.max(...dates.map((value) => value.getTime()))).toISOString() : null;
}

function toIso(value: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function coverageDetail(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const detail = (value as Record<string, unknown>).detail;
  return typeof detail === "string" && detail ? detail : null;
}

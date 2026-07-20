import type { CurrentUser } from "@/lib/auth/roles";
import {
  BACKFILL_SOURCE_DEFINITIONS,
  BACKFILL_START_MONTH,
  businessCurrentMonth,
} from "@/lib/backfill/plan";
import { queryPostgres } from "@/lib/store/postgres";

export type DataHealthSeverity = "critical" | "warning" | "info";
export type DataHealthStatus = "healthy" | "attention" | "critical";
export type DataHealthPageState =
  | "current"
  | "partial"
  | "building"
  | "stale"
  | "suspect"
  | "failed"
  | "missing";

export type DataHealthWatermark = {
  sourceFamily: string;
  windowKey: string;
  status: string;
  dataThrough: string | null;
  expectedThrough: string | null;
  lastSuccessAt: string | null;
  completeWindow: boolean;
  gapDetected: boolean;
  recordCount: number;
  updatedAt: string | null;
};

export type DataHealthQueue = {
  kind: "ingestion" | "rollup";
  queued: number;
  running: number;
  failed: number;
  deadLettered: number;
  oldestQueuedAt: string | null;
  oldestAgeSeconds: number | null;
};

export type DataHealthFailure = {
  id: string;
  kind: "ingestion" | "rollup" | "backfill";
  source: string;
  status: "failed" | "dead_lettered";
  error: string | null;
  occurredAt: string | null;
};

export type DataHealthReconciliation = {
  scope: string;
  periodStart: string | null;
  status: string;
  countDrift: number | null;
  valueDrift: number | null;
  checkedAt: string | null;
};

export type DataHealthBackfill = {
  startMonth: string;
  throughMonth: string;
  totalMonths: number;
  plannedMonths: number;
  completeMonths: number;
  completedRequiredUnits: number;
  totalRequiredUnits: number;
  missingPlanMonths: number;
  percentComplete: number;
};

export type DataHealthProfitCapacity = {
  evidenceAvailable: boolean;
  completedJobsTotal: number;
  completedJobsMissing: number;
  activeCompletedCostCentersTotal: number;
  activeCompletedCostCentersMissing: number;
  peopleTotal: number;
  peopleMissing: number;
  totalMissing: number;
  complete: boolean;
};

export type DataHealthPage = {
  pageKey: "quotes" | "jobs" | "technicians" | "commissions";
  state: DataHealthPageState;
  dataThrough: string | null;
  updatedAt: string | null;
  detail: string | null;
  continuationCount: number;
  coreCovered: number;
  coreTotal: number;
  secondaryCovered: number;
  secondaryTotal: number;
  coveragePercent: number | null;
};

export type DataHealthAlert = {
  id: string;
  severity: DataHealthSeverity;
  title: string;
  detail: string;
  occurredAt: string | null;
};

export type DataHealthModel = {
  generatedAt: string;
  summary: {
    status: DataHealthStatus;
    activeAlertCount: number;
    queueDepth: number;
    failedWorkCount: number;
    deadLetterCount: number;
  };
  alerts: DataHealthAlert[];
  watermarks: DataHealthWatermark[];
  queues: DataHealthQueue[];
  failures: {
    total: number;
    deadLettered: number;
    items: DataHealthFailure[];
  };
  reconciliations: DataHealthReconciliation[];
  profitCapacity: DataHealthProfitCapacity;
  backfill: DataHealthBackfill;
  pages: DataHealthPage[];
};

type QueryResult<T> = { rows: T[]; rowCount: number | null };
export type DataHealthQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<QueryResult<T>>;

type DataHealthAggregateRow = {
  watermarks: unknown;
  queues: unknown;
  failure_summary: unknown;
  failures: unknown;
  reconciliations: unknown;
  profit_capacity: unknown;
  backfill: unknown;
  pages: unknown;
};

const requiredBackfillSourceCount = BACKFILL_SOURCE_DEFINITIONS.filter(
  (source) => source.requiredForCompletion,
).length;

const pageKeys = ["quotes", "jobs", "technicians", "commissions"] as const;

const dataHealthAggregateQuery = `
with latest_watermarks as materialized (
  select distinct on (coalesce(source_family, entity))
         coalesce(source_family, entity) as source_family,
         window_key,
         status,
         coalesce(
           committed_date_logged,
           case when complete_window then expected_through end,
           last_success_at
         ) as data_through,
         expected_through,
         last_success_at,
         complete_window,
         gap_detected,
         record_count,
         updated_at
    from metrics.ingestion_watermarks
   order by coalesce(source_family, entity), updated_at desc
), watermark_payload as (
  select coalesce(jsonb_agg(to_jsonb(w) order by w.source_family), '[]'::jsonb) as value
    from (
      select * from latest_watermarks order by source_family limit 24
    ) w
), queue_rows as (
  select 'ingestion'::text as kind,
         count(*) filter (where status = 'queued')::integer as queued,
         count(*) filter (where status = 'running')::integer as running,
         count(*) filter (where status = 'failed')::integer as failed,
         count(*) filter (where dead_lettered_at is not null)::integer as dead_lettered,
         min(updated_at) filter (where status = 'queued') as oldest_queued_at,
         extract(epoch from (now() - min(updated_at) filter (where status = 'queued'))) as oldest_age_seconds
    from metrics.ingestion_jobs
   where status in ('queued', 'running', 'failed')
  union all
  select 'rollup'::text,
         count(*) filter (where status = 'queued')::integer,
         count(*) filter (where status = 'running')::integer,
         count(*) filter (where status = 'failed')::integer,
         0::integer,
         min(created_at) filter (where status = 'queued'),
         extract(epoch from (now() - min(created_at) filter (where status = 'queued')))
    from metrics.rollup_rebuild_queue
   where status in ('queued', 'running', 'failed')
), queue_payload as (
  select coalesce(jsonb_agg(to_jsonb(q) order by q.kind), '[]'::jsonb) as value
    from queue_rows q
), failed_work_rows as materialized (
  select id::text as id,
         'ingestion'::text as kind,
         entity_type::text as source,
         case when dead_lettered_at is not null then 'dead_lettered' else 'failed' end as status,
         last_error as error,
         coalesce(dead_lettered_at, updated_at) as occurred_at
    from metrics.ingestion_jobs
   where status = 'failed'
  union all
  select id::text,
         'rollup'::text,
         metric_family,
         'failed'::text,
         error_message,
         coalesce(finished_at, created_at)
    from metrics.rollup_rebuild_queue
   where status = 'failed'
  union all
  select id::text,
         'backfill'::text,
         source_family,
         'dead_lettered'::text,
         last_error,
         coalesce(dead_lettered_at, updated_at)
    from metrics.backfill_source_month_ledger
   where status = 'dead_lettered'
), failure_summary as (
  select jsonb_build_object(
           'total', count(*)::integer,
           'dead_lettered', count(*) filter (where status = 'dead_lettered')::integer
         ) as value
    from failed_work_rows
), failure_payload as (
  select coalesce(jsonb_agg(to_jsonb(f) order by f.occurred_at desc nulls last), '[]'::jsonb) as value
    from (
      select * from failed_work_rows order by occurred_at desc nulls last limit 10
    ) f
), latest_reconciliation_checks as materialized (
  select distinct on (scope)
         scope, period_start, status, rollup_value, snapshot_value, upstream_sample_value, checked_at
    from metrics.authoritative_reconciliation_results
   where scope = any(array['quotes', 'jobs', 'technicians', 'commissions']::text[])
     and period_start >= $1::date
   order by scope, checked_at desc, period_start desc, id desc
), profit_capacity_completeness as materialized (
  select completed_jobs_total,
         completed_jobs_missing,
         active_completed_cost_centers_total,
         active_completed_cost_centers_missing,
         people_total,
         people_missing,
         completed_jobs_missing + active_completed_cost_centers_missing + people_missing as total_missing
    from metrics.simpro_profit_capacity_completeness
), profit_capacity_payload as (
  select to_jsonb(completeness) || jsonb_build_object('evidence_available', true) as value
    from profit_capacity_completeness completeness
), latest_reconciliations as (
  select scope,
         period_start,
         status,
         null::numeric as count_drift,
         case
           when rollup_value is null or coalesce(upstream_sample_value, snapshot_value) is null then null
           else coalesce(upstream_sample_value, snapshot_value) - rollup_value
         end as value_drift,
         checked_at
    from latest_reconciliation_checks
), reconciliation_payload as (
  select coalesce(jsonb_agg(to_jsonb(r) order by r.scope), '[]'::jsonb) as value
    from (
      select latest.scope,
             latest.period_start,
             case
               when latest.scope in ('jobs', 'technicians')
                and completeness.total_missing > 0
                 then 'incomplete'
               else latest.status
             end as status,
             latest.count_drift,
             latest.value_drift,
             latest.checked_at
        from latest_reconciliations latest
        cross join profit_capacity_completeness completeness
    ) r
), expected_pages(page_key, display_order) as (
  values ('quotes', 1), ('jobs', 2), ('technicians', 3), ('commissions', 4)
), page_rows as (
  select p.page_key,
         case
           when p.page_key in ('jobs', 'technicians')
            and completeness.total_missing > 0
            and f.status = 'current'
             then 'building'
           else coalesce(f.status, 'missing')
         end as state,
         f.data_through,
         f.updated_at,
         case
           when p.page_key in ('jobs', 'technicians')
            and completeness.total_missing > 0
             then 'Migration 026 profit and capacity normalization is incomplete.'
           else coalesce(f.coverage_json ->> 'detail', f.last_error)
         end as detail,
         coalesce(f.continuation_count, 0)::integer as continuation_count,
         coalesce(source_counts.core_covered, 0)::integer as core_covered,
         coalesce(source_counts.core_total, 0)::integer as core_total,
         coalesce(source_counts.secondary_covered, 0)::integer as secondary_covered,
         coalesce(source_counts.secondary_total, 0)::integer as secondary_total,
         p.display_order
    from expected_pages p
    cross join profit_capacity_completeness completeness
    left join metrics.metrics_freshness f on f.page_key = p.page_key
    left join lateral (
      select count(*) filter (
               where source.value ->> 'role' = 'core'
                 and source.value ->> 'state' = 'successful'
             ) as core_covered,
             count(*) filter (where source.value ->> 'role' = 'core') as core_total,
             count(*) filter (
               where source.value ->> 'role' = 'secondary'
                 and source.value ->> 'state' = 'successful'
             ) as secondary_covered,
             count(*) filter (where source.value ->> 'role' = 'secondary') as secondary_total
        from jsonb_each(
          case
            when jsonb_typeof(f.coverage_json #> '{aggregate,sources}') = 'object'
              then f.coverage_json #> '{aggregate,sources}'
            else '{}'::jsonb
          end
        ) source
    ) source_counts on true
), page_payload as (
  select coalesce(jsonb_agg(to_jsonb(p) - 'display_order' order by p.display_order), '[]'::jsonb) as value
    from page_rows p
), expected_months as (
  select month_start::date
    from generate_series($1::date, $3::date, interval '1 month') month_start
), backfill_months as (
  select m.month_start,
         count(l.id) filter (
           where l.required_for_completion
         )::integer as required_count,
         count(l.id) filter (
           where l.required_for_completion
             and l.status = 'completed'
             and l.reconciliation_status = 'matched'
         )::integer as completed_count
    from expected_months m
    left join metrics.backfill_source_month_ledger l on l.month_start = m.month_start
   group by m.month_start
), backfill_payload as (
  select jsonb_build_object(
           'start_month', min(month_start),
           'through_month', max(month_start),
           'total_months', count(*)::integer,
           'planned_months', count(*) filter (where required_count = $2)::integer,
           'complete_months', count(*) filter (where completed_count = $2)::integer,
           'completed_required_units', coalesce(sum(least(completed_count, $2)), 0)::integer,
           'total_required_units', (count(*) * $2)::integer,
           'missing_plan_months', count(*) filter (where required_count <> $2)::integer
         ) as value
    from backfill_months
)
select watermark_payload.value as watermarks,
       queue_payload.value as queues,
       failure_summary.value as failure_summary,
       failure_payload.value as failures,
       reconciliation_payload.value as reconciliations,
       profit_capacity_payload.value as profit_capacity,
       backfill_payload.value as backfill,
       page_payload.value as pages
  from watermark_payload
 cross join queue_payload
 cross join failure_summary
 cross join failure_payload
 cross join reconciliation_payload
 cross join profit_capacity_payload
 cross join backfill_payload
 cross join page_payload`;

export async function getOwnerDataHealth(
  user: Pick<CurrentUser, "roles">,
  options: { query?: DataHealthQuery; now?: Date } = {},
): Promise<DataHealthModel | null> {
  if (!user.roles.includes("admin")) return null;

  return getOperationalDataHealth(options);
}

export async function getOperationalDataHealth(
  options: { query?: DataHealthQuery; now?: Date } = {},
): Promise<DataHealthModel> {
  const now = options.now ?? new Date();
  const query = options.query ?? queryPostgres;
  const result = await query<DataHealthAggregateRow>(dataHealthAggregateQuery, [
    BACKFILL_START_MONTH,
    requiredBackfillSourceCount,
    businessCurrentMonth(now),
  ]);

  return buildDataHealthModel(result.rows[0], now);
}

function buildDataHealthModel(row: DataHealthAggregateRow | undefined, now: Date): DataHealthModel {
  const watermarks = records(row?.watermarks).map(mapWatermark);
  const queues = records(row?.queues).map(mapQueue).filter(isQueue);
  const failureSummary = record(row?.failure_summary);
  const failures = records(row?.failures).map(mapFailure).filter(isFailure);
  const reconciliations = records(row?.reconciliations).map(mapReconciliation);
  const profitCapacity = mapProfitCapacity(record(row?.profit_capacity));
  const backfill = mapBackfill(record(row?.backfill), now);
  const pages = normalizePages(records(row?.pages).map(mapPage));
  const failureTotal = integer(failureSummary.total, failures.length);
  const deadLettered = integer(
    failureSummary.dead_lettered,
    failures.filter((failure) => failure.status === "dead_lettered").length,
  );
  const alerts = deriveAlerts({
    watermarks,
    queues,
    failures: { total: failureTotal, deadLettered, items: failures },
    reconciliations,
    profitCapacity,
    backfill,
    pages,
    generatedAt: now.toISOString(),
  });
  const status: DataHealthStatus = alerts.some((alert) => alert.severity === "critical")
    ? "critical"
    : alerts.some((alert) => alert.severity === "warning")
      ? "attention"
      : "healthy";

  return {
    generatedAt: now.toISOString(),
    summary: {
      status,
      activeAlertCount: alerts.length,
      queueDepth: queues.reduce((total, queue) => total + queue.queued, 0),
      failedWorkCount: failureTotal,
      deadLetterCount: deadLettered,
    },
    alerts,
    watermarks,
    queues,
    failures: { total: failureTotal, deadLettered, items: failures },
    reconciliations,
    profitCapacity,
    backfill,
    pages,
  };
}

function deriveAlerts(input: Omit<DataHealthModel, "summary" | "alerts">): DataHealthAlert[] {
  const alerts: DataHealthAlert[] = [];
  const latestFailure = input.failures.items[0]?.occurredAt ?? null;

  if (input.failures.total > 0) {
    alerts.push({
      id: "failed-work",
      severity: input.failures.deadLettered > 0 ? "critical" : "warning",
      title: "Pipeline work requires attention",
      detail: `${input.failures.total} unresolved item${input.failures.total === 1 ? "" : "s"}; ${input.failures.deadLettered} dead-lettered.`,
      occurredAt: latestFailure,
    });
  }

  for (const watermark of input.watermarks) {
    if (!watermark.gapDetected && watermark.status !== "failed" && watermark.status !== "gap") continue;
    alerts.push({
      id: `watermark-${watermark.sourceFamily}`,
      severity: "critical",
      title: `${label(watermark.sourceFamily)} watermark is incomplete`,
      detail: watermark.gapDetected ? "A source cursor gap is recorded." : `Latest status: ${watermark.status}.`,
      occurredAt: watermark.updatedAt,
    });
  }

  for (const queue of input.queues) {
    const thresholdSeconds = queue.kind === "ingestion" ? 60 * 60 : 2 * 60 * 60;
    if (queue.queued === 0 || queue.oldestAgeSeconds === null || queue.oldestAgeSeconds < thresholdSeconds) continue;
    alerts.push({
      id: `queue-${queue.kind}`,
      severity: "warning",
      title: `${label(queue.kind)} queue age exceeds target`,
      detail: `${queue.queued} queued; oldest age ${compactDuration(queue.oldestAgeSeconds)}.`,
      occurredAt: queue.oldestQueuedAt,
    });
  }

  for (const reconciliation of input.reconciliations) {
    if (reconciliation.status === "matched") continue;
    alerts.push({
      id: `reconciliation-${reconciliation.scope}`,
      severity: reconciliation.status === "mismatch" || reconciliation.status === "failed" ? "critical" : "warning",
      title: `${label(reconciliation.scope)} reconciliation ${label(reconciliation.status)}`,
      detail: reconciliationDriftDetail(reconciliation),
      occurredAt: reconciliation.checkedAt,
    });
  }

  if (!input.profitCapacity.evidenceAvailable) {
    alerts.push({
      id: "profit-capacity-evidence-missing",
      severity: "critical",
      title: "Migration 026 completeness is unavailable",
      detail: "Owner diagnostics cannot verify profit and capacity normalization coverage.",
      occurredAt: input.generatedAt,
    });
  } else if (!input.profitCapacity.complete) {
    alerts.push({
      id: "profit-capacity-incomplete",
      severity: "warning",
      title: "Migration 026 normalization is incomplete",
      detail: `${input.profitCapacity.completedJobsMissing} completed jobs, ${input.profitCapacity.activeCompletedCostCentersMissing} active completed cost centers, and ${input.profitCapacity.peopleMissing} people remain.`,
      occurredAt: input.generatedAt,
    });
  }

  for (const page of input.pages) {
    if (!(["failed", "suspect", "stale", "missing"] as DataHealthPageState[]).includes(page.state)) continue;
    alerts.push({
      id: `freshness-${page.pageKey}`,
      severity: page.state === "failed" || page.state === "suspect" ? "critical" : "warning",
      title: `${label(page.pageKey)} freshness is ${page.state}`,
      detail: page.detail ?? "Required page freshness evidence is unavailable.",
      occurredAt: page.updatedAt,
    });
  }

  if (input.backfill.missingPlanMonths > 0) {
    alerts.push({
      id: "backfill-plan-coverage",
      severity: "warning",
      title: "Backfill plan coverage is incomplete",
      detail: `${input.backfill.missingPlanMonths} month${input.backfill.missingPlanMonths === 1 ? "" : "s"} lack all required source units.`,
      occurredAt: input.generatedAt,
    });
  } else if (input.backfill.completedRequiredUnits < input.backfill.totalRequiredUnits) {
    alerts.push({
      id: "backfill-incomplete",
      severity: "warning",
      title: "Historical backfill is incomplete",
      detail: `${input.backfill.completedRequiredUnits}/${input.backfill.totalRequiredUnits} required source-month units are reconciled (${input.backfill.percentComplete.toFixed(1)}%).`,
      occurredAt: input.generatedAt,
    });
  }

  return alerts
    .sort((left, right) => {
      const timeDifference = timestampValue(right.occurredAt) - timestampValue(left.occurredAt);
      if (timeDifference !== 0) return timeDifference;
      return severityRank(right.severity) - severityRank(left.severity);
    })
    .slice(0, 10);
}

function mapWatermark(value: Record<string, unknown>): DataHealthWatermark {
  return {
    sourceFamily: string(value.source_family, "unknown"),
    windowKey: string(value.window_key, "default"),
    status: string(value.status, "missing"),
    dataThrough: timestamp(value.data_through),
    expectedThrough: timestamp(value.expected_through),
    lastSuccessAt: timestamp(value.last_success_at),
    completeWindow: boolean(value.complete_window),
    gapDetected: boolean(value.gap_detected),
    recordCount: integer(value.record_count),
    updatedAt: timestamp(value.updated_at),
  };
}

function mapQueue(value: Record<string, unknown>): DataHealthQueue {
  return {
    kind: string(value.kind) as DataHealthQueue["kind"],
    queued: integer(value.queued),
    running: integer(value.running),
    failed: integer(value.failed),
    deadLettered: integer(value.dead_lettered),
    oldestQueuedAt: timestamp(value.oldest_queued_at),
    oldestAgeSeconds: nullableNumber(value.oldest_age_seconds),
  };
}

function mapFailure(value: Record<string, unknown>): DataHealthFailure {
  return {
    id: string(value.id, "unknown"),
    kind: string(value.kind) as DataHealthFailure["kind"],
    source: string(value.source, "unknown"),
    status: string(value.status) as DataHealthFailure["status"],
    error: nullableString(value.error),
    occurredAt: timestamp(value.occurred_at),
  };
}

function mapReconciliation(value: Record<string, unknown>): DataHealthReconciliation {
  return {
    scope: string(value.scope, "unknown"),
    periodStart: nullableString(value.period_start),
    status: string(value.status, "missing"),
    countDrift: nullableNumber(value.count_drift),
    valueDrift: nullableNumber(value.value_drift),
    checkedAt: timestamp(value.checked_at),
  };
}

function mapBackfill(value: Record<string, unknown>, now: Date): DataHealthBackfill {
  const startMonth = nullableString(value.start_month) ?? BACKFILL_START_MONTH;
  const throughMonth = nullableString(value.through_month) ?? businessCurrentMonth(now);
  const expectedMonthCount = inclusiveMonthCount(startMonth, throughMonth);
  const totalMonths = integer(value.total_months, expectedMonthCount);
  const totalRequiredUnits = integer(value.total_required_units, totalMonths * requiredBackfillSourceCount);
  const completedRequiredUnits = integer(value.completed_required_units);
  return {
    startMonth,
    throughMonth,
    totalMonths,
    plannedMonths: integer(value.planned_months),
    completeMonths: integer(value.complete_months),
    completedRequiredUnits,
    totalRequiredUnits,
    missingPlanMonths: integer(value.missing_plan_months, totalMonths),
    percentComplete: totalRequiredUnits > 0
      ? Math.min(100, Math.max(0, (completedRequiredUnits / totalRequiredUnits) * 100))
      : 0,
  };
}

function mapProfitCapacity(value: Record<string, unknown>): DataHealthProfitCapacity {
  const evidenceAvailable = boolean(value.evidence_available);
  const completedJobsMissing = integer(value.completed_jobs_missing);
  const activeCompletedCostCentersMissing = integer(value.active_completed_cost_centers_missing);
  const peopleMissing = integer(value.people_missing);
  const totalMissing = completedJobsMissing + activeCompletedCostCentersMissing + peopleMissing;
  return {
    evidenceAvailable,
    completedJobsTotal: integer(value.completed_jobs_total),
    completedJobsMissing,
    activeCompletedCostCentersTotal: integer(value.active_completed_cost_centers_total),
    activeCompletedCostCentersMissing,
    peopleTotal: integer(value.people_total),
    peopleMissing,
    totalMissing,
    complete: evidenceAvailable && totalMissing === 0,
  };
}

function mapPage(value: Record<string, unknown>): DataHealthPage {
  const coreCovered = integer(value.core_covered);
  const coreTotal = integer(value.core_total);
  const secondaryCovered = integer(value.secondary_covered);
  const secondaryTotal = integer(value.secondary_total);
  const covered = coreCovered + secondaryCovered;
  const total = coreTotal + secondaryTotal;
  return {
    pageKey: string(value.page_key) as DataHealthPage["pageKey"],
    state: normalizePageState(string(value.state)),
    dataThrough: timestamp(value.data_through),
    updatedAt: timestamp(value.updated_at),
    detail: nullableString(value.detail),
    continuationCount: integer(value.continuation_count),
    coreCovered,
    coreTotal,
    secondaryCovered,
    secondaryTotal,
    coveragePercent: total > 0 ? (covered / total) * 100 : null,
  };
}

function normalizePages(values: DataHealthPage[]): DataHealthPage[] {
  const byKey = new Map(values.filter((page) => pageKeys.includes(page.pageKey)).map((page) => [page.pageKey, page]));
  return pageKeys.map((pageKey) => byKey.get(pageKey) ?? {
    pageKey,
    state: "missing",
    dataThrough: null,
    updatedAt: null,
    detail: null,
    continuationCount: 0,
    coreCovered: 0,
    coreTotal: 0,
    secondaryCovered: 0,
    secondaryTotal: 0,
    coveragePercent: null,
  });
}

function reconciliationDriftDetail(value: DataHealthReconciliation) {
  const parts: string[] = [];
  if (value.countDrift !== null) parts.push(`Count drift ${signed(value.countDrift)}`);
  if (value.valueDrift !== null) parts.push(`Value drift ${signed(value.valueDrift, true)}`);
  return parts.length > 0 ? parts.join("; ") : `Latest status: ${value.status}.`;
}

function signed(value: number, currency = false) {
  const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
  return currency ? `${prefix}$${Math.abs(value).toFixed(2)}` : `${prefix}${Math.abs(value)}`;
}

function inclusiveMonthCount(startMonth: string, throughMonth: string) {
  const start = new Date(`${startMonth.slice(0, 7)}-01T00:00:00.000Z`);
  const through = new Date(`${throughMonth.slice(0, 7)}-01T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(through.getTime()) || start > through) return 0;
  return (through.getUTCFullYear() - start.getUTCFullYear()) * 12
    + through.getUTCMonth() - start.getUTCMonth() + 1;
}

function compactDuration(seconds: number) {
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

function normalizePageState(value: string): DataHealthPageState {
  return value === "current" || value === "partial" || value === "building" || value === "stale"
    || value === "suspect" || value === "failed" ? value : "missing";
}

function isQueue(value: DataHealthQueue): value is DataHealthQueue {
  return value.kind === "ingestion" || value.kind === "rollup";
}

function isFailure(value: DataHealthFailure): value is DataHealthFailure {
  return (value.kind === "ingestion" || value.kind === "rollup" || value.kind === "backfill")
    && (value.status === "failed" || value.status === "dead_lettered");
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown, fallback = "") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integer(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolean(value: unknown) {
  return value === true || value === "true";
}

function timestamp(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function timestampValue(value: string | null) {
  return value ? new Date(value).getTime() : 0;
}

function severityRank(value: DataHealthSeverity) {
  return value === "critical" ? 3 : value === "warning" ? 2 : 1;
}

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

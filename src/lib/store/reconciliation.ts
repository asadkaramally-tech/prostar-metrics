import { createHash, randomUUID } from "node:crypto";
import { isCompletedJobStage } from "@/lib/metrics/jobs";
import { SimproClient, type RequestBudget } from "@/lib/simpro/client";
import { SimproEndpoints } from "@/lib/simpro/endpoints";
import { pickId, pickName } from "@/lib/simpro/schemas";
import {
  createPostgresReconciliationContinuationStore,
  type DirectReconciliationScope,
  type ReconciliationContinuationClaim,
  type ReconciliationContinuationState,
  type ReconciliationContinuationStore,
} from "@/lib/store/reconciliation-continuation-store";
import {
  queryPostgres,
  withPostgresTransaction,
  type PostgresQuery,
} from "@/lib/store/postgres";
import { enqueueBoundedSourceWork } from "@/lib/store/bounded-source-work";
import { enqueueRollupRebuild } from "@/lib/store/read-model-rebuilds";
import {
  buildSourcePeriodManifestEvidence,
  upsertSourcePeriodManifest,
  type SourcePeriodManifest,
} from "@/lib/store/source-period-manifests";
import {
  compareTechnicianReconciliationInputs,
  getTechnicianManifestAuthority,
  getTechnicianReconciliationSourceInputs,
  isTechnicianManifestAuthorityPublishable,
  persistTechnicianReconciliationResults,
} from "@/lib/store/technician-reconciliation";
import type { RollupScope } from "@/lib/store/rollups";

export type ReconciliationScope = RollupScope | "all";
export type ReconciliationStatus = "matched" | "mismatch" | "sample_missing";

export type ReconciliationResult = {
  scope: RollupScope;
  periodStart: string;
  periodEnd: string;
  status: ReconciliationStatus;
  checkId: number | null;
  rollupValue: number | null;
  snapshotValue: number | null;
  upstreamSampleValue: number | null;
  generation?: number | null;
  completeTraversal?: boolean;
  detail: Record<string, unknown>;
};

export type ReconciliationTransaction = <T>(
  callback: (query: PostgresQuery) => Promise<T>,
) => Promise<T>;

export type ReconciliationRuntimeDependencies = {
  query?: PostgresQuery;
  transaction?: ReconciliationTransaction;
  continuationStore?: ReconciliationContinuationStore;
  enqueueBoundedWork?: typeof enqueueBoundedSourceWork;
  enqueueRollup?: typeof enqueueRollupRebuild;
};

export type ReconciliationOptions = {
  scope?: ReconciliationScope;
  periodStart?: string;
  requestBudget?: number;
  endpoints?: SimproEndpoints;
  leaseOwner?: string;
  onlyIfNeeded?: boolean;
  restartDirectTraversal?: boolean;
  dependencies?: ReconciliationRuntimeDependencies;
};

type Period = {
  start: string;
  end: string;
};

type SourceEntity = {
  id: string;
  totalValue: number;
  stageName?: string | null;
};

type SourceSummary = {
  complete: boolean;
  incompleteReason?: string;
  count: number;
  totalValue: number;
  ids: string[];
  detailsFetched: number;
  pageCount: number;
  generation: number;
  totalRequestsUsed: number;
  excludedByStage?: Array<{ id: string; stageName: string | null }>;
};

type StoreSummary = {
  count: number;
  totalValue: number;
  ids: string[];
};

type NestedSourceAuthority = {
  complete: boolean;
  expectedProjectCount: number;
  completedProjectCount: number;
  childFingerprints: string[];
  validChildFingerprints: string[];
  invalidProjectIds: string[];
  projectGenerations: Record<string, number>;
  projectRootHashes: Record<string, string>;
};

type DashboardPayloadRow = {
  values_json: Record<string, unknown>;
  source_hash: string | null;
  rebuilt_at: string;
};

const directScopes: RollupScope[] = ["quotes", "jobs"];
const derivedScopes: RollupScope[] = ["technicians", "commissions"];
const allScopes: RollupScope[] = [...directScopes, ...derivedScopes];
const valueTolerance = 0.01;

class ReconciliationGenerationConflictError extends Error {
  constructor(scope: DirectReconciliationScope, periodStart: string, generation: number) {
    super(`Reconciliation generation ${scope}:${periodStart}:${generation} lost its fence.`);
    this.name = "ReconciliationGenerationConflictError";
  }
}

export async function runSimproReconciliation(options: ReconciliationOptions = {}): Promise<ReconciliationResult[]> {
  const period = monthWindow(options.periodStart ?? currentMonthStart());
  const budget: RequestBudget = { limit: Math.max(1, Math.trunc(options.requestBudget ?? 1000)), used: 0 };
  const endpoints = options.endpoints ?? new SimproEndpoints(new SimproClient());
  const dependencies = runtimeDependencies(options.dependencies);
  const leaseOwner = options.leaseOwner ?? `reconciliation-${process.pid}-${randomUUID()}`;
  const scopes = options.scope && options.scope !== "all" ? [options.scope] : allScopes;
  const results: ReconciliationResult[] = [];

  for (const scope of scopes) {
    try {
      if (options.onlyIfNeeded && !await isReconciliationNeeded(scope, period, dependencies)) {
        const existing = await getLatestAuthoritativeResult(scope, period.start, dependencies.query);
        if (existing) {
          results.push(existing);
          continue;
        }
      }
      if (
        (scope === "technicians" || scope === "commissions")
        && options.scope === "all"
        && !results.some((result) => result.scope === "jobs" && result.status === "matched" && result.completeTraversal !== false)
      ) {
        results.push(incompleteResult(scope, period, budget.used, "Current-run jobs reconciliation is incomplete."));
        continue;
      }
      results.push(await reconcileScope(
        scope,
        period,
        endpoints,
        budget,
        leaseOwner,
        dependencies,
        options.restartDirectTraversal === true,
      ));
    } catch (error) {
      results.push(incompleteResult(
        scope,
        period,
        budget.used,
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  return results;
}

async function reconcileScope(
  scope: RollupScope,
  period: Period,
  endpoints: SimproEndpoints,
  budget: RequestBudget,
  leaseOwner: string,
  dependencies: ResolvedReconciliationDependencies,
  restartDirectTraversal: boolean,
): Promise<ReconciliationResult> {
  switch (scope) {
    case "quotes":
      return reconcileQuotes(period, endpoints, budget, leaseOwner, dependencies, restartDirectTraversal);
    case "jobs":
      return reconcileJobs(period, endpoints, budget, leaseOwner, dependencies, restartDirectTraversal);
    case "technicians":
      return reconcileTechnicians(period, dependencies);
    case "commissions":
      return reconcileCommissions(period, dependencies);
    case "materials":
      // The materials mirror is authored by full live month walks
      // (workers/ingest-materials.ts); there is no sampled reconciliation and
      // the scope is never scheduled here (allScopes excludes it).
      throw new Error("Materials has no sampled reconciliation; rerun the materials month walk instead.");
    default:
      assertNever(scope);
  }
}

type ResolvedReconciliationDependencies = {
  query: PostgresQuery;
  transaction: ReconciliationTransaction;
  continuationStore: ReconciliationContinuationStore;
  enqueueBoundedWork: typeof enqueueBoundedSourceWork;
  enqueueRollup: typeof enqueueRollupRebuild;
};

function runtimeDependencies(
  provided: ReconciliationRuntimeDependencies | undefined,
): ResolvedReconciliationDependencies {
  const query = provided?.query ?? queryPostgres;
  const transaction = provided?.transaction
    ?? (provided?.query
      ? async <T>(callback: (transactionQuery: PostgresQuery) => Promise<T>) => callback(query)
      : withPostgresTransaction);
  return {
    query,
    transaction,
    continuationStore: provided?.continuationStore
      ?? createPostgresReconciliationContinuationStore({ query, transaction }),
    enqueueBoundedWork: provided?.enqueueBoundedWork ?? enqueueBoundedSourceWork,
    enqueueRollup: provided?.enqueueRollup ?? enqueueRollupRebuild,
  };
}

export async function isReconciliationNeeded(
  scope: RollupScope,
  period: Period,
  dependencies: Pick<ResolvedReconciliationDependencies, "query"> & {
    continuationStore: Pick<ReconciliationContinuationStore, "hasIncomplete">;
  },
) {
  const direct = scope === "quotes" || scope === "jobs";
  if (direct && await dependencies.continuationStore.hasIncomplete(scope, period.start)) return true;
  if (
    scope === "technicians"
    && !await hasCompleteTechnicianResultEvidence(period.start, dependencies.query)
  ) return true;
  const sourceFamilies = direct
    ? [scope, scope === "quotes" ? "quote_nested" : "job_nested"]
    : [];
  const result = await dependencies.query<{ needed: boolean }>(
    `with latest as (
       select *
         from metrics.authoritative_reconciliation_results
        where scope = $1 and period_start = $2::date
        limit 1
     ), latest_model as (
       select max(rebuilt_at) as rebuilt_at
         from metrics.dashboard_read_models
        where metric_family = $1 and period_start = $2::date
          and period_grain = 'month' and superseded_at is null
     ), manifest_proof as (
       select count(*)::integer as matched_count
         from metrics.source_period_manifests manifest
         join latest on true
        where manifest.source_family = any($4::text[])
          and manifest.period_start = $2::date
          and manifest.coverage_status = 'complete'
          and manifest.reconciliation_status = 'matched'
          and manifest.continuation_token is null
          and manifest.manifest_generation = latest.generation
          and manifest.reconciliation_generation = manifest.manifest_generation
          and manifest.expected_page_count > 0
          and manifest.completed_page_count = manifest.expected_page_count
          and manifest.reconciled_at is not null
          and latest.source_manifest_generations ->> manifest.source_family = manifest.manifest_generation::text
     )
     select (
       latest.id is null
       or latest.status <> 'matched'
       or latest.checked_at < clock_timestamp() - case
            when $2::date = date_trunc('month', clock_timestamp() at time zone 'America/Los_Angeles')::date
              then interval '1 hour'
            else interval '24 hours'
          end
       or latest_model.rebuilt_at > latest.checked_at
       or ($3::boolean and (latest.generation is null or manifest_proof.matched_count <> 2))
     ) as needed
       from (select 1) seed
       left join latest on true
       left join latest_model on true
       left join manifest_proof on true`,
    [scope, period.start, direct, sourceFamilies],
  );
  return result.rows[0]?.needed !== false;
}

async function hasCompleteTechnicianResultEvidence(
  periodStart: string,
  query: PostgresQuery,
) {
  const result = await query<{ complete: boolean }>(
    `with latest as (
       select id, detail
         from metrics.authoritative_reconciliation_results
        where scope = 'technicians' and period_start = $1::date
        limit 1
     ), result_proof as (
       select count(*) filter (where result.status = 'matched')::integer as matched_count,
              count(*) filter (where result.status = 'mismatch')::integer as mismatch_count
         from latest
         left join metrics.technician_reconciliation_results result
           on result.reconciliation_check_id = latest.id
     )
     select (
       result_proof.matched_count::text
         is not distinct from latest.detail #>> '{comparisons,technicians,matched}'
       and result_proof.mismatch_count::text
         is not distinct from latest.detail #>> '{comparisons,technicians,mismatch}'
     ) as complete
       from (select 1) seed
       left join latest on true
       left join result_proof on true`,
    [periodStart],
  );
  return result.rows[0]?.complete === true;
}

async function getLatestAuthoritativeResult(
  scope: RollupScope,
  periodStart: string,
  query: PostgresQuery,
): Promise<ReconciliationResult | null> {
  const result = await query<{
    id: number | string;
    period_end: Date | string;
    status: ReconciliationStatus;
    rollup_value: number | string | null;
    snapshot_value: number | string | null;
    upstream_sample_value: number | string | null;
    generation: number | string | null;
    detail: unknown;
  }>(
    `select id, period_end::text, status, rollup_value, snapshot_value,
            upstream_sample_value, generation, detail
       from metrics.authoritative_reconciliation_results
      where scope = $1 and period_start = $2::date
      limit 1`,
    [scope, periodStart],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    scope,
    periodStart,
    periodEnd: String(row.period_end).slice(0, 10),
    status: row.status,
    checkId: Number(row.id),
    rollupValue: nullableNumber(row.rollup_value),
    snapshotValue: nullableNumber(row.snapshot_value),
    upstreamSampleValue: nullableNumber(row.upstream_sample_value),
    generation: row.generation === null ? null : Number(row.generation),
    completeTraversal: true,
    detail: { ...asRecord(row.detail), requestsUsed: 0, skipped: true },
  };
}

function incompleteResult(
  scope: RollupScope,
  period: Period,
  requestsUsed: number,
  reason: string,
  detail: Record<string, unknown> = {},
): ReconciliationResult {
  return {
    scope,
    periodStart: period.start,
    periodEnd: period.end,
    status: "sample_missing",
    checkId: null,
    rollupValue: null,
    snapshotValue: null,
    upstreamSampleValue: null,
    generation: typeof detail.generation === "number" ? detail.generation : null,
    completeTraversal: false,
    detail: {
      source: "reconciliation_continuation",
      reason,
      ...detail,
      requestsUsed,
      finalPublished: false,
    },
  };
}

async function reconcileQuotes(
  period: Period,
  endpoints: SimproEndpoints,
  budget: RequestBudget,
  leaseOwner: string,
  dependencies: ResolvedReconciliationDependencies,
  restartDirectTraversal = false,
) {
  const traversal = await collectDirectSourceMonth({
    scope: "quotes",
    period,
    endpoints,
    budget,
    leaseOwner,
    store: dependencies.continuationStore,
    restart: restartDirectTraversal,
  });
  if (!traversal.complete || !traversal.source || !traversal.claim) {
    return incompleteResult("quotes", period, budget.used, traversal.reason ?? "Quote traversal is incomplete.", {
      generation: traversal.claim?.generation ?? null,
      totalRequestsUsed: traversal.totalRequestsUsed,
    });
  }
  const source = traversal.source;
  const claim = traversal.claim;
  // Comparison reads and publication share one transaction so the app-owned
  // summaries, the manifests, and the authoritative check all describe the
  // exact database state that is published (mirrors reconcileTechnicians).
  const publication = await dependencies.transaction(async (query) => {
    const [metricsQuotes, quoteSnapshots, quoteActivity, dashboard] = await Promise.all([
      getMetricsQuoteSummary(period, query),
      getQuoteSnapshotSummary(period, query),
      getMetricsQuoteActivitySummary(period, query),
      getDashboardPayload("quotes", period.start, query),
    ]);
    const dashboardSummary = dashboardQuoteSummary(dashboard);
    const metricsComparison = compareSummaries(source, metricsQuotes);
    const snapshotComparison = compareSummaries(source, quoteSnapshots);
    // The source-coverage cohort is DateApproved ∪ DateIssued. DateApproved is
    // the quote-created date in Simpro; the sent-quotes dashboard is keyed by
    // DateIssued, so compare it to that matching app-owned subset.
    const dashboardComparison = compareDashboard(quoteActivity, dashboardSummary);
    const status: "matched" | "mismatch" =
      metricsComparison.matched && snapshotComparison.matched && dashboardComparison.matched
        ? "matched"
        : "mismatch";

    return persistDirectReconciliation({
      scope: "quotes",
      period,
      status,
      rollupValue: dashboardSummary.totalValue,
      snapshotValue: metricsQuotes.totalValue,
      upstreamSampleValue: source.totalValue,
      detail: {
        sourceBasis: "Simpro quotes in the deduplicated DateApproved/DateIssued daily union; detail Total ExTax preferred. Dashboard sent activity is DateIssued-only.",
        source,
        appOwned: {
          metricsQuotes,
          quoteSnapshots,
          quoteActivity,
        },
        dashboard: dashboardSummary,
        comparisons: {
          metricsQuotes: metricsComparison,
          quoteSnapshots: snapshotComparison,
          dashboard: dashboardComparison,
        },
        requestsUsed: budget.used,
        totalRequestsUsed: source.totalRequestsUsed,
        continuationGeneration: source.generation,
      },
      claim,
      source,
      normalizedIds: metricsQuotes.ids,
      exactMissingIds: exactMissingIds(metricsComparison, snapshotComparison),
    }, dependencies, query);
  });
  if (publication.result.status === "mismatch") {
    await scheduleRepair(publication.result, dependencies, publication.repairIds);
  }
  return publication.result;
}

async function reconcileJobs(
  period: Period,
  endpoints: SimproEndpoints,
  budget: RequestBudget,
  leaseOwner: string,
  dependencies: ResolvedReconciliationDependencies,
  restartDirectTraversal = false,
) {
  const traversal = await collectDirectSourceMonth({
    scope: "jobs",
    period,
    endpoints,
    budget,
    leaseOwner,
    store: dependencies.continuationStore,
    restart: restartDirectTraversal,
  });
  if (!traversal.complete || !traversal.source || !traversal.claim) {
    return incompleteResult("jobs", period, budget.used, traversal.reason ?? "Job traversal is incomplete.", {
      generation: traversal.claim?.generation ?? null,
      totalRequestsUsed: traversal.totalRequestsUsed,
    });
  }
  const source = traversal.source;
  const claim = traversal.claim;
  // Comparison reads and publication share one transaction so the app-owned
  // summaries, the manifests, and the authoritative check all describe the
  // exact database state that is published (mirrors reconcileTechnicians).
  const publication = await dependencies.transaction(async (query) => {
    const [metricsJobs, jobSnapshots, dashboard] = await Promise.all([
      getMetricsJobSummary(period, query),
      getJobSnapshotSummary(period, query),
      getDashboardPayload("jobs", period.start, query),
    ]);
    const dashboardSummary = dashboardJobSummary(dashboard);
    const metricsComparison = compareSummaries(source, metricsJobs);
    const snapshotComparison = compareSummaries(source, jobSnapshots);
    const dashboardComparison = compareDashboard(source, dashboardSummary);
    const status: "matched" | "mismatch" =
      metricsComparison.matched && snapshotComparison.matched && dashboardComparison.matched
        ? "matched"
        : "mismatch";

    return persistDirectReconciliation({
      scope: "jobs",
      period,
      status,
      rollupValue: dashboardSummary.totalValue,
      snapshotValue: metricsJobs.totalValue,
      upstreamSampleValue: source.totalValue,
      detail: {
        sourceBasis: "Simpro jobs by CompletedDate; completion is Stage only, valid values Complete and Archived.",
        source,
        appOwned: {
          metricsJobs,
          jobSnapshots,
        },
        dashboard: dashboardSummary,
        comparisons: {
          metricsJobs: metricsComparison,
          jobSnapshots: snapshotComparison,
          dashboard: dashboardComparison,
        },
        requestsUsed: budget.used,
        totalRequestsUsed: source.totalRequestsUsed,
        continuationGeneration: source.generation,
      },
      claim,
      source,
      normalizedIds: metricsJobs.ids,
      exactMissingIds: exactMissingIds(metricsComparison, snapshotComparison),
    }, dependencies, query);
  });
  if (publication.result.status === "mismatch") {
    await scheduleRepair(publication.result, dependencies, publication.repairIds);
  }
  return publication.result;
}

async function reconcileTechnicians(period: Period, dependencies: ResolvedReconciliationDependencies) {
  const result = await dependencies.transaction(async (query) => {
    const [store, sourceInputs, dashboard, inheritedJobs, manifestAuthority] = await Promise.all([
      getTechnicianStoreSummary(period, query),
      getTechnicianReconciliationSourceInputs(period.start, period.end, query),
      getDashboardPayload("technicians", period.start, query),
      getLatestReconciliationStatus("jobs", period.start, query),
      getTechnicianManifestAuthority(period.start, period.end, query),
    ]);
    if (
      !dashboard?.source_hash
      || !inheritedJobs?.generation
      || !isTechnicianManifestAuthorityPublishable(manifestAuthority)
    ) {
      return incompleteResult("technicians", period, 0, "Complete reconciled jobs and technician source manifests are required.");
    }

    const dashboardSummary = dashboardTechnicianSummary(dashboard);
    const comparison = compareDashboard(
      { count: store.totalJobs, totalValue: store.allocatedSellValue },
      { count: dashboardSummary.totalJobs, totalValue: dashboardSummary.allocatedSellValue },
    );
    const technicianComparisons = compareTechnicianReconciliationInputs(
      sourceInputs,
      dashboard.values_json,
      dashboard.source_hash,
    );
    const status: ReconciliationStatus = inheritedJobs.status === "matched"
      && manifestAuthority.matched
      && comparison.matched
      && technicianComparisons.every((row) => row.status === "matched")
      ? "matched"
      : "mismatch";
    const published = await persistReconciliation({
      scope: "technicians",
      period,
      status,
      rollupValue: dashboardSummary.allocatedSellValue,
      snapshotValue: store.allocatedSellValue,
      upstreamSampleValue: null,
      generation: inheritedJobs.generation,
      sourceManifestGenerations: manifestAuthority.generations,
      sourceCount: sourceInputs.reduce((total, row) => total + row.sourceCount, 0),
      sourceValue: sourceInputs.reduce((total, row) => total + row.sourceValue, 0),
      normalizedCount: dashboardSummary.totalJobs,
      normalizedValue: dashboardSummary.allocatedSellValue,
      detail: {
        sourceBasis: "Employee-keyed mapped completed-job timesheet shares compared with the persisted technician read model.",
        inheritedJobsReconciliation: inheritedJobs,
        appOwned: store,
        dashboard: dashboardSummary,
        comparisons: {
          dashboard: comparison,
          technicians: {
            matched: technicianComparisons.filter((row) => row.status === "matched").length,
            mismatch: technicianComparisons.filter((row) => row.status === "mismatch").length,
          },
        },
      },
    }, query);
    if (!published.checkId) throw new Error("Technician reconciliation publication did not return a check ID.");
    await persistTechnicianReconciliationResults({
      reconciliationCheckId: published.checkId,
      periodStart: period.start,
      periodEnd: period.end,
      checkedAt: published.checkedAt,
      comparisons: technicianComparisons,
      query,
    });
    return published;
  });
  if (result.status === "mismatch") await scheduleRepair(result, dependencies, []);
  return result;
}

async function reconcileCommissions(period: Period, dependencies: ResolvedReconciliationDependencies) {
  const [store, dashboard, latestRun, inheritedJobs] = await Promise.all([
    getCommissionStoreSummary(period, dependencies.query),
    getDashboardPayload("commissions", period.start, dependencies.query),
    getLatestCommissionRunSummary(period, dependencies.query),
    getLatestReconciliationStatus("jobs", period.start, dependencies.query),
  ]);
  const dashboardSummary = dashboardCommissionSummary(dashboard);
  const dashboardComparison = compareDashboard(
    { count: store.completedJobs, totalValue: store.totalWorkValue },
    { count: dashboardSummary.completedJobs, totalValue: dashboardSummary.totalWorkValue },
  );
  const runComparison = latestRun
    ? {
        matched:
          latestRun.completedJobs === dashboardSummary.completedJobs &&
          numericMatches(latestRun.totalWorkValue, dashboardSummary.totalWorkValue) &&
          numericMatches(latestRun.payrollTotal, dashboardSummary.payrollTotal),
        completedJobsDelta: dashboardSummary.completedJobs - latestRun.completedJobs,
        totalWorkValueDelta: roundMoney(dashboardSummary.totalWorkValue - latestRun.totalWorkValue),
        payrollTotalDelta: roundMoney(dashboardSummary.payrollTotal - latestRun.payrollTotal),
      }
    : { matched: false, reason: "No immutable commission calculation run found for period." };
  const inheritedStatus = inheritedJobs?.status ?? "sample_missing";
  const status: ReconciliationStatus = inheritedStatus === "matched" && dashboardComparison.matched && runComparison.matched
    ? "matched"
    : inheritedStatus === "sample_missing"
      ? "sample_missing"
      : "mismatch";

  return persistAndScheduleRepair({
    scope: "commissions",
    period,
    status,
    rollupValue: dashboardSummary.payrollTotal,
    snapshotValue: latestRun?.payrollTotal ?? store.payrollTotal,
    upstreamSampleValue: null,
    sourceCount: store.completedJobs,
    sourceValue: store.payrollTotal,
    normalizedCount: dashboardSummary.completedJobs,
    normalizedValue: dashboardSummary.payrollTotal,
    generation: inheritedJobs?.generation ?? null,
    sourceManifestGenerations: inheritedJobs?.sourceManifestGenerations ?? {},
    detail: {
      sourceBasis: "Derived from app-owned completed-job allocations and immutable commission calculation runs.",
      inheritedJobsReconciliation: inheritedJobs,
      appOwned: store,
      latestRun,
      dashboard: dashboardSummary,
      comparisons: {
        dashboard: dashboardComparison,
        latestRun: runComparison,
      },
    },
  }, dependencies);
}

export async function collectDirectSourceMonth(params: {
  scope: DirectReconciliationScope;
  period: Period;
  endpoints: SimproEndpoints;
  budget: RequestBudget;
  leaseOwner: string;
  store: ReconciliationContinuationStore;
  restart?: boolean;
}): Promise<{
  complete: boolean;
  reason?: string;
  claim?: ReconciliationContinuationClaim;
  source?: SourceSummary;
  totalRequestsUsed: number;
}> {
  const claimParams = {
    scope: params.scope,
    periodStart: params.period.start,
    periodEnd: params.period.end,
    leaseOwner: params.leaseOwner,
  };
  const claimed = params.restart
    ? { acquired: true as const, claim: await params.store.restartGeneration(claimParams) }
    : await params.store.claim(claimParams);
  if (!claimed.acquired) {
    return { complete: false, reason: "Another worker owns the active reconciliation generation.", totalRequestsUsed: 0 };
  }

  const claim = claimed.claim;
  const durableRequestLimit = claim.requestsUsed + (params.budget.limit - params.budget.used);
  const state: ReconciliationContinuationState = {
    cursorDay: claim.cursorDay,
    cursorSourceDate: claim.cursorSourceDate,
    cursorPage: claim.cursorPage,
    cursorPhase: claim.cursorPhase,
    cursorDetailIndex: claim.cursorDetailIndex,
    continuationPage: claim.continuationPage,
    pendingDetailIds: [...claim.pendingDetailIds],
    listedSourceIds: [...claim.listedSourceIds],
    sourceEntities: { ...claim.sourceEntities },
    requestsUsed: claim.requestsUsed,
    completedPageCount: claim.completedPageCount,
    completedDayCount: claim.completedDayCount,
  };
  const checkpoint = async () => {
    if (!await params.store.checkpoint(claim, state)) {
      throw new ReconciliationGenerationConflictError(params.scope, params.period.start, claim.generation);
    }
  };
  const reserveRequest = async () => {
    const reserved = await params.store.reserveRequest(claim, durableRequestLimit);
    if (reserved === null) {
      throw new ReconciliationGenerationConflictError(params.scope, params.period.start, claim.generation);
    }
    state.requestsUsed = reserved;
  };
  const budgetStop = async (reason: string) => {
    await checkpoint();
    await params.store.release(claim);
    return {
      complete: false,
      reason,
      claim,
      totalRequestsUsed: state.requestsUsed,
    };
  };

  while (state.cursorPhase !== "complete") {
    const day = state.cursorDay;
    if (!day) throw new Error("An incomplete reconciliation cursor has no day.");

    if (state.cursorPhase === "list") {
      if (params.budget.used >= params.budget.limit) {
        return budgetStop(`Request budget exhausted before page ${state.cursorPage} for ${day}.`);
      }
      try {
        await reserveRequest();
        const page = params.scope === "quotes"
          ? await params.endpoints.listQuotes({
              page: state.cursorPage,
              pageSize: 250,
              budget: params.budget,
              query: state.cursorSourceDate === "date_issued"
                ? { DateIssued: day }
                : { DateApproved: day },
            })
          : await params.endpoints.listJobs({
              page: state.cursorPage,
              pageSize: 250,
              budget: params.budget,
              query: { CompletedDate: day },
            });
        const pageIds = page.rows.map((row) => pickId(row)).filter((id): id is string => Boolean(id));
        state.listedSourceIds = sortedNumericIds([...state.listedSourceIds, ...pageIds]);
        // A quote can be returned by both DateApproved and DateIssued (and by
        // overlapping pages). Fetch it once; the source cohort itself is the
        // set union of both daily result streams.
        const detailedIds = new Set(Object.keys(state.sourceEntities));
        state.pendingDetailIds = sortedNumericIds(
          pageIds.filter((id) => !detailedIds.has(id)),
        );
        state.cursorDetailIndex = 0;
        state.continuationPage = page.continuationToken?.page ?? null;
        state.cursorPhase = "details";
        await checkpoint();
      } catch (error) {
        await checkpoint();
        await params.store.release(claim);
        throw error;
      }
    }

    while (state.cursorPhase === "details" && state.cursorDetailIndex < state.pendingDetailIds.length) {
      const id = state.pendingDetailIds[state.cursorDetailIndex];
      if (params.budget.used >= params.budget.limit) {
        return budgetStop(`Request budget exhausted before detail ${id} on ${day}.`);
      }
      try {
        await reserveRequest();
        const detail = params.scope === "quotes"
          ? await params.endpoints.getQuote(id, params.budget)
          : await params.endpoints.getJob(id, params.budget);
        state.sourceEntities[id] = sourceEntityFromPayload(id, detail);
        state.cursorDetailIndex += 1;
        await checkpoint();
      } catch (error) {
        await checkpoint();
        await params.store.release(claim);
        throw error;
      }
    }

    if (state.cursorPhase !== "details") continue;
    state.completedPageCount += 1;
    state.pendingDetailIds = [];
    state.cursorDetailIndex = 0;
    if (state.continuationPage) {
      state.cursorPage = state.continuationPage;
      state.continuationPage = null;
      state.cursorPhase = "list";
    } else if (params.scope === "quotes" && state.cursorSourceDate === "date_approved") {
      state.cursorSourceDate = "date_issued";
      state.cursorPage = 1;
      state.cursorPhase = "list";
    } else {
      state.completedDayCount += 1;
      state.cursorDay = nextDay(day, params.period.end);
      state.cursorSourceDate = "date_approved";
      state.cursorPage = 1;
      state.cursorPhase = state.cursorDay ? "list" : "complete";
    }
    await checkpoint();
  }

  const allEntities = Object.values(state.sourceEntities);
  const excludedByStage: Array<{ id: string; stageName: string | null }> = [];
  const included = params.scope === "jobs"
    ? allEntities.filter((entity) => {
        if (isCompletedJobStage(entity.stageName)) return true;
        excludedByStage.push({ id: entity.id, stageName: entity.stageName ?? null });
        return false;
      })
    : allEntities;
  const source = summarizeSource(included, true, undefined, {
    pageCount: state.completedPageCount,
    generation: claim.generation,
    totalRequestsUsed: state.requestsUsed,
  });
  if (excludedByStage.length > 0) source.excludedByStage = excludedByStage.slice(0, 50);
  return { complete: true, claim, source, totalRequestsUsed: state.requestsUsed };
}

function sourceEntityFromPayload(id: string, payload: Record<string, unknown>): SourceEntity {
  return {
    id,
    totalValue: moneyValue(payload.Total ?? payload.Totals ?? payload.total ?? payload.total_value),
    stageName: namedValue(payload.Stage ?? payload.stage),
  };
}

function summarizeSource(
  entities: SourceEntity[],
  complete: boolean,
  incompleteReason: string | undefined,
  continuation: Pick<SourceSummary, "pageCount" | "generation" | "totalRequestsUsed">,
): SourceSummary {
  const byId = new Map<string, SourceEntity>();
  for (const entity of entities) {
    byId.set(entity.id, entity);
  }
  const unique = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
  return {
    complete,
    incompleteReason,
    count: unique.length,
    totalValue: roundMoney(sum(unique.map((row) => row.totalValue))),
    ids: unique.map((row) => row.id),
    detailsFetched: entities.length,
    ...continuation,
  };
}

async function getMetricsQuoteSummary(period: Period, query: PostgresQuery): Promise<StoreSummary> {
  const result = await query<{ quote_id: string; total: string }>(
    `select quote_id::text, total::text
       from metrics.metrics_quotes
      where (date_approved between $1::date and $2::date
             or date_issued between $1::date and $2::date)
        and source_deleted_at is null
      order by quote_id`,
    [period.start, period.end],
  );
  return summarizeStore(result.rows.map((row) => ({ id: row.quote_id, totalValue: Number(row.total) || 0 })));
}

async function getQuoteSnapshotSummary(period: Period, query: PostgresQuery): Promise<StoreSummary> {
  const result = await query<{ quote_id: string; total_value: string | null }>(
    `select quote_id::text, total_value::text
       from metrics.quote_snapshots
      where (date_approved between $1::date and $2::date
             or date_issued between $1::date and $2::date)
      order by quote_id`,
    [period.start, period.end],
  );
  return summarizeStore(result.rows.map((row) => ({ id: row.quote_id, totalValue: Number(row.total_value) || 0 })));
}

async function getMetricsQuoteActivitySummary(period: Period, query: PostgresQuery): Promise<StoreSummary> {
  const result = await query<{ quote_id: string; total: string }>(
    `select quote_id::text, total::text
       from metrics.metrics_quotes
      where date_issued between $1::date and $2::date
        and source_deleted_at is null
      order by quote_id`,
    [period.start, period.end],
  );
  return summarizeStore(result.rows.map((row) => ({ id: row.quote_id, totalValue: Number(row.total) || 0 })));
}

async function getMetricsJobSummary(period: Period, query: PostgresQuery): Promise<StoreSummary> {
  const result = await query<{ job_id: string; total: string }>(
    `select job_id::text, total::text
       from metrics.metrics_jobs
      where completed_date between $1::date and $2::date
        and lower(stage) in ('complete', 'archived')
        and source_deleted_at is null
      order by job_id`,
    [period.start, period.end],
  );
  return summarizeStore(result.rows.map((row) => ({ id: row.job_id, totalValue: Number(row.total) || 0 })));
}

async function getJobSnapshotSummary(period: Period, query: PostgresQuery): Promise<StoreSummary> {
  const result = await query<{ job_id: string; sell_value: string | null }>(
    `select job_id::text, sell_value::text
       from metrics.job_snapshots
      where completed_date between $1::date and $2::date
        and lower(stage_name) in ('complete', 'archived')
      order by job_id`,
    [period.start, period.end],
  );
  return summarizeStore(result.rows.map((row) => ({ id: row.job_id, totalValue: Number(row.sell_value) || 0 })));
}

async function getTechnicianStoreSummary(period: Period, query: PostgresQuery) {
  const result = await query<{
    total_jobs: string;
    jobs_with_timesheets: string;
    jobs_missing_timesheets: string;
    actual_hours: string;
    allocated_sell_value: string;
    schedule_covered_jobs: string;
    mobile_status_covered_jobs: string;
  }>(
    `with completed_jobs as (
       select job_id, total
       from metrics.metrics_jobs
       where completed_date between $1::date and $2::date
         and lower(stage) in ('complete', 'archived')
         and source_deleted_at is null
     ),
     timesheet_jobs as (
       select reference_id as job_id, sum(total_hours) as hours
       from metrics.metrics_employee_timesheets
       where reference_type = 'job'
         and source_deleted_at is null
       group by reference_id
     ),
     schedule_jobs as (
       select distinct s.reference_id as job_id
       from metrics.metrics_schedules s
       join completed_jobs j on j.job_id = s.reference_id
       where s.reference_type = 'job'
         and s.source_deleted_at is null
     ),
     mobile_jobs as (
       select distinct m.project_id as job_id
       from metrics.metrics_mobile_status_logs m
       join completed_jobs j on j.job_id = m.project_id
       where m.project_id is not null
     )
     select count(j.job_id)::text as total_jobs,
            count(t.job_id)::text as jobs_with_timesheets,
            (count(j.job_id) - count(t.job_id))::text as jobs_missing_timesheets,
            coalesce(sum(t.hours), 0)::text as actual_hours,
            coalesce(sum(case when t.hours > 0 then j.total else 0 end), 0)::text as allocated_sell_value,
            (select count(*)::text from schedule_jobs) as schedule_covered_jobs,
            (select count(*)::text from mobile_jobs) as mobile_status_covered_jobs
       from completed_jobs j
       left join timesheet_jobs t on t.job_id = j.job_id`,
    [period.start, period.end],
  );
  const row = result.rows[0];
  return {
    totalJobs: Number(row?.total_jobs) || 0,
    jobsWithTimesheets: Number(row?.jobs_with_timesheets) || 0,
    jobsMissingTimesheets: Number(row?.jobs_missing_timesheets) || 0,
    actualHours: Number(row?.actual_hours) || 0,
    allocatedSellValue: roundMoney(Number(row?.allocated_sell_value) || 0),
    scheduleCoveredJobs: Number(row?.schedule_covered_jobs) || 0,
    mobileStatusCoveredJobs: Number(row?.mobile_status_covered_jobs) || 0,
  };
}

async function getCommissionStoreSummary(period: Period, query: PostgresQuery) {
  const result = await query<{
    completed_jobs: string;
    jobs_with_timesheets: string;
    jobs_without_timesheets: string;
    total_work_value: string;
  }>(
    `with completed_jobs as (
       select job_id, total
       from metrics.metrics_jobs
       where completed_date between $1::date and $2::date
         and lower(stage) in ('complete', 'archived')
         and source_deleted_at is null
     ),
     timesheet_jobs as (
       select reference_id as job_id, sum(total_hours) as hours
       from metrics.metrics_employee_timesheets
       where reference_type = 'job'
         and source_deleted_at is null
       group by reference_id
     )
     select count(j.job_id)::text as completed_jobs,
            count(t.job_id)::text as jobs_with_timesheets,
            (count(j.job_id) - count(t.job_id))::text as jobs_without_timesheets,
            coalesce(sum(j.total), 0)::text as total_work_value
       from completed_jobs j
       left join timesheet_jobs t on t.job_id = j.job_id`,
    [period.start, period.end],
  );
  const row = result.rows[0];
  const totalWorkValue = roundMoney(Number(row?.total_work_value) || 0);
  return {
    completedJobs: Number(row?.completed_jobs) || 0,
    jobsWithTimesheets: Number(row?.jobs_with_timesheets) || 0,
    jobsWithoutTimesheets: Number(row?.jobs_without_timesheets) || 0,
    totalWorkValue,
    payrollTotal: 0,
  };
}

async function getLatestCommissionRunSummary(period: Period, query: PostgresQuery) {
  const result = await query<{
    run_id: string;
    completed_jobs: string;
    total_work_value: string;
    payroll_total: string;
    calculation_hash: string | null;
    created_at: string;
  }>(
    `select cr.id::text as run_id, cr.completed_jobs::text, cr.total_work_value::text,
            cr.payroll_total::text, cr.calculation_hash, cr.created_at::text
       from metrics.commission_periods cp
       join metrics.commission_calculation_runs cr on cr.id = cp.current_run_id
      where cp.period_start = $1::date
        and cp.period_end = $2::date
      order by cp.revision desc
      limit 1`,
    [period.start, period.end],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    runId: row.run_id,
    completedJobs: Number(row.completed_jobs) || 0,
    totalWorkValue: roundMoney(Number(row.total_work_value) || 0),
    payrollTotal: roundMoney(Number(row.payroll_total) || 0),
    calculationHash: row.calculation_hash,
    createdAt: row.created_at,
  };
}

async function getDashboardPayload(
  scope: RollupScope,
  periodStart: string,
  query: PostgresQuery,
): Promise<DashboardPayloadRow | null> {
  const result = await query<DashboardPayloadRow>(
    `select values_json, source_hash, rebuilt_at::text
       from metrics.dashboard_read_models
      where metric_family = $1
        and period_grain = 'month'
        and period_start = $2::date
        and superseded_at is null
      order by rebuilt_at desc
      limit 1`,
    [scope, periodStart],
  );
  return result.rows[0] ?? null;
}

async function getLatestReconciliationStatus(scope: RollupScope, periodStart: string, query: PostgresQuery) {
  const nestedSource = scope === "quotes" ? "quote_nested" : "job_nested";
  const result = await query<{
    id: string;
    status: ReconciliationStatus;
    checked_at: string;
    generation: string;
    source_manifest_generations: Record<string, number>;
  }>(
    `select authority.id::text, authority.status, authority.checked_at::text,
            authority.generation::text, authority.source_manifest_generations
       from metrics.authoritative_reconciliation_results authority
       join metrics.source_period_manifests source_manifest
         on source_manifest.source_family = $1
        and source_manifest.period_start = authority.period_start
        and source_manifest.period_end = authority.period_end
       join metrics.source_period_manifests nested_manifest
         on nested_manifest.source_family = $3
        and nested_manifest.period_start = authority.period_start
        and nested_manifest.period_end = authority.period_end
      where authority.scope = $1
        and authority.period_start = $2::date
        and authority.generation is not null
        and authority.source_manifest_generations ->> $1 = authority.generation::text
        and authority.source_manifest_generations ->> $3 = authority.generation::text
        and source_manifest.manifest_generation = authority.generation
        and source_manifest.reconciliation_generation = authority.generation
        and source_manifest.coverage_status = 'complete'
        and source_manifest.reconciliation_status = 'matched'
        and source_manifest.continuation_token is null
        and source_manifest.expected_page_count > 0
        and source_manifest.completed_page_count = source_manifest.expected_page_count
        and source_manifest.reconciled_at is not null
        and nested_manifest.manifest_generation = authority.generation
        and nested_manifest.reconciliation_generation = authority.generation
        and nested_manifest.coverage_status = 'complete'
        and nested_manifest.reconciliation_status = 'matched'
        and nested_manifest.continuation_token is null
        and nested_manifest.expected_page_count > 0
        and nested_manifest.completed_page_count = nested_manifest.expected_page_count
        and nested_manifest.reconciled_at is not null
      order by authority.checked_at desc, authority.id desc
      limit 1`,
    [scope, periodStart, nestedSource],
  );
  const row = result.rows[0];
  return row ? {
    ...row,
    generation: Number(row.generation),
    sourceManifestGenerations: row.source_manifest_generations,
  } : null;
}

async function persistReconciliation(params: {
  scope: RollupScope;
  period: Period;
  status: ReconciliationStatus;
  rollupValue: number | null;
  snapshotValue: number | null;
  upstreamSampleValue: number | null;
  detail: Record<string, unknown>;
  generation?: number | null;
  sourceManifestGenerations?: Record<string, number>;
  completeTraversal?: boolean;
  sourceCount?: number | null;
  sourceValue?: number | null;
  normalizedCount?: number | null;
  normalizedValue?: number | null;
}, query: PostgresQuery): Promise<ReconciliationResult & { checkedAt: string }> {
  const completeTraversal = params.completeTraversal ?? true;
  const generation = params.generation ?? null;
  const sourceManifestGenerations = params.sourceManifestGenerations ?? {};
  if (completeTraversal) {
    if (!Number.isInteger(generation) || Number(generation) <= 0) {
      throw new Error("A complete reconciliation publication requires a positive generation.");
    }
    const declaredGenerations = Object.values(sourceManifestGenerations);
    if (
      declaredGenerations.length === 0
      || declaredGenerations.some((value) => !Number.isInteger(value) || value <= 0)
    ) {
      throw new Error("A complete reconciliation publication requires a nonempty positive source manifest generation map.");
    }
  }
  const result = await query<{ id: string; checked_at: string }>(
    `insert into metrics.reconciliation_checks (
       scope, period_start, period_end, rollup_value, snapshot_value, upstream_sample_value,
       status, detail, generation, complete_traversal, source_manifest_generations,
       source_count, source_value, normalized_count, normalized_value
     )
     values (
       $1, $2::date, $3::date, $4, $5, $6, $7, $8::jsonb, $9::bigint,
       $10::boolean, $11::jsonb, $12, $13, $14, $15
     )
     returning id::text, checked_at::text`,
    [
      params.scope,
      params.period.start,
      params.period.end,
      params.rollupValue,
      params.snapshotValue,
      params.upstreamSampleValue,
      params.status,
      JSON.stringify(params.detail),
      generation,
      completeTraversal,
      JSON.stringify(sourceManifestGenerations),
      params.sourceCount ?? null,
      params.sourceValue ?? params.upstreamSampleValue,
      params.normalizedCount ?? null,
      params.normalizedValue ?? params.snapshotValue,
    ],
  );

  await query(
    `update metrics.dashboard_read_models
        set last_reconciled_at = now(),
            suspect_reason = case when $3 = 'matched' then null else $4 end
      where metric_family = $1
        and period_start = $2::date
        and period_grain = 'month'
        and superseded_at is null
        and $5::boolean`,
    [
      params.scope,
      params.period.start,
      params.status,
      params.status === "matched" ? null : `Latest reconciliation ${params.status}`,
      completeTraversal,
    ],
  );

  return {
    scope: params.scope,
    periodStart: params.period.start,
    periodEnd: params.period.end,
    status: params.status,
    checkId: result.rows[0]?.id ? Number(result.rows[0].id) : null,
    rollupValue: params.rollupValue,
    snapshotValue: params.snapshotValue,
    upstreamSampleValue: params.upstreamSampleValue,
    generation,
    completeTraversal,
    detail: params.detail,
    checkedAt: result.rows[0]?.checked_at ?? new Date().toISOString(),
  };
}

async function persistDirectReconciliation(params: {
  scope: DirectReconciliationScope;
  period: Period;
  status: "matched" | "mismatch";
  rollupValue: number | null;
  snapshotValue: number | null;
  upstreamSampleValue: number | null;
  detail: Record<string, unknown>;
  claim: ReconciliationContinuationClaim;
  source: SourceSummary;
  normalizedIds: string[];
  exactMissingIds: string[];
}, dependencies: ResolvedReconciliationDependencies, query: PostgresQuery): Promise<{
  result: ReconciliationResult;
  repairIds: string[];
}> {
  const nestedSource = params.scope === "quotes" ? "quote_nested" : "job_nested";
  const manifestGenerations = {
    [params.scope]: params.claim.generation,
    [nestedSource]: params.claim.generation,
  };
  const nestedAuthority = await getNestedSourceAuthority(params.scope, params.source.ids, query);
  const completeTraversal = nestedAuthority.complete;
  const finalStatus: "matched" | "mismatch" = params.status === "matched" && completeTraversal
    ? "matched"
    : "mismatch";
  const evidenceTime = await databaseTimestamp(query);
  const rootManifest = buildDirectRootManifest(params, evidenceTime);
  const nestedManifest = buildNestedSourceManifest({
    sourceFamily: nestedSource,
    period: params.period,
    generation: params.claim.generation,
    reconciliationStatus: finalStatus,
    authority: nestedAuthority,
    evidenceAsOf: evidenceTime,
  });
  const rootManifestUpsert = await upsertSourcePeriodManifest(rootManifest, query);
  const nestedManifestUpsert = await upsertSourcePeriodManifest(nestedManifest, query);
  if (rootManifestUpsert.rowCount === 0 || nestedManifestUpsert.rowCount === 0) {
    // The conditional manifest guard affected zero rows: a newer manifest
    // generation owns this period, so the claimed generation lost its fence.
    // Abort so the surrounding transaction cannot publish an authoritative
    // check whose manifests were never written.
    throw new ReconciliationGenerationConflictError(params.scope, params.period.start, params.claim.generation);
  }
  const result = await persistReconciliation({
    ...params,
    status: finalStatus,
    generation: params.claim.generation,
    sourceManifestGenerations: manifestGenerations,
    completeTraversal,
    sourceCount: params.source.count,
    sourceValue: params.source.totalValue,
    normalizedCount: params.normalizedIds.length,
    normalizedValue: params.snapshotValue,
    detail: {
      ...params.detail,
      nestedAuthority: {
        complete: nestedAuthority.complete,
        expectedProjectCount: nestedAuthority.expectedProjectCount,
        completedProjectCount: nestedAuthority.completedProjectCount,
        invalidProjectIds: nestedAuthority.invalidProjectIds,
        childIdentityHash: hashEvidence(nestedAuthority.childFingerprints),
        projectGenerations: nestedAuthority.projectGenerations,
        projectRootHashes: nestedAuthority.projectRootHashes,
      },
      finalPublished: completeTraversal,
    },
  }, query);
  if (!result.checkId || !await dependencies.continuationStore.publish(
    params.claim,
    result.checkId,
    finalStatus,
    query,
  )) {
    throw new ReconciliationGenerationConflictError(params.scope, params.period.start, params.claim.generation);
  }
  return {
    result,
    repairIds: sortedNumericIds([...params.exactMissingIds, ...nestedAuthority.invalidProjectIds]),
  };
}

function buildDirectRootManifest(
  params: {
    scope: DirectReconciliationScope;
    period: Period;
    status: ReconciliationStatus;
    snapshotValue: number | null;
    source: SourceSummary;
    claim: ReconciliationContinuationClaim;
    normalizedIds: string[];
  },
  evidenceAsOf: string,
): SourcePeriodManifest {
  const reconciliationStatus = params.status === "matched" ? "matched" as const : "mismatch" as const;
  return buildSourcePeriodManifestEvidence({
    sourceFamily: params.scope,
    periodStart: params.period.start,
    periodEnd: params.period.end,
    listedIds: params.source.ids,
    detailIds: params.source.ids,
    normalizedIds: params.normalizedIds,
    authoritativeListComplete: true,
    listRequestCount: params.source.pageCount,
    expectedPageCount: params.source.pageCount,
    completedPageCount: params.source.pageCount,
    manifestGeneration: params.claim.generation,
    reconciliationGeneration: reconciliationStatus === "matched" ? params.claim.generation : null,
    reconciliationStatus,
    evidenceAsOf,
    reconciledAt: reconciliationStatus === "matched" ? evidenceAsOf : null,
    sourceValue: params.source.totalValue,
    normalizedValue: params.snapshotValue,
    evidence: {
      reconciliationScope: params.scope,
      continuationGeneration: params.claim.generation,
      fullMonthTraversal: true,
      sourceRole: "page",
    },
  });
}

function buildNestedSourceManifest(params: {
  sourceFamily: "quote_nested" | "job_nested";
  period: Period;
  generation: number;
  reconciliationStatus: "matched" | "mismatch";
  authority: NestedSourceAuthority;
  evidenceAsOf: string;
}): SourcePeriodManifest {
  const matched = params.reconciliationStatus === "matched" && params.authority.complete;
  const reconciliationStatus = matched
    ? "matched" as const
    : params.authority.complete
      ? "mismatch" as const
      : "pending" as const;
  const expectedPageCount = Math.max(1, params.authority.expectedProjectCount);
  const completedPageCount = params.authority.expectedProjectCount === 0
    ? 1
    : params.authority.completedProjectCount;
  return {
    sourceFamily: params.sourceFamily,
    periodStart: params.period.start,
    periodEnd: params.period.end,
    coverageStatus: matched ? "complete" : params.authority.complete ? "suspect" : "partial",
    reconciliationStatus,
    listedCount: params.authority.childFingerprints.length,
    detailCount: params.authority.validChildFingerprints.length,
    normalizedCount: params.authority.validChildFingerprints.length,
    sourceIdHash: hashEvidence(params.authority.childFingerprints),
    normalizedIdHash: hashEvidence(params.authority.validChildFingerprints),
    sourceValue: null,
    normalizedValue: null,
    continuationToken: params.authority.complete ? null : {
      invalidProjectIds: params.authority.invalidProjectIds,
    },
    manifestGeneration: params.generation,
    reconciliationGeneration: matched ? params.generation : null,
    expectedPageCount,
    completedPageCount,
    evidenceAsOf: params.evidenceAsOf,
    reconciledAt: matched ? params.evidenceAsOf : null,
    evidence: {
      authoritativeSource: "project_nested_traversals",
      authoritativeListComplete: params.authority.complete,
      listRequestCount: expectedPageCount,
      expectedPageCount,
      completedPageCount,
      manifestGeneration: params.generation,
      reconciliationGeneration: matched ? params.generation : null,
      exactChildIdentityHash: hashEvidence(params.authority.childFingerprints),
      projectGenerations: params.authority.projectGenerations,
      projectRootHashes: params.authority.projectRootHashes,
      invalidProjectIds: params.authority.invalidProjectIds,
      emptyParentSet: params.authority.expectedProjectCount === 0,
    },
  };
}

async function getNestedSourceAuthority(
  scope: DirectReconciliationScope,
  sourceIds: string[],
  query: PostgresQuery,
): Promise<NestedSourceAuthority> {
  const ids = sortedNumericIds(sourceIds);
  if (ids.length !== sourceIds.length) {
    return {
      complete: false,
      expectedProjectCount: sourceIds.length,
      completedProjectCount: 0,
      childFingerprints: [],
      validChildFingerprints: [],
      invalidProjectIds: [...new Set(sourceIds)].sort(),
      projectGenerations: {},
      projectRootHashes: {},
    };
  }
  if (ids.length === 0) {
    return {
      complete: true,
      expectedProjectCount: 0,
      completedProjectCount: 0,
      childFingerprints: [],
      validChildFingerprints: [],
      invalidProjectIds: [],
      projectGenerations: {},
      projectRootHashes: {},
    };
  }

  const projectType = scope === "quotes" ? "quote" : "job";
  const config = nestedAuthoritySqlConfig(scope);
  const traversals = await query<{
    project_id: string;
    generation: number | string;
    status: string;
    finalized_at: string | null;
  }>(
    `select project_id::text, generation, status, finalized_at::text
       from metrics.project_nested_traversals
      where project_type = $1::text and project_id = any($2::bigint[])
      for share`,
    [projectType, ids.map(Number)],
  );
  const traversalByProject = new Map(traversals.rows.map((row) => [row.project_id, row]));
  const roots = await query<{
    project_id: string;
    canonical_snapshot_id: string | null;
    canonical_source_hash: string | null;
    root_snapshot_id: string | null;
    root_source_hash: string | null;
    root_complete_traversal: boolean | null;
  }>(
    `with expected(project_id) as (select unnest($1::bigint[]))
     select expected.project_id::text,
            canonical.source_snapshot_id::text as canonical_snapshot_id,
            canonical.source_hash as canonical_source_hash,
            root.id::text as root_snapshot_id,
            root.source_hash as root_source_hash,
            root.complete_traversal as root_complete_traversal
       from expected
       left join metrics.${config.rootTable} canonical
         on canonical.${config.rootIdColumn} = expected.project_id
        and canonical.source_deleted_at is null
       left join metrics.raw_simpro_snapshots root
         on root.id = canonical.source_snapshot_id
        and root.entity_type = $2::text
        and root.entity_id = expected.project_id::text
        and root.source_deleted_at is null`,
    [ids.map(Number), `${projectType}_details`],
  );
  const rootByProject = new Map(roots.rows.map((row) => [row.project_id, row]));
  const children = await query<{
    project_id: string;
    child_kind: string;
    child_identity: string;
    source_hash: string | null;
    traversal_generation: number | string | null;
    snapshot_hash: string | null;
    snapshot_present: boolean;
    snapshot_parent_matches: boolean;
  }>(config.childSql, [ids.map(Number), projectType]);

  const childrenByProject = new Map<string, typeof children.rows>();
  for (const child of children.rows) {
    const rows = childrenByProject.get(child.project_id) ?? [];
    rows.push(child);
    childrenByProject.set(child.project_id, rows);
  }
  const childFingerprints: string[] = [];
  const validChildFingerprints: string[] = [];
  const invalidProjectIds: string[] = [];
  const projectGenerations: Record<string, number> = {};
  const projectRootHashes: Record<string, string> = {};
  let completedProjectCount = 0;

  for (const id of ids) {
    const traversal = traversalByProject.get(id);
    const root = rootByProject.get(id);
    const generation = Number(traversal?.generation);
    const rootValid = Boolean(
      traversal
      && Number.isInteger(generation)
      && generation > 0
      && traversal.status === "completed"
      && traversal.finalized_at
      && root?.canonical_snapshot_id
      && root.canonical_snapshot_id === root.root_snapshot_id
      && root.canonical_source_hash
      && root.canonical_source_hash === root.root_source_hash
      && root.root_complete_traversal === true,
    );
    if (Number.isInteger(generation) && generation > 0) projectGenerations[id] = generation;
    if (root?.root_source_hash) projectRootHashes[id] = root.root_source_hash;

    let childrenValid = true;
    for (const child of childrenByProject.get(id) ?? []) {
      const childGeneration = Number(child.traversal_generation);
      const valid = rootValid
        && child.snapshot_present
        && child.snapshot_parent_matches
        && Boolean(child.source_hash)
        && child.source_hash === child.snapshot_hash
        && Number.isInteger(childGeneration)
        && childGeneration === generation;
      const fingerprint = [
        child.child_kind,
        child.child_identity,
        child.source_hash ?? "missing-hash",
        Number.isInteger(childGeneration) ? childGeneration : "missing-generation",
      ].join(":");
      childFingerprints.push(fingerprint);
      if (valid) validChildFingerprints.push(fingerprint);
      else childrenValid = false;
    }
    if (rootValid && childrenValid) completedProjectCount += 1;
    else invalidProjectIds.push(id);
  }

  childFingerprints.sort();
  validChildFingerprints.sort();
  return {
    complete: invalidProjectIds.length === 0 && completedProjectCount === ids.length,
    expectedProjectCount: ids.length,
    completedProjectCount,
    childFingerprints,
    validChildFingerprints,
    invalidProjectIds,
    projectGenerations,
    projectRootHashes,
  };
}

function nestedAuthoritySqlConfig(scope: DirectReconciliationScope) {
  const quote = scope === "quotes";
  const rootTable = quote ? "metrics_quotes" : "metrics_jobs";
  const rootIdColumn = quote ? "quote_id" : "job_id";
  const costCenterTable = quote ? "metrics_quote_cost_centers" : "metrics_job_cost_centers";
  const laborTable = quote ? "metrics_quote_labor" : "metrics_job_labor";
  const itemTable = quote ? "metrics_quote_items" : "metrics_job_items";
  return {
    rootTable,
    rootIdColumn,
    childSql: `
      with children as (
        select child.${rootIdColumn} as project_id, child.section_id, child.cost_center_id,
               'cost_center'::text as child_kind,
               concat_ws(':', child.${rootIdColumn}, child.section_id, child.cost_center_id) as child_identity,
               child.source_hash, child.source_snapshot_id, child.traversal_generation
          from metrics.${costCenterTable} child
         where child.${rootIdColumn} = any($1::bigint[]) and child.source_deleted_at is null
        union all
        select child.${rootIdColumn}, child.section_id, child.cost_center_id, 'labor',
               concat_ws(':', child.${rootIdColumn}, child.section_id, child.cost_center_id, child.labor_id),
               child.source_hash, child.source_snapshot_id, child.traversal_generation
          from metrics.${laborTable} child
         where child.${rootIdColumn} = any($1::bigint[]) and child.source_deleted_at is null
        union all
        select child.${rootIdColumn}, child.section_id, child.cost_center_id, 'item',
               concat_ws(':', child.${rootIdColumn}, child.section_id, child.cost_center_id, child.item_type, child.item_id),
               child.source_hash, child.source_snapshot_id, child.traversal_generation
          from metrics.${itemTable} child
         where child.${rootIdColumn} = any($1::bigint[]) and child.source_deleted_at is null
        union all
        select child.project_id, child.section_id, child.cost_center_id, 'work_order',
               concat_ws(':', child.project_id, child.section_id, child.cost_center_id, child.work_order_id),
               child.source_hash, child.source_snapshot_id, child.traversal_generation
          from metrics.metrics_work_orders child
         where child.project_type = $2::text
           and child.project_id = any($1::bigint[])
           and child.source_deleted_at is null
      )
      select children.project_id::text, children.child_kind, children.child_identity,
             children.source_hash, children.traversal_generation,
             snapshot.source_hash as snapshot_hash,
             (snapshot.id is not null and snapshot.source_deleted_at is null) as snapshot_present,
             (
               snapshot.parent_identity ->> 'projectType' = $2::text
               and snapshot.parent_identity ->> 'projectId' = children.project_id::text
               and snapshot.parent_identity ->> 'sectionId' = children.section_id::text
               and snapshot.parent_identity ->> 'costCenterId' = children.cost_center_id::text
             ) as snapshot_parent_matches
        from children
        left join metrics.raw_simpro_snapshots snapshot
          on snapshot.id = children.source_snapshot_id`,
  };
}

async function databaseTimestamp(query: PostgresQuery) {
  const result = await query<{ current_time: string }>(
    `select clock_timestamp()::text as current_time`,
  );
  const value = result.rows[0]?.current_time;
  if (!value) throw new Error("Database clock did not return a reconciliation timestamp.");
  return new Date(value).toISOString();
}

function hashEvidence(values: string[]) {
  return createHash("sha256").update(JSON.stringify([...values].sort())).digest("hex");
}

async function persistAndScheduleRepair(params: {
  scope: RollupScope;
  period: Period;
  status: ReconciliationStatus;
  rollupValue: number | null;
  snapshotValue: number | null;
  upstreamSampleValue: number | null;
  detail: Record<string, unknown>;
  generation?: number | null;
  sourceManifestGenerations?: Record<string, number>;
  sourceCount?: number | null;
  sourceValue?: number | null;
  normalizedCount?: number | null;
  normalizedValue?: number | null;
}, dependencies: ResolvedReconciliationDependencies): Promise<ReconciliationResult> {
  if (params.status === "sample_missing") {
    return incompleteResult(params.scope, params.period, 0, "A current complete inherited reconciliation is required.");
  }
  const result = await persistReconciliation({ ...params, completeTraversal: true }, dependencies.query);
  if (result.status !== "mismatch") return result;

  await scheduleRepair(result, dependencies, []);
  return result;
}

async function scheduleRepair(
  result: ReconciliationResult,
  dependencies: ResolvedReconciliationDependencies,
  exactIds: string[],
) {
  try {
    if (result.scope === "quotes" || result.scope === "jobs") {
      if (exactIds.length > 0) {
        const entityType = result.scope === "quotes" ? "quote" as const : "job" as const;
        for (const id of exactIds) {
          await dependencies.enqueueBoundedWork({
            work: { kind: "entity_refresh", entityType, entityId: Number(id) },
            requestedBy: "metrics-reconciliation-worker",
            reason: `Repair exact missing ${entityType} ${id} from reconciliation ${result.checkId ?? "unknown"}.`,
            origin: "reconciliation",
          });
        }
      } else {
        await dependencies.enqueueBoundedWork({
          work: {
            kind: "period_backfill",
            sourceFamily: result.scope,
            periodStart: result.periodStart,
            periodEnd: result.periodStart,
          },
          requestedBy: "metrics-reconciliation-worker",
          reason: `Repair ${result.scope} value reconciliation drift for ${result.periodStart}.`,
          origin: "reconciliation",
        });
      }
    } else {
      await dependencies.enqueueRollup({
        metricFamily: result.scope,
        periodStart: result.periodStart,
        reason: `repair reconciliation drift from check ${result.checkId ?? "unknown"}`,
      });
      await dependencies.query(
        `insert into metrics.audit_events (
           actor_email, action, entity_type, entity_id, after_value, reason
         ) values (
           'metrics-reconciliation-worker', 'reconciliation_repair_queued',
           'dashboard_rollup', $1, $2::jsonb, $3
         )`,
        [
          `${result.scope}:${result.periodStart}`,
          JSON.stringify({ scope: result.scope, periodStart: result.periodStart, checkId: result.checkId }),
          `Derived ${result.scope} rollup did not reconcile.`,
        ],
      );
    }
  } catch (error) {
    await dependencies.query(
      `insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, after_value, reason
       ) values (
         'metrics-reconciliation-worker', 'reconciliation_repair_enqueue_failed',
         'reconciliation_check', $1, $2::jsonb, $3
       )`,
      [
        String(result.checkId ?? `${result.scope}:${result.periodStart}`),
        JSON.stringify({ scope: result.scope, periodStart: result.periodStart }),
        error instanceof Error ? error.message.slice(0, 1000) : "Unknown repair enqueue failure.",
      ],
    ).catch(() => undefined);
  }
}

function summarizeStore(rows: Array<{ id: string; totalValue: number }>): StoreSummary {
  return {
    count: rows.length,
    totalValue: roundMoney(sum(rows.map((row) => row.totalValue))),
    ids: rows.map((row) => row.id).sort((a, b) => Number(a) - Number(b)),
  };
}

function dashboardQuoteSummary(row: DashboardPayloadRow | null) {
  const payload = row?.values_json ?? {};
  return {
    count: Number(payload.quoteCount) || 0,
    totalValue: roundMoney(Number(payload.quoteValue) || 0),
    rebuiltAt: row?.rebuilt_at ?? null,
    sourceHash: row?.source_hash ?? null,
    present: Boolean(row),
  };
}

function dashboardJobSummary(row: DashboardPayloadRow | null) {
  const payload = row?.values_json ?? {};
  return {
    count: Number(payload.completedJobCount) || 0,
    totalValue: roundMoney(Number(payload.totalSellValue) || 0),
    rebuiltAt: row?.rebuilt_at ?? null,
    sourceHash: row?.source_hash ?? null,
    present: Boolean(row),
  };
}

function dashboardTechnicianSummary(row: DashboardPayloadRow | null) {
  const payload = row?.values_json ?? {};
  const coverage = asRecord(payload.coverage);
  const technicians = asArray(payload.technicians).map(asRecord);
  // Disclosed outside-roster allocation counts toward totals so store-vs-dashboard
  // reconciliation still balances after the effective-roster gating.
  const outsideRoster = asArray(payload.outsideRoster).map(asRecord);
  return {
    totalJobs: Number(coverage.totalJobs) || 0,
    jobsWithTimesheets: Number(coverage.jobsWithTimesheets) || 0,
    allocatedSellValue: roundMoney(
      sum(technicians.map((tech) => Number(tech.allocatedSellValue) || 0)) +
        sum(outsideRoster.map((entry) => Number(entry.allocatedSellValue) || 0)),
    ),
    actualHours: roundMoney(
      sum(technicians.map((tech) => Number(tech.actualJobHours) || 0)) +
        sum(outsideRoster.map((entry) => Number(entry.actualJobHours) || 0)),
    ),
    rebuiltAt: row?.rebuilt_at ?? null,
    sourceHash: row?.source_hash ?? null,
    present: Boolean(row),
  };
}

function dashboardCommissionSummary(row: DashboardPayloadRow | null) {
  const payload = row?.values_json ?? {};
  return {
    completedJobs: Number(payload.completedJobs) || 0,
    totalWorkValue: roundMoney(Number(payload.totalWorkValue) || 0),
    payrollTotal: roundMoney(Number(payload.payrollTotal) || 0),
    poolAmount: roundMoney(Number(payload.poolAmount) || 0),
    rebuiltAt: row?.rebuilt_at ?? null,
    sourceHash: row?.source_hash ?? null,
    present: Boolean(row),
  };
}

function compareSummaries(source: SourceSummary, store: StoreSummary) {
  const idDiff = compareIds(source.ids, store.ids);
  const totalValueDelta = roundMoney(store.totalValue - source.totalValue);
  return {
    matched: idDiff.idsMatched && numericMatches(store.totalValue, source.totalValue),
    countDelta: store.count - source.count,
    totalValueDelta,
    ...idDiff,
  };
}

function exactMissingIds(
  ...comparisons: Array<{ missingIds: string[] }>
) {
  return sortedNumericIds(comparisons.flatMap((comparison) => comparison.missingIds));
}

function compareDashboard(source: { count: number; totalValue: number }, dashboard: { count: number; totalValue: number; present?: boolean }) {
  return {
    matched: Boolean(dashboard.present ?? true) && dashboard.count === source.count && numericMatches(dashboard.totalValue, source.totalValue),
    present: dashboard.present ?? true,
    countDelta: dashboard.count - source.count,
    totalValueDelta: roundMoney(dashboard.totalValue - source.totalValue),
  };
}

function compareIds(sourceIds: string[], storeIds: string[]) {
  const source = new Set(sourceIds);
  const store = new Set(storeIds);
  const missing = sourceIds.filter((id) => !store.has(id));
  const extra = storeIds.filter((id) => !source.has(id));
  return {
    idsMatched: missing.length === 0 && extra.length === 0,
    missingCount: missing.length,
    extraCount: extra.length,
    missingIds: missing.slice(0, 50),
    extraIds: extra.slice(0, 50),
  };
}

function monthWindow(periodStart: string): Period {
  const match = periodStart.match(/^(\d{4})-(\d{2})(?:-01)?$/);
  if (!match) {
    throw new Error(`Invalid period start: ${periodStart}. Expected YYYY-MM or YYYY-MM-01.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid period start: ${periodStart}.`);
  }
  const start = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start, end };
}

function currentMonthStart() {
  return new Date().toISOString().slice(0, 7) + "-01";
}

function nextDay(day: string, periodEnd: string) {
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const value = next.toISOString().slice(0, 10);
  return value <= periodEnd ? value : null;
}

function moneyValue(value: unknown): number {
  return moneyValueOrNull(value) ?? 0;
}

function moneyValueOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["ExTax", "IncTax", "Total", "SellPrice", "Sell", "Value", "Amount"]) {
      const nested = moneyValueOrNull(record[key]);
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
}

function namedValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return pickName(value);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function numericMatches(left: number, right: number) {
  return Math.abs(roundMoney(left) - roundMoney(right)) <= valueTolerance;
}

function nullableNumber(value: number | string | null) {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sortedNumericIds(values: string[]) {
  return [...new Set(values.filter((value) => /^\d+$/.test(value)))]
    .sort((left, right) => Number(left) - Number(right));
}

function assertNever(value: never): never {
  throw new Error(`Unhandled reconciliation scope: ${value}`);
}

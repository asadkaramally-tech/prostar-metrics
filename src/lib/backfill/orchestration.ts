import {
  AuthoritativeTraversalRecorder,
  type BackfillFilterTarget,
  type BackfillTraversalSliceEvidence,
} from "@/lib/backfill/manifest";
import { BACKFILL_DETAIL_PAGE_REQUEST_FLOOR, type BackfillSourceFamily } from "@/lib/backfill/plan";
import type { RequestBudget } from "@/lib/simpro/client";
import type { SimproEndpoints } from "@/lib/simpro/endpoints";
import { ingestEntityPage, type IngestionEntity, type IngestionResult } from "@/lib/simpro/ingest";
import { findNextBackfillParentId, type BackfillWorkUnit } from "@/lib/store/backfill-ledger";

export type BackfillSliceResult = {
  requestsUsed: number;
  snapshotsWritten: number;
  normalizedWritten: number;
  continuationToken: Record<string, unknown> | null;
  ingestionComplete: boolean;
  traversal: BackfillTraversalSliceEvidence;
};

type ResultCounters = {
  snapshotsWritten: number;
  normalizedWritten: number;
};

type DatedContinuation = {
  version: 1;
  strategy: "dated";
  targetIndex: number;
  sourceContinuation: Record<string, unknown> | null;
};

type SingleContinuation = {
  version: 1;
  strategy: "single";
  sourceContinuation: Record<string, unknown> | null;
};

type NestedContinuation = {
  version: 1;
  strategy: "nested";
  lastCompletedParentId: number;
  currentParentId: number | null;
  sourceContinuation: Record<string, unknown> | null;
};

export async function ingestBackfillSlice(params: {
  workUnit: BackfillWorkUnit;
  endpoints: SimproEndpoints;
  requestBudget: RequestBudget;
  ingestionRunId?: number;
  nextParentId?: typeof findNextBackfillParentId;
  ingestEntity?: typeof ingestEntityPage;
}): Promise<BackfillSliceResult> {
  const recorder = new AuthoritativeTraversalRecorder(params.workUnit, params.endpoints);
  if (params.workUnit.execution_mode === "coverage_only") {
    return emptyCompleteResult(params.requestBudget, recorder);
  }
  switch (params.workUnit.source_family) {
    case "quotes":
      return ingestDatedSource(params, recorder, "quotes");
    case "jobs":
      return ingestDatedSource(params, recorder, "jobs");
    case "quote_nested":
    case "job_nested":
      return ingestNestedSource(params, recorder);
    case "employees":
      return ingestSingleSource(params, recorder, "employees");
    case "timesheets":
      return ingestSingleSource(params, recorder, "timesheets");
    case "jobs_from_timesheets":
      return ingestSingleSource(params, recorder, "jobs_from_timesheets");
    case "schedules":
      return ingestSingleSource(params, recorder, "schedules");
    case "mobile_status":
      return emptyCompleteResult(params.requestBudget, recorder);
    default:
      return assertNever(params.workUnit.source_family);
  }
}

export function ingestionEntityForBackfillSource(sourceFamily: BackfillSourceFamily): IngestionEntity | null {
  return sourceFamily === "mobile_status" ? null : sourceFamily;
}

export function backfillTargetKey(workUnit: BackfillWorkUnit) {
  const continuation = workUnit.continuation_token;
  if (continuation?.strategy === "nested") return `parent:${String(continuation.currentParentId ?? "next")}`;
  if (continuation?.strategy === "dated") return `target:${String(continuation.targetIndex ?? 0)}`;
  return `${workUnit.source_family}:${workUnit.month_start.slice(0, 7)}`;
}

async function ingestDatedSource(
  params: Parameters<typeof ingestBackfillSlice>[0],
  recorder: AuthoritativeTraversalRecorder,
  entity: Extract<IngestionEntity, "quotes" | "jobs">,
) {
  const targets = recorder.contract.targets;
  const state = restoreDatedContinuation(params.workUnit.continuation_token);
  const counters = emptyCounters();
  const ingest = params.ingestEntity ?? ingestEntityPage;

  while (
    state.targetIndex < targets.length
    && (params.ingestEntity ? hasBudget(params.requestBudget) : hasDetailPageBudget(params.requestBudget))
  ) {
    const target = targets[state.targetIndex];
    recorder.beginTarget(target);
    const result = await ingest({
      endpoints: recorder.endpoints,
      entity,
      page: numberValue(state.sourceContinuation?.page, 1),
      continuationToken: state.sourceContinuation,
      params: target.query,
      requestBudget: params.requestBudget,
      ingestionRunId: params.ingestionRunId,
    });
    addResult(counters, result);
    if (!params.ingestEntity) {
      for (const candidate of result.candidateRefreshes ?? []) {
        if (params.requestBudget.used >= params.requestBudget.limit) break;
        const detail = await ingest({
          endpoints: recorder.endpoints,
          entity,
          params: { ...target.query, entityId: candidate.entityId },
          requestBudget: params.requestBudget,
          ingestionRunId: params.ingestionRunId,
        });
        addResult(counters, detail);
      }
    }
    recorder.completeInvocation(result.continuationToken);
    if (recorder.hasViolations()) break;
    if (result.continuationToken) {
      state.sourceContinuation = result.continuationToken;
    } else {
      recorder.completeTarget(target.key);
      state.targetIndex += 1;
      state.sourceContinuation = null;
    }
  }

  const complete = state.targetIndex >= targets.length && !recorder.hasViolations();
  return sliceResult(params.requestBudget, counters, complete ? null : state, complete, recorder);
}

async function ingestSingleSource(
  params: Parameters<typeof ingestBackfillSlice>[0],
  recorder: AuthoritativeTraversalRecorder,
  entity: Extract<IngestionEntity, "employees" | "timesheets" | "jobs_from_timesheets" | "schedules">,
) {
  const target = recorder.contract.targets[0];
  if (!target) throw new Error(`Missing authoritative filter target for ${entity}.`);
  const state = restoreSingleContinuation(params.workUnit.continuation_token);
  const counters = emptyCounters();
  const ingest = params.ingestEntity ?? ingestEntityPage;
  let complete = false;

  while (
    params.ingestEntity
      ? hasBudget(params.requestBudget)
      : hasBudgetForSingleSource(params.requestBudget, entity)
  ) {
    recorder.beginTarget(target);
    const result = await ingest({
      endpoints: recorder.endpoints,
      entity,
      page: numberValue(state.sourceContinuation?.page, 1),
      continuationToken: state.sourceContinuation,
      params: target.query,
      requestBudget: params.requestBudget,
      ingestionRunId: params.ingestionRunId,
    });
    addResult(counters, result);
    for (const candidate of result.candidateRefreshes ?? []) {
      if (params.requestBudget.used >= params.requestBudget.limit) break;
      const detail = await ingest({
        endpoints: recorder.endpoints,
        entity,
        params: { ...target.query, entityId: candidate.entityId },
        requestBudget: params.requestBudget,
        ingestionRunId: params.ingestionRunId,
      });
      addResult(counters, detail);
    }
    recorder.completeInvocation(result.continuationToken);
    if (recorder.hasViolations()) break;
    state.sourceContinuation = result.continuationToken;
    if (!result.continuationToken) {
      complete = true;
      if (entity === "jobs_from_timesheets") recorder.recordDerivedCompletion(target);
      else recorder.completeTarget(target.key);
      break;
    }
  }
  return sliceResult(params.requestBudget, counters, complete ? null : state, complete, recorder);
}

async function ingestNestedSource(
  params: Parameters<typeof ingestBackfillSlice>[0],
  recorder: AuthoritativeTraversalRecorder,
) {
  const dependencyTarget = recorder.contract.targets[0];
  if (!dependencyTarget) throw new Error(`Missing authoritative dependency target for ${params.workUnit.source_family}.`);
  const state = restoreNestedContinuation(params.workUnit.continuation_token);
  const counters = emptyCounters();
  const nextParentId = params.nextParentId ?? findNextBackfillParentId;
  const ingest = params.ingestEntity ?? ingestEntityPage;

  while (hasBudget(params.requestBudget)) {
    if (state.currentParentId === null) {
      state.currentParentId = await nextParentId({
        sourceFamily: params.workUnit.source_family as "quote_nested" | "job_nested",
        monthStart: params.workUnit.month_start,
        monthEndExclusive: params.workUnit.month_end_exclusive,
        afterId: state.lastCompletedParentId,
      });
      if (state.currentParentId === null) {
        recorder.recordDerivedCompletion(dependencyTarget);
        return sliceResult(params.requestBudget, counters, null, true, recorder);
      }
    }

    const parentTarget: BackfillFilterTarget = {
      ...dependencyTarget,
      key: `${params.workUnit.source_family}:parent:${state.currentParentId}`,
      query: { ...dependencyTarget.query, parentId: state.currentParentId },
    };
    recorder.beginTarget(parentTarget);
    const result = await ingest({
      endpoints: recorder.endpoints,
      entity: params.workUnit.source_family as "quote_nested" | "job_nested",
      continuationToken: state.sourceContinuation,
      params: { entityId: state.currentParentId },
      requestBudget: params.requestBudget,
      ingestionRunId: params.ingestionRunId,
    });
    addResult(counters, result);
    recorder.completeInvocation(result.continuationToken);
    if (recorder.hasViolations()) break;
    if (result.continuationToken) {
      state.sourceContinuation = result.continuationToken;
    } else {
      recorder.addSourceIds([String(state.currentParentId)]);
      state.lastCompletedParentId = state.currentParentId;
      state.currentParentId = null;
      state.sourceContinuation = null;
    }
  }
  return sliceResult(params.requestBudget, counters, state, false, recorder);
}

function restoreDatedContinuation(value: Record<string, unknown> | null): DatedContinuation {
  if (value?.strategy === "dated") {
    return {
      version: 1,
      strategy: "dated",
      targetIndex: numberValue(value.targetIndex, 0),
      sourceContinuation: recordValue(value.sourceContinuation),
    };
  }
  return { version: 1, strategy: "dated", targetIndex: 0, sourceContinuation: null };
}

function restoreSingleContinuation(value: Record<string, unknown> | null): SingleContinuation {
  return {
    version: 1,
    strategy: "single",
    sourceContinuation: value?.strategy === "single" ? recordValue(value.sourceContinuation) : null,
  };
}

function restoreNestedContinuation(value: Record<string, unknown> | null): NestedContinuation {
  if (value?.strategy === "nested") {
    return {
      version: 1,
      strategy: "nested",
      lastCompletedParentId: numberValue(value.lastCompletedParentId, 0),
      currentParentId: nullablePositiveNumber(value.currentParentId),
      sourceContinuation: recordValue(value.sourceContinuation),
    };
  }
  return {
    version: 1,
    strategy: "nested",
    lastCompletedParentId: 0,
    currentParentId: null,
    sourceContinuation: null,
  };
}

function emptyCompleteResult(
  requestBudget: RequestBudget,
  recorder: AuthoritativeTraversalRecorder,
): BackfillSliceResult {
  return {
    requestsUsed: requestBudget.used,
    snapshotsWritten: 0,
    normalizedWritten: 0,
    continuationToken: null,
    ingestionComplete: true,
    traversal: recorder.finish({ continuation: null, ingestionComplete: true }),
  };
}

function emptyCounters(): ResultCounters {
  return { snapshotsWritten: 0, normalizedWritten: 0 };
}

function addResult(counters: ResultCounters, result: IngestionResult) {
  counters.snapshotsWritten += result.snapshotsWritten;
  counters.normalizedWritten += result.normalizedWritten;
}

function sliceResult(
  budget: RequestBudget,
  counters: ResultCounters,
  continuationToken: Record<string, unknown> | null,
  ingestionComplete: boolean,
  recorder: AuthoritativeTraversalRecorder,
): BackfillSliceResult {
  return {
    requestsUsed: budget.used,
    ...counters,
    continuationToken,
    ingestionComplete,
    traversal: recorder.finish({ continuation: continuationToken, ingestionComplete }),
  };
}

function hasBudget(budget: RequestBudget) {
  return budget.used < budget.limit;
}

function hasDetailPageBudget(budget: RequestBudget) {
  return budget.limit - budget.used >= BACKFILL_DETAIL_PAGE_REQUEST_FLOOR;
}

function hasBudgetForSingleSource(
  budget: RequestBudget,
  entity: Extract<IngestionEntity, "employees" | "timesheets" | "jobs_from_timesheets" | "schedules">,
) {
  return entity === "employees" || entity === "schedules"
    ? hasDetailPageBudget(budget)
    : hasBudget(budget);
}

function numberValue(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function nullablePositiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function recordValue(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled backfill source family: ${value}`);
}

import assert from "node:assert/strict";
import test from "node:test";
import type { RequestBudget } from "../../src/lib/simpro/client";
import type { SimproEndpoints } from "../../src/lib/simpro/endpoints";
import { ingestEntityPage, type IngestionEntity, type IngestionResult } from "../../src/lib/simpro/ingest";
import { ingestBackfillSlice } from "../../src/lib/backfill/orchestration";
import type { BackfillWorkUnit } from "../../src/lib/store/backfill-ledger";

test("quote backfill traverses DateApproved and DateIssued daily targets", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const budget = { limit: 100, used: 0 };
  const result = await ingestBackfillSlice({
    workUnit: workUnit("quotes"),
    endpoints: {} as SimproEndpoints,
    requestBudget: budget,
    ingestionRunId: 1,
    ingestEntity: ingestionStub(calls),
  });

  assert.equal(result.ingestionComplete, true);
  assert.equal(result.requestsUsed, 62);
  assert.deepEqual(calls[0]?.params, { DateApproved: "2023-01-01", orderby: "ID" });
  assert.deepEqual(calls[30]?.params, { DateApproved: "2023-01-31", orderby: "ID" });
  assert.deepEqual(calls[31]?.params, { DateIssued: "2023-01-01", orderby: "ID" });
  assert.deepEqual(calls[61]?.params, { DateIssued: "2023-01-31", orderby: "ID" });
});

test("dated continuation resumes at the next uncommitted target", async () => {
  const firstCalls: Array<Record<string, unknown>> = [];
  const first = await ingestBackfillSlice({
    workUnit: workUnit("jobs"),
    endpoints: {} as SimproEndpoints,
    requestBudget: { limit: 3, used: 0 },
    ingestionRunId: 1,
    ingestEntity: ingestionStub(firstCalls),
  });
  assert.equal(first.ingestionComplete, false);
  assert.equal(first.continuationToken?.targetIndex, 3);
  assert.deepEqual(firstCalls.map((call) => call.params), [
    { CompletedDate: "2023-01-01", orderby: "ID" },
    { CompletedDate: "2023-01-02", orderby: "ID" },
    { CompletedDate: "2023-01-03", orderby: "ID" },
  ]);

  const resumedCalls: Array<Record<string, unknown>> = [];
  const resumed = await ingestBackfillSlice({
    workUnit: { ...workUnit("jobs"), continuation_token: first.continuationToken },
    endpoints: {} as SimproEndpoints,
    requestBudget: { limit: 1, used: 0 },
    ingestionRunId: 2,
    ingestEntity: ingestionStub(resumedCalls),
  });
  assert.equal(resumed.ingestionComplete, false);
  assert.deepEqual(resumedCalls[0]?.params, { CompletedDate: "2023-01-04", orderby: "ID" });
  assert.equal(resumed.continuationToken?.targetIndex, 4);
});

test("page continuation restarts the same daily target idempotently", async () => {
  const first = await ingestBackfillSlice({
    workUnit: workUnit("jobs"),
    endpoints: {} as SimproEndpoints,
    requestBudget: { limit: 1, used: 0 },
    ingestionRunId: 1,
    ingestEntity: async (params) => {
      params.requestBudget.used += 1;
      return { ...resultFor(params.entity, params.requestBudget), continuationToken: { page: 2 } };
    },
  });
  assert.equal(first.continuationToken?.targetIndex, 0);
  assert.deepEqual(first.continuationToken?.sourceContinuation, { page: 2 });

  const resumedPages: number[] = [];
  const resumed = await ingestBackfillSlice({
    workUnit: { ...workUnit("jobs"), continuation_token: first.continuationToken },
    endpoints: {} as SimproEndpoints,
    requestBudget: { limit: 1, used: 0 },
    ingestionRunId: 2,
    ingestEntity: async (params) => {
      resumedPages.push(params.page ?? 1);
      params.requestBudget.used += 1;
      return resultFor(params.entity, params.requestBudget);
    },
  });
  assert.deepEqual(resumedPages, [2]);
  assert.equal(resumed.continuationToken?.targetIndex, 1);
});

test("nested continuation advances only after each parent traversal completes", async () => {
  const parents: number[] = [];
  const result = await ingestBackfillSlice({
    workUnit: workUnit("quote_nested"),
    endpoints: {} as SimproEndpoints,
    requestBudget: { limit: 5, used: 0 },
    ingestionRunId: 3,
    nextParentId: async ({ afterId }) => afterId === 0 ? 10 : afterId === 10 ? 20 : null,
    ingestEntity: async (params) => {
      params.requestBudget.used += 1;
      parents.push(Number(params.params?.entityId));
      return resultFor(params.entity, params.requestBudget);
    },
  });

  assert.equal(result.ingestionComplete, true);
  assert.deepEqual(parents, [10, 20]);
  assert.equal(result.requestsUsed, 2);
});

test("single-page employee backfill fetches every discovered employee detail", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await ingestBackfillSlice({
    workUnit: workUnit("employees"),
    endpoints: {} as SimproEndpoints,
    requestBudget: { limit: 21, used: 0 },
    ingestionRunId: 4,
    ingestEntity: async (params) => {
      params.requestBudget.used += 1;
      calls.push({ entity: params.entity, params: params.params });
      return {
        ...resultFor(params.entity, params.requestBudget),
        candidateRefreshes: params.params?.entityId
          ? undefined
          : [
              { entity: "employees", entityId: 41, sourceHash: "employee-41" },
              { entity: "employees", entityId: 42, sourceHash: "employee-42" },
            ],
      };
    },
  });

  assert.equal(result.ingestionComplete, true);
  assert.equal(result.requestsUsed, 3);
  assert.deepEqual(calls.map((call) => call.params), [
    { orderby: "ID" },
    { orderby: "ID", entityId: 41 },
    { orderby: "ID", entityId: 42 },
  ]);
});

function ingestionStub(calls: Array<Record<string, unknown>>) {
  return async (params: Parameters<typeof ingestEntityPage>[0]) => {
    params.requestBudget.used += 1;
    calls.push({ entity: params.entity, params: params.params });
    return resultFor(params.entity, params.requestBudget);
  };
}

function resultFor(entity: IngestionEntity, budget: RequestBudget): IngestionResult {
  return {
    entity,
    snapshotsWritten: 1,
    normalizedWritten: 1,
    affectedPeriods: [],
    continuationToken: null,
    requestsUsed: budget.used,
  };
}

function workUnit(sourceFamily: BackfillWorkUnit["source_family"]): BackfillWorkUnit {
  return {
    id: 1,
    source_family: sourceFamily,
    month_start: "2023-01-01",
    month_end_exclusive: "2023-02-01",
    execution_mode: sourceFamily === "mobile_status" ? "coverage_only" : "ingest",
    required_for_completion: sourceFamily !== "mobile_status",
    depends_on: [],
    work_phase: "ingest",
    status: "running",
    expected_pages: 1,
    expected_records: 1,
    estimated_nested_requests: 1,
    estimated_requests: 3,
    daily_request_ceiling: 10_000,
    queue_priority: 200,
    request_slice_limit: 250,
    actual_requests: 0,
    snapshot_count: 0,
    normalized_count: 0,
    continuation_token: null,
    retry_count: 0,
    max_attempts: 5,
    reserved_capacity_date: "2026-07-09",
    reserved_requests: 250,
    claim_phase: "ingest",
  };
}

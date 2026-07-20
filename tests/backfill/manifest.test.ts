import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthoritativeTraversalRecorder,
  authoritativeFilterContract,
} from "../../src/lib/backfill/manifest";
import { SimproError } from "../../src/lib/simpro/client";
import type { SimproEndpoints } from "../../src/lib/simpro/endpoints";
import type { BackfillWorkUnit } from "../../src/lib/store/backfill-ledger";

test("empty source traversal carries terminal page proof instead of relying on local zero equality", async () => {
  const endpoints = {
    listEmployees: async () => ({
      rows: [], page: 1, pageSize: 20, hasMore: false, continuationToken: null,
    }),
  } as unknown as SimproEndpoints;
  const recorder = new AuthoritativeTraversalRecorder(workUnit("employees"), endpoints, new Date("2026-07-09T19:00:00.000Z"));
  const target = recorder.contract.targets[0];

  recorder.beginTarget(target);
  await recorder.endpoints.listEmployees({ page: 1, pageSize: 20, query: target.query, budget: { limit: 21, used: 0 } });
  recorder.completeInvocation(null);
  recorder.completeTarget(target.key);
  const evidence = recorder.finish({ continuation: null, ingestionComplete: true });

  assert.equal(evidence.valid, true);
  assert.equal(evidence.pages.length, 1);
  assert.equal(evidence.pages[0]?.terminal, true);
  assert.equal(evidence.pages[0]?.rowCount, 0);
  assert.equal(evidence.emptyProof?.authoritative, true);
  assert.deepEqual(evidence.sourceIds, []);
});

test("accepted-but-ignored date filters invalidate authoritative proof", async () => {
  const endpoints = {
    listQuotes: async () => ({
      rows: [{ ID: 42 }], page: 1, pageSize: 20, hasMore: false, continuationToken: null,
    }),
    getQuote: async () => ({ ID: 42, DateApproved: "2023-02-01", DateIssued: "2023-01-01" }),
  } as unknown as SimproEndpoints;
  const recorder = new AuthoritativeTraversalRecorder(workUnit("quotes"), endpoints, new Date("2026-07-09T19:00:00.000Z"));
  const target = recorder.contract.targets[0];

  recorder.beginTarget(target);
  await recorder.endpoints.listQuotes({ page: 1, pageSize: 20, query: target.query, budget: { limit: 21, used: 0 } });
  await recorder.endpoints.getQuote(42, { limit: 21, used: 0 });
  recorder.completeInvocation(null);
  recorder.completeTarget(target.key);
  const evidence = recorder.finish({ continuation: null, ingestionComplete: false });

  assert.equal(evidence.valid, false);
  assert.match(evidence.violations.join("\n"), /filter was ignored or the boundary moved/);
});

test("terminal list pages with missing detail IDs are detected as interrupted", async () => {
  const endpoints = {
    listQuotes: async () => ({
      rows: [{ ID: 42 }], page: 1, pageSize: 20, hasMore: false, continuationToken: null,
    }),
  } as unknown as SimproEndpoints;
  const recorder = new AuthoritativeTraversalRecorder(workUnit("quotes"), endpoints, new Date("2026-07-09T19:00:00.000Z"));
  const target = recorder.contract.targets[0];

  recorder.beginTarget(target);
  await recorder.endpoints.listQuotes({ page: 1, pageSize: 20, query: target.query, budget: { limit: 21, used: 0 } });
  recorder.completeInvocation(null);
  const evidence = recorder.finish({ continuation: null, ingestionComplete: false });

  assert.equal(evidence.valid, false);
  assert.match(evidence.violations.join("\n"), /final-page traversal was interrupted/);
  assert.deepEqual(evidence.listedSourceIds, ["42"]);
  assert.deepEqual(evidence.detailedSourceIds, []);
});

test("a listed entity with an authoritative detail 404 is terminal deletion evidence", async () => {
  const endpoints = {
    listEmployees: async () => ({
      rows: [{ ID: 42 }], page: 1, pageSize: 20, hasMore: false, continuationToken: null,
    }),
    getEmployee: async () => {
      throw new SimproError("Employee not found", { status: 404, retryable: false });
    },
  } as unknown as SimproEndpoints;
  const recorder = new AuthoritativeTraversalRecorder(workUnit("employees"), endpoints, new Date("2026-07-09T19:00:00.000Z"));
  const target = recorder.contract.targets[0];

  recorder.beginTarget(target);
  await recorder.endpoints.listEmployees({ page: 1, pageSize: 20, query: target.query, budget: { limit: 21, used: 0 } });
  await assert.rejects(() => recorder.endpoints.getEmployee(42, { limit: 21, used: 0 }), /not found/);
  recorder.completeInvocation(null);
  recorder.completeTarget(target.key);
  const evidence = recorder.finish({ continuation: null, ingestionComplete: true });

  assert.equal(evidence.valid, true);
  assert.deepEqual(evidence.sourceIds, []);
  assert.deepEqual(evidence.listedSourceIds, ["42"]);
  assert.deepEqual(evidence.detailedSourceIds, []);
  assert.equal(evidence.exclusions[0]?.reason, "source_detail_not_found_after_list_discovery");
});

test("authoritative list proof rejects a continuation dropped by ingestion", async () => {
  const endpoints = {
    listEmployees: async () => ({
      rows: [], page: 1, pageSize: 20, hasMore: true, continuationToken: { page: 2 },
    }),
  } as unknown as SimproEndpoints;
  const recorder = new AuthoritativeTraversalRecorder(workUnit("employees"), endpoints, new Date("2026-07-09T19:00:00.000Z"));
  const target = recorder.contract.targets[0];

  recorder.beginTarget(target);
  await recorder.endpoints.listEmployees({ page: 1, pageSize: 20, query: target.query, budget: { limit: 21, used: 0 } });
  recorder.completeInvocation(null);
  const evidence = recorder.finish({ continuation: null, ingestionComplete: false });

  assert.equal(evidence.valid, false);
  assert.match(evidence.violations.join("\n"), /dropped its continuation token/);
});

test("current Pacific quote month stops at the observed boundary and requires full open discovery", () => {
  const contract = authoritativeFilterContract(
    { ...workUnit("quotes"), month_start: "2026-07-01", month_end_exclusive: "2026-08-01" },
    new Date("2026-07-09T19:00:00.000Z"),
  );

  assert.equal(contract.provisional, true);
  assert.equal(contract.effectiveEndInclusive, "2026-07-09");
  assert.equal(contract.openQuoteDiscoveryRequired, true);
  assert.equal(contract.targets.length, 19);
  assert.equal(contract.targets.at(-1)?.key, "quotes:open-discovery");
  assert.deepEqual(contract.targets.at(-1)?.query, { orderby: "ID" });
});

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
    manifest_generation: 1,
    manifest_as_of_watermark: null,
    manifest_status: null,
  };
}

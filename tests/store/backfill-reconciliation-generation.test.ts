import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBackfillSourcePeriodProjection,
  type AuthoritativeBackfillManifest,
} from "../../src/lib/store/backfill-reconciliation";
import type {
  BackfillReconciliationEvidence,
  BackfillWorkUnit,
} from "../../src/lib/store/backfill-ledger";

test("backfill source-period evidence propagates the authoritative traversal generation", () => {
  const projection = buildBackfillSourcePeriodProjection(
    workUnit(7),
    traversalManifest(7),
    matchedEvidence(),
  );

  assert.equal(projection.manifestGeneration, 7);
  assert.equal(projection.reconciliationGeneration, 7);
  assert.equal(projection.coverageStatus, "complete");
  assert.equal(projection.evidence.manifestGeneration, 7);
  assert.equal(projection.evidence.reconciliationGeneration, 7);
});

test("a stale claim cannot bind current traversal rows, while the retried generation can", () => {
  assert.throws(
    () => buildBackfillSourcePeriodProjection(
      workUnit(6),
      traversalManifest(7),
      matchedEvidence(),
    ),
    /generation 6 is stale.*generation 7/,
  );

  const retried = buildBackfillSourcePeriodProjection(
    workUnit(7),
    traversalManifest(7),
    matchedEvidence(),
  );
  assert.equal(retried.manifestGeneration, 7);
  assert.equal(retried.reconciliationGeneration, 7);
});

function workUnit(manifestGeneration: number): BackfillWorkUnit {
  return {
    id: 42,
    source_family: "jobs",
    month_start: "2026-06-01",
    month_end_exclusive: "2026-07-01",
    execution_mode: "ingest",
    required_for_completion: true,
    depends_on: [],
    work_phase: "reconcile",
    status: "running",
    expected_pages: 1,
    expected_records: 1,
    estimated_nested_requests: 0,
    estimated_requests: 1,
    daily_request_ceiling: 1000,
    queue_priority: 1,
    request_slice_limit: 100,
    actual_requests: 1,
    snapshot_count: 1,
    normalized_count: 1,
    continuation_token: null,
    retry_count: 1,
    max_attempts: 5,
    reserved_capacity_date: "2026-07-01",
    reserved_requests: 0,
    claim_phase: "reconcile",
    manifest_generation: manifestGeneration,
  };
}

function traversalManifest(generation: number): AuthoritativeBackfillManifest {
  return {
    generation,
    manifest_status: "completed",
    filter_contract: { CompletedDate: "2026-06" },
    as_of_watermark: "2026-07-01T08:00:00.000Z",
    observed_boundary: { effectiveEndInclusive: "2026-06-30" },
    exact_source_ids: ["101"],
    listed_source_ids: ["101"],
    detailed_source_ids: ["101"],
    completed_target_keys: ["2026-06"],
    required_target_keys: ["2026-06"],
    continuation_token: null,
    detail_coverage_required: true,
    page_count: 1,
    record_count: 1,
    empty_proof: null,
    open_quote_discovery: { required: false, status: "not_required" },
    exclusions: [],
    violations: [],
    source_max_date: "2026-06-30",
  };
}

function matchedEvidence(): BackfillReconciliationEvidence {
  return {
    status: "matched",
    sourceRecordCount: 1,
    normalizedRecordCount: 1,
    sourceMaxDate: "2026-06-30",
    missingSourceIds: [],
    extraNormalizedIds: [],
    repairPlans: [],
    detail: { basis: "generation test" },
  };
}

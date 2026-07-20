import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sourceHash } from "../../src/lib/simpro/client";
import type { BulkBootstrapEvidenceUnit } from "../../src/lib/store/bulk-bootstrap-evidence";
import { exactSourceIdHash } from "../../src/lib/store/exact-source-identities";
import {
  compareExactProjectTotals,
  requiredValidationNumber,
  type ComparableProjectRow,
} from "../../scripts/validate-simpro-bulk";
import {
  compareExactProjectRows,
  readVerifiedProjectDeltas,
  requiredFiniteNumber,
  unverifiedPostArtifactRows,
  verifySourcePeriodEvidence,
} from "../../scripts/publish-bulk-dashboard-reconciliations";

test("validation rejects per-ID 100/200 to 90/210 corruption before monthly totals can cancel", () => {
  const source = comparableRows([100, 200]);
  const canonical = comparableRows([90, 210]);
  const snapshots = comparableRows([90, 210]);

  const mismatches = compareExactProjectTotals("jobs", source, canonical, snapshots);
  assert.deepEqual(mismatches.map((row) => row.sourceId), ["1", "2"]);
  assert.match(mismatches[0]!.diagnostic, /jobs ID 1: source=100, canonical=90, snapshot=90/);
});

test("validation includes undated open quotes in exact source/canonical/snapshot totals", () => {
  const source: ComparableProjectRow[] = [{ sourceId: "77", activityDate: null, stage: "Pending", value: 100 }];
  const canonical: ComparableProjectRow[] = [{ sourceId: "77", activityDate: null, stage: "Pending", value: 100 }];
  const snapshots: ComparableProjectRow[] = [{ sourceId: "77", activityDate: null, stage: "Pending", value: 99 }];

  assert.deepEqual(compareExactProjectTotals("quotes", source, canonical, snapshots), [{
    sourceId: "77",
    source: 100,
    canonical: 100,
    snapshot: 99,
    diagnostic: "quotes ID 77: source=100, canonical=100, snapshot=99",
  }]);
});

test("dashboard reconciliation also rejects canceling per-ID totals", () => {
  const source = projectRows([100, 200]);
  const canonical = projectRows([90, 210]);
  const snapshots = projectRows([90, 210]);

  const mismatches = compareExactProjectRows("jobs", source, canonical, snapshots);
  assert.deepEqual(mismatches.map((row) => row.id), ["1", "2"]);
  assert.equal(mismatches.reduce((sum, row) => sum + Number(row.canonical), 0), 300);
});

test("unverified post-artifact canonical rows are blockers", () => {
  const canonical = [{
    id: "91",
    periodStart: "2026-07-01",
    total: 10,
    fetchedAt: "2026-07-11T00:00:00.000Z",
  }];
  const completedAt = "2026-07-10T00:00:00.000Z";

  assert.deepEqual(unverifiedPostArtifactRows("jobs", canonical, [], completedAt), [{
    type: "jobs_unverified_post_artifact_canonical",
    id: "91",
    fetchedAt: "2026-07-11T00:00:00.000Z",
    artifactCompletedAt: completedAt,
  }]);
  assert.deepEqual(unverifiedPostArtifactRows("jobs", canonical, [{ id: "91", periodStart: null, total: 10 }], completedAt), []);
});

test("raw project deltas require canonical, snapshot, and payload identity agreement", async () => {
  const payload = projectPayload(12);
  const hash = sourceHash(payload);
  const client = deltaClient({
    id: "11",
    snapshot_entity_id: "11",
    payload,
    snapshot_source_hash: hash,
    canonical_source_hash: hash,
    extracted_at: "2026-07-11T00:00:00.000Z",
  });

  await assert.rejects(
    () => readVerifiedProjectDeltas(client, "2026-07-10T00:00:00.000Z"),
    /jobs verified raw delta identity mismatch: canonical ID=11, snapshot\.entity_id=11, payload ID=12/,
  );
});

test("raw project deltas require canonical, snapshot, and payload source-hash agreement", async () => {
  const payload = projectPayload(11);
  const client = deltaClient({
    id: "11",
    snapshot_entity_id: "11",
    payload,
    snapshot_source_hash: "b".repeat(64),
    canonical_source_hash: "a".repeat(64),
    extracted_at: "2026-07-11T00:00:00.000Z",
  });

  await assert.rejects(
    () => readVerifiedProjectDeltas(client, "2026-07-10T00:00:00.000Z"),
    /jobs verified raw delta source-hash mismatch for ID 11: canonical=a+, snapshot=b+, payload=/,
  );
});

test("source-period evidence is bound to current ID hash, total, artifact SHA, and composite manifest SHA", () => {
  const expected = evidenceUnit();
  const idHash = sha(JSON.stringify(["101", "102"]));
  const row = {
    source_family: "jobs",
    period_start: "2026-06-01",
    coverage_status: "complete",
    reconciliation_status: "matched",
    source_id_hash: idHash,
    normalized_id_hash: idHash,
    source_value: "300",
    normalized_value: 300,
    evidence_json: {
      exactSourceIdHash: idHash,
      artifactSha256: expected.artifactSha256,
      manifestSha256: expected.manifestSha256,
      checksumVerifiedFullUniverseArtifact: true,
      fabricatedApiResponse: false,
    },
  };

  assert.equal(verifySourcePeriodEvidence("jobs", "2026-06-01", "jobs", row, expected).valid, true);
  assert.equal(verifySourcePeriodEvidence("jobs", "2026-06-01", "jobs", {
    ...row,
    source_id_hash: "c".repeat(64),
  }, expected).valid, false);
  assert.equal(verifySourcePeriodEvidence("jobs", "2026-06-01", "jobs", {
    ...row,
    source_value: 299,
  }, expected).valid, false);
  assert.equal(verifySourcePeriodEvidence("jobs", "2026-06-01", "jobs", {
    ...row,
    evidence_json: { ...row.evidence_json, artifactSha256: "d".repeat(64) },
  }, expected).valid, false);
  assert.equal(verifySourcePeriodEvidence("jobs", "2026-06-01", "jobs", {
    ...row,
    evidence_json: { ...row.evidence_json, manifestSha256: "e".repeat(64) },
  }, expected).valid, false);
});

test("reconciliation accepts the publisher hash for every compound-ID permutation", () => {
  const expected = evidenceUnit();
  const ids = ["10:ts", "2:ts", "2:alpha"];
  expected.exactSourceIds = ids;
  expected.listedSourceIds = ["2:alpha", "10:ts", "2:ts"];
  expected.detailedSourceIds = ["2:ts", "2:alpha", "10:ts"];
  expected.normalizedSourceIds = ["10:ts", "2:alpha", "2:ts"];
  expected.pages = [{ ...expected.pages[0]!, rowCount: 3, exactIds: ["2:ts", "10:ts", "2:alpha"] }];
  expected.sourceValue = 0;
  expected.normalizedValue = 0;
  const hash = exactSourceIdHash(ids);
  const row = {
    source_family: "jobs",
    period_start: "2026-06-01",
    coverage_status: "complete",
    reconciliation_status: "matched",
    source_id_hash: hash,
    normalized_id_hash: hash,
    source_value: 0,
    normalized_value: 0,
    evidence_json: {
      exactSourceIdHash: hash,
      artifactSha256: expected.artifactSha256,
      manifestSha256: expected.manifestSha256,
      checksumVerifiedFullUniverseArtifact: true,
      fabricatedApiResponse: false,
    },
  };

  assert.equal(verifySourcePeriodEvidence("jobs", "2026-06-01", "jobs", row, expected).valid, true);
  assert.equal(hash, exactSourceIdHash(["2:alpha", "2:ts", "10:ts"]));
});

test("required finite parsers reject null, blank, boolean, absent, and nonnumeric values but preserve zero", () => {
  for (const parser of [requiredValidationNumber, requiredFiniteNumber]) {
    assert.equal(parser(0, "jobs", "2026-06-01", "total"), 0);
    assert.equal(parser("0", "jobs", "2026-06-01", "total"), 0);
    for (const [value, reason] of [
      [null, "null"],
      [" ", "blank"],
      [true, "boolean"],
      [undefined, "absent"],
      ["not-money", "nonnumeric"],
    ] as const) {
      assert.throws(
        () => parser(value, "jobs", "2026-06-01", "total"),
        new RegExp(`jobs/2026-06-01/total is ${reason}`),
      );
    }
  }
});

function comparableRows(values: number[]): ComparableProjectRow[] {
  return values.map((value, index) => ({
    sourceId: String(index + 1),
    activityDate: "2026-06-15",
    stage: "Complete",
    value,
  }));
}

function projectRows(values: number[]) {
  return values.map((total, index) => ({ id: String(index + 1), periodStart: "2026-06-01", total }));
}

function projectPayload(id: number) {
  return {
    ID: id,
    CompletedDate: "2026-07-10",
    Stage: "Complete",
    Total: { ExTax: 10, IncTax: 10, Tax: 0 },
    Totals: {},
    Sections: [],
  };
}

function deltaClient(row: Record<string, unknown>) {
  return {
    async query<T = Record<string, unknown>>(_text: string, values?: unknown[]) {
      return {
        rows: (values?.[0] === "job_details" ? [row] : []) as T[],
        rowCount: 0,
      };
    },
  };
}

function evidenceUnit(): BulkBootstrapEvidenceUnit {
  return {
    sourceFamily: "jobs",
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    exactSourceIds: [102, 101],
    listedSourceIds: [102, 101],
    detailedSourceIds: [102, 101],
    normalizedSourceIds: [102, 101],
    sourceValue: 300,
    normalizedValue: 300,
    pages: [{
      targetKey: "jobs:2026-06-01:full-universe",
      sourceMethod: "listJobs",
      requestIdentity: "jobs:2026-06-01",
      requestSha256: "c".repeat(64),
      pageIdentity: "jobs:2026-06-01:1",
      pageSha256: "d".repeat(64),
      pageNumber: 1,
      pageSize: 250,
      rowCount: 2,
      exactIds: [101, 102],
      requestQuery: {},
      terminal: true,
    }],
    artifactSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    evidenceAsOf: "2026-07-01T08:00:00.000Z",
    currentMonth: false,
    detailCoverageRequired: true,
  };
}

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

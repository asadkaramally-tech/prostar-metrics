import { createHash } from "node:crypto";
import { queryPostgres, type PostgresQuery } from "@/lib/store/postgres";

export type SourcePeriodManifestEvidence = {
  sourceFamily: string;
  periodStart: string;
  periodEnd: string;
  coverageStatus: "complete" | "partial" | "suspect";
  reconciliationStatus: "pending" | "matched" | "mismatch" | "unavailable";
  listedCount: number;
  detailCount: number;
  normalizedCount: number;
  sourceIdHash: string;
  normalizedIdHash: string;
  continuationToken: Record<string, unknown> | null;
  manifestGeneration: number;
  reconciliationGeneration: number | null;
  expectedPageCount: number;
  completedPageCount: number;
  evidenceAsOf: string;
  reconciledAt: string | null;
  evidence: Record<string, unknown>;
};

export type SourcePeriodManifest = SourcePeriodManifestEvidence & {
  sourceValue: number | null;
  normalizedValue: number | null;
};

export function buildSourcePeriodManifestEvidence(params: {
  sourceFamily: string;
  periodStart: string;
  periodEnd: string;
  listedIds: Array<string | number>;
  detailIds: Array<string | number>;
  normalizedIds: Array<string | number>;
  continuationToken?: Record<string, unknown> | null;
  authoritativeListComplete: boolean;
  listRequestCount: number;
  manifestGeneration?: number;
  reconciliationGeneration?: number | null;
  expectedPageCount?: number;
  completedPageCount?: number;
  reconciliationStatus: SourcePeriodManifestEvidence["reconciliationStatus"];
  evidenceAsOf: Date | string;
  reconciledAt?: Date | string | null;
  sourceValue?: number | null;
  normalizedValue?: number | null;
  evidence?: Record<string, unknown>;
}): SourcePeriodManifest {
  assertCanonicalMonth(params.periodStart, params.periodEnd);
  const listed = normalizedIds(params.listedIds);
  const detailed = normalizedIds(params.detailIds);
  const normalized = normalizedIds(params.normalizedIds);
  const sourceIdHash = hashIds(listed);
  const detailIdHash = hashIds(detailed);
  const normalizedIdHash = hashIds(normalized);
  const listRequestCount = nonNegativeInteger(params.listRequestCount);
  const manifestGeneration = positiveInteger(params.manifestGeneration ?? 1);
  const reconciliationGeneration = params.reconciliationStatus === "matched"
    ? positiveInteger(params.reconciliationGeneration ?? manifestGeneration)
    : nullablePositiveInteger(params.reconciliationGeneration);
  const completedPageCount = nonNegativeInteger(
    params.completedPageCount ?? listRequestCount,
  );
  const expectedPageCount = nonNegativeInteger(
    params.expectedPageCount ?? (listRequestCount + (params.continuationToken ? 1 : 0)),
  );
  const pageTraversalComplete = expectedPageCount > 0 && completedPageCount === expectedPageCount;
  const traversalProven = params.authoritativeListComplete
    && listRequestCount > 0
    && !params.continuationToken
    && pageTraversalComplete;
  const detailComplete = listed.length === detailed.length && sourceIdHash === detailIdHash;
  const normalizationComplete = detailed.length === normalized.length && detailIdHash === normalizedIdHash;
  const matched = params.reconciliationStatus === "matched";
  const generationMatched = matched && reconciliationGeneration === manifestGeneration;
  const mismatch = params.reconciliationStatus === "mismatch" || (
    traversalProven && (!detailComplete || !normalizationComplete)
  );
  const coverageStatus = traversalProven && detailComplete && normalizationComplete && generationMatched
    ? "complete"
    : mismatch
      ? "suspect"
      : "partial";
  const evidenceAsOf = new Date(params.evidenceAsOf);
  if (Number.isNaN(evidenceAsOf.getTime())) throw new Error("A valid evidenceAsOf timestamp is required.");
  const reconciledAt = params.reconciliationStatus === "matched"
    ? validTimestamp(params.reconciledAt ?? params.evidenceAsOf, "reconciledAt")
    : null;

  return {
    sourceFamily: params.sourceFamily,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    coverageStatus,
    reconciliationStatus: params.reconciliationStatus,
    listedCount: listed.length,
    detailCount: detailed.length,
    normalizedCount: normalized.length,
    sourceIdHash,
    normalizedIdHash,
    sourceValue: finiteMoney(params.sourceValue),
    normalizedValue: finiteMoney(params.normalizedValue),
    continuationToken: params.continuationToken ?? null,
    manifestGeneration,
    reconciliationGeneration,
    expectedPageCount,
    completedPageCount,
    evidenceAsOf: evidenceAsOf.toISOString(),
    reconciledAt,
    evidence: {
      ...(params.evidence ?? {}),
      authoritativeSource: "simpro_api",
      authoritativeListComplete: params.authoritativeListComplete,
      listRequestCount,
      expectedPageCount,
      completedPageCount,
      manifestGeneration,
      reconciliationGeneration,
      detailIdHash,
      missingDetailIds: difference(listed, detailed),
      missingNormalizedIds: difference(detailed, normalized),
    },
  };
}

export async function upsertSourcePeriodManifest(
  manifest: ReturnType<typeof buildSourcePeriodManifestEvidence>,
  query: PostgresQuery = queryPostgres,
): Promise<{ rowCount: number }> {
  // The conditional DO UPDATE guard silently affects zero rows when a newer
  // manifest generation already owns the period. Callers publishing under a
  // claimed generation must observe the row count and abort when it is zero.
  const result = await query(
    `insert into metrics.source_period_manifests (
       source_family, period_start, period_end, coverage_status, reconciliation_status,
       listed_count, detail_count, normalized_count, source_id_hash, normalized_id_hash,
       source_value, normalized_value, continuation_token, evidence_as_of, completed_at,
       evidence_json, manifest_generation, reconciliation_generation,
       expected_page_count, completed_page_count, reconciled_at
     )
     values (
       $1, $2::date, $3::date, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13::jsonb, $14::timestamptz,
       case when $4 = 'complete' then now() else null end, $15::jsonb,
       $16, $17, $18, $19, $20::timestamptz
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
     where excluded.manifest_generation > coalesce(metrics.source_period_manifests.manifest_generation, 0)
        or (
          excluded.manifest_generation = metrics.source_period_manifests.manifest_generation
          and excluded.evidence_as_of >= metrics.source_period_manifests.evidence_as_of
        )
     returning source_family`,
    [
      manifest.sourceFamily,
      manifest.periodStart,
      manifest.periodEnd,
      manifest.coverageStatus,
      manifest.reconciliationStatus,
      manifest.listedCount,
      manifest.detailCount,
      manifest.normalizedCount,
      manifest.sourceIdHash,
      manifest.normalizedIdHash,
      manifest.sourceValue,
      manifest.normalizedValue,
      manifest.continuationToken ? JSON.stringify(manifest.continuationToken) : null,
      manifest.evidenceAsOf,
      JSON.stringify(manifest.evidence),
      manifest.manifestGeneration,
      manifest.reconciliationGeneration,
      manifest.expectedPageCount,
      manifest.completedPageCount,
      manifest.reconciledAt,
    ],
  );
  return { rowCount: result.rows.length };
}

function normalizedIds(values: Array<string | number>) {
  return [...new Set(values.map(String).filter((value) => /^\d+$/.test(value)))]
    .sort((a, b) => Number(a) - Number(b));
}

function hashIds(ids: string[]) {
  return createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}

function difference(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value)).slice(0, 500);
}

function finiteMoney(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function positiveInteger(value: number) {
  if (!Number.isInteger(value) || value <= 0) throw new Error("Manifest generation and page counts must be positive integers.");
  return value;
}

function nullablePositiveInteger(value: number | null | undefined) {
  return value === null || value === undefined ? null : positiveInteger(value);
}

function nonNegativeInteger(value: number) {
  if (!Number.isInteger(value) || value < 0) throw new Error("Manifest page counts must be non-negative integers.");
  return value;
}

function validTimestamp(value: Date | string, label: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`A valid ${label} timestamp is required.`);
  return parsed.toISOString();
}

function assertCanonicalMonth(start: string, end: string) {
  if (!/^\d{4}-\d{2}-01$/.test(start)) throw new Error(`Invalid period start: ${start}`);
  const expectedEnd = new Date(`${start}T00:00:00.000Z`);
  expectedEnd.setUTCMonth(expectedEnd.getUTCMonth() + 1);
  expectedEnd.setUTCDate(0);
  if (end !== expectedEnd.toISOString().slice(0, 10)) {
    throw new Error(`Period end ${end} does not match month ${start}.`);
  }
}

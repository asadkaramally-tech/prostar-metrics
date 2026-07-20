import {
  resolveJobConvertedFromQuoteId,
  resolveQuoteDirectLinkedJobId,
} from "@/lib/simpro/relationship-provenance";
import type { PostgresQuery } from "@/lib/store/postgres";

export type AuthoritativeQuoteDirectRelationship = {
  quoteId: number;
  sourceSnapshotId: number | null;
  linkedJobId: number | null;
  conversionJobId: number | null;
};

export type AuthoritativeJobInverseRelationship = {
  jobId: number;
  sourceSnapshotId: number | null;
  sourceQuoteId: number | null;
  canonicalConvertedFromQuoteId: number | null;
  canonicalJobSourceQuoteId: number | null;
  snapshotSourceQuoteId: number | null;
  snapshotExists: boolean;
  canonicalNeedsProjection: boolean;
  snapshotNeedsProjection: boolean;
  needsProjection: boolean;
  affectedQuoteIds: number[];
};

export type AuthoritativeQuoteRelationships = {
  quotes: AuthoritativeQuoteDirectRelationship[];
  jobs: AuthoritativeJobInverseRelationship[];
};

type RawQuoteRelationshipRow = {
  quote_id: string;
  source_snapshot_id: string | null;
  payload: unknown;
};

type RawJobRelationshipRow = {
  job_id: string;
  converted_from_type: string | null;
  converted_from_id: string | null;
  job_source_type: string | null;
  job_source_id: string | null;
  snapshot_job_id: string | null;
  snapshot_source_quote_id: string | null;
  source_snapshot_id: string | null;
  payload: unknown;
};

export async function loadAuthoritativeQuoteRelationships(
  query: PostgresQuery,
  quoteIds: readonly number[],
  options: { requireCompleteQuoteProvenance?: boolean } = {},
): Promise<AuthoritativeQuoteRelationships> {
  const uniqueQuoteIds = uniquePositiveIds(quoteIds, "quoteIds");
  if (uniqueQuoteIds.length === 0) return { quotes: [], jobs: [] };

  const quoteRows = await readLatestQuoteProvenance(query, uniqueQuoteIds);
  const missingQuotes: number[] = [];
  const quoteRowsById = new Map(quoteRows.map((row) => [Number(row.quote_id), row]));
  const quoteDrafts: Array<AuthoritativeQuoteDirectRelationship & { linkedJobId: number | null }> = [];
  const directLinkedJobIds: number[] = [];

  for (const quoteId of uniqueQuoteIds) {
    const row = quoteRowsById.get(quoteId);
    const payload = row?.payload;
    const sourceSnapshotId = optionalPositiveId(row?.source_snapshot_id);
    if (payload === undefined || sourceSnapshotId === null) {
      missingQuotes.push(quoteId);
      if (options.requireCompleteQuoteProvenance === false) {
        quoteDrafts.push({
          quoteId,
          sourceSnapshotId: null,
          linkedJobId: null,
          conversionJobId: null,
        });
      }
      continue;
    }
    let linkedJobId: number | null;
    try {
      linkedJobId = resolveQuoteDirectLinkedJobId(payload);
    } catch (error) {
      throw relationshipError(`quote ${quoteId}`, error);
    }
    if (linkedJobId !== null) directLinkedJobIds.push(linkedJobId);
    quoteDrafts.push({
      quoteId,
      sourceSnapshotId,
      linkedJobId,
      conversionJobId: null,
    });
  }

  if (missingQuotes.length > 0 && options.requireCompleteQuoteProvenance !== false) {
    throw new Error(
      `Active served quotes lack authoritative latest complete live raw quote provenance (missing: ${missingQuotes.join(", ")}).`,
    );
  }

  const jobRows = await readLatestJobProvenance(query, uniqueQuoteIds, uniquePositiveIds(directLinkedJobIds, "direct linked job IDs"));
  const jobs = jobRows.map(mapJobRelationship);
  const liveJobIds = new Set(jobs.map((job) => job.jobId));
  const quotes = quoteDrafts.map((quote) => ({
    ...quote,
    conversionJobId: quote.linkedJobId !== null && liveJobIds.has(quote.linkedJobId) ? quote.linkedJobId : null,
  }));

  return { quotes, jobs };
}

function mapJobRelationship(
  row: RawJobRelationshipRow,
): AuthoritativeJobInverseRelationship {
  const jobId = requiredPositiveId(row.job_id, "job ID");
  const sourceSnapshotId = optionalPositiveId(row.source_snapshot_id);
  let sourceQuoteId: number | null = null;
  const payload = sourceSnapshotId === null ? undefined : row.payload;
  if (payload !== undefined) {
    try {
      sourceQuoteId = resolveJobConvertedFromQuoteId(payload);
    } catch (error) {
      throw relationshipError(`job ${jobId}`, error);
    }
  }

  const canonicalConvertedFromClaimsQuote = normalizedType(row.converted_from_type) === "quote";
  const canonicalJobSourceClaimsQuote = normalizedType(row.job_source_type) === "quote";
  const canonicalConvertedFromQuoteId = canonicalConvertedFromClaimsQuote
    ? optionalPositiveId(row.converted_from_id)
    : null;
  const canonicalJobSourceQuoteId = canonicalJobSourceClaimsQuote
    ? optionalPositiveId(row.job_source_id)
    : null;
  const snapshotSourceQuoteId = optionalPositiveId(row.snapshot_source_quote_id);
  const canonicalMatches = sourceQuoteId === null
    ? !canonicalConvertedFromClaimsQuote && !canonicalJobSourceClaimsQuote
    : row.converted_from_type === "Quote"
      && row.job_source_type === "Quote"
      && canonicalConvertedFromQuoteId === sourceQuoteId
      && canonicalJobSourceQuoteId === sourceQuoteId;
  const snapshotExists = row.snapshot_job_id !== null;
  const snapshotMatches = snapshotSourceQuoteId === sourceQuoteId;
  const affectedQuoteIds = [...new Set([
    sourceQuoteId,
    canonicalConvertedFromQuoteId,
    canonicalJobSourceQuoteId,
    snapshotSourceQuoteId,
  ].filter((value): value is number => value !== null))].sort(numericSort);

  return {
    jobId,
    sourceSnapshotId,
    sourceQuoteId,
    canonicalConvertedFromQuoteId,
    canonicalJobSourceQuoteId,
    snapshotSourceQuoteId,
    snapshotExists,
    canonicalNeedsProjection: !canonicalMatches,
    snapshotNeedsProjection: !snapshotMatches,
    needsProjection: !canonicalMatches || !snapshotMatches,
    affectedQuoteIds,
  };
}

async function readLatestQuoteProvenance(
  query: PostgresQuery,
  quoteIds: number[],
): Promise<RawQuoteRelationshipRow[]> {
  const result = await query<RawQuoteRelationshipRow>(
    `select q.quote_id::text,
            authoritative.id::text as source_snapshot_id,
            authoritative.payload
       from metrics.metrics_quotes q
       left join lateral (
         select raw.id, raw.payload
           from metrics.raw_simpro_snapshots raw
          where raw.entity_type in ('quote_details', 'quotes')
            and raw.entity_id = q.quote_id::text
            and raw.complete_traversal = true
            and raw.source_deleted_at is null
          order by raw.extracted_at desc, raw.id desc
          limit 1
       ) authoritative on true
      where q.quote_id = any($1::bigint[])
        and q.source_deleted_at is null
      order by q.quote_id`,
    [quoteIds],
  );
  return result.rows;
}

async function readLatestJobProvenance(
  query: PostgresQuery,
  quoteIds: number[],
  directLinkedJobIds: number[],
): Promise<RawJobRelationshipRow[]> {
  const result = await query<RawJobRelationshipRow>(
    `with latest_raw as materialized (
       select distinct on (raw.entity_id)
              job.job_id,
              raw.id,
              raw.payload
         from metrics.raw_simpro_snapshots raw
         join metrics.metrics_jobs job on job.job_id::text = raw.entity_id
        where raw.entity_type in ('job_details', 'jobs')
          and raw.complete_traversal = true
          and raw.source_deleted_at is null
          and job.source_deleted_at is null
        order by raw.entity_id, raw.extracted_at desc, raw.id desc
     ), candidate_jobs as materialized (
       select j.job_id
         from metrics.metrics_jobs j
        where j.source_deleted_at is null
          and j.job_id = any($2::bigint[])
       union
       select j.job_id
         from metrics.metrics_jobs j
        where j.source_deleted_at is null
          and lower(trim(coalesce(j.converted_from_type, ''))) = 'quote'
          and j.converted_from_id = any($1::bigint[])
       union
       select j.job_id
         from metrics.metrics_jobs j
        where j.source_deleted_at is null
          and lower(trim(coalesce(j.job_source_type, ''))) = 'quote'
          and j.job_source_id = any($1::bigint[])
       union
       select snapshot.job_id
         from metrics.job_snapshots snapshot
         join metrics.metrics_jobs job using (job_id)
        where job.source_deleted_at is null
          and snapshot.source_quote_id = any($1::bigint[])
       union
       select latest_raw.job_id
         from latest_raw
        where metrics.authoritative_job_source_quote_id(latest_raw.payload) = any($1::bigint[])
     )
     select j.job_id::text, j.converted_from_type, j.converted_from_id::text,
            j.job_source_type, j.job_source_id::text,
            snapshot.job_id::text as snapshot_job_id,
            snapshot.source_quote_id::text as snapshot_source_quote_id,
            authoritative.id::text as source_snapshot_id,
            authoritative.payload
       from candidate_jobs candidate
       join metrics.metrics_jobs j using (job_id)
       left join metrics.job_snapshots snapshot on snapshot.job_id = j.job_id
       left join latest_raw authoritative on authoritative.job_id = j.job_id
      order by j.job_id`,
    [quoteIds, directLinkedJobIds],
  );
  return result.rows;
}

function uniquePositiveIds(values: readonly number[], context: string): number[] {
  const unique = [...new Set(values)].sort(numericSort);
  if (unique.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${context} must contain only positive safe integers.`);
  }
  return unique;
}

function requiredPositiveId(value: string | number, context: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${context} is invalid.`);
  return id;
}

function optionalPositiveId(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function relationshipError(context: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : "Malformed relationship provenance.";
  return new Error(`Authoritative relationship provenance for ${context} is invalid: ${detail}`);
}

function normalizedType(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function numericSort(left: number, right: number): number {
  return left - right;
}

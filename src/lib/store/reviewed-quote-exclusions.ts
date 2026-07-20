import { queryPostgres, type PostgresQuery } from "@/lib/store/postgres";

export async function applyReviewedQuoteExclusionSeeds(
  quoteIds: readonly number[],
  query: PostgresQuery = queryPostgres,
): Promise<number> {
  const uniqueQuoteIds = [...new Set(quoteIds)];
  if (uniqueQuoteIds.length === 0) return 0;
  if (uniqueQuoteIds.some((quoteId) => !Number.isSafeInteger(quoteId) || quoteId <= 0)) {
    throw new Error("Reviewed quote exclusion seed IDs must be positive integers.");
  }
  const capability = await query<{ available: boolean }>(
    `select to_regprocedure(
       'metrics.apply_reviewed_quote_exclusion_seeds(bigint[])'
     ) is not null as available`,
  );
  if (capability.rows[0]?.available !== true) return 0;
  const result = await query<{ applied_count: string | number }>(
    "select applied_count from metrics.apply_reviewed_quote_exclusion_seeds($1::bigint[])",
    [uniqueQuoteIds],
  );
  const applied = Number(result.rows[0]?.applied_count ?? 0);
  if (!Number.isSafeInteger(applied) || applied < 0 || applied > uniqueQuoteIds.length) {
    throw new Error("Reviewed quote exclusion seed application returned an invalid count.");
  }
  return applied;
}

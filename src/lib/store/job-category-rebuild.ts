import { queryPostgres, type PostgresQuery } from "@/lib/store/postgres";
import { VERIFIED_CONFIGURED_COST_CENTER_CATEGORIES } from "@/lib/store/quote-category-rebuild";

export async function reprojectImportedJobCategories(
  jobIds: readonly number[],
  query: PostgresQuery = queryPostgres,
): Promise<{ childrenUpdated: number; jobsUpdated: number }> {
  const targets = [...new Set(jobIds)];
  if (targets.length === 0) return { childrenUpdated: 0, jobsUpdated: 0 };
  if (targets.some((jobId) => !Number.isSafeInteger(jobId) || jobId <= 0)) {
    throw new Error("Imported job category IDs must be positive integers.");
  }

  const mappedCategory = mappedCategorySql("child");
  const projectedCategory = projectedCategoryExpression("locked");
  const result = await query<{ children_updated: string; jobs_updated: string }>(
    `with locked_jobs as materialized (
       select job_id
         from metrics.metrics_jobs
        where job_id = any($1::bigint[])
        order by job_id
        for update
     ), child_updated as (
       update metrics.metrics_job_cost_centers child
          set category = ${mappedCategory},
              updated_from_source_at = now()
        where child.job_id in (select job_id from locked_jobs)
          and child.source_deleted_at is null
          and child.category is distinct from ${mappedCategory}
       returning child.job_id
     ), projection as materialized (
       select locked.job_id, ${projectedCategory} as category
         from locked_jobs locked
        where (select count(*) from child_updated) >= 0
     ), canonical_updated as (
       update metrics.metrics_jobs job
          set category = projection.category,
              updated_from_source_at = now()
         from projection
        where job.job_id = projection.job_id
          and job.category is distinct from projection.category
       returning job.job_id
     )
     select (select count(*) from child_updated)::text children_updated,
            (select count(*) from canonical_updated)::text jobs_updated`,
    [targets],
  );
  return {
    childrenUpdated: Number(result.rows[0]?.children_updated ?? 0),
    jobsUpdated: Number(result.rows[0]?.jobs_updated ?? 0),
  };
}

function mappedCategorySql(alias: string) {
  const cases = Object.entries(VERIFIED_CONFIGURED_COST_CENTER_CATEGORIES)
    .map(([id, category]) => `when ${id} then '${category}'`)
    .join(" ");
  return `(case ${alias}.configured_cost_center_id ${cases} else 'Unclassified' end)`;
}

function projectedCategoryExpression(jobAlias: string) {
  const mappedCategory = mappedCategorySql("cost_center");
  return `coalesce((
    select category_totals.category
      from (
        select ${mappedCategory} as category,
               sum(coalesce(cost_center.sell_value, 0)) as sell_value
          from metrics.metrics_job_cost_centers cost_center
         where cost_center.job_id = ${jobAlias}.job_id
           and cost_center.source_deleted_at is null
         group by 1
      ) category_totals
     order by category_totals.sell_value desc, category_totals.category asc
     limit 1
  ), 'Unclassified')`;
}

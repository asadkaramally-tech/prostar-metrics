import { queryPostgres } from "@/lib/store/postgres";

export type RollupScope = "quotes" | "jobs" | "technicians" | "commissions" | "materials";

export type RollupRow = {
  period_start: string;
  period_end: string;
  metric_key: string;
  metric_value: string;
  dimensions: Record<string, unknown>;
  source_snapshot_count: number;
  provisional: boolean;
  rebuilt_at: string;
};

export async function getRollups(scope: RollupScope, limit = 24, periodStart?: string): Promise<RollupRow[]> {
  const result = await queryPostgres<RollupRow>(
    `select period_start::text, period_end::text, metric_key, metric_value::text, dimensions,
            source_snapshot_count, provisional, rebuilt_at::text
     from metrics.metric_rollups
     where scope = $1
       and ($3::date is null or period_start = $3::date)
     order by period_start desc, metric_key asc
     limit $2`,
    [scope, limit, periodStart ?? null],
  );

  return result.rows;
}

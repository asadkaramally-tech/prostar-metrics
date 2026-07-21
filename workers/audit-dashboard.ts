import { queryPostgres } from "@/lib/store/postgres";

type Args = {
  periodStart: string;
  periodEnd: string;
  includeIds: boolean;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [jobsByDay, jobIds, quotesByDay, quoteIds, ingestionJobs, rollupJobs] = await Promise.all([
    getJobsByDay(args),
    getJobIds(args),
    getQuotesByDay(args),
    getQuoteIds(args),
    getIngestionJobs(),
    getRollupJobs(args),
  ]);

  console.log(
    JSON.stringify(
      {
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
        jobs: {
          total: summarize(jobsByDay),
          byDay: jobsByDay,
          ids: args.includeIds ? jobIds : `${jobIds.length} ids omitted; set AUDIT_INCLUDE_IDS=true to print`,
        },
        quotes: {
          total: summarize(quotesByDay),
          byDay: quotesByDay,
          ids: args.includeIds ? quoteIds : `${quoteIds.length} ids omitted; set AUDIT_INCLUDE_IDS=true to print`,
        },
        queues: {
          ingestion: ingestionJobs,
          rollups: rollupJobs,
        },
      },
      null,
      2,
    ),
  );
}

async function getJobsByDay(args: Args) {
  const result = await queryPostgres<{ day: string; stage: string; count: number; total: string }>(
    `select completed_date::text as day,
            stage,
            count(*)::int as count,
            round(sum(total)::numeric, 2)::text as total
      from metrics.metrics_jobs
      where completed_date between $1::date and $2::date
        and lower(stage) in ('complete', 'archived')
        and source_deleted_at is null
      group by completed_date, stage
      order by completed_date, stage`,
    [args.periodStart, args.periodEnd],
  );
  return result.rows;
}

async function getJobIds(args: Args) {
  const result = await queryPostgres<{ job_id: string }>(
    `select job_id::text
      from metrics.metrics_jobs
      where completed_date between $1::date and $2::date
        and lower(stage) in ('complete', 'archived')
        and source_deleted_at is null
      order by job_id`,
    [args.periodStart, args.periodEnd],
  );
  return result.rows.map((row) => row.job_id);
}

async function getQuotesByDay(args: Args) {
  const result = await queryPostgres<{ day: string; count: number; total: string }>(
    `select date_issued::text as day,
            count(*)::int as count,
            round(sum(total)::numeric, 2)::text as total
       from metrics.metrics_quotes
      where date_issued between $1::date and $2::date
        and source_deleted_at is null
      group by date_issued
      order by date_issued`,
    [args.periodStart, args.periodEnd],
  );
  return result.rows;
}

async function getQuoteIds(args: Args) {
  const result = await queryPostgres<{ quote_id: string }>(
    `select quote_id::text
       from metrics.metrics_quotes
      where date_issued between $1::date and $2::date
        and source_deleted_at is null
      order by quote_id`,
    [args.periodStart, args.periodEnd],
  );
  return result.rows.map((row) => row.quote_id);
}

async function getIngestionJobs() {
  const result = await queryPostgres<{
    entity_type: string;
    status: string;
    count: number;
    last_error: string | null;
  }>(
    `select entity_type::text,
            status::text,
            count(*)::int as count,
            max(last_error) as last_error
       from metrics.ingestion_jobs
      where entity_type in ('jobs', 'quotes')
      group by entity_type, status
      order by entity_type, status`,
  );
  return result.rows;
}

async function getRollupJobs(args: Args) {
  const result = await queryPostgres<{ metric_family: string; status: string; count: number }>(
    `select metric_family::text,
            status::text,
            count(*)::int as count
       from metrics.rollup_rebuild_queue
      where period_start between $1::date and $2::date
      group by metric_family, status
      order by metric_family, status`,
    [args.periodStart, args.periodEnd],
  );
  return result.rows;
}

function summarize(rows: Array<{ count: number; total: string }>) {
  return rows.reduce(
    (summary, row) => ({
      count: summary.count + row.count,
      total: Number((summary.total + Number(row.total)).toFixed(2)),
    }),
    { count: 0, total: 0 },
  );
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    periodStart: process.env.AUDIT_PERIOD_START ?? "2026-06-01",
    periodEnd: process.env.AUDIT_PERIOD_END ?? "2026-06-30",
    includeIds: process.env.AUDIT_INCLUDE_IDS === "true",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--period-start") {
      args.periodStart = argv[index + 1];
      index += 1;
    } else if (arg === "--period-end") {
      args.periodEnd = argv[index + 1];
      index += 1;
    } else if (arg === "--include-ids") {
      args.includeIds = true;
    }
  }

  return args;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => {
  process.exit();
});

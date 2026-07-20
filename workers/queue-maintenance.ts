import { queryPostgres } from "@/lib/store/postgres";

type Args = {
  keepSuffix?: string;
  dryRun: boolean;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const staleJobs = await queryPostgres<{ id: number; entity_type: string; idempotency_key: string }>(
    `select id, entity_type::text as entity_type, idempotency_key
       from metrics.ingestion_jobs
      where entity_type = 'jobs'
        and status = 'queued'
        and ($1::text is null or idempotency_key not like ('%:' || $1::text))
      order by id`,
    [args.keepSuffix ?? null],
  );

  const staleErrors = await queryPostgres<{ id: number; entity_type: string; idempotency_key: string }>(
    `select id, entity_type::text as entity_type, idempotency_key
       from metrics.ingestion_jobs
      where status = 'succeeded'
        and entity_type in ('jobs', 'quotes')
        and last_error is not null
      order by id`,
  );

  if (!args.dryRun) {
    await queryPostgres(
      `update metrics.ingestion_jobs
          set status = 'cancelled'::metrics.ingestion_job_status,
              locked_by = null,
              locked_at = null,
              last_error = 'cancelled stale full-list continuation after June repair reconciliation',
              updated_at = now()
        where entity_type = 'jobs'
          and status = 'queued'
          and ($1::text is null or idempotency_key not like ('%:' || $1::text))`,
      [args.keepSuffix ?? null],
    );

    await queryPostgres(
      `update metrics.ingestion_jobs
          set last_error = null,
              updated_at = now()
        where status = 'succeeded'
          and entity_type in ('jobs', 'quotes')
          and last_error is not null`,
    );
  }

  console.log(
    JSON.stringify(
      {
        dryRun: args.dryRun,
        keepSuffix: args.keepSuffix ?? null,
        cancelledQueuedJobs: staleJobs.rows,
        clearedSucceededLastErrors: staleErrors.rows,
      },
      null,
      2,
    ),
  );
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    keepSuffix: process.env.QUEUE_KEEP_SUFFIX,
    dryRun: process.env.QUEUE_MAINTENANCE_EXECUTE !== "true",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep-suffix") {
      args.keepSuffix = argv[index + 1];
      index += 1;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--execute") {
      args.dryRun = false;
    } else {
      throw new Error(`Unknown argument ${arg}.`);
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

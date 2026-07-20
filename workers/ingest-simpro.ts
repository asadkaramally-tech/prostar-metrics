import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SimproClient } from "@/lib/simpro/client";
import { SimproEndpoints } from "@/lib/simpro/endpoints";
import { ingestEntityPage, type IngestionEntity } from "@/lib/simpro/ingest";
import {
  claimNextIngestionJob,
  completeIngestionJob,
  enqueueIngestionJob,
  failIngestionJob,
  heartbeatIngestionJob,
  startIngestionRun,
} from "@/lib/store/ingestion-jobs";
import { refreshPageFreshness, upsertFreshness } from "@/lib/store/freshness";
import { preferredCandidateFamily } from "@/lib/store/ingestion-claim-strategy";
import { inclusivePacificDateWindow } from "@/lib/store/ingestion-window";
import { completedJobDiscoveryParams } from "@/lib/store/simpro-profit-capacity-backfill";

export type Args = {
  dryRun: boolean;
  entity?: IngestionEntity;
  page?: number;
  requestBudget: number;
  startDate?: string;
  endDate?: string;
  entityId?: number;
  lookbackDays?: number;
  localHour?: number;
  idempotencySuffix?: string;
  drainLimit: number;
};

type Environment = Readonly<Record<string, string | undefined>>;

const supportedEntities = new Set<IngestionEntity>([
  "quotes",
  "quote_logs",
  "quote_nested",
  "jobs",
  "job_logs",
  "job_nested",
  "jobs_from_timesheets",
  "employees",
  "timesheets",
  "schedules",
  "schedule_logs",
  "mobile_status",
]);

export const workerId = `metrics-ingest-${process.pid}-${randomUUID()}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.localHour !== undefined && pacificHour(new Date()) !== args.localHour) {
    console.log(JSON.stringify({ skipped: true, reason: `outside Pacific hour ${args.localHour}` }, null, 2));
    return;
  }

  if (args.dryRun && args.entity) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          entity: args.entity,
          page: args.page ?? 1,
          requestBudget: args.requestBudget,
          note: "Dry run stops before Simpro and database writes.",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (args.entity && shouldEnqueueIngestionJob(args)) {
    const entity = args.entity;
    for (const params of ingestionParamSets(args)) {
      await enqueueIngestionJob({
        entity,
        idempotencyKey: ingestionIdempotencyKey(entity, params, args.idempotencySuffix),
        requestBudget: args.requestBudget,
        continuationToken: args.page ? { page: args.page } : null,
        params,
      });
    }
  }

  const results = [];
  const failures: Array<{ jobId: number; entity: IngestionEntity; error: string }> = [];
  const startedAt = Date.now();
  const endpoints = new SimproEndpoints(new SimproClient());
  const touchedEntities = new Set<IngestionEntity>();
  const successfulFreshness = new Map<
    IngestionEntity,
    { runId: number; continuationToken: Record<string, unknown> | null }
  >();
  let totalRequests = 0;
  for (
    let index = 0;
    index < args.drainLimit && Date.now() - startedAt < 19 * 60_000 && totalRequests < 1000;
    index += 1
  ) {
    const preferredEntity = args.entity ?? preferredCandidateFamily(index);
    const preferredJob = await claimNextIngestionJob(workerId, preferredEntity, args.idempotencySuffix);
    const job = preferredJob ?? (args.entity
      ? null
      : await claimNextIngestionJob(workerId, undefined, args.idempotencySuffix));
    if (!job) {
      if (results.length === 0) {
        console.log(JSON.stringify({ workerId, claimed: false }, null, 2));
      }
      break;
    }
    touchedEntities.add(job.entity_type);

    let runId: number | undefined;
    let budget: { limit: number; used: number } | undefined;
    let requestsAccounted = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatError: unknown;
    try {
      runId = await startIngestionRun(job, workerId);
      // Fence before any durable entity write: a fenced heartbeat proves this
      // worker still owns the job's current lease and generation. A superseded
      // worker (expired lease requeued and reclaimed under a bumped generation)
      // fails here instead of writing snapshots/facts it no longer owns.
      await heartbeatIngestionJob(job, workerId);
      heartbeatTimer = setInterval(() => {
        void heartbeatIngestionJob(job, workerId).catch((error) => {
          heartbeatError = error;
        });
      }, 60_000);
      budget = {
        limit: Math.max(0, Math.min(job.request_budget - job.requests_used, 1000 - totalRequests)),
        used: 0,
      };
      const result = await ingestEntityPage({
        endpoints,
        entity: job.entity_type,
        page: Number(job.continuation_token?.page ?? args.page ?? 1),
        continuationToken: job.continuation_token,
        params: job.params,
        requestBudget: budget,
        ingestionRunId: runId,
      });
      totalRequests += result.requestsUsed;
      requestsAccounted = true;
      if (heartbeatError) throw heartbeatError;

      const publication = await completeIngestionJob({
        job,
        workerId,
        runId,
        requestCount: result.requestsUsed,
        snapshotCount: result.snapshotsWritten,
        normalizedCount: result.normalizedWritten,
        continuationToken: result.continuationToken,
        candidateRefreshes: result.candidateRefreshes,
        affectedPeriods: result.affectedPeriods,
      });
      successfulFreshness.set(job.entity_type, { runId, continuationToken: result.continuationToken });

      const rollupsQueued = publication.rollup_count;
      results.push({ jobId: job.id, runId, ...result, rollupsQueued });
      console.log(JSON.stringify({ workerId, jobId: job.id, runId, ...result, rollupsQueued }, null, 2));
    } catch (error) {
      if (!requestsAccounted) totalRequests += budget?.used ?? 0;
      try {
        await failIngestionJob({ job, workerId, runId, requestCount: budget?.used ?? 0, error });
      } catch (failError) {
        // A lost lease/generation means a newer owner (or the recovery requeue)
        // already controls the job's failure accounting; record it and keep
        // draining instead of crashing the worker on a fenced write.
        const failMessage = failError instanceof Error ? failError.message : String(failError);
        console.error(JSON.stringify({ workerId, jobId: job.id, entity: job.entity_type, failError: failMessage }));
      }
      await markFreshnessFailed(job.entity_type, runId, error);
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ jobId: job.id, entity: job.entity_type, error: message });
      console.error(JSON.stringify({ workerId, jobId: job.id, entity: job.entity_type, error: message }));
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }

  // Aggregate freshness evaluation reads every required source, reconciliation,
  // and rollup gate. Evaluate once per touched family after the durable drain.
  for (const entity of touchedEntities) {
    const successful = successfulFreshness.get(entity);
    if (successful) {
      await markFreshnessBuilding(entity, successful.runId, successful.continuationToken);
    }
    await refreshFreshnessPages(entity);
  }

  if (results.length > 1) {
    console.log(JSON.stringify({ workerId, drained: results.length }, null, 2));
  }
  if (failures.length > 0) {
    console.error(JSON.stringify({ workerId, failed: failures.length, failures }, null, 2));
    process.exitCode = 1;
  }
}

async function markFreshnessBuilding(
  entity: IngestionEntity,
  runId: number,
  continuationToken: Record<string, unknown> | null,
) {
  for (const pageKey of freshnessPages(entity)) {
    await upsertFreshness({
      pageKey,
      ingestionRunId: runId,
      status: "building",
      sourceFamily: entity,
      continuationCount: continuationToken ? 1 : 0,
      expectedThrough: new Date(),
      coverage: {
        detail: continuationToken
          ? `${entity} traversal has a saved continuation.`
          : `${entity} traversal completed; aggregate source-family and reconciliation gates are still pending.`,
      },
    });
  }
}

async function markFreshnessFailed(entity: IngestionEntity, runId: number | undefined, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  for (const pageKey of freshnessPages(entity)) {
    await upsertFreshness({
      pageKey,
      ingestionRunId: runId,
      status: "failed",
      errorMessage: message,
      sourceFamily: entity,
      coverage: { detail: `Latest ${entity} ingestion failed; last-good data is retained.` },
    });
  }
}

function freshnessPages(entity: IngestionEntity) {
  return entity === "quotes" || entity === "quote_logs" || entity === "quote_nested"
    ? ["quotes"]
    : entity === "jobs" || entity === "job_logs" || entity === "job_nested" || entity === "jobs_from_timesheets"
      ? ["jobs", "technicians", "commissions"]
      : entity === "employees"
        ? ["technicians", "commissions"]
        : entity === "timesheets"
          ? ["jobs", "technicians", "commissions"]
          : entity === "schedules" || entity === "schedule_logs" || entity === "mobile_status"
            ? ["technicians"]
            : [];
}

async function refreshFreshnessPages(entity: IngestionEntity) {
  for (const pageKey of freshnessPages(entity)) {
    await refreshPageFreshness(pageKey);
  }
}

export function parseArgs(argv: string[], env: Environment = process.env): Args {
  const args: Args = {
    dryRun: environmentBoolean(env.INGEST_DRY_RUN, "INGEST_DRY_RUN"),
    entity: optionalEnvironmentValue(env.INGEST_ENTITY) as IngestionEntity | undefined,
    page: optionalNumber(env.INGEST_PAGE),
    requestBudget: optionalNumber(env.INGEST_REQUEST_BUDGET) ?? 100,
    startDate: optionalEnvironmentValue(env.INGEST_START_DATE),
    endDate: optionalEnvironmentValue(env.INGEST_END_DATE),
    entityId: optionalNumber(env.INGEST_ENTITY_ID),
    lookbackDays: optionalNumber(env.INGEST_LOOKBACK_DAYS),
    localHour: optionalNumber(env.INGEST_LOCAL_HOUR),
    idempotencySuffix: optionalEnvironmentValue(env.INGEST_IDEMPOTENCY_SUFFIX),
    drainLimit: optionalNumber(env.INGEST_DRAIN_LIMIT) ?? 1,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--entity") {
      args.entity = argumentValue(argv, index, arg) as IngestionEntity;
      index += 1;
    } else if (arg === "--page") {
      args.page = integerArgumentValue(argv, index, arg);
      index += 1;
    } else if (arg === "--request-budget") {
      args.requestBudget = integerArgumentValue(argv, index, arg);
      index += 1;
    } else if (arg === "--start-date" || arg === "--from") {
      args.startDate = argumentValue(argv, index, arg);
      index += 1;
    } else if (arg === "--end-date" || arg === "--to") {
      args.endDate = argumentValue(argv, index, arg);
      index += 1;
    } else if (arg === "--entity-id") {
      args.entityId = integerArgumentValue(argv, index, arg);
      index += 1;
    } else if (arg === "--lookback-days") {
      args.lookbackDays = integerArgumentValue(argv, index, arg);
      index += 1;
    } else if (arg === "--local-hour") {
      args.localHour = integerArgumentValue(argv, index, arg);
      index += 1;
    } else if (arg === "--idempotency-suffix") {
      args.idempotencySuffix = argumentValue(argv, index, arg);
      index += 1;
    } else if (arg === "--drain-limit") {
      args.drainLimit = integerArgumentValue(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown argument ${arg}.`);
    }
  }

  validateArgs(args);
  if (args.lookbackDays !== undefined && !args.startDate && !args.endDate) {
    const window = inclusivePacificDateWindow(args.lookbackDays);
    args.startDate = window.startDate;
    args.endDate = window.endDate;
  }
  return args;
}

export function shouldEnqueueIngestionJob(args: Pick<Args, "entity" | "entityId">) {
  if (!args.entity) return false;
  if (args.entity === "quote_nested" || args.entity === "job_nested") {
    return Number.isInteger(args.entityId) && Number(args.entityId) > 0;
  }
  return true;
}

function validateArgs(args: Args) {
  if (args.entity !== undefined && !supportedEntities.has(args.entity)) {
    throw new Error("--entity must be a supported ingestion entity.");
  }
  if (args.page !== undefined) args.page = boundedInteger(args.page, 1, Number.MAX_SAFE_INTEGER, "--page");
  args.requestBudget = boundedInteger(args.requestBudget, 1, 250, "--request-budget");
  if (args.entityId !== undefined) {
    args.entityId = boundedInteger(args.entityId, 1, Number.MAX_SAFE_INTEGER, "--entity-id");
  }
  if (args.lookbackDays !== undefined) {
    args.lookbackDays = boundedInteger(args.lookbackDays, 1, 100_000, "--lookback-days");
  }
  if (args.localHour !== undefined) args.localHour = boundedInteger(args.localHour, 0, 23, "--local-hour");
  if (args.idempotencySuffix !== undefined) {
    args.idempotencySuffix = requiredText(args.idempotencySuffix, "--idempotency-suffix");
  }
  args.drainLimit = boundedInteger(args.drainLimit, 1, 1000, "--drain-limit");
  if (args.startDate !== undefined) args.startDate = validDate(args.startDate, "--start-date/--from");
  if (args.endDate !== undefined) args.endDate = validDate(args.endDate, "--end-date/--to");
  if (args.startDate && args.endDate && args.startDate > args.endDate) {
    throw new Error("The ingestion start date must not be after the end date.");
  }
}

function argumentValue(argv: string[], index: number, argument: string) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${argument} requires a value.`);
  }
  return requiredText(value, argument);
}

function integerArgumentValue(argv: string[], index: number, argument: string) {
  return integerValue(argumentValue(argv, index, argument));
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function validDate(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must use YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid calendar date.`);
  }
  return value;
}

function requiredText(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} requires a value.`);
  return normalized;
}

function optionalEnvironmentValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function optionalNumber(value: string | undefined) {
  const normalized = optionalEnvironmentValue(value);
  return normalized === undefined ? undefined : integerValue(normalized);
}

function integerValue(value: string) {
  return /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
}

function environmentBoolean(value: string | undefined, field: string) {
  const normalized = optionalEnvironmentValue(value);
  if (normalized === undefined || normalized === "false") return false;
  if (normalized === "true") return true;
  throw new Error(`${field} must be true or false.`);
}

function ingestionParams(args: Args) {
  if (args.entity === "quote_nested" || args.entity === "job_nested") {
    if (!Number.isInteger(args.entityId) || Number(args.entityId) <= 0) {
      throw new Error("--entity-id is required for nested quote/job ingestion.");
    }
    return { entityId: args.entityId };
  }
  if (args.entity === "jobs" && args.startDate && args.startDate === args.endDate) {
    return completedJobDiscoveryParams(args.startDate);
  }

  if (args.entity === "quotes" && args.startDate && args.startDate === args.endDate) {
    return { DateApproved: args.startDate };
  }

  return {
    ...(args.startDate ? { StartDate: args.startDate, startDate: args.startDate } : {}),
    ...(args.endDate ? { EndDate: args.endDate, endDate: args.endDate } : {}),
  };
}

function ingestionParamSets(args: Args) {
  if (
    (args.entity === "jobs" || args.entity === "quotes") &&
    args.startDate &&
    args.endDate &&
    args.startDate !== args.endDate
  ) {
    return dateRange(args.startDate, args.endDate).map((day) =>
      args.entity === "jobs" ? completedJobDiscoveryParams(day) : { DateApproved: day },
    );
  }

  return [ingestionParams(args)];
}

function ingestionIdempotencyKey(entity: IngestionEntity, params: Record<string, unknown>, suffix?: string) {
  const dateKey = params.entityId ?? params.CompletedDate ?? params.DateApproved ?? params.StartDate ?? params.startDate;
  const suffixKey = suffix ? `:${suffix}` : "";
  if (dateKey) {
    return `${entity}:${String(dateKey)}${suffixKey}`;
  }

  if (["quote_logs", "job_logs", "schedule_logs", "mobile_status"].includes(entity)) {
    const now = new Date();
    now.setUTCMinutes(Math.floor(now.getUTCMinutes() / 15) * 15, 0, 0);
    return `${entity}:${now.toISOString()}${suffixKey}`;
  }

  return `${entity}:${new Date().toISOString().slice(0, 10)}${suffixKey}`;
}

function dateRange(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const days: string[] = [];
  for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 86_400_000)) {
    days.push(cursor.toISOString().slice(0, 10));
  }
  return days;
}

function pacificHour(date: Date) {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return Number(value);
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

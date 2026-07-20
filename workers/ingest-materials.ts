import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  addMonthsToPeriodStart,
  normalizeMaterialsPeriodStart,
} from "@/lib/metrics/materials";
import { SimproClient, type RequestBudget } from "@/lib/simpro/client";
import { SimproEndpoints } from "@/lib/simpro/endpoints";
import {
  discoverCompletedJobs,
  fetchCatalogGroup,
  fetchJobMaterialLines,
  type CatalogGroupLookup,
} from "@/lib/simpro/materials";
import { upsertFreshness } from "@/lib/store/freshness";
import {
  finishMaterialsMonthWalk,
  getCatalogGroupCache,
  recordMaterialsMonthWalkFailure,
  replaceJobMaterialLines,
  upsertCatalogGroups,
} from "@/lib/store/materials-ingest";
import { MATERIALS_FRESHNESS_PAGE_KEY, MATERIALS_METRIC_FAMILY } from "@/lib/store/materials-read-model";
import {
  claimNextRollupRebuild,
  enqueueRollupRebuild,
  failRollupRebuild,
  heartbeatRollupRebuild,
  rebuildReadModelForJob,
} from "@/lib/store/read-model-rebuilds";

/**
 * Materials ingestion worker: walks completed jobs for each requested month
 * live from Simpro (sections → costCenters → catalogs/oneOffs/prebuilds),
 * mirrors the material lines into metrics.metrics_material_lines, refreshes
 * the persistent catalog-group cache, then enqueues and drains the materials
 * rollup rebuilds so dashboard_read_models serves the page without any
 * request-time Simpro traffic.
 *
 * Scheduled mode (default): walks the current Pacific month, plus the prior
 * `--months-back` months (late completions land in the prior month for days).
 * Backfill mode: `--from 2025-01 --to 2026-07` walks the whole range once.
 */

export type Args = {
  dryRun: boolean;
  month?: string;
  from?: string;
  to?: string;
  monthsBack: number;
  requestLimit: number;
  rebuild: boolean;
  groupMaxAgeDays: number;
};

type Environment = Readonly<Record<string, string | undefined>>;

const workerId = `metrics-materials-${process.pid}`;
const MATERIALS_FRESHNESS_MAX_AGE_HOURS = 13;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const months = resolveMonths(args);
  if (args.dryRun) {
    console.log(JSON.stringify({ mode: "dry-run", months, requestLimit: args.requestLimit }, null, 2));
    return;
  }

  const client = new SimproClient();
  const endpoints = new SimproEndpoints(client);
  const budget: RequestBudget = { limit: args.requestLimit, used: 0 };
  const walked: Array<{ periodStart: string; jobCount: number; lineCount: number; requestsUsed: number }> = [];
  const failures: Array<{ periodStart: string; error: string }> = [];

  for (const periodStart of months) {
    const before = budget.used;
    try {
      const result = await walkMaterialsMonth({ client, endpoints, periodStart, budget, groupMaxAgeDays: args.groupMaxAgeDays });
      walked.push({ ...result, requestsUsed: budget.used - before });
      console.log(JSON.stringify({ workerId, ...result, requestsUsed: budget.used - before }, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ periodStart, error: message });
      console.error(JSON.stringify({ workerId, periodStart, error: message }));
      try {
        await recordMaterialsMonthWalkFailure({ periodStart, error });
      } catch (recordError) {
        console.error(JSON.stringify({
          workerId,
          periodStart,
          recordError: recordError instanceof Error ? recordError.message : String(recordError),
        }));
      }
    }
  }

  const rebuilt = args.rebuild ? await drainMaterialsRebuilds(walked.map((walk) => walk.periodStart)) : [];
  await publishMaterialsFreshness(walked, failures);

  console.log(JSON.stringify({
    workerId,
    months,
    walked,
    rebuilt,
    failures,
    totalRequests: budget.used,
  }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

async function walkMaterialsMonth(params: {
  client: SimproClient;
  endpoints: SimproEndpoints;
  periodStart: string;
  budget: RequestBudget;
  groupMaxAgeDays: number;
}): Promise<{ periodStart: string; jobCount: number; lineCount: number }> {
  const { client, endpoints, periodStart, budget } = params;
  const walkStartedAt = new Date();
  const window = monthWindow(periodStart);
  const jobs = await discoverCompletedJobs(client, { startDate: window.start, endDate: window.end, budget });

  let lineCount = 0;
  const catalogIdsSeen = new Set<number>();
  for (const job of jobs) {
    const lines = await fetchJobMaterialLines(endpoints, job.jobId, budget);
    for (const line of lines) {
      if (line.catalogId !== null) catalogIdsSeen.add(line.catalogId);
    }
    await replaceJobMaterialLines({
      jobId: job.jobId,
      periodStart,
      completedDate: job.completedDate,
      lines,
      fetchedAt: new Date(),
    });
    lineCount += lines.length;
  }

  await refreshCatalogGroups(client, [...catalogIdsSeen], budget, params.groupMaxAgeDays);
  await finishMaterialsMonthWalk({
    periodStart,
    walkStartedAt,
    jobCount: jobs.length,
    lineCount,
    requestsUsed: budget.used,
  });
  return { periodStart, jobCount: jobs.length, lineCount };
}

async function refreshCatalogGroups(
  client: SimproClient,
  catalogIds: number[],
  budget: RequestBudget,
  groupMaxAgeDays: number,
): Promise<void> {
  if (catalogIds.length === 0) return;
  const cache = await getCatalogGroupCache(catalogIds);
  const staleBefore = Date.now() - groupMaxAgeDays * 86_400_000;
  const toFetch = catalogIds.filter((catalogId) => {
    const cached = cache.get(catalogId);
    if (!cached) return true;
    const fetchedAt = new Date(cached.fetchedAt).getTime();
    return !Number.isFinite(fetchedAt) || fetchedAt < staleBefore;
  });

  const fetched: CatalogGroupLookup[] = [];
  for (const catalogId of toFetch) {
    fetched.push(await fetchCatalogGroup(client, catalogId, budget));
    if (fetched.length >= 200) {
      await upsertCatalogGroups(fetched.splice(0));
    }
  }
  await upsertCatalogGroups(fetched);
}

async function drainMaterialsRebuilds(periodStarts: string[]) {
  const affected = new Set<string>(periodStarts);
  // A walked month also feeds the next month's prior-month comparison and the
  // same month next year; rebuild dependents that are already served.
  for (const periodStart of periodStarts) {
    affected.add(addMonthsToPeriodStart(periodStart, 1));
    affected.add(addMonthsToPeriodStart(periodStart, 12));
  }
  for (const periodStart of [...affected].sort()) {
    await enqueueRollupRebuild({
      metricFamily: MATERIALS_METRIC_FAMILY,
      periodStart,
      reason: "materials month walk",
    });
  }

  const rebuilt: Array<{ jobId: number; periodStart: string }> = [];
  const attempted: number[] = [];
  for (;;) {
    const job = await claimNextRollupRebuild(workerId, MATERIALS_METRIC_FAMILY, attempted);
    if (!job) break;
    attempted.push(job.id);
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatError: unknown;
    try {
      heartbeatTimer = setInterval(() => {
        void heartbeatRollupRebuild(job).catch((error) => {
          heartbeatError = error;
        });
      }, 60_000);
      await rebuildReadModelForJob(job);
      if (heartbeatError) throw heartbeatError;
      rebuilt.push({ jobId: job.id, periodStart: job.period_start });
    } catch (error) {
      await failRollupRebuild(job.id, error, { lockedBy: job.locked_by });
      console.error(JSON.stringify({
        workerId,
        jobId: job.id,
        periodStart: job.period_start,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }
  return rebuilt;
}

async function publishMaterialsFreshness(
  walked: Array<{ periodStart: string; jobCount: number; lineCount: number }>,
  failures: Array<{ periodStart: string; error: string }>,
) {
  try {
    if (failures.length > 0) {
      await upsertFreshness({
        pageKey: MATERIALS_FRESHNESS_PAGE_KEY,
        status: "failed",
        errorMessage: failures.map((failure) => `${failure.periodStart}: ${failure.error}`).join("; ").slice(0, 2000),
        sourceFamily: "materials",
        maxAgeHours: MATERIALS_FRESHNESS_MAX_AGE_HOURS,
        coverage: { detail: "The latest materials walk failed; last-good mirrored months are retained." },
      });
      return;
    }
    if (walked.length === 0) return;
    const months = walked.map((walk) => walk.periodStart.slice(0, 7)).join(", ");
    await upsertFreshness({
      pageKey: MATERIALS_FRESHNESS_PAGE_KEY,
      status: "current",
      dataThrough: new Date(),
      sourceFamily: "materials",
      maxAgeHours: MATERIALS_FRESHNESS_MAX_AGE_HOURS,
      coverage: { detail: `Completed a full live Simpro materials walk for ${months}.` },
    });
  } catch (error) {
    console.error(JSON.stringify({
      workerId,
      freshnessError: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function resolveMonths(args: Pick<Args, "month" | "from" | "to" | "monthsBack">, now = new Date()): string[] {
  if (args.from || args.to) {
    const from = monthArgumentToPeriodStart(args.from, "--from");
    const to = monthArgumentToPeriodStart(args.to, "--to");
    if (from > to) throw new Error("--from must not be after --to.");
    const months: string[] = [];
    for (let month = from; month <= to; month = addMonthsToPeriodStart(month, 1)) months.push(month);
    if (months.length > 60) throw new Error("Materials backfill ranges are limited to 60 months.");
    return months;
  }
  if (args.month) {
    return [monthArgumentToPeriodStart(args.month, "--month")];
  }
  const current = normalizeMaterialsPeriodStart(undefined, now);
  const months: string[] = [];
  for (let back = args.monthsBack; back >= 0; back -= 1) {
    months.push(addMonthsToPeriodStart(current, -back));
  }
  return months;
}

export function parseArgs(argv: string[], env: Environment = process.env): Args {
  const args: Args = {
    dryRun: env.MATERIALS_DRY_RUN === "true",
    month: optionalValue(env.MATERIALS_MONTH),
    from: optionalValue(env.MATERIALS_FROM),
    to: optionalValue(env.MATERIALS_TO),
    monthsBack: optionalInteger(env.MATERIALS_MONTHS_BACK) ?? 1,
    requestLimit: optionalInteger(env.MATERIALS_REQUEST_LIMIT) ?? 4000,
    rebuild: env.MATERIALS_SKIP_REBUILD !== "true",
    groupMaxAgeDays: optionalInteger(env.MATERIALS_GROUP_MAX_AGE_DAYS) ?? 30,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--month") {
      args.month = argumentValue(argv, index, arg);
      index += 1;
    } else if (arg === "--from") {
      args.from = argumentValue(argv, index, arg);
      index += 1;
    } else if (arg === "--to") {
      args.to = argumentValue(argv, index, arg);
      index += 1;
    } else if (arg === "--months-back") {
      args.monthsBack = integerArgumentValue(argv, index, arg);
      index += 1;
    } else if (arg === "--request-limit") {
      args.requestLimit = integerArgumentValue(argv, index, arg);
      index += 1;
    } else if (arg === "--no-rebuild") {
      args.rebuild = false;
    } else if (arg === "--group-max-age-days") {
      args.groupMaxAgeDays = integerArgumentValue(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown argument ${arg}.`);
    }
  }

  if ((args.from || args.to) && args.month) {
    throw new Error("Use either --month or a --from/--to range, not both.");
  }
  args.monthsBack = boundedInteger(args.monthsBack, 0, 24, "--months-back");
  args.requestLimit = boundedInteger(args.requestLimit, 100, 100_000, "--request-limit");
  args.groupMaxAgeDays = boundedInteger(args.groupMaxAgeDays, 1, 365, "--group-max-age-days");
  return args;
}

function monthArgumentToPeriodStart(value: string | undefined, label: string): string {
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM.`);
  }
  return `${value}-01`;
}

function monthWindow(periodStart: string): { start: string; end: string } {
  const [year, month] = periodStart.split("-").map(Number);
  const endDate = new Date(Date.UTC(year, month, 0));
  return { start: periodStart, end: endDate.toISOString().slice(0, 10) };
}

function argumentValue(argv: string[], index: number, argument: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
  return value;
}

function integerArgumentValue(argv: string[], index: number, argument: string): number {
  const value = argumentValue(argv, index, argument);
  if (!/^-?\d+$/.test(value)) throw new Error(`${argument} must be an integer.`);
  return Number(value);
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function optionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function optionalInteger(value: string | undefined): number | undefined {
  const normalized = optionalValue(value);
  if (normalized === undefined) return undefined;
  if (!/^-?\d+$/.test(normalized)) return Number.NaN;
  return Number(normalized);
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

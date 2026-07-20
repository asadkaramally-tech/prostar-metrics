import { ingestBackfillSlice, backfillTargetKey, ingestionEntityForBackfillSource } from "@/lib/backfill/orchestration";
import {
  BACKFILL_DETAIL_PAGE_REQUEST_FLOOR,
  BACKFILL_REQUESTS_PER_SECOND,
  BACKFILL_SAFE_PAGE_SIZE,
} from "@/lib/backfill/plan";
import { SimproClient } from "@/lib/simpro/client";
import { loadSimproConfig } from "@/lib/simpro/config";
import { SimproEndpoints } from "@/lib/simpro/endpoints";
import {
  claimNextBackfillWorkUnit,
  failBackfillWorkUnit,
  finishBackfillSlice,
  getBackfillOperationalSummary,
  heartbeatBackfillWorkUnit,
  recordBackfillReconciliation,
  startBackfillIngestionRun,
} from "@/lib/store/backfill-ledger";
import { reconcileBackfillWorkUnit } from "@/lib/store/backfill-reconciliation";

type Args = {
  execute: boolean;
  drainLimit: number;
  runtimeMinutes: number;
  runRequestLimit: number;
};

const workerId = `metrics-backfill-${process.pid}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.execute) {
    console.log(JSON.stringify({ mode: "diagnostic", execute: false, ...(await getBackfillOperationalSummary()) }, null, 2));
    return;
  }

  const config = loadSimproConfig();
  const endpoints = new SimproEndpoints(new SimproClient({
    ...config,
    requestsPerSecond: BACKFILL_REQUESTS_PER_SECOND,
    maxPageSize: Math.min(BACKFILL_SAFE_PAGE_SIZE, config.maxPageSize),
  }));
  const startedAt = Date.now();
  let totalRequests = 0;
  let processed = 0;

  while (
    processed < args.drainLimit
    && Date.now() - startedAt < args.runtimeMinutes * 60_000
    && args.runRequestLimit - totalRequests >= BACKFILL_DETAIL_PAGE_REQUEST_FLOOR
  ) {
    const workUnit = await claimNextBackfillWorkUnit(workerId);
    if (!workUnit) break;
    processed += 1;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatError: unknown;
    let runId: number | undefined;
    let requestsUsed = 0;
    let requestBudget: { limit: number; used: number } | undefined;
    let requestsAccounted = false;
    try {
      heartbeatTimer = setInterval(() => {
        void heartbeatBackfillWorkUnit(workUnit.id, workerId).catch((error) => {
          heartbeatError = error;
        });
      }, 60_000);

      if (workUnit.claim_phase === "reconcile") {
        const evidence = await reconcileBackfillWorkUnit(workUnit);
        if (heartbeatError) throw heartbeatError;
        const completion = await recordBackfillReconciliation({ workUnit, workerId, evidence });
        console.log(JSON.stringify({ workerId, workUnitId: workUnit.id, phase: "reconcile", evidence, completion }, null, 2));
        continue;
      }

      const entity = ingestionEntityForBackfillSource(workUnit.source_family);
      if (entity) {
        runId = await startBackfillIngestionRun({
          workUnit,
          workerId,
          entity,
          targetKey: backfillTargetKey(workUnit),
        });
      }
      requestBudget = {
        limit: Math.min(workUnit.reserved_requests, args.runRequestLimit - totalRequests),
        used: 0,
      };
      const result = await ingestBackfillSlice({ workUnit, endpoints, requestBudget, ingestionRunId: runId });
      requestsUsed = result.requestsUsed;
      if (heartbeatError) throw heartbeatError;
      await finishBackfillSlice({ workUnit, workerId, runId, ...result });
      totalRequests += requestsUsed;
      requestsAccounted = true;
      console.log(JSON.stringify({ workerId, workUnitId: workUnit.id, phase: "ingest", ...result }, null, 2));
    } catch (error) {
      requestsUsed = Math.max(requestsUsed, requestBudget?.used ?? 0);
      if (!requestsAccounted) totalRequests += requestsUsed;
      await failBackfillWorkUnit({ workUnit, workerId, runId, requestsUsed, error });
      console.error(JSON.stringify({
        workerId,
        workUnitId: workUnit.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }

  console.log(JSON.stringify({ workerId, processed, totalRequests, elapsedMs: Date.now() - startedAt }, null, 2));
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    execute: process.env.BACKFILL_EXECUTE === "true",
    drainLimit: Number(process.env.BACKFILL_DRAIN_LIMIT ?? 10),
    runtimeMinutes: Number(process.env.BACKFILL_RUNTIME_MINUTES ?? 19),
    runRequestLimit: Number(process.env.BACKFILL_RUN_REQUEST_LIMIT ?? 1000),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") {
      args.execute = true;
    } else if (arg === "--drain-limit") {
      args.drainLimit = Number(argv[++index]);
    } else if (arg === "--runtime-minutes") {
      args.runtimeMinutes = Number(argv[++index]);
    } else if (arg === "--run-request-limit") {
      args.runRequestLimit = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument ${arg}.`);
    }
  }
  args.drainLimit = boundedInteger(args.drainLimit, 1, 100, "--drain-limit");
  args.runtimeMinutes = boundedInteger(args.runtimeMinutes, 1, 20, "--runtime-minutes");
  args.runRequestLimit = boundedInteger(
    args.runRequestLimit,
    BACKFILL_DETAIL_PAGE_REQUEST_FLOOR,
    1000,
    "--run-request-limit",
  );
  return args;
}

function boundedInteger(value: number, min: number, max: number, label: string) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => {
  process.exit();
});

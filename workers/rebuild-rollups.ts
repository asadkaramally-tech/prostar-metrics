import { randomUUID } from "node:crypto";
import {
  claimNextRollupRebuild,
  enqueueRollupRebuild,
  failRollupRebuild,
  heartbeatRollupRebuild,
  rebuildReadModelForJob,
} from "@/lib/store/read-model-rebuilds";
import type { RollupScope } from "@/lib/store/rollups";
import { enqueueCurrentPacificCommissionRebuild as enqueueNightlyCommission } from "@/lib/store/commission-cadence";
import {
  acquireWorkerExecutionLease,
  heartbeatWorkerExecutionLease,
  releaseWorkerExecutionLease,
} from "@/lib/store/worker-execution-leases";

type Args = {
  scope?: RollupScope;
  periodStart?: string;
  reason: string;
  limit: number;
  nightlyCommissions: boolean;
  localHour: number;
};

const workerId = `metrics-rollup-${process.pid}-${randomUUID()}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const lease = {
    lockKey: args.nightlyCommissions ? "rollups:nightly-commissions" : `rollups:${args.scope ?? "drain"}`,
    owner: workerId,
  };
  if (!await acquireWorkerExecutionLease(lease)) {
    console.log(JSON.stringify({ workerId, skipped: true, reason: "prior execution is still active", lease: lease.lockKey }, null, 2));
    return;
  }
  let leaseHeartbeatError: unknown;
  const leaseHeartbeat = setInterval(() => {
    void heartbeatWorkerExecutionLease(lease).catch((error) => {
      leaseHeartbeatError = error;
    });
  }, 60_000);

  try {

  let commissionCadence = null;
  if (args.nightlyCommissions) {
    commissionCadence = await enqueueCurrentPacificCommissionRebuild(args.localHour);
    if (!commissionCadence.enqueued) {
      console.log(JSON.stringify({ workerId, commissionCadence, claimed: false, rebuilt: [] }, null, 2));
      return;
    }
  }

  if (args.scope && args.periodStart) {
    await enqueueRollupRebuild({
      metricFamily: args.scope,
      periodStart: args.periodStart,
      reason: args.reason,
    });
  }

  const rebuilt = [];
  const failures: Array<{ jobId: number; metricFamily: RollupScope; periodStart: string; error: string }> = [];
  const attemptedJobIds: number[] = [];
  for (let index = 0; index < args.limit; index += 1) {
    if (leaseHeartbeatError) throw leaseHeartbeatError;
    const job = await claimNextRollupRebuild(
      workerId,
      args.nightlyCommissions ? "commissions" : args.scope,
      attemptedJobIds,
    );
    if (!job) break;
    attemptedJobIds.push(job.id);
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatError: unknown;
    try {
      heartbeatTimer = setInterval(() => {
        void heartbeatRollupRebuild(job).catch((error) => {
          heartbeatError = error;
        });
      }, 60_000);
      const payload = await rebuildReadModelForJob(job);
      if (heartbeatError) throw heartbeatError;
      rebuilt.push({
        jobId: job.id,
        metricFamily: job.metric_family,
        periodStart: job.period_start,
        keys: Object.keys(payload),
      });
    } catch (error) {
      await failRollupRebuild(job.id, error, { lockedBy: job.locked_by });
      failures.push({
        jobId: job.id,
        metricFamily: job.metric_family,
        periodStart: job.period_start,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }
  console.log(JSON.stringify({
    workerId,
    commissionCadence,
    claimed: rebuilt.length > 0 || failures.length > 0,
    rebuilt,
    failures,
  }, null, 2));
  if (failures.length > 0) {
    process.exitCode = 1;
  }
  } finally {
    clearInterval(leaseHeartbeat);
    await releaseWorkerExecutionLease(lease).catch((error) => {
      console.error(JSON.stringify({ workerId, lease: lease.lockKey, releaseError: error instanceof Error ? error.message : String(error) }));
    });
  }
}

export async function enqueueCurrentPacificCommissionRebuild(localHour = 3) {
  return enqueueNightlyCommission(localHour);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    scope: process.env.ROLLUP_SCOPE as RollupScope | undefined,
    periodStart: process.env.ROLLUP_PERIOD_START,
    reason: process.env.ROLLUP_REASON ?? "manual rollup rebuild",
    limit: Number(process.env.ROLLUP_DRAIN_LIMIT ?? 1),
    nightlyCommissions: process.env.ROLLUP_NIGHTLY_COMMISSIONS === "true",
    localHour: Number(process.env.ROLLUP_LOCAL_HOUR ?? 3),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scope") {
      args.scope = argv[index + 1] as RollupScope;
      index += 1;
    } else if (arg === "--period-start") {
      args.periodStart = argv[index + 1];
      index += 1;
    } else if (arg === "--reason") {
      args.reason = argv[index + 1];
      index += 1;
    } else if (arg === "--limit") {
      args.limit = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--nightly-commissions") {
      args.nightlyCommissions = true;
    } else if (arg === "--local-hour") {
      args.localHour = Number(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }

  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
    throw new Error("--limit must be an integer from 1 through 100.");
  }
  if (!Number.isInteger(args.localHour) || args.localHour < 0 || args.localHour > 23) {
    throw new Error("--local-hour must be an integer from 0 through 23.");
  }
  if (args.nightlyCommissions && (args.scope || args.periodStart)) {
    throw new Error("--nightly-commissions cannot be combined with --scope or --period-start.");
  }

  return args;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

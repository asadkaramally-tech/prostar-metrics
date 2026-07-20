import { pathToFileURL } from "node:url";
import {
  assertCommissionInitializationRebuildCompleted,
  claimCommissionInitializationRebuild,
  checkCommissionInitializationPrerequisites,
  commissionInitializationDrainConfirmationToken,
  commissionInitializationRepairConfirmationToken,
  getCommissionInitializationQueueStatus,
  getCanonicalCommissionInitializationQueueIds,
  repairFailedCommissionInitializationRebuild,
} from "@/lib/store/commission-initialization-queue";
import {
  failRollupRebuild,
  heartbeatRollupRebuild,
  rebuildReadModelForJob,
} from "@/lib/store/read-model-rebuilds";
import type { RollupRebuildJob } from "@/lib/store/read-model-rebuilds";
import {
  normalizeCommissionInitializationActor,
  resolveCommissionInitializationMonth,
} from "@/lib/store/commission-period-initialization";
import { closePostgresPool } from "@/lib/store/postgres";

type Args = {
  action: "prerequisites" | "status" | "drain" | "repair-failed";
  throughMonth?: string;
  month?: string;
  actorEmail: string;
  limit: number;
  reason?: string;
  confirmation?: string;
  help: boolean;
};

type DrainJobDependencies = {
  heartbeat: (job: RollupRebuildJob) => Promise<void>;
  rebuild: (job: RollupRebuildJob) => Promise<unknown>;
  fail: (jobId: number, error: unknown, options: { lockedBy: string }) => Promise<void>;
  assertCompleted: (job: Pick<RollupRebuildJob, "id" | "period_start">) => Promise<void>;
  heartbeatIntervalMs: number;
};

const usage = `Usage:
  npm run commissions:initialization-queue -- --prerequisites --through <YYYY-MM|current> --actor <Asad-or-Laila-email>
  npm run commissions:initialization-queue -- --status --through <YYYY-MM|current> --actor <Asad-or-Laila-email>
  npm run commissions:initialization-queue -- --drain --through <YYYY-MM|current> --limit <1-43> --actor <Asad-or-Laila-email> --confirm <exact-token>
  npm run commissions:initialization-queue -- --repair-failed --month <YYYY-MM> --actor <Asad-or-Laila-email> --reason <operator-reason> --confirm <exact-token>`;

export function parseCommissionInitializationQueueArgs(argv: string[], now = new Date()): Args {
  let action: Args["action"] | undefined;
  let throughMonth: string | undefined;
  let month: string | undefined;
  let actor: string | undefined;
  let limit = 43;
  let limitProvided = false;
  let reason: string | undefined;
  let confirmation: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--prerequisites", "--status", "--drain", "--repair-failed"].includes(arg)) {
      if (action) throw new Error("Choose exactly one queue action.");
      action = arg.slice(2) as Args["action"];
    } else if (arg === "--through") throughMonth = once(throughMonth, requiredValue(argv, ++index, arg), arg);
    else if (arg === "--month") month = once(month, requiredValue(argv, ++index, arg), arg);
    else if (arg === "--actor") actor = once(actor, requiredValue(argv, ++index, arg), arg);
    else if (arg === "--reason") reason = once(reason, requiredValue(argv, ++index, arg), arg);
    else if (arg === "--confirm") confirmation = once(confirmation, requiredValue(argv, ++index, arg), arg);
    else if (arg === "--limit") {
      if (limitProvided) throw new Error("--limit may only be provided once.");
      limitProvided = true;
      const value = Number(requiredValue(argv, ++index, arg));
      if (!Number.isInteger(value) || value < 1 || value > 43) throw new Error("--limit must be an integer from 1 through 43.");
      limit = value;
    } else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`Unknown argument ${arg}.`);
  }
  if (help) return { action: "status", actorEmail: "", limit, help: true };
  if (!action) throw new Error("Choose exactly one of --prerequisites, --status, --drain, or --repair-failed.");
  if (!actor) throw new Error("--actor is required.");
  const actorEmail = normalizeCommissionInitializationActor(actor);
  if (action === "repair-failed") {
    if (!month || throughMonth) throw new Error("--repair-failed requires --month and does not accept --through.");
    if (limitProvided) throw new Error("--limit is only valid with --drain.");
    const resolvedMonth = resolveCommissionInitializationMonth(month, now);
    if (!reason) throw new Error("--reason is required for --repair-failed.");
    if (confirmation !== commissionInitializationRepairConfirmationToken(resolvedMonth)) {
      throw new Error(`Repair requires --confirm ${commissionInitializationRepairConfirmationToken(resolvedMonth)}.`);
    }
    return { action, month: resolvedMonth, actorEmail, limit, reason, confirmation, help: false };
  }
  if (!throughMonth || month) throw new Error(`--${action} requires --through and does not accept --month.`);
  const through = resolveCommissionInitializationMonth(throughMonth, now);
  if (action !== "drain" && limitProvided) throw new Error("--limit is only valid with --drain.");
  if (reason !== undefined) throw new Error("--reason is only valid with --repair-failed.");
  if ((action === "status" || action === "prerequisites") && confirmation) throw new Error(`--confirm is not valid with --${action}.`);
  if (action === "drain" && confirmation !== commissionInitializationDrainConfirmationToken(through)) {
    throw new Error(`Drain requires --confirm ${commissionInitializationDrainConfirmationToken(through)}.`);
  }
  return { action, throughMonth: through, actorEmail, limit, confirmation, help: false };
}

async function main() {
  const args = parseCommissionInitializationQueueArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
    return;
  }
  if (args.action === "status") {
    console.log(JSON.stringify(await getCommissionInitializationQueueStatus(args.throughMonth!), null, 2));
    return;
  }
  if (args.action === "prerequisites") {
    const report = await checkCommissionInitializationPrerequisites(args.throughMonth!);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 1;
    return;
  }
  if (args.action === "repair-failed") {
    console.log(JSON.stringify(await repairFailedCommissionInitializationRebuild({
      month: args.month!, actorEmail: args.actorEmail, reason: args.reason!, confirmation: args.confirmation!,
    }), null, 2));
    return;
  }

  const prerequisites = await checkCommissionInitializationPrerequisites(args.throughMonth!);
  if (!prerequisites.ready) {
    throw new Error(`Commission initialization drain refused: ${prerequisites.rejected.length} source reconciliation prerequisites are not accepted.`);
  }
  const workerId = `commission-initialization-${process.pid}`;
  const verifiedQueueIds = await getCanonicalCommissionInitializationQueueIds(args.throughMonth!);
  const attempted: number[] = [];
  const rebuilt: number[] = [];
  const failures: Array<{ jobId: number; error: string }> = [];
  for (let index = 0; index < args.limit; index += 1) {
    const job = await claimCommissionInitializationRebuild({
      throughMonth: args.throughMonth!, workerId, excludeJobIds: attempted,
      rangePrerequisitesVerified: true, verifiedQueueIds,
    });
    if (!job) break;
    attempted.push(job.id);
    const result = await processCommissionInitializationDrainJob(job, {
      heartbeat: heartbeatRollupRebuild,
      rebuild: rebuildReadModelForJob,
      fail: (jobId, error, options) => failRollupRebuild(jobId, error, options),
      assertCompleted: (completedJob) => assertCommissionInitializationRebuildCompleted(completedJob, verifiedQueueIds),
      heartbeatIntervalMs: 60_000,
    });
    if (result.ok) {
      rebuilt.push(job.id);
    } else {
      failures.push({ jobId: job.id, error: result.error });
    }
  }
  console.log(JSON.stringify({ workerId, attempted: attempted.length, rebuilt, failures }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

export async function processCommissionInitializationDrainJob(
  job: RollupRebuildJob,
  dependencies: DrainJobDependencies = {
    heartbeat: heartbeatRollupRebuild,
    rebuild: rebuildReadModelForJob,
    fail: (jobId, error, options) => failRollupRebuild(jobId, error, options),
    assertCompleted: assertCommissionInitializationRebuildCompleted,
    heartbeatIntervalMs: 60_000,
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  let stopped = false;
  let wakeHeartbeat: (() => void) | undefined;
  let heartbeatError: unknown;
  let fenced = false;

  const stopHeartbeat = () => {
    stopped = true;
    wakeHeartbeat?.();
  };
  const fence = async (error: unknown) => {
    if (fenced) return;
    fenced = true;
    await dependencies.fail(job.id, error, { lockedBy: job.locked_by });
  };
  const heartbeatLoop = (async () => {
    while (!stopped) {
      await new Promise<void>((resolve) => {
        wakeHeartbeat = resolve;
        const timer = setTimeout(resolve, dependencies.heartbeatIntervalMs);
        const priorResolve = wakeHeartbeat;
        wakeHeartbeat = () => {
          clearTimeout(timer);
          priorResolve();
        };
      });
      wakeHeartbeat = undefined;
      if (stopped) break;
      try {
        await dependencies.heartbeat(job);
      } catch (error) {
        heartbeatError = error;
        try {
          await fence(error);
        } catch (fenceError) {
          heartbeatError = new AggregateError([error, fenceError], `Heartbeat and owner-fenced failure both failed for job ${job.id}.`);
        }
        break;
      }
    }
  })();

  try {
    await dependencies.heartbeat(job);
    await dependencies.rebuild(job);
    stopHeartbeat();
    await heartbeatLoop;
    if (heartbeatError) throw heartbeatError;
    await dependencies.assertCompleted(job);
    return { ok: true };
  } catch (error) {
    stopHeartbeat();
    await heartbeatLoop;
    const failure = heartbeatError ?? error;
    try {
      await fence(failure);
    } catch (fenceError) {
      return { ok: false, error: errorMessage(new AggregateError([failure, fenceError], `Failed to fence commission initialization job ${job.id}.`)) };
    }
    return { ok: false, error: errorMessage(failure) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function once(current: string | undefined, value: string, option: string): string {
  if (current !== undefined) throw new Error(`${option} may only be provided once.`);
  return value;
}

if (Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }).finally(closePostgresPool);
}

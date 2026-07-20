import { pathToFileURL } from "node:url";
import { runSimproReconciliation, type ReconciliationScope } from "@/lib/store/reconciliation";
import {
  RECONCILIATION_CADENCE_MODES,
  runReconciliationCadence,
  type ReconciliationCadenceMode,
  type ReconciliationCadenceOptions,
} from "@/lib/store/reconciliation-cadence";
import { closePostgresPool } from "@/lib/store/postgres";

export type ReconciliationWorkerArgs = {
  scope: ReconciliationScope;
  periodStart?: string;
  requestBudget: number;
  mode?: ReconciliationCadenceMode;
  batchMonths: number;
  runtimeMinutes: number;
  force: boolean;
};

type ReconciliationWorkerDependencies = {
  reconcile?: typeof runSimproReconciliation;
  runCadence?: typeof runCadencedReconciliation;
};

export async function runReconciliationWorker(
  args: ReconciliationWorkerArgs,
  dependencies: ReconciliationWorkerDependencies = {},
) {
  if (args.mode) {
    return (dependencies.runCadence ?? runCadencedReconciliation)({
      mode: args.mode,
      scope: args.scope,
      batchMonths: args.batchMonths,
      runtimeMinutes: args.runtimeMinutes,
      requestBudget: args.requestBudget,
      force: args.force,
    });
  }
  const results = await (dependencies.reconcile ?? runSimproReconciliation)({
    scope: args.scope,
    periodStart: args.periodStart,
    requestBudget: args.requestBudget,
    onlyIfNeeded: !args.force,
  });

  return {
    scope: args.scope,
    periodStart: args.periodStart ?? "current-month",
    requestBudget: args.requestBudget,
    results: results.map((result) => ({
      scope: result.scope,
      status: result.status,
      checkId: result.checkId,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      rollupValue: result.rollupValue,
      snapshotValue: result.snapshotValue,
      upstreamSampleValue: result.upstreamSampleValue,
    })),
  };
}

export async function runCadencedReconciliation(options: ReconciliationCadenceOptions) {
  return runReconciliationCadence(options);
}

export function parseReconciliationArgs(
  argv: string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReconciliationWorkerArgs {
  const args: ReconciliationWorkerArgs = {
    scope: (env.RECONCILE_SCOPE as ReconciliationScope | undefined) ?? "all",
    periodStart: env.RECONCILE_PERIOD_START,
    requestBudget: env.RECONCILE_REQUEST_BUDGET ? Number(env.RECONCILE_REQUEST_BUDGET) : 1000,
    mode: env.RECONCILE_MODE as ReconciliationCadenceMode | undefined,
    batchMonths: env.RECONCILE_BATCH_MONTHS ? Number(env.RECONCILE_BATCH_MONTHS) : 3,
    runtimeMinutes: env.RECONCILE_RUNTIME_MINUTES ? Number(env.RECONCILE_RUNTIME_MINUTES) : 20,
    force: env.RECONCILE_FORCE === "true",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scope") {
      args.scope = argv[index + 1] as ReconciliationScope;
      index += 1;
    } else if (arg === "--period-start") {
      args.periodStart = argv[index + 1];
      index += 1;
    } else if (arg === "--request-budget") {
      args.requestBudget = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--mode") {
      args.mode = argv[index + 1] as ReconciliationCadenceMode;
      index += 1;
    } else if (arg === "--batch-months") {
      args.batchMonths = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--runtime-minutes") {
      args.runtimeMinutes = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--force") {
      args.force = true;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }

  if (!["quotes", "jobs", "technicians", "commissions", "all"].includes(args.scope)) {
    throw new Error(`Invalid --scope ${args.scope}`);
  }
  if (!Number.isFinite(args.requestBudget) || args.requestBudget <= 0) {
    throw new Error("--request-budget must be a positive number.");
  }
  if (args.mode && !RECONCILIATION_CADENCE_MODES.includes(args.mode)) {
    throw new Error(`Invalid --mode ${args.mode}`);
  }
  const maximumBatchMonths = args.mode === "all-months" ? 60 : 3;
  if (!Number.isInteger(args.batchMonths) || args.batchMonths < 1 || args.batchMonths > maximumBatchMonths) {
    throw new Error(`--batch-months must be an integer from 1 through ${maximumBatchMonths}.`);
  }
  if (!Number.isFinite(args.runtimeMinutes) || args.runtimeMinutes <= 0 || args.runtimeMinutes > 20) {
    throw new Error("--runtime-minutes must be greater than 0 and no more than 20.");
  }

  return {
    ...args,
    requestBudget: Math.trunc(args.requestBudget),
  };
}

async function main() {
  const args = parseReconciliationArgs(process.argv.slice(2));
  try {
    console.log(JSON.stringify(await runReconciliationWorker(args), null, 2));
  } finally {
    await closePostgresPool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

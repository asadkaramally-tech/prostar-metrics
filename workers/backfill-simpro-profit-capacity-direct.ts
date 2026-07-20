import { requeueFailedExactTargets, runDirectProfitCapacityBackfill } from "@/lib/store/direct-profit-capacity-backfill";
import { closePostgresPool } from "@/lib/store/postgres";
import { pathToFileURL } from "node:url";

export type DirectBackfillArgs = {
  maxRequests: number;
  runtimeMinutes: number;
  concurrency: number;
  actorEmail: string;
  retryFailed: boolean;
  confirmation?: string;
};

async function main() {
  process.env.POSTGRES_POOL_IDLE_TIMEOUT_MS = "300000";
  const configuredTimeout = Number(process.env.SIMPRO_REQUEST_TIMEOUT_MS ?? 15000);
  process.env.SIMPRO_REQUEST_TIMEOUT_MS = String(Math.min(Number.isFinite(configuredTimeout) ? configuredTimeout : 15000, 15000));
  const args = parseDirectBackfillArgs(process.argv.slice(2));
  try {
    if (args.retryFailed) {
      const requeued = await requeueFailedExactTargets({
        actorEmail: args.actorEmail,
        confirmation: args.confirmation ?? "",
      });
      console.log(JSON.stringify({ mode: "failed-targets-requeued", requeued }));
    }
    const result = await runDirectProfitCapacityBackfill({
      maxRequests: args.maxRequests,
      runtimeMinutes: args.runtimeMinutes,
      concurrency: args.concurrency,
      actorEmail: args.actorEmail,
      onProgress: (progress) => console.log(JSON.stringify({ mode: "progress", ...progress })),
    });
    console.log(JSON.stringify({ mode: "finished", ...result }, null, 2));
    if (result.failed > 0 || result.remaining.failedTargets > 0) process.exitCode = 1;
  } finally {
    await closePostgresPool();
  }
}

export function parseDirectBackfillArgs(argv: string[]): DirectBackfillArgs {
  const args: DirectBackfillArgs = {
    maxRequests: Number(process.env.DIRECT_PROFIT_CAPACITY_MAX_REQUESTS ?? 5_000),
    runtimeMinutes: Number(process.env.DIRECT_PROFIT_CAPACITY_RUNTIME_MINUTES ?? 17),
    concurrency: Number(process.env.DIRECT_PROFIT_CAPACITY_CONCURRENCY ?? 5),
    actorEmail: process.env.DIRECT_PROFIT_CAPACITY_ACTOR ?? "",
    retryFailed: process.env.DIRECT_PROFIT_CAPACITY_RETRY_FAILED === "true",
    confirmation: process.env.DIRECT_PROFIT_CAPACITY_CONFIRM,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--max-requests") args.maxRequests = requiredNumber(argv, ++index, arg);
    else if (arg === "--runtime-minutes") args.runtimeMinutes = requiredNumber(argv, ++index, arg);
    else if (arg === "--concurrency") args.concurrency = requiredNumber(argv, ++index, arg);
    else if (arg === "--actor") args.actorEmail = requiredValue(argv, ++index, arg);
    else if (arg === "--retry-failed") args.retryFailed = true;
    else if (arg === "--confirm") args.confirmation = requiredValue(argv, ++index, arg);
    else throw new Error(`Unknown argument ${arg}.`);
  }
  if (!Number.isInteger(args.maxRequests) || args.maxRequests < 1 || args.maxRequests > 25_000) {
    throw new Error("--max-requests must be an integer from 1 through 25000.");
  }
  if (!Number.isInteger(args.runtimeMinutes) || args.runtimeMinutes < 1 || args.runtimeMinutes > 17) {
    throw new Error("--runtime-minutes must be an integer from 1 through 17.");
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 5) {
    throw new Error("--concurrency must be an integer from 1 through 5.");
  }
  if (!args.actorEmail.trim()) throw new Error("--actor is required.");
  if (args.retryFailed && args.confirmation !== "RETRY-SIMPRO-PROFIT-CAPACITY-028") {
    throw new Error("--retry-failed requires --confirm RETRY-SIMPRO-PROFIT-CAPACITY-028.");
  }
  return args;
}

function requiredValue(argv: string[], index: number, arg: string) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
  return value;
}

function requiredNumber(argv: string[], index: number, arg: string) {
  return Number(requiredValue(argv, index, arg));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

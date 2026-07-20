import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { replayRawSimproSnapshots } from "@/lib/store/raw-snapshot-replay";

type Args = {
  batchSize: number;
  maxItems: number;
  actorEmail?: string;
};

type Environment = Record<string, string | undefined>;

type ReplayCliDependencies = {
  env?: Environment;
  replay?: typeof replayRawSimproSnapshots;
  log?: (message: string) => void;
};

export const REPLAY_POSTGRES_IDLE_TIMEOUT_MS = 1000;

export async function runReplayCli(argv: string[], dependencies: ReplayCliDependencies = {}) {
  const env = dependencies.env ?? process.env;
  configureReplayProcessLifecycle(env);
  const args = parseArgs(argv, env);
  const log = dependencies.log ?? console.log;
  const result = await (dependencies.replay ?? replayRawSimproSnapshots)({
    batchSize: args.batchSize,
    maxItems: args.maxItems,
    actorEmail: args.actorEmail,
    onProgress: (progress) => log(JSON.stringify({ mode: "progress", ...progress })),
  });
  log(JSON.stringify({ mode: "finished", ...result }, null, 2));
  return result.failed > 0 ? 1 : 0;
}

export function configureReplayProcessLifecycle(env: Environment = process.env) {
  // This one-shot worker uses the shared lazy pool. Let pg close its idle client
  // immediately after the replay's awaited final audit write instead of forcing exit.
  env.POSTGRES_POOL_IDLE_TIMEOUT_MS = String(REPLAY_POSTGRES_IDLE_TIMEOUT_MS);
}

export function parseArgs(argv: string[], env: Readonly<Environment> = process.env): Args {
  const args: Args = {
    batchSize: Number(env.RAW_SNAPSHOT_REPLAY_BATCH_SIZE ?? 100),
    maxItems: Number(env.RAW_SNAPSHOT_REPLAY_MAX_ITEMS ?? 100_000),
    actorEmail: env.RAW_SNAPSHOT_REPLAY_ACTOR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--batch-size") args.batchSize = Number(argv[++index]);
    else if (arg === "--max-items") args.maxItems = Number(argv[++index]);
    else if (arg === "--actor") args.actorEmail = argv[++index];
    else throw new Error(`Unknown argument ${arg}.`);
  }
  return args;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  runReplayCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

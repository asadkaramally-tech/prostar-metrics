import type { IngestionEntity } from "@/lib/simpro/ingest";
import {
  boundedLimit,
  previewFailedIngestionRepair,
  requeueFailedIngestionRepair,
} from "@/lib/store/queue-repairs";

type Args = {
  execute: boolean;
  entity: IngestionEntity;
  errorContains: string;
  limit: number;
  actorEmail: string;
  reason: string;
};

const supportedEntities = new Set<IngestionEntity>([
  "quotes", "quote_logs", "quote_nested", "jobs", "job_logs", "job_nested",
  "jobs_from_timesheets", "employees", "timesheets", "schedules", "schedule_logs",
  "mobile_status",
]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.execute) {
    const preview = await previewFailedIngestionRepair(args);
    console.log(JSON.stringify({ mode: "dry-run", matches: preview.rows }, null, 2));
    return;
  }

  const repaired = await requeueFailedIngestionRepair(args);
  console.log(JSON.stringify({ mode: "execute", repaired }, null, 2));
}

export function parseArgs(argv: string[]): Args {
  const values: Record<string, string | boolean> = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") {
      values.execute = true;
      continue;
    }
    if (["--entity", "--error-contains", "--limit", "--actor-email", "--reason"].includes(arg)) {
      values[arg.slice(2)] = argv[++index] ?? "";
      continue;
    }
    throw new Error(`Unknown argument ${arg}.`);
  }

  const entity = String(values.entity ?? "");
  if (!supportedEntities.has(entity as IngestionEntity)) throw new Error("--entity must be a supported ingestion entity.");
  const errorContains = String(values["error-contains"] ?? "").trim();
  if (!errorContains) throw new Error("--error-contains is required.");
  const execute = values.execute === true;
  const actorEmail = String(values["actor-email"] ?? "").trim();
  const reason = String(values.reason ?? "").trim();
  if (execute && (!actorEmail || !reason)) throw new Error("--actor-email and --reason are required with --execute.");

  return {
    execute,
    entity: entity as IngestionEntity,
    errorContains,
    limit: boundedLimit(Number(values.limit ?? 20)),
    actorEmail,
    reason,
  };
}

if (process.env.NODE_ENV !== "test") {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }).finally(() => {
    process.exit();
  });
}

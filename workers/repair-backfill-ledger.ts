import type { BackfillSourceFamily } from "@/lib/backfill/plan";
import { pathToFileURL } from "node:url";
import {
  boundedLimit,
  previewDeadLetteredBackfillRepair,
  requeueDeadLetteredBackfillRepair,
} from "@/lib/store/queue-repairs";

type Args = {
  execute: boolean;
  sourceFamily: BackfillSourceFamily;
  monthStart: string;
  errorContains: string;
  limit: number;
  actorEmail: string;
  reason: string;
};

const supportedSources = new Set<BackfillSourceFamily>([
  "quotes", "quote_nested", "jobs", "job_nested", "employees",
  "timesheets", "jobs_from_timesheets", "schedules", "mobile_status",
]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.execute) {
    const preview = await previewDeadLetteredBackfillRepair(args);
    console.log(JSON.stringify({ mode: "dry-run", matches: preview.rows }, null, 2));
    return;
  }
  const repaired = await requeueDeadLetteredBackfillRepair(args);
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
    if (["--source-family", "--month-start", "--error-contains", "--limit", "--actor-email", "--reason"].includes(arg)) {
      values[arg.slice(2)] = argv[++index] ?? "";
      continue;
    }
    throw new Error(`Unknown argument ${arg}.`);
  }
  const sourceFamily = String(values["source-family"] ?? "");
  if (!supportedSources.has(sourceFamily as BackfillSourceFamily)) throw new Error("--source-family is not supported.");
  const monthStart = String(values["month-start"] ?? "");
  if (!/^\d{4}-\d{2}-01$/.test(monthStart)) throw new Error("--month-start must be YYYY-MM-01.");
  const errorContains = String(values["error-contains"] ?? "").trim();
  if (!errorContains) throw new Error("--error-contains is required.");
  const execute = values.execute === true;
  const actorEmail = String(values["actor-email"] ?? "").trim();
  const reason = String(values.reason ?? "").trim();
  if (execute && (!actorEmail || !reason)) throw new Error("--actor-email and --reason are required with --execute.");
  return {
    execute,
    sourceFamily: sourceFamily as BackfillSourceFamily,
    monthStart,
    errorContains,
    limit: boundedLimit(Number(values.limit ?? 5)),
    actorEmail,
    reason,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }).finally(() => process.exit());
}

import { pathToFileURL } from "node:url";
import {
  ALL_MONTHS_CURSOR_RESET_CONFIRMATION,
  resetAllMonthsReconciliationCursor,
} from "@/lib/store/reconciliation-cadence";
import { closePostgresPool } from "@/lib/store/postgres";

type Args = { actorEmail: string; confirmation: string };

export function parseResetAllMonthsArgs(argv: string[]): Args {
  const args: Args = { actorEmail: "", confirmation: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--actor") args.actorEmail = requiredValue(argv, ++index, arg);
    else if (arg === "--confirm") args.confirmation = requiredValue(argv, ++index, arg);
    else throw new Error(`Unknown argument ${arg}.`);
  }
  if (!args.actorEmail.trim()) throw new Error("--actor is required.");
  if (args.confirmation !== ALL_MONTHS_CURSOR_RESET_CONFIRMATION) {
    throw new Error(`--confirm ${ALL_MONTHS_CURSOR_RESET_CONFIRMATION} is required.`);
  }
  return args;
}

async function main() {
  const args = parseResetAllMonthsArgs(process.argv.slice(2));
  try {
    const result = await resetAllMonthsReconciliationCursor({
      actorEmail: args.actorEmail,
      confirmation: args.confirmation,
    });
    console.log(JSON.stringify({ mode: "all-months-cursor-reset", ...result }, null, 2));
  } finally {
    await closePostgresPool();
  }
}

function requiredValue(argv: string[], index: number, arg: string) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

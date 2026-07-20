import { pathToFileURL } from "node:url";
import {
  executeQuoteCategoryRebuild,
  inspectQuoteCategoryRebuild,
  QUOTE_CATEGORY_REBUILD_CONFIRMATION,
} from "@/lib/store/quote-category-rebuild";

export type ReprojectQuoteCategoryArgs = {
  execute: boolean;
  actorEmail: string;
  confirmation: string;
};

export function parseReprojectQuoteCategoryArgs(argv: string[]): ReprojectQuoteCategoryArgs {
  const args: ReprojectQuoteCategoryArgs = { execute: false, actorEmail: "", confirmation: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") args.execute = true;
    else if (arg === "--actor") args.actorEmail = requiredValue(argv, ++index, arg);
    else if (arg === "--confirm") args.confirmation = requiredValue(argv, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.execute && !args.actorEmail.trim()) throw new Error("--actor is required with --execute.");
  if (args.execute && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.actorEmail.trim())) {
    throw new Error("--actor must be a valid email address.");
  }
  if (args.execute && args.confirmation !== QUOTE_CATEGORY_REBUILD_CONFIRMATION) {
    throw new Error(`--confirm must equal ${QUOTE_CATEGORY_REBUILD_CONFIRMATION} with --execute.`);
  }
  return args;
}

export async function runReprojectQuoteCategories(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseReprojectQuoteCategoryArgs(argv);
  if (!args.execute) {
    const preview = await inspectQuoteCategoryRebuild();
    return {
      mode: "dry-run",
      confirmationToken: QUOTE_CATEGORY_REBUILD_CONFIRMATION,
      ...preview,
    };
  }
  const result = await executeQuoteCategoryRebuild({
    actorEmail: args.actorEmail,
    confirmation: args.confirmation,
  });
  return { mode: "execute", ...result };
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  runReprojectQuoteCategories(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}

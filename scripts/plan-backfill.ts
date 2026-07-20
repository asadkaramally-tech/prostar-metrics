import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  BACKFILL_START_MONTH,
  buildBackfillPlan,
  buildEstimateTemplate,
  businessCurrentMonth,
  capacityAllocation,
  parseBackfillEstimates,
} from "@/lib/backfill/plan";
import { saveApprovedBackfillPlan } from "@/lib/store/backfill-ledger";

type Args = {
  startMonth: string;
  throughMonth: string;
  dailyRequestCeiling: number;
  estimatesPath?: string;
  template: boolean;
  apply: boolean;
  approvedBy?: string;
  confirmation?: string;
  summaryOnly: boolean;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.template) {
    console.log(JSON.stringify(buildEstimateTemplate(args.startMonth, args.throughMonth), null, 2));
    return;
  }
  if (!args.estimatesPath) {
    throw new Error("--estimates is required; generate the source/month skeleton with --template.");
  }
  const estimates = parseBackfillEstimates(JSON.parse(await readFile(args.estimatesPath, "utf8")));
  const units = buildBackfillPlan({
    startMonth: args.startMonth,
    throughMonth: args.throughMonth,
    dailyRequestCeiling: args.dailyRequestCeiling,
    estimates,
  });
  const planHash = createHash("sha256").update(JSON.stringify(units)).digest("hex");
  const summary = {
    mode: args.apply ? "apply" : "preview",
    startMonth: args.startMonth,
    throughMonth: args.throughMonth,
    workUnits: units.length,
    sourceFamilies: new Set(units.map((unit) => unit.sourceFamily)).size,
    capacity: capacityAllocation(args.dailyRequestCeiling),
    estimatedRequests: units.reduce((sum, unit) => sum + unit.estimatedRequests, 0),
    planHash,
  };

  if (!args.apply && !args.summaryOnly) {
    console.log(JSON.stringify({ ...summary, units }, null, 2));
    return;
  }
  if (!args.apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (!args.approvedBy || args.confirmation !== "QUEUE-WP04") {
    throw new Error("Applying a plan requires --approved-by and --confirm QUEUE-WP04.");
  }
  const saved = await saveApprovedBackfillPlan({
    units,
    approvedBy: args.approvedBy,
    approvedAt: new Date(),
    planHash,
  });
  console.log(JSON.stringify({ ...summary, approvedBy: args.approvedBy, saved }, null, 2));
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    startMonth: monthStart(process.env.BACKFILL_START_MONTH ?? BACKFILL_START_MONTH),
    throughMonth: monthStart(process.env.BACKFILL_THROUGH_MONTH ?? businessCurrentMonth()),
    dailyRequestCeiling: Number(process.env.BACKFILL_DAILY_REQUEST_CEILING ?? 10_000),
    estimatesPath: process.env.BACKFILL_ESTIMATES_PATH,
    template: false,
    apply: false,
    approvedBy: process.env.BACKFILL_APPROVED_BY,
    confirmation: process.env.BACKFILL_CONFIRM,
    summaryOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--start") {
      args.startMonth = monthStart(argv[++index]);
    } else if (arg === "--through") {
      args.throughMonth = monthStart(argv[++index]);
    } else if (arg === "--daily-request-ceiling") {
      args.dailyRequestCeiling = Number(argv[++index]);
    } else if (arg === "--estimates") {
      args.estimatesPath = argv[++index];
    } else if (arg === "--template") {
      args.template = true;
    } else if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--approved-by") {
      args.approvedBy = argv[++index];
    } else if (arg === "--confirm") {
      args.confirmation = argv[++index];
    } else if (arg === "--summary-only") {
      args.summaryOnly = true;
    } else {
      throw new Error(`Unknown argument ${arg}.`);
    }
  }
  if (!Number.isInteger(args.dailyRequestCeiling) || args.dailyRequestCeiling < 100) {
    throw new Error("--daily-request-ceiling must be an integer of at least 100.");
  }
  return args;
}

function monthStart(value: string | undefined) {
  if (!value) throw new Error("Month value is required.");
  const normalized = /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value;
  if (!/^\d{4}-\d{2}-01$/.test(normalized)) throw new Error(`Invalid month ${value}; expected YYYY-MM.`);
  return normalized;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => {
  process.exit();
});

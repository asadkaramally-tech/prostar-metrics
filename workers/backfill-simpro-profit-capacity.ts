import {
  enqueueProfitCapacityBackfill,
  estimateProfitCapacityBackfill,
  SIMPRO_PROFIT_CAPACITY_START_MONTH,
} from "@/lib/store/simpro-profit-capacity-backfill";

const CONFIRMATION = "QUEUE-SIMPRO-PROFIT-CAPACITY-026";

type Args = {
  execute: boolean;
  startMonth: string;
  throughMonth?: string;
  approvedBy?: string;
  confirmation?: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.execute) {
    console.log(JSON.stringify({
      mode: "preview",
      estimate: await estimateProfitCapacityBackfill(args.startMonth, args.throughMonth),
      nextCommand: `rerun with --execute --approved-by <email> --confirm ${CONFIRMATION}`,
    }, null, 2));
    return;
  }
  if (!args.approvedBy || args.confirmation !== CONFIRMATION) {
    throw new Error(`Queueing requires --approved-by and --confirm ${CONFIRMATION}.`);
  }
  const result = await enqueueProfitCapacityBackfill({
    startMonth: args.startMonth,
    throughMonth: args.throughMonth,
    approvedBy: args.approvedBy,
  });
  console.log(JSON.stringify({ mode: "queued", ...result }, null, 2));
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    execute: false,
    startMonth: SIMPRO_PROFIT_CAPACITY_START_MONTH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") args.execute = true;
    else if (arg === "--start") args.startMonth = argv[++index];
    else if (arg === "--through") args.throughMonth = argv[++index];
    else if (arg === "--approved-by") args.approvedBy = argv[++index];
    else if (arg === "--confirm") args.confirmation = argv[++index];
    else throw new Error(`Unknown argument ${arg}.`);
  }
  return args;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

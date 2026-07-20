import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  BACKFILL_SOURCE_DEFINITIONS,
  BACKFILL_START_MONTH,
  backfillEstimateKey,
  businessCurrentMonth,
  type BackfillEstimate,
  type BackfillSourceFamily,
} from "@/lib/backfill/plan";

const baseline: Record<BackfillSourceFamily, BackfillEstimate> = {
  quotes: { expectedPages: 62, expectedRecords: 200, estimatedNestedRequests: 0 },
  quote_nested: { expectedPages: 0, expectedRecords: 200, estimatedNestedRequests: 5_000 },
  jobs: { expectedPages: 31, expectedRecords: 350, estimatedNestedRequests: 0 },
  job_nested: { expectedPages: 0, expectedRecords: 350, estimatedNestedRequests: 10_500 },
  employees: { expectedPages: 1, expectedRecords: 20, estimatedNestedRequests: 0 },
  timesheets: { expectedPages: 20, expectedRecords: 3_000, estimatedNestedRequests: 0 },
  jobs_from_timesheets: { expectedPages: 0, expectedRecords: 350, estimatedNestedRequests: 0 },
  schedules: { expectedPages: 2, expectedRecords: 350, estimatedNestedRequests: 0 },
  mobile_status: { expectedPages: 0, expectedRecords: 0, estimatedNestedRequests: 0 },
};

async function main() {
  const output = resolve(process.argv[2] ?? "docs/prostar-metrics/backfill/estimates-2023-current.json");
  const through = businessCurrentMonth();
  const estimates: Record<string, BackfillEstimate> = {};

  for (let month = BACKFILL_START_MONTH; month <= through; month = addMonth(month)) {
    for (const source of BACKFILL_SOURCE_DEFINITIONS) {
      estimates[backfillEstimateKey(month, source.sourceFamily)] = baseline[source.sourceFamily];
    }
  }

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(estimates, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output, start: BACKFILL_START_MONTH, through, estimates: Object.keys(estimates).length }, null, 2));
}

function addMonth(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

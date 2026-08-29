import { addMonthsToPeriodStart } from "@/lib/metrics/materials";
import { SimproClient, type RequestBudget } from "@/lib/simpro/client";
import { fetchCatalogGroup } from "@/lib/simpro/materials";
import {
  getCatalogGroupCache,
  upsertCatalogGroups,
} from "@/lib/store/materials-ingest";
import {
  importMaterialsHistoryMonth,
  loadMaterialsHistoryMonthPlan,
} from "@/lib/store/materials-history-import";
import { closePostgresPool, queryPostgres } from "@/lib/store/postgres";
import { enqueueRollupRebuild } from "@/lib/store/read-model-rebuilds";

async function main() {
  const from = monthArgument("--from");
  const to = monthArgument("--to");
  if (from > to) throw new Error("--from must not be after --to.");
  const execute = process.argv.includes("--execute");
  const includeComplete = process.argv.includes("--include-complete");
  const client = execute ? new SimproClient() : null;
  const budget: RequestBudget = { limit: integerArgument("--request-limit", 10_000), used: 0 };
  const summaries: Array<Record<string, unknown>> = [];

  try {
    for (let periodStart = from; periodStart <= to; periodStart = addMonthsToPeriodStart(periodStart, 1)) {
      const existing = await queryPostgres<{ status: string }>(
        `select status from metrics.materials_month_walks where period_start = $1::date`,
        [periodStart],
      );
      if (!includeComplete && existing.rows[0]?.status === "complete") {
        summaries.push({ periodStart, status: "skipped-complete" });
        continue;
      }

      const plan = await loadMaterialsHistoryMonthPlan(periodStart);
      if (execute) await upsertCatalogGroups(plan.embeddedCatalogGroups);
      const cached = await getCatalogGroupCache(plan.catalogIds);
      const embedded = new Set(plan.embeddedCatalogGroups.map((group) => group.catalogId));
      const unresolved = plan.catalogIds.filter((catalogId) => !cached.has(catalogId) && !embedded.has(catalogId));
      const requestStart = budget.used;
      if (execute && client) {
        const hydrated = [];
        for (const catalogId of unresolved) hydrated.push(await fetchCatalogGroup(client, catalogId, budget));
        await upsertCatalogGroups(hydrated);
        await importMaterialsHistoryMonth(plan, budget.used - requestStart);
        for (const dependent of [periodStart, addMonthsToPeriodStart(periodStart, 1), addMonthsToPeriodStart(periodStart, 12)]) {
          await enqueueRollupRebuild({
            metricFamily: "materials",
            periodStart: dependent,
            reason: `authoritative raw-snapshot materials history import ${periodStart}`,
          });
        }
      }
      summaries.push({
        periodStart,
        status: execute ? "imported" : "verified-dry-run",
        jobs: plan.jobCount,
        lines: plan.lines.length,
        catalogIds: plan.catalogIds.length,
        unresolvedCatalogIds: unresolved.length,
        catalogRequests: budget.used - requestStart,
      });
      console.log(JSON.stringify(summaries.at(-1)));
    }
    console.log(JSON.stringify({
      mode: execute ? "executed" : "verified-dry-run",
      months: summaries,
      simproRequestsUsed: budget.used,
    }, null, 2));
  } finally {
    await closePostgresPool();
  }
}

function monthArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error(`${name} must use YYYY-MM.`);
  return `${value}-01`;
}

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import { buildMaterialsCsv, materialsCsvFilename } from "@/lib/materials/csv";
import { boundedDashboardPeriodStart, periodStartToMonthKey } from "@/lib/metrics/periods";
import {
  filterMaterialsItems,
  getMaterialsReadModel,
  materialsCategoryParam,
  materialsSearchParam,
  materialsSortParam,
} from "@/lib/store/materials-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

export async function GET(request: Request) {
  try {
    assertRole(await getCurrentUser(), ["admin", "finance"]);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }

  const searchParams = new URL(request.url).searchParams;
  const periodStart = boundedDashboardPeriodStart(searchParams.get("month"));
  if (!periodStart) return new Response("month is outside the supported reporting range.", { status: 400 });
  const model = await cachedPageLoad(`api:materials:csv:${periodStart}`, 120_000, () =>
    getMaterialsReadModel(periodStart),
  );
  const monthKey = periodStartToMonthKey(model.periodStart) ?? model.periodStart.slice(0, 7);
  const priorDate = new Date(`${model.periodStart}T00:00:00Z`);
  priorDate.setUTCMonth(priorDate.getUTCMonth() - 1);
  const priorMonthShort = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(priorDate);
  const items = filterMaterialsItems(model.items, {
    q: materialsSearchParam(searchParams.get("q")),
    category: materialsCategoryParam(searchParams.get("category")),
    sort: materialsSortParam(searchParams.get("sort")),
  });
  return new Response(buildMaterialsCsv(items, model.comparison.columnLabel, priorMonthShort), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${materialsCsvFilename(monthKey)}"`,
      "cache-control": "private, no-store",
    },
  });
}

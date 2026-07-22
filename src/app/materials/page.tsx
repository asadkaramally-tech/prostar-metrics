import { notFound } from "next/navigation";
import { DashboardPage } from "@/components/dashboard-page";
import { MaterialsDashboard } from "@/components/materials-dashboard";
import { PeriodSelector } from "@/components/period-selector";
import { boundedDashboardPeriodStart, DASHBOARD_HISTORY_START } from "@/lib/metrics/periods";
import { addMonthsToPeriodStart } from "@/lib/metrics/materials";
import {
  getMaterialsPageReadModel,
  getMaterialsTrend,
  materialsCategoryParam,
  materialsPageParam,
  materialsSearchParam,
  materialsSortParam,
} from "@/lib/store/materials-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

export default async function MaterialsPage({
  searchParams,
}: {
  searchParams?: Promise<{ month?: string; page?: string; q?: string; category?: string; sort?: string }>;
}) {
  const params = await searchParams;
  const periodStart = boundedDashboardPeriodStart(params?.month);
  if (!periodStart) notFound();
  const page = materialsPageParam(params?.page);
  const itemOptions = {
    page,
    q: materialsSearchParam(params?.q),
    category: materialsCategoryParam(params?.category),
    sort: materialsSortParam(params?.sort),
  };
  const model = await cachedPageLoad(`materials:${periodStart}:items:${JSON.stringify(itemOptions)}`, 120_000, () =>
    getMaterialsPageReadModel(periodStart, itemOptions),
  );
  const trendPeriods: string[] = [];
  for (
    let month = DASHBOARD_HISTORY_START;
    month <= periodStart;
    month = addMonthsToPeriodStart(month, 1)
  ) {
    trendPeriods.push(month);
  }
  const trend = await cachedPageLoad(`materials:trend:${periodStart}`, 120_000, () =>
    getMaterialsTrend(trendPeriods),
  );

  return (
    <DashboardPage
      title="Materials"
      description="Sales, change drivers, and job-level material review."
      freshness={model.freshness}
      controls={<PeriodSelector action="/materials" value={model.periodStart.slice(0, 7)} />}
    >
      <MaterialsDashboard model={model} trend={trend} />
    </DashboardPage>
  );
}

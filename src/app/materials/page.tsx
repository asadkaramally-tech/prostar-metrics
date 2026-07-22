import { notFound } from "next/navigation";
import { DashboardPage } from "@/components/dashboard-page";
import { MaterialsDashboard } from "@/components/materials-dashboard";
import { PeriodSelector } from "@/components/period-selector";
import { boundedDashboardPeriodStart } from "@/lib/metrics/periods";
import { addMonthsToPeriodStart } from "@/lib/metrics/materials";
import {
  getMaterialsPageReadModel,
  getMaterialsTrend,
  materialsPageParam,
} from "@/lib/store/materials-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

export default async function MaterialsPage({
  searchParams,
}: {
  searchParams?: Promise<{ month?: string; page?: string }>;
}) {
  const params = await searchParams;
  const periodStart = boundedDashboardPeriodStart(params?.month);
  if (!periodStart) notFound();
  const page = materialsPageParam(params?.page);
  const model = await cachedPageLoad(`materials:${periodStart}:page:${page}`, 120_000, () =>
    getMaterialsPageReadModel(periodStart, page),
  );
  const trendPeriods = Array.from({ length: 13 }, (_, index) => addMonthsToPeriodStart(periodStart, index - 12))
    .filter((month) => month >= "2023-01-01");
  const trend = await cachedPageLoad(`materials:trend:${periodStart}`, 120_000, () =>
    getMaterialsTrend(trendPeriods),
  );

  return (
    <DashboardPage
      title="Material Sales"
      description="Materials billed on completed jobs — volume, value and category mix."
      freshness={model.freshness}
      controls={<PeriodSelector action="/materials" value={model.periodStart.slice(0, 7)} />}
    >
      <MaterialsDashboard model={model} trend={trend} />
    </DashboardPage>
  );
}

import { DashboardPage } from "@/components/dashboard-page";
import { MaterialsDashboard } from "@/components/materials-dashboard";
import { PeriodSelector } from "@/components/period-selector";
import { monthParamToPeriodStart } from "@/lib/metrics/periods";
import { getMaterialsPageReadModel, materialsPageParam } from "@/lib/store/materials-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

export default async function MaterialsPage({
  searchParams,
}: {
  searchParams?: Promise<{ month?: string; page?: string }>;
}) {
  const params = await searchParams;
  const periodStart = monthParamToPeriodStart(params?.month);
  const page = materialsPageParam(params?.page);
  const model = await cachedPageLoad(`materials:${periodStart ?? "current"}:page:${page}`, 120_000, () =>
    getMaterialsPageReadModel(periodStart, page),
  );

  return (
    <DashboardPage
      title="Material Sales"
      description="Materials billed on completed jobs — volume, value and category mix."
      freshness={model.freshness}
      controls={<PeriodSelector action="/materials" value={model.periodStart.slice(0, 7)} />}
    >
      <MaterialsDashboard model={model} />
    </DashboardPage>
  );
}

import { DashboardPage } from "@/components/dashboard-page";
import { JobsDashboard } from "@/components/jobs-dashboard";
import { PeriodSelector } from "@/components/period-selector";
import { monthParamToPeriodStart, periodStartToMonthKey } from "@/lib/metrics/periods";
import { getJobDashboardReadModel } from "@/lib/store/job-dashboard-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

export default async function JobsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    month?: string;
    category?: string;
    costCenter?: string;
    technician?: string;
    jobPage?: string;
    states?: string;
  }>;
}) {
  const params = await searchParams;
  const periodStart = monthParamToPeriodStart(params?.month);
  const jobQuery = {
    selectedMonth: periodStartToMonthKey(periodStart),
    category: params?.category,
    costCenter: params?.costCenter,
    technician: params?.technician,
    page: Number(params?.jobPage),
  };
  const model = await cachedPageLoad(`jobs:${JSON.stringify(jobQuery)}`, 120_000, () =>
    getJobDashboardReadModel(jobQuery),
  );

  return (
    <DashboardPage
      title="Job Metrics"
      description="Revenue, profit and outcomes for completed work."
      freshness={model.freshness}
      controls={<PeriodSelector action="/jobs" value={model.selectedMonth} />}
    >
      <JobsDashboard model={model} showStates={params?.states === "1"} />
    </DashboardPage>
  );
}

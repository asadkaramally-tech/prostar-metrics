import { DashboardPage } from "@/components/dashboard-page";
import { TodayDashboard } from "@/components/today-dashboard";
import { getTodayReadModel } from "@/lib/store/today-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

/**
 * /today — live completed-job profitability for the current Pacific business
 * date. Data is always read from the app-owned PostgreSQL serving store.
 */
export default async function TodayPage({
  searchParams,
}: {
  searchParams?: Promise<{ states?: string }>;
}) {
  const params = await searchParams;
  const model = await cachedPageLoad("today", 60_000, () => getTodayReadModel());

  return (
    <DashboardPage
      title="Today's Profitability"
      description="Live revenue, gross profit and net profit as today’s completed jobs arrive."
      freshness={model.freshness.jobs}
    >
      <TodayDashboard model={model} showStates={params?.states === "1"} />
    </DashboardPage>
  );
}

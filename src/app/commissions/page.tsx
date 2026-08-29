import { notFound } from "next/navigation";
import { CommissionsDashboard } from "@/components/commissions-dashboard";
import { DashboardPage } from "@/components/dashboard-page";
import { getCurrentUser } from "@/lib/auth/roles";
import { parseCommissionDashboardPeriod } from "@/lib/commissions/period";
import { getCommissionDashboardReadModel } from "@/lib/store/commissions-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

export default async function CommissionsPage({
  searchParams,
}: {
  searchParams?: Promise<{ year?: string; month?: string; summaryYear?: string; states?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user.roles.some((role) => role === "admin" || role === "finance")) {
    notFound();
  }
  const params = await searchParams;
  const period = parseCommissionDashboardPeriod(params ?? {});
  if (!period) notFound();
  const { year, month, summaryYear } = period;
  const model = await cachedPageLoad(`commissions:${year}-${month}:${summaryYear ?? ""}`, 120_000, () =>
    getCommissionDashboardReadModel({ year, month, summaryYear, includeAllocationDetails: false }),
  );

  return (
    <DashboardPage
      title="Technician Commissions"
      description="Calculated amounts only — nothing on this page confirms that a payment was made."
      freshness={model.freshness}
    >
      <CommissionsDashboard model={model} showStates={params?.states === "1"} />
    </DashboardPage>
  );
}

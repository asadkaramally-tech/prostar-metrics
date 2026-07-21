import { notFound } from "next/navigation";
import { CommissionsDashboard } from "@/components/commissions-dashboard";
import { DashboardPage } from "@/components/dashboard-page";
import { getCurrentUser } from "@/lib/auth/roles";
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
  const today = new Date();
  const { year, month, summaryYear } = parsePeriodParams(params, today);
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

function parsePeriodParams(
  params: { year?: string; month?: string; summaryYear?: string } | undefined,
  today: Date,
) {
  const monthParam = params?.month;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const [selectedYear, selectedMonth] = monthParam.split("-").map(Number);
    return {
      year: selectedYear,
      month: selectedMonth,
      summaryYear: parseInt(params?.summaryYear ?? String(selectedYear), 10),
    };
  }

  const year = parseInt(params?.year ?? String(today.getFullYear()), 10);
  const month = parseInt(monthParam ?? String(today.getMonth() + 1), 10);
  return {
    year,
    month,
    summaryYear: parseInt(params?.summaryYear ?? String(year), 10),
  };
}

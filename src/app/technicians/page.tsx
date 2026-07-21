import { DashboardPage } from "@/components/dashboard-page";
import { PeriodSelector } from "@/components/period-selector";
import { TechniciansDashboard } from "@/components/technicians-dashboard";
import { businessCurrentMonth } from "@/lib/backfill/plan";
import { monthParamToPeriodStart, periodStartToMonthKey } from "@/lib/metrics/periods";
import { getDashboardReadModel } from "@/lib/store/dashboard-read-models";
import { cachedPageLoad } from "@/lib/store/page-cache";

/**
 * /technicians — month-scoped, per the approved
 * APPROVED-2026-07-15/mockups/technicians.html. Server component: reads the
 * technician read model and hands the typed payload to the client dashboard.
 * `?states=1` renders the design-reference state strip (mockup gate).
 */
export default async function TechniciansPage({
  searchParams,
}: {
  searchParams?: Promise<{ month?: string; states?: string }>;
}) {
  const params = await searchParams;
  const periodStart = monthParamToPeriodStart(params?.month) ?? businessCurrentMonth();
  const model = await cachedPageLoad(`technicians:${periodStart}`, 120_000, () =>
    getDashboardReadModel("technicians", { periodStart, compactTechnicianDetails: true }),
  );
  const selectedMonth = monthFromPayload(model.payload)
    ?? periodStartToMonthKey(periodStart)
    ?? periodStart.slice(0, 7);
  const rosterCount = rosterCountFromPayload(model.payload);

  return (
    <DashboardPage
      title="Technician Performance"
      description={
        rosterCount
          ? `Capacity, productive time, efficiency and punctuality across the ${rosterCount}-technician roster.`
          : "Capacity, productive time, efficiency and punctuality across the verified technician roster."
      }
      freshness={model.freshness}
      controls={
        <PeriodSelector
          action="/technicians"
          value={selectedMonth}
          hiddenFields={{ states: params?.states }}
        />
      }
    >
      <TechniciansDashboard model={model} showStates={params?.states === "1"} />
    </DashboardPage>
  );
}

type Payload = Awaited<ReturnType<typeof getDashboardReadModel>>["payload"];

function monthFromPayload(payload: Payload) {
  if (!payload || !("periodStart" in payload) || typeof payload.periodStart !== "string") {
    return undefined;
  }
  return periodStartToMonthKey(payload.periodStart);
}

/** Active effective-roster size for the header sub — server-side structural
 *  read; the client dashboard applies its own full contract guard. */
function rosterCountFromPayload(payload: Payload): number | null {
  if (!payload || !("technicians" in payload) || !Array.isArray(payload.technicians)) return null;
  if (!("rosterApplied" in payload) || payload.rosterApplied !== true) return null;
  const count = payload.technicians.filter((tech) => tech.archived !== true).length;
  return count > 0 ? count : null;
}

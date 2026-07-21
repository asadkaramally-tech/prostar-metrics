import { DashboardPage } from "@/components/dashboard-page";
import { MonthStepper, formatMonthKey, shiftMonthKey } from "@/components/period-selector";
import { TodayDashboard } from "@/components/today-dashboard";
import type { FreshnessStatus } from "@/lib/metrics/freshness";
import { getTodayReadModel } from "@/lib/store/today-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

/**
 * /today — legacy live-month metrics route. It is intentionally no longer in
 * primary navigation; the durable operating surfaces are the monthly Jobs,
 * Quotes, Technicians, and Commissions pages.
 */
export default async function TodayPage({
  searchParams,
}: {
  searchParams?: Promise<{ states?: string }>;
}) {
  const params = await searchParams;
  const model = await cachedPageLoad("today", 60_000, () => getTodayReadModel());
  const priorMonthKey = shiftMonthKey(model.month, -1);
  const monthLong = monthLongName(model.month);
  const priorLong = monthLongName(priorMonthKey);

  return (
    <DashboardPage
      title="Today"
      description={`${monthLong} in progress — live pace against ${priorLong} and last ${monthLong}.`}
      freshness={combineFreshness(model.freshness.jobs, model.freshness.quotes)}
      controls={
        <MonthStepper
          label="Live month"
          prevHref={`/jobs?month=${priorMonthKey}`}
          prevTitle={`${formatMonthKey(priorMonthKey)} — see the monthly dashboards`}
          nextTitle={`${monthLong} is the live month`}
        >
          {formatMonthKey(model.month)} · through {shortDate(model.asOfDate)}
        </MonthStepper>
      }
    >
      <TodayDashboard model={model} showStates={params?.states === "1"} />
    </DashboardPage>
  );
}

/** One truthful pill for two sources: the worse state wins and the "Updated"
 *  timestamp is the older successful run, so the pill never overstates. */
function combineFreshness(jobs: FreshnessStatus, quotes: FreshnessStatus): FreshnessStatus {
  const severity: Record<FreshnessStatus["state"], number> = {
    current: 0,
    partial: 1,
    building: 2,
    stale: 3,
    suspect: 4,
    failed: 5,
    missing: 6,
  };
  const worse = severity[quotes.state] > severity[jobs.state] ? quotes : jobs;
  const older = olderIso(jobs.lastSuccessfulRunAt, quotes.lastSuccessfulRunAt);
  return {
    ...worse,
    pageKey: "today",
    lastSuccessfulRunAt: older,
    detail: `Jobs: ${jobs.detail} Quotes: ${quotes.detail}`,
  };
}

function olderIso(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function monthLongName(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function shortDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

import { DashboardPage } from "@/components/dashboard-page";
import { PeriodSelector } from "@/components/period-selector";
import { QuoteMetricsDashboard } from "@/components/quotes/quote-metrics-dashboard";
import { monthParamToPeriodStart, periodStartToMonthKey } from "@/lib/metrics/periods";
import { getQuoteMetricsReadModel } from "@/lib/store/quote-dashboard-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

/**
 * /quotes — month-scoped Quote Metrics per the approved
 * docs/approved-design/mockups/quotes.html. Server component: reads the
 * quote read model and hands the typed payload to the client dashboard.
 * Deep-link params mirror the retained review gates (?states=1,
 * ?mode=volume). The Overview/History tabs are removed — the Monthly
 * Breakdown is always present, so ?history=1 no longer exists.
 */
export default async function QuotesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const periodStart = monthParamToPeriodStart(firstParam(params?.month));
  const selectedMonth = periodStartToMonthKey(periodStart);
  const model = await cachedPageLoad(`quotes:${selectedMonth}`, 120_000, () =>
    getQuoteMetricsReadModel({ selectedMonth }),
  );

  return (
    <DashboardPage
      title="Quote Metrics"
      description="Quote activity, acceptance, status mix and value trend."
      freshness={model.freshness}
      controls={<PeriodSelector action="/quotes" value={model.selectedMonth} hiddenFields={{
        states: firstParam(params?.states), mode: firstParam(params?.mode),
      }} />}
    >
      <QuoteMetricsDashboard
        model={model}
        showStates={firstParam(params?.states) === "1"}
        initialTrendVolume={firstParam(params?.mode) === "volume"}
      />
    </DashboardPage>
  );
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

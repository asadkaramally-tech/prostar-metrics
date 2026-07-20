import { getRollups, type RollupScope, type RollupRow } from "@/lib/store/rollups";
import { getPageFreshness } from "@/lib/store/freshness";
import { getLatestReadModelPayload, type ReadModelPayload } from "@/lib/store/read-model-rebuilds";
import type { FreshnessStatus } from "@/lib/metrics/freshness";
import type { TechnicianPerformanceReadModel } from "@/lib/metrics/technicians";

export type DashboardReadModel = {
  scope: RollupScope;
  freshness: FreshnessStatus;
  rollups: RollupRow[];
  payload: ReadModelPayload | null;
  kpis: Array<{ label: string; value: string; detail?: string }>;
  warnings: string[];
};

const metricLabels: Record<RollupScope, Record<string, string>> = {
  quotes: {
    quote_count: "Quotes",
    won_count: "Won quotes",
    total_value: "Quote value",
    won_value: "Won value",
    win_rate_count: "Win rate by count",
  },
  jobs: {
    completed_job_count: "Completed jobs",
    sell_value: "Total billed value",
    average_job_value: "Average job value",
    gross_profit: "Gross profit",
    gross_margin: "Gross margin",
  },
  technicians: {
    completed_job_credit: "Completed job credit",
    allocated_sell_value: "Allocated sell value",
    actual_hours: "Actual job hours",
    labor_efficiency: "Labor efficiency",
    on_time_rate: "On-time rate",
  },
  commissions: {
    completed_jobs: "Completed jobs",
    total_work_value: "Total work value",
    commission_pool: "Commission pool",
    active_technicians: "Active technicians",
  },
};

export async function getDashboardReadModel(scope: RollupScope, options: { periodStart?: string } = {}): Promise<DashboardReadModel> {
  const freshnessPromise = getPageFreshness(scope, options.periodStart);

  try {
    const [freshness, latestPayload, rollups] = await Promise.all([
      freshnessPromise,
      getLatestReadModelPayload(scope, options.periodStart),
      getRollups(scope, options.periodStart ? 100 : 24, options.periodStart),
    ]);
    const payload = latestPayload?.values_json ?? null;
    return {
      scope,
      freshness,
      rollups,
      payload,
      kpis: payload ? buildPayloadKpis(scope, payload) : buildKpis(scope, rollups),
      warnings: buildWarnings(scope, rollups, payload),
    };
  } catch (error) {
    const freshness = await freshnessPromise;
    return {
      scope,
      freshness,
      rollups: [],
      payload: null,
      kpis: [],
      warnings: [error instanceof Error ? error.message : "Unable to read app-owned rollups."],
    };
  }
}

function buildKpis(scope: RollupScope, rollups: RollupRow[]) {
  const latestPeriod = rollups[0]?.period_start;
  if (!latestPeriod) {
    return [];
  }

  const latest = rollups.filter((row) => row.period_start === latestPeriod);
  return latest.slice(0, 5).map((row) => ({
    label: metricLabels[scope][row.metric_key] ?? row.metric_key,
    value: formatMetric(row.metric_key, row.metric_value),
    detail: row.provisional ? "Provisional period" : `${row.source_snapshot_count} source snapshots`,
  }));
}

function buildPayloadKpis(scope: RollupScope, payload: ReadModelPayload) {
  if (scope === "quotes" && "quoteCount" in payload) {
    return [
      { label: "Quotes", value: formatMetric("quote_count", payload.quoteCount), detail: payload.dateBasis },
      { label: "Quote value", value: formatMetric("total_value", payload.quoteValue), detail: `${payload.excludedWithoutDateApproved} without DateApproved` },
      { label: "Won quotes", value: formatMetric("won_count", payload.wonCount), detail: `${payload.overrideCount} overrides applied` },
      { label: "Win rate by count", value: formatMetric("win_rate_count", payload.winRateByCount), detail: "DateApproved basis" },
    ];
  }

  if (scope === "jobs" && "completedJobCount" in payload) {
    return [
      { label: "Completed jobs", value: formatMetric("completed_job_count", payload.completedJobCount), detail: "Stage: Complete or Archived" },
      { label: "Total billed value", value: formatMetric("sell_value", payload.totalSellValue), detail: `${payload.grossMarginCoverage.fromSimproTotals} margin totals` },
      { label: "Gross profit", value: formatMetric("gross_profit", payload.grossProfitActual), detail: "Simpro Totals preferred" },
      { label: "Labor coverage", value: formatMetric("coverage", payload.laborAccuracy.includedJobs), detail: `${payload.laborAccuracy.eligibleQuoteSourcedJobs} quote-sourced jobs` },
    ];
  }

  if (scope === "technicians" && isTechnicianPayload(payload)) {
    const allocatedSellValue = payload.technicians.reduce((sum, tech) => sum + tech.allocatedSellValue, 0);
    const jobHours = payload.coverage.jobHours ?? 0;
    const adjustedCapacity = payload.coverage.adjustedCapacityHours ?? 0;
    return [
      { label: "Technicians", value: formatMetric("count", payload.technicians.length), detail: `${payload.coverage.jobsWithTimesheets} jobs with timesheets` },
      { label: "Allocated sell value", value: formatMetric("allocated_sell_value", allocatedSellValue), detail: "Credit shared by hours" },
      { label: "Adjusted capacity", value: formatMetric("hours", adjustedCapacity), detail: `${payload.coverage.grossCapacityHours ?? 0} gross hours before leave` },
      { label: "Job utilization", value: formatMetric("utilization", adjustedCapacity > 0 ? jobHours / adjustedCapacity * 100 : 0), detail: `${jobHours} work-date job hours` },
      { label: "Mobile coverage", value: formatMetric("coverage", payload.coverage.mobileStatusCoveredJobs), detail: `${payload.coverage.totalJobs} completed jobs` },
    ];
  }

  if (scope === "commissions" && "poolAmount" in payload) {
    return [
      { label: "Completed jobs", value: formatMetric("completed_jobs", payload.completedJobs), detail: `${payload.coverage.jobsWithoutTimesheets} without timesheets` },
      { label: "Total work value", value: formatMetric("total_work_value", payload.totalWorkValue), detail: "Timesheet-supported jobs" },
      { label: "Commission pool", value: formatMetric("commission_pool", payload.poolAmount), detail: "Default 0.5%" },
      { label: "Active technicians", value: formatMetric("active_technicians", payload.activeTechnicians), detail: "Roster + allocation" },
    ];
  }

  return [];
}

function isTechnicianPayload(payload: ReadModelPayload): payload is TechnicianPerformanceReadModel {
  return (
    "technicians" in payload &&
    "coverage" in payload &&
    "totalJobs" in payload.coverage &&
    payload.technicians.every((tech) => "allocatedSellValue" in tech && "actualJobHours" in tech)
  );
}

function buildWarnings(scope: RollupScope, rollups: RollupRow[], payload: ReadModelPayload | null) {
  const warnings: string[] = [];
  if (rollups.length === 0 && !payload) {
    warnings.push("No app-owned rollups have been built for this dashboard yet.");
  }

  if (scope === "jobs" && payload && "completedJobCount" in payload) {
    if (payload.completedJobCount > 0 && payload.grossMarginCoverage.fromSimproTotals === 0) {
      warnings.push("No completed jobs have Simpro gross-margin totals for the selected period.");
    }
    if (payload.laborAccuracy.eligibleQuoteSourcedJobs > 0 && payload.laborAccuracy.includedJobs === 0) {
      warnings.push("Quote-sourced jobs exist, but none have both quoted and actual labor hours for labor accuracy.");
    }
  }

  if (scope === "technicians" && payload && isTechnicianPayload(payload)) {
    if (payload.coverage.totalJobs > 0 && payload.coverage.jobsWithTimesheets === 0) {
      warnings.push("No completed jobs have timesheet coverage for technician allocation.");
    }
    if (payload.coverage.totalJobs > 0 && payload.coverage.scheduleCoveredJobs === 0) {
      warnings.push("No completed jobs have schedule coverage for planned-vs-actual metrics.");
    }
    if (payload.coverage.totalJobs > 0 && payload.coverage.mobileStatusCoveredJobs === 0) {
      warnings.push("No completed jobs have mobile-status coverage for on-time metrics.");
    }
    if (payload.coverage.totalJobs > 0 && payload.coverage.jobsWithQuotedLabor === 0) {
      warnings.push("No completed quote-generated or recurring jobs have labor-hour coverage for labor efficiency.");
    }
    if ((payload.coverage.adjustedCapacityHours ?? 0) === 0) warnings.push("No adjusted technician capacity is available for the selected period.");
  }

  if (scope === "commissions" && !payload) {
    warnings.push("Efficiency calculation must be backed by quote-job labor linkage before it can affect commission results.");
  }

  return warnings;
}

function formatMetric(metricKey: string, value: string | number) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value);
  }

  if (metricKey.includes("value") || metricKey.includes("profit") || metricKey.includes("pool")) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(number);
  }

  if (metricKey.includes("rate") || metricKey.includes("margin") || metricKey.includes("efficiency")) {
    return `${number.toFixed(1)}%`;
  }

  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(number);
}

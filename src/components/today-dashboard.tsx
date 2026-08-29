"use client";

import { useEffect, useState } from "react";
import { fmt, TrendChart, type TrendSeries } from "@/components/charts";
import {
  KpiBand,
  KpiBandNote,
  KpiTile,
  KpiTiles,
  PrimaryStatCard,
} from "@/components/band";
import {
  Card,
  CardBody,
  DefTooltipProvider,
  Fnote,
  Skel,
  StateEmpty,
  StateError,
  StateMini,
  StatesStrip,
} from "@/components/reset";
import type { TodayDashboardReadModel } from "@/lib/store/today-read-model";

export type TodayDashboardProps = {
  model: TodayDashboardReadModel;
  showStates?: boolean;
};

export function TodayDashboard({ model, showStates }: TodayDashboardProps) {
  const [liveModel, setLiveModel] = useState(model);
  useEffect(() => {
    const refresh = async () => {
      const response = await fetch("/api/today", { cache: "no-store" });
      if (!response.ok) return;
      setLiveModel(await response.json() as TodayDashboardReadModel);
    };
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <DefTooltipProvider>
      {liveModel.loadError ? <TodayLoadError detail={liveModel.loadError} /> : <TodayContent model={liveModel} />}
      <StatesStrip show={showStates}>
        <StateMini label="Loading">
          <Skel width="55%" />
          <Skel width="85%" />
          <Skel width="70%" />
        </StateMini>
        <StateMini label="Quiet morning">
          <StateEmpty>No jobs have been completed today yet. The screen will fill in as completions arrive.</StateEmpty>
        </StateMini>
        <StateMini label="Partial / stale">
          <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
            <span className="pill warn" style={{ height: 32 }}>
              <span className="dot" />Updated 3 hrs ago
            </span>
            <StateEmpty>Figures stay visible with an as-of note.</StateEmpty>
          </div>
        </StateMini>
        <StateMini label="Error">
          <StateError>The app-owned profitability feed could not be loaded.</StateError>
        </StateMini>
      </StatesStrip>
      <div className="footline">
        Source: app-owned PostgreSQL serving models populated by bounded Simpro workers · Pacific business date · refreshes every minute
      </div>
    </DefTooltipProvider>
  );
}

function TodayLoadError({ detail }: { detail: string }) {
  return (
    <Card>
      <CardBody>
        <StateError onRetry={() => window.location.reload()}>
          Today&apos;s profitability feed could not be loaded. <span className="sr-only">{detail}</span>
        </StateError>
      </CardBody>
    </Card>
  );
}

function TodayContent({ model }: { model: TodayDashboardReadModel }) {
  const daily = model.today;
  const revenueCovered = daily.revenueCoveredJobs === daily.completedJobs;
  const grossCovered = daily.grossProfitCoveredJobs === daily.completedJobs;
  const netCovered = daily.netProfitCoveredJobs === daily.completedJobs;

  return (
    <>
      <KpiBand ariaLabel="Today's completed-job profitability">
        <PrimaryStatCard
          label="Net profit today"
          labelDef="Σ Simpro NetProfit Actual for jobs whose CompletedDate is today in Pacific time and whose stage is Complete or Archived."
          value={netCovered ? fmt.moneyFull(daily.netProfit) : "N/A"}
          sub={daily.netMargin !== null ? `${daily.netMargin.toFixed(1)}% net margin` : "net margin unavailable"}
        />
        <KpiTiles>
          <KpiTile
            label="Revenue"
            value={revenueCovered ? fmt.moneyFull(daily.revenue) : "N/A"}
            sub={daily.averageJobValue !== null ? `avg ${fmt.moneyFull(daily.averageJobValue)}` : "no completions yet"}
          />
          <KpiTile
            label="Gross profit"
            value={grossCovered ? fmt.moneyFull(daily.grossProfit) : "N/A"}
            sub={daily.grossMargin !== null ? `${daily.grossMargin.toFixed(1)}% gross margin` : "gross margin unavailable"}
          />
          <KpiTile
            label="Completed jobs"
            value={String(daily.completedJobs)}
            sub={`Pacific date ${formatBusinessDate(model.asOfDate)}`}
          />
          <KpiTile
            label="Net-negative jobs"
            value={String(daily.netNegativeJobs)}
            sub={daily.netNegativeJobs > 0 ? `${fmt.moneyFull(daily.netNegativeTotal)} total` : "none today"}
            alert={daily.netNegativeJobs > 0}
          />
        </KpiTiles>
      </KpiBand>
      <KpiBandNote>
        Auto-refreshes every minute. Source workers currently poll completed jobs on their bounded schedule; the freshness pill shows the latest verified load. Profit values remain N/A unless every completed job has the required Simpro financial field.
      </KpiBandNote>

      <TodayJobsCard model={model} />

      <div className="g3">
        <EconomicsMiniCard model={model} />
        <VolumeMiniCard model={model} />
        <CapacityMiniCard model={model} />
      </div>
      <div className="grid12">
        <PaceCard model={model} names={[
          seriesName(model.sameDayComparisons.priorYearSameMonth.month),
          seriesName(model.sameDayComparisons.priorMonth.month),
          seriesName(model.month),
        ]} />
      </div>
    </>
  );
}

function TodayJobsCard({ model }: { model: TodayDashboardReadModel }) {
  const jobs = model.today.jobs;
  return (
    <Card
      title="Today's Completed Jobs"
      subtitle={`${jobs.length} ${jobs.length === 1 ? "job" : "jobs"} completed on ${formatBusinessDate(model.asOfDate)} · newest source updates first`}
      footer="CompletedDate assigns the business day; stage must be Complete or Archived. Net profit is Simpro NetProfit Actual."
    >
      {jobs.length === 0 ? (
        <CardBody><StateEmpty>No jobs have been completed today yet.</StateEmpty></CardBody>
      ) : (
        <div className="tblwrap">
          <table>
            <thead><tr><th>Job</th><th className="hide-sm">Site</th><th className="num">Revenue</th><th className="num hide-sm">Gross</th><th className="num">Net</th><th className="num">Net margin</th></tr></thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.jobId}>
                  <td><div className="id1">{job.name}</div><div className="id2">Job {job.jobNo}</div></td>
                  <td className="hide-sm">{job.siteName}</td>
                  <td className="num tnum">{job.sellValue !== null ? fmt.moneyFull(job.sellValue) : "N/A"}</td>
                  <td className="num tnum hide-sm">{job.grossProfit !== null ? fmt.moneyFull(job.grossProfit) : "N/A"}</td>
                  <td className="num tnum" style={job.netProfit !== null && job.netProfit < 0 ? { color: "var(--down)", fontWeight: 700 } : undefined}>{job.netProfit !== null ? fmt.moneyFull(job.netProfit) : "N/A"}</td>
                  <td className="num tnum">{job.netMargin !== null ? `${job.netMargin.toFixed(1)}%` : "N/A"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function formatBusinessDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

function PaceCard({ model, names }: { model: TodayDashboardReadModel; names: [string, string, string] }) {
  const labels = Array.from({ length: model.daysInMonth }, (_, i) => String(i + 1));
  const series: TrendSeries[] = [
    { name: names[0], color: "#c9cfda", dash: "4 4", values: fillMonth(model.dailyCumulativeRevenue.priorYearSameMonth.days, model.daysInMonth), tipFmt: fmt.money },
    { name: names[1], color: "#9aa2b2", values: fillMonth(model.dailyCumulativeRevenue.priorMonth.days, model.daysInMonth), tipFmt: fmt.money },
    { name: names[2], color: "#5b63d3", star: true, fill: true, values: fillMonth(model.dailyCumulativeRevenue.currentMonth.days, model.daysInMonth, model.elapsedDays), tipFmt: fmt.money },
  ];
  return (
    <Card
      className="span12"
      style={{ marginTop: 0 }}
      title="Cumulative Revenue Pace"
      subtitle={`Day ${model.elapsedDays} · same-day cumulative revenue`}
    >
      <CardBody>
        <TrendChart
          labels={labels}
          series={series}
          everyX={3}
          h={318}
          band={Math.max(model.elapsedDays - 1, 0)}
          bandLabel={`Day ${model.elapsedDays} · ${fmt.money(model.mtd.revenue)}`}
          yFmt={fmt.money}
        />
        <Fnote>
          This is a pace view only: monthly decisions live on the Jobs, Quotes, Technicians, and Commissions pages.
        </Fnote>
      </CardBody>
    </Card>
  );
}

function EconomicsMiniCard({ model }: { model: TodayDashboardReadModel }) {
  const revenue = Math.max(model.mtd.revenue, 0);
  const net = model.mtd.netProfit;
  const cost = revenue - net;
  const netPct = revenue > 0 ? Math.max(0, Math.min(100, (net / revenue) * 100)) : 0;
  return (
    <Card title="Revenue to Net" subtitle="MTD completed-work economics">
      <CardBody>
        <div className="compact-bridge">
          <span className="compact-bridge-fill" style={{ width: `${netPct}%` }} />
        </div>
        <div className="compact-split">
          <b>{fmt.moneyFull(net)} net</b>
          <span>{fmt.moneyFull(Math.max(cost, 0))} cost / overhead</span>
        </div>
      </CardBody>
    </Card>
  );
}

function VolumeMiniCard({ model }: { model: TodayDashboardReadModel }) {
  return (
    <Card title="Work Volume" subtitle="MTD count and size">
      <CardBody>
        <div className="mini-metric-row">
          <span>Completed jobs</span>
          <b className="tnum">{model.mtd.jobsCount}</b>
        </div>
        <div className="mini-metric-row">
          <span>Avg job value</span>
          <b className="tnum">{model.mtd.avgJobValue !== null ? fmt.moneyFull(model.mtd.avgJobValue) : "—"}</b>
        </div>
        <div className="mini-metric-row">
          <span>Quotes sent</span>
          <b className="tnum">{model.mtd.quotesSent}</b>
        </div>
      </CardBody>
    </Card>
  );
}

function CapacityMiniCard({ model }: { model: TodayDashboardReadModel }) {
  const pct = model.mtd.mtdCapacityHours > 0 ? (model.mtd.teamRecordedHours / model.mtd.mtdCapacityHours) * 100 : null;
  return (
    <Card title="Team Capacity" subtitle={`${model.mtd.rosterSize} technicians`}>
      <CardBody>
        <div className="compact-meter">
          <span style={{ width: `${Math.min(Math.max(pct ?? 0, 0), 130) / 1.3}%` }} />
        </div>
        <div className="compact-split">
          <b>{pct !== null ? `${Math.round(pct)}% used` : "—"}</b>
          <span>{fmt.hrs(model.mtd.teamRecordedHours)} of {fmt.hrs(model.mtd.mtdCapacityHours)}</span>
        </div>
      </CardBody>
    </Card>
  );
}

function fillMonth(
  days: Array<{ day: number; cumulativeRevenue: number }>,
  daysInMonth: number,
  cutoff?: number,
): Array<number | null> {
  const values = new Array<number | null>(daysInMonth).fill(null);
  for (const point of days) {
    if (cutoff !== undefined && point.day > cutoff) continue;
    values[point.day - 1] = point.cumulativeRevenue;
  }
  return values;
}

function monthName(monthKey: string, width: "short" | "long"): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: width, timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function seriesName(monthKey: string): string {
  return `${monthName(monthKey, "short")} ’${monthKey.slice(2, 4)}`;
}

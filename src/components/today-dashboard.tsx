"use client";

import { fmt, TrendChart, type TrendSeries } from "@/components/charts";
import {
  Card,
  CardBody,
  Chipd,
  Def,
  DefTooltipProvider,
  DCell,
  DGrid,
  Fnote,
  Focal,
  FocalCov,
  FocalLabel,
  FocalMeta,
  FocalValue,
  Hero,
  Mgn,
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
  return (
    <DefTooltipProvider>
      {model.loadError ? <TodayLoadError detail={model.loadError} /> : <TodayContent model={model} />}
      <StatesStrip show={showStates}>
        <StateMini label="Loading">
          <Skel width="55%" />
          <Skel width="85%" />
          <Skel width="70%" />
        </StateMini>
        <StateMini label="Quiet morning">
          <StateEmpty>No completions yet today; the pace chart holds the last available cumulative point.</StateEmpty>
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
          <StateError>Live Simpro pull failed.</StateError>
        </StateMini>
      </StatesStrip>
      <div className="footline">
        Source: Simpro · live month-to-date figures under the monthly pages’ cohort rules · comparisons are same-day-count
      </div>
    </DefTooltipProvider>
  );
}

function TodayLoadError({ detail }: { detail: string }) {
  return (
    <Card>
      <CardBody>
        <StateError onRetry={() => window.location.reload()}>
          Live Simpro pull failed. <span className="sr-only">{detail}</span>
        </StateError>
      </CardBody>
    </Card>
  );
}

function TodayContent({ model }: { model: TodayDashboardReadModel }) {
  const { mtd } = model;
  const monthLong = monthName(model.month, "long");
  const monthShort = monthName(model.month, "short");
  const priorMonthKey = model.sameDayComparisons.priorMonth.month;
  const priorYearKey = model.sameDayComparisons.priorYearSameMonth.month;
  const priorLong = monthName(priorMonthKey, "long");
  const curSeriesName = seriesName(model.month);
  const priorMonthSeriesName = seriesName(priorMonthKey);
  const priorYearSeriesName = seriesName(priorYearKey);
  const day = model.elapsedDays;
  const margin = mtd.revenue > 0 ? (mtd.netProfit / mtd.revenue) * 100 : null;
  const capacityPct = mtd.mtdCapacityHours > 0 ? (mtd.teamRecordedHours / mtd.mtdCapacityHours) * 100 : null;

  return (
    <>
      <Hero split>
        <Focal style={{ paddingBottom: 24 }}>
          <FocalLabel>
            <Def def={`Completed-job revenue from ${monthShort} 1 through ${day}, using the Jobs page completion cohort rule.`}>
              Revenue
            </Def>
            {" · "}
            {monthLong} to date
          </FocalLabel>
          <FocalValue>{fmt.moneyFull(mtd.revenue)}</FocalValue>
          <FocalMeta>
            <Mgn>
              {fmt.moneyFull(mtd.netProfit)} net{margin !== null ? ` · ${margin.toFixed(1)}% margin` : ""}
            </Mgn>
            <DeltaChip current={mtd.revenue} prior={model.sameDayComparisons.priorYearSameMonth.cumulativeRevenue} label={priorYearSeriesName} day={day} />
            <DeltaChip current={mtd.revenue} prior={model.sameDayComparisons.priorMonth.cumulativeRevenue} label={priorMonthSeriesName} day={day} />
          </FocalMeta>
          <DGrid>
            <DCell
              label="Completed Jobs"
              def={`Jobs completed ${monthShort} 1 through ${day}.`}
              value={String(mtd.jobsCount)}
              s={mtd.avgJobValue !== null ? `avg ${fmt.moneyFull(mtd.avgJobValue)}` : "none yet"}
            />
            <DCell
              label="Quotes Sent"
              def={mtd.quotesSentBasis}
              value={String(mtd.quotesSent)}
              s={`${fmt.moneyFull(mtd.quotesSentValue)} total`}
            />
            <DCell
              label="Pool So Far"
              def={`${mtd.poolPercent.toFixed(2)}% of completed-work value to date.`}
              value={fmt.cents(mtd.poolSoFar)}
              s={`${mtd.poolPercent.toFixed(2)}% rate`}
            />
            <DCell
              label="Team Hours"
              def={`${mtd.capacityRule} MTD capacity = ${fmt.hrs(mtd.mtdCapacityHours)}.`}
              value={fmt.hrs(mtd.teamRecordedHours)}
              s={capacityPct !== null ? `${Math.round(capacityPct)}% of cap` : "no capacity basis"}
              sStyle={capacityPct !== null && capacityPct > 100 ? { color: "#e6c07a" } : undefined}
            />
          </DGrid>
          <FocalCov style={{ paddingTop: 14 }}>
            Day {day} of {model.daysInMonth} · same-day comparisons use {priorLong} and {priorYearSeriesName}
          </FocalCov>
        </Focal>
        <PaceCard model={model} names={[priorYearSeriesName, priorMonthSeriesName, curSeriesName]} />
      </Hero>

      <div className="g3">
        <EconomicsMiniCard model={model} />
        <VolumeMiniCard model={model} />
        <CapacityMiniCard model={model} />
      </div>
    </>
  );
}

function DeltaChip({ current, prior, label, day }: { current: number; prior: number; label: string; day: number }) {
  if (prior <= 0) return <Chipd tone="neutral">no {label} day-{day} basis</Chipd>;
  const pct = ((current - prior) / prior) * 100;
  return (
    <Chipd tone={pct >= 0 ? "up" : "dn"}>
      {pct >= 0 ? "↑" : "↓"} {Math.abs(pct).toFixed(1)}% vs {label} · day {day}
    </Chipd>
  );
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

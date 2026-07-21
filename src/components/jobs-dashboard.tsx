"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  fmt,
  LineChart,
  tipHide,
  tipRow,
  tipShow,
  tipTitle,
  type LineAnnotation,
  type LineRefline,
  type LineSeries,
  type WaterfallStep,
} from "@/components/charts";
import {
  BarList,
  BarListRow,
  Dpill,
  KpiBand,
  KpiBandNote,
  KpiTile,
  KpiTiles,
  moneyK,
  PrimaryStatCard,
  SegBar,
  type SegBarSegment,
} from "@/components/band";
import {
  Card,
  CardBody,
  Def,
  DefTooltipProvider,
  DNote,
  Drawer,
  DSec,
  Fnote,
  KV,
  KVCell,
  MetricPicker,
  Seg,
  Skel,
  SrcPill,
  StateEmpty,
  StateError,
  StateMini,
  StatesStrip,
  type MetricChip,
} from "@/components/reset";
import {
  type JobDrilldownRow,
  type JobSourceType,
} from "@/lib/metrics/jobs";
import { csvCell } from "@/lib/csv";
import type { JobDashboardReadModel } from "@/lib/store/job-dashboard-read-model";

/* /jobs — implements the owner-approved redesign
   docs/approved-design/mockups/jobs.html exactly, with every figure taken
   from the read-model payload (the mockup's July numbers are sample
   content). Composition: KPI band (NET PROFIT primary + gross / calculated
   expenses / calculated overhead / revenue tiles + chain footnote) →
   Monthly Trend as TWO stacked single-axis panels ($ + margin-% strip) →
   [Where Revenue Went above Work Source Mix] beside [Estimated vs Actual
   Labor above Largest Overruns] → span-12 Profitability by Site → Completed
   Jobs table. The net-negative card/tile is REMOVED per owner ruling — loss
   records stay reachable through the completed-jobs table rows. */

const ACC = "#5b63d3"; /* var(--acc) */
const SERIES2 = "#0e9aae"; /* var(--series-2) */

const CLIENT_PAGE_SIZE = 10;
const FIRST_AVAILABLE_MONTH = "2023-01";

export type JobsDashboardProps = {
  model: JobDashboardReadModel;
  /** Renders the design-reference state strip (mockups' ?states=1 gate). */
  showStates?: boolean;
};

export function JobsDashboard({ model, showStates }: JobsDashboardProps) {
  return (
    <DefTooltipProvider>
      {model.loadError ? (
        <JobsLoadError detail={model.loadError} />
      ) : model.selected.completedJobCount === 0 ? (
        <JobsEmptyMonth model={model} />
      ) : (
        <JobsContent model={model} />
      )}
      <StatesStrip show={showStates}>
        <StateMini label="Loading">
          <Skel width="55%" />
          <Skel width="85%" />
          <Skel width="70%" />
        </StateMini>
        <StateMini label="Empty month">
          <StateEmpty>No jobs were completed in this month.</StateEmpty>
        </StateMini>
        <StateMini label="Partial / stale">
          <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
            <span className="pill warn" style={{ height: 32 }}>
              <span className="dot" />Updated 3 hrs ago
            </span>
            <StateEmpty>Header pill turns amber; charts stay visible with an as-of note.</StateEmpty>
          </div>
        </StateMini>
        <StateMini label="Error">
          <StateError>Job data could not be loaded.</StateError>
        </StateMini>
      </StatesStrip>
      <div className="footline">
        Source: Simpro completed jobs · Pacific-time months · net profit = Simpro NetProfit Actual
      </div>
    </DefTooltipProvider>
  );
}

function JobsLoadError({ detail }: { detail: string }) {
  return (
    <Card>
      <CardBody>
        <StateError onRetry={() => window.location.reload()}>
          Job data could not be loaded. <span className="sr-only">{detail}</span>
        </StateError>
      </CardBody>
    </Card>
  );
}

function JobsEmptyMonth({ model }: { model: JobDashboardReadModel }) {
  return (
    <>
      <Card>
        <CardBody>
          <StateEmpty>No jobs were completed in this month.</StateEmpty>
        </CardBody>
      </Card>
      <div className="grid12">
        <TrendCard model={model} />
      </div>
    </>
  );
}

/* ── Full month layout ─────────────────────────────────── */

type SourceRow = JobDashboardReadModel["selected"]["jobSourceRows"][number];

type DrawerState =
  | { kind: "job"; row: JobDrilldownRow }
  | { kind: "source"; row: SourceRow }
  | { kind: "prof"; mode: "site" | "category"; label: string; jobs: number; sell: number; np: number };

function JobsContent({ model }: { model: JobDashboardReadModel }) {
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [drill, setDrill] = useState<{ kind: "site" | "category"; label: string; epoch: number } | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);
  const monthLong = monthLongName(model.selectedMonth);
  const cohort = useFullCohort(model);
  const openDrill = useCallback((kind: "site" | "category", label: string) => {
    setDrawer(null);
    setDrill((prev) => ({ kind, label, epoch: (prev?.epoch ?? 0) + 1 }));
    void cohort.load().catch(() => undefined);
    tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [cohort]);

  return (
    <>
      <JobsBand model={model} />

      <div className="grid12">
        <TrendCard model={model} />
      </div>

      <div className="grid12">
        <div className="span6 colstack">
          <RevenueWentCard model={model} />
          <WorkSourceCard model={model} onOpen={(row) => setDrawer({ kind: "source", row })} />
        </div>
        <div className="span6 colstack">
          <LaborCard model={model} cohort={cohort} />
          <OverrunsCard model={model} />
        </div>
      </div>

      <div className="grid12">
        <ProfitabilityCard model={model} onOpen={(state) => setDrawer(state)} />
      </div>

      <div ref={tableRef}>
        <CompletedJobsCard
          key={drill ? `drill-${drill.epoch}` : "base"}
          model={model}
          cohort={cohort}
          initialCategory={drill?.kind === "category" ? drill.label : "all"}
          site={drill?.kind === "site" ? drill.label : null}
          onClearSite={() => setDrill(null)}
          onOpen={(row) => setDrawer({ kind: "job", row })}
        />
      </div>

      <Drawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        ariaLabel="Detail"
        title={drawerTitle(drawer)}
        sub={drawerSub(drawer, monthLong, model.selectedMonth)}
      >
        {drawer?.kind === "job" ? <JobDrawerBody row={drawer.row} /> : null}
        {drawer?.kind === "source" ? <SourceDrawerBody row={drawer.row} /> : null}
        {drawer?.kind === "prof" ? (
          <ProfDrawerBody
            state={drawer}
            totalNet={model.selected.netProfitActual}
            monthLong={monthLong}
            onDrill={openDrill}
          />
        ) : null}
      </Drawer>
    </>
  );
}

function drawerTitle(drawer: DrawerState | null): ReactNode {
  if (!drawer) return null;
  if (drawer.kind === "prof") return drawer.label;
  if (drawer.kind === "source") return drawer.row.sourceType;
  return drawer.row.name;
}

function drawerSub(drawer: DrawerState | null, monthLong: string, selectedMonth: string): ReactNode {
  if (!drawer) return null;
  if (drawer.kind === "prof") {
    return `${monthLong} ${selectedMonth.slice(0, 4)} · ${drawer.jobs} completed ${drawer.jobs === 1 ? "job" : "jobs"}`;
  }
  if (drawer.kind === "source") {
    return `${monthLong} ${selectedMonth.slice(0, 4)} · ${drawer.row.jobs} completed ${drawer.row.jobs === 1 ? "job" : "jobs"}`;
  }
  return `Job ${drawer.row.jobId} · ${drawer.row.siteName}`;
}

/* ── Row 1: KPI band ───────────────────────────────────── */

function JobsBand({ model }: { model: JobDashboardReadModel }) {
  const selected = model.selected;
  const coverage = selected.financialCoverage;
  const monthLong = monthLongName(model.selectedMonth);
  const provisional = model.provisional.active;
  const day = model.provisional.elapsedDays;
  const monShort = monthShortName(model.selectedMonth);
  const lyName = seriesLabel(shiftMonthKey(model.selectedMonth, -12));
  const priorName = seriesLabel(shiftMonthKey(model.selectedMonth, -1));
  const priorShort = monthShortName(shiftMonthKey(model.selectedMonth, -1));
  const priorYearAvailable = shiftMonthKey(model.selectedMonth, -12) >= FIRST_AVAILABLE_MONTH;
  const priorMonthAvailable = shiftMonthKey(model.selectedMonth, -1) >= FIRST_AVAILABLE_MONTH;
  const comparison = Object.fromEntries(model.comparisons.map((row) => [row.key, row]));
  const netRow = comparison.netProfit;
  const netPriorYear = priorYearAvailable ? netRow?.priorYear ?? null : null;
  const netPriorMonth = priorMonthAvailable ? netRow?.priorMonth ?? null : null;
  const netSupported = coverage.netProfitSupported > 0;
  const revSupported = coverage.sellValueSupported > 0;
  const grossSupported = coverage.grossProfitSupported > 0;
  const netMargin = selected.netMarginActual;
  const steps = netSupported && revSupported
    ? buildBridgeSteps(selected.profitBridge, selected.grossProfitActual, selected.netProfitActual, false)
    : null;
  const materials = steps?.[1]?.value ?? null;
  const labor = steps?.[2]?.value ?? null;
  const overhead = steps?.[4]?.value ?? null;
  const lyDef = provisional ? `vs ${lyName}, aligned to day ${day}` : `vs ${lyName}, full month`;
  const priorDef = `vs ${priorShort}, full month`;
  const netDef = `Σ Simpro NetProfit Actual across jobs completed in ${monthLong} (CompletedDate sets the month; stage must be Complete or Archived — job status is never used, and Invoiced is not completion). Commission actuals are treated as cost inputs only.`;

  return (
    <>
      <KpiBand ariaLabel={`${monthLong} key metrics`}>
        <PrimaryStatCard
          href="#trend"
          label="Net profit"
          labelDef={netDef}
          pills={
            <>
              {deltaPill(priorYearAvailable ? netRow?.priorYearDelta : null, lyName, lyDef)}
              {deltaPill(priorMonthAvailable ? netRow?.priorMonthDelta : null, priorShort, priorDef)}
            </>
          }
          value={netSupported ? fmt.moneyFull(selected.netProfitActual) : "N/A"}
          sub={
            netMargin != null ? (
              <>{netMargin.toFixed(1)}% net margin</>
            ) : (
              "net margin unavailable"
            )
          }
          bullet={
            netSupported
              ? {
                  value: selected.netProfitActual,
                  m1: { label: `${lyName} · ${provisional ? `d${day}` : "full"}`, value: netPriorYear, ghost: priorYearAvailable ? "no run" : "unavailable" },
                  m2: { label: `${priorName} · full`, value: netPriorMonth, ghost: priorMonthAvailable ? "no run" : "unavailable" },
                  fmt: moneyK,
                  ariaLabel: `Net profit ${provisional ? "month to date" : monthLong} ${moneyK(selected.netProfitActual)}${
                    netPriorYear != null ? `; ticks mark ${lyName} ${moneyK(netPriorYear)}` : ""
                  }${netPriorMonth != null ? ` and full ${priorName} ${moneyK(netPriorMonth)}` : ""}`,
                }
              : null
          }
        />
        <KpiTiles>
          <KpiTile
            label="Gross profit"
            labelDef={`Σ Simpro GrossProfit Actual across the ${monthLong} completed cohort. Margin = gross profit ÷ revenue.`}
            pills={deltaPill(priorYearAvailable ? comparison.grossProfit?.priorYearDelta : null, lyName, lyDef)}
            value={grossSupported ? fmt.moneyFull(selected.grossProfitActual) : "N/A"}
            sub={selected.grossMarginActual != null ? `${selected.grossMarginActual.toFixed(1)}% margin` : "gross margin unavailable"}
          />
          <KpiTile
            label="Calculated expenses"
            labelDef={`Materials + labor cost actuals across the ${monthLong} cohort, display-rounded so revenue − expenses = gross exactly (largest-remainder split of the rounded revenue→gross gap).`}
            value={materials != null && labor != null ? fmt.moneyFull(materials + labor) : "N/A"}
            sub={
              materials != null && labor != null
                ? `materials ${fmt.moneyFull(materials)} · labor ${fmt.moneyFull(labor)}`
                : "no supported cost basis"
            }
          />
          <KpiTile
            label="Calculated overhead"
            labelDef={`Gross − net for the ${monthLong} cohort. The overhead step includes overhead, commission cost inputs and any residual, so the chain always closes.`}
            value={overhead != null ? fmt.moneyFull(overhead) : "N/A"}
            sub="gross − overhead = net"
          />
          <KpiTile
            label="Revenue"
            labelDef={`Σ Simpro job Total (ex-tax) across the ${monthLong} completed cohort — CompletedDate in ${monthLong}, stage Complete or Archived.`}
            pills={deltaPill(priorYearAvailable ? comparison.sellValue?.priorYearDelta : null, lyName, lyDef)}
            value={revSupported ? fmt.moneyFull(selected.totalSellValue) : "N/A"}
            sub={
              <>
                {selected.completedJobCount} completed {selected.completedJobCount === 1 ? "job" : "jobs"}
                {selected.averageJobValue != null && revSupported ? ` · avg ${fmt.moneyFull(selected.averageJobValue)}` : ""}
              </>
            }
          />
        </KpiTiles>
      </KpiBand>
      <KpiBandNote>
        {provisional
          ? `Vs ${lyName} comparisons are day-aligned through ${monShort} ${day} (“d${day}”); vs ${priorShort} compares the full month. The tiles chain: revenue − expenses = gross · gross − overhead = net.`
          : "All vs-comparisons are full-month. The tiles chain: revenue − expenses = gross · gross − overhead = net."}
      </KpiBandNote>
    </>
  );
}

/** Labeled percent delta pill; null when there is no comparison basis. */
function deltaPill(delta: number | null | undefined, vsLabel: string, def?: string): ReactNode {
  if (delta == null) return null;
  return (
    <Dpill tone={delta < 0 ? "down" : delta > 0 ? "up" : "neutral"} def={def}>
      {delta < 0 ? "↓" : "↑"} {Math.abs(delta).toFixed(1)}% vs {vsLabel}
    </Dpill>
  );
}

/* ── Row 2: Monthly Trend (stacked single-axis panels) ─── */

type TrendMetric = {
  key: string;
  label: string;
  color: string;
  unit?: "pct" | "count";
  values: (number | null)[];
  /** Profit-derived metrics carry the representative provenance footnote. */
  repr: boolean;
};

/** Metric-picker semantics: yoy is exclusive both ways, minimum one chip,
 *  cap four via shift. Mixed units are allowed — they render as stacked
 *  single-axis panels (never a shared or hidden dual axis). */
export function nextTrendSelection(sel: string[], key: string): string[] {
  if (key === "yoy") return sel.includes("yoy") ? ["np", "nm"] : ["yoy"];
  if (sel.includes("yoy")) return [key];
  if (sel.includes(key)) return sel.length > 1 ? sel.filter((k) => k !== key) : sel;
  const out = [...sel, key];
  while (out.length > 4) out.shift();
  return out;
}

function TrendCard({ model }: { model: JobDashboardReadModel }) {
  const [sel, setSel] = useState<string[]>(["np", "nm"]);
  const t = model.trends;
  const metrics = useMemo<TrendMetric[]>(
    () => [
      { key: "rev", label: "Revenue", color: "#404a60", values: t.map((r) => r.sellValue), repr: false },
      { key: "gp", label: "Gross profit", color: "#9aa2b2", values: t.map((r) => r.grossProfit), repr: true },
      { key: "np", label: "Net profit", color: ACC, values: t.map((r) => r.netProfit), repr: true },
      { key: "ajv", label: "Avg job value", color: "#6d7890", values: t.map((r) => r.avgJobValue), repr: false },
      { key: "gm", label: "Gross margin %", color: "#b98b3f", unit: "pct", values: t.map((r) => r.grossMargin), repr: true },
      { key: "nm", label: "Net margin %", color: SERIES2, unit: "pct", values: t.map((r) => r.netMargin), repr: true },
      { key: "jobs", label: "Completed jobs", color: "#5f6b83", unit: "count", values: t.map((r) => r.completedJobs), repr: false },
    ],
    [t],
  );
  if (t.length === 0) {
    return (
      <Card className="span12" title="Monthly Trend" subtitle="No served history for this selection.">
        <CardBody>
          <StateEmpty>No monthly history is available.</StateEmpty>
        </CardBody>
      </Card>
    );
  }

  const curYY = model.selectedMonth.slice(2, 4);
  const prevYY = String(Number(curYY) - 1).padStart(2, "0");
  const groups: MetricChip[][] = [
    metrics.slice(0, 4).map(chipOf),
    metrics.slice(4, 6).map(chipOf),
    metrics.slice(6).map(chipOf),
    [{ key: "yoy", label: `Net ’${prevYY} vs ’${curYY}`, color: "#c9cfda" }],
  ];
  const rangeLabel = `${seriesLabel(t[0].month)} – ${seriesLabel(t[t.length - 1].month)}`;

  return (
    <Card
      className="span12"
      style={{ scrollMarginTop: 70 }}
      title={<span id="trend">Monthly Trend</span>}
      subtitle={`${rangeLabel} · pick up to four metrics · hover or tap for detail`}
      aside={
        <MetricPicker
          style={{ padding: 0, justifyContent: "flex-end" }}
          groups={groups}
          selected={sel}
          onToggle={(key) => setSel(nextTrendSelection(sel, key))}
        />
      }
    >
      <CardBody>
        <div data-primary-viz="">
        <TrendBody model={model} metrics={metrics} sel={sel} />
      </div>
      </CardBody>
    </Card>
  );
}

const chipOf = (m: TrendMetric): MetricChip => ({ key: m.key, label: m.label, color: m.color });

/** Sparse x labels mirroring the approved ML array: every other month, the
 *  first (and each January) with its year, the last always kept. */
function sparseLabels(monthKeys: string[]): string[] {
  const n = monthKeys.length;
  return monthKeys.map((key, i) => {
    if (i % 2 !== 0 && i !== n - 1) return "";
    return i === 0 || key.endsWith("-01") ? seriesLabel(key) : monthShortName(key);
  });
}

function niceMoneyMax(v: number): number {
  if (v <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / step) * step;
}

function TrendBody({ model, metrics, sel }: { model: JobDashboardReadModel; metrics: TrendMetric[]; sel: string[] }) {
  const t = model.trends;
  if (sel.includes("yoy")) return <YoYTrend model={model} />;

  const selIdx = t.findIndex((row) => row.month === model.selectedMonth);
  const labels = sparseLabels(t.map((r) => r.month));
  const full = t.map((r) => seriesLabel(r.month));
  const drawn = metrics.filter((m) => sel.includes(m.key));
  const moneyDrawn = drawn.filter((m) => m.unit == null);
  const pctDrawn = drawn.filter((m) => m.unit === "pct");
  const countDrawn = drawn.filter((m) => m.unit === "count");
  const anyRepr = t.some((row) => row.provenance === "representative") && drawn.some((m) => m.repr);
  const mfmt = (unit: "pct" | "count" | undefined, v: number) =>
    unit === "pct" ? v.toFixed(1) + "%" : unit === "count" ? fmt.n(v) : fmt.money(v);

  /* One tooltip for every panel: the month plus every drawn metric. */
  const tip = (i: number) =>
    tipTitle(full[i]) +
    drawn
      .map((m) => {
        const v = m.values[i];
        return v == null ? "" : tipRow(m.color, m.label, mfmt(m.unit, v));
      })
      .join("") +
    (i >= 12
      ? drawn
          .map((m) => {
            const v = m.values[i - 12];
            return v == null ? "" : tipRow("#e2e6ec", `${m.label} · ${full[i - 12]}`, mfmt(m.unit, v));
          })
          .join("")
      : "");

  /* Only months that actually completed work can be annotated — an empty
     month's $0 is absence of data, not a slowdown or a record. */
  const activeOnly = (value: number | null, i: number) => (t[i].completedJobs > 0 ? value : null);

  const panels: ReactNode[] = [];

  if (moneyDrawn.length > 0) {
    const vals = moneyDrawn.flatMap((m) => m.values).filter((v): v is number => v != null);
    const ymax = niceMoneyMax(Math.max(0, ...vals));
    const ymin = Math.min(0, ...vals) < 0 ? -niceMoneyMax(Math.abs(Math.min(0, ...vals))) : 0;
    const npIdx = moneyDrawn.findIndex((m) => m.key === "np");
    const revIdx = moneyDrawn.findIndex((m) => m.key === "rev");
    const reflines: LineRefline[] = [];
    const netPriorYearFull = model.comparisons.find((r) => r.key === "netProfit")?.priorYearFull;
    if (npIdx >= 0 && netPriorYearFull != null && netPriorYearFull > ymin && netPriorYearFull < ymax) {
      reflines.push({
        v: netPriorYearFull,
        text: `${seriesLabel(shiftMonthKey(model.selectedMonth, -12))} · ${fmt.money(netPriorYearFull)} — same month last year`,
        anchor: "start",
      });
    }
    const annotations: LineAnnotation[] = [];
    if (npIdx >= 0) {
      const netVals = moneyDrawn[npIdx].values.map((v, i) => activeOnly(v, i));
      const maxIdx = argBest(netVals, (a, b) => a > b);
      const minIdx = argBest(netVals, (a, b) => a < b);
      if (maxIdx >= 0 && maxIdx !== selIdx) {
        annotations.push({ s: npIdx, i: maxIdx, text: `${full[maxIdx]} · ${fmt.money(t[maxIdx].netProfit)}\nhigh`, dy: -24, anchor: "middle" });
      }
      if (minIdx >= 0 && minIdx !== selIdx && minIdx !== maxIdx) {
        annotations.push({
          s: npIdx,
          i: minIdx,
          text: `${fmt.money(t[minIdx].netProfit)} net\n${monthShortName(t[minIdx].month)} slowdown`,
          dy: 30,
          anchor: "middle",
        });
      }
      if (selIdx >= 0 && model.selected.financialCoverage.netProfitSupported > 0) {
        annotations.push({
          s: npIdx,
          i: selIdx,
          text: `${monthShortName(model.selectedMonth)} · ${fmt.money(t[selIdx].netProfit)} net`,
          dy: -14,
          dx: -4,
          anchor: "end",
        });
      }
    } else if (revIdx >= 0) {
      const revVals = moneyDrawn[revIdx].values.map((v, i) => activeOnly(v, i));
      const maxIdx = argBest(revVals, (a, b) => a > b);
      if (maxIdx >= 0 && maxIdx !== selIdx) {
        annotations.push({
          s: revIdx,
          i: maxIdx,
          text: `${fmt.money(t[maxIdx].sellValue)} revenue\nbest month on record`,
          dy: -24,
          anchor: "middle",
        });
      }
    }
    const onlyPanel = pctDrawn.length === 0 && countDrawn.length === 0;
    panels.push(
      <LineChart
        key="money"
        labels={labels}
        series={moneyDrawn.map((m): LineSeries => ({ name: m.label, vals: m.values, color: m.color, width: 2 }))}
        h={onlyPanel ? 300 : 210}
        ymin={ymin}
        ymax={ymax}
        ticks={4}
        yFmt={fmt.money}
        reflines={reflines}
        annotations={annotations}
        xlabels={onlyPanel ? undefined : false}
        tip={tip}
        ariaLabel={`${moneyDrawn.map((m) => m.label).join(", ")} by month, dollars`}
      />,
    );
  }

  if (pctDrawn.length > 0) {
    const vals = pctDrawn.flatMap((m) => m.values).filter((v): v is number => v != null);
    const lo = Math.max(0, Math.floor((Math.min(100, ...vals) - 5) / 10) * 10);
    const hi = Math.min(100, Math.ceil((Math.max(0, ...vals) + 5) / 10) * 10);
    const firstPanel = panels.length === 0;
    const lastPanel = countDrawn.length === 0;
    if (!firstPanel) {
      panels.push(
        <div key="pcthead" className="striphead">
          <span className="sl">{pctDrawn.map((m) => m.label).join(" · ")}</span>
          <span className="sn">own axis — mixed-unit picks always split into stacked panels, never share a $ axis</span>
        </div>,
      );
    }
    panels.push(
      <LineChart
        key="pct"
        labels={labels}
        series={pctDrawn.map((m): LineSeries => ({ name: m.label, vals: m.values, color: m.color, width: 2 }))}
        h={firstPanel ? 300 : 96}
        ymin={lo}
        ymax={hi}
        ticks={firstPanel ? 4 : 2}
        yFmt={(v) => v + "%"}
        xlabels={lastPanel ? undefined : false}
        tip={tip}
        ariaLabel={`${pctDrawn.map((m) => m.label).join(", ")} by month, percent`}
      />,
    );
  }

  if (countDrawn.length > 0) {
    const vals = countDrawn.flatMap((m) => m.values).filter((v): v is number => v != null);
    const ymax = niceMoneyMax(Math.max(1, ...vals));
    const firstPanel = panels.length === 0;
    if (!firstPanel) {
      panels.push(
        <div key="counthead" className="striphead">
          <span className="sl">Completed jobs</span>
          <span className="sn">own count axis</span>
        </div>,
      );
    }
    panels.push(
      <LineChart
        key="count"
        labels={labels}
        series={countDrawn.map((m): LineSeries => ({ name: m.label, vals: m.values, color: m.color, width: 2 }))}
        h={firstPanel ? 300 : 96}
        ymax={ymax}
        ticks={firstPanel ? 4 : 2}
        yFmt={fmt.n}
        tip={tip}
        ariaLabel="Completed jobs by month"
      />,
    );
  }

  const fnote: ReactNode = (
    <>
      {pctDrawn.length > 0 && moneyDrawn.length > 0
        ? `${pctDrawn.map((m) => m.label).join(" and ")} is drawn on its own panel below the $ chart · `
        : ""}
      {anyRepr ? (
        <>
          Profit and margin series are <span className="repr">representative</span> pending Simpro verification — revenue
          and job counts are Simpro-verified for all {t.length} months.
        </>
      ) : (
        <>Revenue and job counts are verified against Simpro for all {t.length} months.</>
      )}
    </>
  );

  return (
    <>
      {panels}
      <Fnote>{fnote}</Fnote>
    </>
  );
}

function YoYTrend({ model }: { model: JobDashboardReadModel }) {
  const t = model.trends;
  const curYear = model.selectedMonth.slice(0, 4);
  const prevYear = String(Number(curYear) - 1);
  const prior = new Array<number | null>(12).fill(null);
  const cur = new Array<number | null>(12).fill(null);
  let anyRepr = false;
  for (const row of t) {
    const m = Number(row.month.slice(5)) - 1;
    if (row.month.startsWith(prevYear)) {
      prior[m] = row.netProfit;
      if (row.provenance === "representative") anyRepr = true;
    }
    if (row.month.startsWith(curYear) && row.month <= model.selectedMonth) {
      cur[m] = row.netProfit;
      if (row.provenance === "representative") anyRepr = true;
    }
  }
  const M12 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const band = Number(model.selectedMonth.slice(5)) - 1;
  const vals = [...prior, ...cur].filter((v): v is number => v != null);
  const ymax = niceMoneyMax(Math.max(0, ...vals));
  const ymin = Math.min(0, ...vals) < 0 ? -niceMoneyMax(Math.abs(Math.min(0, ...vals))) : 0;
  const annotations: LineAnnotation[] = [];
  if (cur[band] != null) {
    annotations.push({
      s: 1,
      i: band,
      text: `${M12[band]} ’${curYear.slice(2)} · ${fmt.money(cur[band] as number)}`,
      dy: -14,
      anchor: band >= 9 ? "end" : "middle",
    });
  }
  return (
    <>
      <LineChart
        labels={M12}
        series={[
          { name: `Net ’${prevYear.slice(2)}`, vals: prior, color: "#c9cfda", width: 2 },
          { name: `Net ’${curYear.slice(2)}`, vals: cur, color: ACC, width: 2 },
        ]}
        h={300}
        ymin={ymin}
        ymax={ymax}
        ticks={4}
        yFmt={fmt.money}
        annotations={annotations}
        tip={(i) =>
          tipTitle(M12[i]) +
          (prior[i] != null ? tipRow("#c9cfda", `Net ’${prevYear.slice(2)}`, fmt.money(prior[i] as number)) : "") +
          (cur[i] != null ? tipRow(ACC, `Net ’${curYear.slice(2)}`, fmt.money(cur[i] as number)) : "")
        }
        ariaLabel={`Net profit ${prevYear} versus ${curYear} by calendar month`}
      />
      <Fnote>
        {anyRepr ? (
          <>
            Profit history is <span className="repr">representative</span> pending per-month reconciliation — revenue and
            job counts are Simpro-verified.
          </>
        ) : (
          <>Both years verified against Simpro.</>
        )}
      </Fnote>
    </>
  );
}

function argBest(values: Array<number | null | undefined>, better: (a: number, b: number) => boolean): number {
  let idx = -1;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const current = idx >= 0 ? values[idx] : null;
    if (idx < 0 || typeof current !== "number" || better(value, current)) idx = i;
  }
  return idx;
}

/* ── Revenue → cost chain (display rounding) ───────────── */

/**
 * Display rounding for the approved cost chain: whole-dollar components that
 * sum exactly — revenue − materials − labor = gross (largest-remainder split
 * of the rounded revenue→gross gap across the two cost components) and
 * gross − overhead = net (overhead absorbs commission cost inputs and any
 * residual, so the chain always closes).
 */
export function buildBridgeSteps(
  bridge: { revenue: number; materials: number; labor: number },
  gross: number,
  net: number,
  compact: boolean,
): WaterfallStep[] | null {
  const revR = Math.round(bridge.revenue);
  const grossR = Math.round(gross);
  const netR = Math.round(net);
  if (revR <= 0) return null;
  const gap = revR - grossR;
  const weights = [Math.max(bridge.materials, 0), Math.max(bridge.labor, 0)];
  const weightTotal = weights[0] + weights[1];
  let materialsR: number;
  let laborR: number;
  if (gap <= 0 || weightTotal <= 0) {
    materialsR = Math.max(gap, 0);
    laborR = 0;
  } else {
    const exact = weights.map((w) => (gap * w) / weightTotal);
    const floors = exact.map(Math.floor);
    let remainder = gap - floors[0] - floors[1];
    const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
    const out = [...floors];
    for (const { i } of order) {
      if (remainder <= 0) break;
      out[i] += 1;
      remainder -= 1;
    }
    [materialsR, laborR] = out;
  }
  const overheadR = grossR - netR;
  const L = compact
    ? ["Rev", "Mat", "Labor", "Gross", "Ovhd", "Net"]
    : ["Revenue", "Materials", "Labor", "Gross profit", "Overhead", "Net profit"];
  return [
    { label: L[0], value: revR, kind: "base" },
    { label: L[1], value: materialsR, kind: "minus" },
    { label: L[2], value: laborR, kind: "minus" },
    { label: L[3], value: grossR, kind: "base" },
    { label: L[4], value: overheadR, kind: "minus" },
    { label: L[5], value: netR, kind: "net" },
  ];
}

/* ── Row 3 left: Where Revenue Went + Work Source Mix ──── */

const REVENUE_SEG_COLORS = {
  materials: "color-mix(in srgb,#0e9aae,#fff 40%)",
  labor: SERIES2,
  overhead: "#404a60", /* var(--series-strong) */
  net: ACC,
};

function RevenueWentCard({ model }: { model: JobDashboardReadModel }) {
  const selected = model.selected;
  const monthLong = monthLongName(model.selectedMonth);
  const supported = selected.financialCoverage.netProfitSupported > 0 && selected.financialCoverage.sellValueSupported > 0;
  const steps = supported
    ? buildBridgeSteps(selected.profitBridge, selected.grossProfitActual, selected.netProfitActual, false)
    : null;
  if (!steps) {
    return (
      <Card title={`Where ${monthLong} Revenue Went`} subtitle={`one bar · segments sum to ${monthLong} revenue`}>
        <CardBody>
          <StateEmpty>The {monthLong} cohort has no supported revenue and net-profit totals to split.</StateEmpty>
        </CardBody>
      </Card>
    );
  }
  const revenue = steps[0].value;
  const materials = steps[1].value;
  const labor = steps[2].value;
  const overhead = steps[4].value;
  const net = steps[5].value;
  const pct = (v: number) => (revenue > 0 ? (v / revenue) * 100 : 0);
  const netPct = pct(net);
  const segments: SegBarSegment[] = [
    { width: pct(materials), color: REVENUE_SEG_COLORS.materials, label: `${pct(materials).toFixed(1)}%`, labelColor: "var(--ink)" },
    { width: pct(labor), color: REVENUE_SEG_COLORS.labor, label: `${pct(labor).toFixed(1)}%`, labelColor: "var(--ink)" },
    { width: pct(overhead), color: REVENUE_SEG_COLORS.overhead, label: `${pct(overhead).toFixed(1)}%` },
    ...(net > 0
      ? [
          {
            width: netPct,
            color: REVENUE_SEG_COLORS.net,
            label: netPct >= 16 ? `Net profit ${moneyK(net)} · ${netPct.toFixed(1)}%` : `${netPct.toFixed(1)}%`,
          },
        ]
      : []),
  ];
  const legendSwatch = (background: string) => (
    <i style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background, flex: "none" }} />
  );
  return (
    <Card
      title={`Where ${monthLong} Revenue Went`}
      subtitle={`one bar · segments sum to ${monthLong} revenue`}
      aside={
        <div
          data-viz=""
          style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", fontSize: 12, color: "var(--muted)", justifyContent: "flex-end" }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            {legendSwatch(REVENUE_SEG_COLORS.materials)}Materials {fmt.moneyFull(materials)} · {pct(materials).toFixed(1)}%
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            {legendSwatch(REVENUE_SEG_COLORS.labor)}Labor {fmt.moneyFull(labor)} · {pct(labor).toFixed(1)}%
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            {legendSwatch(REVENUE_SEG_COLORS.overhead)}Overhead {fmt.moneyFull(overhead)} · {pct(overhead).toFixed(1)}%
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>{legendSwatch(REVENUE_SEG_COLORS.net)}Net profit</span>
        </div>
      }
    >
      <CardBody>
        <div data-viz="">
          <SegBar
            tall
            segments={segments}
            ariaLabel={`Revenue split: materials ${fmt.moneyFull(materials)}, labor ${fmt.moneyFull(labor)}, overhead ${fmt.moneyFull(overhead)}, net profit ${fmt.moneyFull(net)}`}
          />
        </div>
        <Fnote>Gross profit = revenue − materials − labor.</Fnote>
      </CardBody>
    </Card>
  );
}

function WorkSourceCard({ model, onOpen }: { model: JobDashboardReadModel; onOpen: (row: SourceRow) => void }) {
  const monthLong = monthLongName(model.selectedMonth);
  const rows = model.selected.jobSourceRows;
  const totalRevenue = Math.max(
    rows.reduce((sum, row) => sum + (row.revenueCoverage > 0 ? row.revenue : 0), 0),
    1,
  );
  return (
    <Card title="Work Source Mix" subtitle={`${monthLong} completed jobs by source · bar = revenue share`}>
      <CardBody>
        <BarList>
          {rows.map((row) => {
            const revenueSupported = row.revenueCoverage > 0;
            const netSupported = row.netProfitCoverage > 0;
            return (
              <BarListRow
                key={row.sourceType}
                name={row.sourceType}
                value={
                  <>
                    {row.jobs} <small>jobs</small>
                  </>
                }
                barPct={revenueSupported ? (row.revenue / totalRevenue) * 100 : 0}
                meta={`${revenueSupported ? fmt.moneyFull(row.revenue) : "revenue n/a"} · ${
                  netSupported ? `${fmt.moneyFull(row.netProfit)} net` : "net n/a"
                } · ${row.netMargin == null ? "margin n/a" : `${pctText(row.netMargin)} margin`}`}
                onClick={() => onOpen(row)}
              />
            );
          })}
        </BarList>
        <Fnote>
          Work source is classification only. Negative rows elsewhere on this page require actual Simpro net profit below zero.
        </Fnote>
      </CardBody>
    </Card>
  );
}

function SourceDrawerBody({ row }: { row: SourceRow }) {
  return (
    <>
      <KV>
        <KVCell label="Jobs" value={String(row.jobs)} />
        <KVCell label="Revenue" value={row.revenueCoverage > 0 ? fmt.moneyFull(row.revenue) : "N/A"} />
        <KVCell label="Net profit" value={row.netProfitCoverage > 0 ? fmt.moneyFull(row.netProfit) : "N/A"} />
        <KVCell label="Net margin" value={row.netMargin == null ? "N/A" : pctText(row.netMargin)} />
      </KV>
      <DSec>Drill-through</DSec>
      <DNote>
        Filter the completed-jobs list by source to see every {row.sourceType} job’s revenue, gross and net.
      </DNote>
    </>
  );
}

/* ── Row 3 right: labor + overruns ─────────────────────── */

const OVER_ESTIMATE_DEF =
  "Aggregated as (Σ actual − Σ estimated) ÷ Σ estimated across covered jobs — never an average of per-job percentages. Jobs with actuals but no estimate are excluded from the %; estimates come from the linked quote’s labor lines.";

export type RecurringLaborFacts = {
  coveredJobs: number;
  estimatedHours: number;
  actualHours: number;
  overrunPercent: number | null;
  exclusions: Array<{ jobId: string; name: string; siteName: string; actualHours: number }>;
};

/** Estimate-covered recurring facts from drilldown rows: the % uses only
 *  jobs with a positive plan estimate and recorded actuals; recorded hours
 *  with no plan estimate are listed as exclusions, never averaged in. */
export function recurringLaborFacts(rows: JobDrilldownRow[]): RecurringLaborFacts {
  let coveredJobs = 0;
  let estimatedHours = 0;
  let actualHours = 0;
  const exclusions: RecurringLaborFacts["exclusions"] = [];
  for (const row of rows) {
    if (row.jobSourceType !== "Recurring") continue;
    if (row.quotedHours != null && row.quotedHours > 0 && row.actualHours != null && row.actualHours >= 0) {
      coveredJobs += 1;
      estimatedHours += row.quotedHours;
      actualHours += row.actualHours;
    } else if (row.actualHours != null && row.actualHours > 0) {
      exclusions.push({ jobId: row.jobId, name: row.name, siteName: row.siteName, actualHours: row.actualHours });
    }
  }
  exclusions.sort((a, b) => b.actualHours - a.actualHours);
  return {
    coveredJobs,
    estimatedHours,
    actualHours,
    overrunPercent: estimatedHours > 0 ? ((actualHours - estimatedHours) / estimatedHours) * 100 : null,
    exclusions,
  };
}

function LaborCard({ model, cohort }: { model: JobDashboardReadModel; cohort: FullCohort }) {
  const [mode, setMode] = useState<"quote" | "recurring">("quote");
  const changeMode = (value: "quote" | "recurring") => {
    setMode(value);
    if (value === "recurring") void cohort.load().catch(() => undefined);
  };
  return (
    <Card
      title="Estimated vs Actual Labor"
      subtitle="Hours variance on covered jobs"
      aside={
        <Seg
          dataSeg="labormode"
          ariaLabel="Labor mode"
          options={[
            { val: "quote", label: "Quote-linked" },
            { val: "recurring", label: "Recurring" },
          ]}
          value={mode}
          onChange={(val) => changeMode(val as "quote" | "recurring")}
        />
      }
    >
      <CardBody>
        {mode === "quote" ? (
          <QuoteLinkedLabor model={model} />
        ) : (
          <RecurringLabor rows={cohort.rows} complete={cohort.complete} loading={cohort.loading} />
        )}
      </CardBody>
    </Card>
  );
}

/** Estimated/actual hour bars per the mockup: 14px tracks in a 76px/1fr/60px
 *  grid, both scaled so the larger bar fills 93% of the track. */
function LaborBars({ est, act }: { est: number; act: number }) {
  const max = Math.max(est, act, 0.0001);
  const bar = (value: number, color: string) => (
    <div style={{ height: 14, borderRadius: 5, background: "var(--n100)", overflow: "hidden" }}>
      <i style={{ display: "block", height: "100%", width: `${(value / max) * 93}%`, background: color, borderRadius: 5, fontStyle: "normal" }} />
    </div>
  );
  return (
    <div data-viz="" style={{ display: "grid", gridTemplateColumns: "76px 1fr 60px", gap: 10, alignItems: "center", margin: "8px 0 4px" }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>Estimated</span>
      {bar(est, "var(--series-weak)")}
      <b className="tnum" style={{ textAlign: "right" }}>{fmt.hrs(est)}</b>
      <span style={{ fontSize: 13, fontWeight: 600 }}>Actual</span>
      {bar(act, "var(--acc)")}
      <b className="tnum" style={{ textAlign: "right" }}>{fmt.hrs(act)}</b>
    </div>
  );
}

function LaborHeadline({ cov, pct }: { cov: ReactNode; pct: number | null }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginTop: 10 }}>
      <span style={{ fontSize: 12.5, color: "var(--faint)" }}>{cov}</span>
      <span
        className="tnum"
        style={{
          fontSize: 20,
          fontWeight: 700,
          flex: "none",
          color: pct == null ? "var(--muted)" : pct > 0 ? "var(--state-failed-fg)" : "var(--success-fg)",
        }}
      >
        {pct == null ? "—" : signedPct(pct)}{" "}
        <span
          className="def"
          data-def={OVER_ESTIMATE_DEF}
          style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}
        >
          {pct != null && pct < 0 ? "under estimate" : "over estimate"}
        </span>
      </span>
    </div>
  );
}

const stripTitleStyle: CSSProperties = {
  marginTop: 14,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: ".06em",
  textTransform: "uppercase",
  color: "var(--muted)",
};

/** Per-job variance strip: one thin flex bar per covered job, sorted — green
 *  under estimate, grey on estimate, red over (the mockup's exact pattern). */
function VarianceStrip({ items }: { items: Array<{ v: number; label: string }> }) {
  const maxAbs = Math.max(...items.map((d) => Math.abs(d.v)), 0.0001);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 56, marginTop: 8 }} aria-label="Per-job hours variance, sorted" data-viz="">
      {items.map((d, i) => (
        <i
          key={i}
          style={{
            flex: 1,
            fontStyle: "normal",
            background: d.v > 0 ? "var(--down)" : d.v < 0 ? "var(--up)" : "var(--n200)",
            height: `${d.v === 0 ? 3 : Math.max(4, (Math.abs(d.v) / maxAbs) * 100)}%`,
          }}
          onPointerEnter={(e) =>
            tipShow(
              tipTitle(d.label) + tipRow(d.v > 0 ? "#d0463a" : d.v < 0 ? "#177a52" : "#d7dbe4", "Hours variance", hoursSigned(d.v)),
              e.clientX,
              e.clientY,
            )
          }
          onPointerLeave={tipHide}
        />
      ))}
    </div>
  );
}

function LaborOverrunRow({ name, det, delta, neutral }: { name: string; det: string; delta: string; neutral?: boolean }) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: "1px solid var(--hair-2)" }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {name}
        </div>
        <div className="id2 tnum">{det}</div>
      </div>
      <b className="tnum" style={{ color: neutral ? "var(--ink-2)" : "var(--down)", flex: "none" }}>
        {delta}
      </b>
    </div>
  );
}

function QuoteLinkedLabor({ model }: { model: JobDashboardReadModel }) {
  const ql = model.selected.quoteLinkedLabor;
  const monthLong = monthLongName(model.selectedMonth);
  const quoteGenerated = model.selected.jobSourceRows.find((row) => row.sourceType === "Quote-generated");
  const covDef = `Quote-linked (${ql.quoteLinkedJobs}) counts every ${monthLong} job converted from a quote, including recurring-plan quotes — the work-source card’s Quote-generated (${quoteGenerated?.jobs ?? 0}) excludes recurring conversions. ${ql.definition}`;
  const perJobAsc = [...ql.perJob].sort((a, b) => a.varianceHours - b.varianceHours);
  const over = perJobAsc.filter((row) => row.varianceHours > 0);
  const under = perJobAsc.filter((row) => row.varianceHours < 0);
  const onEstimate = perJobAsc.length - over.length - under.length;
  const overSum = over.reduce((sum, row) => sum + row.varianceHours, 0);
  const underSum = under.reduce((sum, row) => sum + Math.abs(row.varianceHours), 0);
  return (
    <div>
      <LaborBars est={ql.estimatedHours} act={ql.actualHours} />
      <LaborHeadline
        cov={
          <>
            <Def def={covDef}>
              {ql.coveredJobs} of {ql.quoteLinkedJobs} quote-linked jobs covered
            </Def>
            {ql.actualOnlyJobs > 0 ? (
              <>
                {" "}· {ql.actualOnlyJobs} more {ql.actualOnlyJobs === 1 ? "has" : "have"} actuals but no estimate
              </>
            ) : null}
          </>
        }
        pct={ql.overrunPercent}
      />
      {perJobAsc.length > 0 ? (
        <>
          <div style={stripTitleStyle}>
            Per-job variance — {perJobAsc.length} covered jobs · {over.length} over (+{overSum.toFixed(1)}h) · {under.length}{" "}
            under (−{underSum.toFixed(1)}h) · {onEstimate} on estimate
          </div>
          <VarianceStrip
            items={perJobAsc.map((row) => ({ v: row.varianceHours, label: `${row.jobId} · ${row.siteName}` }))}
          />
        </>
      ) : null}
    </div>
  );
}

function RecurringLabor({ rows, complete, loading }: { rows: JobDrilldownRow[]; complete: boolean; loading: boolean }) {
  if (!complete) {
    return <StateEmpty>{loading ? "Loading recurring labor for the full month…" : "Recurring labor is available when opened."}</StateEmpty>;
  }
  const facts = recurringLaborFacts(rows);
  const exclusions = facts.exclusions.slice(0, 3);
  return (
    <div>
      <LaborBars est={facts.estimatedHours} act={facts.actualHours} />
      <LaborHeadline
        cov={
          <>
            {facts.coveredJobs} estimate-covered recurring {facts.coveredJobs === 1 ? "job" : "jobs"} only ·{" "}
            <span className="repr">representative</span>
          </>
        }
        pct={facts.overrunPercent}
      />
      <div style={stripTitleStyle}>Recorded hours with no plan estimate — excluded from the %</div>
      {exclusions.length > 0 ? (
        exclusions.map((row) => (
          <LaborOverrunRow
            key={row.jobId}
            neutral
            name={`${row.jobId} · ${row.siteName} — ${row.name}`}
            det="recurring visit · no plan estimate"
            delta={`${trimHours(row.actualHours)}h`}
          />
        ))
      ) : (
        <div className="id2" style={{ padding: "9px 0" }}>
          {complete
            ? "Every recorded recurring visit has a plan estimate."
            : "Per-job exclusions appear once the full month is loaded."}
        </div>
      )}
      <Fnote style={{ marginTop: 10 }}>
        <span className="repr">Representative</span> until recurring estimates are re-verified per plan.
        {!complete ? " Computed from the loaded jobs only — the full month is still loading." : ""}
      </Fnote>
    </div>
  );
}

function OverrunsCard({ model }: { model: JobDashboardReadModel }) {
  const topOverruns = [...model.selected.quoteLinkedLabor.perJob]
    .filter((row) => row.varianceHours > 0)
    .sort((a, b) => b.varianceHours - a.varianceHours)
    .slice(0, 3);
  const maxOverrun = topOverruns[0]?.varianceHours ?? 0;
  return (
    <Card
      title="Largest Overruns"
      subtitle={
        topOverruns.length > 0
          ? `top ${topOverruns.length} by hours over estimate · bars scaled to the largest (+${trimHours(maxOverrun)}h)`
          : "hours over estimate on covered quote-linked jobs"
      }
    >
      <CardBody>
        {topOverruns.length > 0 ? (
          <BarList>
            {topOverruns.map((row) => (
              <BarListRow
                key={row.jobId}
                name={`${row.jobId} · ${row.siteName} — ${row.name}`}
                value={`+${trimHours(row.varianceHours)}h`}
                bad
                barPct={(row.varianceHours / maxOverrun) * 100}
                barBad
                meta={`${trimHours(row.estimatedHours)}h quoted · ${trimHours(row.actualHours)}h actual`}
              />
            ))}
          </BarList>
        ) : (
          <StateEmpty>No overruns — every covered job finished at or under its estimate.</StateEmpty>
        )}
      </CardBody>
    </Card>
  );
}

/* ── Row 4: Profitability by Site / Category ───────────── */

type ProfRow = { label: string; jobs: number; sell: number; np: number; isRemainder?: boolean };

function ProfitabilityCard({
  model,
  onOpen,
}: {
  model: JobDashboardReadModel;
  onOpen: (state: DrawerState) => void;
}) {
  const [mode, setMode] = useState<"site" | "category">("site");
  const selected = model.selected;
  const monthLong = monthLongName(model.selectedMonth);
  const totalNet = selected.netProfitActual;

  let rows: ProfRow[];
  let foot: string;
  if (mode === "category") {
    rows = selected.categoryRows.map((row) => ({
      label: row.label,
      jobs: row.distinctJobCount,
      sell: row.sellValue,
      np: row.netProfit,
    }));
    const top = rows.reduce((best, row) => (row.np > best.np ? row : best), rows[0]);
    foot =
      rows.length > 0 && totalNet !== 0
        ? `All ${rows.length} configured categories · ${top.label} produced ${pctText((top.np / totalNet) * 100)} of ${monthLong} net profit`
        : `All ${rows.length} configured categories`;
  } else {
    const ranked = [...selected.siteRows].sort((a, b) => b.netProfit - a.netProfit);
    const top = ranked.slice(0, 8).map((row) => ({
      label: row.label,
      jobs: row.jobs,
      sell: row.revenue,
      np: row.netProfit,
    }));
    rows = top;
    if (ranked.length > 8) {
      const remainder: ProfRow = {
        label: `Remaining ${ranked.length - 8} sites`,
        jobs: ranked.slice(8).reduce((sum, row) => sum + row.jobs, 0),
        sell: selected.totalSellValue - top.reduce((sum, row) => sum + row.sell, 0),
        np: totalNet - top.reduce((sum, row) => sum + row.np, 0),
        isRemainder: true,
      };
      rows = [...top, remainder];
      foot =
        totalNet !== 0
          ? `Top ${top.length} of ${ranked.length} sites by net profit · the long tail still carries ${pctText((remainder.np / totalNet) * 100)} of net`
          : `Top ${top.length} of ${ranked.length} sites by net profit`;
    } else {
      foot = `All ${ranked.length} sites by net profit`;
    }
  }
  const maxNp = Math.max(...rows.filter((row) => !row.isRemainder).map((row) => row.np), 0);

  return (
    <Card
      className="span12"
      title={mode === "category" ? "Profitability by Category" : "Profitability by Site"}
      subtitle={`${monthLong} net profit · bars scaled to the largest row · click a row for its jobs`}
      aside={
        <Seg
          dataSeg="profmode"
          ariaLabel="Profitability mode"
          options={[
            { val: "site", label: "By site" },
            { val: "category", label: "By category" },
          ]}
          value={mode}
          onChange={(val) => setMode(val as "site" | "category")}
        />
      }
    >
      <CardBody>
        <BarList variant="cols2">
          {rows.map((row) => {
            const nm = row.sell > 0 ? (row.np / row.sell) * 100 : null;
            const share = totalNet !== 0 ? (row.np / totalNet) * 100 : null;
            const metaParts = [
              `${row.jobs} ${row.jobs === 1 ? "job" : "jobs"}`,
              `${fmt.moneyFull(row.sell)} revenue`,
              nm != null ? `${pctText(nm)} margin` : "margin n/a",
              share != null ? `${pctText(share)} of net` : null,
            ].filter(Boolean);
            return (
              <BarListRow
                key={row.label}
                name={row.label}
                value={fmt.moneyFull(row.np)}
                bad={row.np < 0}
                total={row.isRemainder}
                barPct={row.isRemainder || maxNp <= 0 ? undefined : Math.max((Math.max(row.np, 0) / maxNp) * 100, 2)}
                meta={`${metaParts.join(" · ")}${row.isRemainder ? " — long-tail aggregate, not on the per-site bar scale" : ""}`}
                onClick={
                  row.isRemainder
                    ? undefined
                    : () => onOpen({ kind: "prof", mode, label: row.label, jobs: row.jobs, sell: row.sell, np: row.np })
                }
              />
            );
          })}
        </BarList>
        <Fnote>{foot}</Fnote>
      </CardBody>
    </Card>
  );
}

function ProfDrawerBody({
  state,
  totalNet,
  monthLong,
  onDrill,
}: {
  state: Extract<DrawerState, { kind: "prof" }>;
  totalNet: number;
  monthLong: string;
  onDrill: (kind: "site" | "category", label: string) => void;
}) {
  return (
    <>
      <KV>
        <KVCell label="Revenue" value={fmt.moneyFull(state.sell)} />
        <KVCell label="Net profit" value={fmt.moneyFull(state.np)} />
        <KVCell label="Net margin" value={state.sell > 0 ? pctText((state.np / state.sell) * 100) : "N/A"} />
        <KVCell
          label={`Share of ${monthLong} net`}
          value={totalNet !== 0 ? pctText((state.np / totalNet) * 100) : "N/A"}
        />
      </KV>
      <DSec>Drill-through</DSec>
      <DNote>
        Every job’s revenue, gross and net is in the completed-jobs list.{" "}
        <span className="retry" role="button" onClick={() => onDrill(state.mode, state.label)}>
          Open the list filtered to this {state.mode === "category" ? "category" : "site"}
        </span>
      </DNote>
    </>
  );
}

/* ── Completed jobs drilldown ──────────────────────────── */

export type JobsFetcher = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Loads the full month roster through the narrow records endpoint. Table
 * filters remain client-side so they never alter the dashboard read model.
 */
export async function fetchAllCompletedJobs(
  model: JobDashboardReadModel,
  fetcher: JobsFetcher = fetch,
): Promise<JobDrilldownRow[]> {
  const { total } = model.drilldownPagination;
  if (model.selected.records.length >= total) return model.selected.records;
  const search = new URLSearchParams({ month: model.selectedMonth });
  const response = await fetcher(`/api/jobs/records?${search.toString()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("The complete job list could not be loaded.");
  }
  const data = (await response.json()) as { records?: JobDrilldownRow[]; total?: number };
  const rows = data.records;
  if (!Array.isArray(rows) || rows.length !== total || data.total !== total) {
    throw new Error("The complete job list could not be loaded. No file was downloaded.");
  }
  return rows;
}

export type CompletedJobsFilters = {
  category: string;
  source: string;
  technician: string;
  site: string | null;
};

export function filterCompletedJobs(rows: JobDrilldownRow[], filters: CompletedJobsFilters): JobDrilldownRow[] {
  return rows.filter((row) => {
    if (
      filters.category !== "all" &&
      !row.categories.includes(filters.category) &&
      row.primaryCategory !== filters.category
    ) {
      return false;
    }
    if (filters.source !== "all" && row.jobSourceType !== filters.source) return false;
    if (filters.technician !== "all" && !row.technicians.includes(filters.technician)) return false;
    if (filters.site !== null && row.siteName !== filters.site) return false;
    return true;
  });
}

export function sortBySellValue(rows: JobDrilldownRow[]): JobDrilldownRow[] {
  return [...rows].sort(
    (a, b) =>
      (b.sellValue ?? Number.NEGATIVE_INFINITY) - (a.sellValue ?? Number.NEGATIVE_INFINITY) ||
      a.jobId.localeCompare(b.jobId),
  );
}

/** Approved C7: plain client-side CSV of the current filtered cohort. */
export function buildCompletedJobsCsv(rows: JobDrilldownRow[]): string {
  const header = [
    "Job ID",
    "Job Number",
    "Name",
    "Completed Date",
    "Customer",
    "Site",
    "Work Source",
    "Primary Category",
    "Technicians",
    "Sell Value",
    "Gross Profit",
    "Net Profit",
    "Net Margin (%)",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.jobId,
        row.jobNo,
        row.name,
        row.completedDate,
        row.customerName,
        row.siteName,
        row.jobSourceType,
        row.primaryCategory,
        row.technicians.join("; "),
        row.sellValue ?? "",
        row.grossProfit ?? "",
        row.netProfit ?? "",
        row.sellValue != null && row.sellValue > 0 && row.netProfit != null
          ? ((row.netProfit / row.sellValue) * 100).toFixed(1)
          : "",
      ]
        .map((value) => csvCell(value))
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** Real pager layout: first pages, a window around the current page, and the
 *  last page, with gaps — every numbered button is a live page. */
export function pageList(totalPages: number, page: number): Array<number | "gap"> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const wanted = new Set([1, 2, page - 1, page, page + 1, totalPages]);
  const pages = [...wanted].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const out: Array<number | "gap"> = [];
  let prev = 0;
  for (const p of pages) {
    if (p - prev > 1) out.push("gap");
    out.push(p);
    prev = p;
  }
  return out;
}

export type FullCohort = {
  rows: JobDrilldownRow[];
  complete: boolean;
  loading: boolean;
  error: string | null;
  load: () => Promise<JobDrilldownRow[]>;
};

/** Full-cohort loader shared by the drilldown table and recurring labor.
 * It stays idle on initial render and makes one narrow request only when an
 * interaction needs records beyond the supplied dashboard page. */
function useFullCohort(model: JobDashboardReadModel): FullCohort {
  const initialComplete = model.selected.records.length >= model.drilldownPagination.total;
  const [state, setState] = useState<{
    month: string; rows: JobDrilldownRow[] | null; error: string | null; loading: boolean;
  }>(() => ({
    month: model.selectedMonth,
    rows: initialComplete ? model.selected.records : null,
    error: null,
    loading: false,
  }));
  const requestRef = useRef<{ month: string; promise: Promise<JobDrilldownRow[]> } | null>(null);
  const currentState = state.month === model.selectedMonth
    ? state
    : { rows: null, error: null, loading: false };
  const load = useCallback(() => {
    if (initialComplete) return Promise.resolve(model.selected.records);
    if (currentState.rows) return Promise.resolve(currentState.rows);
    if (requestRef.current?.month === model.selectedMonth) return requestRef.current.promise;

    setState({ month: model.selectedMonth, rows: null, error: null, loading: true });
    const promise = fetchAllCompletedJobs(model)
      .then((rows) => {
        setState({ month: model.selectedMonth, rows, error: null, loading: false });
        return rows;
      })
      .catch((error: unknown) => {
        setState({
          month: model.selectedMonth,
          rows: null,
          error: error instanceof Error ? error.message : "Load failed.",
          loading: false,
        });
        throw error;
      })
      .finally(() => {
        if (requestRef.current?.promise === promise) requestRef.current = null;
      });
    requestRef.current = { month: model.selectedMonth, promise };
    return promise;
  }, [currentState.rows, initialComplete, model]);
  return {
    rows: currentState.rows ?? model.selected.records,
    complete: currentState.rows !== null || initialComplete,
    loading: currentState.loading,
    error: currentState.error,
    load,
  };
}

function CompletedJobsCard({
  model,
  cohort,
  initialCategory,
  site,
  onClearSite,
  onOpen,
}: {
  model: JobDashboardReadModel;
  cohort: FullCohort;
  /** Drill-through seeds (the card remounts per drill, so state re-inits). */
  initialCategory: string;
  site: string | null;
  onClearSite: () => void;
  onOpen: (row: JobDrilldownRow) => void;
}) {
  const monthLong = monthLongName(model.selectedMonth);
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState(initialCategory);
  const [source, setSource] = useState("all");
  const [technician, setTechnician] = useState("all");
  const [csvError, setCsvError] = useState<string | null>(null);

  const filters: CompletedJobsFilters = { category, source, technician, site };
  const filteredAll = sortBySellValue(filterCompletedJobs(cohort.rows, filters));
  const anyFilter = category !== "all" || source !== "all" || technician !== "all" || site !== null;
  const waitingForFullCohort = !cohort.complete && (anyFilter || page > 1);
  const total = anyFilter || cohort.complete ? filteredAll.length : model.drilldownPagination.total;
  const totalPages = Math.max(1, Math.ceil(total / CLIENT_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * CLIENT_PAGE_SIZE;
  const visible = filteredAll.slice(start, start + CLIENT_PAGE_SIZE);
  const setFilter = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(1);
    void cohort.load().catch(() => undefined);
  };

  const downloadCsv = async () => {
    setCsvError(null);
    let rows = cohort.rows;
    try {
      rows = await cohort.load();
    } catch {
      setCsvError(cohort.error ?? "The complete job list could not be loaded. No file was downloaded.");
      return;
    }
    const csv = buildCompletedJobsCsv(sortBySellValue(filterCompletedJobs(rows, filters)));
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `completed-jobs-${model.selectedMonth}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card">
      <div className="hd" style={{ flexWrap: "wrap" }}>
        <div>
          <div className="ti">Completed Jobs</div>
          <div className="st">
            All {model.drilldownPagination.total} {monthLong} jobs by sell value · click a row for detail
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="ctl" style={{ height: 34, fontSize: 13.5 }} onClick={downloadCsv}>
            <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path d="M12 3v12M7 10l5 5 5-5" />
              <path d="M4 19h16" />
            </svg>
            Download CSV
          </button>
          {site !== null ? (
            <button
              type="button"
              className="ctl"
              style={{ height: 34, fontSize: 13.5 }}
              onClick={onClearSite}
              title="Clear the site filter"
            >
              Site: {site} ✕
            </button>
          ) : null}
          <select
            className="ctl-sel"
            aria-label="Category filter"
            value={category}
            onChange={(event) => setFilter(setCategory)(event.target.value)}
          >
            <option value="all">All categories</option>
            {model.filterOptions.categories.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <select
            className="ctl-sel"
            aria-label="Source filter"
            value={source}
            onChange={(event) => setFilter(setSource)(event.target.value)}
          >
            <option value="all">All sources</option>
            {(["Quote-generated", "Recurring", "Direct service"] as JobSourceType[]).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <select
            className="ctl-sel"
            aria-label="Technician filter"
            value={technician}
            onChange={(event) => setFilter(setTechnician)(event.target.value)}
          >
            <option value="all">All technicians</option>
            {model.filterOptions.technicians.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th className="jobcol">Job</th>
              <th className="hide-sm">Source</th>
              <th className="num">Sell</th>
              <th className="num hide-sm">Gross</th>
              <th className="num">Net</th>
              <th className="num hide-lg">Net Margin</th>
            </tr>
          </thead>
          <tbody>
            {waitingForFullCohort ? (
              <tr>
                <td colSpan={6}><StateEmpty>Loading the full month…</StateEmpty></td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <StateEmpty>
                    {anyFilter ? "No completed jobs match the current filters." : "No completed jobs to show."}
                  </StateEmpty>
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <tr
                  key={row.jobId}
                  className="rowlink"
                  tabIndex={0}
                  aria-label={`Open job ${row.jobNo || row.jobId} detail`}
                  onClick={() => onOpen(row)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpen(row);
                    }
                  }}
                >
                  <td>
                    <div className="id1">{row.name}</div>
                    <div className="id2">
                      Job {row.jobId} · {row.siteName}
                    </div>
                  </td>
                  <td className="hide-sm">
                    <SrcPill>{row.jobSourceType}</SrcPill>
                  </td>
                  <td className="num tnum">{row.sellValue != null ? fmt.moneyFull(row.sellValue) : "—"}</td>
                  <td className="num tnum hide-sm">{row.grossProfit != null ? fmt.moneyFull(row.grossProfit) : "—"}</td>
                  <td className="num tnum" style={{ fontWeight: 700 }}>
                    {row.netProfit != null ? (
                      row.netProfit < 0 ? <span className="neg" style={{ color: "var(--state-failed-fg)" }}>{fmt.moneyFull(row.netProfit)}</span> : fmt.moneyFull(row.netProfit)
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="num tnum hide-lg">{marginCellText(netMarginDisplay(row.sellValue, row.netProfit))}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="foot">
        <span>
          {total === 0
            ? "Showing 0 jobs"
            : `Showing ${start + 1}–${start + visible.length} of ${total}${anyFilter ? " filtered" : ""} by sell value`}
          {cohort.loading ? " · loading the full month…" : ""}
          {cohort.error ? ` · ${cohort.error}` : ""}
          {csvError ? ` · ${csvError}` : ""}
        </span>
        <span className="pager">
          <button type="button" disabled={safePage === 1} onClick={() => setPage(safePage - 1)} aria-label="Previous page">
            ‹
          </button>
          {pageList(totalPages, safePage).map((entry, index) =>
            entry === "gap" ? (
              <span key={`gap${index}`} className="gap">
                …
              </span>
            ) : (
              <button
                key={entry}
                type="button"
                className={entry === safePage ? "on" : undefined}
                disabled={cohort.loading}
                onClick={() => {
                  if (!cohort.complete && entry > 1) {
                    void cohort.load().then(() => setPage(entry)).catch(() => undefined);
                    return;
                  }
                  setPage(entry);
                }}
              >
                {entry}
              </button>
            ),
          )}
          <button
            type="button"
            disabled={safePage === totalPages || cohort.loading}
            onClick={() => {
              const next = safePage + 1;
              if (!cohort.complete) {
                void cohort.load().then(() => setPage(next)).catch(() => undefined);
                return;
              }
              setPage(next);
            }}
            aria-label="Next page"
          >
            ›
          </button>
        </span>
      </div>
    </div>
  );
}

/* ── Drawers ───────────────────────────────────────────── */

export type NetMarginDisplay = { kind: "na" } | { kind: "nm"; ticket: string } | { kind: "pct"; text: string };

/** Approved drawer grammar: no margin without a positive sell basis, and the
 *  n/m treatment for fee tickets whose |margin| would exceed 200%. */
export function netMarginDisplay(sell: number | null, net: number | null): NetMarginDisplay {
  if (sell == null || sell <= 0 || net == null) return { kind: "na" };
  const pct = (net / sell) * 100;
  if (Math.abs(pct) > 200) return { kind: "nm", ticket: fmt.moneyFull(sell) };
  return { kind: "pct", text: (pct < 0 ? "−" : "") + Math.abs(pct).toFixed(1) + "%" };
}

function marginCellText(display: NetMarginDisplay): string {
  if (display.kind === "na") return "—";
  if (display.kind === "nm") return "n/m";
  return display.text;
}

/** "an $863 ticket" vs "a $59 ticket" — ported from the approved kit. */
export function ticketArticle(v: number): string {
  return String(Math.round(Math.abs(v)))[0] === "8" ? "an" : "a";
}

function JobDrawerBody({ row }: { row: JobDrilldownRow }) {
  const margin = netMarginDisplay(row.sellValue, row.netProfit);
  const loss = row.netProfit != null && row.netProfit < 0;
  return (
    <>
      <KV>
        <KVCell label="Sell value" value={row.sellValue != null ? fmt.moneyFull(row.sellValue) : "N/A"} />
        {row.grossProfit != null ? <KVCell label="Gross profit" value={fmt.moneyFull(row.grossProfit)} /> : null}
        <KVCell
          label="Net profit"
          value={row.netProfit != null ? fmt.moneyFull(row.netProfit) : "N/A"}
          valueStyle={{ color: loss ? "var(--down)" : "var(--ink)" }}
        />
        <KVCell
          label="Net margin"
          value={
            margin.kind === "nm" ? (
              <>
                n/m{" "}
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>· {margin.ticket} ticket</span>
              </>
            ) : margin.kind === "pct" ? (
              margin.text
            ) : (
              "N/A"
            )
          }
        />
        {loss && row.actualHours != null ? <KVCell label="Recorded hours" value={`${trimHours(row.actualHours)}h`} /> : null}
        <KVCell label="Work source" value={<span style={{ fontSize: 14 }}>{row.jobSourceType}</span>} />
        {loss && row.technicians.length > 0 ? (
          <KVCell label="Technicians" value={<span style={{ fontSize: 14 }}>{row.technicians.join(", ")}</span>} />
        ) : null}
      </KV>
      {loss ? (
        <>
          <DSec>Net-negative basis</DSec>
          <DNote>This job finished below zero only because Simpro NetProfit Actual is below zero. No additional cause is inferred by the dashboard.</DNote>
        </>
      ) : null}
      <DSec>In Simpro</DSec>
      <DNote>Open the job record in Simpro for scope, notes, attachments and billing state.</DNote>
    </>
  );
}

/* ── Shared helpers ────────────────────────────────────── */

export function monthLongName(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

export function monthShortName(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

/** "2026-06" → "Jun ’26" (chart label/series grammar). */
export function seriesLabel(monthKey: string): string {
  return `${monthShortName(monthKey)} ’${monthKey.slice(2, 4)}`;
}

export function shiftMonthKey(monthKey: string, offset: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function signedPct(v: number, dp = 1): string {
  return (v < 0 ? "−" : "+") + Math.abs(v).toFixed(dp) + "%";
}

/** Percentage with the typographic minus (U+2212), matching fmt.moneyFull. */
function pctText(v: number, dp = 1): string {
  return (v < 0 ? "−" : "") + Math.abs(v).toFixed(dp) + "%";
}

function hoursSigned(v: number): string {
  return (v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "h";
}

function trimHours(v: number): string {
  return String(Math.round(v * 100) / 100);
}

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Bullet,
  DevStrip,
  fmt,
  Histogram,
  tipRow,
  TrendChart,
  type TrendAnnotation,
  type TrendSeries,
  type WaterfallStep,
} from "@/components/charts";
import {
  BRow,
  Card,
  CardBody,
  Chipd,
  DCell,
  Def,
  DefTooltipProvider,
  DGrid,
  DNote,
  Drawer,
  DSec,
  Fnote,
  Focal,
  FocalCov,
  FocalLabel,
  FocalMeta,
  FocalValue,
  Hero,
  KV,
  KVCell,
  MetricPicker,
  Mgn,
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
import type { JobDashboardReadModel } from "@/lib/store/job-dashboard-read-model";

/* /jobs — implements the approved APPROVED-2026-07-15/mockups/jobs.html
   exactly, with every figure taken from the read-model payload (the mockup's
   numbers were the June 2026 snapshot). Representative data carries the repr
   grammar + data-def tooltips; empty/partial states are honest; no
   unsupported value is ever rendered as zero. */

/** Example net-margin target (approved decision C6): every mention is
 *  labelled "(example)" — the real target number is Asad's to set. */
export const EXAMPLE_NET_MARGIN_TARGET_PCT = 50;

const CLIENT_PAGE_SIZE = 10;

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
  const monthLong = monthLongName(model.selectedMonth);
  return (
    <Hero split>
      <Focal style={{ paddingBottom: 24 }}>
        <FocalLabel>Net Profit · Completed Jobs · {monthLong}</FocalLabel>
        <div className="empt" style={{ marginTop: 16 }}>
          No jobs were completed in this month.
        </div>
      </Focal>
      <TrendCard model={model} />
    </Hero>
  );
}

/* ── Full month layout ─────────────────────────────────── */

type DrawerState =
  | { kind: "loss"; row: JobDrilldownRow }
  | { kind: "job"; row: JobDrilldownRow }
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
    tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <>
      <Hero split>
        <FocalPanel model={model} />
        <BridgeCard model={model} />
      </Hero>

      <div className="g75">
        <LaborCard model={model} cohort={cohort} />
        <ProfitabilityCard model={model} onOpen={(state) => setDrawer(state)} />
      </div>

      <div className="g57">
        <TrendCard model={model} />
        <NetNegativeJobsCard model={model} onOpen={(row) => setDrawer({ kind: "loss", row })} />
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
        {drawer?.kind === "loss" ? <JobDrawerBody row={drawer.row} loss /> : null}
        {drawer?.kind === "job" ? <JobDrawerBody row={drawer.row} /> : null}
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
  return drawer.kind === "prof" ? drawer.label : drawer.row.name;
}

function drawerSub(drawer: DrawerState | null, monthLong: string, selectedMonth: string): ReactNode {
  if (!drawer) return null;
  if (drawer.kind === "prof") {
    return `${monthLong} ${selectedMonth.slice(0, 4)} · ${drawer.jobs} completed ${drawer.jobs === 1 ? "job" : "jobs"}`;
  }
  return `Job ${drawer.row.jobId} · ${drawer.row.siteName}`;
}

/* ── Hero focal ────────────────────────────────────────── */

function FocalPanel({ model }: { model: JobDashboardReadModel }) {
  const selected = model.selected;
  const coverage = selected.financialCoverage;
  const monthLong = monthLongName(model.selectedMonth);
  const priorLong = monthLongName(shiftMonthKey(model.selectedMonth, -1));
  const yoyLabel = seriesLabel(shiftMonthKey(model.selectedMonth, -12));
  const daySuffix = model.provisional.active ? ` · day ${model.provisional.elapsedDays}` : "";
  const comparison = Object.fromEntries(model.comparisons.map((row) => [row.key, row]));
  const netRow = comparison.netProfit;
  const netMarginRow = comparison.netMargin;
  const netSupported = coverage.netProfitSupported > 0;
  const netMargin = selected.netMarginActual;
  const marginPtsDelta =
    netMarginRow?.current != null && netMarginRow.priorYear != null
      ? netMarginRow.current - netMarginRow.priorYear
      : null;
  const netDef = `Σ Simpro NetProfit Actual across jobs completed in ${monthLong} (CompletedDate sets the month; stage must be Complete or Archived — job status is never used, and Invoiced is not completion). Commission actuals are treated as cost inputs only.`;

  const mom = (delta: number | null | undefined) =>
    delta == null ? `No ${priorLong} comparison basis.` : `Vs ${priorLong}: ${signedPct(delta)}.`;

  const bullet = heroBullet(model, monthLong, yoyLabel);

  return (
    <Focal style={{ paddingBottom: 24 }}>
      <FocalLabel>
        <Def def={netDef}>Net Profit</Def> · Completed Jobs · {monthLong}
        {model.provisional.active ? " (to date)" : ""}
      </FocalLabel>
      <FocalValue>{netSupported ? fmt.moneyFull(selected.netProfitActual) : "N/A"}</FocalValue>
      <FocalMeta>
        {netMargin != null ? (
          <Mgn>
            {netMargin.toFixed(1)}% net margin{" "}
            {marginPtsDelta != null ? (
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: marginPtsDelta < 0 ? "#f0937f" : "#7fd4a8",
                  marginLeft: 4,
                }}
              >
                {marginPtsDelta < 0 ? "↓" : "↑"} {Math.abs(marginPtsDelta).toFixed(1)} pts vs {yoyLabel}
              </span>
            ) : null}
          </Mgn>
        ) : (
          <Mgn>net margin unavailable</Mgn>
        )}
        {netRow?.priorYearDelta != null ? (
          <Chipd tone={netRow.priorYearDelta >= 0 ? "up" : "dn"}>
            {netRow.priorYearDelta >= 0 ? "↑" : "↓"} {Math.abs(netRow.priorYearDelta).toFixed(1)}% vs {yoyLabel}
            {daySuffix}
          </Chipd>
        ) : (
          <Chipd tone="neutral">no {yoyLabel} basis</Chipd>
        )}
        {netRow?.priorMonthDelta != null ? (
          <Chipd tone="neutral">
            {netRow.priorMonthDelta >= 0 ? "↑" : "↓"} {Math.abs(netRow.priorMonthDelta).toFixed(1)}% vs {priorLong}
            {daySuffix}
          </Chipd>
        ) : (
          <Chipd tone="neutral">no {priorLong} basis</Chipd>
        )}
        {netMargin != null ? (
          <span className="mgn tnum" style={{ fontSize: 13, color: "#e6c07a" }}>
            {Math.abs(EXAMPLE_NET_MARGIN_TARGET_PCT - netMargin).toFixed(1)} pts{" "}
            {netMargin < EXAMPLE_NET_MARGIN_TARGET_PCT ? "below" : "above"} the {EXAMPLE_NET_MARGIN_TARGET_PCT}% target{" "}
            <span style={{ fontSize: 11.5 }}>(example)</span>
          </span>
        ) : null}
      </FocalMeta>
      <div style={{ flex: "1 1 0" }} />
      <DGrid style={{ marginTop: 0 }}>
        <DCell
          label="Revenue"
          def={`Σ Simpro job Total (ex-tax) across the ${monthLong} completed cohort — CompletedDate in ${monthLong}, stage Complete or Archived. ${mom(comparison.sellValue?.priorMonthDelta)}`}
          value={coverage.sellValueSupported > 0 ? fmt.moneyFull(selected.totalSellValue) : "N/A"}
          u={yoyDeltaU(comparison.sellValue?.priorYearDelta)}
          s={comparison.sellValue?.priorYearDelta == null ? `no ${yoyLabel} basis` : undefined}
        />
        <div className="dcell">
          <div className="dl2">
            <span
              className="def"
              data-def={`Σ Simpro GrossProfit Actual across the ${monthLong} completed cohort. Margin = gross profit ÷ revenue. ${mom(comparison.grossProfit?.priorMonthDelta)}`}
            >
              Gross Profit
            </span>
          </div>
          <div className="dv2 tnum">
            {coverage.grossProfitSupported > 0 ? fmt.moneyFull(selected.grossProfitActual) : "N/A"}
            {comparison.grossProfit?.priorYearDelta != null ? (
              <span className="u">{yoyDeltaU(comparison.grossProfit.priorYearDelta)}</span>
            ) : null}
          </div>
          {selected.grossMarginActual != null ? (
            <div className="tnum" style={{ fontSize: 12, fontWeight: 600, color: "#8b90a6", marginTop: 3 }}>
              {selected.grossMarginActual.toFixed(1)}% gross margin
            </div>
          ) : null}
        </div>
        <DCell
          label="Completed Jobs"
          def={`Count of jobs with CompletedDate in ${monthLong} and Simpro stage Complete or Archived. ${mom(comparison.completedJobs?.priorMonthDelta)}`}
          value={String(selected.completedJobCount)}
          u={yoyDeltaU(comparison.completedJobs?.priorYearDelta)}
          s={comparison.completedJobs?.priorYearDelta == null ? `no ${yoyLabel} basis` : undefined}
        />
        <DCell
          label="Avg Job Value"
          def={`${monthLong} revenue ÷ completed jobs. ${mom(comparison.averageJobValue?.priorMonthDelta)}`}
          value={
            selected.averageJobValue != null && coverage.sellValueSupported > 0
              ? fmt.moneyFull(selected.averageJobValue)
              : "—"
          }
          u={yoyDeltaU(comparison.averageJobValue?.priorYearDelta)}
          s={comparison.averageJobValue?.priorYearDelta == null ? `no ${yoyLabel} basis` : undefined}
        />
      </DGrid>
      <div style={{ marginTop: "auto", paddingTop: 18 }}>
        {bullet ? <Bullet cur={bullet.cur} comp={bullet.comp} high={bullet.high} fmt={(v) => fmt.money(v)} /> : null}
      </div>
      <FocalCov style={{ paddingTop: 14 }}>
        Green deltas vs {yoyLabel} · vs-{priorLong} in each tile’s tooltip
      </FocalCov>
    </Focal>
  );
}

function yoyDeltaU(delta: number | null | undefined): ReactNode | undefined {
  if (delta == null) return undefined;
  if (delta >= 0) return <>↑ {Math.abs(delta).toFixed(1)}%</>;
  return <span style={{ color: "#f0937f" }}>↓ {Math.abs(delta).toFixed(1)}%</span>;
}

function heroBullet(model: JobDashboardReadModel, monthLong: string, yoyLabel: string) {
  const trailing = model.trends.filter((row) => row.month <= model.selectedMonth).slice(-12);
  if (trailing.length === 0 || model.selected.financialCoverage.netProfitSupported === 0) return null;
  const high = trailing.reduce((best, row) => (row.netProfit > best.netProfit ? row : best), trailing[0]);
  if (high.netProfit <= 0) return null;
  const highLabel =
    high.provenance === "representative"
      ? `<span class="repr">${seriesLabel(high.month)}</span>`
      : seriesLabel(high.month);
  const priorYear = model.priorYearFull;
  return {
    cur: { m: monthLong, v: model.selected.netProfitActual },
    comp:
      priorYear.completedJobCount > 0 && priorYear.financialCoverage.netProfitSupported > 0
        ? { m: yoyLabel, v: priorYear.netProfitActual }
        : null,
    high: { m: highLabel, v: high.netProfit },
  };
}

/* ── Monthly Trend card ────────────────────────────────── */

type TrendMetric = {
  key: string;
  label: string;
  color: string;
  axis: 1 | 2;
  unit?: "pct" | "count";
  values: (number | null)[];
  /** Profit-derived metrics carry the per-month provenance dashing. */
  repr: boolean;
};

const TREND_UNITS: Record<string, "pct" | "count" | undefined> = {
  rev: undefined,
  gp: undefined,
  np: undefined,
  ajv: undefined,
  gm: "pct",
  nm: "pct",
  jobs: "count",
};

/** Metric-picker selection semantics ported verbatim from the approved
 *  jobs.html script: yoy is exclusive, minimum one chip, unit-compatible
 *  multi-select capped at four. */
export function nextTrendSelection(sel: string[], key: string): string[] {
  if (key === "yoy") return sel.includes("yoy") ? ["np", "nm"] : ["yoy"];
  if (sel.includes("yoy")) return [key];
  if (sel.includes(key)) return sel.length > 1 ? sel.filter((k) => k !== key) : sel;
  const unit = TREND_UNITS[key];
  const out = unit ? sel.filter((k) => !TREND_UNITS[k] || TREND_UNITS[k] === unit) : [...sel];
  out.push(key);
  while (out.length > 4) out.shift();
  return out;
}

function TrendCard({ model }: { model: JobDashboardReadModel }) {
  const [sel, setSel] = useState<string[]>(["np", "nm"]);
  const t = model.trends;
  const metrics = useMemo<TrendMetric[]>(
    () => [
      { key: "rev", label: "Revenue", color: "#404a60", axis: 1, values: t.map((r) => r.sellValue), repr: false },
      { key: "gp", label: "Gross profit", color: "#9aa2b2", axis: 1, values: t.map((r) => r.grossProfit), repr: true },
      { key: "np", label: "Net profit", color: "#5b63d3", axis: 1, values: t.map((r) => r.netProfit), repr: true },
      { key: "ajv", label: "Avg job value", color: "#6d7890", axis: 1, values: t.map((r) => r.avgJobValue), repr: false },
      {
        key: "gm",
        label: "Gross margin %",
        color: "#b98b3f",
        axis: 2,
        unit: "pct",
        values: t.map((r) => r.grossMargin),
        repr: true,
      },
      {
        key: "nm",
        label: "Net margin %",
        color: "#404a60",
        axis: 2,
        unit: "pct",
        values: t.map((r) => r.netMargin),
        repr: true,
      },
      {
        key: "jobs",
        label: "Completed jobs",
        color: "#5f6b83",
        axis: 2,
        unit: "count",
        values: t.map((r) => r.completedJobs),
        repr: false,
      },
    ],
    [t],
  );
  if (t.length === 0) {
    return (
      <Card title="Monthly Trend" subtitle="No served history for this selection.">
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
    <Card title="Monthly Trend" subtitle={`${rangeLabel} · pick up to four metrics · hover or tap for detail`}>
      <MetricPicker groups={groups} selected={sel} onToggle={(key) => setSel(nextTrendSelection(sel, key))} />
      <CardBody>
        <TrendBody model={model} metrics={metrics} sel={sel} />
      </CardBody>
    </Card>
  );
}

const chipOf = (m: TrendMetric): MetricChip => ({ key: m.key, label: m.label, color: m.color });

function TrendBody({ model, metrics, sel }: { model: JobDashboardReadModel; metrics: TrendMetric[]; sel: string[] }) {
  const t = model.trends;
  const selIdx = t.findIndex((row) => row.month === model.selectedMonth);
  const labels = t.map((row, i) => (i === 0 || row.month.endsWith("-01") ? seriesLabel(row.month) : monthShortName(row.month)));
  const reprLast = t.reduce((last, row, i) => (row.provenance === "representative" ? i : last), -1);
  const verifiedDots = t.map((row, i) => (row.provenance === "verified" && i < reprLast ? i : -1)).filter((i) => i >= 0);
  const reprProps = reprLast >= 0 ? { reprTo: reprLast, dots: verifiedDots } : {};
  const mfmt = (unit: "pct" | "count" | undefined, v: number) =>
    unit === "pct" ? v.toFixed(1) + "%" : unit === "count" ? fmt.n(v) : fmt.money(v);

  if (sel.includes("yoy")) return <YoYTrend model={model} />;

  const drawn = metrics.filter((m) => sel.includes(m.key));
  const anyRepr = reprLast >= 0 && drawn.some((m) => m.repr);
  const fnote = anyRepr ? (
    <>
      Dashed = <span className="repr">representative</span> history, solid = verified — revenue and job counts are
      Simpro-verified for all {t.length} months.
    </>
  ) : (
    <>Revenue and job counts are verified against Simpro for all {t.length} months.</>
  );

  if (sel.length === 1 && sel[0] === "jobs") {
    return (
      <>
        <Histogram
          h={340}
          seriesName="Completed jobs"
          buckets={t.map((row, i) => ({
            label: labels[i],
            count: row.completedJobs,
            accent: i === selIdx,
            tipLabel: seriesLabel(row.month),
            extra:
              (row.avgJobValue != null ? tipRow("#9aa2b2", "Avg job value", fmt.moneyFull(row.avgJobValue)) : "") +
              tipRow("#9aa2b2", "Revenue", fmt.money(row.sellValue)) +
              (i >= 12 ? tipRow("#e2e6ec", `Jobs · ${seriesLabel(t[i - 12].month)}`, String(t[i - 12].completedJobs)) : ""),
          }))}
        />
        <Fnote>{fnote}</Fnote>
      </>
    );
  }

  const a2 = drawn.find((m) => m.axis === 2);
  const onlyPct = drawn.length > 0 && drawn.every((m) => m.unit === "pct");
  const annotations: TrendAnnotation[] = [];
  const ri = drawn.findIndex((m) => m.key === "rev");
  const ni = drawn.findIndex((m) => m.key === "np");
  /* Only months that actually completed work can be annotated — an empty
     month's $0 is absence of data, not a slowdown or a record. */
  const activeOnly = (value: number, i: number) => (t[i].completedJobs > 0 ? value : null);
  if (ri >= 0) {
    const maxIdx = argBest(t.map((r, i) => activeOnly(r.sellValue, i)), (a, b) => a > b);
    if (maxIdx >= 0 && maxIdx !== selIdx) {
      annotations.push({ s: ri, i: maxIdx, text: `${fmt.money(t[maxIdx].sellValue)} revenue`, sub: "best month on record" });
    }
  }
  if (ni >= 0) {
    const minIdx = argBest(t.map((r, i) => activeOnly(r.netProfit, i)), (a, b) => a < b);
    if (minIdx >= 0 && minIdx !== selIdx) {
      annotations.push({
        s: ni,
        i: minIdx,
        text: `${fmt.money(t[minIdx].netProfit)} net`,
        sub: `${monthShortName(t[minIdx].month)} slowdown`,
        dy: 1,
      });
    }
  }
  /* The band label states the selected month's figure — suppressed when the
     cohort has no supported basis for it (never a fabricated $0). */
  const coverage = model.selected.financialCoverage;
  const bandLabel =
    selIdx < 0
      ? undefined
      : sel.includes("np") && coverage.netProfitSupported > 0
        ? `${monthShortName(model.selectedMonth)} · ${fmt.money(t[selIdx].netProfit)} net`
        : sel.includes("rev") && coverage.sellValueSupported > 0
          ? `${monthShortName(model.selectedMonth)} · ${fmt.money(t[selIdx].sellValue)} revenue`
          : undefined;

  return (
    <>
      <TrendChart
        labels={labels}
        everyX={2}
        h={340}
        band={selIdx >= 0 ? selIdx : null}
        bandLabel={bandLabel}
        tipLabel={(i) => seriesLabel(t[i].month)}
        annotations={annotations}
        yFmt={fmt.money}
        y2Fmt={a2 && a2.unit === "pct" ? (v) => v.toFixed(0) + "%" : fmt.n}
        yMax={onlyPct ? 100 : undefined}
        yMin={onlyPct ? 0 : undefined}
        tipExtra={(i) =>
          i >= 12
            ? `<div style="border-top:1px solid #f1f2f6;margin-top:5px;padding-top:5px">` +
              drawn
                .map((m) => {
                  const v = m.values[i - 12];
                  return v == null ? "" : tipRow("#e2e6ec", `${m.label} · ${seriesLabel(t[i - 12].month)}`, mfmt(m.unit, v));
                })
                .join("") +
              `</div>`
            : ""
        }
        series={drawn.map(
          (m): TrendSeries => ({
            ...(m.repr ? reprProps : {}),
            name: m.label,
            color: m.color,
            values: m.values,
            axis: m.axis,
            star: m.key === "np",
            fill: m.key === "np",
            endLabel: false,
            tipFmt: m.unit ? (v) => mfmt(m.unit, v) : undefined,
          }),
        )}
      />
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
  const priorVerified: number[] = [];
  let priorMonths = 0;
  let curReprLast = -1;
  for (const row of t) {
    const m = Number(row.month.slice(5)) - 1;
    if (row.month.startsWith(prevYear)) {
      prior[m] = row.netProfit;
      priorMonths += 1;
      if (row.provenance === "verified") priorVerified.push(m);
    }
    if (row.month.startsWith(curYear) && row.month <= model.selectedMonth) {
      cur[m] = row.netProfit;
      if (row.provenance === "representative") curReprLast = m;
    }
  }
  const priorAllVerified = priorMonths > 0 && priorVerified.length === priorMonths;
  const M12 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const band = Number(model.selectedMonth.slice(5)) - 1;
  const curNet = cur[band];
  const priorNet = prior[band];
  const bandLabel =
    curNet != null && priorNet != null
      ? `${monthShortName(model.selectedMonth)} ’${curYear.slice(2)} · ${fmt.money(curNet)} vs ${fmt.money(priorNet)}`
      : curNet != null
        ? `${monthShortName(model.selectedMonth)} ’${curYear.slice(2)} · ${fmt.money(curNet)}`
        : undefined;
  const sw = (c: string) => (
    <i
      style={{
        display: "inline-block",
        width: 14,
        height: 3,
        borderRadius: 2,
        background: c,
        verticalAlign: 2,
        marginRight: 5,
      }}
    />
  );
  const markedNote = priorAllVerified ? (
    <>the ’{prevYear.slice(2)} line is verified throughout.</>
  ) : priorVerified.length > 0 ? (
    <>
      solid spans and the marked {priorVerified.map((m) => `${M12[m]} ’${prevYear.slice(2)}`).join(", ")}{" "}
      {priorVerified.length === 1 ? "point is" : "points are"} verified.
    </>
  ) : (
    <>solid spans are verified.</>
  );

  return (
    <>
      <TrendChart
        labels={M12}
        everyX={1}
        h={340}
        band={band}
        bandLabel={bandLabel}
        tipLabel={(i) => M12[i]}
        yFmt={fmt.money}
        series={[
          {
            name: `Net ’${prevYear.slice(2)}`,
            color: "#c9cfda",
            ...(priorAllVerified ? {} : { dash: "4 4.5", dots: priorVerified }),
            values: prior,
            tipFmt: fmt.money,
          },
          {
            name: `Net ’${curYear.slice(2)}`,
            color: "#5b63d3",
            star: true,
            fill: true,
            endLabel: false,
            ...(curReprLast >= 0 ? { reprTo: curReprLast } : {}),
            values: cur,
            tipFmt: fmt.money,
          },
        ]}
      />
      <Fnote>
        {sw("#c9cfda")}Net ’{prevYear.slice(2)} · {sw("#5b63d3")}Net ’{curYear.slice(2)} — dashed spans are{" "}
        <span className="repr">representative</span>; {markedNote}
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

/* ── Revenue → Net bridge ──────────────────────────────── */

/**
 * Display rounding for the approved waterfall: whole-dollar components that
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

function BridgeCard({ model }: { model: JobDashboardReadModel }) {
  const selected = model.selected;
  const monthLong = monthLongName(model.selectedMonth);
  const supported =
    selected.financialCoverage.netProfitSupported > 0 && selected.financialCoverage.sellValueSupported > 0;
  const steps = supported
    ? buildBridgeSteps(selected.profitBridge, selected.grossProfitActual, selected.netProfitActual, false)
    : null;
  const revenue = steps?.[0]?.value ?? 0;
  const materials = steps?.[1]?.value ?? 0;
  const labor = steps?.[2]?.value ?? 0;
  const gross = steps?.[3]?.value ?? 0;
  const overhead = steps?.[4]?.value ?? 0;
  const net = steps?.[5]?.value ?? 0;
  const netPct = revenue > 0 && net > 0 ? Math.min(100, (net / revenue) * 100) : 0;
  return (
    <Card
      style={{ display: "flex", flexDirection: "column" }}
      title="Revenue to Net Profit"
      def={`Simpro job-cost components across the ${monthLong} cohort, display-rounded to whole dollars so the chain sums exactly. The overhead step includes overhead, commission cost inputs and any residual, so gross − overhead = net.`}
      subtitle={
        steps
          ? `${monthLong} cost components · one revenue bar, net labeled directly`
          : `${monthLong} cost components`
      }
    >
      <CardBody style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-start", minHeight: 0 }}>
        {steps ? (
          <>
            <div className="compact-bridge">
              <span className="compact-bridge-fill" style={{ width: `${netPct}%` }} />
            </div>
            <div className="compact-split">
              <b>{fmt.moneyFull(net)} net profit</b>
              <span>{fmt.moneyFull(revenue)} revenue</span>
            </div>
            <div className="mini-metric-grid" style={{ marginTop: 16 }}>
              <div>
                <span>Materials</span>
                <b className="tnum">{fmt.moneyFull(materials)}</b>
              </div>
              <div>
                <span>Labor</span>
                <b className="tnum">{fmt.moneyFull(labor)}</b>
              </div>
              <div>
                <span>Gross profit</span>
                <b className="tnum">{fmt.moneyFull(gross)}</b>
              </div>
              <div>
                <span>Overhead</span>
                <b className="tnum">{fmt.moneyFull(overhead)}</b>
              </div>
            </div>
          </>
        ) : (
          <StateEmpty>The {monthLong} cohort has no supported revenue and net-profit totals to bridge.</StateEmpty>
        )}
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--hair-2)" }}>
          <div className="ti">Work Source Mix</div>
          <div className="st">{monthLong} completed jobs by source · labels show margin and revenue</div>
          <WorkSourceVisual model={model} />
        </div>
      </CardBody>
    </Card>
  );
}

/* ── Work source ───────────────────────────────────────── */

function WorkSourceVisual({ model }: { model: JobDashboardReadModel }) {
  const rows = model.selected.jobSourceRows;
  const totalJobs = Math.max(rows.reduce((sum, row) => sum + row.jobs, 0), 1);
  const sourceColors: Record<string, string> = {
    "Quote-generated": "#5b63d3",
    Recurring: "#9aa2b2",
    "Direct service": "#404a60",
  };
  return (
    <>
      <div className="status-mix-bar" aria-label="Completed jobs by work source" style={{ marginTop: 10 }}>
        {rows.map((row) => (
          <span
            key={row.sourceType}
            style={{
              width: `${(row.jobs / totalJobs) * 100}%`,
              background: sourceColors[row.sourceType] ?? "#6d7890",
            }}
          />
        ))}
      </div>
      <div className="source-mix-list">
        {rows.map((row) => {
          const revenueSupported = row.revenueCoverage > 0;
          const netSupported = row.netProfitCoverage > 0;
          const margin = row.netMargin == null ? "—" : pctText(row.netMargin);
          return (
            <div key={row.sourceType}>
              <span>
                <i style={{ background: sourceColors[row.sourceType] ?? "#6d7890" }} />
                {row.sourceType}
              </span>
              <b className="tnum">{row.jobs}</b>
              <em className="tnum">
                {revenueSupported ? fmt.moneyFull(row.revenue) : "revenue n/a"} · {netSupported ? `${fmt.moneyFull(row.netProfit)} net` : "net n/a"} · {margin}
              </em>
            </div>
          );
        })}
      </div>
      <Fnote>
        Work source is classification only. Negative rows elsewhere on this page require actual Simpro net profit below zero.
      </Fnote>
    </>
  );
}

/* ── Loss module ───────────────────────────────────────── */

const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** "an $863 ticket" vs "a $59 ticket" — ported from the approved kit. */
export function ticketArticle(v: number): string {
  return String(Math.round(Math.abs(v)))[0] === "8" ? "an" : "a";
}

function NetNegativeJobsCard({ model, onOpen }: { model: JobDashboardReadModel; onOpen: (row: JobDrilldownRow) => void }) {
  const selected = model.selected;
  const monthLong = monthLongName(model.selectedMonth);
  const breakdown = selected.lossBreakdown;
  if (breakdown.lossJobs === 0) {
    return (
      <Card title="Net-Negative Jobs" subtitle={`${monthLong} jobs below zero actual net profit`}>
        <CardBody>
          <StateEmpty>No {monthLong} jobs finished below zero actual net profit.</StateEmpty>
        </CardBody>
      </Card>
    );
  }
  const losses = [...selected.lossRecords].sort((a, b) => (a.netProfit ?? 0) - (b.netProfit ?? 0));
  const shown = losses.slice(0, 6);
  const maxLoss = Math.max(Math.abs(shown[0]?.netProfit ?? 0), 1);
  const shownWord = NUMBER_WORDS[shown.length] ?? String(shown.length);
  const lossShare = selected.completedJobCount > 0 ? (breakdown.lossJobs / selected.completedJobCount) * 100 : 0;
  return (
    <Card
      title="Net-Negative Jobs"
      subtitle={`${monthLong} jobs where Simpro NetProfit Actual is below zero · click a job for detail`}
      footer={
        <>
          <span>
            {breakdown.lossJobs > shown.length
              ? `${shownWord} largest net-negative jobs shown · all ${breakdown.lossJobs} appear in the completed-jobs drilldown`
              : `All ${breakdown.lossJobs} net-negative ${breakdown.lossJobs === 1 ? "job" : "jobs"} shown · also in the completed-jobs drilldown`}
          </span>
          <span />
        </>
      }
    >
      <div className="g57" style={{ margin: 0, gap: 0, marginTop: 0 }}>
        <div
          className="bd"
          style={{
            borderRight: "1px solid var(--hair-2)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <div className="bigstat" style={{ marginBottom: 18 }}>
            <div className="n tnum" style={{ color: "var(--down)" }}>
              {fmt.moneyFull(breakdown.netTotal)}
            </div>
            <div className="d">
              <Def def={`Count of completed ${monthLong} jobs where Simpro NetProfit Actual is below zero.`}>
                {breakdown.lossJobs} of {selected.completedJobCount} {monthLong} jobs finished below zero actual net profit
              </Def>
            </div>
          </div>
          <div className="compact-meter danger">
            <span style={{ width: `${Math.min(Math.max(lossShare, 0), 100)}%` }} />
          </div>
          <div className="compact-split" style={{ marginTop: 10 }}>
            <b>{lossShare.toFixed(1)}% of completed jobs</b>
            <span>actual net below zero</span>
          </div>
          <Fnote>
            This card does not infer losses from source type, job structure, or ticket size. It only uses Simpro NetProfit Actual.
          </Fnote>
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0 }}>
          {shown.map((row) => (
            <BRow
              key={row.jobId}
              neg
              barWidth={Math.max(4, (Math.abs(row.netProfit ?? 0) / maxLoss) * 100)}
              style={{ padding: "12px 20px" }}
              onClick={() => onOpen(row)}
              nameRow={
                <>
                  <div className="id1" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {row.name}
                  </div>
                  <div className="id2">{lossRowSub(row)}</div>
                </>
              }
              mid={
                row.sellValue != null ? (
                  <span className="id2 tnum" style={{ flex: "none" }}>
                    {fmt.moneyFull(row.sellValue)}
                  </span>
                ) : null
              }
              value={row.netProfit != null ? fmt.moneyFull(row.netProfit) : "—"}
              valueStyle={{ color: "var(--down)", fontSize: 15 }}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}

function lossRowSub(row: JobDrilldownRow): string {
  const parts = [`Job ${row.jobId}`, row.siteName];
  if (row.technicians.length > 0) parts.push(row.technicians.join(", "));
  if (row.actualHours != null) {
    parts.push(`${trimHours(row.actualHours)}h recorded`);
  }
  return parts.join(" · ");
}

/* ── Labor ─────────────────────────────────────────────── */

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
          onChange={(val) => setMode(val as "quote" | "recurring")}
        />
      }
    >
      <CardBody className="fillbd">
        {mode === "quote" ? (
          <QuoteLinkedLabor model={model} />
        ) : (
          <RecurringLabor rows={cohort.rows} complete={cohort.complete} />
        )}
      </CardBody>
    </Card>
  );
}

function LaborBars({ est, act }: { est: number; act: number }) {
  const max = Math.max(est, act, 0.0001) * 1.12;
  return (
    <>
      {(
        [
          ["Estimated", est, "#9aa2b2"],
          ["Actual", act, "#5b63d3"],
        ] as const
      ).map(([label, value, color]) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 76, fontSize: 13.5, fontWeight: 600, color: "var(--ink-2)", flex: "none" }}>{label}</span>
          <div style={{ flex: 1, height: 24, background: "#f1f2f6", borderRadius: 7, overflow: "hidden" }}>
            <div style={{ width: `${(value / max) * 100}%`, height: "100%", background: color, borderRadius: 7 }} />
          </div>
          <b className="tnum" style={{ width: 64, textAlign: "right", fontSize: 14 }}>
            {fmt.hrs(value)}
          </b>
        </div>
      ))}
    </>
  );
}

function LaborHeadline({ cov, pct }: { cov: ReactNode; pct: number | null }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, marginTop: 2 }}>
      <span style={{ fontSize: 13, color: "var(--muted)" }}>{cov}</span>
      <span style={{ textAlign: "right", flex: "none" }}>
        <span
          className="tnum"
          style={{
            fontWeight: 800,
            fontSize: 26,
            letterSpacing: "-.03em",
            color: pct == null ? "var(--muted)" : pct > 0 ? "var(--down)" : "var(--up)",
          }}
        >
          {pct == null ? "—" : signedPct(pct)}
        </span>
        <span
          className="def"
          data-def={OVER_ESTIMATE_DEF}
          style={{
            display: "block",
            fontSize: 11.5,
            fontWeight: 600,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "var(--subtle)",
          }}
        >
          over estimate
        </span>
      </span>
    </div>
  );
}

const laborSectionTitle: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: ".06em",
  textTransform: "uppercase",
  color: "var(--faint)",
  padding: "10px 0 2px",
};

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
  const topOverruns = [...ql.perJob]
    .sort((a, b) => b.varianceHours - a.varianceHours)
    .filter((row) => row.varianceHours > 0)
    .slice(0, 3);
  return (
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1, gap: 15, paddingTop: 8 }}>
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
      <div>
        {perJobAsc.length > 0 ? (
          <>
            <div style={{ ...laborSectionTitle, borderTop: "1px solid var(--hair-2)" }}>
              Per-job variance — {perJobAsc.length} covered jobs, sorted · {over.length} over (+{overSum.toFixed(1)}h,
              red) · {under.length} under (−{underSum.toFixed(1)}h) · {onEstimate} on estimate
            </div>
            <DevStrip
              h={130}
              unit="Hours variance"
              fmt={hoursSigned}
              items={perJobAsc.map((row) => ({
                v: row.varianceHours,
                label:
                  row.varianceHours > 0
                    ? `+${trimHours(row.varianceHours)}h over estimate`
                    : row.varianceHours < 0
                      ? `${hoursSigned(row.varianceHours).replace(".00", "")} under estimate`
                      : "on estimate",
              }))}
            />
          </>
        ) : null}
        <div style={{ ...laborSectionTitle, ...(perJobAsc.length > 0 ? {} : { borderTop: "1px solid var(--hair-2)" }) }}>
          Largest overruns
        </div>
        {topOverruns.length > 0 ? (
          topOverruns.map((row) => (
            <LaborOverrunRow
              key={row.jobId}
              name={`${row.jobId} · ${row.siteName} — ${row.name}`}
              det={`${trimHours(row.estimatedHours)}h quoted · ${trimHours(row.actualHours)}h actual`}
              delta={`+${trimHours(row.varianceHours)}h`}
            />
          ))
        ) : (
          <div className="id2" style={{ padding: "9px 0" }}>
            No overruns — every covered job finished at or under its estimate.
          </div>
        )}
      </div>
    </div>
  );
}

function RecurringLabor({ rows, complete }: { rows: JobDrilldownRow[]; complete: boolean }) {
  const facts = recurringLaborFacts(rows);
  const exclusions = facts.exclusions.slice(0, 3);
  return (
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1, gap: 15, paddingTop: 8 }}>
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
      <div>
        <div style={{ ...laborSectionTitle, borderTop: "1px solid var(--hair-2)" }}>
          Recorded hours with no plan estimate — excluded from the %
        </div>
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
        <Fnote style={{ marginTop: 0 }}>
          <span className="repr">Representative</span> until recurring estimates are re-verified per plan.
          {!complete ? " Computed from the loaded jobs only — the full month is still loading." : ""}
        </Fnote>
      </div>
    </div>
  );
}

/* ── Profitability by Site / Category ──────────────────── */

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
      footer={
        <>
          <span>{foot}</span>
          <span />
        </>
      }
    >
      <div style={{ paddingBottom: 8 }}>
        {rows.map((row) => {
          const nm = row.sell > 0 ? (row.np / row.sell) * 100 : null;
          const share = totalNet !== 0 ? (row.np / totalNet) * 100 : null;
          return (
            <BRow
              key={row.label}
              rem={row.isRemainder}
              barWidth={row.isRemainder || maxNp <= 0 ? 0 : Math.max(2, (row.np / maxNp) * 100)}
              barColor={row.isRemainder ? "transparent" : undefined}
              name={row.label}
              sub={
                <span className="tnum">
                  {row.jobs} {row.jobs === 1 ? "job" : "jobs"} · {fmt.moneyFull(row.sell)} revenue
                </span>
              }
              onClick={
                row.isRemainder
                  ? undefined
                  : () => onOpen({ kind: "prof", mode, label: row.label, jobs: row.jobs, sell: row.sell, np: row.np })
              }
              valueBold={false}
              value={
                <span style={{ display: "inline-block", textAlign: "right" }}>
                  <b className="tnum" style={{ fontSize: 14 }}>
                    {fmt.moneyFull(row.np)}
                  </b>
                  <span className="id2 tnum" style={{ display: "block" }}>
                    {nm != null ? `${pctText(nm)} margin` : "margin n/a"}
                    {share != null ? ` · ${pctText(share)} of net` : ""}
                  </span>
                </span>
              }
            />
          );
        })}
      </div>
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
 * Assembles the full month cohort by walking the real paginated /api/jobs
 * payload (unfiltered — table filters are applied client-side so they change
 * only the drilldown cohort, never the page's read model). Throws instead of
 * returning a partial cohort.
 */
export async function fetchAllCompletedJobs(
  model: JobDashboardReadModel,
  fetcher: JobsFetcher = fetch,
): Promise<JobDrilldownRow[]> {
  const { total, totalPages } = model.drilldownPagination;
  if (model.selected.records.length >= total) return model.selected.records;
  const rows: JobDrilldownRow[] = [];
  for (let page = 1; page <= totalPages; page += 1) {
    const search = new URLSearchParams({ month: model.selectedMonth, page: String(page) });
    const response = await fetcher(`/api/jobs?${search.toString()}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`The complete job list could not be loaded (page ${page} failed).`);
    }
    const data = (await response.json()) as JobDashboardReadModel;
    rows.push(...data.selected.records);
  }
  if (rows.length !== total) {
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
  const lines = [header.map(csvEscape).join(",")];
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
        .map((value) => csvEscape(String(value)))
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
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

export type FullCohort = { rows: JobDrilldownRow[]; complete: boolean; error: string | null };

/** Full-cohort loader shared by the drilldown table and the recurring labor
 *  mode. Kicks off the paginated walk once, on the client. */
function useFullCohort(model: JobDashboardReadModel): FullCohort {
  const initialComplete = model.selected.records.length >= model.drilldownPagination.total;
  const [state, setState] = useState<{ rows: JobDrilldownRow[] | null; error: string | null }>(() => ({
    rows: initialComplete ? model.selected.records : null,
    error: null,
  }));
  useEffect(() => {
    if (initialComplete) return;
    let cancelled = false;
    fetchAllCompletedJobs(model)
      .then((rows) => {
        if (!cancelled) setState({ rows, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ rows: null, error: error instanceof Error ? error.message : "Load failed." });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.selectedMonth]);
  return {
    rows: state.rows ?? model.selected.records,
    complete: state.rows !== null,
    error: state.error,
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
  const total = anyFilter || cohort.complete ? filteredAll.length : model.drilldownPagination.total;
  const totalPages = Math.max(1, Math.ceil(total / CLIENT_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * CLIENT_PAGE_SIZE;
  const visible = filteredAll.slice(start, start + CLIENT_PAGE_SIZE);
  const setFilter = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(1);
  };

  const downloadCsv = () => {
    setCsvError(null);
    if (!cohort.complete) {
      setCsvError(cohort.error ?? "The complete job list is still loading. No file was downloaded.");
      return;
    }
    const csv = buildCompletedJobsCsv(filteredAll);
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
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <StateEmpty>
                    {anyFilter ? "No completed jobs match the current filters." : "No completed jobs to show."}
                  </StateEmpty>
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <tr key={row.jobId} className="rowlink" onClick={() => onOpen(row)}>
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
                    {row.netProfit != null ? fmt.moneyFull(row.netProfit) : "—"}
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
          {!cohort.complete && !cohort.error ? " · loading the full month…" : ""}
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
                disabled={!cohort.complete && entry * CLIENT_PAGE_SIZE > cohort.rows.length}
                onClick={() => setPage(entry)}
              >
                {entry}
              </button>
            ),
          )}
          <button
            type="button"
            disabled={safePage === totalPages}
            onClick={() => setPage(safePage + 1)}
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

function JobDrawerBody({ row, loss }: { row: JobDrilldownRow; loss?: boolean }) {
  const margin = netMarginDisplay(row.sellValue, row.netProfit);
  return (
    <>
      <KV>
        <KVCell label="Sell value" value={row.sellValue != null ? fmt.moneyFull(row.sellValue) : "N/A"} />
        {!loss && row.grossProfit != null ? <KVCell label="Gross profit" value={fmt.moneyFull(row.grossProfit)} /> : null}
        <KVCell
          label="Net profit"
          value={row.netProfit != null ? fmt.moneyFull(row.netProfit) : "N/A"}
          valueStyle={{ color: row.netProfit != null && row.netProfit < 0 ? "var(--down)" : "var(--ink)" }}
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
          <DNote>This job appears here only because Simpro NetProfit Actual is below zero. No additional cause is inferred by the dashboard.</DNote>
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

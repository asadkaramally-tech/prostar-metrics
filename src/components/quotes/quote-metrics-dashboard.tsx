"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { fmt, tipRow, Bullet, Heatmap, TrendChart, type BulletProps, type TrendAnnotation, type TrendSeries } from "@/components/charts";
import { useContainerWidth } from "@/components/charts/use-container-width";
import {
  Card,
  CardBody,
  Chipd,
  DCell,
  Def,
  DefTooltipProvider,
  DGrid,
  DNote,
  DSec,
  Fnote,
  Focal,
  FocalCov,
  FocalLabel,
  FocalMeta,
  FocalValue,
  Hero,
  Insight,
  KV,
  KVCell,
  Legend,
  MetricPicker,
  Mgn,
  Skel,
  StateEmpty,
  StateError,
  StateMini,
  StatesStrip,
} from "@/components/reset";
import {
  type QuoteDealTier,
  type QuoteFollowUpQueue,
  type QuoteFollowUpQueueRow,
  type QuoteMetricsReadModel,
  type QuoteMonthlyMetric,
} from "@/lib/store/quote-dashboard-read-model";

/* /quotes — implements the approved
   redesign-handoff/product-reset/APPROVED-2026-07-15/mockups/quotes.html
   exactly, with every figure taken from the read-model payload (the mockup's
   numbers were the June-2026 snapshot). Fused hero-split, Overview/History
   tabs, status mix first, tier rows + tier×month heatmap, 12-month history
   table with computed T12 row, honest states, one-line footline. */

export type QuoteMetricsDashboardProps = {
  model: QuoteMetricsReadModel;
  /** Renders the design-reference state strip (mockups' ?states=1 gate). */
  showStates?: boolean;
  /** Deep-link parity with the approved mockup (?history=1). */
  initialTab?: "overview" | "history";
  /** Deep-link parity with the approved mockup (?mode=volume). */
  initialTrendVolume?: boolean;
};

export function QuoteMetricsDashboard({
  model,
  showStates,
  initialTab = "overview",
  initialTrendVolume = false,
}: QuoteMetricsDashboardProps) {
  const failed = model.quotesLoaded === 0 && model.warnings.length > 0;
  return (
    <DefTooltipProvider>
      {failed ? (
        <QuotesLoadError detail={model.warnings[0]} />
      ) : (
        <QuotesContent
          model={model}
          initialTab={initialTab}
          initialTrendVolume={initialTrendVolume}
        />
      )}
      <StatesStrip show={showStates}>
        <StateMini label="Loading">
          <Skel width="55%" />
          <Skel width="85%" />
          <Skel width="70%" />
        </StateMini>
        <StateMini label="Partial month (pace)">
          <StateEmpty>{partialMonthStateCopy(model)}</StateEmpty>
        </StateMini>
        <StateMini label="Empty tier cell">
          <StateEmpty>A month with no quotes in a tier shows — (never 0%).</StateEmpty>
        </StateMini>
        <StateMini label="Error">
          <StateError>Quote data could not be loaded.</StateError>
        </StateMini>
      </StatesStrip>
      <div className="footline">
        Source: Simpro quotes · month assigned by DateApproved · acceptance requires verified online acceptance or an exact converted job
      </div>
    </DefTooltipProvider>
  );
}

function QuotesLoadError({ detail }: { detail: string }) {
  return (
    <Card>
      <CardBody>
        <StateError onRetry={() => window.location.reload()}>
          Quote data could not be loaded. <span className="sr-only">{detail}</span>
        </StateError>
      </CardBody>
    </Card>
  );
}

/** Real partial-month example copy for the states strip, driven by the payload
 *  (never the mockup's hardcoded July figures). */
export function partialMonthStateCopy(model: QuoteMetricsReadModel): ReactNode {
  const p = model.provisional;
  if (p.isCurrentMonthPartial && model.currentMonth) {
    const long = monthLong(model.selectedMonth);
    return (
      <>
        <b style={{ color: "var(--ink)" }}>{long} so far:</b> {model.currentMonth.quoteCount} quotes /{" "}
        {fmt.moneyFull(model.currentMonth.quoteValue)} through day {p.elapsedDays} — on pace for ~
        {Math.round(p.pace.quoteCount)}. Comparisons switch to same-day prior year.
      </>
    );
  }
  return (
    <>
      Selecting the live month shows actuals through the pull day — an on-pace projection and same-day
      prior-year comparisons replace full-month deltas.
    </>
  );
}

/* ── Page content ──────────────────────────────────────── */

function QuotesContent({
  model,
  initialTab,
  initialTrendVolume,
}: {
  model: QuoteMetricsReadModel;
  initialTab: "overview" | "history";
  initialTrendVolume: boolean;
}) {
  const [tab, setTab] = useState<"overview" | "history">(initialTab);
  const months = useMemo(() => [...model.monthlyBreakdown].reverse(), [model.monthlyBreakdown]);
  const cur = model.currentMonth;
  if (!cur) {
    return (
      <Card>
        <CardBody>
          <StateEmpty>No quote activity is recorded for {monthLong(model.selectedMonth)} — pick another month.</StateEmpty>
        </CardBody>
      </Card>
    );
  }
  return (
    <>
      <Hero split>
        <QuotesFocal model={model} cur={cur} months={months} />
        <QuoteStatusMixCard model={model} cur={cur} />
      </Hero>

      <div className="tabs" id="pageTabs">
        <button type="button" data-tab="overview" className={tab === "overview" ? "on" : undefined} aria-pressed={tab === "overview"} onClick={() => setTab("overview")}>
          Overview
        </button>
        <button type="button" data-tab="history" className={tab === "history" ? "on" : undefined} aria-pressed={tab === "history"} onClick={() => setTab("history")}>
          History
        </button>
      </div>

      <div id="tab-overview" style={tab === "overview" ? undefined : { display: "none" }}>
        <div className="g57">
          <TrendCard model={model} months={months} initialVolume={initialTrendVolume} />
          <TiersCard model={model} cur={cur} />
        </div>
        <div style={{ marginTop: 18 }}>
          <HeatmapCard model={model} months={months} />
        </div>
      </div>

      <div id="tab-history" style={tab === "history" ? undefined : { display: "none" }}>
        <HistoryCard model={model} months={months} />
      </div>
    </>
  );
}

/* ── Hero focal ────────────────────────────────────────── */

function QuotesFocal({ model, cur, months }: { model: QuoteMetricsReadModel; cur: QuoteMonthlyMetric; months: QuoteMonthlyMetric[] }) {
  const partial = model.provisional.isCurrentMonthPartial;
  const long = monthLong(model.selectedMonth);
  const ly = partial ? model.priorYearSameDay : model.priorYearSameMonth;
  const lyLabel = `${seriesName(addYears(model.selectedMonth, -1))}${partial ? ` · day ${model.provisional.elapsedDays}` : ""}`;
  const prior = model.priorMonth;
  const priorWord = prior ? monthLong(prior.month) : "prior month";
  const momClause = (curVal: number | null, priorVal: number | null | undefined) => {
    const pct = percentChange(curVal, priorVal ?? null);
    return pct === null ? "" : ` Vs ${priorWord}: ${signedPct(pct)}.`;
  };
  const rateDelta = displayRoundedPtsDelta(cur.acceptanceRateCount, ly?.acceptanceRateCount ?? null);
  const momRateDelta = displayRoundedPtsDelta(cur.acceptanceRateCount, prior?.acceptanceRateCount ?? null);
  const sentYoY = percentChange(cur.quoteCount, ly?.quoteCount ?? null);
  const high = highRateMonth(months);
  return (
    <Focal style={{ paddingBottom: 24 }}>
      <FocalLabel>
        <Def
          def={`Accepted ÷ (accepted + not accepted) among non-excluded quotes whose DateApproved falls in ${long}. Accepted requires verified online acceptance or an exact converted-job link — never quote stage or status alone.`}
        >
          Acceptance Rate
        </Def>
        {" · "}
        {long}
        {partial ? " to date" : ""}
      </FocalLabel>
      <FocalValue>{rateText(cur.acceptanceRateCount)}</FocalValue>
      <FocalMeta>
        <Mgn>
          {cur.acceptedCount} of {cur.quoteCount} quotes accepted
        </Mgn>
        {rateDelta !== null && ly ? (
          <Chipd
            tone={rateDelta < 0 ? "dn" : rateDelta > 0 ? "up" : "neutral"}
            def={ptsChipDef(cur.acceptanceRateCount, ly.acceptanceRateCount, `${long.slice(0, 3)} ’${model.selectedMonth.slice(2, 4)}`, seriesName(addYears(model.selectedMonth, -1)), rateDelta)}
          >
            {rateDelta < 0 ? "↓" : "↑"} {Math.abs(rateDelta).toFixed(1)} pts vs {lyLabel}
          </Chipd>
        ) : null}
        {momRateDelta !== null && prior ? (
          <Chipd tone="neutral">
            {momRateDelta < 0 ? "↓" : "↑"} {Math.abs(momRateDelta).toFixed(1)} pts vs {priorWord}
          </Chipd>
        ) : null}
      </FocalMeta>
      <FocalCov style={{ display: "flex", gap: 22, flexWrap: "wrap", marginTop: 12 }}>
        <span>
          <span style={covLabelStyle("#6bd3a0")}>Won</span>
          <b className="tnum" style={{ fontSize: 16, color: "#e9ebf4" }}>{fmt.moneyFull(cur.acceptedValue)}</b>{" "}
          <span style={{ color: "#9ba2b6" }}>· {rateText(cur.acceptanceRateValue)} of quoted value</span>
        </span>
        <span>
          <span style={covLabelStyle("#f0937f")}>Open — not yet accepted</span>
          <b className="tnum" style={{ fontSize: 16, color: "#e9ebf4" }}>{fmt.moneyFull(cur.notAcceptedValue)}</b>{" "}
          <span style={{ color: "#9ba2b6" }}>
            · {cur.notAcceptedCount} quotes{" "}
            <Def def="Simpro records no declined status — an open quote counts as in play until verified acceptance, conversion, or archival. Age is the practical dead-signal.">
              still in play
            </Def>
          </span>
        </span>
      </FocalCov>
      <DGrid>
        <DCell
          label="Quotes Sent"
          def={`Count of non-excluded quotes with DateApproved in ${long}. DateApproved sets the month only — it is not acceptance evidence.${momClause(cur.quoteCount, prior?.quoteCount)}`}
          value={fmt.n(cur.quoteCount)}
          u={deltaU(cur.quoteCount, ly?.quoteCount ?? null)}
        />
        <DCell
          label="Quote Value"
          def={`Σ quote total (ex-tax) across the ${long} cohort.${momClause(cur.quoteValue, prior?.quoteValue)}`}
          value={fmt.moneyFull(cur.quoteValue)}
          u={deltaU(cur.quoteValue, ly?.quoteValue ?? null)}
        />
        <DCell
          label="Won Value"
          def={`Σ quote total across ${long} quotes classified Accepted (verified online acceptance or exact converted job).${momClause(cur.acceptedValue, prior?.acceptedValue)}`}
          value={fmt.moneyFull(cur.acceptedValue)}
          u={deltaU(cur.acceptedValue, ly?.acceptedValue ?? null)}
        />
        <DCell
          label="Avg Accepted Deal"
          def={`Accepted value ÷ accepted count for ${long}.${momClause(cur.averageAcceptedDeal, prior?.averageAcceptedDeal)}`}
          value={cur.averageAcceptedDeal === null ? "N/A" : fmt.moneyFull(cur.averageAcceptedDeal)}
          u={deltaU(cur.averageAcceptedDeal, ly?.averageAcceptedDeal ?? null)}
        />
      </DGrid>
      <div style={{ marginTop: "auto", paddingTop: 18 }}>
        {cur.acceptanceRateCount !== null && high ? (
          <HeroBullet
            cur={{ m: long, v: round1(cur.acceptanceRateCount) }}
            comp={ly?.acceptanceRateCount != null ? { m: seriesName(addYears(model.selectedMonth, -1)), v: round1(ly.acceptanceRateCount) } : null}
            high={{ m: seriesName(high.month), v: round1(high.rate) }}
            fmt={(v) => v.toFixed(1) + "%"}
          />
        ) : null}
      </div>
      <FocalCov style={{ paddingTop: 14 }}>
        Tile deltas compare to {lyLabel}
        {rateDelta !== null && rateDelta < 0 && sentYoY !== null && sentYoY > 0 && aboveZero(percentChange(cur.acceptedValue, ly?.acceptedValue ?? null))
          ? ` · a rate drop on ${Math.round(sentYoY)}% more volume still means more won work`
          : ""}
      </FocalCov>
    </Focal>
  );
}

/** Bullet plus the approved collision guard (quotes.html page-local script):
 *  if the comparison label runs into the right-pinned High label, move High
 *  to the free top-right slot in the same 11px style. */
function HeroBullet(props: BulletProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const rows = ref.current?.firstElementChild?.children;
    if (!rows || rows.length < 3) return;
    const bottom = [...rows[2].querySelectorAll("span")].filter((span) => span.textContent?.trim());
    const highLabel = bottom.find((span) => /^High/.test(span.textContent?.trim() ?? ""));
    const compLabel = bottom.find((span) => span !== highLabel);
    if (
      highLabel instanceof HTMLElement &&
      compLabel instanceof HTMLElement &&
      compLabel.getBoundingClientRect().right + 8 > highLabel.getBoundingClientRect().left
    ) {
      highLabel.style.fontSize = "11px";
      highLabel.style.fontWeight = "400";
      highLabel.style.color = "#8b90a6";
      rows[0].appendChild(highLabel);
    }
  });
  return (
    <div ref={ref}>
      <Bullet {...props} />
    </div>
  );
}

function covLabelStyle(color: string): CSSProperties {
  return { display: "block", fontSize: 11.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color };
}

function ptsChipDef(cur: number | null, prior: number | null, curLabel: string, priorLabel: string, delta: number): string {
  const c = round1(cur ?? 0).toFixed(1);
  const p = round1(prior ?? 0).toFixed(1);
  const abs = Math.abs(delta).toFixed(1);
  const arithmetic = delta < 0 ? `${p}% (${priorLabel}) − ${c}% (${curLabel})` : `${c}% (${curLabel}) − ${p}% (${priorLabel})`;
  return `Display-rounded: ${arithmetic} = ${abs} pts. Deltas are computed on the one-decimal rates shown.`;
}

function QuoteStatusMixCard({ model, cur }: { model: QuoteMetricsReadModel; cur: QuoteMonthlyMetric }) {
  const long = monthLong(model.selectedMonth);
  const quoteValue = Math.max(cur.quoteValue, 0);
  const acceptedPct = quoteValue > 0 ? (cur.acceptedValue / quoteValue) * 100 : 0;
  const openPct = quoteValue > 0 ? (cur.notAcceptedValue / quoteValue) * 100 : 0;
  const aging = agingBins(model.followUpQueue.rows);
  return (
    <Card
      style={{ marginTop: 0 }}
      title="Quote Status Mix"
      def="Accepted value versus still-open/not-yet-accepted value inside the selected quote cohort. This is a metric view, not a task queue."
      subtitle={`${long} cohort · accepted vs open quoted value`}
    >
      <CardBody>
        <div className="status-mix-bar" aria-label="Accepted and open quote value split">
          <span style={{ width: `${Math.max(0, Math.min(acceptedPct, 100))}%`, background: "#5b63d3" }} />
          <span style={{ width: `${Math.max(0, Math.min(openPct, 100 - Math.max(0, Math.min(acceptedPct, 100))))}%`, background: "#9aa2b2" }} />
        </div>
        <div className="compact-split" style={{ marginTop: 10 }}>
          <b>{fmt.moneyFull(cur.acceptedValue)} accepted</b>
          <span>{fmt.moneyFull(cur.notAcceptedValue)} open</span>
        </div>
        <div className="mini-metric-grid" style={{ marginTop: 16 }}>
          <div>
            <span>Accepted quotes</span>
            <b className="tnum">{cur.acceptedCount}</b>
          </div>
          <div>
            <span>Open quotes</span>
            <b className="tnum">{cur.notAcceptedCount}</b>
          </div>
          <div>
            <span>Value rate</span>
            <b className="tnum">{rateText(cur.acceptanceRateValue)}</b>
          </div>
          <div>
            <span>Count rate</span>
            <b className="tnum">{rateText(cur.acceptanceRateCount)}</b>
          </div>
        </div>
        <div className="aging-strip" aria-label="Open quote aging distribution">
          {aging.map((bin) => (
            <div key={bin.label}>
              <span>{bin.label}</span>
              <b className="tnum">{bin.count}</b>
            </div>
          ))}
        </div>
        <Fnote>
          Open quote aging is aggregated from {model.followUpQueue.totalCount} still-open quotes as of {shortDate(model.followUpQueue.asOf)}.
        </Fnote>
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--hair-2)" }}>
          <div className="ti">Deal Size Mix</div>
          <div className="st">Acceptance rate and quoted value by tier</div>
          <div className="source-mix-list">
            {model.acceptanceByTier.map((tier) => (
              <div key={tier.tier}>
                <span>
                  <i style={{ background: tier.acceptanceRateCount !== null && tier.acceptanceRateCount < 15 ? "#d0463a" : "#5b63d3" }} />
                  {displayTier(tier.tier)}
                </span>
                <b className="tnum">{rateText(tier.acceptanceRateCount)}</b>
                <em className="tnum">
                  {fmt.moneyFull(tier.quoteValue)} quoted · {tier.quoteCount} quotes
                </em>
              </div>
            ))}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function agingBins(rows: QuoteFollowUpQueueRow[]) {
  return [
    { label: "0-30d", count: rows.filter((row) => row.ageDays <= 30).length },
    { label: "31-45d", count: rows.filter((row) => row.ageDays > 30 && row.ageDays <= 45).length },
    { label: "46d+", count: rows.filter((row) => row.ageDays > 45).length },
  ];
}

/** Green up / red down YoY suffix for a dark dgrid tile; null when no basis. */
function deltaU(current: number | null, prior: number | null): ReactNode {
  const pct = percentChange(current, prior);
  if (pct === null) return null;
  if (pct >= 0) return `↑ ${pct.toFixed(1)}%`;
  return <span style={{ color: "#f0937f" }}>↓ {Math.abs(pct).toFixed(1)}%</span>;
}

function highRateMonth(months: QuoteMonthlyMetric[]): { month: string; rate: number } | null {
  let best: { month: string; rate: number } | null = null;
  for (const m of months) {
    if (m.acceptanceRateCount === null) continue;
    if (!best || m.acceptanceRateCount > best.rate) best = { month: m.month, rate: m.acceptanceRateCount };
  }
  return best;
}

/* ── Acceptance Trend card ─────────────────────────────── */

export type TrendMode = "count" | "value" | "volume";

const TREND_CHIPS = [
  { key: "count", label: "By count", color: "#5b63d3" },
  { key: "value", label: "By value", color: "#6d7890" },
  { key: "volume", label: "Volume", color: "#c9cfda" },
] as const;

/** Mockup picker semantics: count/value co-plot; Volume is exclusive; at
 *  least one chip stays on. */
export function nextTrendModes(selected: TrendMode[], k: TrendMode): TrendMode[] {
  if (k === "volume") return ["volume"];
  if (selected.includes("volume")) return [k];
  if (selected.includes(k)) return selected.length > 1 ? selected.filter((x) => x !== k) : selected;
  return [...selected, k];
}

const pf = (v: number) => v.toFixed(1) + "%";

function TrendCard({ model, months, initialVolume }: { model: QuoteMetricsReadModel; months: QuoteMonthlyMetric[]; initialVolume: boolean }) {
  const [modes, setModes] = useState<TrendMode[]>(initialVolume ? ["volume"] : ["count", "value"]);
  const [wrapRef, width] = useContainerWidth<HTMLDivElement>();
  const labels = months.map((m, i) => chartLabel(m.month, i));
  const band = labels.length - 1;
  const monShort = monthLong(model.selectedMonth).slice(0, 3);
  const rateC = months.map((m) => m.acceptanceRateCount);
  const rateV = months.map((m) => m.acceptanceRateValue);
  const sent = months.map((m) => m.quoteCount);
  const won = months.map((m) => m.acceptedCount);
  const quoted = months.map((m) => m.quoteValue);
  const trends = model.trends;

  const volume = modes.includes("volume");
  const both = !volume && modes.length === 2;
  const valOnly = !volume && !both && modes[0] === "value";

  let legendItems: Array<{ label: string; color?: string; swatchStyle?: CSSProperties }>;
  let series: TrendSeries[];
  let annotations: TrendAnnotation[];
  let bandLabel: string;
  let chart: ReactNode;

  if (volume) {
    legendItems = [
      { label: "Quotes sent", color: "#404a60" },
      { label: "Won", color: "#5b63d3" },
    ];
    series = [
      { name: "Quotes sent", color: "#404a60", values: sent, tipFmt: fmt.n },
      { name: "Won", color: "#5b63d3", star: true, fill: true, values: won, endLabel: false, tipFmt: fmt.n },
    ];
    const meanWon = won.reduce((a, b) => a + b, 0) / Math.max(won.length, 1);
    annotations = won.length
      ? [{ s: 1, i: Math.floor(won.length / 2), text: `~${Math.round(meanWon)} accepted/month`, sub: "closes hold flat while volume swings" }]
      : [];
    bandLabel = `${monShort} · ${sent[band] ?? 0} sent · ${won[band] ?? 0} accepted`;
    chart = (
      <TrendChart
        labels={labels}
        series={series}
        everyX={1}
        h={340}
        band={band}
        bandLabel={bandLabel}
        yFmt={fmt.n}
        yMin={0}
        annotations={annotations}
        tipExtra={(i) =>
          tipRow("#9aa2b2", "Acceptance rate", rateText(rateC[i])) + tipRow("#9aa2b2", "Quoted value", fmt.money(quoted[i]))
        }
      />
    );
  } else {
    const base = valOnly ? rateV : rateC;
    series = [];
    if (!both) {
      const t12 = valOnly ? trends.at(-1)?.acceptanceRateValue12Month ?? null : trends.at(-1)?.acceptanceRateCount12Month ?? null;
      const roll3 = trends.map((t) => (valOnly ? t.acceptanceRateValue3Month : t.acceptanceRateCount3Month));
      series.push({ name: "Trailing-12", color: "#c9cede", dash: "3 4", values: base.map(() => t12), tipFmt: pf });
      series.push({ name: "3-mo rolling", color: "#9aa2b2", values: roll3, tipFmt: pf });
    }
    if (modes.includes("count")) series.push({ name: "By count", color: "#5b63d3", star: !both || undefined, fill: !both, values: rateC, endLabel: false, tipFmt: pf });
    if (modes.includes("value")) series.push({ name: "By value", color: "#6d7890", values: rateV, endLabel: false, tipFmt: pf });
    const pk = peakIndex(base);
    annotations = pk === null
      ? []
      : [{
          s: series.length - (both ? 2 : 1),
          i: pk,
          text: (base[pk] as number).toFixed(1) + "%",
          sub: `${labels[pk].split(" ")[0]} — ${both ? "count-rate peak" : valOnly ? "value-rate peak" : "best month"}`,
        }];
    legendItems = both
      ? [
          { label: "By count", color: "#5b63d3" },
          { label: "By value", color: "#6d7890" },
        ]
      : [
          { label: valOnly ? "By value" : "By count", color: valOnly ? "#6d7890" : "#5b63d3" },
          { label: "3-mo rolling", color: "#9aa2b2" },
          { label: "Trailing-12", swatchStyle: { background: "none", borderTop: "2px dashed #c9cede", height: 0 } },
        ];
    bandLabel = both
      ? `${monShort} · ${rateText(rateC[band])} / ${rateText(rateV[band])}`
      : `${monShort} · ${rateText(base[band])}`;
    const plottedMax = Math.max(0, ...series.flatMap((s) => s.values).filter((v): v is number => v != null));
    const yMax = Math.max(valOnly ? 40 : 50, Math.ceil(plottedMax / 10) * 10);
    chart = (
      <TrendChart
        labels={labels}
        series={series}
        everyX={1}
        h={340}
        band={band}
        bandLabel={bandLabel}
        yFmt={(v) => v.toFixed(0) + "%"}
        yMin={0}
        yMax={yMax}
        ticks={valOnly ? 4 : 5}
        annotations={annotations}
      />
    );
  }

  return (
    <Card
      title="Acceptance Trend"
      subtitle={`${months[0]?.label ?? ""} – ${months.at(-1)?.label ?? ""} · hover or tap for monthly detail`}
      aside={<Legend style={{ padding: 0 }} items={legendItems} />}
    >
      <MetricPicker
        groups={[TREND_CHIPS.map((c) => ({ key: c.key, label: c.label, color: c.color }))]}
        selected={modes}
        onToggle={(key) => setModes((prev) => nextTrendModes(prev, key as TrendMode))}
      />
      <CardBody>
        <div ref={wrapRef}>{chart}</div>
        <Fnote style={width >= 520 ? { display: "none" } : undefined}>
          Peak callouts move into the tooltips at this width — hover or tap any point.
        </Fnote>
      </CardBody>
    </Card>
  );
}

function peakIndex(values: Array<number | null>): number | null {
  let idx: number | null = null;
  values.forEach((v, i) => {
    if (v === null) return;
    if (idx === null || v > (values[idx] as number)) idx = i;
  });
  return idx;
}

/* ── Quote classification drawers ──────────────────────── */

export function QuoteDrawerDetail({ row }: { row: QuoteFollowUpQueueRow }) {
  const viewed = /view/i.test(row.status);
  return (
    <>
      <KV>
        <KVCell label="Value" value={fmt.moneyFull(row.value)} />
        <KVCell
          label="Sent"
          def="Simpro DateApproved — the internal approve-and-issue date; it also assigns the quote’s reporting month."
          value={shortDateYear(row.sentDate)}
          valueStyle={{ fontSize: 14 }}
        />
        <KVCell label="Days open" value={String(row.ageDays)} />
        <KVCell label="Status" value={viewed ? "Viewed by customer" : "Sent"} valueStyle={{ fontSize: 14 }} />
      </KV>
      <DSec>Classification</DSec>
      <DNote>
        Not Accepted — no verified online acceptance and no exact converted-job relationship yet. It flips to Accepted
        automatically the moment either appears in Simpro.
      </DNote>
      <QuoteOverridePanel quoteId={row.quoteId} />
    </>
  );
}

export function CustomerDrawerDetail({ entry, rows }: { entry: QuoteFollowUpQueue["byCustomer"][number]; rows: QuoteFollowUpQueueRow[] }) {
  const quotes = rows.filter((r) => r.customer === entry.customer).sort((a, b) => b.value - a.value);
  return (
    <>
      <KV>
        <KVCell label="Open quotes" value={String(entry.count)} />
        <KVCell label="Total value" value={fmt.moneyFull(entry.totalValue)} />
        <KVCell label="Oldest" value={`${entry.oldestAgeDays}d`} />
        <KVCell label="Newest" value={`${entry.newestAgeDays}d`} />
      </KV>
      <DSec>Open quotes</DSec>
      {quotes.map((q) => (
        <DNote key={q.quoteId} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "3px 0" }}>
          <span style={{ minWidth: 0 }}>
            Quote {q.quoteNo} · {q.name}
          </span>
          <b className="tnum" style={{ flex: "none", color: "var(--ink)" }}>
            {fmt.moneyFull(q.value)} · {q.ageDays}d
          </b>
        </DNote>
      ))}
      <Fnote>
        Aggregated open value is shown for exposure only; sales workflow is outside this metrics dashboard.
      </Fnote>
    </>
  );
}

/* ── Exclusion override (drawer action) ────────────────── */

export function quoteExclusionRevisionFromApiPayload(payload: unknown): number {
  if (!payload || typeof payload !== "object" || !("currentExclusionRevision" in payload)) {
    throw new Error("The exclusion history response did not include its current revision.");
  }
  const revision = (payload as { currentExclusionRevision?: unknown }).currentExclusionRevision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) {
    throw new Error("The exclusion history response included an invalid current revision.");
  }
  return Number(revision);
}

function QuoteOverridePanel({ quoteId }: { quoteId: number }) {
  const [access, setAccess] = useState<"loading" | "allowed" | "forbidden" | "error">("loading");
  const [canWrite, setCanWrite] = useState(false);
  const [currentExclusionRevision, setCurrentExclusionRevision] = useState(0);
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");
  const action = currentExclusionRevision > 0 ? "reinstate" : "exclude";

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/quotes/overrides?quoteId=${quoteId}`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 403) {
          setAccess("forbidden");
          return;
        }
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Unable to load the exclusion state.");
        setCurrentExclusionRevision(quoteExclusionRevisionFromApiPayload(payload));
        setCanWrite(Boolean(payload.canWrite));
        setAccess("allowed");
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMessage(error instanceof Error ? error.message : "Unable to load the exclusion state.");
        setAccess("error");
      });
    return () => controller.abort();
  }, [quoteId]);

  async function submitOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitState("saving");
    setMessage("");
    try {
      const requestKey = idempotencyKey || crypto.randomUUID();
      if (!idempotencyKey) setIdempotencyKey(requestKey);
      const response = await fetch("/api/quotes/overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          quoteId,
          action,
          expectedActiveExclusionRevision: currentExclusionRevision,
          idempotencyKey: requestKey,
          reason,
          evidenceUrl: null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? `Unable to ${action} quote.`);
      setSubmitState("saved");
      setMessage(`Revision ${payload.override.revision} saved.`);
      window.location.reload();
    } catch (error) {
      setSubmitState("error");
      setMessage(error instanceof Error ? error.message : `Unable to ${action} quote.`);
    }
  }

  if (access === "forbidden" || (access === "allowed" && !canWrite)) return null;

  return (
    <>
      <DSec>{action === "exclude" ? "Exclude from metrics" : "Reinstate in metrics"}</DSec>
      {access === "loading" ? (
        <DNote>Checking exclusion state…</DNote>
      ) : access === "error" ? (
        <DNote>{message}</DNote>
      ) : (
        <form onSubmit={submitOverride}>
          <DNote>
            {action === "exclude"
              ? "Exclusion removes this quote from activity and acceptance denominators — it cannot create Accepted evidence. Requires a reason; the audit trail is retained."
              : `An exclusion is active (revision ${currentExclusionRevision}). Reinstating immediately restores the source-derived classification.`}
          </DNote>
          <textarea
            aria-label="Override reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={5}
            maxLength={1000}
            required
            rows={3}
            disabled={submitState === "saving"}
            placeholder="Reason (required)"
            style={{
              width: "100%",
              marginTop: 8,
              padding: 8,
              fontSize: 13,
              border: "1px solid var(--hair)",
              borderRadius: 9,
              resize: "vertical",
            }}
          />
          <button type="submit" className="ctl" style={{ height: 34, fontSize: 13.5, marginTop: 8 }} disabled={submitState === "saving"}>
            {submitState === "saving" ? "Saving…" : action === "exclude" ? "Exclude from metrics" : "Reinstate in metrics"}
          </button>
          {message ? (
            <DNote style={{ marginTop: 8, color: submitState === "error" ? "var(--down)" : "var(--muted)" }}>{message}</DNote>
          ) : null}
        </form>
      )}
    </>
  );
}

/* ── Acceptance by Deal Size ───────────────────────────── */

function TiersCard({ model, cur }: { model: QuoteMetricsReadModel; cur: QuoteMonthlyMetric }) {
  const long = monthLong(model.selectedMonth);
  const tiers = model.acceptanceByTier;
  const maxCount = Math.max(1, ...tiers.map((t) => t.quoteCount));
  return (
    <Card title="Acceptance by Deal Size" subtitle={`${long} quotes by value tier · bar = size relative to the largest tier`}>
      <CardBody className="fillbd">
        <div>
          {tiers.map((t) => {
            const low = t.acceptanceRateCount !== null && t.acceptanceRateCount < 15;
            return (
              <div key={t.tier} style={{ padding: "12px 0", borderBottom: "1px solid var(--hair-2)" }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
                  <span className="id1 tnum">{displayTier(t.tier)}</span>
                  <b className="tnum" style={{ fontSize: 19, letterSpacing: "-.02em", color: low ? "var(--down)" : "var(--ink)" }}>
                    {rateText(t.acceptanceRateCount)}
                  </b>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                  <div style={{ flex: 1, height: 6, background: "#f1f2f6", borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ width: `${Math.max((t.quoteCount / maxCount) * 100, 4)}%`, height: "100%", background: "#9aa2b2", borderRadius: 4 }} />
                  </div>
                  <span className="id2 tnum" style={{ margin: 0, flex: "none" }}>{t.quoteCount} quotes</span>
                </div>
                <div className="id2 tnum" style={{ marginTop: 5 }}>
                  {fmt.moneyFull(t.quoteValue)} quoted · {rateText(t.acceptanceRateValue)} accepted by value
                </div>
              </div>
            );
          })}
        </div>
        <Insight style={{ marginTop: 14 }}>{tierInsight(model, cur)}</Insight>
      </CardBody>
    </Card>
  );
}

/** Data-driven mix insight: the mockup's "rate drop is mostly mix" sentence
 *  renders only when the data supports it; otherwise an honest value-share
 *  fallback. */
function tierInsight(model: QuoteMetricsReadModel, cur: QuoteMonthlyMetric): ReactNode {
  const long = monthLong(model.selectedMonth);
  const partial = model.provisional.isCurrentMonthPartial;
  const ly = partial ? model.priorYearSameDay : model.priorYearSameMonth;
  const tiers = model.acceptanceByTier;
  const top = [...tiers].sort((a, b) => b.quoteValue - a.quoteValue)[0];
  if (!top || cur.quoteValue <= 0) {
    return (
      <>
        <b>No quoted value this month.</b> Tier acceptance appears once {long} records quote activity.
      </>
    );
  }
  const share = Math.round((top.quoteValue / cur.quoteValue) * 100);
  const rc = rateText(top.acceptanceRateCount);
  const rv = rateText(top.acceptanceRateValue);
  const rateDelta = displayRoundedPtsDelta(cur.acceptanceRateCount, ly?.acceptanceRateCount ?? null);
  const sentYoY = percentChange(cur.quoteCount, ly?.quoteCount ?? null);
  const mixShift = ly && ly.quoteCount > 0 && cur.quoteCount > 0
    ? cur.byTier[top.tier].quoteCount / cur.quoteCount > ly.byTier[top.tier].quoteCount / ly.quoteCount
    : false;
  if (rateDelta !== null && rateDelta < 0 && sentYoY !== null && sentYoY > 0 && mixShift) {
    return (
      <>
        <b>The rate drop is mostly mix.</b> {long} sent {Math.round(sentYoY)}% more quotes than last {long}, weighted
        toward {displayTier(top.tier)} — {top.quoteCount} big quotes carried {share}% of the value but close at {rc} by
        count, {rv} by value.
      </>
    );
  }
  return (
    <>
      <b>{displayTier(top.tier)} carries the value.</b> {top.quoteCount} quotes carried {share}% of {long}’s quoted
      value, closing at {rc} by count and {rv} by value.
    </>
  );
}

/* ── Tier × month heatmap ──────────────────────────────── */

const HEAT_LEGEND: Array<[string, string]> = [
  ["#b8453a", "<15%"],
  ["#d4d8f9", "15–25"],
  ["#a3a9ef", "25–35"],
  ["#5a63c8", "35–45"],
  ["#4b52c0", "45%+"],
];

function HeatmapCard({ model, months }: { model: QuoteMetricsReadModel; months: QuoteMonthlyMetric[] }) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width:480px)");
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const keep = narrow ? 6 : 12;
  const monShort = monthLong(model.selectedMonth).slice(0, 3);
  const heatLabels = months.map((m, i) => heatLabel(m.month, i)).slice(-keep);
  const heatRows = model.heatmap.map((row) => ({
    name: displayTier(row.tier),
    cells: row.months.slice(-keep).map((cell) => ({
      v: cell.acceptanceRate,
      repr: cell.month !== model.selectedMonth || undefined,
    })),
  }));
  const bigTier = model.acceptanceByTier.find((t) => t.tier === "$10K+");
  const bigTierLow = bigTier != null && bigTier.acceptanceRateCount !== null && bigTier.acceptanceRateCount < 15;
  const swatch = (background: string, extra?: CSSProperties) => (
    <i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background, ...extra }} />
  );
  return (
    <Card
      style={{ display: "flex", flexDirection: "column" }}
      title="Acceptance by Deal Size and Month"
      subtitle={`Count-based acceptance per tier · ${months[0]?.label ?? ""} – ${months.at(-1)?.label ?? ""} · hover or tap any cell`}
      aside={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 9,
            fontSize: 12,
            color: "var(--muted)",
            flexWrap: "wrap",
            maxWidth: 380,
          }}
        >
          {HEAT_LEGEND.map(([color, label]) => (
            <span key={label} className="tnum" style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
              {swatch(color)}
              {label}
            </span>
          ))}
          <span
            className="def"
            data-def={`Hatched cells are representative, pending per-month reconciliation — the ${monShort} column is verified against Simpro.`}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}
          >
            {swatch("#a3a9ef", {
              backgroundImage: "repeating-linear-gradient(45deg,transparent 0 2.5px,rgba(16,20,34,.22) 2.5px 4px)",
            })}
            hatched = representative
          </span>
        </div>
      }
    >
      <Heatmap
        months={heatLabels}
        rows={heatRows}
        highlightLast
        cols={keep}
        style={{ paddingTop: 6, flex: 1, alignContent: "start", rowGap: 6 }}
      />
      {narrow ? (
        <div style={{ fontSize: 12, color: "var(--subtle)", padding: "6px 20px 0" }}>
          {heatLabels[0]} – {heatLabels.at(-1)} · the full year shows on wider screens
        </div>
      ) : null}
      <CardBody style={{ paddingTop: 0 }}>
        <Fnote>
          {monShort} column verified against Simpro{bigTierLow ? " · the pattern: big deals rarely clear 15%." : ""}
        </Fnote>
      </CardBody>
    </Card>
  );
}

/* ── History tab ───────────────────────────────────────── */

function HistoryCard({ model, months }: { model: QuoteMetricsReadModel; months: QuoteMonthlyMetric[] }) {
  const chronological = months;
  const labels = new Map(chronological.map((m, i) => [m.month, chartLabel(m.month, i)]));
  const displayRows = model.monthlyBreakdown; // newest first
  const hasPartial = displayRows.some((m) => m.provisional);
  const totals = historyTotals(chronological);
  const footTd: CSSProperties = { fontWeight: 700, padding: "13px 20px", borderTop: "1px solid var(--hair)" };
  return (
    <Card
      title="Monthly Breakdown"
      subtitle={hasPartial ? `Trailing 12 months · ${monthLong(model.selectedMonth)} is month-to-date` : "Trailing 12 complete months"}
      aside={
        <button type="button" className="ctl" style={{ height: 34, fontSize: 13.5 }} onClick={() => downloadHistoryCsv(model)}>
          <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M12 3v12M7 10l5 5 5-5" />
            <path d="M4 19h16" />
          </svg>
          Download CSV
        </button>
      }
    >
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Sent</th>
              <th className="num hide-sm">Quote Value</th>
              <th className="num">Accepted</th>
              <th className="num hide-sm">Accepted Value</th>
              <th className="num hide-sm">Avg Deal</th>
              <th className="num">Rate (Count)</th>
              <th className="num hide-sm">Rate (Value)</th>
            </tr>
          </thead>
          <tbody id="histRows">
            {displayRows.map((m) => (
              <tr key={m.month} style={m.month === model.selectedMonth ? { background: "var(--acc-weak)" } : undefined}>
                <td className="id1 tnum">{labels.get(m.month) ?? m.label}</td>
                <td className="num tnum">{m.quoteCount}</td>
                <td className="num tnum hide-sm">{fmt.moneyFull(m.quoteValue)}</td>
                <td className="num tnum">{m.acceptedCount}</td>
                <td className="num tnum hide-sm">{fmt.moneyFull(m.acceptedValue)}</td>
                <td className="num tnum hide-sm">{m.averageAcceptedDeal === null ? "N/A" : fmt.moneyFull(m.averageAcceptedDeal)}</td>
                <td className="num tnum">{rateText(m.acceptanceRateCount)}</td>
                <td className="num tnum hide-sm">{rateText(m.acceptanceRateValue)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr id="histFoot">
              <td style={footTd}>Trailing 12</td>
              <td className="num tnum" style={footTd}>{fmt.n(totals.sent)}</td>
              <td className="num tnum hide-sm" style={footTd}>{fmt.moneyFull(totals.value)}</td>
              <td className="num tnum" style={footTd}>{fmt.n(totals.accepted)}</td>
              <td className="num tnum hide-sm" style={footTd}>{fmt.moneyFull(totals.acceptedValue)}</td>
              <td className="num tnum hide-sm" style={footTd}>{totals.avgDeal === null ? "N/A" : fmt.moneyFull(totals.avgDeal)}</td>
              <td className="num tnum" style={footTd}>{rateText(totals.rateCount)}</td>
              <td className="num tnum hide-sm" style={footTd}>{rateText(totals.rateValue)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

function historyTotals(months: QuoteMonthlyMetric[]) {
  const sent = months.reduce((a, m) => a + m.quoteCount, 0);
  const value = months.reduce((a, m) => a + m.quoteValue, 0);
  const accepted = months.reduce((a, m) => a + m.acceptedCount, 0);
  const acceptedValue = months.reduce((a, m) => a + m.acceptedValue, 0);
  return {
    sent,
    value,
    accepted,
    acceptedValue,
    avgDeal: accepted > 0 ? acceptedValue / accepted : null,
    rateCount: sent > 0 ? (accepted / sent) * 100 : null,
    rateValue: value > 0 ? (acceptedValue / value) * 100 : null,
  };
}

/** Client-side CSV of the History table (approved C7) — same columns and the
 *  same computed Trailing-12 row, consistent weights (Σaccepted ÷ Σsent). */
export function quoteHistoryCsv(model: QuoteMetricsReadModel): string {
  const totals = historyTotals(model.monthlyBreakdown);
  const headings = ["Month", "Sent", "Quote Value", "Accepted", "Accepted Value", "Avg Deal", "Rate (Count)", "Rate (Value)"];
  const rows = model.monthlyBreakdown.map((m) => [
    m.label,
    m.quoteCount,
    m.quoteValue,
    m.acceptedCount,
    m.acceptedValue,
    m.averageAcceptedDeal === null ? "" : Math.round(m.averageAcceptedDeal),
    m.acceptanceRateCount === null ? "" : m.acceptanceRateCount.toFixed(1),
    m.acceptanceRateValue === null ? "" : m.acceptanceRateValue.toFixed(1),
  ]);
  const foot = [
    "Trailing 12",
    totals.sent,
    totals.value,
    totals.accepted,
    totals.acceptedValue,
    totals.avgDeal === null ? "" : Math.round(totals.avgDeal),
    totals.rateCount === null ? "" : totals.rateCount.toFixed(1),
    totals.rateValue === null ? "" : totals.rateValue.toFixed(1),
  ];
  return [headings, ...rows, foot].map((row) => row.map(csvCell).join(",")).join("\n");
}

function downloadHistoryCsv(model: QuoteMetricsReadModel) {
  const csv = quoteHistoryCsv(model);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `quote-metrics-${model.selectedMonth}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/* ── Shared helpers ────────────────────────────────────── */

/** Delta in points computed on the one-decimal rates actually displayed
 *  (approved display-rounding policy). */
export function displayRoundedPtsDelta(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null) return null;
  return Math.round((round1(current) - round1(prior)) * 10) / 10;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function percentChange(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return ((current - prior) / prior) * 100;
}

function aboveZero(v: number | null): boolean {
  return v !== null && v > 0;
}

function signedPct(pct: number): string {
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`;
}

function rateText(v: number | null | undefined): string {
  return v === null || v === undefined ? "N/A" : `${v.toFixed(1)}%`;
}

/** "$1,963,611" spans read full-$; card subtitles use $X.XXM once ≥ $1M. */
export function moneyM(v: number): string {
  return Math.abs(v) >= 1e6 ? `${v < 0 ? "−$" : "$"}${(Math.abs(v) / 1e6).toFixed(2)}M` : fmt.money(v);
}

function displayTier(tier: QuoteDealTier): string {
  return tier.replaceAll("-", "–");
}

function monthLong(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/** "2026-06" → "Jun ’26" (chip/series grammar). */
export function seriesName(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const mon = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
  return `${mon} ’${monthKey.slice(2, 4)}`;
}

function addYears(monthKey: string, years: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  return `${year + years}-${String(month).padStart(2, "0")}`;
}

/** Chart x labels: "Jul 25", "Aug", …, "Jan 26", … (year on the first column
 *  and each January, mirroring the approved M array). */
function chartLabel(monthKey: string, index: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const mon = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
  return index === 0 || month === 1 ? `${mon} ${monthKey.slice(2, 4)}` : mon;
}

/** Heatmap column labels: same rule with the approved apostrophe ("Jul ’25"). */
function heatLabel(monthKey: string, index: number): string {
  const label = chartLabel(monthKey, index);
  return label.includes(" ") ? label.replace(" ", " ’") : label;
}

/** "2026-06-02" → "Jun 2". */
function shortDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

/** "2026-06-08" → "Jun 8, 2026". */
function shortDateYear(date: string): string {
  const [year] = date.split("-");
  return `${shortDate(date)}, ${year}`;
}

"use client";

import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { fmt, tipRow, tipTitle, Heatmap, LineChart, type LineAnnotation, type LineRefline, type LineSeries } from "@/components/charts";
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
} from "@/components/band";

export { moneyK };
import {
  Card,
  CardBody,
  DefTooltipProvider,
  DNote,
  Drawer,
  DSec,
  Fnote,
  KV,
  KVCell,
  MetricPicker,
  Skel,
  StateEmpty,
  StateError,
  StateMini,
  StatesStrip,
} from "@/components/reset";
import {
  type QuoteDealTier,
  type QuoteClassificationRow,
  type QuoteFollowUpQueue,
  type QuoteFollowUpQueueRow,
  type QuoteMetricsReadModel,
  type QuoteMonthlyMetric,
} from "@/lib/store/quote-dashboard-read-model";
import { csvCell } from "@/lib/csv";

/* /quotes — implements the owner-approved redesign
   docs/approved-design/mockups/quotes.html exactly, with every figure taken
   from the read-model payload (the mockup's July numbers are sample
   content). Composition: KPI band (primary dark card + 2×2 tiles + one
   day-alignment footnote) → full-width Acceptance Trend → full-width Deal
   Size (4-up tier grid + the one allowed callout) → tier×month heatmap →
   always-present Monthly Breakdown (tabs removed). Honest states, one
   source line. */

const ACC = "#5b63d3"; /* var(--acc) */
const SERIES2 = "#0e9aae"; /* var(--series-2) */

export type QuoteMetricsDashboardProps = {
  model: QuoteMetricsReadModel;
  /** Renders the design-reference state strip (mockups' ?states=1 gate). */
  showStates?: boolean;
  /** Deep-link parity (?mode=volume) — pre-enables the Volume panel. */
  initialTrendVolume?: boolean;
};

export function QuoteMetricsDashboard({ model, showStates, initialTrendVolume = false }: QuoteMetricsDashboardProps) {
  const failed = model.quotesLoaded === 0 && model.warnings.length > 0;
  return (
    <DefTooltipProvider>
      {failed ? (
        <QuotesLoadError detail={model.warnings[0]} />
      ) : (
        <QuotesContent model={model} initialTrendVolume={initialTrendVolume} />
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
        Source: Simpro quotes · month assigned by DateIssued · acceptance requires verified online acceptance or an exact converted job
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

type TierSegment = QuoteMetricsReadModel["acceptanceByTier"][number];

function QuotesContent({ model, initialTrendVolume }: { model: QuoteMetricsReadModel; initialTrendVolume: boolean }) {
  const months = useMemo(() => [...model.monthlyBreakdown].reverse(), [model.monthlyBreakdown]);
  const [tierDrill, setTierDrill] = useState<TierSegment | null>(null);
  const [quoteDrill, setQuoteDrill] = useState<QuoteClassificationRow | null>(null);
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
  const long = monthLong(model.selectedMonth);
  return (
    <>
      <QuotesBand model={model} cur={cur} />
      <div className="grid12">
        <TrendCard model={model} months={months} initialVolume={initialTrendVolume} />
      </div>
      <div className="grid12">
        <DealSizeCard model={model} cur={cur} onOpen={setTierDrill} />
      </div>
      <div className="grid12">
        <HeatmapCard model={model} months={months} />
      </div>
      <div className="grid12">
        <HistoryCard model={model} months={months} />
      </div>
      <div className="grid12">
        <QuoteReviewCard model={model} onOpen={setQuoteDrill} />
      </div>
      <Drawer
        open={tierDrill !== null}
        onClose={() => setTierDrill(null)}
        ariaLabel="Deal-size tier detail"
        title={tierDrill ? displayTier(tierDrill.tier) : null}
        sub={tierDrill ? `${long} · ${tierDrill.quoteCount} ${tierDrill.quoteCount === 1 ? "quote" : "quotes"}` : null}
      >
        {tierDrill ? <TierDrawerBody tier={tierDrill} /> : null}
      </Drawer>
      <Drawer
        open={quoteDrill !== null}
        onClose={() => setQuoteDrill(null)}
        ariaLabel="Quote classification detail"
        title={quoteDrill ? `Quote ${quoteDrill.quoteNo}` : null}
        sub={quoteDrill?.name ?? null}
      >
        {quoteDrill ? <QuoteClassificationDetail row={quoteDrill} /> : null}
      </Drawer>
    </>
  );
}

function QuoteReviewCard({ model, onOpen }: { model: QuoteMetricsReadModel; onOpen: (row: QuoteClassificationRow) => void }) {
  const rows = model.classificationRows ?? [];
  const { page, classificationPages, classificationTotal } = model.pagination ?? {
    page: 1,
    classificationPages: 1,
    classificationTotal: rows.length,
  };
  const movePage = (nextPage: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set("page", String(nextPage));
    window.location.assign(url.toString());
  };
  return (
    <Card
      className="span12"
      title="Quote Classification Review"
      subtitle={`${monthLong(model.selectedMonth)} · ${classificationTotal} quotes · select a quote to review or exclude it from metrics`}
      aside={classificationPages > 1 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" className="ctl" disabled={page <= 1} onClick={() => movePage(page - 1)}>Previous</button>
          <span className="tnum" style={{ fontSize: 12, color: "var(--muted)" }}>{page} / {classificationPages}</span>
          <button type="button" className="ctl" disabled={page >= classificationPages} onClick={() => movePage(page + 1)}>Next</button>
        </div>
      ) : null}
    >
      {rows.length === 0 ? (
        <CardBody><StateEmpty>No quotes match this month and filter selection.</StateEmpty></CardBody>
      ) : (
        <div className="tblwrap">
          <table>
            <thead><tr><th>Quote</th><th>Status</th><th>Classification</th><th className="num">Value</th><th className="num hide-sm">Issued</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.quoteId}>
                  <td>
                    <button
                      type="button"
                      onClick={() => onOpen(row)}
                      style={{ border: 0, background: "none", color: "var(--acc)", cursor: "pointer", padding: 0, textAlign: "left", font: "inherit" }}
                    >
                      <b>{row.quoteNo}</b><br /><span style={{ color: "var(--muted)", fontSize: 12 }}>{row.name}</span>
                    </button>
                  </td>
                  <td>{row.status}</td>
                  <td>{classificationLabel(row.outcome)}</td>
                  <td className="num tnum">{fmt.moneyFull(row.value)}</td>
                  <td className="num tnum hide-sm">{shortDateYear(row.dateIssued)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function QuoteClassificationDetail({ row }: { row: QuoteClassificationRow }) {
  return (
    <>
      <KV>
        <KVCell label="Value" value={fmt.moneyFull(row.value)} />
        <KVCell label="Issued" value={shortDateYear(row.dateIssued)} valueStyle={{ fontSize: 14 }} />
        <KVCell label="Classification" value={classificationLabel(row.outcome)} valueStyle={{ fontSize: 14 }} />
        <KVCell label="Status" value={row.status} valueStyle={{ fontSize: 14 }} />
      </KV>
      <DSec>Evidence</DSec>
      <DNote>{row.evidence}</DNote>
      {row.override?.effective ? <DNote>Excluded by {row.override.actorEmail}: {row.override.reason}</DNote> : null}
      <QuoteOverridePanel quoteId={row.quoteId} />
    </>
  );
}

function classificationLabel(outcome: QuoteClassificationRow["outcome"]) {
  return outcome === "accepted" ? "Accepted" : outcome === "excluded" ? "Excluded" : "Not Accepted";
}

/* ── Row 1: KPI band ───────────────────────────────────── */

function QuotesBand({ model, cur }: { model: QuoteMetricsReadModel; cur: QuoteMonthlyMetric }) {
  const partial = model.provisional.isCurrentMonthPartial;
  const long = monthLong(model.selectedMonth);
  const monShort = long.slice(0, 3);
  const day = model.provisional.elapsedDays;
  const ly = partial ? model.priorYearSameDay : model.priorYearSameMonth;
  const lyName = seriesName(addYears(model.selectedMonth, -1));
  const lyWin = partial ? `d${day}` : "full";
  const prior = model.priorMonth;
  const priorName = prior ? seriesName(prior.month) : null;
  const priorShort = prior ? monthLong(prior.month).slice(0, 3) : null;
  const lyDef = partial ? `vs ${lyName}, aligned to day ${day}` : `vs ${lyName}, full month`;
  const priorDef = `vs ${priorShort ?? "prior month"}, full month`;

  const rateDelta = displayRoundedPtsDelta(cur.acceptanceRateCount, ly?.acceptanceRateCount ?? null);
  const momRateDelta = displayRoundedPtsDelta(cur.acceptanceRateCount, prior?.acceptanceRateCount ?? null);

  return (
    <>
      <KpiBand ariaLabel={`${long} key metrics`}>
        <PrimaryStatCard
          href="#trend"
          label={partial ? "Accepted · month to date" : "Accepted"}
          labelDef={`Σ quote total across ${long} quotes classified Accepted — verified online acceptance or an exact converted-job link, never quote stage or status alone.`}
          pills={pctPill(cur.acceptedValue, ly?.acceptedValue ?? null, lyName, lyDef)}
          value={fmt.moneyFull(cur.acceptedValue)}
          sub={
            <>
              {cur.acceptedCount} of {cur.quoteCount} quotes accepted · {rateText(cur.acceptanceRateValue)} of value sent
            </>
          }
          bullet={{
            value: cur.acceptedValue,
            m1: { label: `${lyName} · ${lyWin}`, value: ly?.acceptedValue ?? null, ghost: "no data" },
            m2: prior ? { label: `${priorName} · full`, value: prior.acceptedValue } : null,
            fmt: moneyK,
            ariaLabel: `Accepted ${partial ? "month to date" : long} ${moneyK(cur.acceptedValue)}${
              ly ? `; ticks mark ${lyName} ${lyWin === "full" ? "full" : "day-aligned"} ${moneyK(ly.acceptedValue)}` : ""
            }${prior ? ` and full ${priorName} ${moneyK(prior.acceptedValue)}` : ""}`,
          }}
        />
        <KpiTiles>
          <KpiTile
            label="Acceptance rate"
            labelDef={`Accepted ÷ (accepted + not accepted) among non-excluded quotes whose DateIssued falls in ${long}.`}
            pills={
              <>
                {rateDelta !== null && ly
                  ? ptsPill(rateDelta, lyName, ptsChipDef(cur.acceptanceRateCount, ly.acceptanceRateCount, `${monShort} ’${model.selectedMonth.slice(2, 4)}`, lyName, rateDelta))
                  : null}
                {momRateDelta !== null && priorShort ? ptsPill(momRateDelta, priorShort, priorDef) : null}
              </>
            }
            value={rateText(cur.acceptanceRateCount)}
          />
          <KpiTile
            label="Quotes sent"
            labelDef={`Count of non-excluded quotes with DateIssued in ${long}. DateIssued sets the month only — it is not acceptance evidence.`}
            pills={pctPill(cur.quoteCount, ly?.quoteCount ?? null, lyName, lyDef)}
            value={fmt.n(cur.quoteCount)}
          />
          <KpiTile
            label="Value of quotes sent"
            labelDef={`Σ quote total (ex-tax) across the ${long} cohort.`}
            pills={pctPill(cur.quoteValue, ly?.quoteValue ?? null, lyName, lyDef)}
            value={fmt.moneyFull(cur.quoteValue)}
          />
          <KpiTile
            label="Avg accepted deal"
            labelDef={`Accepted value ÷ accepted count for ${long}.`}
            pills={pctPill(cur.averageAcceptedDeal, ly?.averageAcceptedDeal ?? null, lyName, lyDef)}
            value={cur.averageAcceptedDeal === null ? "N/A" : fmt.moneyFull(cur.averageAcceptedDeal)}
          />
        </KpiTiles>
      </KpiBand>
      <KpiBandNote>
        {partial
          ? `All vs-comparisons are day-aligned through ${monShort} ${day} (“d${day}”) unless marked “full”.`
          : "All vs-comparisons are full-month."}
      </KpiBandNote>
    </>
  );
}

/** Green up / red down labeled percent pill; null when there is no basis. */
function pctPill(current: number | null, prior: number | null, vsLabel: string, def?: string): ReactNode {
  const pct = percentChange(current, prior);
  if (pct === null) return null;
  return (
    <Dpill tone={pct < 0 ? "down" : pct > 0 ? "up" : "neutral"} def={def}>
      {pct < 0 ? "↓" : "↑"} {Math.abs(pct).toFixed(1)}% vs {vsLabel}
    </Dpill>
  );
}

function ptsPill(delta: number, vsLabel: string, def?: string): ReactNode {
  return (
    <Dpill tone={delta < 0 ? "down" : delta > 0 ? "up" : "neutral"} def={def}>
      {delta < 0 ? "↓" : "↑"} {Math.abs(delta).toFixed(1)} pts vs {vsLabel}
    </Dpill>
  );
}

function ptsChipDef(cur: number | null, prior: number | null, curLabel: string, priorLabel: string, delta: number): string {
  const c = round1(cur ?? 0).toFixed(1);
  const p = round1(prior ?? 0).toFixed(1);
  const abs = Math.abs(delta).toFixed(1);
  const arithmetic = delta < 0 ? `${p}% (${priorLabel}) − ${c}% (${curLabel})` : `${c}% (${curLabel}) − ${p}% (${priorLabel})`;
  return `Display-rounded: ${arithmetic} = ${abs} pts. Deltas are computed on the one-decimal rates shown.`;
}

/* ── Row 2: Acceptance Trend ───────────────────────────── */

export type TrendMode = "count" | "value" | "volume";

const TREND_CHIPS = [
  { key: "count", label: "By count", color: ACC },
  { key: "value", label: "By value", color: SERIES2 },
  { key: "volume", label: "Volume", color: "#c3cad6" },
] as const;

/** Approved picker semantics: count/value co-plot with at least one rate
 *  series always on; Volume toggles a separate count panel BELOW the chart
 *  on its own axis (single-axis rule — never bars behind the rate lines). */
export function nextTrendModes(selected: TrendMode[], k: TrendMode): TrendMode[] {
  if (k === "volume") {
    return selected.includes("volume") ? selected.filter((x) => x !== "volume") : [...selected, "volume"];
  }
  if (selected.includes(k)) {
    const rest = selected.filter((x) => x !== k);
    return rest.some((x) => x !== "volume") ? rest : selected;
  }
  return [...selected, k];
}

function TrendCard({ model, months, initialVolume }: { model: QuoteMetricsReadModel; months: QuoteMonthlyMetric[]; initialVolume: boolean }) {
  const [modes, setModes] = useState<TrendMode[]>(initialVolume ? ["count", "value", "volume"] : ["count", "value"]);
  const n = months.length;
  const monShort = monthLong(model.selectedMonth).slice(0, 3);
  const full = months.map((m) => seriesName(m.month));
  const labels = months.map((m, i) => (i % 2 === 0 || i === n - 1 ? (i === 0 ? seriesName(m.month) : monthLong(m.month).slice(0, 3)) : ""));
  const rateC = months.map((m) => m.acceptanceRateCount);
  const rateV = months.map((m) => m.acceptanceRateValue);
  const sent = months.map((m) => m.quoteCount);
  const won = months.map((m) => m.acceptedCount);

  const showCount = modes.includes("count");
  const showValue = modes.includes("value");
  const showVolume = modes.includes("volume");

  const series: LineSeries[] = [];
  if (showCount) series.push({ name: "By count", vals: rateC, color: ACC, width: 2 });
  if (showValue) series.push({ name: "By value", vals: rateV, color: SERIES2, width: 2 });

  const plotted = series.flatMap((s) => s.vals).filter((v): v is number => v != null);
  const ymax = Math.max(35, Math.ceil((Math.max(0, ...plotted) + 5) / 5) * 5);

  const lyFull = model.priorYearSameMonth;
  const reflines: LineRefline[] = [];
  if (lyFull?.acceptanceRateCount != null && showCount) {
    reflines.push({
      v: lyFull.acceptanceRateCount,
      text: `${seriesName(addYears(model.selectedMonth, -1))} · ${lyFull.acceptanceRateCount.toFixed(1)}% — same month last year`,
      anchor: "start",
    });
  }

  const base = showCount ? rateC : rateV;
  const baseIdx = 0;
  const annotations: LineAnnotation[] = [];
  const pk = peakIndex(base);
  if (pk !== null && pk !== n - 1) {
    annotations.push({
      s: baseIdx,
      i: pk,
      text: `${full[pk]} · ${(base[pk] as number).toFixed(1)}%\n${showCount ? "count" : "value"}-rate peak`,
      dy: -26,
      anchor: "middle",
    });
  }
  const curC = rateC[n - 1];
  const curV = rateV[n - 1];
  const curText =
    showCount && showValue
      ? `${monShort} · ${rateText(curC)} / ${rateText(curV)}`
      : `${monShort} · ${rateText(showCount ? curC : curV)}`;
  annotations.push({ s: baseIdx, i: n - 1, text: curText, dy: -14, dx: -6, anchor: "end" });

  const tip = (i: number) =>
    tipTitle(full[i]) +
    (showCount ? tipRow(ACC, "By count", rateText(rateC[i])) : "") +
    (showValue ? tipRow(SERIES2, "By value", rateText(rateV[i])) : "") +
    tipRow("#9aa2b2", "Accepted", `${won[i]} of ${sent[i]}`);

  const volMax = Math.max(1, ...sent);
  const volStep = 10 ** Math.floor(Math.log10(volMax));
  const volTop = Math.ceil(volMax / volStep) * volStep;

  return (
    <Card
      className="span12"
      style={{ scrollMarginTop: 70 }}
      title={<span id="trend">Acceptance Trend</span>}
      subtitle={`${full[0] ?? ""} – ${full[n - 1] ?? ""} · hover or tap for monthly detail`}
      aside={
        <MetricPicker
          style={{ padding: 0 }}
          groups={[TREND_CHIPS.map((c) => ({ key: c.key, label: c.label, color: c.color }))]}
          selected={modes}
          onToggle={(key) => setModes((prev) => nextTrendModes(prev, key as TrendMode))}
        />
      }
    >
      <CardBody>
        <div data-primary-viz="">
        <LineChart
          labels={labels}
          series={series}
          h={300}
          ymax={ymax}
          ticks={5}
          yFmt={(v) => v + "%"}
          reflines={reflines}
          annotations={annotations}
          xlabels={showVolume ? false : undefined}
          tip={tip}
          ariaLabel="Acceptance rate by month, count and value"
        />
        {showVolume ? (
          <>
            <div className="striphead">
              <span className="sl">Volume</span>
              <span className="sn">quotes sent (columns) and accepted per month — own count axis</span>
            </div>
            <LineChart
              labels={labels}
              series={[{ name: "Accepted", vals: won, color: ACC, width: 2 }]}
              bars={{ vals: sent }}
              h={110}
              ymax={volTop}
              ticks={2}
              yFmt={fmt.n}
              tip={(i) => tipTitle(full[i]) + tipRow("#e4e7ed", "Quotes sent", fmt.n(sent[i])) + tipRow(ACC, "Accepted", fmt.n(won[i]))}
              ariaLabel="Quotes sent and accepted per month"
            />
          </>
        ) : null}
      </div>
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

/* ── Row 3: Acceptance by Deal Size ────────────────────── */

function DealSizeCard({
  model,
  cur,
  onOpen,
}: {
  model: QuoteMetricsReadModel;
  cur: QuoteMonthlyMetric;
  onOpen: (tier: TierSegment) => void;
}) {
  const long = monthLong(model.selectedMonth);
  const tiers = model.acceptanceByTier;
  const maxValue = Math.max(1, ...tiers.map((t) => t.quoteValue));
  return (
    <Card className="span12" title="Acceptance by Deal Size" subtitle={`${long} quotes by value tier · bar = quoted value relative to the largest tier`}>
      <CardBody>
        <BarList variant="tiergrid">
          {tiers.map((t) => {
            const low = t.acceptanceRateCount !== null && t.acceptanceRateCount < 15;
            return (
              <BarListRow
                key={t.tier}
                name={displayTier(t.tier)}
                value={rateText(t.acceptanceRateCount)}
                bad={low}
                barPct={Math.max((t.quoteValue / maxValue) * 100, 0.5)}
                barBad={low}
                meta={`${fmt.moneyFull(t.quoteValue)} quoted · ${t.quoteCount} ${t.quoteCount === 1 ? "quote" : "quotes"} · ${rateText(t.acceptanceRateValue)} accepted by value`}
                onClick={() => onOpen(t)}
              />
            );
          })}
        </BarList>
        {tierCallout(model, cur)}
      </CardBody>
    </Card>
  );
}

/** The one allowed narrative callout (owner-approved): the top-value tier's
 *  share and close rates, derived from the tier data — never hardcoded. */
function tierCallout(model: QuoteMetricsReadModel, cur: QuoteMonthlyMetric): ReactNode {
  const long = monthLong(model.selectedMonth);
  const top = [...model.acceptanceByTier].sort((a, b) => b.quoteValue - a.quoteValue)[0];
  if (!top || cur.quoteValue <= 0 || top.quoteCount === 0) return null;
  const share = Math.round((top.quoteValue / cur.quoteValue) * 100);
  return (
    <div className="callout">
      <span className="diam">◆</span>
      <b>{displayTier(top.tier)} carries the value.</b> {top.quoteCount} {top.quoteCount === 1 ? "quote" : "quotes"} carried{" "}
      {share}% of {long}’s quoted value, closing at {rateText(top.acceptanceRateCount)} by count and{" "}
      {rateText(top.acceptanceRateValue)} by value.
    </div>
  );
}

function TierDrawerBody({ tier }: { tier: TierSegment }) {
  return (
    <>
      <KV>
        <KVCell label="Quoted value" value={fmt.moneyFull(tier.quoteValue)} />
        <KVCell label="Accepted value" value={fmt.moneyFull(tier.acceptedValue)} />
        <KVCell label="Rate (count)" value={rateText(tier.acceptanceRateCount)} />
        <KVCell label="Rate (value)" value={rateText(tier.acceptanceRateValue)} />
      </KV>
      <DSec>Cohort</DSec>
      <DNote>
        {tier.acceptedCount} accepted · {tier.notAcceptedCount} not accepted. Every quote in this tier is part of the
        month&rsquo;s Monthly Breakdown cohort; acceptance requires verified online acceptance or an exact converted job.
      </DNote>
    </>
  );
}

/* ── Quote classification drawers (retained) ───────────── */

export function QuoteDrawerDetail({ row }: { row: QuoteFollowUpQueueRow }) {
  const viewed = /view/i.test(row.status);
  return (
    <>
      <KV>
        <KVCell label="Value" value={fmt.moneyFull(row.value)} />
        <KVCell
          label="Sent"
          def="Simpro DateIssued — the quote issue date that assigns the reporting month."
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

/* ── Row 4: tier × month heatmap ───────────────────────── */

/* Validated ordinal ramp (mockups tokens.css .heatmap .b0–.b4). */
const HEAT_LEGEND: Array<[string, string]> = [
  ["color-mix(in srgb,#d0463a,#fff 30%)", "<15%"],
  ["color-mix(in srgb,#5b63d3,#fff 46%)", "15–25"],
  ["color-mix(in srgb,#5b63d3,#fff 23%)", "25–35"],
  ["#5b63d3", "35–45"],
  ["color-mix(in srgb,#5b63d3,#000 22%)", "45%+"],
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
  const heatLabels = months.map((m, i) => heatLabel(m.month, i)).slice(-keep);
  const heatRows = model.heatmap.map((row) => ({
    name: displayTier(row.tier),
    cells: row.months.slice(-keep).map((cell) => ({
      v: cell.acceptanceRate,
    })),
  }));
  const swatch = (background: string, extra?: CSSProperties) => (
    <i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background, ...extra }} />
  );
  return (
    <Card
      className="span12"
      style={{ display: "flex", flexDirection: "column" }}
      title="Acceptance by Deal Size and Month"
      subtitle={`Count-based acceptance per tier · ${months[0] ? seriesName(months[0].month) : ""} – ${months.at(-1) ? seriesName(months.at(-1)!.month) : ""} · hover or tap any cell`}
      aside={
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 12,
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
          </div>
        </div>
      }
    >
      <div data-viz="">
        <Heatmap
          months={heatLabels}
          rows={heatRows}
          highlightLast
          cols={keep}
          style={{ paddingTop: 6, flex: 1, alignContent: "start", rowGap: 6 }}
        />
      </div>
      {narrow ? (
        <div style={{ fontSize: 12, color: "var(--subtle)", padding: "6px 20px 0" }}>
          {heatLabels[0]} – {heatLabels.at(-1)} · the full year shows on wider screens
        </div>
      ) : null}
      <CardBody style={{ paddingTop: 0 }}>
        <Fnote>
          Each cell is the count-based acceptance rate for that tier and month; — means no denominator.
        </Fnote>
      </CardBody>
    </Card>
  );
}

/* ── Row 5: Monthly Breakdown (always present — tabs removed) ── */

function HistoryCard({ model, months }: { model: QuoteMetricsReadModel; months: QuoteMonthlyMetric[] }) {
  const chronological = months;
  const labels = new Map(chronological.map((m, i) => [m.month, chartLabel(m.month, i)]));
  const displayRows = model.monthlyBreakdown; // newest first
  const hasPartial = displayRows.some((m) => m.provisional);
  const totals = historyTotals(chronological);
  const footTd: CSSProperties = { fontWeight: 700, padding: "13px 20px", borderTop: "1px solid var(--hair)" };
  return (
    <Card
      className="span12"
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

/** Client-side CSV of the Monthly Breakdown (approved C7) — same columns and
 *  the same computed Trailing-12 row, consistent weights (Σaccepted ÷ Σsent). */
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

/** Table month labels: "Jul 25", "Aug", …, "Jan 26", … (year on the first
 *  column and each January, mirroring the approved M array). */
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

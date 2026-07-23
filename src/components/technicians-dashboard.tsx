"use client";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { DevBars, fmt, Histogram, tipHide, tipRow, tipShow, tipTitle, type HistogramBucket } from "@/components/charts";
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
  Legend,
  Seg,
  Skel,
  StateEmpty,
  StateError,
  StateMini,
  StatesStrip,
} from "@/components/reset";
import { KpiBand, KpiBandNote, KpiTile, KpiTiles } from "@/components/band";
import type {
  TechnicianJobAllocationDetail,
  TechnicianPerformance,
  TechnicianPerformanceReadModel,
  TechnicianPunctualityDistribution,
} from "@/lib/metrics/technicians";
import type { DashboardReadModel, TechnicianHistorySummary } from "@/lib/store/dashboard-read-models";

/* /technicians — implements the owner-approved redesign
   docs/approved-design/mockups/technicians.html exactly, with every figure
   taken from the technician read-model payload. Composition: KPI band
   (primary PRODUCTIVE UTILIZATION card + UNBILLED/QLE/ON-TIME tiles + the
   no-history note) → full-width Recorded Time card (job / travel / other
   unbilled per technician) → Labor Efficiency + Punctuality (drills to the
   ranked per-tech on-time list) → Scorecard → Completed-Job Economics.
   OWNER RULINGS: no capacity model anywhere (no capacity line, no
   capacity-used tile or column, no capacity math in hover detail) and no
   alert banners. */

const ACC = "#5b63d3";
const SERIES2 = "#0e9aae"; /* var(--series-2) */
const GREY = "#9aa2b2"; /* var(--series-weak) */
const POS = "#1a8a5a";
const NEG = "#d0463a";
/** Inactive rule (display only): recorded below 20% of the month's gross availability. */
const INACTIVE_SHARE = 0.2;

/* ── Payload guard ─────────────────────────────────────── */

/** Accepts only the detailed technician contract (exact net-profit basis +
 *  the roster/outside-roster disclosure fields). Anything else renders
 *  the honest error state — never synthetic zeros. */
export function technicianPayload(model: DashboardReadModel): TechnicianPerformanceReadModel | null {
  const candidate = model.payload;
  if (!candidate || typeof candidate !== "object") return null;
  if (!("netProfitBasis" in candidate) || candidate.netProfitBasis !== "simpro_job_net_profit_actual") return null;
  if (!("technicians" in candidate) || !Array.isArray(candidate.technicians)) return null;
  if (!("rosterApplied" in candidate) || !("outsideRoster" in candidate) || !Array.isArray(candidate.outsideRoster)) return null;
  if (!("coverage" in candidate) || typeof candidate.coverage !== "object") return null;
  return candidate as TechnicianPerformanceReadModel;
}

type EmptyTechnicianPayload = {
  periodStart: string;
  periodEnd: string | null;
};

function emptyTechnicianPayload(model: DashboardReadModel): EmptyTechnicianPayload | null {
  const candidate = model.payload;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  if (!("technicians" in candidate) || !Array.isArray(candidate.technicians) || candidate.technicians.length > 0) {
    return null;
  }
  if (!("periodStart" in candidate) || typeof candidate.periodStart !== "string") return null;
  if (!("coverage" in candidate) || typeof candidate.coverage !== "object") return null;
  return {
    periodStart: candidate.periodStart,
    periodEnd: "periodEnd" in candidate && typeof candidate.periodEnd === "string" ? candidate.periodEnd : null,
  };
}

/* ── Row derivation (pure, exported for tests) ─────────── */

export type TechnicianScoreRow = {
  employeeId: string;
  name: string;
  /** Completed jobs carrying this technician's hours (allocation cohort). */
  jobs: number;
  /** Job-assigned recorded hours in the month. */
  job: number;
  /** All recorded hours in the month. */
  rec: number;
  /** Unbilled = recorded − job-assigned. */
  unb: number;
  inactive: boolean;
  /** Productive utilization %, job ÷ recorded (null when inactive/no basis). */
  util: number | null;
  /** Quote-linked labor efficiency ratio (est ÷ act), representative. */
  effQ: number | null;
  /** Recurring labor efficiency ratio (est ÷ act), representative. */
  effR: number | null;
  /** On-time arrival % over verified visits (null without coverage). */
  ot: number | null;
  sell: number;
  np: number | null;
  archived: boolean;
  dateOfHire: string | null;
  outsidePeriodHours: number | null;
  tech: TechnicianPerformance;
};

function toScoreRow(tech: TechnicianPerformance): TechnicianScoreRow {
  const job = tech.jobHours;
  const rec = tech.totalRecordedHours;
  const avail = tech.grossCapacityHours;
  const inactive = avail > 0 ? rec < avail * INACTIVE_SHARE : rec <= 0;
  const qg = tech.laborEfficiency.quoteGenerated;
  const rc = tech.laborEfficiency.recurring;
  return {
    employeeId: tech.employeeId,
    name: tech.displayName,
    jobs: tech.coverage.allocatedJobs,
    job,
    rec,
    unb: Math.max(rec - job, 0),
    inactive,
    util: !inactive && rec > 0 ? (job / rec) * 100 : null,
    effQ: qg.jobs > 0 && qg.actualHours > 0 ? qg.quotedHours / qg.actualHours : null,
    effR: rc.jobs > 0 && rc.actualHours > 0 ? rc.quotedHours / rc.actualHours : null,
    ot: tech.arrivalCoveredVisits > 0 && tech.onTimeRate !== null ? tech.onTimeRate : null,
    sell: tech.allocatedSellValue,
    np: tech.allocatedNetProfit,
    archived: tech.archived,
    dateOfHire: tech.dateOfHire,
    outsidePeriodHours: tech.actualJobHoursOutsidePeriod,
    tech,
  };
}

/** Effective-roster scorecard rows — archived people are disclosed
 *  separately and never promoted into the scorecard. */
export function technicianScoreRows(payload: TechnicianPerformanceReadModel): TechnicianScoreRow[] {
  return payload.technicians.filter((tech) => !tech.archived).map(toScoreRow);
}

/** Archived field-position people kept for history. */
export function archivedTechnicianRows(payload: TechnicianPerformanceReadModel): TechnicianScoreRow[] {
  return payload.technicians.filter((tech) => tech.archived).map(toScoreRow);
}

export const SCORE_SORT_KEYS = ["job", "unb", "util", "effQ", "ot"] as const;
export type ScoreSortKey = (typeof SCORE_SORT_KEYS)[number];

export function scoreSortValue(row: TechnicianScoreRow, key: ScoreSortKey): number | null {
  if (key === "util") return row.inactive ? null : row.rec > 0 ? row.job / row.rec : null;
  if (key === "unb") return row.unb;
  if (key === "effQ") return row.effQ;
  if (key === "ot") return row.ot;
  return row.job;
}

/** Sortable in both directions on every metric column; "—" (null) rows
 *  always sort last regardless of direction. */
export function sortScoreRows(rows: TechnicianScoreRow[], key: ScoreSortKey, dir: 1 | -1): TechnicianScoreRow[] {
  return [...rows].sort((a, b) => {
    const va = scoreSortValue(a, key);
    const vb = scoreSortValue(b, key);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return dir * (va - vb);
  });
}

/** Approved punctuality buckets: Early / ≤ 15 min / 16–30 min / 30+ min.
 *  "≤ 15 min" merges the exact-on-time and 1–15-minute payload buckets. */
export function punctualityBuckets(punctuality: TechnicianPunctualityDistribution): HistogramBucket[] {
  return [
    { label: "Early", count: punctuality.early },
    { label: "≤ 15 min", count: punctuality.onTime + punctuality.late1To15 },
    { label: "16–30 min", count: punctuality.late16To30, neg: true },
    { label: "30+ min", count: punctuality.lateOver30, neg: true },
  ];
}

/* ── Unbilled activity split (owner requirement: never lumped) ── */

export type TechnicianActivityBucket = { label: string; hours: number };

/** Per-technician (or summed team) unbilled activity split from the REAL
 *  payload fields — never invented, never lumped into one number. */
export function activityBuckets(source: {
  travelHours: number;
  holidayHours: number;
  lunchHours: number;
  pickupPartsHours: number;
  sickPersonalHours: number;
  ptoHours: number;
  supportHours: number;
}): TechnicianActivityBucket[] {
  return [
    { label: "Travel", hours: source.travelHours },
    { label: "Holiday", hours: source.holidayHours },
    { label: "Lunch", hours: source.lunchHours },
    { label: "Pickup parts", hours: source.pickupPartsHours },
    { label: "Sick / personal", hours: source.sickPersonalHours },
    { label: "PTO", hours: source.ptoHours },
    { label: "Support / office", hours: source.supportHours },
  ]
    .filter((bucket) => bucket.hours > 0.049)
    .sort((a, b) => b.hours - a.hours);
}

/** "Travel 240.5h · Holiday 72h · … · 2 more types" (mockup tile sub). */
export function activitySplitText(buckets: TechnicianActivityBucket[], max = 5): string {
  if (buckets.length === 0) return "no unbilled activity recorded";
  const shown = buckets.slice(0, max).map((bucket) => `${bucket.label} ${fmt.hrs(bucket.hours)}`);
  const rest = buckets.length - max;
  return rest > 0 ? `${shown.join(" · ")} · ${rest} more ${rest === 1 ? "type" : "types"}` : shown.join(" · ");
}

/* ── Formatting helpers ────────────────────────────────── */

const pctInt = (value: number) => `${Math.round(value)}%`;
const ratioX = (value: number) => `${value.toFixed(2)}×`;

function monthLongName(periodStart: string): string {
  const [year, month] = periodStart.split("-").map(Number);
  if (!year || !month) return periodStart;
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function periodYear(periodStart: string): string {
  return periodStart.slice(0, 4);
}

/** "2026-07-01" shifted by n months → "Jun ’26" / "Jul ’25". */
function shiftedSeriesName(periodStart: string, shiftMonths: number): string {
  const [year, month] = periodStart.split("-").map(Number);
  if (!year || !month) return periodStart;
  const date = new Date(Date.UTC(year, month - 1 + shiftMonths, 1));
  const mon = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  return `${mon} ’${String(date.getUTCFullYear()).slice(2)}`;
}

/** "2007-08-27" → "Aug 2007". */
function hireLabel(dateOfHire: string | null): string | null {
  if (!dateOfHire) return null;
  const [year, month] = dateOfHire.split("-").map(Number);
  if (!year || !month) return null;
  const name = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
  return `${name} ${year}`;
}

function listJoin(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/* ── Team facts ────────────────────────────────────────── */

export type TechnicianTeamFacts = {
  monthLong: string;
  year: string;
  rosterCount: number;
  job: number;
  rec: number;
  unb: number;
  /** Team unbilled activity split (descending, real payload fields summed). */
  activity: TechnicianActivityBucket[];
  utilPct: number | null;
  /** Verified team quote-linked efficiency ratio (Σ est ÷ Σ act). */
  teamEff: number | null;
  teamEffEstHours: number;
  teamEffActHours: number;
  effCoveredJobs: number;
  effTotalJobs: number;
  effMissingEstimate: number;
  scheduledVisits: number;
  verifiedVisits: number;
  onTimeVisits: number;
  otPct: number | null;
  otFloorPct: number | null;
};

export type TechnicianUtilizationHistory = {
  periodStart: string;
  utilizationPercent: number;
};

export function deriveTeamFacts(payload: TechnicianPerformanceReadModel, rows: TechnicianScoreRow[]): TechnicianTeamFacts {
  const job = rows.reduce((sum, row) => sum + row.job, 0);
  const rec = rows.reduce((sum, row) => sum + row.rec, 0);
  const coverage = payload.coverage;
  const teamEffEstHours = coverage.quoteGeneratedAllocatedQuotedHours;
  const teamEffActHours = coverage.quoteGeneratedActualHours;
  const rosterTechs = payload.technicians;
  const scheduledVisits = rosterTechs.reduce((sum, tech) => sum + tech.scheduledVisits, 0);
  const verifiedVisits = rosterTechs.reduce((sum, tech) => sum + tech.arrivalCoveredVisits, 0);
  const onTimeVisits = rosterTechs.reduce((sum, tech) => sum + tech.onTimeVisits, 0);
  const activity = activityBuckets({
    travelHours: rows.reduce((sum, row) => sum + row.tech.travelHours, 0),
    holidayHours: rows.reduce((sum, row) => sum + row.tech.holidayHours, 0),
    lunchHours: rows.reduce((sum, row) => sum + row.tech.lunchHours, 0),
    pickupPartsHours: rows.reduce((sum, row) => sum + row.tech.pickupPartsHours, 0),
    sickPersonalHours: rows.reduce((sum, row) => sum + row.tech.sickPersonalHours, 0),
    ptoHours: rows.reduce((sum, row) => sum + row.tech.ptoHours, 0),
    supportHours: rows.reduce((sum, row) => sum + row.tech.supportHours, 0),
  });
  return {
    monthLong: monthLongName(payload.periodStart),
    year: periodYear(payload.periodStart),
    rosterCount: rows.length,
    job,
    rec,
    unb: Math.max(rec - job, 0),
    activity,
    utilPct: rec > 0 ? (job / rec) * 100 : null,
    teamEff: teamEffActHours > 0 ? teamEffEstHours / teamEffActHours : null,
    teamEffEstHours,
    teamEffActHours,
    effCoveredJobs: coverage.quoteGeneratedJobsWithLabor,
    effTotalJobs: coverage.quoteGeneratedJobs,
    effMissingEstimate: Math.max(coverage.quoteGeneratedJobs - coverage.quoteGeneratedJobsWithLabor, 0),
    scheduledVisits,
    verifiedVisits,
    onTimeVisits,
    otPct: verifiedVisits > 0 ? (onTimeVisits / verifiedVisits) * 100 : null,
    otFloorPct: scheduledVisits > 0 ? (onTimeVisits / scheduledVisits) * 100 : null,
  };
}

function shiftPeriodStart(periodStart: string, offset: number): string {
  const [year, month] = periodStart.slice(0, 7).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return date.toISOString().slice(0, 10);
}

export function utilizationComparison(
  summary: TechnicianHistorySummary | undefined,
  periodStart: string,
  offset: number,
): TechnicianUtilizationHistory | null {
  const comparison = summary?.comparisons.find((entry) => entry.periodStart === shiftPeriodStart(periodStart, offset));
  return comparison && comparison.recordedHours > 0
    ? { periodStart: comparison.periodStart, utilizationPercent: (comparison.jobHours / comparison.recordedHours) * 100 }
    : null;
}

function effDef(facts: TechnicianTeamFacts): string {
  const verified = facts.teamEff !== null
    ? ` The ${ratioX(facts.teamEff)} team ratio (${fmt.hrs(facts.teamEffEstHours)} ÷ ${fmt.hrs(facts.teamEffActHours)}) uses the same recorded-time allocation.`
    : "";
  return `Per-technician ratios allocate each crew job's estimated and actual hours by recorded job time.${verified}`;
}

function otDef(facts: TechnicianTeamFacts): string {
  return `Verified mobile arrival events matched ${facts.verifiedVisits} of ${facts.scheduledVisits} ${facts.monthLong} scheduled visits. Visits without a matched arrival event are uncovered, not counted late.`;
}

/* ── Dashboard ─────────────────────────────────────────── */

export type TechniciansDashboardProps = {
  model: DashboardReadModel;
  /** Renders the design-reference state strip (mockups' ?states=1 gate). */
  showStates?: boolean;
  /** Opens the drilldown for this technician on first render (mockups' ?drill=1 affordance; also used by tests). */
  initialDrillEmployeeId?: string;
};

export function TechniciansDashboard({ model, showStates, initialDrillEmployeeId }: TechniciansDashboardProps) {
  const payload = technicianPayload(model);
  const emptyPayload = payload ? null : emptyTechnicianPayload(model);
  const monthLong = payload ? monthLongName(payload.periodStart) : emptyPayload ? monthLongName(emptyPayload.periodStart) : "the selected month";
  return (
    <DefTooltipProvider>
      {payload ? (
        <TechniciansContent
          payload={payload}
          historySummary={model.technicianHistory}
          initialDrillEmployeeId={initialDrillEmployeeId}
        />
      ) : emptyPayload ? (
        <TechniciansEmptyMonth payload={emptyPayload} />
      ) : (
        <Card>
          <CardBody>
            <StateError onRetry={() => window.location.reload()}>Technician data could not be loaded.</StateError>
          </CardBody>
        </Card>
      )}
      <StatesStrip show={showStates}>
        <StateMini label="Loading">
          <Skel width="55%" />
          <Skel width="85%" />
          <Skel width="70%" />
        </StateMini>
        <StateMini label="No punctuality coverage">
          <StateEmpty>A technician with no verified visits shows “no coverage” — never 0% or 100%.</StateEmpty>
        </StateMini>
        <StateMini label="Mid-month roster change">
          <StateEmpty>Archived on the 14th → hours through the 13th only; history stays.</StateEmpty>
        </StateMini>
        <StateMini label="Error">
          <StateError>Technician data could not be loaded.</StateError>
        </StateMini>
      </StatesStrip>
      <div className="footline">
        Source: Simpro — roster is everyone with recorded work in {monthLong}; work metrics use {monthLong}-dated timesheets,
        with completed-job economics labeled as a separate cohort.
      </div>
    </DefTooltipProvider>
  );
}

function TechniciansEmptyMonth({ payload }: { payload: EmptyTechnicianPayload }) {
  const monthLong = monthLongName(payload.periodStart);
  return (
    <Card>
      <CardBody>
        <StateEmpty>No technician activity is recorded for {monthLong}. Pick another month.</StateEmpty>
      </CardBody>
    </Card>
  );
}

function TechniciansContent({
  payload,
  historySummary,
  initialDrillEmployeeId,
}: {
  payload: TechnicianPerformanceReadModel;
  historySummary?: TechnicianHistorySummary;
  initialDrillEmployeeId?: string;
}) {
  const rows = useMemo(() => technicianScoreRows(payload), [payload]);
  const archivedRows = useMemo(() => archivedTechnicianRows(payload), [payload]);
  const facts = useMemo(() => deriveTeamFacts(payload, rows), [payload, rows]);
  const [drillId, setDrillId] = useState<string | null>(initialDrillEmployeeId ?? null);
  const [punctOpen, setPunctOpen] = useState(false);
  const drillRow = drillId !== null
    ? rows.find((row) => row.employeeId === drillId) ?? archivedRows.find((row) => row.employeeId === drillId) ?? null
    : null;

  return (
    <>
      <TechniciansBand facts={facts} payload={payload} historySummary={historySummary} />
      <div className="grid12">
        <RecordedTimeCard rows={rows} onOpen={(row) => setDrillId(row.employeeId)} />
      </div>
      {/* Stretch this pair so the row ends flush (gate: multi-card rows within 28px). */}
      <div className="grid12" style={{ alignItems: "stretch" }}>
        <EfficiencyCard rows={rows} facts={facts} />
        <PunctualityCard payload={payload} facts={facts} onOpenDetail={() => setPunctOpen(true)} />
      </div>
      <div className="grid12">
        <ScorecardCard rows={rows} facts={facts} rosterApplied={payload.rosterApplied} onOpen={(row) => setDrillId(row.employeeId)} />
      </div>
      <div className="grid12">
        <EconomicsCard payload={payload} rows={rows} archivedRows={archivedRows} facts={facts} />
      </div>
      <Drawer
        open={drillRow !== null}
        onClose={() => setDrillId(null)}
        ariaLabel="Technician detail"
        title={drillRow?.name ?? null}
        sub={drillRow ? `${facts.monthLong} ${facts.year}` : null}
      >
        {drillRow ? <TechnicianDrill row={drillRow} facts={facts} payload={payload} onBack={() => setDrillId(null)} /> : null}
      </Drawer>
      <Drawer
        open={punctOpen}
        onClose={() => setPunctOpen(false)}
        ariaLabel="Punctuality by technician"
        title="Punctuality by technician"
        sub="On-time share of verified visits · lowest first"
      >
        <PunctualityDrawerBody payload={payload} facts={facts} />
      </Drawer>
    </>
  );
}

/* ── Row 1: KPI band ───────────────────────────────────── */

function TechniciansBand({
  facts,
  payload,
  historySummary,
}: {
  facts: TechnicianTeamFacts;
  payload: TechnicianPerformanceReadModel;
  historySummary?: TechnicianHistorySummary;
}) {
  const { monthLong } = facts;
  const prevName = shiftedSeriesName(payload.periodStart, -1);
  const lyName = shiftedSeriesName(payload.periodStart, -12);
  const priorMonth = utilizationComparison(historySummary, payload.periodStart, -1);
  const priorYear = utilizationComparison(historySummary, payload.periodStart, -12);
  const utilDef = `Job-assigned timesheet hours ÷ all recorded hours, using timesheets dated in ${monthLong}, across the ${facts.rosterCount}-person recorded-work roster only.`;
  const unbilledDef = `All recorded hours minus job-assigned hours — the split lists every recorded activity type from the ${monthLong} timesheets.`;
  const effStatDef = `Σ estimated ÷ Σ actual hours on quote-linked ${monthLong} jobs where both are present: ${fmt.hrs(facts.teamEffEstHours)} ÷ ${fmt.hrs(facts.teamEffActHours)}. Above 1.00× beats the estimate${
    facts.effMissingEstimate > 0 ? `; ${facts.effMissingEstimate} more jobs have actuals but no estimate` : ""
  }.`;
  const onTimeDef =
    "Arrival within 15 minutes of planned start — early arrivals count on-time — over visits with a verified mobile arrival event; missing events are uncovered, never counted late.";
  const utilValue = facts.utilPct !== null ? pctInt(facts.utilPct) : "—";

  return (
    <>
      <KpiBand ariaLabel={`${monthLong} key metrics`}>
        <a className="kpi primary" href="#recorded-time">
          <span className="lblrow">
            <span className="lbl">
              <span className="def" data-def={utilDef}>Productive utilization</span>
            </span>
          </span>
          <span className="val">{utilValue}</span>
          <span className="sub">
            {fmt.hrs(facts.job)} on jobs of {fmt.hrs(facts.rec)} recorded
          </span>
          <div
            className="bullet"
            data-viz=""
            aria-label={`Productive utilization ${utilValue}${
              priorMonth ? `; ${prevName} ${pctInt(priorMonth.utilizationPercent)}` : ""
            }${priorYear ? `; ${lyName} ${pctInt(priorYear.utilizationPercent)}` : ""}`}
          >
            <div className="btrack">
              <i style={{ width: `${Math.min(100, Math.max(facts.utilPct ?? 0, 0))}%` }} />
            </div>
            <div className="bcap">
              <span className="bkey">
                {priorMonth ? `${prevName} ${pctInt(priorMonth.utilizationPercent)}` : `${prevName} unavailable`}
                {" · "}
                {priorYear ? `${lyName} ${pctInt(priorYear.utilizationPercent)}` : `${lyName} unavailable`}
              </span>
            </div>
          </div>
        </a>
        <KpiTiles>
          <div className="kpi wide" style={{ gridColumn: "span 2" }}>
            <span className="lbl">
              <span className="def" data-def={unbilledDef}>Unbilled hours</span>
            </span>
            <span className="val">{fmt.hrs(facts.unb)}</span>
            <span className="sub">{activitySplitText(facts.activity)}</span>
          </div>
          <KpiTile
            label="Quote labor efficiency"
            labelDef={effStatDef}
            value={facts.teamEff !== null ? ratioX(facts.teamEff) : "—"}
            sub={`team · ${facts.effCoveredJobs} of ${facts.effTotalJobs} quote-linked jobs`}
          />
          <KpiTile
            label="On-Time Arrival"
            labelDef={onTimeDef}
            value={
              facts.otPct !== null ? (
                <span className="repr" data-def={otDef(facts)}>
                  {pctInt(facts.otPct)}
                </span>
              ) : (
                "—"
              )
            }
            sub={
              facts.verifiedVisits > 0
                ? `${facts.onTimeVisits} of ${facts.verifiedVisits} verified visits`
                : "no verified visits"
            }
          />
        </KpiTiles>
      </KpiBand>
      <KpiBandNote>
        {priorMonth || priorYear
          ? `Prior-period utilization is from stored timesheet models${historySummary?.availableFrom ? `; data is available from ${monthLongName(historySummary.availableFrom)} ${periodYear(historySummary.availableFrom)}` : ""}.`
          : "No prior-period technician model is available for comparison."}
      </KpiBandNote>
    </>
  );
}

/* ── Row 2: Recorded Time (primary visualization) ──────── */

function recordedTimeRowTip(row: TechnicianScoreRow): string {
  const buckets = activityBuckets(row.tech);
  const travel = buckets.find((bucket) => bucket.label === "Travel");
  const others = buckets.filter((bucket) => bucket.label !== "Travel");
  return (
    tipRow(ACC, "Job-assigned", fmt.hrs(row.job)) +
    (travel ? tipRow(SERIES2, "Travel", fmt.hrs(travel.hours)) : "") +
    others.map((bucket) => tipRow(GREY, bucket.label, fmt.hrs(bucket.hours))).join("") +
    tipRow(GREY, "Recorded total", fmt.hrs(row.rec))
  );
}

function RecordedTimeCard({ rows, onOpen }: { rows: TechnicianScoreRow[]; onOpen: (row: TechnicianScoreRow) => void }) {
  const sorted = useMemo(() => [...rows].sort((a, b) => b.job - a.job), [rows]);
  const scale = Math.max(1, ...sorted.map((row) => row.rec)) * 1.04;
  return (
    <Card
      className="span12"
      style={{ scrollMarginTop: 70 }}
      title={<span id="recorded-time">Recorded Time by Technician</span>}
      subtitle="Job-assigned vs travel vs other unbilled · sorted by job hours · click a row for the full activity split"
      aside={
        <Legend
          style={{ padding: 0 }}
          items={[
            { label: "Job-assigned", color: ACC },
            { label: "Travel", color: SERIES2 },
            { label: "Other unbilled", color: GREY },
          ]}
        />
      }
    >
      <CardBody>
        {sorted.length > 0 ? (
          <div className="caprows" data-viz="" data-primary-viz="">
            {sorted.map((row) => {
              const travel = Math.min(row.tech.travelHours, row.unb);
              const other = Math.max(row.unb - travel, 0);
              const jobW = (row.job / scale) * 100;
              const travW = (travel / scale) * 100;
              const otherW = (other / scale) * 100;
              const utilizationLabel = row.util !== null ? `${Math.round(row.util)}% of ${fmt.hrs(row.rec)} recorded` : `of ${fmt.hrs(row.rec)} recorded`;
              const drillLabel = row.inactive
                ? `${row.name} — inactive, ${fmt.hrs(row.rec)} recorded; open the full ${row.name} drilldown`
                : `${row.name} — ${fmt.hrs(row.job)} job-assigned out of ${fmt.hrs(row.rec)} recorded, ${row.util !== null ? `${Math.round(row.util)}% of recorded` : "utilization unavailable"}; open the full ${row.name} drilldown`;
              return (
                <div
                  key={row.employeeId}
                  className={row.inactive ? "crow inactive drillable" : "crow drillable"}
                  role="button"
                  tabIndex={0}
                  aria-label={drillLabel}
                  onClick={() => onOpen(row)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpen(row);
                    }
                  }}
                  onPointerEnter={(event) => tipShow(tipTitle(row.name) + recordedTimeRowTip(row), event.clientX, event.clientY)}
                  onPointerLeave={tipHide}
                >
                  <span className="cname">{row.name}</span>
                  <div className="ctrack">
                    {jobW > 0.15 ? <span className="job" style={{ width: `${jobW.toFixed(2)}%` }} /> : null}
                    {travW > 0.15 ? (
                      <span className="unb trav" style={{ left: `${jobW.toFixed(2)}%`, width: `${travW.toFixed(2)}%` }} />
                    ) : null}
                    {otherW > 0.15 ? (
                      <span className="unb" style={{ left: `${(jobW + travW).toFixed(2)}%`, width: `${otherW.toFixed(2)}%` }} />
                    ) : null}
                  </div>
                  <span className="cmeta">
                    {row.inactive ? (
                      <>
                        <b>inactive</b>
                        <small>{fmt.hrs(row.rec)} recorded</small>
                      </>
                    ) : (
                      <>
                        <b>{fmt.hrs(row.job)} job hrs</b>
                        <small>{utilizationLabel}</small>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <StateEmpty>No roster technicians recorded time this month.</StateEmpty>
        )}
      </CardBody>
    </Card>
  );
}

/* ── Row 3: Labor Efficiency ───────────────────────────── */

function EfficiencyCard({ rows, facts }: { rows: TechnicianScoreRow[]; facts: TechnicianTeamFacts }) {
  const [mode, setMode] = useState<"quote" | "recurring">("quote");
  const EFF_DEF = effDef(facts);
  const barRows = useMemo(
    () =>
      rows
        .filter((row) => row.jobs > 0)
        .map((row) => ({ name: row.name, v: mode === "recurring" ? row.effR : row.effQ }))
        .sort((a, b) => (b.v ?? -9) - (a.v ?? -9)),
    [rows, mode],
  );
  return (
    <Card
      className="span6"
      title="Labor Efficiency"
      subtitle={
        <>
          Estimated ÷ actual hours — above 1.00× beats the estimate ·{" "}
          <span data-def={EFF_DEF}>
            per-tech hour-share allocation
          </span>
        </>
      }
      aside={
        <Seg
          dataSeg="effmode"
          ariaLabel="Labor efficiency mode"
          options={[
            { val: "quote", label: "Quote-linked" },
            { val: "recurring", label: "Recurring" },
          ]}
          value={mode}
          onChange={(val) => setMode(val === "recurring" ? "recurring" : "quote")}
        />
      }
    >
      <CardBody>
        {barRows.length > 0 ? (
          <DevBars
            rows={barRows}
            refValue={1}
            min={0.7}
            max={1.3}
            labelW={132}
            refLabel="1.00× — estimate met exactly"
            fmt={ratioX}
            pos={POS}
            neg={NEG}
          />
        ) : (
          <StateEmpty>No covered {mode === "recurring" ? "recurring" : "quote-linked"} jobs for the roster this month.</StateEmpty>
        )}
        <Fnote>
          <span style={{ color: "var(--success-fg)" }}>●</span> right of the line = beat the estimate{"  "}
          <span style={{ color: "var(--state-failed-fg)" }}>●</span> left = over · {facts.effCoveredJobs} covered jobs (team)
          {facts.teamEff !== null ? <> — team and per-technician figures use the recorded-time allocation.</> : "."}
        </Fnote>
        {mode === "recurring" ? (
          <Fnote style={{ borderTop: "none", paddingTop: 0 }}>
            Recurring-work efficiency is{" "}
            <span
              className="repr"
              data-def="Recurring estimates are copied templates in Simpro; per-technician recurring ratios are directional until those estimates are re-verified."
            >
              representative
            </span>{" "}
            until recurring estimates are re-verified per technician.
          </Fnote>
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ── Row 3: Punctuality (click → ranked per-tech list) ─── */

function PunctualityCard({
  payload,
  facts,
  onOpenDetail,
}: {
  payload: TechnicianPerformanceReadModel;
  facts: TechnicianTeamFacts;
  onOpenDetail: () => void;
}) {
  const buckets = punctualityBuckets(payload.punctuality);
  const coveragePct = facts.scheduledVisits > 0 ? (facts.verifiedVisits / facts.scheduledVisits) * 100 : 0;
  return (
    <Card
      className="span6"
      title="Punctuality"
      subtitle={
        <>
          Verified arrivals vs planned start ·{" "}
          <span
            className="repr"
            data-def={`Verified mobile arrivals cover ${facts.verifiedVisits} of ${facts.scheduledVisits} ${facts.monthLong} visits. Visits without a matching arrival event are excluded from technician rates.`}
          >
            {facts.verifiedVisits} of {facts.scheduledVisits} visits covered
          </span>
          {" "}· click for per-technician detail
        </>
      }
    >
      <CardBody>
        {facts.verifiedVisits > 0 ? (
          <>
            <div
              role="button"
              tabIndex={0}
              aria-label="Arrival distribution — open per-technician punctuality"
              style={{ cursor: "pointer" }}
              onClick={onOpenDetail}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenDetail();
                }
              }}
            >
              <Histogram buckets={buckets} h={300} seriesName="Visits" style={{ maxWidth: 620, margin: "0 auto" }} />
            </div>
            <div
              className="tnum"
              style={{ maxWidth: 620, margin: "2px auto 0", textAlign: "center", fontSize: 12, color: "var(--subtle)" }}
            >
              <Def def="Buckets are minutes between the verified arrival and the planned start; arriving early counts as on-time.">
                minutes vs planned start
              </Def>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, fontSize: 12.5, color: "var(--muted)" }}>
              <span style={{ flex: "none" }}>Coverage</span>
              <span style={{ flex: 1, height: 6, borderRadius: 4, background: "#f1f2f6", overflow: "hidden" }}>
                <span style={{ display: "block", width: `${Math.min(coveragePct, 100)}%`, height: "100%", background: GREY }} />
              </span>
              <b className="tnum" style={{ flex: "none" }}>
                {facts.verifiedVisits} of {facts.scheduledVisits} verified
              </b>
            </div>
            <Fnote>{punctualityFnote(payload.punctuality, facts)}</Fnote>
          </>
        ) : (
          <StateEmpty>
            No verified arrivals in {facts.monthLong} — punctuality has no coverage
            {facts.scheduledVisits > 0 ? ` across ${facts.scheduledVisits} scheduled visits` : ""}.
          </StateEmpty>
        )}
      </CardBody>
    </Card>
  );
}

/** Mockup grammar: the footnote never restates the band's on-time value —
 *  it carries the uncovered-visits floor and the heavier late band only. */
export function punctualityFnote(punctuality: TechnicianPunctualityDistribution, facts: TechnicianTeamFacts): string {
  if (facts.otPct === null) return `No verified arrivals in ${facts.monthLong}.`;
  const floor = facts.otFloorPct !== null ? ` (${pctInt(facts.otFloorPct)} if every uncovered visit were late)` : "";
  const tail =
    punctuality.lateOver30 > punctuality.late16To30
      ? ` — the ${punctuality.lateOver30}-visit 30+ tail outweighs the 16–30 band`
      : punctuality.late16To30 > punctuality.lateOver30
        ? ` — the ${punctuality.late16To30}-visit 16–30 band outweighs the 30+ tail`
        : "";
  return `On-time counts verified visits only${floor}${tail}.`;
}

/** Ranked per-technician on-time list — real data from technicians[].onTimeRate, lowest first. */
function PunctualityDrawerBody({ payload, facts }: { payload: TechnicianPerformanceReadModel; facts: TechnicianTeamFacts }) {
  const ranked = payload.technicians
    .filter((tech) => tech.arrivalCoveredVisits > 0 && tech.onTimeRate !== null)
    .sort((a, b) => (a.onTimeRate ?? 0) - (b.onTimeRate ?? 0));
  const uncovered = payload.technicians.filter((tech) => tech.arrivalCoveredVisits === 0 || tech.onTimeRate === null);
  if (ranked.length === 0) {
    return <DNote>No verified arrivals in {facts.monthLong} — no per-technician punctuality yet.</DNote>;
  }
  return (
    <div data-viz="">
      {ranked.map((tech) => (
        <DNote
          key={tech.employeeId}
          style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid var(--hair-2)" }}
        >
          <span style={{ minWidth: 0 }}>{tech.displayName}</span>
          <b className="tnum" style={{ flex: "none", color: "var(--ink)" }}>
            {pctInt(tech.onTimeRate ?? 0)} · {tech.onTimeVisits} of {tech.arrivalCoveredVisits}
          </b>
        </DNote>
      ))}
      {uncovered.length > 0 ? (
        <Fnote>
          {listJoin(uncovered.map((tech) => tech.displayName))} {uncovered.length === 1 ? "has" : "have"} no verified visits in{" "}
          {facts.monthLong} — no rate is shown, never 0% or 100%.
        </Fnote>
      ) : null}
      <Fnote>
        Rates are the on-time share of verified visits only — team coverage is {facts.verifiedVisits} of {facts.scheduledVisits}{" "}
        {facts.monthLong} visits.
      </Fnote>
    </div>
  );
}

/* ── Row 4: Scorecard ──────────────────────────────────── */

const FOOT_TD: CSSProperties = {
  fontWeight: 700,
  color: "var(--ink)",
  padding: "13px 20px",
  borderTop: "1px solid var(--hair)",
  background: "linear-gradient(#fbfcfe,#f7f9fc)",
};

function ScorecardCard({
  rows,
  facts,
  rosterApplied,
  onOpen,
}: {
  rows: TechnicianScoreRow[];
  facts: TechnicianTeamFacts;
  rosterApplied: boolean;
  onOpen: (row: TechnicianScoreRow) => void;
}) {
  const [sortKey, setSortKey] = useState<ScoreSortKey>("job");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const sorted = useMemo(() => sortScoreRows(rows, sortKey, sortDir), [rows, sortKey, sortDir]);
  const EFF_DEF = effDef(facts);
  const OT_DEF = otDef(facts);
  const unbColDef = `All recorded hours minus job-assigned hours — travel, holiday, lunch and the other recorded activity types. The team total is ${fmt.hrs(facts.unb)} this ${facts.monthLong}.`;

  const onSort = (key: ScoreSortKey) => {
    if (sortKey === key) setSortDir((dir) => (dir === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(-1);
    }
  };
  const th = (key: ScoreSortKey, extra: string, children: ReactNode) => (
    <th
      className={["num", extra, "sortable", sortKey === key ? "sorted" : "", sortKey === key && sortDir === 1 ? "asc" : ""]
        .filter(Boolean)
        .join(" ")}
      data-sort={key}
      onClick={() => onSort(key)}
      aria-sort={sortKey === key ? (sortDir === 1 ? "ascending" : "descending") : undefined}
    >
      {children}
    </th>
  );

  return (
    <Card
      className="span12"
      title="Technician Scorecard"
      subtitle="The month in one table — hours, utilization, efficiency, punctuality · click a technician for the full drilldown"
      footer={
        <>
          <span>
            {rosterApplied
              ? `Roster: ${facts.rosterCount} people with recorded work · sorted by job hours (descending) — click a column to re-sort`
              : `Roster gate unavailable — showing every mapped technician · sorted by job hours (descending) — click a column to re-sort`}
          </span>
          <span />
        </>
      }
    >
      <div className="tblwrap">
        <table>
          <thead id="scoreHead">
            <tr>
              <th>Technician</th>
              {th("job", "", "Job Hrs")}
              {th("unb", "", <Def def={unbColDef}>Unbilled</Def>)}
              {th(
                "util",
                "",
                <>
                  <span className="abbr-sm">Utilization</span>
                  <span className="show-sm">Util.</span>
                </>,
              )}
              {th(
                "effQ",
                "",
                <>
                  <span className="abbr-sm">Quote Eff.</span>
                  <span className="show-sm">Eff.</span>
                </>,
              )}
              {th("ot", "hide-lg", "On-Time")}
            </tr>
          </thead>
          <tbody id="scoreRows">
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ color: "var(--muted)" }}>
                  No technicians on the effective roster for {facts.monthLong}.
                </td>
              </tr>
            ) : (
              sorted.map((row) => (
                <tr
                  key={row.employeeId}
                  className="rowlink"
                  data-tech={row.employeeId}
                  tabIndex={0}
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
                    <div className="id2 tnum">
                      {row.jobs}
                      {" "}jobs
                      {row.inactive ? <span style={{ whiteSpace: "nowrap" }}> · inactive</span> : null}
                    </div>
                  </td>
                  <td className="num tnum">{fmt.hrs(row.job)}</td>
                  <td className="num tnum">{fmt.hrs(row.unb)}</td>
                  <td className="num tnum">{row.util === null ? "—" : `${row.util.toFixed(0)}%`}</td>
                  <td className="num tnum">
                    {row.effQ === null ? (
                      "—"
                    ) : (
                      <span className="repr" data-def={EFF_DEF}>
                        {ratioX(row.effQ)}
                      </span>
                    )}
                  </td>
                  <td className="num tnum hide-lg">
                    {row.ot === null ? (
                      "—"
                    ) : (
                      <span className="repr" data-def={OT_DEF}>
                        {pctInt(row.ot)}
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {sorted.length > 0 ? (
            <tfoot id="scoreFoot">
              <tr>
                <td style={FOOT_TD}>Team · {facts.rosterCount} technicians</td>
                <td className="num tnum" style={FOOT_TD}>
                  {Math.round(facts.job)}h
                </td>
                <td className="num tnum" style={FOOT_TD}>
                  {Math.round(facts.unb)}h
                </td>
                <td className="num tnum" style={FOOT_TD}>
                  {facts.utilPct !== null ? pctInt(facts.utilPct) : "—"}
                </td>
                <td className="num tnum" style={FOOT_TD}>
                  {facts.teamEff !== null ? ratioX(facts.teamEff) : "—"}
                </td>
                <td className="num tnum hide-lg" style={FOOT_TD}>
                  {facts.otPct !== null ? (
                    <span className="repr" data-def={OT_DEF}>
                      {pctInt(facts.otPct)}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </Card>
  );
}

/* ── Drilldown ─────────────────────────────────────────── */

export function TechnicianDrill({
  row,
  facts,
  payload,
  onBack,
}: {
  row: TechnicianScoreRow;
  facts: TechnicianTeamFacts;
  payload: TechnicianPerformanceReadModel;
  onBack: () => void;
}) {
  const first = row.name.split(" ")[0];
  const EFF_DEF = effDef(facts);
  const OT_DEF = otDef(facts);
  const hired = hireLabel(row.dateOfHire);
  const buckets = activityBuckets(row.tech);
  const covered = useMemo(
    () =>
      payload.allocations.filter(
        (allocation) =>
          allocation.employeeId === row.employeeId &&
          allocation.jobSource === "quote_generated" &&
          allocation.laborEfficiencyCovered,
      ),
    [payload, row.employeeId],
  );

  return (
    <div className="card">
      <div className="hd">
        <div>
          <div className="ti">{row.name}</div>
          <div className="st">
            {hired ? `hired ${hired} · ` : ""}viewing {facts.monthLong} {facts.year}
            {row.archived ? " · archived — history kept" : ""}
          </div>
        </div>
        <button type="button" className="ctl" style={{ height: 34 }} onClick={onBack}>
          ← All technicians
        </button>
      </div>
      <CardBody>
        <KV four>
          <KVCell label="Job hours" value={fmt.hrs(row.job)} />
          <KVCell label="Unbilled" value={fmt.hrs(row.unb)} />
          <KVCell label="Recorded" value={fmt.hrs(row.rec)} />
          <KVCell label="Utilization" value={row.util === null ? "—" : `${row.util.toFixed(0)}%`} />
          <KVCell
            label="Quote eff."
            value={
              row.effQ === null ? (
                "—"
              ) : (
                <span className="repr" data-def={EFF_DEF}>
                  {ratioX(row.effQ)}
                </span>
              )
            }
          />
          <KVCell
            label="On-time"
            value={
              row.ot === null ? (
                "—"
              ) : (
                <span className="def" data-def={OT_DEF}>
                  {pctInt(row.ot)}
                </span>
              )
            }
          />
          <KVCell label={`${facts.monthLong} jobs`} value={String(row.jobs)} />
        </KV>
        <div style={{ marginTop: 20 }}>
          <DSec>{facts.monthLong} unbilled activity — per recorded type</DSec>
        </div>
        {buckets.length > 0 ? (
          <div style={{ maxWidth: 460 }}>
            {buckets.map((bucket) => (
              <DNote
                key={bucket.label}
                style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "4px 0", borderBottom: "1px solid var(--hair-2)" }}
              >
                <span>{bucket.label}</span>
                <b className="tnum" style={{ color: "var(--ink)" }}>
                  {fmt.hrs(bucket.hours)}
                </b>
              </DNote>
            ))}
            <DNote style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "4px 0" }}>
              <span>Total unbilled</span>
              <b className="tnum" style={{ color: "var(--ink)" }}>
                {fmt.hrs(row.unb)}
              </b>
            </DNote>
          </div>
        ) : (
          <DNote>No unbilled activity recorded in {facts.monthLong}.</DNote>
        )}
        <div style={{ marginTop: 20 }}>
          <DSec>{facts.monthLong} efficiency — quote-linked jobs</DSec>
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th className="num">Estimated</th>
                <th className="num">Actual</th>
                <th className="num hide-sm">Result</th>
              </tr>
            </thead>
            <tbody>
              {covered.length === 0 ? (
                <tr>
                  <td className="id1" style={{ fontWeight: 500 }}>
                    No covered quote-linked jobs in {facts.monthLong}
                  </td>
                  <td className="num tnum">—</td>
                  <td className="num tnum">—</td>
                  <td className="num hide-sm" />
                </tr>
              ) : (
                covered.map((allocation) => <DrillJobRow key={`${allocation.jobId}-${allocation.employeeId}`} allocation={allocation} />)
              )}
              {row.effQ !== null ? (
                <tr>
                  <td colSpan={4} style={{ border: 0, paddingTop: 10, color: "var(--subtle)", fontSize: 13 }}>
                    {first}’s{" "}
                    <span data-def={EFF_DEF}>
                      {ratioX(row.effQ)} uses the hour-share allocation
                    </span>
                    {facts.teamEff !== null
                      ? `; the team ratio is ${ratioX(facts.teamEff)} across ${facts.effCoveredJobs} covered jobs.`
                      : "."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <DSec>Completed-job economics — separate cohort</DSec>
        <DNote>
          {row.sell > 0 ? (
            <>
              Jobs completed in {facts.monthLong} that {first} worked on carry <b className="tnum">{fmt.moneyFull(row.sell)}</b>{" "}
              allocated revenue and{" "}
              {row.np !== null ? (
                <>
                  <b className="tnum">{fmt.moneyFull(row.np)}</b> allocated net profit
                </>
              ) : (
                <>no covered net profit</>
              )}{" "}
              (hours-share allocation from recorded job time). This cohort includes hours recorded before{" "}
              {facts.monthLong} on jobs that finished in {facts.monthLong}
              {row.outsidePeriodHours !== null && row.outsidePeriodHours > 0
                ? ` — ${fmt.hrs(row.outsidePeriodHours)} of ${first}’s allocation basis`
                : ""}{" "}
              — it is contribution context, not {facts.monthLong} earnings.
            </>
          ) : (
            <>
              No jobs completed in {facts.monthLong} carry {first}’s hours — no allocation this month.
            </>
          )}
        </DNote>
      </CardBody>
    </div>
  );
}

function DrillJobRow({ allocation }: { allocation: TechnicianJobAllocationDetail }) {
  const est = allocation.allocatedQuotedHours;
  const act = allocation.actualHours;
  const result = est !== null && act > 0 ? est / act : null;
  return (
    <tr>
      <td className="id1" style={{ fontWeight: 500 }}>
        {allocation.jobNo ?? allocation.jobId}
        {allocation.jobName ? ` · ${allocation.jobName}` : ""}
      </td>
      <td className="num tnum">{est !== null ? fmt.hrs(est) : "—"}</td>
      <td className="num tnum">{act > 0 ? fmt.hrs(act) : "—"}</td>
      <td className="num hide-sm">
        {result !== null ? <span className={`mom ${result >= 1 ? "up" : "dn"}`}>{ratioX(result)}</span> : null}
      </td>
    </tr>
  );
}

/* ── Row 5: Completed-Job Economics ────────────────────── */

function EconomicsCard({
  payload,
  rows,
  archivedRows,
  facts,
}: {
  payload: TechnicianPerformanceReadModel;
  rows: TechnicianScoreRow[];
  archivedRows: TechnicianScoreRow[];
  facts: TechnicianTeamFacts;
}) {
  const ranked = useMemo(
    () =>
      rows
        .filter((row) => row.sell > 0)
        .sort((a, b) => (b.np ?? Number.NEGATIVE_INFINITY) - (a.np ?? Number.NEGATIVE_INFINITY)),
    [rows],
  );
  const maxNp = Math.max(0, ...ranked.map((row) => row.np ?? 0));
  const teamNp = ranked.reduce((sum, row) => sum + (row.np ?? 0), 0);
  const outsideTotal = payload.coverage.outsideRosterAllocatedSellValue;
  const outsideNames = payload.outsideRoster.map((entry) => `${entry.displayName} (${fmt.money(entry.allocatedSellValue)})`);
  const archivedWithSell = archivedRows.filter((row) => row.sell > 0);
  const noAllocation = rows.filter((row) => row.sell <= 0);
  return (
    <Card
      className="span12"
      title="Completed-Job Economics"
      subtitle={`Ranked by allocated net profit · ${facts.monthLong}-completed jobs, including pre-${facts.monthLong} hours on those jobs · hatched = hours-share allocation · hover or tap a row`}
      aside={
        <Legend
          style={{ padding: 0 }}
          items={[
            { label: "Net profit", color: ACC, swatchClassName: "hatch", swatchStyle: { width: 12, height: 12, borderRadius: 4 } },
          ]}
        />
      }
    >
      <CardBody>
        {ranked.length > 0 ? (
          <div data-viz="">
            {ranked.map((row) => (
              <div
                key={row.employeeId}
                className="erow"
                onPointerEnter={(event) =>
                  tipShow(
                    tipTitle(row.name) +
                      tipRow(GREY, "Revenue", fmt.moneyFull(row.sell)) +
                      tipRow(ACC, "Net profit", row.np !== null ? fmt.moneyFull(row.np) : "—"),
                    event.clientX,
                    event.clientY,
                  )
                }
                onPointerLeave={tipHide}
              >
                <span className="ename">{row.name}</span>
                <div className="ebar">
                  {row.np !== null && row.np > 0 && maxNp > 0 ? (
                    <div
                      className="hatch"
                      style={{
                        width: `${(row.np / maxNp) * 100}%`,
                        height: "100%",
                        backgroundColor: ACC,
                        borderRadius: 5,
                      }}
                    />
                  ) : null}
                </div>
                <span className="eval tnum">
                  {row.np !== null ? (
                    <>
                      <b style={{ color: "var(--ink)" }}>{fmt.money(row.np)}</b> net ·{" "}
                      <b style={{ color: "var(--ink)" }}>{teamNp > 0 ? `${Math.round(((row.np ?? 0) / teamNp) * 100)}%` : "—"}</b> of
                      team net
                    </>
                  ) : (
                    <>net profit uncovered</>
                  )}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <StateEmpty>No completed-job allocation for the roster in {facts.monthLong}.</StateEmpty>
        )}
        <Fnote>
          Allocation is an{" "}
          <span data-def="Each completed job’s value is split by each technician’s recorded share of job time; totals equal the job total.">
            hours-share split
          </span>
          {outsideTotal > 0 ? (
            <>
              {" "}
              · {fmt.money(outsideTotal)} sits outside the {facts.rosterCount}-tech roster —{" "}
              {listJoin(outsideNames)} {payload.outsideRoster.length === 1 ? "is" : "are"} not on the recorded-work roster
            </>
          ) : null}
          {archivedWithSell.length > 0 ? (
            <>
              {" "}
              · {listJoin(archivedWithSell.map((row) => `${row.name} (${fmt.money(row.sell)})`))}{" "}
              {archivedWithSell.length === 1 ? "is" : "are"} archived — history kept, not ranked
            </>
          ) : null}
          {noAllocation.length > 0 ? (
            <>
              {" "}
              · {listJoin(noAllocation.map((row) => row.name))} {noAllocation.length === 1 ? "has" : "have"} no {facts.monthLong}{" "}
              allocation
            </>
          ) : null}
          .
        </Fnote>
      </CardBody>
    </Card>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DevBars, fmt, Histogram, HStack, tipHide, tipRow, tipShow, tipTitle, type HistogramBucket, type HStackRow } from "@/components/charts";
import {
  Card,
  CardBody,
  Chipd,
  Def,
  DefTooltipProvider,
  DNote,
  DSec,
  Flag,
  Flags,
  Fnote,
  Focal,
  FocalCov,
  FocalLabel,
  FocalMeta,
  FocalValue,
  Hero,
  KV,
  KVCell,
  Legend,
  Meter,
  Mgn,
  Seg,
  Skel,
  StateEmpty,
  StateError,
  StateMini,
  StatesStrip,
} from "@/components/reset";
import type {
  TechnicianJobAllocationDetail,
  TechnicianPerformance,
  TechnicianPerformanceReadModel,
  TechnicianPunctualityDistribution,
} from "@/lib/metrics/technicians";
import type { DashboardReadModel } from "@/lib/store/dashboard-read-models";

/* /technicians — implements the approved
   redesign-handoff/product-reset/APPROVED-2026-07-15/mockups/technicians.html
   exactly, with every figure taken from the technician read-model payload
   (the mockup's numbers were June-2026 snapshots). Provenance grammar:
   solid = verified, .repr dotted amber = representative, hatched = interim
   allocation. Honest empty/error states throughout. */

const ACC = "#5b63d3";
const GREY = "#8a92a4";
const CAP_TICK = "#1c2230";
const AMBER = "#b4791a";
const INACTIVE_GREY = "#6b7383";
const POS = "#1a8a5a";
const NEG = "#d0463a";
const HERO_JOB = "#8087ec";
const HERO_TARGET = "#e6c07a";
/** Example utilization target shown on the hero bar — explicitly labeled "(example)". */
const EXAMPLE_TARGET_PCT = 65;
/** Mockup inactive rule: recorded below 20% of monthly capacity. */
const INACTIVE_SHARE = 0.2;
const OVER_CAPACITY_SHARE = 1.15;

/* ── Payload guard ─────────────────────────────────────── */

/** Accepts only the detailed technician contract (exact net-profit basis +
 *  the new roster/outside-roster disclosure fields). Anything else renders
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
  /** Gross monthly capacity hours (hire/archive gated). */
  cap: number;
  inactive: boolean;
  /** Productive utilization %, job ÷ recorded (null when inactive/no basis). */
  util: number | null;
  /** Capacity use %, recorded ÷ capacity (null when inactive/no basis). */
  capUse: number | null;
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
  const cap = tech.grossCapacityHours;
  const inactive = cap > 0 ? rec < cap * INACTIVE_SHARE : rec <= 0;
  const qg = tech.laborEfficiency.quoteGenerated;
  const rc = tech.laborEfficiency.recurring;
  return {
    employeeId: tech.employeeId,
    name: tech.displayName,
    jobs: tech.coverage.allocatedJobs,
    job,
    rec,
    unb: Math.max(rec - job, 0),
    cap,
    inactive,
    util: !inactive && rec > 0 ? (job / rec) * 100 : null,
    capUse: !inactive && cap > 0 ? (rec / cap) * 100 : null,
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

/** Archived field-position people kept for history (zero capacity). */
export function archivedTechnicianRows(payload: TechnicianPerformanceReadModel): TechnicianScoreRow[] {
  return payload.technicians.filter((tech) => tech.archived).map(toScoreRow);
}

export const SCORE_SORT_KEYS = ["job", "unb", "util", "cap", "effQ", "ot"] as const;
export type ScoreSortKey = (typeof SCORE_SORT_KEYS)[number];

export function scoreSortValue(row: TechnicianScoreRow, key: ScoreSortKey): number | null {
  if (key === "util") return row.inactive ? null : row.rec > 0 ? row.job / row.rec : null;
  if (key === "cap") return row.inactive ? null : row.cap > 0 ? row.rec / row.cap : null;
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

export type TechnicianExceptionFlag =
  | { kind: "over_capacity"; tone: "warn"; name: string; recordedHours: number; capacityHours: number; overHours: number }
  | { kind: "low_hours"; tone: "down"; name: string; recordedHours: number }
  | { kind: "archived_with_work"; tone: "info"; name: string; allocatedJobs: number; recordedHours: number };

/** Data-driven exception flags — derived from the payload, never hardcoded:
 *  the top over-capacity technician, the lowest-hours (inactive-rule) roster
 *  member, and every archived person with in-month work. */
export function deriveExceptionFlags(
  rows: TechnicianScoreRow[],
  archivedRows: TechnicianScoreRow[],
): TechnicianExceptionFlag[] {
  const flags: TechnicianExceptionFlag[] = [];
  const over = rows
    .filter((row) => row.cap > 0 && row.rec > row.cap)
    .sort((a, b) => (b.rec - b.cap) - (a.rec - a.cap))[0];
  if (over) {
    flags.push({
      kind: "over_capacity",
      tone: "warn",
      name: over.name,
      recordedHours: over.rec,
      capacityHours: over.cap,
      overHours: over.rec - over.cap,
    });
  }
  const low = rows
    .filter((row) => row.inactive && row.cap > 0)
    .sort((a, b) => a.rec - b.rec)[0];
  if (low) {
    flags.push({ kind: "low_hours", tone: "down", name: low.name, recordedHours: low.rec });
  }
  for (const archived of archivedRows) {
    if (archived.jobs > 0 || archived.rec > 0) {
      flags.push({
        kind: "archived_with_work",
        tone: "info",
        name: archived.name,
        allocatedJobs: archived.jobs,
        recordedHours: archived.rec,
      });
    }
  }
  return flags;
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
  cap: number;
  workdays: number;
  /** True when Σ capacity equals workdays × 8 × roster (flat-rule prose applies). */
  flatCapacityRule: boolean;
  utilPct: number | null;
  capPct: number | null;
  over115Count: number;
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

export function deriveTeamFacts(payload: TechnicianPerformanceReadModel, rows: TechnicianScoreRow[]): TechnicianTeamFacts {
  const job = rows.reduce((sum, row) => sum + row.job, 0);
  const rec = rows.reduce((sum, row) => sum + row.rec, 0);
  const cap = rows.reduce((sum, row) => sum + row.cap, 0);
  const workdays = rows.reduce((max, row) => Math.max(max, row.tech.eligibleWorkdays), 0);
  const coverage = payload.coverage;
  const teamEffEstHours = coverage.quoteGeneratedAllocatedQuotedHours;
  const teamEffActHours = coverage.quoteGeneratedActualHours;
  const rosterTechs = payload.technicians;
  const scheduledVisits = rosterTechs.reduce((sum, tech) => sum + tech.scheduledVisits, 0);
  const verifiedVisits = rosterTechs.reduce((sum, tech) => sum + tech.arrivalCoveredVisits, 0);
  const onTimeVisits = rosterTechs.reduce((sum, tech) => sum + tech.onTimeVisits, 0);
  return {
    monthLong: monthLongName(payload.periodStart),
    year: periodYear(payload.periodStart),
    rosterCount: rows.length,
    job,
    rec,
    unb: Math.max(rec - job, 0),
    cap,
    workdays,
    flatCapacityRule: cap > 0 && Math.abs(cap - workdays * 8 * rows.length) < 0.001,
    utilPct: rec > 0 ? (job / rec) * 100 : null,
    capPct: cap > 0 ? (rec / cap) * 100 : null,
    over115Count: rows.filter((row) => row.capUse !== null && row.capUse > OVER_CAPACITY_SHARE * 100).length,
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

function effDef(facts: TechnicianTeamFacts): string {
  const verified = facts.teamEff !== null
    ? ` The ${ratioX(facts.teamEff)} team ratio (${fmt.hrs(facts.teamEffEstHours)} ÷ ${fmt.hrs(facts.teamEffActHours)}) is verified.`
    : "";
  return `Per-technician split is representative until timesheet attribution is re-verified.${verified}`;
}

function otDef(facts: TechnicianTeamFacts): string {
  return `Representative until mobile-arrival matching is re-verified — team coverage is ${facts.verifiedVisits} of ${facts.scheduledVisits} ${facts.monthLong} visits.`;
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
        <TechniciansContent payload={payload} initialDrillEmployeeId={initialDrillEmployeeId} />
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
          <StateEmpty>Archived on the 14th → capacity accrues through the 13th only; history stays.</StateEmpty>
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
  initialDrillEmployeeId,
}: {
  payload: TechnicianPerformanceReadModel;
  initialDrillEmployeeId?: string;
}) {
  const rows = useMemo(() => technicianScoreRows(payload), [payload]);
  const archivedRows = useMemo(() => archivedTechnicianRows(payload), [payload]);
  const facts = useMemo(() => deriveTeamFacts(payload, rows), [payload, rows]);
  const flags = useMemo(() => deriveExceptionFlags(rows, archivedRows), [rows, archivedRows]);
  const [drillId, setDrillId] = useState<string | null>(initialDrillEmployeeId ?? null);
  const drillRow = drillId !== null
    ? rows.find((row) => row.employeeId === drillId) ?? archivedRows.find((row) => row.employeeId === drillId) ?? null
    : null;

  return (
    <>
      <TechniciansHero facts={facts} />
      {flags.length > 0 ? (
        <Flags>
          {flags.map((flag) => (
            <Flag key={`${flag.kind}-${flag.name}`} tone={flag.tone}>
              <FlagBody flag={flag} monthLong={facts.monthLong} />
            </Flag>
          ))}
        </Flags>
      ) : null}
      {drillRow ? (
        <TechnicianDrill row={drillRow} facts={facts} payload={payload} onBack={() => setDrillId(null)} />
      ) : (
        <>
          <CapacityCard rows={rows} />
          <div className="g75">
            <EfficiencyCard rows={rows} facts={facts} />
            <PunctualityCard payload={payload} facts={facts} />
          </div>
          <ScorecardCard rows={rows} facts={facts} rosterApplied={payload.rosterApplied} onOpen={(row) => setDrillId(row.employeeId)} />
        </>
      )}
      <EconomicsCard payload={payload} rows={rows} archivedRows={archivedRows} facts={facts} />
    </>
  );
}

/* ── Hero ──────────────────────────────────────────────── */

function TechniciansHero({ facts }: { facts: TechnicianTeamFacts }) {
  const { monthLong } = facts;
  const scale = Math.max(facts.rec, facts.cap);
  const jobW = scale > 0 ? (facts.job / scale) * 100 : 0;
  const unbW = scale > 0 ? (facts.unb / scale) * 100 : 0;
  const capLeft = scale > 0 && facts.cap > 0 ? (facts.cap / scale) * 100 : null;
  const targetLeft = scale > 0 && facts.rec > 0 ? (EXAMPLE_TARGET_PCT / 100) * (facts.rec / scale) * 100 : null;
  const overHours = facts.rec - facts.cap;
  const capacityRule = facts.flatCapacityRule
    ? `capacity 8h/day (Mon–Fri 8:30–5:00, 30-min lunch) = ${fmt.hrs(facts.cap)}`
    : `capacity 8h per eligible workday, prorated for hire dates = ${fmt.hrs(facts.cap)}`;
  const unbilledDef = `All recorded hours minus job-assigned hours — travel, shop, training and unassigned time.${
    facts.rec > 0 && facts.unb / facts.rec >= 0.3
      ? ` At ${((facts.unb / facts.rec) * 100).toFixed(1)}% of recorded time, this is the team’s biggest leak.`
      : ""
  }`;
  const capacityDef = facts.flatCapacityRule
    ? `All recorded hours ÷ available capacity. Capacity = ${facts.workdays} workdays × 8 productive hours × ${facts.rosterCount} technicians = ${fmt.hrs(facts.cap)}.`
    : `All recorded hours ÷ available capacity. Capacity totals ${fmt.hrs(facts.cap)} across ${facts.rosterCount} technicians — 8h per eligible workday, prorated for hire dates.`;
  const effStatDef = `Σ estimated ÷ Σ actual hours on quote-linked ${monthLong} jobs where both are present: ${fmt.hrs(facts.teamEffEstHours)} ÷ ${fmt.hrs(facts.teamEffActHours)}. Above 1.00× beats the estimate${
    facts.effMissingEstimate > 0 ? `; ${facts.effMissingEstimate} more jobs have actuals but no estimate` : ""
  }.`;
  const onTimeDef =
    "Arrival within 15 minutes of planned start — early arrivals count on-time — over visits with a verified mobile arrival event; missing events are uncovered, never counted late.";

  return (
    <Hero>
      <Focal style={{ paddingBottom: 24 }}>
        <FocalLabel>
          <Def def={`Job-assigned timesheet hours ÷ all recorded hours, using timesheets dated in ${monthLong}, across the ${facts.rosterCount}-person recorded-work roster only.`}>
            Productive Utilization
          </Def>
          {" · "}
          {monthLong}
        </FocalLabel>
        <FocalValue>{facts.utilPct !== null ? pctInt(facts.utilPct) : "—"}</FocalValue>
        <FocalMeta>
          <Mgn>
            {fmt.hrs(facts.job)} on jobs of {fmt.hrs(facts.rec)} recorded
          </Mgn>
          {facts.capPct !== null ? (
            overHours > 0 ? (
              <Chipd
                tone="neutral"
                style={{ background: "rgba(230,192,122,.15)", color: HERO_TARGET, borderColor: "rgba(230,192,122,.35)" }}
              >
                {pctInt(facts.capPct)} of capacity · {fmt.hrs(overHours)} over
              </Chipd>
            ) : (
              <Chipd tone="neutral">{pctInt(facts.capPct)} of capacity</Chipd>
            )
          ) : null}
        </FocalMeta>
        <FocalCov>
          {facts.rosterCount} technicians · {facts.workdays} workdays · {capacityRule}
        </FocalCov>
        <FocalCov>No prior-period comparison yet — timesheet history verification is pending.</FocalCov>
        <div style={{ marginTop: "auto", paddingTop: 20 }}>
          <div style={{ position: "relative", height: 14, borderRadius: 7, background: "rgba(255,255,255,.08)" }}>
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                width: `${jobW}%`,
                background: HERO_JOB,
                borderRadius: "7px 0 0 7px",
              }}
            />
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${jobW}%`,
                width: `${unbW}%`,
                background: "rgba(255,255,255,.3)",
                borderRadius: "0 7px 7px 0",
              }}
            />
            {capLeft !== null ? (
              <div
                style={{
                  position: "absolute",
                  top: -3,
                  bottom: -3,
                  left: `${Math.min(capLeft, 100)}%`,
                  width: 2,
                  background: "rgba(255,255,255,.9)",
                  borderRadius: 1,
                }}
                title={`Capacity ${fmt.hrs(facts.cap)}`}
              />
            ) : null}
            {targetLeft !== null ? (
              <div
                style={{
                  position: "absolute",
                  top: -3,
                  bottom: -3,
                  left: `${Math.min(targetLeft, 100)}%`,
                  width: 2,
                  background: HERO_TARGET,
                  borderRadius: 1,
                }}
                title="Utilization target (example)"
              />
            ) : null}
          </div>
          <div className="herolegend">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <i style={{ width: 9, height: 9, borderRadius: 3, background: HERO_JOB, display: "inline-block" }} />
              Job-assigned · {fmt.hrs(facts.job)}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <i style={{ width: 9, height: 9, borderRadius: 3, background: "rgba(255,255,255,.3)", display: "inline-block" }} />
              Unbilled · {fmt.hrs(facts.unb)}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <i style={{ width: 2, height: 10, borderRadius: 1, background: "rgba(255,255,255,.9)", display: "inline-block" }} />
              Capacity · {fmt.hrs(facts.cap)}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <i style={{ width: 2, height: 10, borderRadius: 1, background: HERO_TARGET, display: "inline-block" }} />
              Target {EXAMPLE_TARGET_PCT}% (example)
            </span>
          </div>
        </div>
      </Focal>
      <div className="stats">
        <div className="stat">
          <div className="l">
            <Def def={unbilledDef}>Unbilled Hours</Def>
          </div>
          <div className="v tnum">{fmt.hrs(facts.unb)}</div>
          <div className="r">
            <span className="dl tnum">
              <span className="c">{facts.rec > 0 ? `${((facts.unb / facts.rec) * 100).toFixed(1)}% of recorded` : "no recorded basis"}</span>
            </span>
          </div>
        </div>
        <div className="stat">
          <div className="l">
            <Def def={capacityDef}>Capacity Used</Def>
          </div>
          <div className="v tnum">{facts.capPct !== null ? pctInt(facts.capPct) : "—"}</div>
          <div className="r">
            {facts.over115Count > 0 ? (
              <span className="dl tnum" style={{ color: AMBER }}>
                {facts.over115Count} {facts.over115Count === 1 ? "tech" : "techs"} <span className="c">above 115%</span>
              </span>
            ) : (
              <span className="dl tnum">
                <span className="c">none above 115%</span>
              </span>
            )}
          </div>
        </div>
        <div className="stat">
          <div className="l">
            <Def def={effStatDef}>Quote Labor Efficiency</Def>
          </div>
          <div className="v tnum">{facts.teamEff !== null ? ratioX(facts.teamEff) : "—"}</div>
          <div className="r">
            <span className="dl tnum">
              <span className="c">
                team · {facts.effCoveredJobs} of {facts.effTotalJobs} quote-linked jobs
              </span>
            </span>
          </div>
        </div>
        <div className="stat">
          <div className="l">
            <Def def={onTimeDef}>On-Time Arrival</Def>
          </div>
          <div className="v tnum">
            {facts.otPct !== null ? (
              <span className="repr" data-def={otDef(facts)}>
                {pctInt(facts.otPct)}
              </span>
            ) : (
              "—"
            )}
          </div>
          <div className="r">
            <span className="dl tnum">
              <span className="c">
                {facts.verifiedVisits > 0 ? `${facts.onTimeVisits} of ${facts.verifiedVisits} verified visits` : "no verified visits"}
              </span>
            </span>
          </div>
        </div>
      </div>
    </Hero>
  );
}

/* ── Exception flags ───────────────────────────────────── */

function FlagBody({ flag, monthLong }: { flag: TechnicianExceptionFlag; monthLong: string }) {
  if (flag.kind === "over_capacity") {
    return (
      <>
        <b>{flag.name}</b> recorded {fmt.hrs(flag.recordedHours)} vs {fmt.hrs(flag.capacityHours)} capacity —{" "}
        <b>+{fmt.hrs(flag.overHours)} over</b>
      </>
    );
  }
  if (flag.kind === "low_hours") {
    return (
      <>
        <b>{flag.name}</b> is an active technician with <b>{fmt.hrs(flag.recordedHours)}</b> recorded in {monthLong}
      </>
    );
  }
  return (
    <>
      <b>{flag.name}</b> is archived but worked{" "}
      {flag.allocatedJobs > 0
        ? `${flag.allocatedJobs} ${monthLong} ${flag.allocatedJobs === 1 ? "job" : "jobs"}`
        : `${fmt.hrs(flag.recordedHours)} in ${monthLong}`}{" "}
      — history kept, no current capacity
    </>
  );
}

/* ── Scorecard ─────────────────────────────────────────── */

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
  const unbColDef = `All recorded hours minus job-assigned hours — travel, shop, training and unassigned time. The team total is ${fmt.hrs(facts.unb)} this ${facts.monthLong}.`;

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
              {th("cap", "hide-sm", "Capacity Use")}
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
                <td colSpan={7} style={{ color: "var(--muted)" }}>
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
                      {" "}jobs
                      {row.inactive ? <span style={{ whiteSpace: "nowrap" }}> · inactive</span> : null}
                    </div>
                  </td>
                  <td className="num tnum">{fmt.hrs(row.job)}</td>
                  <td className="num tnum">{fmt.hrs(row.unb)}</td>
                  <td className="num">
                    {row.util === null ? (
                      <b className="tnum">—</b>
                    ) : (
                      <Meter pct={Math.min(row.util, 100)} style={{ justifyContent: "flex-end" }}>
                        {row.util.toFixed(0)}%
                      </Meter>
                    )}
                  </td>
                  <td
                    className="num tnum hide-sm"
                    style={row.capUse !== null && row.capUse > 115 ? { color: AMBER, fontWeight: 700 } : undefined}
                  >
                    {row.capUse === null ? "—" : `${row.capUse.toFixed(0)}%`}
                  </td>
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
                <td className="num tnum hide-sm" style={FOOT_TD}>
                  {facts.capPct !== null ? pctInt(facts.capPct) : "—"}
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
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [row.employeeId]);
  const first = row.name.split(" ")[0];
  const EFF_DEF = effDef(facts);
  const OT_DEF = otDef(facts);
  const hired = hireLabel(row.dateOfHire);
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
    <div ref={cardRef} className="card">
      <div className="hd">
        <div>
          <div className="ti">{row.name}</div>
          <div className="st">
            {hired ? `hired ${hired} · ` : ""}viewing {facts.monthLong} {facts.year}
            {row.archived ? " · archived — history kept, no current capacity" : ""}
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
          <KVCell label="Capacity use" value={row.capUse === null ? "—" : `${row.capUse.toFixed(0)}%`} />
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
                <span className="repr" data-def={OT_DEF}>
                  {pctInt(row.ot)}
                </span>
              )
            }
          />
          <KVCell label={`${facts.monthLong} jobs`} value={String(row.jobs)} />
        </KV>
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
                    <span className="repr" data-def={EFF_DEF}>
                      {ratioX(row.effQ)} is representative
                    </span>
                    {facts.teamEff !== null
                      ? `; the verified team ratio is ${ratioX(facts.teamEff)} across ${facts.effCoveredJobs} covered jobs.`
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
              (interim hours-share split until timesheet attribution is re-verified). This cohort includes hours recorded before{" "}
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

/* ── Recorded Time vs Capacity ─────────────────────────── */

function capacityTickHours(rows: TechnicianScoreRow[]): number {
  const counts = new Map<number, number>();
  for (const row of rows) {
    if (row.cap > 0) counts.set(row.cap, (counts.get(row.cap) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [cap, count] of counts) {
    if (count > bestCount || (count === bestCount && cap > best)) {
      best = cap;
      bestCount = count;
    }
  }
  return best;
}

function CapacityCard({ rows }: { rows: TechnicianScoreRow[] }) {
  const sorted = useMemo(() => [...rows].sort((a, b) => b.job - a.job), [rows]);
  const tick = capacityTickHours(rows);
  const hRows: HStackRow[] = sorted.map((row) => {
    const capPct = row.cap > 0 ? Math.round((row.rec / row.cap) * 100) : null;
    const jobShare = row.rec > 0 ? Math.round((row.job / row.rec) * 100) : null;
    return {
      name: row.name,
      segs: [
        { v: row.job, color: ACC },
        { v: row.unb, color: GREY },
      ],
      cap: row.cap > 0 ? row.cap : undefined,
      over: false,
      noteColor: row.inactive ? INACTIVE_GREY : capPct !== null && capPct > OVER_CAPACITY_SHARE * 100 ? AMBER : undefined,
      note: row.inactive
        ? `inactive · ${fmt.hrs(row.rec)}`
        : capPct !== null && jobShare !== null
          ? `${capPct}% · ${jobShare}% jobs`
          : `${fmt.hrs(row.rec)} recorded`,
      noteShort: row.inactive ? "inactive" : capPct !== null ? `${capPct}%` : fmt.hrs(row.rec),
      tip:
        `<div style="display:flex;flex-direction:column;gap:3px">` +
        [
          ["Job-assigned", fmt.hrs(row.job), ACC],
          ["Unbilled", fmt.hrs(row.unb), GREY],
          ["Capacity", row.cap > 0 ? fmt.hrs(row.cap) : "—", CAP_TICK],
        ]
          .map(
            ([label, value, color]) =>
              `<div style="display:flex;align-items:center;gap:7px"><i style="width:8px;height:8px;border-radius:3px;background:${color}"></i><span style="color:#5c6474">${label}</span><b style="margin-left:auto;padding-left:16px">${value}</b></div>`,
          )
          .join("") +
        `</div>`,
    };
  });
  return (
    <Card
      title="Recorded Time vs Capacity"
      subtitle={`Sorted by job hours · dark tick = ${tick > 0 ? `${fmt.hrs(tick)} monthly capacity` : "monthly capacity"} · amber = above 115% · hover or tap any row`}
      aside={
        <Legend
          style={{ padding: 0 }}
          items={[
            { label: "Job-assigned", color: ACC },
            { label: "Unbilled", color: GREY },
            { label: "Capacity", color: CAP_TICK, swatchStyle: { height: 10, width: 2.5 } },
          ]}
        />
      }
    >
      <CardBody>
        {hRows.length > 0 ? (
          <HStack rows={hRows} labelW={132} rowH={40} noteW={162} />
        ) : (
          <StateEmpty>No roster technicians recorded time this month.</StateEmpty>
        )}
      </CardBody>
    </Card>
  );
}

/* ── Labor Efficiency ──────────────────────────────────── */

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
      title="Labor Efficiency"
      subtitle={
        <>
          Estimated ÷ actual hours — above 1.00× beats the estimate ·{" "}
          <span className="repr" data-def={EFF_DEF}>
            per-tech split representative
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
          <span style={{ color: POS }}>●</span> right of the line = beat the estimate{"  "}
          <span style={{ color: NEG }}>●</span> left = over · {facts.effCoveredJobs} covered jobs (team)
          {facts.teamEff !== null ? <> — the team’s {ratioX(facts.teamEff)} is verified, the per-tech split is not yet.</> : "."}
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

/* ── Punctuality ───────────────────────────────────────── */

function PunctualityCard({ payload, facts }: { payload: TechnicianPerformanceReadModel; facts: TechnicianTeamFacts }) {
  const buckets = punctualityBuckets(payload.punctuality);
  const coveragePct = facts.scheduledVisits > 0 ? (facts.verifiedVisits / facts.scheduledVisits) * 100 : 0;
  return (
    <Card
      title="Punctuality"
      subtitle={
        <>
          Verified arrivals vs planned start ·{" "}
          <span
            className="repr"
            data-def={`Verified-arrival coverage is ${facts.verifiedVisits} of ${facts.scheduledVisits} ${facts.monthLong} visits; per-technician rates are representative until mobile-event matching is re-verified.`}
          >
            representative until mobile-event matching is re-verified
          </span>
        </>
      }
    >
      <CardBody>
        {facts.verifiedVisits > 0 ? (
          <>
            <Histogram buckets={buckets} h={300} seriesName="Visits" style={{ maxWidth: 620, margin: "0 auto" }} />
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

export function punctualityFnote(punctuality: TechnicianPunctualityDistribution, facts: TechnicianTeamFacts): string {
  if (facts.otPct === null) return `No verified arrivals in ${facts.monthLong}.`;
  const floor = facts.otFloorPct !== null ? ` (${pctInt(facts.otFloorPct)} if every uncovered visit were late)` : "";
  const tail =
    punctuality.lateOver30 > punctuality.late16To30
      ? ` — the ${punctuality.lateOver30}-visit 30+ tail outweighs the 16–30 band`
      : punctuality.late16To30 > punctuality.lateOver30
        ? ` — the ${punctuality.late16To30}-visit 16–30 band outweighs the 30+ tail`
        : "";
  return `On-time is ${pctInt(facts.otPct)} of verified visits${floor}${tail}.`;
}

/* ── Completed-Job Economics ───────────────────────────── */

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
  const maxSell = Math.max(0, ...ranked.map((row) => row.sell));
  const teamNp = ranked.reduce((sum, row) => sum + (row.np ?? 0), 0);
  const outsideTotal = payload.coverage.outsideRosterAllocatedSellValue;
  const outsideNames = payload.outsideRoster.map((entry) => `${entry.displayName} (${fmt.money(entry.allocatedSellValue)})`);
  const archivedWithSell = archivedRows.filter((row) => row.sell > 0);
  const noAllocation = rows.filter((row) => row.sell <= 0);
  return (
    <Card
      title="Completed-Job Economics"
      subtitle={`Ranked by allocated net profit · ${facts.monthLong}-completed jobs, including pre-${facts.monthLong} hours on those jobs · hatched = interim allocation · hover or tap a row`}
      aside={
        <Legend
          style={{ padding: 0 }}
          items={[
            { label: "Net profit", color: ACC, swatchClassName: "hatch", swatchStyle: { width: 12, height: 12, borderRadius: 4 } },
            { label: "Revenue", color: GREY, swatchClassName: "hatch", swatchStyle: { width: 12, height: 12, borderRadius: 4 } },
          ]}
        />
      }
    >
      <CardBody>
        {ranked.length > 0 ? (
          <div>
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
                  <div
                    className="hatch"
                    style={{
                      width: `${maxSell > 0 ? (row.sell / maxSell) * 100 : 0}%`,
                      height: "100%",
                      backgroundColor: GREY,
                      borderRadius: 5,
                    }}
                  />
                  {row.np !== null && row.np > 0 ? (
                    <div
                      className="hatch"
                      style={{
                        width: `${maxSell > 0 ? (row.np / maxSell) * 100 : 0}%`,
                        height: "100%",
                        backgroundColor: ACC,
                        borderRadius: 5,
                        position: "absolute",
                        top: 0,
                        left: 0,
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
          <span
            className="repr"
            data-def="Each completed job’s value is split by each technician’s share of the job’s timesheet hours — interim until timesheet attribution is re-verified; totals are exact, shares may shift."
          >
            interim hours-share split
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

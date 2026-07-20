"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DevBars, fmt, Histogram, type HistogramBucket } from "@/components/charts";
import {
  Card,
  CardBody,
  Def,
  DefTooltipProvider,
  Fnote,
  LDetail,
  Legend,
  LRow,
  Seg,
  Skel,
  StateEmpty,
  StateError,
  StateMini,
  StatesStrip,
  TierChip,
  type LRowSegment,
} from "@/components/reset";
import { KpiBand, KpiBandNote, KpiTile, KpiTiles, PrimaryStatCard } from "@/components/band";
import {
  allocateLargestRemainder,
  efficiencyMultiplier,
  type CommissionTier,
  type CommissionTierMultipliers,
} from "@/lib/metrics/commissions";
import type {
  CommissionConfig,
  CommissionDashboardReadModel,
  CommissionJobAllocation,
  CommissionReadyWorksheetModel,
  CommissionWorksheetModel,
} from "@/lib/store/commissions-read-model";

/* /commissions — implements the owner-approved redesign
   docs/approved-design/mockups/commissions.html exactly, data-driven from the
   commission read model. Composition: KPI band (primary CALCULATED COMMISSION
   DUE card with cents styling + bullet vs the prior month, plus COMPLETED
   REVENUE / TECHNICIANS EARNING / TOP CALCULATED PAYOUT / YEAR TO DATE tiles)
   → Worksheet/Summary tabs → toolbar → ONE ranked leaderboard.
   FINAL OWNER RULE: membership and shares come ONLY from recorded hours on
   the period's jobs — everyone with hours is a row, included by default; the
   per-row include checkboxes are the ONLY exclusion mechanism, and unchecking
   redistributes the unchanged pool across everyone still included. There is
   no "eligibility" anywhere. The pool %, efficiency toggle, ±max slider and
   checkboxes drive a session-only client recalculation (nothing persists); at
   the saved defaults the page renders the persisted server-verified run
   number-for-number. Rejected surfaces (lifecycle/status/export UI) are not
   rendered. */

export type CommissionsDashboardProps = {
  model: CommissionDashboardReadModel;
  /** Renders the design-reference state strip (mockups' ?states=1 gate). */
  showStates?: boolean;
};

/* ── Approved colors (mockup .lbar: base --acc-2, boost --acc) ── */

const SEG_BASE = "#8087ec";
const SEG_BOOST = "#5b63d3";
const SEG_EFF_UP = "#1a8a5a";
const SEG_EFF_DOWN = "#eab3ac";
const EFF_NEG_BAR = "#d0463a";

/* ── Session engine (mirror of the verified server engine) ─
   Same step order and deterministic largest-remainder cent allocation as
   src/lib/metrics/commissions.ts buildCommissionReadModel: base allocation
   share → rank boosts → normalize to the pool → minimum-bonus forfeit +
   redistribute → efficiency remap [0.5,1.5]→[1∓max] (neutral when uncovered)
   → renormalize to the pool. Payouts always sum exactly to the pool. */

export type CommissionSessionControls = {
  poolPercent: number;
  efficiencyEnabled: boolean;
  maxAdjustmentPercent: number;
  /** Employees the owner unchecked: removed from the calculation entirely, and
   *  the pool redistributes across everyone still included. Session-only;
   *  seeded from any saved `included` overrides on the persisted run. */
  excludedEmployeeIds?: readonly string[];
};

export type CommissionSessionTechnician = {
  employeeId: string;
  displayName: string;
  /** Deterministic cents-allocated work value (display). */
  allocatedValue: number;
  /** Allocation weight basis (the server's effective allocated work value). */
  effectiveValue: number;
  efficiencyRatio: number | null;
  jobCount: number;
  jobAllocations: CommissionJobAllocation[];
};

export type CommissionComputedRow = CommissionSessionTechnician & {
  tier: CommissionTier;
  tierMultiplier: number;
  /** Pool distributed by allocation weight alone (trace "base share"). */
  base: number;
  /** Post-boost, post-forfeiture, pre-efficiency payout (sums to the pool). */
  post: number;
  /** Calculated payout (sums to the pool). */
  final: number;
  belowMinimum: boolean;
  /** Owner unchecked this person: excluded from the calculation, pool
   *  redistributed across everyone still included. */
  excluded: boolean;
};

/** Saved checkbox state: employees whose persisted run carries an `included:
 *  false` override. Everyone else defaults to checked. */
export function savedExcludedIds(worksheet: CommissionReadyWorksheetModel): string[] {
  return worksheet.coverage.technicianWork.filter((entry) => !entry.included).map((entry) => entry.employeeId);
}

export function savedControls(config: CommissionConfig, savedExcluded: readonly string[] = []): CommissionSessionControls {
  return {
    poolPercent: config.poolPercent,
    efficiencyEnabled: config.efficiencyEnabled,
    maxAdjustmentPercent: config.maxEfficiencyAdjustmentPercent,
    excludedEmployeeIds: [...savedExcluded],
  };
}

export function controlsMatchSaved(
  controls: CommissionSessionControls,
  config: CommissionConfig,
  savedExcluded: readonly string[] = [],
): boolean {
  const excluded = new Set(controls.excludedEmployeeIds ?? []);
  const saved = new Set(savedExcluded);
  return Math.abs(controls.poolPercent - config.poolPercent) < 1e-9
    && controls.efficiencyEnabled === config.efficiencyEnabled
    && controls.maxAdjustmentPercent === config.maxEfficiencyAdjustmentPercent
    && excluded.size === saved.size
    && [...excluded].every((employeeId) => saved.has(employeeId));
}

/** Rows from coverage.technicianWork that have no payout row on the persisted
 *  run — zero-hour directory rows plus anyone a saved override excluded. ALL
 *  of them render; nobody is silently dropped. */
function coverageOnlyInputs(worksheet: CommissionReadyWorksheetModel): CommissionSessionTechnician[] {
  const seen = new Set(worksheet.technicians.map((technician) => technician.employeeId));
  return worksheet.coverage.technicianWork
    .filter((entry) => !seen.has(entry.employeeId))
    .map((entry) => ({
      employeeId: entry.employeeId,
      displayName: entry.displayName,
      allocatedValue: entry.allocatedWorkValue,
      effectiveValue: entry.effectiveAllocatedWorkValue,
      efficiencyRatio: null,
      jobCount: entry.jobCount,
      jobAllocations: [] as CommissionJobAllocation[],
    }));
}

export function buildSessionInputs(worksheet: CommissionReadyWorksheetModel): CommissionSessionTechnician[] {
  const withWork = worksheet.technicians.map((technician) => ({
    employeeId: technician.employeeId,
    displayName: technician.displayName,
    allocatedValue: technician.allocatedValue,
    effectiveValue: technician.effectiveAllocatedValue,
    efficiencyRatio: technician.efficiency?.efficiencyRatio ?? null,
    jobCount: technician.jobCount,
    jobAllocations: technician.jobAllocations,
  }));
  return [...withWork, ...coverageOnlyInputs(worksheet)];
}

export function runCommissionSessionEngine(params: {
  totalWorkValue: number;
  minBonusPercent: number;
  tierMultipliers: CommissionTierMultipliers;
  technicians: CommissionSessionTechnician[];
  controls: CommissionSessionControls;
}): { pool: number; rows: CommissionComputedRow[] } {
  const { controls } = params;
  const poolCents = toCents(Math.max(0, params.totalWorkValue) * (Math.max(0, controls.poolPercent) / 100));
  const excluded = new Set(controls.excludedEmployeeIds ?? []);
  const ranked = params.technicians
    .filter((technician) => technician.effectiveValue > 0 && !excluded.has(technician.employeeId))
    .sort((a, b) => b.effectiveValue - a.effectiveValue || compareNumericIds(a.employeeId, b.employeeId))
    .map((technician, index) => {
      const tier = tierForRank(index + 1);
      return { ...technician, tier, tierMultiplier: params.tierMultipliers[tier] ?? 1 };
    });
  const baseWeights = ranked.map((technician) => ({ id: technician.employeeId, weight: technician.effectiveValue }));
  const tierWeights = ranked.map((technician) => ({
    id: technician.employeeId,
    weight: technician.effectiveValue * technician.tierMultiplier,
  }));
  const baseCents = allocateLargestRemainder(poolCents, baseWeights);
  const rawCents = allocateLargestRemainder(poolCents, tierWeights);
  const rawExact = exactShares(poolCents, tierWeights);
  const thresholdCents = ranked.length > 0 ? (poolCents / ranked.length) * (params.minBonusPercent / 100) : 0;
  const below = new Set(
    ranked
      .filter((technician) => (rawExact.get(technician.employeeId) ?? 0) < thresholdCents)
      .map((technician) => technician.employeeId),
  );
  if (below.size === ranked.length) below.clear();
  const postWeights = tierWeights.filter((entry) => !below.has(entry.id));
  const forfeitedCents = ranked.reduce(
    (sum, technician) => sum + (below.has(technician.employeeId) ? rawCents.get(technician.employeeId) ?? 0 : 0),
    0,
  );
  const reallocCents = allocateLargestRemainder(forfeitedCents, postWeights);
  const postCents = new Map(ranked.map((technician) => [
    technician.employeeId,
    below.has(technician.employeeId)
      ? 0
      : (rawCents.get(technician.employeeId) ?? 0) + (reallocCents.get(technician.employeeId) ?? 0),
  ]));
  const postExact = exactShares(poolCents, postWeights);
  const multipliers = new Map(ranked.map((technician) => [
    technician.employeeId,
    controls.efficiencyEnabled && technician.efficiencyRatio !== null
      ? efficiencyMultiplier(technician.efficiencyRatio, controls.maxAdjustmentPercent)
      : 1,
  ]));
  const hasAdjustment = ranked.some(
    (technician) => Math.abs((multipliers.get(technician.employeeId) ?? 1) - 1) > Number.EPSILON,
  );
  const effWeights = ranked.map((technician) => ({
    id: technician.employeeId,
    weight: (postExact.get(technician.employeeId) ?? 0) * (multipliers.get(technician.employeeId) ?? 1),
  }));
  const finalCents = hasAdjustment ? allocateLargestRemainder(poolCents, effWeights) : new Map(postCents);
  const rows: CommissionComputedRow[] = [
    ...ranked.map((technician) => ({
      ...technician,
      base: fromCents(baseCents.get(technician.employeeId) ?? 0),
      post: fromCents(postCents.get(technician.employeeId) ?? 0),
      final: fromCents(finalCents.get(technician.employeeId) ?? 0),
      belowMinimum: below.has(technician.employeeId),
      excluded: false,
    })),
    // Zero-work people and anyone the owner unchecked still render, so they can
    // be put back into the calculation.
    ...params.technicians
      .filter((technician) => technician.effectiveValue <= 0 || excluded.has(technician.employeeId))
      .map((technician) => ({
        ...technician,
        tier: "Standard" as CommissionTier,
        tierMultiplier: 1,
        base: 0,
        post: 0,
        final: 0,
        belowMinimum: false,
        excluded: excluded.has(technician.employeeId),
      })),
  ];
  return { pool: fromCents(poolCents), rows };
}

/** The persisted server-verified run, in session-row shape — rendered
 *  verbatim while the controls sit at the saved state. */
export function persistedWorksheetRows(worksheet: CommissionReadyWorksheetModel): { pool: number; rows: CommissionComputedRow[] } {
  const multipliers = worksheet.config.tierMultipliers;
  const excluded = new Set(savedExcludedIds(worksheet));
  const rows: CommissionComputedRow[] = [
    ...worksheet.technicians.map((technician) => ({
      employeeId: technician.employeeId,
      displayName: technician.displayName,
      allocatedValue: technician.allocatedValue,
      effectiveValue: technician.effectiveAllocatedValue,
      efficiencyRatio: technician.efficiency?.efficiencyRatio ?? null,
      jobCount: technician.jobCount,
      jobAllocations: technician.jobAllocations,
      tier: (isCommissionTier(technician.tier) ? technician.tier : "Standard") as CommissionTier,
      tierMultiplier: isCommissionTier(technician.tier) ? multipliers[technician.tier] ?? 1 : 1,
      base: technician.baseBonus,
      post: technician.postForfeitureBonus,
      final: technician.finalBonus,
      belowMinimum: technician.belowMinimum,
      excluded: false,
    })),
    ...coverageOnlyInputs(worksheet).map((entry) => ({
      ...entry,
      tier: "Standard" as CommissionTier,
      tierMultiplier: 1,
      base: 0,
      post: 0,
      final: 0,
      belowMinimum: false,
      excluded: excluded.has(entry.employeeId),
    })),
  ];
  return { pool: worksheet.commissionPool, rows };
}

export function buildWorksheetRows(
  worksheet: CommissionReadyWorksheetModel,
  controls: CommissionSessionControls,
): { pool: number; rows: CommissionComputedRow[] } {
  const result = controlsMatchSaved(controls, worksheet.config, savedExcludedIds(worksheet))
    ? persistedWorksheetRows(worksheet)
    : runCommissionSessionEngine({
      totalWorkValue: worksheet.totalWorkValue,
      minBonusPercent: worksheet.config.minBonusPercent,
      tierMultipliers: worksheet.config.tierMultipliers,
      technicians: buildSessionInputs(worksheet),
      controls,
    });
  const rows = [...result.rows].sort(
    (a, b) => b.final - a.final || b.effectiveValue - a.effectiveValue || compareNumericIds(a.employeeId, b.employeeId),
  );
  return { pool: result.pool, rows };
}

/** Composite payout adjustment (efficiency remap × pool re-scale), computed
 *  from the PRINTED operands (cents-rounded pre-efficiency value) at 5
 *  decimals so the trace multiplication reproduces the printed payout exactly
 *  at every pool/±max setting (ledger C1/C2). */
export function compositeAdjustment(preEfficiency: number, payout: number): number | null {
  const printed = Math.round(preEfficiency * 100) / 100;
  if (!(printed > 0)) return null;
  return Number((payout / printed).toFixed(5));
}

/* ── Summary view model + CSV (client-side, approved) ──── */

export type CommissionSummaryMode = "monthly" | "quarterly" | "annual";

export type CommissionSummaryVM = {
  year: number;
  months: Array<{ month: number; short: string; pool: number | null; status: "current" | "draft" | "final" | "none" }>;
  lastLoadedMonth: number;
  ytd: number | null;
  average: number | null;
  peak: { short: string; value: number } | null;
  earningYtd: number | null;
};

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function buildSummaryVM(summary: CommissionDashboardReadModel["summary"]): CommissionSummaryVM {
  const byMonth = new Map(summary.months.map((month) => [month.month, month]));
  const pools = Array.from({ length: 12 }, (_, index) => byMonth.get(index + 1)?.commissionPool ?? null);
  const lastLoadedMonth = pools.reduce<number>((last, pool, index) => (pool !== null ? index + 1 : last), 0);
  const months = pools.map((pool, index) => {
    const month = index + 1;
    const source = byMonth.get(month);
    const status: CommissionSummaryVM["months"][number]["status"] = pool === null
      ? "none"
      : month === lastLoadedMonth
        ? "current"
        : source?.finalized
          ? "final"
          : "draft";
    return { month, short: MONTHS_SHORT[index], pool, status };
  });
  const loaded = months.filter((month) => month.pool !== null);
  const ytd = loaded.length ? round2(loaded.reduce((sum, month) => sum + (month.pool ?? 0), 0)) : null;
  const peak = loaded.reduce<CommissionSummaryVM["peak"]>((current, month) => {
    if (month.pool === null) return current;
    return !current || month.pool > current.value ? { short: month.short, value: month.pool } : current;
  }, null);
  const earningIds = new Set<string>();
  for (const month of summary.months) {
    for (const technician of month.technicians) {
      if (technician.totalBonus > 0) earningIds.add(technician.employeeId);
    }
  }
  return {
    year: summary.year,
    months,
    lastLoadedMonth,
    ytd,
    average: ytd !== null && loaded.length ? round2(ytd / loaded.length) : null,
    peak,
    earningYtd: loaded.length ? earningIds.size : null,
  };
}

const STATUS_WORD = { current: "Current", draft: "Draft", final: "Final", none: "No run" } as const;

export function summaryQuarters(vm: CommissionSummaryVM): Array<{ label: string; pool: number | null; loaded: number }> {
  return [0, 1, 2, 3].map((quarter) => {
    const slice = vm.months.slice(quarter * 3, quarter * 3 + 3).filter((month) => month.pool !== null);
    return {
      label: `Q${quarter + 1}`,
      pool: slice.length ? round2(slice.reduce((sum, month) => sum + (month.pool ?? 0), 0)) : null,
      loaded: slice.length,
    };
  });
}

export function buildSummaryCsv(vm: CommissionSummaryVM, mode: CommissionSummaryMode): string {
  const csvPool = (pool: number | null) => (pool === null ? "N/A" : pool.toFixed(2));
  if (mode === "monthly") {
    return [
      "Month,Pool,Status",
      ...vm.months.map((month) => `${month.short} ${vm.year},${csvPool(month.pool)},${STATUS_WORD[month.status]}`),
    ].join("\n");
  }
  if (mode === "quarterly") {
    return [
      "Quarter,Pool,Months with a run",
      ...summaryQuarters(vm).map((quarter) => `${quarter.label} ${vm.year},${csvPool(quarter.pool)},${quarter.loaded} of 3`),
    ].join("\n");
  }
  const h1 = vm.months.slice(0, 6).filter((month) => month.pool !== null);
  const h2 = vm.months.slice(6).filter((month) => month.pool !== null);
  const half = (loaded: typeof h1) => (loaded.length ? round2(loaded.reduce((sum, month) => sum + (month.pool ?? 0), 0)) : null);
  return [
    "Year,H1 pool,H2 pool,Total,Peak month",
    `${vm.year},${csvPool(half(h1))},${csvPool(half(h2))},${csvPool(vm.ytd)},${vm.peak ? `${vm.peak.short} ${vm.peak.value.toFixed(2)}` : "N/A"}`,
  ].join("\n");
}

/* ── Component ─────────────────────────────────────────── */

export function CommissionsDashboard({ model, showStates }: CommissionsDashboardProps) {
  return (
    <DefTooltipProvider>
      <CommissionsContent model={model} />
      <StatesStrip show={showStates}>
        <StateMini label="Loading">
          <Skel width="55%" />
          <Skel width="85%" />
          <Skel width="70%" />
        </StateMini>
        <StateMini label="No finalized months">
          <StateEmpty>
            Summary shows “No finalized months yet for {model.summary.year}” — KPIs render N/A, never $0.
          </StateEmpty>
        </StateMini>
        <StateMini label="Below minimum">
          <StateEmpty>
            A bonus under 5% of the average is forfeited and redistributed — the row stays visible, marked “below minimum.”
          </StateEmpty>
        </StateMini>
        <StateMini label="Error">
          <StateError>Commission data could not be loaded.</StateError>
        </StateMini>
      </StatesStrip>
      <div className="footline">
        Source: Simpro completed jobs · pool = completed work value × pool percent · calculated amounts are not payment records
      </div>
    </DefTooltipProvider>
  );
}

function CommissionsContent({ model }: { model: CommissionDashboardReadModel }) {
  const worksheet = model.worksheet;
  const [controls, setControls] = useState<CommissionSessionControls>(() =>
    savedControls(worksheet.config, worksheet.servingStatus === "ready" ? savedExcludedIds(worksheet) : []),
  );
  const [tab, setTab] = useState<"monthly" | "summary">("monthly");
  const [mode, setMode] = useState<CommissionSummaryMode>("monthly");
  const [openTech, setOpenTech] = useState<string | null>(null);
  const interacted = useRef(false);

  const computed = useMemo(
    () => (worksheet.servingStatus === "ready" ? buildWorksheetRows(worksheet, controls) : null),
    [worksheet, controls],
  );
  const vm = useMemo(() => buildSummaryVM(model.summary), [model.summary]);

  useEffect(() => {
    if (interacted.current && openTech) {
      document.querySelector(".lrow.open")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [openTech]);

  const toggleOpen = (employeeId: string) => {
    interacted.current = true;
    setOpenTech((current) => (current === employeeId ? null : employeeId));
  };

  /** Uncheck/recheck a person: the pool is unchanged, but it redistributes
   *  across everyone still included (session-only, nothing persists). */
  const toggleExclude = (employeeId: string) => {
    setControls((current) => {
      const excluded = new Set(current.excludedEmployeeIds ?? []);
      if (excluded.has(employeeId)) excluded.delete(employeeId);
      else excluded.add(employeeId);
      return { ...current, excludedEmployeeIds: [...excluded] };
    });
  };

  return (
    <>
      {worksheet.servingStatus === "ready" && computed ? (
        <CommissionsBand worksheet={worksheet} computed={computed} controls={controls} vm={vm} />
      ) : null}
      <div className="tabs" id="pageTabs">
        <button type="button" className={tab === "monthly" ? "on" : undefined} data-tab="monthly" onClick={() => setTab("monthly")}>
          Worksheet
        </button>
        <button type="button" className={tab === "summary" ? "on" : undefined} data-tab="summary" onClick={() => setTab("summary")}>
          Summary
        </button>
      </div>
      {tab === "monthly" ? (
        worksheet.servingStatus === "ready" && computed ? (
          <WorksheetTab
            worksheet={worksheet}
            computed={computed}
            controls={controls}
            onControls={setControls}
            openTech={openTech}
            onToggleOpen={toggleOpen}
            onToggleExclude={toggleExclude}
          />
        ) : (
          <WorksheetStateCard worksheet={worksheet} />
        )
      ) : (
        <SummaryTab vm={vm} mode={mode} onMode={setMode} savedPoolPercent={worksheet.config.poolPercent} />
      )}
    </>
  );
}

/* ── Honest non-ready states (never fabricated zeros) ──── */

function WorksheetStateCard({ worksheet }: { worksheet: CommissionWorksheetModel }) {
  if (worksheet.servingStatus === "building") {
    return (
      <Card style={{ marginTop: 18 }}>
        <CardBody>
          <Skel width="55%" />
          <Skel width="85%" />
          <Skel width="70%" />
          <StateEmpty>
            The {worksheet.periodLabel} calculation is still building — amounts appear when the run completes, never as $0.
          </StateEmpty>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card style={{ marginTop: 18 }}>
      <CardBody>
        <StateError onRetry={() => window.location.reload()}>
          Commission data could not be loaded.
          <span className="sr-only">{worksheet.servingMessage}</span>
        </StateError>
      </CardBody>
    </Card>
  );
}

/* ── Row 1: KPI band ───────────────────────────────────── */

function CommissionsBand({
  worksheet,
  computed,
  controls,
  vm,
}: {
  worksheet: CommissionReadyWorksheetModel;
  computed: { pool: number; rows: CommissionComputedRow[] };
  controls: CommissionSessionControls;
  vm: CommissionSummaryVM;
}) {
  const { pool, rows } = computed;
  const monthLong = monthLongName(worksheet.periodLabel);
  const earning = rows.filter((row) => row.final > 0);
  const multipliers = worksheet.config.tierMultipliers;
  const basis = allocationBasis(rows);
  const poolText = fmt.cents(pool);
  const dot = poolText.lastIndexOf(".");
  const top = rows[0];
  const primaryDef = `Pool = completed-cohort work value × pool percent (${monthShortName(worksheet.periodLabel)}: ${controls.poolPercent.toFixed(2)}% × ${fmt.cents(worksheet.totalWorkValue)} = ${fmt.cents(pool)}), distributed by each technician’s allocated share (${basis.label}) with rank boosts, normalized so payouts always sum exactly to the pool. Calculated — not proof of payment.`;

  const priorMonth = vm.months.find((month) => month.month === worksheet.month - 1);
  const priorName = shiftedSeriesName(worksheet.periodStart, -1);
  const lyName = shiftedSeriesName(worksheet.periodStart, -12);
  const loaded = vm.months.filter((month) => month.pool !== null);
  const poolsRange = loaded.length === 0
    ? "no pools loaded"
    : loaded.length === 1
      ? `pool ${loaded[0].short}`
      : `pools ${loaded[0].short}–${loaded[loaded.length - 1].short}`;

  return (
    <>
      <KpiBand ariaLabel={`${monthLong} key metrics`}>
        <PrimaryStatCard
          label="Calculated commission due"
          labelDef={primaryDef}
          value={
            <>
              {poolText.slice(0, dot)}
              <span className="cents">{poolText.slice(dot)}</span>
            </>
          }
          sub={`${controls.poolPercent.toFixed(2)}% pool of completed work value`}
          bullet={{
            value: pool,
            m1: { label: lyName, value: null, ghost: "· no run" },
            m2: priorMonth && priorMonth.pool !== null ? { label: `${priorName} · full`, value: priorMonth.pool } : { label: priorName, value: null, ghost: "· no run" },
            fmt: fmt.cents,
            ariaLabel: `Commission pool ${fmt.cents(pool)}${
              priorMonth && priorMonth.pool !== null ? `; tick marks ${priorName} ${fmt.cents(priorMonth.pool)}` : ""
            }; ${lyName} had no run`,
          }}
        />
        <KpiTiles>
          <KpiTile
            label="Completed revenue"
            labelDef={`Σ Simpro job Total (ex-tax) across the ${monthLong} completed cohort — the same cohort as the Jobs page.`}
            value={fmt.moneyFull(worksheet.totalWorkValue)}
            sub={`${worksheet.completedJobs} completed jobs`}
          />
          <KpiTile
            label="Technicians earning"
            labelDef="Worksheet rows whose calculated payout is above zero this month, of every technician on the worksheet."
            value={String(earning.length)}
            sub={`of ${rows.length} technicians`}
          />
          <KpiTile
            label="Top calculated payout"
            labelDef="The largest single calculated payout under the current settings — after rank boosts, the efficiency adjustment (when on), and re-scaling to the pool."
            value={top && top.final > 0 ? fmt.cents(top.final) : "N/A"}
            sub={top && top.final > 0 ? `${top.displayName} · ${top.tier}` : "no payouts"}
          />
          <KpiTile
            label="Year to date"
            labelDef={`Σ of every loaded ${vm.year} monthly pool. Months without a run stay N/A and add nothing.`}
            value={vm.ytd !== null ? fmt.cents(vm.ytd) : "N/A"}
            sub={`${vm.year} · ${poolsRange}`}
          />
        </KpiTiles>
      </KpiBand>
      <KpiBandNote>
        Rank boosts: Gold ×{multipliers.Gold.toFixed(2)} · Silver ×{multipliers.Silver.toFixed(2)} · Bronze ×
        {multipliers.Bronze.toFixed(2)}.
      </KpiBandNote>
    </>
  );
}

/* ── Worksheet tab ─────────────────────────────────────── */

const POOL_OPTIONS = Array.from({ length: 16 }, (_, index) => (25 + index * 5) / 100);

function WorksheetTab({
  worksheet,
  computed,
  controls,
  onControls,
  openTech,
  onToggleOpen,
  onToggleExclude,
}: {
  worksheet: CommissionReadyWorksheetModel;
  computed: { pool: number; rows: CommissionComputedRow[] };
  controls: CommissionSessionControls;
  onControls: (controls: CommissionSessionControls) => void;
  openTech: string | null;
  onToggleOpen: (employeeId: string) => void;
  onToggleExclude: (employeeId: string) => void;
}) {
  const eff = controls.efficiencyEnabled;
  const monthLong = monthLongName(worksheet.periodLabel);
  const basis = allocationBasis(computed.rows);
  const legendItems = [
    { label: "Base share", color: SEG_BASE },
    { label: "Rank boost", color: SEG_BOOST },
    ...(eff
      ? [
        { label: "Efficiency +", color: SEG_EFF_UP },
        { label: "Efficiency −", color: SEG_EFF_DOWN },
      ]
      : []),
  ];

  return (
    <>
      <div className="toolbar">
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5, fontWeight: 600, color: "var(--ink-2)" }}>
          Commission pool
          <select
            className="ctl-sel"
            aria-label="Commission pool percent"
            value={controls.poolPercent.toFixed(2)}
            onChange={(event) => onControls({ ...controls, poolPercent: Number(event.target.value) })}
          >
            {POOL_OPTIONS.map((option) => (
              <option key={option.toFixed(2)} value={option.toFixed(2)}>
                {option.toFixed(2)}%
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5, fontWeight: 600, color: "var(--ink-2)", cursor: "pointer" }}>
          <span
            className={eff ? "switch on" : "switch"}
            role="switch"
            aria-checked={eff}
            aria-label="Efficiency adjustment"
            tabIndex={0}
            onClick={() => onControls({ ...controls, efficiencyEnabled: !eff })}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onControls({ ...controls, efficiencyEnabled: !eff });
              }
            }}
          />
          <span>
            Efficiency adjustment · <span style={{ color: "var(--subtle)" }}>{eff ? "on" : "off"}</span>
          </span>
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 13.5,
            fontWeight: 600,
            color: eff ? "var(--ink-2)" : "var(--muted)",
            opacity: eff ? 1 : 0.45,
            transition: "opacity .15s",
          }}
        >
          Max adjustment
          <input
            type="range"
            min={5}
            max={50}
            step={1}
            value={controls.maxAdjustmentPercent}
            disabled={!eff}
            aria-label="Maximum efficiency adjustment percent"
            style={{ width: 130 }}
            onChange={(event) => onControls({ ...controls, maxAdjustmentPercent: Number(event.target.value) })}
          />
          <b className="tnum" style={{ color: eff ? "var(--ink-2)" : "var(--faint)" }}>
            ±{controls.maxAdjustmentPercent}%
          </b>
        </label>
        {eff ? (
          <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--subtle)" }}>
            Faster than the estimate boosts the share, slower trims it — the pool total never changes.
          </span>
        ) : null}
      </div>

      <Card
        title="Commission by Technician"
        subtitle={
          <>
            Ranked by calculated payout · bar shows how each payout is built · click a row for job detail
            {eff ? (
              <>
                {" · "}
                <Def def="Payout adjustment — the efficiency ratio remapped to the ±max, then re-scaled so the pool total is unchanged; shown to 5 decimals so the trace arithmetic reproduces exactly.">
                  × column = payout adjustment
                </Def>
              </>
            ) : null}
          </>
        }
        aside={<Legend style={{ padding: 0, justifyContent: "flex-end", rowGap: 6 }} items={legendItems} />}
      >
        <div data-viz="">
          <div data-primary-viz="">
            {computed.rows.slice(0, 3).map((row, index) => (
              <BoardRow
                key={row.employeeId}
                row={row}
                rank={index + 1}
                pool={computed.pool}
                rows={computed.rows}
                controls={controls}
                worksheet={worksheet}
                basis={basis}
                monthLong={monthLong}
                open={openTech === row.employeeId}
                onToggle={() => onToggleOpen(row.employeeId)}
                onToggleExclude={() => onToggleExclude(row.employeeId)}
              />
            ))}
          </div>
          {computed.rows.slice(3).map((row, index) => (
            <BoardRow
              key={row.employeeId}
              row={row}
              rank={index + 4}
              pool={computed.pool}
              rows={computed.rows}
              controls={controls}
              worksheet={worksheet}
              basis={basis}
              monthLong={monthLong}
              open={openTech === row.employeeId}
              onToggle={() => onToggleOpen(row.employeeId)}
              onToggleExclude={() => onToggleExclude(row.employeeId)}
            />
          ))}
        </div>
        <CardBody style={{ paddingTop: 4 }}>
          <Fnote style={{ marginTop: 0 }}>
            Shares are{" "}
            <span className={basis.repr ? "repr" : "def"} data-def={basis.def}>
              {basis.label}
            </span>{" "}
            of each job’s value — everyone with recorded {monthLong} hours is a row, included by default; unchecking a row
            redistributes the unchanged pool across everyone still included.
          </Fnote>
        </CardBody>
      </Card>

      {eff ? <EfficiencyEffectCard worksheet={worksheet} computed={computed} monthLong={monthLong} /> : null}
    </>
  );
}

/* ── Board row + expandable detail ─────────────────────── */

/** "18 jobs · $46K allocated" (mockup grammar — full dollars under $10K). */
function allocatedText(value: number): string {
  return value >= 10_000 ? `$${Math.round(value / 1000)}K` : fmt.money(value);
}

function BoardRow({
  row,
  rank,
  pool,
  rows,
  controls,
  worksheet,
  basis,
  monthLong,
  open,
  onToggle,
  onToggleExclude,
}: {
  row: CommissionComputedRow;
  rank: number;
  pool: number;
  rows: CommissionComputedRow[];
  controls: CommissionSessionControls;
  worksheet: CommissionReadyWorksheetModel;
  basis: AllocationBasis;
  monthLong: string;
  open: boolean;
  onToggle: () => void;
  onToggleExclude: () => void;
}) {
  const eff = controls.efficiencyEnabled;
  const preEff = eff ? row.post : row.final;
  const delta = row.final - preEff;
  const maxBar = Math.max(...rows.map((entry) => Math.max(entry.final, eff ? entry.post : entry.final)), 0);
  const unit = (value: number) => (maxBar > 0 ? (Math.max(0, value) / maxBar) * 100 : 0);
  const baseSeg = row.tierMultiplier > 0 ? preEff / row.tierMultiplier : preEff;
  const boostSeg = preEff - baseSeg;
  const segments: LRowSegment[] = [];
  if (row.final > 0 || preEff > 0) segments.push({ widthPct: unit(baseSeg), color: SEG_BASE });
  if (boostSeg > 0.005) segments.push({ widthPct: unit(boostSeg), color: SEG_BOOST });
  if (delta > 0.005) segments.push({ widthPct: unit(delta), color: SEG_EFF_UP });
  if (delta < -0.005) segments.push({ widthPct: unit(-delta), color: SEG_EFF_DOWN });
  const ceff = eff ? compositeAdjustment(row.post, row.final) : null;
  const multipliers = worksheet.config.tierMultipliers;
  const tierDef = `Rank boosts go to the top three by allocated ${monthLong} value: Gold ×${multipliers.Gold.toFixed(2)}, Silver ×${multipliers.Silver.toFixed(2)}, Bronze ×${multipliers.Bronze.toFixed(2)} — everyone else ×1.00. Boosts shift relative shares; the pool total never changes.`;
  const zero = row.jobCount === 0 && row.effectiveValue <= 0;

  return (
    <div style={{ borderBottom: "1px solid var(--hair-2)" }}>
      <LRow
        className={zero ? "zerorow" : undefined}
        rank={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={!row.excluded}
              onChange={onToggleExclude}
              onClick={(event) => event.stopPropagation()}
              aria-label={`Include ${row.displayName} in the commission calculation`}
              title={row.excluded ? "Excluded — check to put back in and redistribute" : "Included — uncheck to remove and redistribute"}
              style={{ width: 15, height: 15, accentColor: "var(--acc)", cursor: "pointer" }}
            />
            <span>{rank}</span>
          </span>
        }
        open={open}
        onClick={onToggle}
        name={row.displayName}
        sub={
          zero ? (
            `no ${monthLong} work`
          ) : row.jobCount > 0 ? (
            <>
              {row.jobCount} {row.jobCount === 1 ? "job" : "jobs"} · {allocatedText(row.allocatedValue)} allocated
              {row.belowMinimum ? (
                <>
                  {" · "}
                  <Def def={`A calculated bonus under ${worksheet.config.minBonusPercent}% of the average payout is forfeited and redistributed to the remaining technicians — the row stays visible.`}>
                    below minimum
                  </Def>
                </>
              ) : null}
            </>
          ) : (
            "no completed-job allocation"
          )
        }
        segments={segments}
        tier={
          row.effectiveValue > 0 ? (
            <TierChip tier={tierClass(row.tier)} def={tierDef}>
              {row.tier}
              {row.tierMultiplier > 1 ? ` ×${row.tierMultiplier.toFixed(2)}` : ""}
            </TierChip>
          ) : (
            <TierChip placeholder />
          )
        }
        mult={
          eff
            ? ceff !== null
              ? (
                <Def def={`Payout adjustment — the efficiency ratio remapped to ±${controls.maxAdjustmentPercent}%, then re-scaled so the pool total is unchanged; shown to 5 decimals so the trace arithmetic reproduces exactly.`}>
                  ×{ceff.toFixed(5)}
                </Def>
              )
              : ""
            : undefined
        }
        multStyle={{
          width: 68,
          color: ceff === null ? undefined : ceff > 1 ? "var(--up)" : ceff < 1 ? "var(--down)" : "var(--subtle)",
        }}
        amount={row.final > 0 ? fmt.cents(row.final) : "$0.00"}
      />
      {open ? (
        <RowDetail row={row} pool={pool} controls={controls} basis={basis} monthLong={monthLong} worksheet={worksheet} />
      ) : null}
    </div>
  );
}

function RowDetail({
  row,
  pool,
  controls,
  basis,
  monthLong,
  worksheet,
}: {
  row: CommissionComputedRow;
  pool: number;
  controls: CommissionSessionControls;
  basis: AllocationBasis;
  monthLong: string;
  worksheet: CommissionReadyWorksheetModel;
}) {
  const allocations = [...row.jobAllocations].sort((a, b) => b.allocatedValue - a.allocatedValue);
  const trace = row.effectiveValue > 0 ? (
    <Trace row={row} pool={pool} controls={controls} basis={basis} monthLong={monthLong} worksheet={worksheet} />
  ) : null;
  if (allocations.length === 0) {
    return (
      <LDetail style={{ fontSize: 13, paddingBottom: 14 }}>
        <span style={{ color: "var(--subtle)" }}>
          {row.jobCount > 0
            ? `No job-level allocation rows were persisted for ${row.displayName}.`
            : "No completed-job allocations."}
        </span>
        {trace}
      </LDetail>
    );
  }
  return (
    <LDetail>
      <div className="tblwrap">
        <table style={{ fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ padding: "8px 12px 8px 0" }}>Job</th>
              <th className="num hide-sm" style={{ padding: "8px 12px" }}>Job value</th>
              <th className="num hide-sm" style={{ padding: "8px 12px" }}>Share</th>
              <th className="num" style={{ padding: "8px 0 8px 12px" }}>Allocated</th>
            </tr>
          </thead>
          <tbody>
            {allocations.map((allocation) => (
              <tr key={allocation.jobId}>
                <td style={{ padding: "8px 12px 8px 0", border: 0 }}>
                  {allocation.jobId} · {allocation.customer} — {allocation.jobName}
                </td>
                <td className="num tnum hide-sm" style={{ padding: "8px 12px", border: 0 }}>
                  {fmt.moneyFull(allocation.jobTotal)}
                </td>
                <td className="num tnum hide-sm" style={{ padding: "8px 12px", border: 0 }}>
                  {shareText(allocation.share)}
                </td>
                <td className="num tnum" style={{ padding: "8px 0 8px 12px", border: 0, fontWeight: 700 }}>
                  {fmt.moneyFull(allocation.allocatedValue)}
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={4} style={{ padding: "8px 12px 0 0", border: 0, color: "var(--subtle)", fontSize: 13 }}>
                All {allocations.length} {monthLong} allocations by allocated value.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {trace}
    </LDetail>
  );
}

function Trace({
  row,
  pool,
  controls,
  basis,
  monthLong,
  worksheet,
}: {
  row: CommissionComputedRow;
  pool: number;
  controls: CommissionSessionControls;
  basis: AllocationBasis;
  monthLong: string;
  worksheet: CommissionReadyWorksheetModel;
}) {
  const eff = controls.efficiencyEnabled;
  const preEff = eff ? row.post : row.final;
  const ceff = eff ? compositeAdjustment(row.post, row.final) : null;
  const weighted = round2(row.base * row.tierMultiplier);
  const ratioNode = row.efficiencyRatio === null ? (
    "not covered — neutral ×1.00, then re-scaled to the pool"
  ) : (
    <>
      ratio{" "}
      <span className="repr" data-def={perTechRatioDef(worksheet)}>
        {row.efficiencyRatio.toFixed(2)}×
      </span>{" "}
      remapped, then re-scaled to the pool
    </>
  );
  return (
    <div className="callout" style={{ lineHeight: 1.7 }}>
      <span className="diam">◆</span>
      <b>How this was calculated:</b>{" "}
      allocated <b className="tnum">{fmt.money(row.allocatedValue)}</b> (
      <span className={basis.repr ? "repr" : "def"} data-def={basis.def}>
        {basis.label}
      </span>{" "}
      of {monthLong} jobs) → base share <b className="tnum">{fmt.cents(row.base)}</b> →{" "}
      {row.tierMultiplier > 1 ? (
        <>
          {row.tier} boost ×{row.tierMultiplier.toFixed(2)} → <b className="tnum">{fmt.cents(weighted)}</b>
        </>
      ) : (
        "Standard ×1.00"
      )}
      {row.belowMinimum ? (
        <>
          {" "}→ below the {worksheet.config.minBonusPercent}% minimum — forfeited and redistributed →{" "}
          <b className="tnum">$0.00</b>
        </>
      ) : (
        <>
          {" "}→ scaled so the total stays exactly <b className="tnum">{fmt.cents(pool)}</b> →{" "}
          <b className="tnum">{fmt.cents(preEff)}</b>
          {ceff !== null ? (
            <>
              {" "}→ efficiency <b className="tnum">×{ceff.toFixed(5)}</b> ({ratioNode}) →{" "}
              <b className="tnum" style={{ color: "var(--ink)" }}>{fmt.cents(row.final)}</b>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ── Efficiency effect card ────────────────────────────── */

function EfficiencyEffectCard({
  worksheet,
  computed,
  monthLong,
}: {
  worksheet: CommissionReadyWorksheetModel;
  computed: { pool: number; rows: CommissionComputedRow[] };
  monthLong: string;
}) {
  const rows = computed.rows
    .filter((row) => row.jobCount > 0)
    .map((row) => ({
      name: `${row.displayName} · ${row.efficiencyRatio === null ? "not covered" : `${row.efficiencyRatio.toFixed(2)}×`}`,
      v: round2(row.final - row.post),
    }))
    .sort((a, b) => b.v - a.v);
  const extent = Math.max(...rows.map((row) => Math.abs(row.v)), 1) * 1.15;
  return (
    <Card
      title="Efficiency Effect"
      subtitle={
        <>
          Dollar impact of the efficiency adjustment on each payout ·{" "}
          <span className="repr" data-def={perTechRatioDef(worksheet)}>
            representative ratio
          </span>{" "}
          beside each name · the pool total is unchanged
        </>
      }
    >
      <CardBody>
        <DevBars
          rows={rows}
          refValue={0}
          min={-extent}
          max={extent}
          labelW={190}
          refLabel="$0 — no effect"
          fmt={(value) => (value >= 0 ? "+" : "−") + fmt.cents(Math.abs(value))}
          pos={SEG_EFF_UP}
          neg={EFF_NEG_BAR}
        />
        <Fnote>
          Ratio = Σ estimated ÷ Σ actual on{" "}
          <Def def="Quote-linked jobs only; not covered = neutral ×1.00. The ratio is linearly remapped from 0.5×–1.5× onto the ±max, and payouts are then re-scaled so the pool total is unchanged.">
            quote-linked {monthLong} jobs
          </Def>
          , remapped to the ±max — effects sum to $0 after re-scaling.
        </Fnote>
      </CardBody>
    </Card>
  );
}

/* ── Summary tab ───────────────────────────────────────── */

function SummaryTab({
  vm,
  mode,
  onMode,
  savedPoolPercent,
}: {
  vm: CommissionSummaryVM;
  mode: CommissionSummaryMode;
  onMode: (mode: CommissionSummaryMode) => void;
  savedPoolPercent: number;
}) {
  const loaded = vm.months.filter((month) => month.pool !== null);
  const draftMonths = vm.months.filter((month) => month.status === "draft");
  const download = () => {
    const blob = new Blob([buildSummaryCsv(vm, mode)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `commission-summary-${vm.year}-${mode}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Card
      title={`Commission Summary — ${vm.year}`}
      subtitle={`Pool per period at the saved ${savedPoolPercent.toFixed(2)}% setting`}
      aside={
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Seg
            dataSeg="summode"
            ariaLabel="Summary period mode"
            options={[
              { val: "monthly", label: "Monthly" },
              { val: "quarterly", label: "Quarterly" },
              { val: "annual", label: "Annual" },
            ]}
            value={mode}
            onChange={(value) => onMode(value as CommissionSummaryMode)}
          />
          <button type="button" className="ctl" style={{ height: 34, fontSize: 13.5 }} onClick={download}>
            <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path d="M12 3v12M7 10l5 5 5-5" />
              <path d="M4 19h16" />
            </svg>
            Download CSV
          </button>
        </div>
      }
    >
      <CardBody style={{ paddingBottom: 6 }}>
        <div className="strip">
          <span className="s">
            <span className="l">Average month</span>
            <span className="v">{vm.average !== null ? fmt.cents(vm.average) : "N/A"}</span>
          </span>
          <span className="s">
            <span className="l">Peak month</span>
            <span className="v">{vm.peak ? `${vm.peak.short} · ${fmt.cents(vm.peak.value)}` : "N/A"}</span>
          </span>
          <span className="s">
            <span className="l">Earning technicians · YTD</span>
            <span className="v">{vm.earningYtd !== null ? String(vm.earningYtd) : "N/A"}</span>
          </span>
        </div>
        {loaded.length === 0 ? (
          <StateEmpty>No finalized months yet for {vm.year} — KPIs render N/A, never $0.</StateEmpty>
        ) : (
          <div style={{ marginTop: 18 }}>
            <SummaryChart vm={vm} mode={mode} />
          </div>
        )}
      </CardBody>
      <div className="tblwrap">
        <table id="sumTable">
          <SummaryTable vm={vm} mode={mode} />
        </table>
      </div>
      <CardBody style={{ paddingTop: 4 }}>
        <Fnote style={{ marginTop: 0 }}>
          {draftMonths.length > 0 ? (
            <>
              {draftMonths[0].short}–{draftMonths[draftMonths.length - 1].short} pools are{" "}
              <span
                className="repr"
                data-def="Draft runs — recomputed on the recorded-hours worksheet before they become final; per-month history verification is pending."
              >
                draft runs
              </span>{" "}
              until recomputed on the recorded-hours worksheet; months without a run show N/A, never $0.
            </>
          ) : (
            <>Months without a run show N/A, never $0.</>
          )}
        </Fnote>
      </CardBody>
    </Card>
  );
}

function SummaryChart({ vm, mode }: { vm: CommissionSummaryVM; mode: CommissionSummaryMode }) {
  let buckets: HistogramBucket[];
  if (mode === "quarterly") {
    const quarters = summaryQuarters(vm).filter((quarter) => quarter.pool !== null);
    buckets = quarters.map((quarter, index) => ({
      label: quarter.label,
      count: quarter.pool ?? 0,
      accent: index === quarters.length - 1,
      tipLabel: `${quarter.label} ${vm.year} pool`,
    }));
  } else {
    // Monthly and annual views share the loaded-months histogram (ledger C10);
    // draft months carry the "(draft)" mark (C31).
    const loadedMonths = vm.months.filter((month) => month.pool !== null);
    buckets = loadedMonths.map((month) => ({
      label: month.short,
      count: month.pool ?? 0,
      accent: month.month === vm.lastLoadedMonth,
      tipLabel: `${month.short} ${vm.year} pool${month.status === "draft" ? " (draft)" : ""}`,
    }));
  }
  return <Histogram buckets={buckets} h={190} seriesName="Pool" valFmt={fmt.cents} yFmt={fmt.money} />;
}

function SummaryTable({ vm, mode }: { vm: CommissionSummaryVM; mode: CommissionSummaryMode }) {
  if (mode === "monthly") {
    const shown = vm.months.filter((month) => month.month <= vm.lastLoadedMonth);
    const remaining = vm.months.filter((month) => month.month > vm.lastLoadedMonth);
    return (
      <>
        <thead>
          <tr>
            <th>Month</th>
            <th className="num">Pool</th>
            <th className="num">Status</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((month) => (
            <tr key={month.month}>
              <td className="id1 tnum">{month.short} {vm.year}</td>
              <td className="num tnum" style={{ fontWeight: 700 }}>
                {month.pool !== null ? fmt.cents(month.pool) : "N/A"}
              </td>
              <td className="num">
                <SummaryStatusPill status={month.status} />
              </td>
            </tr>
          ))}
          {remaining.length > 0 ? (
            <tr>
              <td className="id1" style={{ color: "var(--subtle)", fontWeight: 500 }}>
                {remaining.length === 1
                  ? `${remaining[0].short} ${vm.year}`
                  : `${remaining[0].short}–${remaining[remaining.length - 1].short} ${vm.year}`}
              </td>
              <td className="num tnum" style={{ color: "var(--subtle)" }}>N/A</td>
              <td className="num">
                <span className="srcpill" style={{ opacity: 0.6 }}>No runs yet</span>
              </td>
            </tr>
          ) : null}
        </tbody>
      </>
    );
  }
  if (mode === "quarterly") {
    return (
      <>
        <thead>
          <tr>
            <th>Quarter</th>
            <th className="num">Pool</th>
            <th className="num">Months with a run</th>
          </tr>
        </thead>
        <tbody>
          {summaryQuarters(vm).map((quarter) => (
            <tr key={quarter.label}>
              <td className="id1 tnum">{quarter.label} {vm.year}</td>
              <td className="num tnum" style={{ fontWeight: 700 }}>
                {quarter.pool !== null ? fmt.cents(quarter.pool) : "N/A"}
              </td>
              <td className="num tnum">{quarter.loaded} of 3</td>
            </tr>
          ))}
        </tbody>
      </>
    );
  }
  const h1 = vm.months.slice(0, 6).filter((month) => month.pool !== null);
  const h2 = vm.months.slice(6).filter((month) => month.pool !== null);
  const half = (months: typeof h1) => (months.length ? round2(months.reduce((sum, month) => sum + (month.pool ?? 0), 0)) : null);
  const h1Pool = half(h1);
  const h2Pool = half(h2);
  return (
    <>
      <thead>
        <tr>
          <th>Year</th>
          <th className="num">H1 pool</th>
          <th className="num">H2 pool</th>
          <th className="num">Total</th>
          <th className="num hide-sm">Peak month</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className="id1 tnum">{vm.year} · {h1.length + h2.length} mo loaded</td>
          <td className="num tnum">{h1Pool !== null ? fmt.cents(h1Pool) : "N/A"}</td>
          <td className="num tnum">{h2Pool !== null ? fmt.cents(h2Pool) : "N/A"}</td>
          <td className="num tnum" style={{ fontWeight: 700 }}>{vm.ytd !== null ? fmt.cents(vm.ytd) : "N/A"}</td>
          <td className="num tnum hide-sm">{vm.peak ? `${vm.peak.short} · ${fmt.cents(vm.peak.value)}` : "N/A"}</td>
        </tr>
      </tbody>
    </>
  );
}

function SummaryStatusPill({ status }: { status: "current" | "draft" | "final" | "none" }) {
  if (status === "none") {
    return <span className="srcpill" style={{ opacity: 0.6 }}>No run</span>;
  }
  if (status === "draft") {
    return (
      <span
        className="srcpill def"
        data-def="Draft run — recomputed on the recorded-hours worksheet before it becomes final."
        style={{ background: "#faf3df", color: "#8a6a14" }}
      >
        Draft
      </span>
    );
  }
  if (status === "final") {
    return (
      <span className="srcpill def" data-def="Recomputed on the recorded-hours worksheet and reconciled — a finalized run.">
        Final
      </span>
    );
  }
  return <span className="srcpill">Current</span>;
}

/* ── Shared helpers ────────────────────────────────────── */

type AllocationBasis = { label: string; def: string; repr: boolean };

/** Allocation-basis disclosure: the mockups shipped with interim equal-split
 *  data (dotted amber repr mark); when the payload's allocations are real
 *  timesheet hours-shares the copy states that instead (contract map:
 *  "equal-split interim disclosed until timesheet hours-share verified"). */
function allocationBasis(rows: CommissionComputedRow[]): AllocationBasis {
  const byJob = new Map<string, number[]>();
  for (const row of rows) {
    for (const allocation of row.jobAllocations) {
      byJob.set(allocation.jobId, [...(byJob.get(allocation.jobId) ?? []), allocation.share]);
    }
  }
  const multiTech = [...byJob.values()].filter((shares) => shares.length > 1);
  const equalSplit = multiTech.length > 0
    && multiTech.every((shares) => shares.every((share) => Math.abs(share - shares[0]) < 1e-9));
  if (equalSplit) {
    return {
      label: "interim equal-split",
      repr: true,
      def: "Interim equal split of each job’s value among its assigned technicians — implementation allocates by exact timesheet hours per job.",
    };
  }
  return {
    label: "timesheet hours-share",
    repr: false,
    def: "Each job’s value is allocated by each technician’s share of the job’s mapped timesheet hours — every recorded hour counts.",
  };
}

function perTechRatioDef(worksheet: CommissionReadyWorksheetModel): string {
  const totals = worksheet.technicians.reduce(
    (sum, technician) => ({
      quoted: sum.quoted + (technician.efficiency?.quotedHours ?? 0),
      actual: sum.actual + (technician.efficiency?.actualHours ?? 0),
    }),
    { quoted: 0, actual: 0 },
  );
  const team = totals.actual > 0 ? totals.quoted / totals.actual : null;
  return team !== null
    ? `Per-technician ratios are representative until timesheet attribution is verified; the team ratio ${team.toFixed(2)}× is verified.`
    : "Per-technician ratios are representative until timesheet attribution is verified.";
}

function shareText(share: number): string {
  for (let denominator = 1; denominator <= 12; denominator += 1) {
    if (Math.abs(share - 1 / denominator) < 1e-6) return denominator === 1 ? "100%" : `1/${denominator}`;
  }
  const percent = share * 100;
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

function tierClass(tier: CommissionTier): "gold" | "silver" | "bronze" | "std" {
  if (tier === "Gold") return "gold";
  if (tier === "Silver") return "silver";
  if (tier === "Bronze") return "bronze";
  return "std";
}

/** "June 2026" → "June". */
function monthLongName(periodLabel: string): string {
  return periodLabel.split(" ")[0] ?? periodLabel;
}

/** "June 2026" → "Jun". */
function monthShortName(periodLabel: string): string {
  return monthLongName(periodLabel).slice(0, 3);
}

/** "2026-07-01" shifted by n months → "Jun ’26" / "Jul ’25". */
function shiftedSeriesName(periodStart: string, shiftMonths: number): string {
  const [year, month] = periodStart.split("-").map(Number);
  if (!year || !month) return periodStart;
  const date = new Date(Date.UTC(year, month - 1 + shiftMonths, 1));
  const mon = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  return `${mon} ’${String(date.getUTCFullYear()).slice(2)}`;
}

function exactShares(totalCents: number, entries: Array<{ id: string; weight: number }>): Map<string, number> {
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  return new Map(entries.map((entry) => [entry.id, totalWeight > 0 ? (totalCents * entry.weight) / totalWeight : 0]));
}

function tierForRank(rank: number): CommissionTier {
  if (rank === 1) return "Gold";
  if (rank === 2) return "Silver";
  if (rank === 3) return "Bronze";
  return "Standard";
}

function isCommissionTier(value: string): value is CommissionTier {
  return value === "Gold" || value === "Silver" || value === "Bronze" || value === "Standard";
}

function compareNumericIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const numericLeft = BigInt(left);
    const numericRight = BigInt(right);
    if (numericLeft < numericRight) return -1;
    if (numericLeft > numericRight) return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function toCents(value: number): number {
  return Math.round((value + Math.sign(value) * Number.EPSILON) * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

import type { CommissionPeriodConfig } from "@/lib/metrics/commissions";
import { isAllowedSessionOwner } from "@/lib/auth/session-principal";
import {
  commissionCanonicalRunSelect,
  commissionHashJson,
  commissionStableJson,
  isCommissionSha256,
  validateCommissionConfigValue,
  verifyCommissionCanonicalRun,
  type CommissionCanonicalRunRow,
} from "@/lib/store/commission-integrity";
import { parseCommissionOverride } from "@/lib/store/commission-lifecycle";
import {
  prerequisiteConflictMessages,
  readCommissionInitializationPrerequisites,
} from "@/lib/store/commission-initialization-prerequisites";
import {
  withPostgresTransaction,
  type PostgresQuery,
} from "@/lib/store/postgres";

export const COMMISSION_INITIALIZATION_START_MONTH = "2023-01";
export const COMMISSION_INITIALIZATION_VERSION = "commission-period-initialization-v2";
export const COMMISSION_INITIALIZATION_QUEUE_REASON = "Historical commission period initialization v2 from locked evidence";
export const LOCKED_COMMISSION_CONFIG_HASH = "719dd0fb880a4ffd7447f35a97b8989a0c9bbf1350071edbcc5fb708ffa574fc";

export const LOCKED_COMMISSION_CONFIG: CommissionPeriodConfig = Object.freeze({
  poolPercent: 0.5,
  minBonusPercent: 5,
  efficiencyEnabled: false,
  maxEfficiencyAdjustmentPercent: 20,
  tierMultipliers: Object.freeze({ Gold: 1.3, Silver: 1.2, Bronze: 1.1, Standard: 1 }),
});

export const LOCKED_COMMISSION_POLICY_EVIDENCE = Object.freeze({
  priorDashboard: Object.freeze({
    path: "docs/prostar-metrics/reference/commissions-dashboard.html",
    sha256: "037b1f6e0e5b7a4156a8eee8180307e92dfc3f0f17b8f19b5ea7011f2852538b",
    configLines: "603-610",
    rosterLines: "613-623",
  }),
  lockedPlan: Object.freeze({
    path: "docs/prostar-metrics/execution-plan.md",
    sha256: "7392ad68fb810b840175604291a9b43cb57a3a4dce23de546f3e1c057abca3e5",
    section: "6.4 Technician Commissions",
  }),
  rosterMigration: Object.freeze({
    path: "infra/db/migrations/009_commission_roster_seed.sql",
    sha256: "3601b7b7dbf0031f59828600ef4726cf616006c79875a2c3ac9b923d3c8599b5",
  }),
  configMigrations: Object.freeze([
    Object.freeze({
      path: "infra/db/migrations/019_seed_verified_commission_period_configs.sql",
      sha256: "32a9947998e3e8c7e7f0403ef87b18ca53b2536d78a1a4892d738ef3cf5a5f60",
    }),
    Object.freeze({
      path: "infra/db/migrations/025_upgrade_verified_commission_tier_config.sql",
      sha256: "68437467608d41cfe828a03c9f5a2637b079a6feb0dc6a5169a96f6446bc1178",
    }),
  ]),
  integrityMigration: Object.freeze({
    path: "infra/db/migrations/036_commission_initialization_integrity.sql",
    sha256: "98e180287fb96ace8237581e3d658a6bc6ace07c92ccef7e66ee854a5462db58",
  }),
});

const REQUIRED_MIGRATIONS = Object.freeze([
  Object.freeze({ filename: "009_commission_roster_seed.sql", sha256: LOCKED_COMMISSION_POLICY_EVIDENCE.rosterMigration.sha256 }),
  Object.freeze({ filename: "015_commission_manifest_evidence.sql", sha256: "7fd57801f3786b6c508183f53569a25beba072920064eda8be38961979d1beab" }),
  Object.freeze({ filename: "019_seed_verified_commission_period_configs.sql", sha256: LOCKED_COMMISSION_POLICY_EVIDENCE.configMigrations[0].sha256 }),
  Object.freeze({ filename: "025_upgrade_verified_commission_tier_config.sql", sha256: LOCKED_COMMISSION_POLICY_EVIDENCE.configMigrations[1].sha256 }),
  Object.freeze({ filename: "036_commission_initialization_integrity.sql", sha256: LOCKED_COMMISSION_POLICY_EVIDENCE.integrityMigration.sha256 }),
]);

const LOCKED_ROSTER_NOTES = "Eligibility and effective date seeded from the prior Pro Star commissions dashboard EMPLOYEES configuration.";
const LOCKED_ROSTER_AUDIT_REASON = "Seed effective-dated commission eligibility from the prior commissions dashboard evidence.";
const LOCKED_ROSTER = Object.freeze([
  { employeeId: "17", displayName: "Rob Sires", effectiveStart: "2007-08-23" },
  { employeeId: "134", displayName: "Roberto Villalta", effectiveStart: "2022-11-21" },
  { employeeId: "168", displayName: "Ernie Hernandez", effectiveStart: "2023-03-08" },
  { employeeId: "205", displayName: "Juan Serrato", effectiveStart: "2023-12-06" },
  { employeeId: "209", displayName: "Justin Molina", effectiveStart: "2024-05-08" },
  { employeeId: "216", displayName: "Jeffrey Perry", effectiveStart: "2025-04-21" },
  { employeeId: "251", displayName: "Erick Eudave", effectiveStart: "2025-09-18" },
  { employeeId: "252", displayName: "Cole Bender", effectiveStart: "2025-10-13" },
  { employeeId: "253", displayName: "Victor Contreras", effectiveStart: "2025-11-17" },
]);

const INITIALIZATION_ACTION = "commission_period_historical_initialization_evidenced";
const INITIALIZATION_REASON = "Initialize the monthly commission period from locked prior-dashboard config and effective-dated roster evidence without changing existing commission policy or overrides.";
const LOCKED_CONFIG_REASON = "Initialized from locked prior-dashboard commission policy evidence.";
const MIGRATION_019_CONFIG_HASH = "5966f042954aea4d9e8d7499655b76f7d4df9748693972cd386a8a7fb6735553";
const MIGRATION_019_CONFIG = Object.freeze({
  poolPercent: 0.5,
  minBonusPercent: 5,
  efficiencyEnabled: false,
  maxEfficiencyAdjustmentPercent: 20,
});
const MIGRATION_019_REASON = "Persist period-effective evidence for the commission config already specified by the authoritative prior dashboard and locked implementation plan.";
const MIGRATION_025_REASON = "Added the locked default tier multipliers to the verified prior-dashboard config and queued an immutable recalculation.";
const OVERRIDE_VALUE_TYPES: Record<string, string> = {
  included: "boolean",
  allocated_value: "number",
  final_bonus: "number",
  inside_pool_adjustment: "number",
  outside_pool_adjustment: "number",
  tier: "tier",
  notes: "string",
};

type TransactionRunner = <T>(callback: (query: PostgresQuery) => Promise<T>) => Promise<T>;

type PeriodRow = {
  id: string;
  period_start: string;
  period_end: string;
  status: string;
  config: unknown;
  revision: number;
  edit_revision: number;
  config_revision: number;
  current_run_id: string | null;
  current_run_period_id: string | null;
  supersedes_period_id: string | null;
  calculation_stale: boolean;
  created_by: string;
  revision_reason: string | null;
};

type ConfigRow = {
  period_id: string;
  revision: number;
  pool_pct: string;
  min_bonus_pct: string;
  efficiency_enabled: boolean;
  max_efficiency_adjustment_pct: string;
  on_time_threshold_minutes: number;
  config_json: unknown;
  config_hash: string;
  actor_email: string;
  active: boolean;
  superseded_at: string | null;
  idempotency_key: string | null;
};

type ConfigAuditRow = {
  id: string;
  entity_id: string;
  action: string;
  actor_email: string;
  before_value: unknown;
  after_value: unknown;
  reason: string | null;
};

type RosterRow = {
  id: string;
  employee_id: string;
  display_name: string;
  included: boolean;
  tier: string;
  effective_start: string;
  effective_end: string | null;
  notes: string | null;
  seed_audit_count: number;
  seed_audit_id: string | null;
  seed_audit_actor: string | null;
  seed_audit_after: unknown;
  seed_audit_reason: string | null;
};

type QueueRow = {
  id: string;
  metric_family: string;
  period_grain: string;
  period_start: string;
  dimensions_json: unknown;
  reason: string;
  status: string;
  idempotency_key: string;
  created_at: string;
  identity_valid: boolean;
};

type InitializationAuditRow = {
  id: string;
  entity_id: string;
  actor_email: string;
  before_value: unknown;
  after_value: unknown;
  reason: string | null;
};

type OverrideRow = {
  id: string;
  period_id: string;
  period_revision: number;
  employee_id: string;
  field_name: string;
  before_value: unknown;
  after_value: unknown;
  value_type: string;
  reason: string;
  evidence_url: string | null;
  actor_email: string;
  pool_treatment: string;
  revision: number;
  active: boolean;
  superseded_at: string | null;
  idempotency_key: string | null;
  created_at: string;
};

type OverrideAuditRow = {
  id: string;
  entity_id: string;
  actor_email: string;
  before_value: unknown;
  after_value: unknown;
  reason: string | null;
};

type QueueIdentity = {
  id: string;
  metricFamily: "commissions";
  periodGrain: "month";
  periodStart: string;
  dimensions: Record<string, never>;
  reason: string;
  idempotencyKey: string;
  createdAt: string;
};

type OverrideEvidence = {
  overrideCount: number;
  effectiveOverrideCount: number;
  overrideHash: string;
  overrideRowIds: string[];
  overrideAuditIds: string[];
};

export type CommissionPeriodInitializationPlanItem = {
  month: string;
  periodStart: string;
  periodEnd: string;
  periodId: string | null;
  periodRevision: number;
  periodAction: "create" | "preserve";
  configAction: "insert_locked" | "preserve";
  configHash: string;
  configEvidenceActor: string;
  rosterHash: string;
  rosterRowIds: string[];
  rosterEntries: number;
  overridesPreserved: number;
  effectiveOverrides: number;
  overrideHash: string;
  overrideRowIds: string[];
  overrideAuditIds: string[];
  runIntegrity: "missing" | "invalid" | "publishable";
  runIntegrityDetail: string | null;
  rebuildAction: "enqueue" | "use_existing" | "not_needed";
  rebuildQueue: QueueIdentity | null;
  auditAction: "write" | "preserve";
};

export type CommissionPeriodInitializationReport = {
  mode: "dry-run" | "execute";
  actorEmail: string;
  startMonth: string;
  throughMonth: string;
  monthCount: number;
  confirmationToken: string;
  evidence: typeof LOCKED_COMMISSION_POLICY_EVIDENCE & { lockedConfigHash: string };
  summary: {
    periodsToCreate: number;
    configsToEvidence: number;
    evidenceAuditsToWrite: number;
    rebuildsToQueue: number;
    rebuildsAlreadyQueued: number;
    publishablePeriodsPreserved: number;
    overridesPreserved: number;
    writesApplied: number;
  };
  periods: CommissionPeriodInitializationPlanItem[];
};

export class CommissionPeriodInitializationConflictError extends Error {
  readonly conflicts: string[];

  constructor(conflicts: string[]) {
    super(`Commission period initialization refused:\n- ${conflicts.join("\n- ")}`);
    this.name = "CommissionPeriodInitializationConflictError";
    this.conflicts = conflicts;
  }
}

export function currentPacificMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Unable to resolve the current Pacific month.");
  return `${year}-${month}`;
}

export function resolveCommissionInitializationMonth(value: string, now = new Date()): string {
  const current = currentPacificMonth(now);
  const normalized = value.trim().toLowerCase() === "current" ? current : value.trim();
  assertMonthKey(normalized);
  if (normalized < COMMISSION_INITIALIZATION_START_MONTH) {
    throw new Error(`--through must be ${COMMISSION_INITIALIZATION_START_MONTH} or later.`);
  }
  if (normalized > current) {
    throw new Error(`--through cannot be later than the current Pacific month ${current}.`);
  }
  return normalized;
}

export function commissionInitializationConfirmationToken(throughMonth: string): string {
  assertMonthKey(throughMonth);
  return `INITIALIZE-COMMISSION-PERIODS-${COMMISSION_INITIALIZATION_START_MONTH}-THROUGH-${throughMonth}`;
}

export function commissionInitializationQueueKey(periodStart: string): string {
  return `commissions:month:${periodStart}:${COMMISSION_INITIALIZATION_VERSION}`;
}

export function normalizeCommissionInitializationActor(actorEmail: string): string {
  const normalized = actorEmail.trim().toLowerCase();
  if (!isAllowedSessionOwner(normalized)) {
    throw new Error("--actor must be exactly asad@prostarmechanical.com or laila@prostarmechanical.com.");
  }
  return normalized;
}

export async function initializeHistoricalCommissionPeriods(
  params: {
    throughMonth: string;
    actorEmail: string;
    execute?: boolean;
    confirmation?: string;
  },
  transaction: TransactionRunner = withPostgresTransaction,
): Promise<CommissionPeriodInitializationReport> {
  const throughMonth = resolveCommissionInitializationMonth(params.throughMonth);
  const actorEmail = normalizeCommissionInitializationActor(params.actorEmail);
  const confirmationToken = commissionInitializationConfirmationToken(throughMonth);
  const execute = params.execute === true;
  if (execute && params.confirmation !== confirmationToken) {
    throw new Error(`Execution requires --confirm ${confirmationToken}.`);
  }
  assertLockedConfigEvidence();

  const run = () => transaction(async (query) => {
    if (execute) {
      await query("set transaction isolation level serializable");
      await query("set local statement_timeout = '120s'");
      await query("set local lock_timeout = '10s'");
      await query("select pg_advisory_xact_lock(hashtextextended('metrics:historical-commission-period-initialization', 0))");
    } else {
      await query("set transaction isolation level repeatable read, read only");
      await query("set local statement_timeout = '120s'");
    }
    const plan = await buildPlan(query, throughMonth, actorEmail);
    if (plan.conflicts.length > 0) throw new CommissionPeriodInitializationConflictError(plan.conflicts);

    let writesApplied = 0;
    if (execute) {
      const prerequisites = await readCommissionInitializationPrerequisites(
        COMMISSION_INITIALIZATION_START_MONTH,
        throughMonth,
        query,
      );
      if (!prerequisites.ready) {
        throw new CommissionPeriodInitializationConflictError(prerequisiteConflictMessages(prerequisites));
      }
      for (const item of plan.items) writesApplied += await executePlanItem(query, item, actorEmail);
    }
    return buildReport({ actorEmail, throughMonth, confirmationToken, execute, items: plan.items, writesApplied });
  });

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!execute || attempt >= 3 || !isSerializationFailure(error)) throw error;
    }
  }
}

async function buildPlan(query: PostgresQuery, throughMonth: string, actorEmail: string) {
  const months = monthRange(COMMISSION_INITIALIZATION_START_MONTH, throughMonth);
  const rangeStart = `${COMMISSION_INITIALIZATION_START_MONTH}-01`;
  const rangeEnd = monthBounds(throughMonth).periodEnd;
  const expectedQueueKeys = months.map((month) => commissionInitializationQueueKey(`${month}-01`));
  const [migrationRows, periods, configs, configAudits, roster, queues, audits, overrides, overrideAudits, canonicalRows, prerequisites] = await Promise.all([
    query<{ filename: string; sha256: string }>(
      `select filename, sha256 from metrics.schema_migrations where filename = any($1::text[]) order by filename`,
      [REQUIRED_MIGRATIONS.map((migration) => migration.filename)],
    ),
    query<PeriodRow>(
      `select p.id::text, p.period_start::text, p.period_end::text, p.status::text,
              p.config, p.revision, p.edit_revision, p.config_revision,
              p.current_run_id::text, r.period_id::text as current_run_period_id,
              p.supersedes_period_id::text, p.calculation_stale,
              lower(p.created_by) as created_by, p.revision_reason
         from metrics.commission_periods p
         left join metrics.commission_calculation_runs r on r.id = p.current_run_id
        where p.period_start >= $1::date and p.period_start <= $2::date
        order by p.period_start, p.revision, p.id`,
      [rangeStart, rangeEnd],
    ),
    query<ConfigRow>(
      `select c.period_id::text, c.revision, c.pool_pct::text, c.min_bonus_pct::text,
              c.efficiency_enabled, c.max_efficiency_adjustment_pct::text,
              c.on_time_threshold_minutes, c.config_json, c.config_hash,
              lower(c.actor_email) as actor_email, c.active, c.superseded_at::text,
              c.idempotency_key
         from metrics.commission_period_configs c
         join metrics.commission_periods p on p.id = c.period_id
        where p.period_start >= $1::date and p.period_start <= $2::date
        order by c.period_id, c.revision`,
      [rangeStart, rangeEnd],
    ),
    query<ConfigAuditRow>(
      `select a.id::text, a.entity_id, a.action, lower(a.actor_email) as actor_email,
              a.before_value, a.after_value, a.reason
         from metrics.audit_events a
         join metrics.commission_periods p on p.id::text = a.entity_id
        where a.entity_type = 'commission_period'
          and a.action in (
            'commission_period_config_evidence_seeded',
            'commission_tier_config_upgraded',
            'commission_config_revised'
          )
          and p.period_start >= $1::date and p.period_start <= $2::date
        order by p.period_start, a.id`,
      [rangeStart, rangeEnd],
    ),
    query<RosterRow>(
      `select r.id::text, r.employee_id::text, r.display_name, r.included, r.tier,
              r.effective_start::text, r.effective_end::text, r.notes,
              (select count(*)::int from metrics.audit_events a
                where a.entity_type = 'commission_roster' and a.entity_id = r.id::text
                  and a.action = 'commission_roster_seeded') as seed_audit_count,
              (select a.id::text from metrics.audit_events a
                where a.entity_type = 'commission_roster' and a.entity_id = r.id::text
                  and a.action = 'commission_roster_seeded' order by a.id limit 1) as seed_audit_id,
              (select lower(a.actor_email) from metrics.audit_events a
                where a.entity_type = 'commission_roster' and a.entity_id = r.id::text
                  and a.action = 'commission_roster_seeded' order by a.id limit 1) as seed_audit_actor,
              (select a.after_value from metrics.audit_events a
                where a.entity_type = 'commission_roster' and a.entity_id = r.id::text
                  and a.action = 'commission_roster_seeded' order by a.id limit 1) as seed_audit_after,
              (select a.reason from metrics.audit_events a
                where a.entity_type = 'commission_roster' and a.entity_id = r.id::text
                  and a.action = 'commission_roster_seeded' order by a.id limit 1) as seed_audit_reason
         from metrics.commission_roster r
        where r.effective_start <= $2::date
          and (r.effective_end is null or r.effective_end >= $1::date)
        order by r.employee_id, r.effective_start, r.id`,
      [rangeStart, rangeEnd],
    ),
    query<QueueRow>(
      `select q.id::text, q.metric_family, q.period_grain, q.period_start::text,
              q.dimensions_json, q.reason, q.status::text, q.idempotency_key,
              to_char(q.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
              (q.metric_family = 'commissions'
                and q.period_grain = 'month'
                and q.dimensions_json = '{}'::jsonb
                and q.reason = $2
                and q.created_at >= migration.applied_at) as identity_valid
         from metrics.rollup_rebuild_queue q
         cross join metrics.schema_migrations migration
        where migration.filename = '036_commission_initialization_integrity.sql'
          and q.idempotency_key = any($1::text[])
        order by q.period_start, q.id`,
      [expectedQueueKeys, COMMISSION_INITIALIZATION_QUEUE_REASON],
    ),
    query<InitializationAuditRow>(
      `select a.id::text, a.entity_id, lower(a.actor_email) as actor_email,
              a.before_value, a.after_value, a.reason
         from metrics.audit_events a
         join metrics.commission_periods p on p.id::text = a.entity_id
        where a.entity_type = 'commission_period' and a.action = $3
          and p.period_start >= $1::date and p.period_start <= $2::date
        order by p.period_start, a.id`,
      [rangeStart, rangeEnd, INITIALIZATION_ACTION],
    ),
    query<OverrideRow>(
      `select o.id::text, o.period_id::text, p.revision as period_revision,
              o.employee_id::text, o.field_name, o.before_value, o.after_value,
              o.value_type, o.reason, o.evidence_url, lower(o.actor_email) as actor_email,
              o.pool_treatment, o.revision, o.active, o.superseded_at::text,
              o.idempotency_key, o.created_at::text
         from metrics.commission_overrides o
         join metrics.commission_periods p on p.id = o.period_id
        where p.period_start >= $1::date and p.period_start <= $2::date
        order by p.period_start, o.employee_id, o.field_name, o.revision, o.id`,
      [rangeStart, rangeEnd],
    ),
    query<OverrideAuditRow>(
      `select a.id::text, a.entity_id, lower(a.actor_email) as actor_email,
              a.before_value, a.after_value, a.reason
         from metrics.audit_events a
         join metrics.commission_periods p on p.id::text = a.entity_id
        where a.entity_type = 'commission_period'
          and a.action = 'commission_override_revised'
          and p.period_start >= $1::date and p.period_start <= $2::date
        order by p.period_start, a.id`,
      [rangeStart, rangeEnd],
    ),
    query<CommissionCanonicalRunRow>(
      `${commissionCanonicalRunSelect()}
        where p.period_start >= $1::date and p.period_start <= $2::date
          and (p.current_run_id is null or r.period_id = p.id)
        order by p.period_start, p.revision, p.id`,
      [rangeStart, rangeEnd],
    ),
    readCommissionInitializationPrerequisites(COMMISSION_INITIALIZATION_START_MONTH, throughMonth, query),
  ]);

  const conflicts = validateMigrationBaseline(migrationRows.rows);
  conflicts.push(...prerequisiteConflictMessages(prerequisites));
  conflicts.push(...validateRosterEvidence(roster.rows, throughMonth));
  const periodsByStart = groupBy(periods.rows, (row) => row.period_start);
  const configsByPeriod = groupBy(configs.rows, (row) => row.period_id);
  const configAuditsByPeriod = groupBy(configAudits.rows, (row) => row.entity_id);
  const queuesByStart = groupBy(queues.rows, (row) => row.period_start);
  const auditsByPeriod = groupBy(audits.rows, (row) => row.entity_id);
  const overridesByPeriod = groupBy(overrides.rows, (row) => row.period_id);
  const overrideAuditsByPeriod = groupBy(overrideAudits.rows, (row) => row.entity_id);
  const canonicalByPeriod = new Map(canonicalRows.rows.map((row) => [row.period_id, row]));

  for (const period of periods.rows) {
    if (!months.includes(period.period_start.slice(0, 7)) || period.period_start !== `${period.period_start.slice(0, 7)}-01`) {
      conflicts.push(`Unexpected non-monthly commission period starts on ${period.period_start}.`);
    }
  }

  const items: CommissionPeriodInitializationPlanItem[] = [];
  for (const month of months) {
    const bounds = monthBounds(month);
    const revisions = [...(periodsByStart.get(bounds.periodStart) ?? [])]
      .sort((left, right) => left.revision - right.revision || compareIds(left.id, right.id));
    conflicts.push(...validatePeriodRevisionChain(month, bounds.periodEnd, revisions));
    const period = revisions.at(-1) ?? null;
    const periodConfigs = revisions.flatMap((revision) => configsByPeriod.get(revision.id) ?? []);
    const periodConfigAudits = revisions.flatMap((revision) => configAuditsByPeriod.get(revision.id) ?? []);
    const configResolution = resolveConfig(
      month,
      period,
      periodConfigs,
      periodConfigAudits,
    );
    conflicts.push(...configResolution.conflicts);

    const effectiveRoster = roster.rows.filter((row) =>
      row.effective_start <= bounds.periodEnd
      && (row.effective_end === null || row.effective_end >= bounds.periodStart));
    if (effectiveRoster.length === 0) conflicts.push(`${month} has no authoritative effective commission roster rows.`);
    const rosterHash = hashRoster(effectiveRoster);
    const monthOverrides = revisions.flatMap((revision) => overridesByPeriod.get(revision.id) ?? []);
    const monthOverrideAudits = revisions.flatMap((revision) => overrideAuditsByPeriod.get(revision.id) ?? []);
    const overrideResolution = validateOverrideEvidence(month, monthOverrides, monthOverrideAudits, effectiveRoster);
    conflicts.push(...overrideResolution.conflicts);

    const runResolution = resolveRunIntegrity(period, canonicalByPeriod);
    const monthQueues = queuesByStart.get(bounds.periodStart) ?? [];
    const queueResolution = resolveQueue(bounds.periodStart, runResolution.state === "publishable", monthQueues);
    conflicts.push(...queueResolution.conflicts);

    const draftItem: CommissionPeriodInitializationPlanItem = {
      month,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
      periodId: period?.id ?? null,
      periodRevision: period?.revision ?? 1,
      periodAction: period ? "preserve" : "create",
      configAction: configResolution.action,
      configHash: configResolution.configHash,
      configEvidenceActor: configResolution.actor ?? actorEmail,
      rosterHash,
      rosterRowIds: effectiveRoster.map((row) => row.id),
      rosterEntries: effectiveRoster.length,
      overridesPreserved: overrideResolution.evidence.overrideCount,
      effectiveOverrides: overrideResolution.evidence.effectiveOverrideCount,
      overrideHash: overrideResolution.evidence.overrideHash,
      overrideRowIds: overrideResolution.evidence.overrideRowIds,
      overrideAuditIds: overrideResolution.evidence.overrideAuditIds,
      runIntegrity: runResolution.state,
      runIntegrityDetail: runResolution.detail,
      rebuildAction: queueResolution.action,
      rebuildQueue: queueResolution.queue,
      auditAction: "write",
    };
    const periodAudits = period ? auditsByPeriod.get(period.id) ?? [] : [];
    const auditResolution = resolveAudit({
      item: draftItem,
      period,
      config: configResolution.activeConfig,
      audits: periodAudits,
      monthQueues,
    });
    conflicts.push(...auditResolution.conflicts);
    items.push({ ...draftItem, auditAction: auditResolution.action });
  }
  return { conflicts, items };
}

function validateMigrationBaseline(rows: Array<{ filename: string; sha256: string }>): string[] {
  const conflicts: string[] = [];
  const byFilename = new Map(rows.map((row) => [row.filename, row.sha256]));
  for (const migration of REQUIRED_MIGRATIONS) {
    const actual = byFilename.get(migration.filename);
    if (!actual) conflicts.push(`Required applied migration ${migration.filename} is missing from metrics.schema_migrations.`);
    else if (actual !== migration.sha256) conflicts.push(`Applied migration ${migration.filename} hash conflicts with the locked repository baseline.`);
  }
  return conflicts;
}

function validateRosterEvidence(rows: RosterRow[], throughMonth: string): string[] {
  const conflicts: string[] = [];
  const expected = LOCKED_ROSTER.filter((row) => row.effectiveStart <= monthBounds(throughMonth).periodEnd);
  for (const locked of expected) {
    const matches = rows.filter((row) => row.employee_id === locked.employeeId && row.effective_start === locked.effectiveStart);
    if (matches.length !== 1) {
      conflicts.push(`Locked roster evidence for employee ${locked.employeeId} at ${locked.effectiveStart} is ${matches.length === 0 ? "missing" : "duplicated"}.`);
      continue;
    }
    const row = matches[0];
    const expectedAudit = {
      employeeId: Number(locked.employeeId),
      displayName: locked.displayName,
      included: true,
      effectiveStart: locked.effectiveStart,
    };
    if (
      row.display_name !== locked.displayName
      || row.included !== true
      || row.tier.toLowerCase() !== "standard"
      || row.effective_end !== null
      || row.notes !== LOCKED_ROSTER_NOTES
      || row.seed_audit_count !== 1
      || !row.seed_audit_id
      || row.seed_audit_actor !== "system:migration-009"
      || !sameJson(row.seed_audit_after, expectedAudit)
      || row.seed_audit_reason !== LOCKED_ROSTER_AUDIT_REASON
    ) {
      conflicts.push(`Locked roster row ${row.id} for employee ${locked.employeeId} conflicts with migration 009 and prior-dashboard evidence.`);
    }
  }
  const expectedIdentities = new Set(expected.map((row) => `${row.employeeId}:${row.effectiveStart}`));
  for (const row of rows) {
    if (!expectedIdentities.has(`${row.employee_id}:${row.effective_start}`)) {
      conflicts.push(`Roster row ${row.id} (${row.employee_id}, ${row.effective_start}) has no authoritative locked evidence for this initialization range.`);
    }
  }
  return conflicts;
}

function validatePeriodRevisionChain(month: string, expectedEnd: string, rows: PeriodRow[]): string[] {
  const conflicts: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.period_end !== expectedEnd) conflicts.push(`${month} period ${row.id} ends ${row.period_end}; expected ${expectedEnd}.`);
    if (row.revision !== index + 1) conflicts.push(`${month} period revision chain is not contiguous from revision 1.`);
    const expectedParent = index === 0 ? null : rows[index - 1].id;
    if (row.supersedes_period_id !== expectedParent) {
      conflicts.push(`${month} period revision ${row.revision} does not supersede the preceding revision.`);
    }
  }
  return conflicts;
}

function resolveConfig(
  month: string,
  period: PeriodRow | null,
  rows: ConfigRow[],
  audits: ConfigAuditRow[],
) {
  const conflicts: string[] = [];
  if (!period) {
    return {
      action: "insert_locked" as const,
      configHash: LOCKED_COMMISSION_CONFIG_HASH,
      actor: "system:migration-025",
      activeConfig: null,
      conflicts,
    };
  }

  const rowsByPeriod = groupBy(rows, (row) => row.period_id);
  const auditsByPeriod = groupBy(audits, (audit) => audit.entity_id);
  for (const [periodId, chain] of rowsByPeriod) {
    conflicts.push(...validateAuthenticatedConfigChain(
      month,
      periodId,
      chain,
      auditsByPeriod.get(periodId) ?? [],
    ));
  }
  for (const audit of audits) {
    if (!rowsByPeriod.has(audit.entity_id)) {
      conflicts.push(`${month} config approval audit ${audit.id} has no period-effective config chain.`);
    }
  }
  const latestRows = rows.filter((row) => row.period_id === period.id);
  const active = latestRows.filter((row) => row.active);
  if (active.length === 0) {
    if (latestRows.length > 0) conflicts.push(`${month} latest period has config history but no active config; refusing to reactivate or replace history.`);
    if (period.config_revision !== 1) conflicts.push(`${month} latest period lacks active config evidence at non-initial config revision ${period.config_revision}.`);
    if (!["draft", "reviewed"].includes(period.status)) conflicts.push(`${month} ${period.status} period lacks active locked config evidence and cannot be mutated.`);
    if (period.current_run_id !== null) conflicts.push(`${month} has a current calculation run but no active config evidence.`);
    if (!sameLockedConfig(period.config)) conflicts.push(`${month} period config differs from locked evidence and has no approved period-effective config row.`);
    return {
      action: "insert_locked" as const,
      configHash: LOCKED_COMMISSION_CONFIG_HASH,
      actor: "system:migration-025",
      activeConfig: null,
      conflicts,
    };
  }
  if (active.length !== 1) {
    conflicts.push(`${month} has multiple active period-effective config rows.`);
    return { action: "preserve" as const, configHash: active[0]?.config_hash ?? "", actor: active[0]?.actor_email ?? null, activeConfig: active[0] ?? null, conflicts };
  }
  const config = active[0];
  if (config.revision !== period.config_revision) conflicts.push(`${month} active config revision does not match the period config revision.`);
  if (!sameLockedConfig(period.config)) conflicts.push(`${month} period config is not the exact repository-authenticated locked config.`);
  if (!isLockedConfigRow(config)) conflicts.push(`${month} latest active config is not the locked migration-025 formula with efficiency disabled.`);
  return { action: "preserve" as const, configHash: config.config_hash, actor: config.actor_email, activeConfig: config, conflicts };
}

function validateAuthenticatedConfigChain(
  month: string,
  periodId: string,
  chain: ConfigRow[],
  audits: ConfigAuditRow[],
): string[] {
  const conflicts: string[] = [];
  const ordered = [...chain].sort((left, right) => left.revision - right.revision);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].revision !== ordered[index - 1].revision + 1) {
      conflicts.push(`${month} config chain for period ${periodId} is not contiguous.`);
    }
  }
  const active = ordered.filter((row) => row.active);
  if (active.length !== 1 || active[0] !== ordered.at(-1)) {
    conflicts.push(`${month} config chain for period ${periodId} must have exactly one active latest revision.`);
  }
  for (const row of ordered) {
    if (row.active === (row.superseded_at !== null)) {
      conflicts.push(`${month} config revision ${row.revision} has inconsistent active/supersession state.`);
    }
  }

  if (ordered.length !== 2) {
    conflicts.push(`${month} config history is not the exact migration-019 to migration-025 revision chain.`);
    return conflicts;
  }
  const [predecessor, locked] = ordered;
  if (!isMigration019ConfigRow(predecessor, month) || predecessor.active || !predecessor.superseded_at) {
    conflicts.push(`${month} inactive config revision ${predecessor.revision} is not the exact authenticated migration-019 predecessor.`);
  }
  if (!isLockedConfigRow(locked)
      || locked.actor_email !== "system:migration-025"
      || locked.idempotency_key !== `verified-tier-config:025:${periodId}`
      || !locked.active
      || locked.superseded_at !== null) {
    conflicts.push(`${month} active config revision ${locked.revision} is not the exact authenticated migration-025 locked config.`);
  }
  const audit019 = audits.filter((audit) => audit.action === "commission_period_config_evidence_seeded");
  const audit025 = audits.filter((audit) => audit.action === "commission_tier_config_upgraded");
  const unexpected = audits.filter((audit) => ![
    "commission_period_config_evidence_seeded",
    "commission_tier_config_upgraded",
  ].includes(audit.action));
  if (audit019.length !== 1 || !isMigration019ConfigAudit(audit019[0], periodId, month, predecessor)) {
    conflicts.push(`${month} migration-019 config predecessor lacks its exact immutable repository evidence audit.`);
  }
  if (audit025.length !== 1 || !isMigration025ConfigAudit(audit025[0], periodId, locked)) {
    conflicts.push(`${month} migration-025 locked config lacks its exact immutable supersession audit.`);
  }
  if (unexpected.length > 0 || audits.length !== 2) {
    conflicts.push(`${month} config chain has unsupported owner or duplicate approval audit history; runtime config audits do not carry source evidence sufficient for initialization.`);
  }
  return conflicts;
}

function isMigration019ConfigRow(row: ConfigRow, month: string): boolean {
  return sameJson(row.config_json, MIGRATION_019_CONFIG)
    && row.config_hash === MIGRATION_019_CONFIG_HASH
    && Number(row.pool_pct) === 0.5
    && Number(row.min_bonus_pct) === 5
    && row.efficiency_enabled === false
    && Number(row.max_efficiency_adjustment_pct) === 20
    && row.on_time_threshold_minutes === 15
    && row.actor_email === "system:migration-019"
    && row.idempotency_key === `verified-prior-dashboard-config:${month}-01`;
}

function isLockedConfigRow(row: ConfigRow): boolean {
  return sameLockedConfig(row.config_json)
    && row.config_hash === LOCKED_COMMISSION_CONFIG_HASH
    && Number(row.pool_pct) === 0.5
    && Number(row.min_bonus_pct) === 5
    && row.efficiency_enabled === false
    && Number(row.max_efficiency_adjustment_pct) === 20
    && row.on_time_threshold_minutes === 15;
}

function isMigration019ConfigAudit(
  audit: ConfigAuditRow | undefined,
  periodId: string,
  month: string,
  predecessor: ConfigRow,
): boolean {
  if (!audit) return false;
  return audit.entity_id === periodId
    && audit.actor_email === "system:migration-019"
    && audit.reason === MIGRATION_019_REASON
    && sameJson(audit.before_value, null)
    && sameJson(audit.after_value, {
      periodStart: `${month}-01`,
      periodEnd: monthBounds(month).periodEnd,
      configRevision: predecessor.revision,
      configHash: MIGRATION_019_CONFIG_HASH,
      config: MIGRATION_019_CONFIG,
      evidence: {
        source: LOCKED_COMMISSION_POLICY_EVIDENCE.priorDashboard.path,
        sourceSha256: LOCKED_COMMISSION_POLICY_EVIDENCE.priorDashboard.sha256,
        sourceLines: "604-610",
        planSection: "6.4 Technician Commissions / Base calculation order",
        historicalBasis: "The prior dashboard declares one global CONFIG used by its monthly calculations.",
      },
    });
}

function isMigration025ConfigAudit(
  audit: ConfigAuditRow | undefined,
  periodId: string,
  locked: ConfigRow,
): boolean {
  if (!audit) return false;
  const beforeMatches = sameJson(audit.before_value, {
    configHash: MIGRATION_019_CONFIG_HASH,
    tierMultipliers: null,
  });
  const after = recordValue(audit.after_value);
  return audit.entity_id === periodId
    && audit.actor_email === "system:migration-025"
    && audit.reason === MIGRATION_025_REASON
    && beforeMatches
    && after?.configRevision === locked.revision
    && after?.configHash === LOCKED_COMMISSION_CONFIG_HASH
    && sameJson(after?.tierMultipliers, LOCKED_COMMISSION_CONFIG.tierMultipliers)
    && typeof after?.rebuildQueued === "boolean";
}

function validateOverrideEvidence(
  month: string,
  rows: OverrideRow[],
  audits: OverrideAuditRow[],
  roster: RosterRow[],
): { evidence: OverrideEvidence; conflicts: string[] } {
  const conflicts: string[] = [];
  const rosterIds = new Set(roster.map((row) => row.employee_id));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const auditsByOverrideId = new Map<string, OverrideAuditRow[]>();
  for (const audit of audits) {
    const overrideId = jsonId(recordValue(audit.after_value)?.override_id);
    if (!overrideId || !rowsById.has(overrideId)) {
      conflicts.push(`${month} override approval audit ${audit.id} is orphaned or references another period.`);
      continue;
    }
    auditsByOverrideId.set(overrideId, [...(auditsByOverrideId.get(overrideId) ?? []), audit]);
  }

  for (const row of rows) {
    if (!rosterIds.has(row.employee_id)) conflicts.push(`${month} override ${row.id} targets out-of-roster employee ${row.employee_id}.`);
    if (!isAllowedSessionOwner(row.actor_email)) conflicts.push(`${month} override ${row.id} actor ${row.actor_email} is not Asad or Laila.`);
    if (!isCommissionSha256(row.idempotency_key)) conflicts.push(`${month} override ${row.id} lacks a runtime-authenticated SHA-256 idempotency key.`);
    if (row.active === (row.superseded_at !== null)) conflicts.push(`${month} override ${row.id} has inconsistent active/supersession state.`);
    try {
      const parsed = parseCommissionOverride({
        employeeId: row.employee_id,
        field: row.field_name,
        value: row.after_value,
        reason: row.reason,
      });
      if (parsed.poolTreatment !== row.pool_treatment || OVERRIDE_VALUE_TYPES[row.field_name] !== row.value_type) {
        conflicts.push(`${month} override ${row.id} has field/value/pool semantics that differ from the commission runtime.`);
      }
    } catch (error) {
      conflicts.push(`${month} override ${row.id} is invalid: ${error instanceof Error ? error.message : "unknown override error"}`);
    }

    const matchingAudits = auditsByOverrideId.get(row.id) ?? [];
    if (matchingAudits.length !== 1) {
      conflicts.push(`${month} override ${row.id} has ${matchingAudits.length} matching immutable commission_override_revised audits; expected exactly one.`);
      continue;
    }
    const audit = matchingAudits[0];
    const expectedBefore = { field: row.field_name, value: row.before_value };
    const expectedAfter = {
      field: row.field_name,
      value: row.after_value,
      override_id: numericJsonId(row.id),
      override_revision: row.revision,
    };
    if (audit.entity_id !== row.period_id
        || audit.actor_email !== row.actor_email
        || !isAllowedSessionOwner(audit.actor_email)
        || audit.reason !== row.reason
        || !sameJson(audit.before_value, expectedBefore)
        || !sameJson(audit.after_value, expectedAfter)) {
      conflicts.push(`${month} override ${row.id} approval audit ${audit.id} is missing or tampered.`);
    }
  }

  const grouped = groupBy(rows, (row) => `${row.employee_id}:${row.field_name}`);
  const effective: OverrideRow[] = [];
  for (const [key, chain] of grouped) {
    const ordered = [...chain].sort((left, right) => left.revision - right.revision || compareIds(left.id, right.id));
    for (let index = 0; index < ordered.length; index += 1) {
      const row = ordered[index];
      const previous = ordered[index - 1];
      if (row.revision !== index + 1) conflicts.push(`${month} override chain ${key} is not contiguous from revision 1.`);
      if (previous && row.period_revision < previous.period_revision) conflicts.push(`${month} override chain ${key} moves backward across period revisions.`);
      if (!sameJson(row.before_value, previous?.after_value ?? null)) conflicts.push(`${month} override ${row.id} before_value does not supersede the preceding approved value.`);
    }
    const activeByPeriod = groupBy(ordered.filter((row) => row.active), (row) => row.period_id);
    for (const duplicates of activeByPeriod.values()) {
      if (duplicates.length > 1) conflicts.push(`${month} override chain ${key} has duplicate active rows in one period revision.`);
    }
    const selected = ordered.filter((row) => row.active)
      .sort((left, right) => right.period_revision - left.period_revision || right.revision - left.revision || compareIds(right.id, left.id))[0];
    if (selected) effective.push(selected);
  }
  const effectiveFields = new Set(effective.map((row) => `${row.employee_id}:${row.field_name}`));
  for (const row of effective) {
    const opposite = row.field_name === "final_bonus" ? "inside_pool_adjustment"
      : row.field_name === "inside_pool_adjustment" ? "final_bonus" : null;
    if (opposite && effectiveFields.has(`${row.employee_id}:${opposite}`)) {
      conflicts.push(`${month} employee ${row.employee_id} has mutually exclusive effective final_bonus and inside_pool_adjustment overrides.`);
    }
  }

  const canonicalRows = [...rows].sort(overrideSort).map(overrideEvidenceValue);
  const canonicalEffective = [...effective].sort(overrideSort).map(overrideEvidenceValue);
  return {
    conflicts,
    evidence: {
      overrideCount: rows.length,
      effectiveOverrideCount: effective.length,
      overrideHash: commissionHashJson(canonicalEffective),
      overrideRowIds: canonicalRows.map((row) => String(row.overrideId)),
      overrideAuditIds: rows
        .flatMap((row) => auditsByOverrideId.get(row.id) ?? [])
        .map((audit) => audit.id)
        .sort(compareIds),
    },
  };
}

function resolveRunIntegrity(period: PeriodRow | null, canonicalByPeriod: Map<string, CommissionCanonicalRunRow>) {
  if (!period?.current_run_id) return { state: "missing" as const, detail: null };
  if (period.current_run_period_id !== period.id) {
    return { state: "invalid" as const, detail: `current_run_id ${period.current_run_id} belongs to period ${period.current_run_period_id ?? "unknown"}` };
  }
  const canonical = canonicalByPeriod.get(period.id);
  if (!canonical) return { state: "invalid" as const, detail: "current run failed the explicit period ownership query" };
  const verification = verifyCommissionCanonicalRun(canonical);
  return verification.ok
    ? { state: "publishable" as const, detail: null }
    : { state: "invalid" as const, detail: verification.error };
}

function resolveQueue(periodStart: string, publishable: boolean, rows: QueueRow[]) {
  const conflicts: string[] = [];
  const initializationKey = commissionInitializationQueueKey(periodStart);
  if (rows.length > 1) conflicts.push(`${periodStart.slice(0, 7)} has duplicate initialization-v2 queue keys.`);
  const prior = rows[0];
  if (prior && (
    prior.idempotency_key !== initializationKey
    || prior.metric_family !== "commissions"
    || prior.period_grain !== "month"
    || prior.period_start !== periodStart
    || !sameJson(prior.dimensions_json, {})
    || prior.reason !== COMMISSION_INITIALIZATION_QUEUE_REASON
    || prior.identity_valid !== true
  )) {
    conflicts.push(`${periodStart.slice(0, 7)} initialization-v2 queue ${prior.id} has a conflicting key, reason, scope, creation bound, or dimensions identity.`);
  }
  if (publishable) return { action: "not_needed" as const, queue: null, conflicts };
  if (prior && prior.status !== "queued" && prior.status !== "running") {
    conflicts.push(`${periodStart.slice(0, 7)} initialization rebuild ${prior.id} is ${prior.status} but the period is not canonically publishable; use the explicit commission initialization queue repair command.`);
    return { action: "use_existing" as const, queue: queueIdentity(prior), conflicts };
  }
  if (prior) return { action: "use_existing" as const, queue: queueIdentity(prior), conflicts };
  return { action: "enqueue" as const, queue: null, conflicts };
}

function resolveAudit(params: {
  item: CommissionPeriodInitializationPlanItem;
  period: PeriodRow | null;
  config: ConfigRow | null;
  audits: InitializationAuditRow[];
  monthQueues: QueueRow[];
}) {
  const conflicts: string[] = [];
  if (params.audits.length > 1) conflicts.push(`${params.item.month} has duplicate historical initialization evidence audits.`);
  const audit = params.audits[0];
  if (!audit) {
    if (params.item.rebuildAction === "not_needed" && params.monthQueues.length > 0) {
      conflicts.push(`${params.item.month} has an unaudited initialization-v2 queue despite an already publishable period.`);
    }
    return { action: "write" as const, conflicts };
  }
  if (!params.period) {
    conflicts.push(`${params.item.month} has historical initialization audit ${audit.id} without its period.`);
    return { action: "preserve" as const, conflicts };
  }

  const after = recordValue(audit.after_value);
  const periodAction = enumValue(after?.periodAction, ["create", "preserve"] as const);
  const configAction = enumValue(after?.configAction, ["insert_locked", "preserve"] as const);
  const rebuildAction = enumValue(after?.rebuildAction, ["enqueue", "use_existing", "not_needed"] as const);
  if (!periodAction || !configAction || !rebuildAction) {
    conflicts.push(`${params.item.month} historical initialization audit ${audit.id} has invalid action evidence.`);
    return { action: "preserve" as const, conflicts };
  }
  const recordedQueue = recordValue(after?.rebuildQueue);
  const queueId = typeof recordedQueue?.id === "string" ? recordedQueue.id : null;
  const queue = queueId ? params.monthQueues.find((row) => row.id === queueId) ?? null : null;
  const queueEvidence = queue ? queueIdentity(queue) : null;
  if ((rebuildAction === "not_needed") !== (queueEvidence === null)) {
    conflicts.push(`${params.item.month} historical initialization audit ${audit.id} has missing or unexpected exact queue linkage.`);
  }
  if (params.item.rebuildAction === "enqueue") {
    conflicts.push(`${params.item.month} has initialization audit evidence but its required exact rebuild queue record is missing.`);
  }
  if (params.item.rebuildAction === "use_existing" && params.item.rebuildQueue?.id !== queueEvidence?.id) {
    conflicts.push(`${params.item.month} active rebuild queue does not match initialization audit ${audit.id}.`);
  }
  if (periodAction === "create" && (params.period.created_by !== audit.actor_email || params.period.revision_reason !== LOCKED_CONFIG_REASON)) {
    conflicts.push(`${params.item.month} audit says the initializer created the period but creator/reason evidence differs.`);
  }
  if (configAction === "insert_locked" && (
    params.config?.idempotency_key !== `verified-tier-config:025:${params.period.id}`
    || params.config.actor_email !== "system:migration-025"
  )) {
    conflicts.push(`${params.item.month} audit says the initializer inserted config but exact config linkage differs.`);
  }
  if (rebuildAction === "enqueue" && queueEvidence?.idempotencyKey !== commissionInitializationQueueKey(params.item.periodStart)) {
    conflicts.push(`${params.item.month} audit says the initializer enqueued a rebuild but the exact queue key differs.`);
  }

  const expectedBefore = initializationBeforeValue(periodAction, configAction, params.item.overridesPreserved);
  const expectedAfter = initializationAfterValue(params.item, {
    periodAction,
    configAction,
    rebuildAction,
    queue: queueEvidence,
  });
  if (!isAllowedSessionOwner(audit.actor_email)
      || audit.reason !== INITIALIZATION_REASON
      || !sameJson(audit.before_value, expectedBefore)
      || !sameJson(audit.after_value, expectedAfter)) {
    conflicts.push(`${params.item.month} historical initialization audit ${audit.id} conflicts with current authoritative evidence or has missing/tampered fields.`);
  }
  return { action: "preserve" as const, conflicts };
}

async function executePlanItem(query: PostgresQuery, item: CommissionPeriodInitializationPlanItem, actorEmail: string) {
  let writes = 0;
  let periodId = item.periodId;
  if (item.periodAction === "create") {
    const inserted = await query<{ id: string }>(
      `insert into metrics.commission_periods (
         period_start, period_end, status, config, source_watermarks, override_hash,
         revision, edit_revision, config_revision, created_by, revision_reason,
         calculation_stale
       ) values ($1::date, $2::date, 'draft', $3::jsonb, '{}'::jsonb, $4,
                 1, 0, 1, $5, $6, true)
       returning id::text`,
      [item.periodStart, item.periodEnd, commissionStableJson(LOCKED_COMMISSION_CONFIG), commissionHashJson([]), actorEmail, LOCKED_CONFIG_REASON],
    );
    periodId = inserted.rows[0]?.id ?? null;
    if (!periodId) throw new Error(`Failed to insert commission period ${item.month}.`);
    writes += 1;
  }
  if (!periodId) throw new Error(`Commission period ${item.month} has no durable identity.`);

  if (item.configAction === "insert_locked") {
    const inserted = await query<{ id: string }>(
      `with target as materialized (
         select id, config_revision
           from metrics.commission_periods
          where id = $1::bigint
          for update
       ), inserted as materialized (
         insert into metrics.commission_period_configs (
           period_id, revision, pool_pct, min_bonus_pct, efficiency_enabled,
           max_efficiency_adjustment_pct, on_time_threshold_minutes,
           config_json, config_hash, actor_email, active, superseded_at, idempotency_key
         )
         select id, config_revision, 0.50, 5.00, false, 20.00, 15,
                $2::jsonb, $3, 'system:migration-019', false, clock_timestamp(),
                'verified-prior-dashboard-config:' || $4
           from target
         union all
         select id, config_revision + 1, 0.50, 5.00, false, 20.00, 15,
                $5::jsonb, $6, 'system:migration-025', true, null,
                'verified-tier-config:025:' || id::text
           from target
         returning period_id
       ), updated as (
         update metrics.commission_periods period
            set config_revision = target.config_revision + 1,
                config = $5::jsonb,
                updated_at = clock_timestamp()
           from target
          where period.id = target.id
            and (select count(*) from inserted) = 2
         returning period.id::text
       )
       select id from updated`,
      [
        periodId,
        commissionStableJson(MIGRATION_019_CONFIG),
        MIGRATION_019_CONFIG_HASH,
        item.periodStart,
        commissionStableJson(LOCKED_COMMISSION_CONFIG),
        LOCKED_COMMISSION_CONFIG_HASH,
      ],
    );
    if (inserted.rows.length !== 1) throw new Error(`Failed to insert the exact 019-to-025 locked config lineage for ${item.month}.`);
    writes += 1;

    const audited = await query(
      `insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason
       )
       select 'system:migration-019', 'commission_period_config_evidence_seeded',
              'commission_period', p.id::text, null,
              jsonb_build_object(
                'periodStart', p.period_start,
                'periodEnd', p.period_end,
                'configRevision', predecessor.revision,
                'configHash', predecessor.config_hash,
                'config', predecessor.config_json,
                'evidence', jsonb_build_object(
                  'source', 'docs/prostar-metrics/reference/commissions-dashboard.html',
                  'sourceSha256', '037b1f6e0e5b7a4156a8eee8180307e92dfc3f0f17b8f19b5ea7011f2852538b',
                  'sourceLines', '604-610',
                  'planSection', '6.4 Technician Commissions / Base calculation order',
                  'historicalBasis', 'The prior dashboard declares one global CONFIG used by its monthly calculations.'
                )
              ),
              $2
         from metrics.commission_periods p
         join metrics.commission_period_configs predecessor
           on predecessor.period_id = p.id
          and predecessor.revision = p.config_revision - 1
        where p.id = $1::bigint
       union all
       select 'system:migration-025', 'commission_tier_config_upgraded',
              'commission_period', p.id::text,
              jsonb_build_object('configHash', predecessor.config_hash, 'tierMultipliers', null),
              jsonb_build_object(
                'configRevision', locked.revision,
                'configHash', locked.config_hash,
                'tierMultipliers', locked.config_json -> 'tierMultipliers',
                'rebuildQueued', true
              ),
              $3
         from metrics.commission_periods p
         join metrics.commission_period_configs predecessor
           on predecessor.period_id = p.id
          and predecessor.revision = p.config_revision - 1
         join metrics.commission_period_configs locked
           on locked.period_id = p.id
          and locked.revision = p.config_revision
        where p.id = $1::bigint`,
      [periodId, MIGRATION_019_REASON, MIGRATION_025_REASON],
    );
    if (audited.rowCount !== 2) throw new Error(`Failed to audit the exact 019-to-025 locked config lineage for ${item.month}.`);
    writes += 1;
  }

  let queue = item.rebuildQueue;
  if (item.rebuildAction === "enqueue") {
    const inserted = await query<QueueRow>(
      `insert into metrics.rollup_rebuild_queue (
         metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
       ) values ('commissions', 'month', $1::date, '{}'::jsonb, $2, $3)
       returning id::text, metric_family, period_grain, period_start::text,
                 dimensions_json, reason, status::text, idempotency_key,
                 to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`,
      [item.periodStart, COMMISSION_INITIALIZATION_QUEUE_REASON, commissionInitializationQueueKey(item.periodStart)],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error(`Failed to queue the exact commission rebuild for ${item.month}.`);
    queue = queueIdentity(row);
    writes += 1;
  }

  if (item.auditAction === "write") {
    const inserted = await query(
      `insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason
       ) values ($1, $2, 'commission_period', $3, $4::jsonb, $5::jsonb, $6)`,
      [
        actorEmail,
        INITIALIZATION_ACTION,
        periodId,
        JSON.stringify(initializationBeforeValue(item.periodAction, item.configAction, item.overridesPreserved)),
        JSON.stringify(initializationAfterValue(item, {
          periodAction: item.periodAction,
          configAction: item.configAction,
          rebuildAction: item.rebuildAction,
          queue,
        })),
        INITIALIZATION_REASON,
      ],
    );
    if (inserted.rowCount !== 1) throw new Error(`Failed to audit commission period initialization for ${item.month}.`);
    writes += 1;
  }
  return writes;
}

function initializationBeforeValue(
  periodAction: "create" | "preserve",
  configAction: "insert_locked" | "preserve",
  overridesPreserved: number,
) {
  return periodAction === "create" ? null : {
    periodPreserved: true,
    configPreserved: configAction === "preserve",
    overridesPreserved,
  };
}

function initializationAfterValue(
  item: CommissionPeriodInitializationPlanItem,
  historical: {
    periodAction: "create" | "preserve";
    configAction: "insert_locked" | "preserve";
    rebuildAction: "enqueue" | "use_existing" | "not_needed";
    queue: QueueIdentity | null;
  },
) {
  return {
    initializationVersion: COMMISSION_INITIALIZATION_VERSION,
    periodAction: historical.periodAction,
    configAction: historical.configAction,
    periodStart: item.periodStart,
    periodEnd: item.periodEnd,
    periodRevision: item.periodRevision,
    configHash: item.configHash,
    configEvidenceActor: item.configEvidenceActor,
    rosterHash: item.rosterHash,
    rosterRowIds: item.rosterRowIds,
    rosterEntries: item.rosterEntries,
    overrideCount: item.overridesPreserved,
    effectiveOverrideCount: item.effectiveOverrides,
    overrideHash: item.overrideHash,
    overrideRowIds: item.overrideRowIds,
    overrideAuditIds: item.overrideAuditIds,
    rebuildAction: historical.rebuildAction,
    rebuildQueue: historical.queue,
    evidence: {
      ...LOCKED_COMMISSION_POLICY_EVIDENCE,
      lockedConfigHash: LOCKED_COMMISSION_CONFIG_HASH,
    },
  };
}

function buildReport(params: {
  actorEmail: string;
  throughMonth: string;
  confirmationToken: string;
  execute: boolean;
  items: CommissionPeriodInitializationPlanItem[];
  writesApplied: number;
}): CommissionPeriodInitializationReport {
  return {
    mode: params.execute ? "execute" : "dry-run",
    actorEmail: params.actorEmail,
    startMonth: COMMISSION_INITIALIZATION_START_MONTH,
    throughMonth: params.throughMonth,
    monthCount: params.items.length,
    confirmationToken: params.confirmationToken,
    evidence: { ...LOCKED_COMMISSION_POLICY_EVIDENCE, lockedConfigHash: LOCKED_COMMISSION_CONFIG_HASH },
    summary: {
      periodsToCreate: count(params.items, (item) => item.periodAction === "create"),
      configsToEvidence: count(params.items, (item) => item.configAction === "insert_locked"),
      evidenceAuditsToWrite: count(params.items, (item) => item.auditAction === "write"),
      rebuildsToQueue: count(params.items, (item) => item.rebuildAction === "enqueue"),
      rebuildsAlreadyQueued: count(params.items, (item) => item.rebuildAction === "use_existing"),
      publishablePeriodsPreserved: count(params.items, (item) => item.rebuildAction === "not_needed"),
      overridesPreserved: params.items.reduce((sum, item) => sum + item.overridesPreserved, 0),
      writesApplied: params.writesApplied,
    },
    periods: params.items,
  };
}

function hashRoster(rows: RosterRow[]): string {
  return commissionHashJson(rows.map((row) => ({
    rosterId: row.id,
    employeeId: row.employee_id,
    displayName: row.display_name,
    included: row.included,
    tier: row.tier,
    effectiveStart: row.effective_start,
    effectiveEnd: row.effective_end,
    notes: row.notes,
    seedAuditId: row.seed_audit_id,
  })).sort((left, right) => left.employeeId.localeCompare(right.employeeId) || compareIds(left.rosterId, right.rosterId)));
}

function queueIdentity(row: QueueRow): QueueIdentity {
  if (!sameJson(row.dimensions_json, {})) throw new Error(`Commission queue ${row.id} dimensions are not exactly {}.`);
  return {
    id: row.id,
    metricFamily: "commissions",
    periodGrain: "month",
    periodStart: row.period_start,
    dimensions: {},
    reason: row.reason,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function overrideEvidenceValue(row: OverrideRow) {
  return {
    overrideId: row.id,
    periodId: row.period_id,
    periodRevision: row.period_revision,
    employeeId: row.employee_id,
    field: row.field_name,
    before: row.before_value,
    after: row.after_value,
    valueType: row.value_type,
    reason: row.reason,
    evidenceUrl: row.evidence_url,
    actorEmail: row.actor_email,
    poolTreatment: row.pool_treatment,
    revision: row.revision,
    active: row.active,
    supersededAt: row.superseded_at,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function overrideSort(left: OverrideRow, right: OverrideRow) {
  return left.employee_id.localeCompare(right.employee_id)
    || left.field_name.localeCompare(right.field_name)
    || left.revision - right.revision
    || compareIds(left.id, right.id);
}

function sameLockedConfig(value: unknown): boolean {
  return sameJson(value, LOCKED_COMMISSION_CONFIG);
}

function assertLockedConfigEvidence() {
  const normalized = validateCommissionConfigValue(LOCKED_COMMISSION_CONFIG);
  const calculated = commissionHashJson(normalized);
  if (calculated !== LOCKED_COMMISSION_CONFIG_HASH || normalized.efficiencyEnabled !== false) {
    throw new Error(`Locked commission config hash mismatch: expected ${LOCKED_COMMISSION_CONFIG_HASH}, calculated ${calculated}.`);
  }
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "40001";
}

function monthRange(start: string, through: string): string[] {
  const values: string[] = [];
  let [year, month] = start.split("-").map(Number);
  const [throughYear, throughMonth] = through.split("-").map(Number);
  while (year < throughYear || (year === throughYear && month <= throughMonth)) {
    values.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
  return values;
}

function monthBounds(monthKey: string) {
  assertMonthKey(monthKey);
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    periodStart: `${monthKey}-01`,
    periodEnd: `${monthKey}-${String(lastDay).padStart(2, "0")}`,
  };
}

function assertMonthKey(value: string): void {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  const month = Number(match?.[2]);
  if (!match || month < 1 || month > 12) throw new Error("Month must be YYYY-MM or current.");
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const itemKey = key(value);
    grouped.set(itemKey, [...(grouped.get(itemKey) ?? []), value]);
  }
  return grouped;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameJson(left: unknown, right: unknown): boolean {
  return commissionStableJson(left) === commissionStableJson(right);
}

function numericJsonId(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Unsafe database identity ${value}.`);
  return number;
}

function jsonId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return null;
}

function compareIds(left: string, right: string): number {
  return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  return typeof value === "string" && allowed.includes(value) ? value as T[number] : null;
}

function count<T>(values: T[], predicate: (value: T) => boolean): number {
  return values.reduce((total, value) => total + (predicate(value) ? 1 : 0), 0);
}

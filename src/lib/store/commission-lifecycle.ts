import type {
  CommissionPeriodConfig,
  CommissionTier,
  CommissionTypedOverrideInput,
} from "@/lib/metrics/commissions";
import {
  commissionCanonicalRunSelect,
  commissionHashJson,
  commissionStableJson,
  isCommissionSha256,
  validateCommissionConfigValue,
  verifyCommissionCanonicalRun,
  type CommissionCanonicalRunRow,
} from "@/lib/store/commission-integrity";
import { queryPostgres, withPostgresTransaction } from "@/lib/store/postgres";

export type CommissionLifecycleStatus = "draft" | "reviewed" | "exported" | "locked" | "revised";
export type CommissionLifecycleAction = "review" | "lock";
export type CommissionOverrideField = CommissionTypedOverrideInput["field"];

const commissionEvidenceUnitKeys = [
  "completedJobs",
  "timesheets",
  "peopleFieldMapping",
  "roster",
  "config",
  "overrides",
  "quoteLabor",
  "backfill",
  "reconciliation",
] as const;

export function isCommissionSourceEvidenceComplete(
  value: unknown,
  config?: Pick<CommissionPeriodConfig, "efficiencyEnabled">,
): boolean {
  const evidence = recordValue(value);
  const units = recordValue(evidence?.units);
  if (evidence?.schemaVersion !== 2 || evidence.complete !== true || evidence.status !== "complete" || !units) {
    return false;
  }
  for (const key of commissionEvidenceUnitKeys) {
    const unit = recordValue(units[key]);
    if (!unit || typeof unit.required !== "boolean") return false;
    const complete = unit.status === "complete" || unit.status === "complete_no_qualifying_work";
    if (key === "quoteLabor") {
      if (config && unit.required !== config.efficiencyEnabled) return false;
      if ((config?.efficiencyEnabled ?? unit.required) && !complete) return false;
    } else if (unit.required !== true || !complete) {
      return false;
    }
  }
  const reconciliation = recordValue(units.reconciliation);
  const detail = recordValue(reconciliation?.detail);
  const requiredScopes = Array.isArray(detail?.requiredScopes) ? detail.requiredScopes.map(String) : [];
  const matches = Array.isArray(evidence.matchedReconciliations)
    ? evidence.matchedReconciliations.map(recordValue).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  return requiredScopes.length > 0 && requiredScopes.every((scope) => matches.some((match) =>
    match.scope === scope
    && typeof match.id === "string"
    && match.id.length > 0
    && typeof match.hash === "string"
    && isCommissionSha256(match.hash)
  ));
}

type QueryResult<T> = { rows: T[]; rowCount: number | null };
export type CommissionQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<QueryResult<T>>;

export type CommissionRevisionRef = {
  periodId: number;
  periodStart: string;
  periodEnd: string;
  revision: number;
  editRevision: number;
  status: CommissionLifecycleStatus;
  currentRunId: number | null;
  calculationStale: boolean;
  forkedFromRevision: number | null;
};

export type CommissionOverrideRecord = {
  id: number;
  periodId: number;
  employeeId: string;
  field: CommissionOverrideField;
  beforeValue: unknown;
  afterValue: unknown;
  valueType: string;
  poolTreatment: "neutral" | "inside_pool" | "outside_pool";
  reason: string;
  evidenceUrl: string | null;
  actorEmail: string;
  revision: number;
  active: boolean;
  createdAt: string;
  supersededAt: string | null;
};

export type CommissionAuditRecord = {
  id: number;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  createdAt: string;
};

type RevisionDbRow = {
  period_id: string | number | null;
  period_start: string | null;
  period_end: string | null;
  revision: string | number | null;
  edit_revision: string | number | null;
  status: CommissionLifecycleStatus | null;
  current_run_id: string | number | null;
  calculation_stale: boolean | null;
  forked_from_revision: string | number | null;
  current_edit_revision?: string | number | null;
  failure_reason?: string | null;
};

type OverrideDbRow = RevisionDbRow & {
  id: string | number | null;
  employee_id: string | number | null;
  field_name: CommissionOverrideField | null;
  before_value: unknown;
  after_value: unknown;
  value_type: string | null;
  pool_treatment: "neutral" | "inside_pool" | "outside_pool" | null;
  reason: string | null;
  evidence_url: string | null;
  actor_email: string | null;
  override_revision: string | number | null;
  active: boolean | null;
  created_at: string | null;
  superseded_at: string | null;
};

export class CommissionRevisionConflictError extends Error {
  readonly currentRevision: number;

  constructor(expectedRevision: number, currentRevision: number) {
    super(`Commission period changed since it was loaded. Expected edit revision ${expectedRevision}; current edit revision is ${currentRevision}.`);
    this.name = "CommissionRevisionConflictError";
    this.currentRevision = currentRevision;
  }
}

export class CommissionLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommissionLifecycleError";
  }
}

export function validateCommissionConfig(value: unknown): CommissionPeriodConfig {
  try {
    return validateCommissionConfigValue(value);
  } catch (error) {
    throw new CommissionLifecycleError(error instanceof Error ? error.message : "Commission config is invalid.");
  }
}

export function parseCommissionOverride(params: {
  employeeId: unknown;
  field: unknown;
  value: unknown;
  reason: unknown;
}): CommissionTypedOverrideInput {
  const employeeId = stringId(params.employeeId);
  const field = typeof params.field === "string" ? params.field : "";
  const reason = typeof params.reason === "string" ? params.reason.trim() : "";
  if (!employeeId) throw new CommissionLifecycleError("employeeId is required.");
  if (reason.length < 5 || reason.length > 1000) {
    throw new CommissionLifecycleError("Reason must be between 5 and 1000 characters.");
  }

  switch (field) {
    case "included": {
      if (typeof params.value !== "boolean") throw new CommissionLifecycleError("Included override must be boolean.");
      return { employeeId, field, value: params.value, reason, poolTreatment: "neutral" };
    }
    case "allocated_value": {
      const value = finiteNumber(params.value);
      if (value === null || value < 0) throw new CommissionLifecycleError("allocated_value must be a nonnegative finite number.");
      return { employeeId, field, value, reason, poolTreatment: "neutral" };
    }
    case "final_bonus": {
      const value = finiteNumber(params.value);
      if (value === null || value < 0) throw new CommissionLifecycleError("final_bonus must be a nonnegative finite number.");
      return { employeeId, field, value, reason, poolTreatment: "inside_pool" };
    }
    case "inside_pool_adjustment": {
      const value = finiteNumber(params.value);
      if (value === null) throw new CommissionLifecycleError("inside_pool_adjustment must be a finite number.");
      return { employeeId, field, value, reason, poolTreatment: "inside_pool" };
    }
    case "outside_pool_adjustment": {
      const value = finiteNumber(params.value);
      if (value === null) throw new CommissionLifecycleError("outside_pool_adjustment must be a finite number.");
      return { employeeId, field, value, reason, poolTreatment: "outside_pool" };
    }
    case "tier": {
      if (!isTier(params.value)) throw new CommissionLifecycleError("Tier must be Gold, Silver, Bronze, or Standard.");
      return { employeeId, field, value: params.value, reason, poolTreatment: "neutral" };
    }
    case "notes": {
      if (typeof params.value !== "string" || params.value.trim().length > 2000) {
        throw new CommissionLifecycleError("Notes must be a string no longer than 2000 characters.");
      }
      return { employeeId, field, value: params.value.trim(), reason, poolTreatment: "neutral" };
    }
    default:
      throw new CommissionLifecycleError("Unsupported commission override field.");
  }
}

export async function persistCommissionOverride(
  params: {
    periodStart: string;
    expectedRevision: number;
    override: CommissionTypedOverrideInput;
    evidenceUrl?: string | null;
    actorEmail: string;
  },
  query: CommissionQuery = queryPostgres,
): Promise<{ override: CommissionOverrideRecord; period: CommissionRevisionRef }> {
  const valueType = valueTypeFor(params.override.field);
  const oppositeField = params.override.field === "final_bonus"
    ? "inside_pool_adjustment"
    : params.override.field === "inside_pool_adjustment"
      ? "final_bonus"
      : null;
  const idempotencyKey = commissionHashJson({
    action: "commission_override",
    periodStart: params.periodStart,
    expectedRevision: params.expectedRevision,
    employeeId: params.override.employeeId,
    field: params.override.field,
    value: params.override.value,
    reason: params.override.reason,
    evidenceUrl: params.evidenceUrl ?? null,
    actorEmail: params.actorEmail.toLowerCase(),
  });

  const result = await query<OverrideDbRow>(
    `with recursive target_lock as materialized (
       select pg_advisory_xact_lock(hashtextextended('commission:' || $1, 0))
     ), target as materialized (
       select p.*
         from metrics.commission_periods p
         cross join target_lock
        where p.period_start = $1::date
        order by p.revision desc
        limit 1
        for update
     ), source_config as materialized (
       select c.*
         from metrics.commission_period_configs c
         join target t on t.id = c.period_id
        where c.revision = t.config_revision
          and c.active
     ), prior_idempotent as materialized (
       select o.*, p.revision as period_revision, p.edit_revision, p.status,
              p.period_start, p.period_end, p.current_run_id, p.calculation_stale
         from metrics.commission_overrides o
         join metrics.commission_periods p on p.id = o.period_id
        where o.idempotency_key = $10
        limit 1
     ), lineage(period_id, depth) as (
       select id, 0 from target
       union all
       select p.supersedes_period_id, l.depth + 1
         from lineage l
         join metrics.commission_periods p on p.id = l.period_id
        where p.supersedes_period_id is not null
     ), effective_before as materialized (
       select o.*
         from metrics.commission_overrides o
         join lineage l on l.period_id = o.period_id
        where o.employee_id = $3::bigint
          and o.field_name = $4
          and o.active
        order by l.depth, o.revision desc, o.id desc
        limit 1
     ), conflicting as materialized (
       select o.id
         from metrics.commission_overrides o
         join lineage l on l.period_id = o.period_id
        where $11::text is not null
          and o.employee_id = $3::bigint
          and o.field_name = $11
          and o.active
        order by l.depth, o.revision desc, o.id desc
        limit 1
     ), forked as (
       insert into metrics.commission_periods (
         period_start, period_end, status, config, source_watermarks, override_hash,
         revision, edit_revision, config_revision, created_by, supersedes_period_id,
         revision_reason, calculation_stale, source_changed_after_export
       )
       select t.period_start, t.period_end, 'draft', t.config, t.source_watermarks, t.override_hash,
              t.revision + 1, t.edit_revision + 1, t.config_revision, $9, t.id,
              $8, true, true
         from target t
         cross join source_config
        where t.edit_revision = $2
          and t.status in ('exported', 'locked')
          and not exists (select 1 from prior_idempotent)
          and not exists (select 1 from conflicting)
       returning *
     ), inherited_config as (
       insert into metrics.commission_period_configs (
         period_id, revision, pool_pct, min_bonus_pct, efficiency_enabled,
         max_efficiency_adjustment_pct, on_time_threshold_minutes,
         config_json, config_hash, actor_email, created_at, active,
         superseded_at, idempotency_key
       )
       select f.id, c.revision, c.pool_pct, c.min_bonus_pct, c.efficiency_enabled,
              c.max_efficiency_adjustment_pct, c.on_time_threshold_minutes,
              c.config_json, c.config_hash, c.actor_email, c.created_at, true,
              null, null
         from forked f
         cross join source_config c
       returning period_id
     ), updated_period as (
       update metrics.commission_periods p
          set status = 'draft',
              edit_revision = p.edit_revision + 1,
              calculation_stale = true,
              updated_at = now()
        where p.id = (select id from target)
          and p.edit_revision = $2
          and p.status in ('draft', 'reviewed')
          and not exists (select 1 from prior_idempotent)
          and not exists (select 1 from conflicting)
       returning p.*
     ), working as materialized (
       select f.*
         from forked f
         join inherited_config c on c.period_id = f.id
       union all
       select * from updated_period
     ), superseded as (
       update metrics.commission_overrides o
          set active = false, superseded_at = now()
        where o.period_id = (select id from working)
          and o.employee_id = $3::bigint
          and o.field_name = $4
          and o.active
       returning o.id
     ), inserted as (
       insert into metrics.commission_overrides (
         period_id, employee_id, field_name, before_value, after_value, value_type,
         reason, evidence_url, actor_email, pool_treatment, revision, active, idempotency_key
       )
       select w.id, $3::bigint, $4, e.after_value, $5::jsonb, $6, $8, $7, $9, $12,
              coalesce((
                select max(o.revision)
                  from metrics.commission_overrides o
                  join metrics.commission_periods p on p.id = o.period_id
                 where p.period_start = w.period_start
                   and o.employee_id = $3::bigint
                   and o.field_name = $4
              ), 0) + 1,
              true, $10
         from working w
         left join effective_before e on true
        where not exists (select 1 from conflicting)
       returning *
     ), audit_written as (
       insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason
       )
       select $9, 'commission_override_revised', 'commission_period', i.period_id::text,
              jsonb_build_object('field', i.field_name, 'value', i.before_value),
              jsonb_build_object('field', i.field_name, 'value', i.after_value,
                                 'override_id', i.id, 'override_revision', i.revision),
              i.reason
         from inserted i
       returning id
     ), queued as (
       insert into metrics.rollup_rebuild_queue (
         metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
       )
       select 'commissions', 'month', w.period_start, '{}'::jsonb,
              'commission override by ' || $9,
              'commissions:month:' || w.period_start::text || ':{}'
         from working w
         cross join audit_written
       on conflict (idempotency_key) do update set
         status = case
           when metrics.rollup_rebuild_queue.status = 'running'
             and metrics.rollup_rebuild_queue.locked_until > now()
             then metrics.rollup_rebuild_queue.status
           else 'queued'::metrics.rollup_rebuild_status
         end,
         reason = excluded.reason,
         error_message = null
       returning id
     ), selected as (
       select i.id, i.period_id, i.employee_id, i.field_name, i.before_value,
              i.after_value, i.value_type, i.pool_treatment, i.reason,
              i.evidence_url, i.actor_email, i.revision as override_revision,
              i.active, i.created_at, i.superseded_at,
              w.revision as period_revision, w.edit_revision, w.status,
              w.period_start, w.period_end, w.current_run_id, w.calculation_stale,
              (select revision from target where id = w.supersedes_period_id) as forked_from_revision
         from inserted i
         join working w on w.id = i.period_id
         cross join queued
       union all
       select p.id, p.period_id, p.employee_id, p.field_name, p.before_value,
              p.after_value, p.value_type, p.pool_treatment, p.reason,
              p.evidence_url, p.actor_email, p.revision as override_revision,
              p.active, p.created_at, p.superseded_at,
              p.period_revision, p.edit_revision, p.status, p.period_start, p.period_end,
              p.current_run_id, p.calculation_stale, null::integer
         from prior_idempotent p
        where not exists (select 1 from inserted)
     )
     select s.period_id, s.period_start::text, s.period_end::text,
            s.period_revision as revision, s.edit_revision, s.status,
            s.current_run_id, s.calculation_stale, s.forked_from_revision,
            s.id, s.employee_id, s.field_name, s.before_value, s.after_value,
            s.value_type, s.pool_treatment, s.reason, s.evidence_url, s.actor_email,
            s.override_revision, s.active, s.created_at::text, s.superseded_at::text,
            (select edit_revision from target) as current_edit_revision,
            case
              when not exists (select 1 from target) then 'missing_period'
              when (select edit_revision from target) <> $2 and not exists (select 1 from prior_idempotent) then 'stale_revision'
              when exists (select 1 from conflicting) then 'override_conflict'
              else null
            end as failure_reason
       from (select 1) seed
       left join selected s on true
      limit 1`,
    [
      params.periodStart,
      params.expectedRevision,
      params.override.employeeId,
      params.override.field,
      JSON.stringify(params.override.value),
      valueType,
      params.evidenceUrl ?? null,
      params.override.reason,
      params.actorEmail,
      idempotencyKey,
      oppositeField,
      params.override.poolTreatment,
    ],
  );

  const row = result.rows[0];
  if (row?.failure_reason === "override_conflict") {
    throw new CommissionLifecycleError("final_bonus and inside_pool_adjustment cannot both be active for one technician.");
  }
  assertCommandResult(row, params.expectedRevision);
  return { override: mapOverride(row), period: mapRevision(row) };
}

export async function persistCommissionConfig(
  params: {
    periodStart: string;
    expectedRevision: number;
    config: CommissionPeriodConfig;
    reason: string;
    actorEmail: string;
  },
  query: CommissionQuery = queryPostgres,
): Promise<CommissionRevisionRef> {
  const config = validateCommissionConfig(params.config);
  const reason = params.reason.trim();
  if (reason.length < 5 || reason.length > 1000) {
    throw new CommissionLifecycleError("Reason must be between 5 and 1000 characters.");
  }
  const configJson = commissionStableJson(config);
  const configHash = commissionHashJson(config);
  const idempotencyKey = commissionHashJson({
    action: "commission_config",
    periodStart: params.periodStart,
    expectedRevision: params.expectedRevision,
    config,
    reason,
    actorEmail: params.actorEmail.toLowerCase(),
  });

  const result = await query<RevisionDbRow>(
    `with target_lock as materialized (
       select pg_advisory_xact_lock(hashtextextended('commission:' || $1, 0))
     ), target as materialized (
       select p.* from metrics.commission_periods p cross join target_lock
        where p.period_start = $1::date order by p.revision desc limit 1 for update
     ), idempotent as materialized (
       select c.*, p.period_start, p.period_end, p.status, p.edit_revision,
              p.current_run_id, p.calculation_stale, p.revision as period_revision
         from metrics.commission_period_configs c
         join metrics.commission_periods p on p.id = c.period_id
        where c.idempotency_key = $9 limit 1
     ), forked as (
       insert into metrics.commission_periods (
         period_start, period_end, status, config, source_watermarks, override_hash,
         revision, edit_revision, config_revision, created_by, supersedes_period_id,
         revision_reason, calculation_stale, source_changed_after_export
       )
       select t.period_start, t.period_end, 'draft', $3::jsonb, t.source_watermarks, t.override_hash,
              t.revision + 1, t.edit_revision + 1, 1, $8, t.id, $7, true, true
         from target t
        where t.edit_revision = $2 and t.status in ('exported', 'locked')
          and not exists (select 1 from idempotent)
       returning *
     ), superseded_config as (
       update metrics.commission_period_configs c
          set active = false, superseded_at = now()
        where c.period_id = (select id from target)
          and c.active
          and (select status from target) in ('draft', 'reviewed')
          and (select edit_revision from target) = $2
          and not exists (select 1 from idempotent)
       returning c.revision
     ), updated_period as (
       update metrics.commission_periods p
          set status = 'draft', config = $3::jsonb,
              config_revision = p.config_revision + 1,
              edit_revision = p.edit_revision + 1,
              calculation_stale = true,
              revision_reason = $7,
              updated_at = now()
        where p.id = (select id from target)
          and p.edit_revision = $2 and p.status in ('draft', 'reviewed')
          and not exists (select 1 from idempotent)
       returning p.*
     ), working as materialized (
       select * from forked union all select * from updated_period
     ), inserted as (
       insert into metrics.commission_period_configs (
         period_id, revision, pool_pct, min_bonus_pct, efficiency_enabled,
         max_efficiency_adjustment_pct, config_json, config_hash, actor_email,
         active, idempotency_key
       )
       select w.id, w.config_revision, $4, $5, $6, $10, $3::jsonb, $11, $8, true, $9
         from working w
       returning period_id
     ), audit_written as (
       insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason
       )
       select $8, 'commission_config_revised', 'commission_period', w.id::text,
              (select config from target), $3::jsonb, $7
         from working w cross join inserted
       returning id
     ), queued as (
       insert into metrics.rollup_rebuild_queue (
         metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
       )
       select 'commissions', 'month', w.period_start, '{}'::jsonb,
              'commission config by ' || $8,
              'commissions:month:' || w.period_start::text || ':{}'
         from working w cross join audit_written
       on conflict (idempotency_key) do update set
         status = case when metrics.rollup_rebuild_queue.status = 'running'
                            and metrics.rollup_rebuild_queue.locked_until > now()
                       then metrics.rollup_rebuild_queue.status
                       else 'queued'::metrics.rollup_rebuild_status end,
         reason = excluded.reason, error_message = null
       returning id
     ), selected as (
       select w.id as period_id, w.period_start, w.period_end, w.revision,
              w.edit_revision, w.status, w.current_run_id, w.calculation_stale,
              t.revision as forked_from_revision
         from working w cross join inserted cross join queued
         left join target t on t.id = w.supersedes_period_id
       union all
       select i.period_id, i.period_start, i.period_end, i.period_revision,
              i.edit_revision, i.status, i.current_run_id, i.calculation_stale, null
         from idempotent i where not exists (select 1 from working)
     )
     select s.period_id, s.period_start::text, s.period_end::text, s.revision,
            s.edit_revision, s.status, s.current_run_id, s.calculation_stale,
            s.forked_from_revision, (select edit_revision from target) as current_edit_revision,
            null::text as failure_reason
       from selected s
      union all
     select null, null, null, null, null, null, null, null, null,
            (select edit_revision from target),
            case when not exists (select 1 from target) then 'missing_period'
                 when (select edit_revision from target) <> $2 then 'stale_revision'
                 else 'write_failed' end
      where not exists (select 1 from selected)
      limit 1`,
    [
      params.periodStart,
      params.expectedRevision,
      configJson,
      config.poolPercent,
      config.minBonusPercent,
      config.efficiencyEnabled,
      reason,
      params.actorEmail,
      idempotencyKey,
      config.maxEfficiencyAdjustmentPercent,
      configHash,
    ],
  );
  const row = result.rows[0];
  assertCommandResult(row, params.expectedRevision);
  return mapRevision(row);
}

export async function transitionCommissionPeriod(
  params: {
    periodStart: string;
    expectedRevision: number;
    action: CommissionLifecycleAction;
    reason: string;
    actorEmail: string;
  },
  query: CommissionQuery = queryPostgres,
): Promise<CommissionRevisionRef> {
  const runInTransaction = query === queryPostgres
    ? withPostgresTransaction
    : async <T>(callback: (transactionQuery: CommissionQuery) => Promise<T>) => callback(query);
  return runInTransaction(async (transactionQuery) => {
    await transactionQuery(
      "select pg_advisory_xact_lock(hashtextextended('commission:' || $1, 0))",
      [params.periodStart],
    );
    const selected = await transactionQuery<CommissionCanonicalRunRow>(
      `${commissionCanonicalRunSelect()}
        where p.period_start = $1::date
        order by p.revision desc
        limit 1
        for update of p`,
      [params.periodStart],
    );
    const row = selected.rows[0];
    if (!row) throw new CommissionLifecycleError("Commission period is missing.");
    if (row.edit_revision !== params.expectedRevision) {
      throw new CommissionRevisionConflictError(params.expectedRevision, row.edit_revision);
    }
    const requiredStatus = params.action === "review" ? "draft" : "exported";
    if (row.status !== requiredStatus) {
      throw new CommissionLifecycleError(`${params.action} requires a ${requiredStatus} commission revision.`);
    }
    const verification = verifyCommissionCanonicalRun(row);
    if (!verification.ok) {
      throw new CommissionLifecycleError(`The current run failed canonical integrity verification: ${verification.error}`);
    }
    return transitionCommissionPeriodVerified(params, transactionQuery);
  });
}

async function transitionCommissionPeriodVerified(
  params: {
    periodStart: string;
    expectedRevision: number;
    action: CommissionLifecycleAction;
    reason: string;
    actorEmail: string;
  },
  query: CommissionQuery = queryPostgres,
): Promise<CommissionRevisionRef> {
  const reason = params.reason.trim();
  if (reason.length < 5 || reason.length > 1000) {
    throw new CommissionLifecycleError("Reason must be between 5 and 1000 characters.");
  }
  const requiredStatus = params.action === "review" ? "draft" : "exported";
  const nextStatus = params.action === "review" ? "reviewed" : "locked";
  const result = await query<RevisionDbRow>(
    `with target_lock as materialized (
       select pg_advisory_xact_lock(hashtextextended('commission:' || $1, 0))
     ), target as materialized (
       select p.*, r.run_status, r.source_complete, r.source_evidence,
              r.input_manifest_hash, r.source_hash, r.config_hash, r.config as run_config,
              r.override_hash as run_override_hash
         from metrics.commission_periods p
         cross join target_lock
         left join metrics.commission_calculation_runs r on r.id = p.current_run_id
        where p.period_start = $1::date order by p.revision desc limit 1 for update of p
     ), updated as (
       update metrics.commission_periods p
          set status = $3::metrics.commission_period_status,
              edit_revision = p.edit_revision + 1,
              reviewed_by = case when $5 = 'review' then $4 else p.reviewed_by end,
              reviewed_at = case when $5 = 'review' then now() else p.reviewed_at end,
              locked_by = case when $5 = 'lock' then $4 else p.locked_by end,
              locked_at = case when $5 = 'lock' then now() else p.locked_at end,
              updated_at = now()
        where p.id = (select id from target)
          and p.edit_revision = $2
          and p.status::text = $6
          and p.current_run_id is not null
          and p.calculation_stale = false
          and (select run_status from target) = 'succeeded'
          and (select source_complete from target) = true
          and metrics.commission_source_evidence_complete((select source_evidence from target))
          and jsonb_typeof((select run_config from target) -> 'efficiencyEnabled') = 'boolean'
          and not exists (
            select 1
              from unnest(array['completedJobs','timesheets','peopleFieldMapping','roster','config','overrides','backfill','reconciliation']) unit_key
             where (select source_evidence from target) #>> array['units', unit_key, 'required'] <> 'true'
                or (select source_evidence from target) #>> array['units', unit_key, 'status'] not in ('complete','complete_no_qualifying_work')
          )
          and (
            ((select run_config from target) ->> 'efficiencyEnabled')::boolean = false
            and (select source_evidence from target) #>> '{units,quoteLabor,required}' = 'false'
            or ((select run_config from target) ->> 'efficiencyEnabled')::boolean = true
            and (select source_evidence from target) #>> '{units,quoteLabor,required}' = 'true'
            and (select source_evidence from target) #>> '{units,quoteLabor,status}' in ('complete','complete_no_qualifying_work')
          )
          and (select input_manifest_hash from target) is not null
          and (select source_hash from target) is not null
          and (select config_hash from target) is not null
          and (select run_override_hash from target) = p.override_hash
       returning p.*
     ), audit_written as (
       insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason
       )
       select $4, 'commission_period_' || $5, 'commission_period', u.id::text,
              jsonb_build_object('status', $6, 'edit_revision', $2),
              jsonb_build_object('status', u.status, 'edit_revision', u.edit_revision,
                                 'run_id', u.current_run_id),
              $7
         from updated u
       returning id
     )
     select u.id as period_id, u.period_start::text, u.period_end::text, u.revision,
            u.edit_revision, u.status, u.current_run_id, u.calculation_stale,
            null::integer as forked_from_revision,
            (select edit_revision from target) as current_edit_revision,
            null::text as failure_reason
       from updated u cross join audit_written
      union all
     select null, null, null, null, null, null, null, null, null,
            (select edit_revision from target),
            case when not exists (select 1 from target) then 'missing_period'
                 when (select edit_revision from target) <> $2 then 'stale_revision'
                 when (select status::text from target) <> $6 then 'invalid_status'
                 else 'run_not_exportable' end
      where not exists (select 1 from updated)
      limit 1`,
    [params.periodStart, params.expectedRevision, nextStatus, params.actorEmail, params.action, requiredStatus, reason],
  );
  const row = result.rows[0];
  if (row?.failure_reason === "invalid_status") {
    throw new CommissionLifecycleError(`${params.action} requires a ${requiredStatus} commission revision.`);
  }
  if (row?.failure_reason === "run_not_exportable") {
    throw new CommissionLifecycleError("The current run is stale, lacks complete period-specific source evidence, or does not match the active config and overrides.");
  }
  assertCommandResult(row, params.expectedRevision);
  return mapRevision(row);
}

export async function queueCommissionRebuild(
  params: {
    periodStart: string;
    expectedRevision: number;
    reason: string;
    actorEmail: string;
  },
  query: CommissionQuery = queryPostgres,
): Promise<CommissionRevisionRef> {
  const reason = params.reason.trim();
  if (reason.length < 5 || reason.length > 1000) {
    throw new CommissionLifecycleError("Reason must be between 5 and 1000 characters.");
  }
  const result = await query<RevisionDbRow>(
    `with target_lock as materialized (
       select pg_advisory_xact_lock(hashtextextended('commission:' || $1, 0))
     ), target as materialized (
       select p.* from metrics.commission_periods p cross join target_lock
        where p.period_start = $1::date order by p.revision desc limit 1 for update
     ), source_config as materialized (
       select c.*
         from metrics.commission_period_configs c
         join target t on t.id = c.period_id
        where c.revision = t.config_revision
          and c.active
     ), forked as (
       insert into metrics.commission_periods (
         period_start, period_end, status, config, source_watermarks, override_hash,
         revision, edit_revision, config_revision, created_by, supersedes_period_id,
         revision_reason, calculation_stale, source_changed_after_export
       )
       select t.period_start, t.period_end, 'draft', t.config, t.source_watermarks, t.override_hash,
              t.revision + 1, t.edit_revision + 1, t.config_revision, $4, t.id, $3, true, true
         from target t
         cross join source_config
        where t.edit_revision = $2 and t.status in ('exported', 'locked')
       returning *
     ), inherited_config as (
       insert into metrics.commission_period_configs (
         period_id, revision, pool_pct, min_bonus_pct, efficiency_enabled,
         max_efficiency_adjustment_pct, on_time_threshold_minutes,
         config_json, config_hash, actor_email, created_at, active,
         superseded_at, idempotency_key
       )
       select f.id, c.revision, c.pool_pct, c.min_bonus_pct, c.efficiency_enabled,
              c.max_efficiency_adjustment_pct, c.on_time_threshold_minutes,
              c.config_json, c.config_hash, c.actor_email, c.created_at, true,
              null, null
         from forked f
         cross join source_config c
       returning period_id
     ), updated as (
       update metrics.commission_periods p
          set status = 'draft', calculation_stale = true,
              edit_revision = p.edit_revision + 1, updated_at = now()
        where p.id = (select id from target)
          and p.edit_revision = $2 and p.status in ('draft', 'reviewed')
       returning p.*
     ), working as materialized (
       select f.*
         from forked f
         join inherited_config c on c.period_id = f.id
       union all
       select * from updated
     ), audit_written as (
       insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason
       )
       select $4, 'commission_rebuild_queued', 'commission_period', w.id::text,
              jsonb_build_object('status', (select status from target), 'revision', (select revision from target)),
              jsonb_build_object('status', w.status, 'revision', w.revision), $3
         from working w returning id
     ), queued as (
       insert into metrics.rollup_rebuild_queue (
         metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
       )
       select 'commissions', 'month', w.period_start, '{}'::jsonb, $3,
              'commissions:month:' || w.period_start::text || ':{}'
         from working w cross join audit_written
       on conflict (idempotency_key) do update set
         status = case when metrics.rollup_rebuild_queue.status = 'running'
                            and metrics.rollup_rebuild_queue.locked_until > now()
                       then metrics.rollup_rebuild_queue.status
                       else 'queued'::metrics.rollup_rebuild_status end,
         reason = excluded.reason, error_message = null
       returning id
     )
     select w.id as period_id, w.period_start::text, w.period_end::text, w.revision,
            w.edit_revision, w.status, w.current_run_id, w.calculation_stale,
            t.revision as forked_from_revision,
            (select edit_revision from target) as current_edit_revision,
            null::text as failure_reason
       from working w cross join queued left join target t on t.id = w.supersedes_period_id
      union all
     select null, null, null, null, null, null, null, null, null,
            (select edit_revision from target),
            case when not exists (select 1 from target) then 'missing_period'
                 when (select edit_revision from target) <> $2 then 'stale_revision'
                 else 'write_failed' end
      where not exists (select 1 from working)
      limit 1`,
    [params.periodStart, params.expectedRevision, reason, params.actorEmail],
  );
  const row = result.rows[0];
  assertCommandResult(row, params.expectedRevision);
  return mapRevision(row);
}

export async function getCommissionAuditHistory(
  periodStart: string,
  query: CommissionQuery = queryPostgres,
): Promise<CommissionAuditRecord[]> {
  const result = await query<{
    id: string | number;
    actor_email: string;
    action: string;
    entity_type: string;
    entity_id: string;
    before_value: unknown;
    after_value: unknown;
    reason: string | null;
    created_at: string;
  }>(
    `select a.id::text, a.actor_email, a.action, a.entity_type, a.entity_id,
            a.before_value, a.after_value, a.reason, a.created_at::text
       from metrics.audit_events a
      where (
        a.entity_type = 'commission_period'
        and a.entity_id in (
          select p.id::text from metrics.commission_periods p where p.period_start = $1::date
        )
      ) or (
        a.entity_type = 'commission_calculation_run'
        and a.entity_id in (
          select r.id::text
            from metrics.commission_calculation_runs r
            join metrics.commission_periods p on p.id = r.period_id
           where p.period_start = $1::date
        )
      )
      order by a.created_at desc, a.id desc`,
    [periodStart],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    actorEmail: row.actor_email,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: row.before_value,
    after: row.after_value,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

function assertCommandResult(row: RevisionDbRow | undefined, expectedRevision: number): asserts row is RevisionDbRow {
  if (!row) throw new CommissionLifecycleError("Commission command returned no result.");
  if (row.failure_reason === "missing_period") {
    throw new CommissionLifecycleError("No commission period exists for the selected month.");
  }
  if (row.failure_reason === "stale_revision") {
    throw new CommissionRevisionConflictError(expectedRevision, Number(row.current_edit_revision) || 0);
  }
  if (row.failure_reason) {
    throw new CommissionLifecycleError("Commission command could not be committed.");
  }
  if (!row.period_id) throw new CommissionLifecycleError("Commission command did not return a period revision.");
}

function mapRevision(row: RevisionDbRow): CommissionRevisionRef {
  if (!row.period_id || !row.period_start || !row.period_end || !row.revision || row.edit_revision === null || !row.status) {
    throw new CommissionLifecycleError("Commission period revision is incomplete.");
  }
  return {
    periodId: Number(row.period_id),
    periodStart: row.period_start,
    periodEnd: row.period_end,
    revision: Number(row.revision),
    editRevision: Number(row.edit_revision),
    status: row.status,
    currentRunId: row.current_run_id === null ? null : Number(row.current_run_id),
    calculationStale: Boolean(row.calculation_stale),
    forkedFromRevision: row.forked_from_revision === null ? null : Number(row.forked_from_revision),
  };
}

function mapOverride(row: OverrideDbRow): CommissionOverrideRecord {
  if (
    !row.id || !row.period_id || !row.employee_id || !row.field_name || !row.value_type
    || !row.pool_treatment || !row.reason || !row.actor_email || !row.override_revision || !row.created_at
  ) {
    throw new CommissionLifecycleError("Commission override result is incomplete.");
  }
  return {
    id: Number(row.id),
    periodId: Number(row.period_id),
    employeeId: String(row.employee_id),
    field: row.field_name,
    beforeValue: row.before_value,
    afterValue: row.after_value,
    valueType: row.value_type,
    poolTreatment: row.pool_treatment,
    reason: row.reason,
    evidenceUrl: row.evidence_url,
    actorEmail: row.actor_email,
    revision: Number(row.override_revision),
    active: Boolean(row.active),
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
  };
}

function valueTypeFor(field: CommissionOverrideField) {
  if (field === "included") return "boolean";
  if (field === "tier") return "tier";
  if (field === "notes") return "string";
  return "number";
}

function isTier(value: unknown): value is CommissionTier {
  return value === "Gold" || value === "Silver" || value === "Bronze" || value === "Standard";
}

function finiteNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function stringId(value: unknown) {
  const parsed = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return /^\d+$/.test(parsed) && parsed !== "0" ? parsed : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

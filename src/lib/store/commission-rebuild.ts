import {
  buildCommissionReadModel,
  type CommissionJobInput,
  type CommissionPeriodConfig,
  type CommissionQuoteLaborCoverageState,
  type CommissionReadModel,
  type CommissionRosterEntry,
} from "@/lib/metrics/commissions";
import {
  assertCommissionCanonicalRun,
  commissionCalculationHash,
  commissionFieldBasis,
  commissionHashJson as hashJson,
  commissionInputManifestHash,
  commissionPersistedJson,
  commissionSourceHash,
  requiredCommissionBackfillIdentities,
  requiredCommissionReconciliationScopes,
  type CommissionCanonicalRunRow,
  type CommissionEvidenceState,
  type CommissionEvidenceUnit,
  type CommissionEvidenceUnitKey,
  type CommissionHashManifestEntry,
  type CommissionSourceEvidence,
} from "@/lib/store/commission-integrity";
import { parseCommissionOverride, validateCommissionConfig, type CommissionQuery } from "@/lib/store/commission-lifecycle";
import { queryPostgres } from "@/lib/store/postgres";
import { plainDisplayText } from "@/lib/text/plain-display-text";
import {
  getCommissionSourceJobs,
  type CommissionSourceJob,
  type CommissionSourceVersion,
} from "@/lib/store/technician-read-model-inputs";

export type { CommissionEvidenceState, CommissionEvidenceUnit, CommissionEvidenceUnitKey, CommissionSourceEvidence };
export type CommissionManifestEntry = CommissionHashManifestEntry;
export type CommissionRebuildArtifact = {
  periodId: number;
  periodStart: string;
  periodEnd: string;
  periodRevision: number;
  editRevision: number;
  configRevision: number;
  config: CommissionPeriodConfig;
  sourceWatermarks: Record<string, unknown>;
  sourceEvidence: CommissionSourceEvidence;
  sourceComplete: boolean;
  manifest: CommissionManifestEntry[];
  inputManifestHash: string;
  sourceHash: string;
  configHash: string;
  overrideHash: string;
  calculationHash: string;
  readModel: CommissionReadModel;
};

type PeriodRow = {
  id: string;
  period_start: string;
  period_end: string;
  revision: number;
  edit_revision: number;
  config_revision: number;
  config: unknown;
  source_watermarks: unknown;
  generated_default: boolean;
};

export type OverrideRow = {
  period_id: string;
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
  id: string;
  active: boolean;
  created_at: string;
  lineage_depth: number;
};

export type RosterRow = CommissionRosterEntry & {
  rosterId: string;
  effectiveStart: string;
  effectiveEnd: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConfigRow = {
  period_id: string;
  revision: number;
  pool_pct: string;
  min_bonus_pct: string;
  efficiency_enabled: boolean;
  max_efficiency_adjustment_pct: string;
  config_json: unknown;
  config_hash: string;
  actor_email: string;
  active: boolean;
  created_at: string;
};

export type BackfillRow = {
  id: string;
  source_family: string;
  month_start: string;
  month_end_exclusive: string;
  required_for_completion: boolean;
  status: string;
  work_phase: string;
  reconciliation_status: string;
  reconciliation_detail: unknown;
  continuation_token: unknown;
  actual_requests: number;
  snapshot_count: number;
  normalized_count: number;
  plan_hash: string;
  completed_at: string | null;
  updated_at: string;
  last_error: string | null;
};

export type ReconciliationRow = {
  id: string;
  scope: string;
  period_start: string;
  period_end: string;
  generation: string | null;
  complete_traversal: boolean;
  source_manifest_generations: unknown;
  source_manifests: unknown;
  rollup_value: string | null;
  snapshot_value: string | null;
  upstream_sample_value: string | null;
  status: string;
  detail: unknown;
  checked_at: string;
};

const commissionReconciliationManifestFamilies = {
  jobs: ["jobs", "job_nested"],
  technicians: [
    "jobs", "job_nested", "employees", "timesheets", "jobs_from_timesheets",
    "schedules", "mobile_status",
  ],
  quotes: ["quotes", "quote_nested"],
} as const;

const defaultConfig: CommissionPeriodConfig = {
  poolPercent: 0.5,
  minBonusPercent: 5,
  efficiencyEnabled: false,
  maxEfficiencyAdjustmentPercent: 20,
  tierMultipliers: { Gold: 1.3, Silver: 1.2, Bronze: 1.1, Standard: 1 },
};

export function assertCommissionRebuildPublishable(
  artifact: CommissionRebuildArtifact,
) {
  try {
    assertCommissionCanonicalRun(canonicalRunFromArtifact(artifact));
  } catch (error) {
    throw new Error(
      `Commission integrity verification failed for ${artifact.periodStart}; refusing immutable-run and ready read-model publication: ${error instanceof Error ? error.message : "unknown integrity failure"}`,
    );
  }
}

export function canonicalRunFromArtifact(artifact: CommissionRebuildArtifact): CommissionCanonicalRunRow {
  const configEntry = artifact.manifest.find((entry) => entry.inputType === "config");
  const configInput = configEntry?.input && typeof configEntry.input === "object" && !Array.isArray(configEntry.input)
    ? configEntry.input as Record<string, unknown>
    : null;
  const employeeResults = artifact.readModel.technicians.map((technician) => {
    const persisted = { ...technician } as Record<string, unknown>;
    delete persisted.tierMultiplier;
    return persisted;
  });
  const runId = "1";
  return {
    period_id: String(artifact.periodId), period_start: artifact.periodStart, period_end: artifact.periodEnd,
    status: "draft", revision: artifact.periodRevision, edit_revision: artifact.editRevision,
    period_config_revision: artifact.configRevision, period_config: artifact.config,
    period_config_source: configInput?.sourceRow ?? null,
    period_watermarks: artifact.sourceWatermarks, period_override_hash: artifact.overrideHash,
    current_run_id: runId, calculation_stale: false, source_changed_after_export: false,
    reviewed_by: null, reviewed_at: null, exported_by: null, exported_at: null,
    locked_by: null, locked_at: null, created_by: "commission-rebuild-verifier",
    period_created_at: artifact.periodStart, revision_reason: null,
    run_id: runId, run_revision: 1, run_status: "succeeded", run_config: artifact.config,
    run_config_revision: artifact.configRevision, run_watermarks: artifact.sourceWatermarks,
    run_override_hash: artifact.overrideHash, read_model: artifact.readModel,
    calculated_by: "commission-rebuild-verifier", calculated_at: artifact.periodEnd,
    source_complete: artifact.sourceComplete, source_evidence: artifact.sourceEvidence,
    config_hash: artifact.configHash, source_hash: artifact.sourceHash,
    input_manifest_hash: artifact.inputManifestHash, calculation_hash: artifact.calculationHash,
    immutable: true, run_completed_jobs: artifact.readModel.completedJobs,
    run_total_work_value: artifact.readModel.totalWorkValue, run_pool_amount: artifact.readModel.poolAmount,
    run_inside_pool_total: artifact.readModel.insidePoolTotal,
    run_outside_pool_total: artifact.readModel.outsidePoolTotal,
    run_payroll_total: artifact.readModel.payrollTotal, run_coverage: artifact.readModel.coverage,
    run_diagnostics: artifact.readModel.diagnostics, run_invariants: artifact.readModel.invariants,
    employee_results: employeeResults, job_allocations: artifact.readModel.jobAllocations,
    input_manifest: artifact.manifest, export_count: 0,
  };
}

export async function prepareCommissionRebuildArtifact(params: {
  periodStart: string;
  periodEnd: string;
  actorEmail: string;
}): Promise<CommissionRebuildArtifact> {
  const period = await ensurePeriod(params);
  const [sourceJobs, roster, overrideRows, configRow, backfillRows, reconciliationRows, jobLabels] = await Promise.all([
    getCommissionSourceJobs(params.periodStart, params.periodEnd),
    getRoster(params.periodStart, params.periodEnd),
    getEffectiveOverrides(period.id),
    getEffectiveConfig(period.id, period.config_revision),
    getPeriodBackfillRows(params.periodStart, params.periodEnd),
    getPeriodReconciliations(params.periodStart, params.periodEnd),
    getJobLabels(params.periodStart, params.periodEnd),
  ]);

  const config = configRow ? normalizeConfigRow(configRow) : normalizeStoredConfig(period.config);
  const overrides = overrideRows.map((row) => parseCommissionOverride({
    employeeId: row.employee_id,
    field: row.field_name,
    value: row.after_value,
    reason: row.reason,
  }));
  const sourceEvidence = buildCommissionSourceEvidence({
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    generatedDefault: period.generated_default,
    config,
    configRow,
    sourceJobs,
    roster,
    overrides: overrideRows,
    backfillRows,
    reconciliationRows,
  });
  const quoteLaborState = sourceEvidence.units.quoteLabor.status as CommissionQuoteLaborCoverageState;
  const jobs: CommissionJobInput[] = sourceJobs.map((job) => ({
    jobId: job.jobId,
    completedDate: job.completedDate,
    stageName: job.stageName,
    sellValue: job.sellValue,
    quoteId: job.quoteId,
    quotedHours: job.quotedHours,
    quoteLaborRows: job.quoteLabor.length,
    quoteLaborCoverageStatus: job.quoteId === null
      ? undefined
      : quoteLaborState === "missing" || quoteLaborState === "loading" || quoteLaborState === "error"
        ? quoteLaborState
        : (job.quotedHours ?? 0) > 0
          ? "complete"
          : "complete_no_qualifying_work",
    timesheets: job.timesheets.map((timesheet) => ({
      employeeId: timesheet.employeeId,
      hours: timesheet.hours,
      mapped: timesheet.mapped,
      fieldTechnician: timesheet.fieldTechnician,
    })),
  }));

  const calculated = buildCommissionReadModel({
    jobs,
    roster,
    overrides,
    config,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
  });
  const labelsByJob = new Map(jobLabels.map((row) => [row.jobId, row]));
  const readModel: CommissionReadModel = {
    ...calculated,
    jobAllocations: calculated.jobAllocations.map((allocation) => ({
      ...allocation,
      ...labelsByJob.get(allocation.jobId),
    })),
  };

  const sourceWatermarks = { periodEvidence: sourceEvidence };
  const sourceComplete = sourceEvidence.complete;
  if (!sourceComplete) {
    readModel.diagnostics.push({
      code: "IMMUTABLE_SOURCE_MANIFEST_INCOMPLETE",
      severity: "error",
      message: `Period-specific commission evidence is ${sourceEvidence.status}; this run cannot be reviewed or exported.`,
    });
    for (const [unitName, unit] of Object.entries(sourceEvidence.units)) {
      if (!unit.required || isCompleteEvidenceState(unit.status)) continue;
      readModel.diagnostics.push({
        code: `SOURCE_EVIDENCE_${unitName.replaceAll(/([A-Z])/g, "_$1").toUpperCase()}_${unit.status.toUpperCase()}`,
        severity: "error",
        message: `${unitName} evidence is ${unit.status}.`,
      });
    }
  }

  const manifest = buildManifest({
    sourceJobs,
    roster,
    config,
    configRow,
    overrides: overrideRows,
    backfillRows,
    reconciliationRows,
    sourceEvidence,
  });
  const configHash = hashJson(config);
  const overrideHash = hashJson(overrideRows);
  const inputManifestHash = commissionInputManifestHash(manifest);
  const sourceHash = commissionSourceHash(manifest);
  const calculationHash = commissionCalculationHash({ readModel, inputManifestHash, configHash, overrideHash });

  return {
    periodId: Number(period.id),
    periodStart: period.period_start,
    periodEnd: period.period_end,
    periodRevision: period.revision,
    editRevision: period.edit_revision,
    configRevision: period.config_revision,
    config,
    sourceWatermarks,
    sourceEvidence,
    sourceComplete,
    manifest,
    inputManifestHash,
    sourceHash,
    configHash,
    overrideHash,
    calculationHash,
    readModel,
  };
}

export async function persistCommissionRebuildArtifactInTransaction(
  params: {
    artifact: CommissionRebuildArtifact;
    rebuiltByJobId: number;
    lockedBy: string;
    actorEmail: string;
  },
  query: CommissionQuery,
): Promise<{ runId: number; runRevision: number; idempotent: boolean }> {
  const artifact = params.artifact;
  assertCommissionRebuildPublishable(artifact);
  const lockedLease = await query<{ id: string }>(
      `select id::text
         from metrics.rollup_rebuild_queue
        where id = $1::bigint
          and metric_family = 'commissions'
          and period_grain = 'month'
          and period_start = $2::date
          and dimensions_json = '{}'::jsonb
          and status = 'running'
          and locked_by = $3
          and locked_until > clock_timestamp()
        for update`,
      [params.rebuiltByJobId, artifact.periodStart, params.lockedBy],
  );
  if (lockedLease.rows.length !== 1) {
    throw new Error(`Lost rollup lease for commission job ${params.rebuiltByJobId} before immutable-run publication.`);
  }

  const result = await query<{
      run_id: string | null;
      run_revision: number | null;
      idempotent: boolean | null;
      failure_reason: string | null;
    }>(
    `with target_lock as materialized (
       select pg_advisory_xact_lock(hashtextextended('commission:' || $1, 0))
     ), target as materialized (
       select p.* from metrics.commission_periods p cross join target_lock
        where p.id = $2 and p.period_start = $1::date
          and p.revision = $3 and p.edit_revision = $4
          and p.config = $6::jsonb
          and p.config_revision = $7
          and exists (
            select 1
              from metrics.commission_period_configs c
             where c.period_id = p.id and c.revision = $7 and c.active
               and c.config_json = $6::jsonb and lower(c.config_hash) = lower($14)
               and c.pool_pct = $30 and c.min_bonus_pct = $31
               and c.efficiency_enabled = $32
               and c.max_efficiency_adjustment_pct = $33
          )
        for update
     ), existing as materialized (
       select r.* from metrics.commission_calculation_runs r
        where r.period_id = $2 and r.calculation_hash = $5
          and r.id = (select current_run_id from target)
          and r.run_status = 'succeeded' and r.immutable = true and r.source_complete = true
          and lower(r.input_manifest_hash) = lower($12)
          and lower(r.source_hash) = lower($13)
          and lower(r.config_hash) = lower($14)
          and lower(r.override_hash) = lower($9)
        limit 1
     ), inserted_run as (
       insert into metrics.commission_calculation_runs (
         period_id, revision, run_status, config, config_revision, source_watermarks,
         override_hash, employee_results, job_allocations, calculation_hash,
         input_manifest_hash, source_hash, config_hash, source_complete,
         source_evidence, read_model, coverage_json, diagnostics_json, invariants_json,
         completed_jobs, total_work_value, pool_amount, inside_pool_total,
         outside_pool_total, payroll_total, created_by, immutable
       )
       select t.id, coalesce((select max(r.revision) + 1 from metrics.commission_calculation_runs r where r.period_id = t.id), 1),
              'succeeded', $6::jsonb, $7, $8::jsonb, $9,
              $10::jsonb, $11::jsonb, $5, $12, $13, $14, $15,
              $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb,
              $21, $22, $23, $24, $25, $26, $27, true
         from target t
        where not exists (select 1 from existing)
       on conflict (period_id, revision) do nothing
       returning *
     ), selected_run as materialized (
       select *, false as idempotent from inserted_run
       union all
       select *, true as idempotent from existing where not exists (select 1 from inserted_run)
     ), input_rows as (
       insert into metrics.commission_run_inputs (
         run_id, input_type, source_identity, source_version, source_hash, input_json
       )
       select r.id, m.input_type, m.source_identity, m.source_version, m.source_hash, m.input_json
         from selected_run r
         cross join jsonb_to_recordset($28::jsonb) as m(
           input_type text, source_identity text, source_version text, source_hash text, input_json jsonb
         )
        where not r.idempotent
       returning run_id
     ), employee_rows as (
       insert into metrics.commission_employee_results (
         run_id, employee_id, display_name, rank, tier, included, allocated_value,
         effective_allocated_value, base_bonus, raw_bonus, below_minimum,
         forfeited_bonus, reallocation_received, post_forfeiture_bonus,
         efficiency_json, inside_pool_adjustment, override_redistribution,
         final_bonus_locked, outside_pool_adjustment, final_bonus, payroll_bonus, notes_json
       )
       select r.id,
              (e ->> 'employeeId')::bigint,
              e ->> 'displayName', nullif(e ->> 'rank', '')::integer,
              e ->> 'tier', coalesce((e ->> 'included')::boolean, true),
              coalesce((e ->> 'allocatedWorkValue')::numeric, 0),
              nullif(e ->> 'effectiveAllocatedWorkValue', '')::numeric,
              coalesce((e ->> 'baseBonus')::numeric, 0),
              coalesce((e ->> 'rawBonus')::numeric, 0),
              coalesce((e ->> 'belowMinimum')::boolean, false),
              coalesce((e ->> 'forfeitedBonus')::numeric, 0),
              coalesce((e ->> 'reallocationReceived')::numeric, 0),
              coalesce((e ->> 'postForfeitureBonus')::numeric, 0),
              e -> 'efficiency', coalesce((e ->> 'insidePoolAdjustment')::numeric, 0),
              coalesce((e ->> 'overrideRedistribution')::numeric, 0),
              coalesce((e ->> 'finalBonusLocked')::boolean, false),
              coalesce((e ->> 'outsidePoolAdjustment')::numeric, 0),
              coalesce((e ->> 'finalBonus')::numeric, 0),
              coalesce((e ->> 'payrollBonus')::numeric, 0),
              coalesce(e -> 'notes', '[]'::jsonb)
         from selected_run r
         cross join jsonb_array_elements($10::jsonb) e
        where not r.idempotent
       returning run_id
     ), allocation_rows as (
       insert into metrics.commission_job_allocations (
         run_id, job_id, employee_id, job_total, employee_hours,
         job_total_hours, share, allocated_value, included
       )
       select r.id, (a ->> 'jobId')::bigint, (a ->> 'employeeId')::bigint,
              coalesce((a ->> 'jobTotal')::numeric, 0),
              coalesce((a ->> 'employeeHours')::numeric, 0),
              coalesce((a ->> 'jobTotalHours')::numeric, 0),
              coalesce((a ->> 'share')::numeric, 0),
              coalesce((a ->> 'allocatedValue')::numeric, 0),
              coalesce((a ->> 'included')::boolean, false)
         from selected_run r
         cross join jsonb_array_elements($11::jsonb) a
        where not r.idempotent
       returning run_id
     ), period_updated as (
       update metrics.commission_periods p
          set current_run_id = r.id,
              config = $6::jsonb,
              config_revision = $7,
              source_watermarks = $8::jsonb,
              override_hash = $9,
              calculation_stale = false,
              updated_at = now()
         from selected_run r
        where p.id = $2
          and (
            r.idempotent
            or exists (select 1 from input_rows)
          )
       returning p.id
     ), audit_written as (
       insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, after_value, reason
       )
       select $27, 'commission_run_created', 'commission_calculation_run', r.id::text,
              jsonb_build_object(
                'period_id', $2, 'period_revision', $3, 'run_revision', r.revision,
                'calculation_hash', $5, 'manifest_hash', $12,
                'source_complete', $15, 'source_evidence_status', $16::jsonb ->> 'status',
                'rebuilt_by_job_id', $29::bigint
              ),
              'immutable commission rebuild'
         from selected_run r cross join period_updated
        where not r.idempotent
       returning id
     )
     select r.id::text as run_id, r.revision as run_revision, r.idempotent,
            null::text as failure_reason
       from selected_run r cross join period_updated
      union all
     select null, null, null,
            case when not exists (select 1 from target) then 'stale_period_revision'
                 else 'run_insert_failed' end
      where not exists (select 1 from selected_run)
      limit 1`,
    [
      artifact.periodStart,
      artifact.periodId,
      artifact.periodRevision,
      artifact.editRevision,
      artifact.calculationHash,
      JSON.stringify(artifact.config),
      artifact.configRevision,
      JSON.stringify(artifact.sourceWatermarks),
      artifact.overrideHash,
      JSON.stringify(artifact.readModel.technicians),
      JSON.stringify(artifact.readModel.jobAllocations),
      artifact.inputManifestHash,
      artifact.sourceHash,
      artifact.configHash,
      artifact.sourceComplete,
      JSON.stringify(artifact.sourceEvidence),
      JSON.stringify(artifact.readModel),
      JSON.stringify(artifact.readModel.coverage),
      JSON.stringify(artifact.readModel.diagnostics),
      JSON.stringify(artifact.readModel.invariants),
      artifact.readModel.completedJobs,
      artifact.readModel.totalWorkValue,
      artifact.readModel.poolAmount,
      artifact.readModel.insidePoolTotal,
      artifact.readModel.outsidePoolTotal,
      artifact.readModel.payrollTotal,
      params.actorEmail,
      JSON.stringify(artifact.manifest.map((entry) => ({
        input_type: entry.inputType,
        source_identity: entry.sourceIdentity,
        source_version: entry.sourceVersion,
        source_hash: entry.sourceHash,
        input_json: entry.input,
      }))),
      params.rebuiltByJobId,
      artifact.config.poolPercent,
      artifact.config.minBonusPercent,
      artifact.config.efficiencyEnabled,
      artifact.config.maxEfficiencyAdjustmentPercent,
    ],
    );
  const row = result.rows[0];
  if (!row?.run_id || !row.run_revision) {
    throw new Error(row?.failure_reason === "stale_period_revision"
      ? "Commission period changed while the immutable rebuild was being prepared; retry the rebuild."
      : "Unable to persist immutable commission run.");
  }

  const publicationLease = await query<{ id: string }>(
      `select id::text
         from metrics.rollup_rebuild_queue
        where id = $1::bigint
          and metric_family = 'commissions'
          and period_grain = 'month'
          and period_start = $2::date
          and dimensions_json = '{}'::jsonb
          and status = 'running'
          and locked_by = $3
          and locked_until > clock_timestamp()`,
    [params.rebuiltByJobId, artifact.periodStart, params.lockedBy],
  );
  if (publicationLease.rows.length !== 1) {
    throw new Error(`Lost rollup lease for commission job ${params.rebuiltByJobId} during immutable-run publication.`);
  }
  return { runId: Number(row.run_id), runRevision: Number(row.run_revision), idempotent: Boolean(row.idempotent) };
}

export function buildManifest(params: {
  sourceJobs: CommissionSourceJob[];
  roster: RosterRow[];
  config: CommissionPeriodConfig;
  configRow: ConfigRow | null;
  overrides: OverrideRow[];
  backfillRows: BackfillRow[];
  reconciliationRows: ReconciliationRow[];
  sourceEvidence: CommissionSourceEvidence;
}): CommissionManifestEntry[] {
  const requiredBackfills = new Set(requiredCommissionBackfillIdentities(
    params.sourceEvidence.periodStart,
    params.sourceEvidence.periodEnd,
    params.config.efficiencyEnabled,
  ));
  const requiredReconciliations = new Set(requiredCommissionReconciliationScopes(params.config.efficiencyEnabled));
  const people = new Map<string, { sourceIdentity: string; sourceVersion: string; input: unknown }>();
  const raw: Array<{
    inputType: CommissionManifestEntry["inputType"];
    sourceIdentity: string;
    sourceVersion: string;
    input: unknown;
  }> = [
    ...params.sourceJobs.map((job) => ({
      inputType: "job" as const,
      sourceIdentity: job.jobId,
      sourceVersion: sourceRowVersion(job.source, `job:${job.jobId}`),
      input: {
        jobId: job.jobId,
        jobNo: job.jobNo,
        jobName: job.jobName,
        completedDate: job.completedDate,
        stageName: job.stageName,
        sellValue: job.sellValue,
        grossProfit: job.grossProfit,
        quoteId: job.quoteId,
        quotedHours: job.quotedHours,
        source: job.source,
      },
    })),
    ...params.sourceJobs.flatMap((job) => job.timesheets.map((timesheet) => {
      const employeeIdentity = timesheet.employeeId ?? "unmapped";
      const personIdentity = timesheet.person?.personId ?? `employee:${employeeIdentity}:unmapped`;
      if (!people.has(personIdentity)) {
        const input = {
          employeeId: timesheet.employeeId,
          person: timesheet.person,
          fieldClassification: timesheet.fieldClassification,
          fieldTechnician: timesheet.fieldTechnician,
        };
        people.set(personIdentity, {
          sourceIdentity: personIdentity,
          sourceVersion: timesheet.person?.sourceModifiedAt ?? timesheet.person?.lastSeenAt ?? "unmapped",
          input,
        });
      }
      return {
        inputType: "timesheet" as const,
        sourceIdentity: `${employeeIdentity}:${timesheet.timesheetId}`,
        sourceVersion: sourceRowVersion(timesheet.source, `timesheet:${employeeIdentity}:${timesheet.timesheetId}`),
        input: { jobId: job.jobId, ...timesheet },
      };
    })),
    ...params.sourceJobs.flatMap((job) => job.quoteLabor.map((labor) => ({
      inputType: "quote_labor" as const,
      sourceIdentity: `${labor.quoteId}:${labor.sectionId}:${labor.costCenterId}:${labor.laborId}`,
      sourceVersion: sourceRowVersion(
        labor.source,
        `quote-labor:${labor.quoteId}:${labor.sectionId}:${labor.costCenterId}:${labor.laborId}`,
      ),
      input: { jobId: job.jobId, ...labor },
    }))),
    ...params.roster.map((input) => ({
      inputType: "roster" as const,
      sourceIdentity: input.rosterId,
      sourceVersion: `${input.updatedAt}:${input.rosterId}`,
      input,
    })),
    {
      inputType: "config" as const,
      sourceIdentity: params.configRow
        ? `${params.configRow.period_id}:${params.configRow.revision}`
        : "period-config:missing-effective-row",
      sourceVersion: params.configRow?.config_hash ?? hashJson(params.config),
      input: { normalizedConfig: params.config, sourceRow: params.configRow },
    },
    ...params.overrides.map((input) => ({
      inputType: "override" as const,
      sourceIdentity: input.id,
      sourceVersion: `${input.revision}:${input.created_at}:${input.id}`,
      input,
    })),
    ...params.backfillRows.filter((input) => requiredBackfills.has(`${input.source_family}:${input.month_start}`)).map((input) => ({
      inputType: "backfill_unit" as const,
      sourceIdentity: `${input.source_family}:${input.month_start}`,
      sourceVersion: `${input.plan_hash}:${input.updated_at}:${input.id}`,
      input,
    })),
    ...params.reconciliationRows.filter((input) => requiredReconciliations.has(input.scope)).map((input) => ({
      inputType: "reconciliation" as const,
      sourceIdentity: input.id,
      sourceVersion: `${input.checked_at}:${input.id}`,
      input,
    })),
    {
      inputType: "evidence_summary" as const,
      sourceIdentity: `${params.sourceEvidence.periodStart}:${params.sourceEvidence.periodEnd}`,
      sourceVersion: `commission-evidence-v${params.sourceEvidence.schemaVersion}`,
      input: params.sourceEvidence,
    },
    {
      inputType: "field_basis" as const,
      sourceIdentity: "commission-v2-period-evidence",
      sourceVersion: "2",
      input: commissionFieldBasis,
    },
  ];
  raw.push(...[...people.values()].map((person) => ({
    inputType: "person_field_mapping" as const,
    ...person,
  })));
  return raw
    .sort((a, b) => a.inputType.localeCompare(b.inputType) || a.sourceIdentity.localeCompare(b.sourceIdentity))
    .map((entry) => {
    const input = commissionPersistedJson(entry.input);
    const sourceHash = hashJson(input);
    return { ...entry, input, sourceHash };
  });
}

async function ensurePeriod(params: { periodStart: string; periodEnd: string; actorEmail: string }) {
  const result = await queryPostgres<PeriodRow>(
    `with inserted as (
       insert into metrics.commission_periods (
         period_start, period_end, status, config, source_watermarks, override_hash,
         revision, edit_revision, config_revision, created_by, revision_reason, calculation_stale
       )
       select $1::date, $2::date, 'draft', $3::jsonb, '{}'::jsonb, $4, 1, 0, 1, $5,
              'Generated default config requires period-effective evidence review', true
        where not exists (
          select 1 from metrics.commission_periods where period_start = $1::date
        )
       returning *
     ), selected as (
       select p.*,
              p.revision_reason = 'Generated default config requires period-effective evidence review' as generated_default
         from metrics.commission_periods p
        where p.period_start = $1::date
          and not exists (select 1 from inserted)
        order by p.revision desc limit 1
     )
     select i.id::text, i.period_start::text, i.period_end::text, i.revision,
            i.edit_revision, i.config_revision, i.config, i.source_watermarks,
            true as generated_default
       from inserted i
     union all
     select s.id::text, s.period_start::text, s.period_end::text, s.revision,
            s.edit_revision, s.config_revision, s.config, s.source_watermarks,
            s.generated_default
       from selected s
     limit 1`,
    [params.periodStart, params.periodEnd, JSON.stringify(defaultConfig), hashJson([]), params.actorEmail],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Unable to create or load the commission period.");
  return row;
}

/**
 * Worksheet roster: everyone who recorded work in the period (archived or
 * not) PLUS every non-archived directory member without period timesheets —
 * the latter render as $0.00 rows and never enter allocation math (the
 * engine allocates from recorded hours only; include checkboxes remain the
 * only exclusion mechanism).
 */
async function getRoster(periodStart: string, periodEnd: string): Promise<RosterRow[]> {
  const result = await queryPostgres<{
    id: string;
    employee_id: string;
    display_name: string;
    included: boolean;
    notes: string | null;
    effective_start: string;
    effective_end: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `select distinct on (r.simpro_employee_id)
            r.person_id::text as id,
            r.simpro_employee_id::text as employee_id,
            r.display_name,
            true as included,
            null::text as notes,
            coalesce(r.date_of_hire, $1::date)::text as effective_start,
            null::text as effective_end,
            coalesce(p.source_modified_at::text, p.last_seen_at::text, r.date_of_hire::text, $1::text) as created_at,
            coalesce(p.source_modified_at::text, p.last_seen_at::text, r.date_of_hire::text, $2::text) as updated_at
       from metrics.effective_technician_roster r
       join metrics.dim_people p on p.person_id = r.person_id
      where r.archived = false
         or exists (
              select 1
                from metrics.metrics_employee_timesheets t
               where t.employee_id = r.simpro_employee_id
                 and t.work_date between $1::date and $2::date
                 and t.source_deleted_at is null
                 and t.total_hours > 0
            )
      order by r.simpro_employee_id, r.person_id desc`,
    [periodStart, periodEnd],
  );
  return result.rows.map((row) => ({
    employeeId: row.employee_id,
    displayName: row.display_name,
    included: row.included,
    notes: row.notes ?? undefined,
    rosterId: row.id,
    effectiveStart: row.effective_start,
    effectiveEnd: row.effective_end,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function getEffectiveOverrides(periodId: string): Promise<OverrideRow[]> {
  const result = await queryPostgres<OverrideRow>(
    `with recursive lineage(period_id, depth) as (
       select $1::bigint, 0
       union all
       select p.supersedes_period_id, l.depth + 1
         from lineage l
         join metrics.commission_periods p on p.id = l.period_id
        where p.supersedes_period_id is not null
     )
     select distinct on (o.employee_id, o.field_name)
            o.period_id::text, o.employee_id::text, o.field_name, o.before_value,
            o.after_value, o.value_type, o.reason, o.evidence_url, o.actor_email,
            o.pool_treatment, o.revision, o.id::text, o.active,
            o.created_at::text, l.depth as lineage_depth
       from metrics.commission_overrides o
       join lineage l on l.period_id = o.period_id
      where o.active
      order by o.employee_id, o.field_name, l.depth, o.revision desc, o.id desc`,
    [periodId],
  );
  return result.rows;
}

async function getEffectiveConfig(periodId: string, configRevision: number): Promise<ConfigRow | null> {
  const result = await queryPostgres<ConfigRow>(
    `select period_id::text, revision, pool_pct::text, min_bonus_pct::text,
            efficiency_enabled, max_efficiency_adjustment_pct::text,
            config_json, config_hash, actor_email, active, created_at::text
       from metrics.commission_period_configs
      where period_id = $1::bigint
        and revision = $2
        and active
      limit 1`,
    [periodId, configRevision],
  );
  return result.rows[0] ?? null;
}

async function getPeriodBackfillRows(periodStart: string, periodEnd: string): Promise<BackfillRow[]> {
  const result = await queryPostgres<BackfillRow>(
    `select id::text, source_family, month_start::text, month_end_exclusive::text,
            required_for_completion, status, work_phase, reconciliation_status,
            reconciliation_detail, continuation_token, actual_requests,
            snapshot_count, normalized_count, plan_hash, completed_at::text,
            updated_at::text, last_error
       from metrics.backfill_source_month_ledger
      where month_start <= $2::date
        and month_end_exclusive > $1::date
        and source_family in (
          'jobs', 'job_nested', 'employees', 'timesheets',
          'jobs_from_timesheets', 'quotes', 'quote_nested'
        )
      order by month_start, source_family`,
    [periodStart, periodEnd],
  );
  return result.rows;
}

async function getPeriodReconciliations(periodStart: string, periodEnd: string): Promise<ReconciliationRow[]> {
  const result = await queryPostgres<ReconciliationRow>(
    `with required_sources(scope, source_families) as (
       values
         ('jobs'::text, array['jobs', 'job_nested']::text[]),
         ('technicians'::text, array[
           'jobs', 'job_nested', 'employees', 'timesheets', 'jobs_from_timesheets',
           'schedules', 'mobile_status'
         ]::text[]),
         ('quotes'::text, array['quotes', 'quote_nested']::text[])
     )
     select authority.id::text, authority.scope,
            authority.period_start::text, authority.period_end::text,
            authority.generation::text, authority.complete_traversal,
            authority.source_manifest_generations,
            manifests.source_manifests,
            authority.rollup_value::text, authority.snapshot_value::text,
            authority.upstream_sample_value::text, authority.status,
            authority.detail, authority.checked_at::text
       from metrics.authoritative_reconciliation_checks authority
       join required_sources required on required.scope = authority.scope
       join lateral (
         select jsonb_agg(jsonb_build_object(
                  'source_family', manifest.source_family,
                  'period_start', manifest.period_start::text,
                  'period_end', manifest.period_end::text,
                  'coverage_status', manifest.coverage_status,
                  'reconciliation_status', manifest.reconciliation_status,
                  'continuation_token', manifest.continuation_token,
                  'manifest_generation', manifest.manifest_generation::text,
                  'reconciliation_generation', manifest.reconciliation_generation::text,
                  'expected_page_count', manifest.expected_page_count,
                  'completed_page_count', manifest.completed_page_count,
                  'reconciled_at', manifest.reconciled_at::text
                ) order by manifest.source_family) as source_manifests,
                count(*)::integer as proof_count
           from unnest(required.source_families) family(source_family)
           join metrics.source_period_manifests manifest
             on manifest.source_family = family.source_family
            and manifest.period_start = authority.period_start
            and manifest.period_end = authority.period_end
            and manifest.coverage_status = 'complete'
            and manifest.reconciliation_status = 'matched'
            and manifest.continuation_token is null
            and manifest.manifest_generation is not null
            and manifest.reconciliation_generation = manifest.manifest_generation
            and manifest.expected_page_count > 0
            and manifest.completed_page_count = manifest.expected_page_count
            and manifest.reconciled_at is not null
            and authority.source_manifest_generations ->> manifest.source_family = manifest.manifest_generation::text
       ) manifests on manifests.proof_count = cardinality(required.source_families)
      where authority.period_start = $1::date
        and authority.period_end = $2::date
        and authority.status = 'matched'
        and authority.complete_traversal
        and authority.generation is not null
        and jsonb_typeof(authority.source_manifest_generations) = 'object'
        and authority.source_manifest_generations <> '{}'::jsonb
        and authority.source_manifest_generations ->> case
              when authority.scope = 'quotes' then 'quotes' else 'jobs'
            end = authority.generation::text
        and authority.source_manifest_generations ->> case
              when authority.scope = 'quotes' then 'quote_nested' else 'job_nested'
            end = authority.generation::text
      order by authority.scope`,
    [periodStart, periodEnd],
  );
  return result.rows;
}

async function getJobLabels(periodStart: string, periodEnd: string) {
  const result = await queryPostgres<{
    job_id: string;
    job_name: string | null;
    customer_name: string | null;
    customer_id: string | null;
  }>(
    `select j.job_id::text, j.name as job_name,
            j.customer_name, j.customer_id::text
       from metrics.metrics_jobs j
      where j.completed_date between $1::date and $2::date
        and j.source_deleted_at is null
      order by j.job_id`,
    [periodStart, periodEnd],
  );
  return result.rows.map((row) => ({
    jobId: row.job_id,
    jobName: plainDisplayText(row.job_name, `Job ${row.job_id}`),
    customer: plainDisplayText(
      row.customer_name,
      row.customer_id ? `Customer ${row.customer_id}` : "Customer unavailable",
    ),
  }));
}

function normalizeStoredConfig(value: unknown): CommissionPeriodConfig {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return validateCommissionConfig({
    poolPercent: record.poolPercent ?? record.pool_pct ?? defaultConfig.poolPercent,
    minBonusPercent: record.minBonusPercent ?? record.min_bonus_pct ?? defaultConfig.minBonusPercent,
    efficiencyEnabled: record.efficiencyEnabled ?? record.efficiency_enabled ?? defaultConfig.efficiencyEnabled,
    maxEfficiencyAdjustmentPercent:
      record.maxEfficiencyAdjustmentPercent
      ?? record.max_efficiency_adjustment_pct
      ?? defaultConfig.maxEfficiencyAdjustmentPercent,
    tierMultipliers: record.tierMultipliers ?? defaultConfig.tierMultipliers,
  });
}

function normalizeConfigRow(row: ConfigRow): CommissionPeriodConfig {
  const jsonConfig = normalizeStoredConfig(row.config_json);
  return validateCommissionConfig({
    poolPercent: Number(row.pool_pct),
    minBonusPercent: Number(row.min_bonus_pct),
    efficiencyEnabled: row.efficiency_enabled,
    maxEfficiencyAdjustmentPercent: Number(row.max_efficiency_adjustment_pct),
    tierMultipliers: jsonConfig.tierMultipliers,
  });
}

export function buildCommissionSourceEvidence(params: {
  periodStart: string;
  periodEnd: string;
  generatedDefault: boolean;
  config: CommissionPeriodConfig;
  configRow: ConfigRow | null;
  sourceJobs: CommissionSourceJob[];
  roster: RosterRow[];
  overrides: OverrideRow[];
  backfillRows: BackfillRow[];
  reconciliationRows: ReconciliationRow[];
}): CommissionSourceEvidence {
  const timesheets = params.sourceJobs.flatMap((job) => job.timesheets);
  const positiveTimesheets = timesheets.filter((timesheet) => timesheet.hours > 0);
  const quoteJobs = params.sourceJobs.filter((job) => job.quoteId !== null);
  const quoteLabor = quoteJobs.flatMap((job) => job.quoteLabor);
  const requiredBackfillFamilies = ["jobs", "job_nested", "employees", "timesheets", "jobs_from_timesheets"];
  if (params.config.efficiencyEnabled) requiredBackfillFamilies.push("quotes", "quote_nested");
  const backfill = evaluateBackfillRows(
    params.periodStart,
    params.periodEnd,
    requiredBackfillFamilies,
    params.backfillRows,
  );
  const reconciliationScopes = params.config.efficiencyEnabled
    ? ["jobs", "technicians", "quotes"]
    : ["jobs", "technicians"];
  const reconciliation = evaluateReconciliations(
    reconciliationScopes,
    params.reconciliationRows,
    params.periodStart,
    params.periodEnd,
  );
  const quoteDependencies = combineEvidenceStates([
    evaluateBackfillRows(params.periodStart, params.periodEnd, ["quotes", "quote_nested"], params.backfillRows).status,
    evaluateReconciliations(["quotes"], params.reconciliationRows, params.periodStart, params.periodEnd).status,
  ]);
  const quoteLaborStatus: CommissionEvidenceState = quoteJobs.length === 0
    ? "complete_no_qualifying_work"
    : !isCompleteEvidenceState(quoteDependencies)
      ? quoteDependencies
      : quoteJobs.some((job) => (job.quotedHours ?? 0) > 0)
        ? "complete"
        : "complete_no_qualifying_work";
  const invalidJobIds = params.sourceJobs
    .filter((job) => !["complete", "archived"].includes(job.stageName.trim().toLowerCase()))
    .map((job) => job.jobId);
  const invalidTimesheetIds = timesheets
    .filter((timesheet) => !timesheet.timesheetId || !timesheet.referenceId)
    .map((timesheet) => `${timesheet.employeeId ?? "unmapped"}:${timesheet.timesheetId}`);
  const unmappedFieldIdentities = positiveTimesheets
    .filter((timesheet) => !timesheet.mapped || !timesheet.fieldClassification.verified)
    .map((timesheet) => `${timesheet.employeeId ?? "unmapped"}:${timesheet.timesheetId}`);
  const configStatus: CommissionEvidenceState = !params.configRow
    ? "missing"
    : hashJson(params.config) !== params.configRow.config_hash
      ? "error"
      : "complete";

  const units: Record<CommissionEvidenceUnitKey, CommissionEvidenceUnit> = {
    completedJobs: evidenceUnit(
      invalidJobIds.length === 0 ? "complete" : "error",
      true,
      params.sourceJobs.map((job) => job.jobId),
      {
        rowCount: params.sourceJobs.length,
        invalidJobIds,
        stages: Object.fromEntries(params.sourceJobs.map((job) => [job.jobId, job.stageName])),
      },
    ),
    timesheets: evidenceUnit(
      invalidTimesheetIds.length === 0 ? "complete" : "error",
      true,
      timesheets.map((timesheet) => `${timesheet.employeeId ?? "unmapped"}:${timesheet.timesheetId}`),
      { invalidTimesheetIds, individualRows: timesheets.length },
    ),
    peopleFieldMapping: evidenceUnit(
      unmappedFieldIdentities.length === 0 ? "complete" : "missing",
      true,
      positiveTimesheets.map((timesheet) => timesheet.person?.personId ?? `employee:${timesheet.employeeId ?? "unmapped"}:unmapped`),
      {
        unmappedFieldIdentities,
        fieldHours: sumHours(positiveTimesheets.filter((timesheet) => timesheet.fieldTechnician)),
        nonFieldHours: sumHours(positiveTimesheets.filter((timesheet) => timesheet.mapped && !timesheet.fieldTechnician)),
        classificationBasis: "effective technician roster membership with in-period work",
      },
    ),
    roster: evidenceUnit(
      params.roster.length > 0 ? "complete" : "missing",
      true,
      params.roster.map((row) => row.rosterId),
      { effectiveRows: params.roster.length },
    ),
    config: evidenceUnit(
      params.generatedDefault && !params.configRow ? "missing" : configStatus,
      true,
      params.configRow ? [`${params.configRow.period_id}:${params.configRow.revision}`] : [],
      {
        generatedDefault: params.generatedDefault,
        revision: params.configRow?.revision ?? null,
        persistedHash: params.configRow?.config_hash ?? null,
        calculatedHash: hashJson(params.config),
      },
    ),
    overrides: evidenceUnit(
      "complete",
      true,
      params.overrides.map((row) => row.id),
      { effectiveRows: params.overrides.length, emptySetRecorded: params.overrides.length === 0 },
    ),
    quoteLabor: evidenceUnit(
      quoteLaborStatus,
      params.config.efficiencyEnabled,
      quoteLabor.map((row) => `${row.quoteId}:${row.sectionId}:${row.costCenterId}:${row.laborId}`),
      {
        efficiencyEnabled: params.config.efficiencyEnabled,
        quoteSourcedJobs: quoteJobs.length,
        laborRows: quoteLabor.length,
        qualifyingJobs: quoteJobs.filter((job) => (job.quotedHours ?? 0) > 0).length,
        jobsWithNoQualifyingWork: quoteJobs.filter((job) => (job.quotedHours ?? 0) <= 0).map((job) => job.jobId),
        dependencyStatus: quoteDependencies,
      },
    ),
    backfill: evidenceUnit(backfill.status, true, backfill.identities, backfill.detail),
    reconciliation: evidenceUnit(
      reconciliation.status,
      true,
      reconciliation.identities,
      reconciliation.detail,
    ),
  };
  const requiredStates = Object.values(units).filter((unit) => unit.required).map((unit) => unit.status);
  const aggregateStatus = combineEvidenceStates(requiredStates);
  const matchedReconciliations = reconciliation.matched;
  return {
    schemaVersion: 2,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    status: isCompleteEvidenceState(aggregateStatus) ? "complete" : aggregateStatus,
    complete: requiredStates.every(isCompleteEvidenceState),
    units,
    matchedReconciliations,
  };
}

function evaluateBackfillRows(
  periodStart: string,
  periodEnd: string,
  sourceFamilies: string[],
  rows: BackfillRow[],
) {
  const expected = monthStartsInPeriod(periodStart, periodEnd)
    .flatMap((monthStart) => sourceFamilies.map((sourceFamily) => `${sourceFamily}:${monthStart}`));
  const byIdentity = new Map(rows.map((row) => [`${row.source_family}:${row.month_start}`, row]));
  const selected = expected.map((identity) => byIdentity.get(identity)).filter((row): row is BackfillRow => Boolean(row));
  const missing = expected.filter((identity) => !byIdentity.has(identity));
  const errored = selected.filter((row) =>
    row.status === "dead_lettered"
    || row.status === "cancelled"
    || row.reconciliation_status === "mismatch"
  );
  const loading = selected.filter((row) =>
    row.status !== "completed"
    || row.reconciliation_status !== "matched"
    || row.continuation_token !== null
  );
  const status: CommissionEvidenceState = errored.length > 0
    ? "error"
    : missing.length > 0
      ? "missing"
      : loading.length > 0
        ? "loading"
        : "complete";
  return {
    status,
    identities: selected.map((row) => `${row.source_family}:${row.month_start}`),
    detail: {
      expectedUnits: expected,
      missingUnits: missing,
      loadingUnits: loading.map((row) => `${row.source_family}:${row.month_start}`),
      errorUnits: errored.map((row) => `${row.source_family}:${row.month_start}`),
    },
  };
}

function evaluateReconciliations(
  scopes: string[],
  rows: ReconciliationRow[],
  periodStart: string,
  periodEnd: string,
) {
  const rowsByScope = new Map<string, ReconciliationRow[]>();
  for (const row of rows) rowsByScope.set(row.scope, [...(rowsByScope.get(row.scope) ?? []), row]);
  const validByScope = new Map<string, ReconciliationRow>();
  const missing = scopes.filter((scope) => !(rowsByScope.get(scope)?.length));
  const errored: string[] = [];
  const authorityErrors: Record<string, string[]> = {};
  for (const scope of scopes) {
    const candidates = rowsByScope.get(scope) ?? [];
    if (candidates.length === 0) continue;
    const errors = candidates.length === 1
      ? reconciliationAuthorityErrors(candidates[0], scope, periodStart, periodEnd)
      : ["authoritative scope is duplicated"];
    if (errors.length > 0) {
      errored.push(scope);
      authorityErrors[scope] = errors;
    } else {
      validByScope.set(scope, candidates[0]);
    }
  }
  const matched = scopes.flatMap((scope) => {
    const row = validByScope.get(scope);
    return row ? [{ scope, id: row.id, hash: hashJson(row) }] : [];
  });
  return {
    status: errored.length > 0 ? "error" as const : missing.length > 0 ? "missing" as const : "complete" as const,
    identities: scopes.flatMap((scope) => validByScope.get(scope)?.id ?? []),
    matched,
    detail: {
      requiredScopes: scopes,
      missingScopes: missing,
      errorScopes: errored,
      authorityErrors,
      matched,
    },
  };
}

function reconciliationAuthorityErrors(
  row: ReconciliationRow,
  scope: string,
  periodStart: string,
  periodEnd: string,
) {
  const errors: string[] = [];
  if (row.scope !== scope || row.period_start !== periodStart || row.period_end !== periodEnd) errors.push("scope or month mismatch");
  if (row.status !== "matched") errors.push("status is not matched");
  if (row.complete_traversal !== true) errors.push("traversal is incomplete");
  const authorityGeneration = positiveInteger(row.generation);
  if (authorityGeneration === null) errors.push("generation is absent");
  const generations = recordValue(row.source_manifest_generations);
  if (!generations || Object.keys(generations).length === 0) errors.push("source manifest generations are empty");
  const requiredFamilies = commissionReconciliationManifestFamilies[scope as keyof typeof commissionReconciliationManifestFamilies];
  const authorityFamilies = scope === "quotes" ? ["quotes", "quote_nested"] : ["jobs", "job_nested"];
  if (authorityGeneration !== null && authorityFamilies.some((family) => positiveInteger(generations?.[family]) !== authorityGeneration)) {
    errors.push("source manifest generations do not match the authoritative generation");
  }
  const manifests = Array.isArray(row.source_manifests)
    ? row.source_manifests.filter((value): value is Record<string, unknown> => Boolean(recordValue(value)))
    : [];
  const manifestsByFamily = new Map(manifests.map((manifest) => [String(manifest.source_family ?? ""), manifest]));
  if (!requiredFamilies || manifests.length !== requiredFamilies.length || manifestsByFamily.size !== requiredFamilies.length) {
    errors.push("required source manifest proofs are incomplete");
    return errors;
  }
  for (const family of requiredFamilies) {
    const manifest = manifestsByFamily.get(family);
    const manifestGeneration = positiveInteger(manifest?.manifest_generation);
    const expectedPages = positiveInteger(manifest?.expected_page_count);
    if (!manifest
        || manifest.period_start !== periodStart || manifest.period_end !== periodEnd
        || manifest.coverage_status !== "complete" || manifest.reconciliation_status !== "matched"
        || manifest.continuation_token !== null || manifestGeneration === null
        || positiveInteger(manifest.reconciliation_generation) !== manifestGeneration
        || positiveInteger(generations?.[family]) !== manifestGeneration
        || expectedPages === null || positiveInteger(manifest.completed_page_count) !== expectedPages
        || typeof manifest.reconciled_at !== "string" || !manifest.reconciled_at) {
      errors.push(`source manifest ${family} is not complete same-generation positive-page evidence`);
    }
  }
  return errors;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveInteger(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function evidenceUnit(
  status: CommissionEvidenceState,
  required: boolean,
  identities: string[],
  detail: Record<string, unknown>,
): CommissionEvidenceUnit {
  return { status, required, rowCount: identities.length, identities: [...new Set(identities)].sort(), detail };
}

function combineEvidenceStates(states: CommissionEvidenceState[]): CommissionEvidenceState {
  if (states.some((state) => state === "error")) return "error";
  if (states.some((state) => state === "loading")) return "loading";
  if (states.some((state) => state === "missing")) return "missing";
  if (states.length > 0 && states.every((state) => state === "complete_no_qualifying_work")) {
    return "complete_no_qualifying_work";
  }
  return "complete";
}

function isCompleteEvidenceState(state: CommissionEvidenceState) {
  return state === "complete" || state === "complete_no_qualifying_work";
}

function monthStartsInPeriod(periodStart: string, periodEnd: string) {
  const current = new Date(`${periodStart.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${periodEnd.slice(0, 7)}-01T00:00:00Z`);
  const months: string[] = [];
  while (current <= end) {
    months.push(current.toISOString().slice(0, 10));
    current.setUTCMonth(current.getUTCMonth() + 1);
  }
  return months;
}

function sumHours(rows: Array<{ hours: number }>) {
  return rows.reduce((total, row) => total + row.hours, 0);
}

function sourceRowVersion(source: CommissionSourceVersion, fallback: string) {
  return source.sourceVersion
    ?? source.sourceSnapshotId
    ?? source.fetchedAt
    ?? source.updatedFromSourceAt
    ?? fallback;
}

import { createHash } from "node:crypto";
import {
  buildCommissionReadModel,
  CommissionCalculationError,
  type CommissionCoverage,
  type CommissionDiagnostic,
  type CommissionInvariants,
  type CommissionJobAllocationResult,
  type CommissionJobInput,
  type CommissionPeriodConfig,
  type CommissionReadModel,
  type CommissionRosterEntry,
  type CommissionTechnicianResult,
  type CommissionTier,
  type CommissionTypedOverrideInput,
} from "@/lib/metrics/commissions";

export type CommissionEvidenceState = "complete" | "complete_no_qualifying_work" | "missing" | "loading" | "error";
export type CommissionEvidenceUnitKey =
  | "completedJobs" | "timesheets" | "peopleFieldMapping" | "roster" | "config"
  | "overrides" | "quoteLabor" | "backfill" | "reconciliation";
export type CommissionEvidenceUnit = {
  status: CommissionEvidenceState;
  required: boolean;
  rowCount: number;
  identities: string[];
  detail: Record<string, unknown>;
};
export type CommissionSourceEvidence = {
  schemaVersion: 2;
  periodStart: string;
  periodEnd: string;
  status: "complete" | "missing" | "loading" | "error";
  complete: boolean;
  units: Record<CommissionEvidenceUnitKey, CommissionEvidenceUnit>;
  matchedReconciliations: Array<{ scope: string; id: string; hash: string }>;
};

export const commissionManifestInputTypes = [
  "job", "timesheet", "person_field_mapping", "roster", "config", "override",
  "quote_labor", "backfill_unit", "reconciliation", "evidence_summary", "field_basis",
] as const;
export const commissionFieldBasis = {
  workValue: "metrics.metrics_jobs.total ex-tax",
  completionDate: "metrics.metrics_jobs.completed_date",
  completedStages: ["complete", "archived"],
  technicianAllocation: "positive mapped timesheet hours classified by effective technician roster membership with in-period work",
  nonFieldTreatment: "disclosed and excluded from the job allocation denominator",
  ineligibleFieldTreatment: "allocated and disclosed, then excluded from payout weights so value redistributes to eligible weights",
  quoteLabor: "persisted quote labor linked through converted_from quote identity",
} as const;
export type CommissionManifestInputType = (typeof commissionManifestInputTypes)[number];
export type CommissionHashManifestEntry = {
  inputType: CommissionManifestInputType | string;
  sourceIdentity: string;
  sourceVersion: string;
  sourceHash: string;
  input: unknown;
};

export type CommissionCanonicalRunRow = {
  period_id: string;
  period_start: string;
  period_end: string;
  status: string;
  revision: number;
  edit_revision: number;
  period_config_revision: number;
  period_config: unknown;
  period_config_source: unknown;
  period_watermarks: unknown;
  period_override_hash: string;
  current_run_id: string | null;
  calculation_stale: boolean;
  source_changed_after_export: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  exported_by: string | null;
  exported_at: string | null;
  locked_by: string | null;
  locked_at: string | null;
  created_by: string;
  period_created_at: string;
  revision_reason: string | null;
  run_id: string | null;
  run_revision: number | null;
  run_status: string | null;
  run_config: unknown;
  run_config_revision: number | null;
  run_watermarks: unknown;
  run_override_hash: string | null;
  read_model: unknown;
  calculated_by: string | null;
  calculated_at: string | null;
  source_complete: boolean | null;
  source_evidence: unknown;
  config_hash: string | null;
  source_hash: string | null;
  input_manifest_hash: string | null;
  calculation_hash: string | null;
  immutable: boolean | null;
  run_completed_jobs: number | null;
  run_total_work_value: number | null;
  run_pool_amount: number | null;
  run_inside_pool_total: number | null;
  run_outside_pool_total: number | null;
  run_payroll_total: number | null;
  run_coverage: unknown;
  run_diagnostics: unknown;
  run_invariants: unknown;
  employee_results: unknown;
  job_allocations: unknown;
  input_manifest: unknown;
  export_count: number;
};

export type CommissionVerifiedIdentity = {
  periodId: string;
  periodRevision: number;
  editRevision: number;
  runId: string;
  runRevision: number;
  calculationHash: string;
  inputManifestHash: string;
  sourceHash: string;
  configHash: string;
  overrideHash: string;
  immutable: true;
};

export type CommissionCanonicalVerification =
  | { ok: true; readModel: CommissionReadModel; identity: CommissionVerifiedIdentity; manifest: CommissionHashManifestEntry[] }
  | { ok: false; error: string };

export class CommissionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommissionIntegrityError";
  }
}

export function commissionStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(commissionStableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${commissionStableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function commissionHashJson(value: unknown): string {
  return createHash("sha256").update(commissionStableJson(value)).digest("hex");
}

export function commissionPersistedJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isCommissionSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

export function commissionInputManifestHash(manifest: CommissionHashManifestEntry[]): string {
  return commissionHashJson(manifest.map((entry) => ({
    inputType: entry.inputType,
    sourceIdentity: entry.sourceIdentity,
    sourceVersion: entry.sourceVersion,
    sourceHash: entry.sourceHash,
  })));
}

export function commissionSourceHash(manifest: CommissionHashManifestEntry[]): string {
  return commissionHashJson(manifest
    .filter((entry) => entry.inputType !== "config" && entry.inputType !== "override")
    .map((entry) => entry.sourceHash));
}

export function commissionCalculationHash(params: {
  readModel: unknown;
  inputManifestHash: string;
  configHash: string;
  overrideHash: string;
}): string {
  return commissionHashJson(params);
}

export function validateCommissionConfigValue(value: unknown): CommissionPeriodConfig & {
  tierMultipliers: { Gold: number; Silver: number; Bronze: number; Standard: number };
} {
  const record = asRecord(value);
  const poolPercent = finiteValue(record.poolPercent);
  const minBonusPercent = finiteValue(record.minBonusPercent);
  const maxEfficiencyAdjustmentPercent = finiteValue(record.maxEfficiencyAdjustmentPercent);
  const tierRecord = recordOrNull(record.tierMultipliers);
  const defaults = { Gold: 1.3, Silver: 1.2, Bronze: 1.1, Standard: 1 } as const;
  if (poolPercent === null || poolPercent < 0.25 || poolPercent > 1 || !increment(poolPercent, 0.05)) {
    throw new CommissionIntegrityError("Pool percent must be 0.25 through 1.00 in 0.05-point increments.");
  }
  if (minBonusPercent === null || minBonusPercent < 0 || minBonusPercent > 100) {
    throw new CommissionIntegrityError("Minimum bonus percent must be between 0 and 100.");
  }
  if (typeof record.efficiencyEnabled !== "boolean") throw new CommissionIntegrityError("Efficiency enabled must be boolean.");
  if (maxEfficiencyAdjustmentPercent === null || !Number.isInteger(maxEfficiencyAdjustmentPercent)
      || maxEfficiencyAdjustmentPercent < 5 || maxEfficiencyAdjustmentPercent > 50) {
    throw new CommissionIntegrityError("Maximum efficiency adjustment must be an integer from 5 through 50 percent.");
  }
  const tierMultipliers = Object.fromEntries(Object.entries(defaults).map(([tier, fallback]) => {
    const multiplier = tierRecord === null ? fallback : finiteValue(tierRecord[tier]);
    if (multiplier === null || multiplier < 0.5 || multiplier > 2 || !increment(multiplier, 0.05)) {
      throw new CommissionIntegrityError(`${tier} tier multiplier must be 0.50 through 2.00 in 0.05-point increments.`);
    }
    return [tier, multiplier];
  })) as { Gold: number; Silver: number; Bronze: number; Standard: number };
  return {
    poolPercent, minBonusPercent, efficiencyEnabled: record.efficiencyEnabled,
    maxEfficiencyAdjustmentPercent, tierMultipliers,
  };
}

export function commissionCanonicalRunSelect() {
  return `select p.id::text as period_id, p.period_start::text, p.period_end::text,
                 p.status::text as status, p.revision, p.edit_revision,
                 p.config_revision as period_config_revision, p.config as period_config,
                 case when c.period_id is null then null else jsonb_build_object(
                   'period_id', c.period_id::text, 'revision', c.revision,
                   'pool_pct', c.pool_pct::text, 'min_bonus_pct', c.min_bonus_pct::text,
                   'efficiency_enabled', c.efficiency_enabled,
                   'max_efficiency_adjustment_pct', c.max_efficiency_adjustment_pct::text,
                   'config_json', c.config_json, 'config_hash', c.config_hash,
                   'actor_email', c.actor_email, 'active', c.active,
                   'created_at', c.created_at::text
                 ) end as period_config_source,
                 p.source_watermarks as period_watermarks, p.override_hash as period_override_hash,
                 p.current_run_id::text, p.calculation_stale, p.source_changed_after_export,
                 p.reviewed_by, p.reviewed_at::text, p.exported_by, p.exported_at::text,
                 p.locked_by, p.locked_at::text, p.created_by,
                 p.created_at::text as period_created_at, p.revision_reason,
                 r.id::text as run_id, r.revision as run_revision, r.run_status,
                 r.config as run_config, r.config_revision as run_config_revision,
                 r.source_watermarks as run_watermarks, r.override_hash as run_override_hash,
                 r.read_model, r.created_by as calculated_by, r.created_at::text as calculated_at,
                 r.source_complete, r.source_evidence, r.config_hash, r.source_hash,
                 r.input_manifest_hash, r.calculation_hash, r.immutable,
                 r.completed_jobs as run_completed_jobs,
                 r.total_work_value::double precision as run_total_work_value,
                 r.pool_amount::double precision as run_pool_amount,
                 r.inside_pool_total::double precision as run_inside_pool_total,
                 r.outside_pool_total::double precision as run_outside_pool_total,
                 r.payroll_total::double precision as run_payroll_total,
                 r.coverage_json as run_coverage, r.diagnostics_json as run_diagnostics,
                 r.invariants_json as run_invariants,
                 coalesce((select jsonb_agg(jsonb_build_object(
                   'employeeId', e.employee_id::text, 'displayName', e.display_name,
                   'rank', e.rank, 'tier', e.tier, 'included', e.included,
                   'allocatedWorkValue', e.allocated_value, 'effectiveAllocatedWorkValue', e.effective_allocated_value,
                   'baseBonus', e.base_bonus, 'rawBonus', e.raw_bonus, 'belowMinimum', e.below_minimum,
                   'forfeitedBonus', e.forfeited_bonus, 'reallocationReceived', e.reallocation_received,
                   'postForfeitureBonus', e.post_forfeiture_bonus, 'efficiency', e.efficiency_json,
                   'insidePoolAdjustment', e.inside_pool_adjustment, 'overrideRedistribution', e.override_redistribution,
                   'finalBonusLocked', e.final_bonus_locked, 'outsidePoolAdjustment', e.outside_pool_adjustment,
                   'finalBonus', e.final_bonus, 'payrollBonus', e.payroll_bonus, 'notes', e.notes_json
                 ) order by e.employee_id) from metrics.commission_employee_results e where e.run_id = r.id), '[]'::jsonb) as employee_results,
                 coalesce((select jsonb_agg(jsonb_build_object(
                   'jobId', a.job_id::text, 'employeeId', a.employee_id::text,
                   'jobName', nullif(btrim(j.name), ''),
                   'customer', nullif(btrim(to_jsonb(j)->>'customer_name'), ''),
                   'jobTotal', a.job_total, 'employeeHours', a.employee_hours,
                   'jobTotalHours', a.job_total_hours, 'share', a.share,
                   'allocatedValue', a.allocated_value, 'included', a.included
                 ) order by a.job_id, a.employee_id)
                 from metrics.commission_job_allocations a
                 left join metrics.metrics_jobs j on j.job_id = a.job_id
                 where a.run_id = r.id), '[]'::jsonb) as job_allocations,
                 coalesce((select jsonb_agg(jsonb_build_object(
                   'inputType', i.input_type, 'sourceIdentity', i.source_identity,
                   'sourceVersion', i.source_version, 'sourceHash', i.source_hash,
                   'input', i.input_json
                 ) order by i.input_type, i.source_identity) from metrics.commission_run_inputs i where i.run_id = r.id), '[]'::jsonb) as input_manifest,
                 coalesce((select count(*) from metrics.commission_exports e where e.calculation_run_id = r.id), 0)::integer as export_count
            from metrics.commission_periods p
            left join metrics.commission_calculation_runs r on r.id = p.current_run_id
            left join metrics.commission_period_configs c
              on c.period_id = p.id and c.revision = p.config_revision and c.active`;
}

export function verifyCommissionCanonicalRun(row: CommissionCanonicalRunRow): CommissionCanonicalVerification {
  try {
    return verifyCanonical(row);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "unknown commission integrity failure" };
  }
}

export function assertCommissionCanonicalRun(row: CommissionCanonicalRunRow) {
  const verification = verifyCommissionCanonicalRun(row);
  if (!verification.ok) throw new CommissionIntegrityError(verification.error);
  return verification;
}

function verifyCanonical(row: CommissionCanonicalRunRow): Extract<CommissionCanonicalVerification, { ok: true }> {
  requireValue(row.run_id, "current run is missing");
  if (row.current_run_id !== row.run_id) fail("run is not the period current_run_id");
  if (row.run_status !== "succeeded") fail("run status is not succeeded");
  if (row.immutable !== true) fail("run is not immutable");
  if (row.calculation_stale) fail("run is stale");
  if (row.source_changed_after_export) fail("source changed after export");
  if (row.source_complete !== true) fail("source_complete is false");
  if (!Number.isInteger(row.run_revision) || (row.run_revision ?? 0) <= 0) fail("run revision is invalid");

  const hashes = {
    config: exactHash(row.config_hash, "config_hash"),
    source: exactHash(row.source_hash, "source_hash"),
    manifest: exactHash(row.input_manifest_hash, "input_manifest_hash"),
    calculation: exactHash(row.calculation_hash, "calculation_hash"),
    runOverride: exactHash(row.run_override_hash, "run override_hash"),
    periodOverride: exactHash(row.period_override_hash, "period override_hash"),
  };
  if (!hashEqual(hashes.runOverride, hashes.periodOverride)) fail("run override hash does not match period override hash");
  if (!same(row.run_watermarks, row.period_watermarks)) fail("run source watermarks do not match period source watermarks");

  const runConfig = validateCommissionConfigValue(row.run_config);
  const periodConfig = validateCommissionConfigValue(row.period_config);
  if (!same(runConfig, periodConfig)) fail("run config does not match period config");
  if (row.run_config_revision !== row.period_config_revision) fail("run config revision does not match period config revision");

  const manifest = parseManifest(row.input_manifest);
  const groups = groupManifest(manifest);
  requireCount(groups.config, 1, "config");
  requireCount(groups.evidence_summary, 1, "evidence_summary");
  requireCount(groups.field_basis, 1, "field_basis");
  if (!groups.roster?.length) fail("complete evidence requires immutable roster rows");
  for (const entry of manifest) {
    exactHash(entry.sourceHash, `source hash for ${entry.inputType}:${entry.sourceIdentity}`);
    if (!hashEqual(entry.sourceHash, commissionHashJson(entry.input))) fail(`source hash mismatch for ${entry.inputType}:${entry.sourceIdentity}`);
  }
  const evidenceEntry = groups.evidence_summary![0];
  if (evidenceEntry.sourceIdentity !== `${row.period_start}:${row.period_end}`
      || evidenceEntry.sourceVersion !== "commission-evidence-v2") fail("evidence summary identity or version is invalid");
  const fieldBasisEntry = groups.field_basis![0];
  if (fieldBasisEntry.sourceIdentity !== "commission-v2-period-evidence"
      || fieldBasisEntry.sourceVersion !== "2" || !same(fieldBasisEntry.input, commissionFieldBasis)) {
    fail("field basis does not match the canonical calculation source contract");
  }

  const configEntry = groups.config![0];
  const configInput = requiredRecord(configEntry.input, "config input");
  const manifestConfig = validateCommissionConfigValue(configInput.normalizedConfig);
  const sourceConfig = requiredRecord(configInput.sourceRow, "config source row");
  const persistedConfigSource = requiredRecord(row.period_config_source, "period config source row");
  if (!same(sourceConfig, persistedConfigSource)) fail("manifest config source row does not match period config source row");
  const sourceJsonConfig = validateCommissionConfigValue(sourceConfig.config_json);
  const sourceScalarConfig = validateCommissionConfigValue({
    poolPercent: sourceConfig.pool_pct, minBonusPercent: sourceConfig.min_bonus_pct,
    efficiencyEnabled: sourceConfig.efficiency_enabled,
    maxEfficiencyAdjustmentPercent: sourceConfig.max_efficiency_adjustment_pct,
    tierMultipliers: sourceJsonConfig.tierMultipliers,
  });
  if (!same(sourceJsonConfig, sourceScalarConfig) || !same(sourceScalarConfig, manifestConfig) || !same(manifestConfig, runConfig)) {
    fail("config_json, scalar config columns, manifest config, run config, and period config do not match");
  }
  const configIdentity = `${row.period_id}:${row.period_config_revision}`;
  if (configEntry.sourceIdentity !== configIdentity
      || String(sourceConfig.period_id) !== row.period_id
      || Number(sourceConfig.revision) !== row.period_config_revision
      || sourceConfig.active !== true) fail("config source identity or revision does not match the period contract");
  const configHash = commissionHashJson(runConfig);
  if (!hashEqual(hashes.config, configHash)
      || !hashEqual(exactHash(sourceConfig.config_hash, "source config hash"), configHash)
      || !hashEqual(exactHash(configEntry.sourceVersion, "config source version"), configHash)) fail("config hash mismatch");

  const inputManifestHash = commissionInputManifestHash(manifest);
  const sourceHash = commissionSourceHash(manifest);
  if (!hashEqual(hashes.manifest, inputManifestHash)) fail("input manifest hash mismatch");
  if (!hashEqual(hashes.source, sourceHash)) fail("source hash mismatch");

  const typed = projectTypedInputs(row, groups, runConfig);
  validateEvidence(row, groups, typed, runConfig);
  const overrideHash = commissionHashJson([...typed.overrideRows].sort((left, right) =>
    String(left.employee_id).localeCompare(String(right.employee_id), undefined, { numeric: true })
    || String(left.field_name).localeCompare(String(right.field_name))));
  if (!hashEqual(hashes.runOverride, overrideHash)) fail("override hash does not match immutable override rows");

  const replay = replayCommission(row, runConfig, typed.jobs, typed.roster, typed.overrides);
  const persistedReadModel = requiredRecord(row.read_model, "read_model") as unknown as CommissionReadModel;
  compareReadModels(replay, persistedReadModel, "read_model");
  compareReadModels(replay, canonicalChildrenModel(row, runConfig, persistedReadModel), "canonical child rows", true);
  if (!same(replay.coverage, row.run_coverage)) fail("canonical coverage_json does not match replay");
  if (!same(replay.invariants, row.run_invariants)) fail("canonical invariants_json does not match replay");
  if (!same(replay.diagnostics, row.run_diagnostics)) fail("canonical diagnostics_json does not match replay");
  compareScalars(row, replay);

  const calculationHash = commissionCalculationHash({
    readModel: row.read_model, inputManifestHash, configHash, overrideHash,
  });
  if (!hashEqual(hashes.calculation, calculationHash)) fail("calculation hash mismatch");
  return {
    ok: true,
    readModel: replay,
    manifest,
    identity: {
      periodId: row.period_id, periodRevision: row.revision, editRevision: row.edit_revision,
      runId: row.run_id!, runRevision: row.run_revision!, calculationHash,
      inputManifestHash, sourceHash, configHash, overrideHash, immutable: true,
    },
  };
}

type ManifestGroups = Partial<Record<CommissionManifestInputType, CommissionHashManifestEntry[]>>;
type TypedInputs = {
  jobs: CommissionJobInput[];
  roster: CommissionRosterEntry[];
  overrides: CommissionTypedOverrideInput[];
  overrideRows: Record<string, unknown>[];
  reconciliationRows: Record<string, unknown>[];
  backfillRows: Record<string, unknown>[];
};

function projectTypedInputs(
  row: CommissionCanonicalRunRow,
  groups: ManifestGroups,
  config: ReturnType<typeof validateCommissionConfigValue>,
): TypedInputs {
  const jobs = new Map<string, { source: Record<string, unknown>; entry: CommissionHashManifestEntry }>();
  for (const entry of groups.job ?? []) {
    const input = requiredRecord(entry.input, `job ${entry.sourceIdentity}`);
    const jobId = positiveId(input.jobId, "jobId");
    if (jobId !== entry.sourceIdentity || jobs.has(jobId)) fail("job source identity mismatch or duplicate");
    const completedDate = requireDate(input.completedDate, "job completedDate");
    if (completedDate < row.period_start || completedDate > row.period_end
        || !["complete", "archived"].includes(String(input.stageName ?? "").trim().toLowerCase())) {
      fail("job is outside the period completed-work contract");
    }
    requireFinite(input.sellValue, "job sellValue");
    if (Number(input.sellValue) < 0) fail("job sellValue is negative");
    jobs.set(jobId, { source: input, entry });
  }

  const timesheetsByJob = new Map<string, CommissionJobInput["timesheets"]>();
  const usedPersonMappings = new Set<string>();
  for (const entry of groups.timesheet ?? []) {
    const input = requiredRecord(entry.input, `timesheet ${entry.sourceIdentity}`);
    const jobId = positiveId(input.jobId, "timesheet jobId");
    if (!jobs.has(jobId)) fail("timesheet is orphaned from immutable job input");
    const timesheetId = nonempty(input.timesheetId, "timesheetId").trim();
    const employeeIdentity = input.employeeId === null || input.employeeId === undefined
      ? "unmapped"
      : positiveId(input.employeeId, "timesheet employeeId");
    if (entry.sourceIdentity !== `${employeeIdentity}:${timesheetId}` || typeof input.referenceId !== "string" || !input.referenceId) {
      fail("timesheet source identity or reference is invalid");
    }
    const hours = requireFinite(input.hours, "timesheet hours");
    if (hours < 0 || typeof input.mapped !== "boolean" || typeof input.fieldTechnician !== "boolean") fail("timesheet mapping or hours are invalid");
    const fieldClassification = requiredRecord(input.fieldClassification, "timesheet fieldClassification");
    if (hours > 0 && (input.mapped !== true || fieldClassification.verified !== true)) {
      fail("positive timesheet lacks complete person and field classification evidence");
    }
    const employeeId = nullablePositiveId(input.employeeId, "timesheet employeeId");
    usedPersonMappings.add(validatePersonMapping(input, groups.person_field_mapping ?? []));
    timesheetsByJob.set(jobId, [...(timesheetsByJob.get(jobId) ?? []), {
      employeeId, hours, mapped: input.mapped, fieldTechnician: input.fieldTechnician,
    }]);
  }
  if (!same(
    [...usedPersonMappings].sort(),
    (groups.person_field_mapping ?? []).map((entry) => entry.sourceIdentity).sort(),
  )) fail("person field mappings are orphaned or missing from timesheet inputs");

  const quoteByJob = new Map<string, Record<string, unknown>[]>();
  for (const entry of groups.quote_labor ?? []) {
    const input = requiredRecord(entry.input, `quote labor ${entry.sourceIdentity}`);
    const jobId = positiveId(input.jobId, "quote labor jobId");
    const job = jobs.get(jobId)?.source;
    if (!job) fail("quote labor is orphaned from immutable job input");
    const quoteId = positiveId(input.quoteId, "quote labor quoteId");
    const sectionId = positiveId(input.sectionId, "quote labor sectionId");
    const costCenterId = positiveId(input.costCenterId, "quote labor costCenterId");
    const laborId = positiveId(input.laborId, "quote labor laborId");
    const expectedIdentity = `${quoteId}:${sectionId}:${costCenterId}:${laborId}`;
    if (entry.sourceIdentity !== expectedIdentity || String(input.quoteId) !== String(job.quoteId)) fail("quote labor identity does not match its job quote");
    const quantityHours = input.quantityHours === null ? 0 : requireFinite(input.quantityHours, "quote labor quantityHours");
    if (quantityHours < 0) fail("quote labor hours are negative");
    quoteByJob.set(jobId, [...(quoteByJob.get(jobId) ?? []), input]);
  }

  const evidence = requiredRecord(groups.evidence_summary?.[0]?.input, "evidence summary");
  const evidenceUnits = requiredRecord(evidence.units, "evidence units");
  const quoteStatusValue = String(requiredRecord(evidenceUnits.quoteLabor, "quoteLabor evidence").status);
  if (!isEvidenceState(quoteStatusValue)) fail("quote labor evidence status is invalid");
  const quoteStatus = quoteStatusValue as CommissionJobInput["quoteLaborCoverageStatus"];
  const typedJobs = [...jobs.values()].map(({ source }) => {
    const jobId = String(source.jobId);
    const quoteRows = quoteByJob.get(jobId) ?? [];
    const quoteId = source.quoteId === null || source.quoteId === undefined ? null : positiveId(source.quoteId, "job quoteId");
    const quotedHours = quoteRows.length ? sum(quoteRows.map((labor) => Number(labor.quantityHours ?? 0))) : null;
    if ((source.quotedHours === null ? null : Number(source.quotedHours)) !== quotedHours) fail(`job ${jobId} quotedHours does not match immutable quote labor rows`);
    if (config.efficiencyEnabled && quoteId && quoteRows.length === 0) fail(`efficiency-enabled job ${jobId} has no immutable quote labor rows`);
    return {
      jobId, completedDate: String(source.completedDate), stageName: String(source.stageName ?? ""),
      sellValue: Number(source.sellValue), quoteId, quotedHours, quoteLaborRows: quoteRows.length,
      quoteLaborCoverageStatus: quoteLaborCoverageStatusForReplay(quoteId, quotedHours, quoteStatus),
      timesheets: timesheetsByJob.get(jobId) ?? [],
    } satisfies CommissionJobInput;
  });

  const roster = (groups.roster ?? []).map((entry) => {
    const input = requiredRecord(entry.input, `roster ${entry.sourceIdentity}`);
    if (positiveId(input.rosterId, "rosterId") !== entry.sourceIdentity || typeof input.included !== "boolean") fail("roster identity or inclusion is invalid");
    return {
      employeeId: positiveId(input.employeeId, "roster employeeId"),
      displayName: nonempty(input.displayName, "roster displayName"),
      included: input.included,
      notes: typeof input.notes === "string" ? input.notes : undefined,
    } satisfies CommissionRosterEntry;
  });
  if (new Set(roster.map((entry) => entry.employeeId)).size !== roster.length) fail("roster employee IDs are duplicated");

  const overrideRows = (groups.override ?? []).map((entry) => {
    const input = requiredRecord(entry.input, `override ${entry.sourceIdentity}`);
    if (positiveId(input.id, "override id") !== entry.sourceIdentity || input.active !== true) fail("override identity or active status is invalid");
    return input;
  });
  const overrides = overrideRows.map(parseOverride);
  return {
    jobs: typedJobs, roster, overrides, overrideRows,
    reconciliationRows: (groups.reconciliation ?? []).map((entry) => requiredRecord(entry.input, `reconciliation ${entry.sourceIdentity}`)),
    backfillRows: (groups.backfill_unit ?? []).map((entry) => requiredRecord(entry.input, `backfill ${entry.sourceIdentity}`)),
  };
}

function quoteLaborCoverageStatusForReplay(
  quoteId: string | null,
  quotedHours: number | null,
  quoteStatus: CommissionJobInput["quoteLaborCoverageStatus"],
): CommissionJobInput["quoteLaborCoverageStatus"] {
  if (!quoteId) return undefined;
  if (quoteStatus === "missing" || quoteStatus === "loading" || quoteStatus === "error") return quoteStatus;
  return (quotedHours ?? 0) > 0 ? "complete" : "complete_no_qualifying_work";
}

function validateEvidence(
  row: CommissionCanonicalRunRow,
  groups: ManifestGroups,
  typed: TypedInputs,
  config: ReturnType<typeof validateCommissionConfigValue>,
) {
  const evidence = requiredRecord(row.source_evidence, "source_evidence");
  if (!same(evidence, groups.evidence_summary![0].input)) fail("source_evidence does not match immutable evidence summary");
  if (evidence.schemaVersion !== 2 || evidence.status !== "complete" || evidence.complete !== true
      || evidence.periodStart !== row.period_start || evidence.periodEnd !== row.period_end) fail("source evidence envelope is incomplete or has the wrong period");
  const units = requiredRecord(evidence.units, "source evidence units");
  const expectedUnitKeys: CommissionEvidenceUnitKey[] = [
    "completedJobs", "timesheets", "peopleFieldMapping", "roster", "config",
    "overrides", "quoteLabor", "backfill", "reconciliation",
  ];
  if (!same(Object.keys(units).sort(), [...expectedUnitKeys].sort())) fail("source evidence units are structurally incomplete");
  const identities: Record<CommissionEvidenceUnitKey, string[]> = {
    completedJobs: (groups.job ?? []).map((entry) => entry.sourceIdentity),
    timesheets: (groups.timesheet ?? []).map((entry) => entry.sourceIdentity),
    peopleFieldMapping: (groups.person_field_mapping ?? []).map((entry) => entry.sourceIdentity),
    roster: (groups.roster ?? []).map((entry) => entry.sourceIdentity),
    config: [groups.config![0].sourceIdentity],
    overrides: (groups.override ?? []).map((entry) => entry.sourceIdentity),
    quoteLabor: (groups.quote_labor ?? []).map((entry) => entry.sourceIdentity),
    backfill: requiredCommissionBackfillIdentities(row.period_start, row.period_end, config.efficiencyEnabled),
    reconciliation: [],
  };
  const requiredScopes = requiredCommissionReconciliationScopes(config.efficiencyEnabled);
  const reconciliationByScope = new Map<string, { entry: CommissionHashManifestEntry; input: Record<string, unknown> }>();
  for (const entry of groups.reconciliation ?? []) {
    const input = requiredRecord(entry.input, `reconciliation ${entry.sourceIdentity}`);
    const scope = String(input.scope ?? "");
    if (!requiredScopes.includes(scope) || reconciliationByScope.has(scope)
        || positiveId(input.id, "reconciliation id") !== entry.sourceIdentity || input.status !== "matched"
        || input.period_start !== row.period_start || input.period_end !== row.period_end) {
      fail("reconciliation input has the wrong id, scope, status, or period");
    }
    reconciliationByScope.set(scope, { entry, input });
  }
  if (!same([...reconciliationByScope.keys()].sort(), [...requiredScopes].sort())) fail("required reconciliation scopes are missing or extra");
  identities.reconciliation = requiredScopes.map((scope) => reconciliationByScope.get(scope)!.entry.sourceIdentity);

  const backfillByIdentity = new Map<string, Record<string, unknown>>();
  for (const entry of groups.backfill_unit ?? []) {
    const input = requiredRecord(entry.input, `backfill ${entry.sourceIdentity}`);
    positiveId(input.id, "backfill id");
    const identity = `${input.source_family}:${input.month_start}`;
    if (identity !== entry.sourceIdentity || backfillByIdentity.has(identity)) fail("backfill identity is invalid or duplicated");
    backfillByIdentity.set(identity, input);
  }
  if (!same([...backfillByIdentity.keys()].sort(), identities.backfill)) fail("backfill families do not exactly match the period config contract");
  for (const identity of identities.backfill) {
    const input = backfillByIdentity.get(identity);
    if (!input || input.status !== "completed" || input.reconciliation_status !== "matched"
        || input.continuation_token !== null || input.required_for_completion !== true
        || !isCommissionSha256(input.plan_hash)) fail(`required backfill ${identity} is absent or incomplete`);
  }

  const quoteLaborHours = sum(typed.jobs.map((job) => job.quotedHours ?? 0));
  for (const key of expectedUnitKeys) {
    const unit = requiredRecord(units[key], `${key} evidence unit`);
    const required = key === "quoteLabor" ? config.efficiencyEnabled : true;
    if (unit.required !== required) fail(`${key} evidence required flag does not match the period contract`);
    const expectedStatus = key === "quoteLabor"
      ? quoteLaborHours > 0 ? "complete" : "complete_no_qualifying_work"
      : "complete";
    if (key === "quoteLabor" && !required) {
      if (!isEvidenceState(String(unit.status))) fail("quoteLabor evidence status is invalid");
      if ((unit.status === "complete" || unit.status === "complete_no_qualifying_work") && unit.status !== expectedStatus) {
        fail("quoteLabor evidence status does not match immutable quote labor hours");
      }
    } else if (unit.status !== expectedStatus) fail(`${key} evidence status does not match immutable inputs`);
    const expected = [...new Set(identities[key])].sort();
    const expectedRowCount = key === "peopleFieldMapping"
      ? (groups.timesheet ?? []).filter((entry) => Number(requiredRecord(entry.input, "timesheet input").hours) > 0).length
      : identities[key].length;
    if (!same(arrayStrings(unit.identities), expected) || unit.rowCount !== expectedRowCount) fail(`${key} evidence identities or rowCount do not match immutable inputs`);
  }
  if (!identities.roster.length || !identities.config.length || !identities.backfill.length || !identities.reconciliation.length) {
    fail("structurally empty complete evidence is not valid");
  }
  const matches = arrayRecords(evidence.matchedReconciliations);
  if (matches.length !== requiredScopes.length) fail("matched reconciliation evidence count is invalid");
  for (const scope of requiredScopes) {
    const source = reconciliationByScope.get(scope)!;
    const match = matches.find((candidate) => candidate.scope === scope);
    if (!match || match.id !== source.entry.sourceIdentity
        || !hashEqual(exactHash(match.hash, `reconciliation ${scope} hash`), source.entry.sourceHash)) {
      fail(`matched reconciliation ${scope} does not match immutable source material`);
    }
  }
  const quoteUnit = requiredRecord(units.quoteLabor, "quoteLabor evidence unit");
  if (config.efficiencyEnabled && typed.jobs.some((job) => job.quoteId && (job.quoteLaborRows ?? 0) === 0)) {
    fail("efficiency-enabled source has a quote job without quote labor inputs");
  }
  if (config.efficiencyEnabled && quoteUnit.status !== "complete" && quoteUnit.status !== "complete_no_qualifying_work") {
    fail("efficiency-enabled quote labor evidence is incomplete");
  }
}

function replayCommission(
  row: CommissionCanonicalRunRow,
  config: ReturnType<typeof validateCommissionConfigValue>,
  jobs: CommissionJobInput[],
  roster: CommissionRosterEntry[],
  overrides: CommissionTypedOverrideInput[],
) {
  try {
    const replay = buildCommissionReadModel({
      periodStart: row.period_start, periodEnd: row.period_end, config, jobs, roster, overrides,
    });
    if (config.efficiencyEnabled && replay.technicians.some((technician) =>
      technician.efficiency?.enabled !== true
      || technician.efficiency.maxAdjustmentPercent !== config.maxEfficiencyAdjustmentPercent)) {
      fail("technician efficiency result bypasses the enabled efficiency config");
    }
    if (!config.efficiencyEnabled && replay.technicians.some((technician) => technician.efficiency?.enabled !== false)) {
      fail("technician efficiency result does not reflect disabled efficiency config");
    }
    return replay;
  } catch (error) {
    const isNoWorkError = error instanceof CommissionCalculationError
      && (error.code === "NO_ELIGIBLE_TECHNICIANS" || error.code === "ZERO_ELIGIBLE_BASIS");
    const hasOnlyReplayableZeroWorkOverrides = overrides.every((override) => override.field === "included");
    if (isNoWorkError && jobs.length === 0 && isCanonicalZero(row) && hasOnlyReplayableZeroWorkOverrides) {
      return canonicalZeroReadModel(row, config, roster, overrides);
    }
    throw error;
  }
}

function canonicalZeroReadModel(
  row: CommissionCanonicalRunRow,
  config: ReturnType<typeof validateCommissionConfigValue>,
  roster: CommissionRosterEntry[],
  overrides: CommissionTypedOverrideInput[],
): CommissionReadModel {
  const includedOverrides = new Map(overrides.filter((item) => item.field === "included").map((item) => [item.employeeId, item.value]));
  const technicianWork = roster.map((entry) => ({
    employeeId: entry.employeeId, displayName: entry.displayName,
    included: includedOverrides.get(entry.employeeId) ?? entry.included,
    allocatedWorkValue: 0, effectiveAllocatedWorkValue: 0, mappedHours: 0, jobCount: 0,
  })).sort((a, b) => a.employeeId.localeCompare(b.employeeId, undefined, { numeric: true }));
  const coverage: CommissionCoverage = {
    jobsWithTimesheets: 0, jobsWithoutTimesheets: 0, completedJobs: 0,
    positiveValueJobs: 0, nonPositiveValueJobs: 0, commissionSupportedJobs: 0,
    excludedJobs: 0, jobsWithEligibleWork: 0, jobsWithOnlyIneligibleWork: 0,
    mappedHours: 0, unmappedHours: 0, nonFieldTechnicianHours: 0,
    unmappedTimesheetEntries: 0, mappedTechnicians: 0,
    eligibleTechnicians: technicianWork.filter((item) => item.included).length,
    ineligibleTechnicians: technicianWork.filter((item) => !item.included).length,
    eligibleAllocatedWorkValue: 0, ineligibleAllocatedWorkValue: 0, excludedWorkValue: 0,
    excludedJobDetails: [],
    quoteLabor: {
      status: "complete_no_qualifying_work", required: config.efficiencyEnabled,
      quoteSourcedJobs: 0, jobsWithLaborRows: 0, qualifyingJobs: 0,
      jobsWithNoQualifyingWork: 0, laborRows: 0, incompleteJobIds: [],
    },
    technicianWork,
  };
  const invariants: CommissionInvariants = {
    insidePoolReconciles: true, outsidePoolReconciles: true,
    jobAllocationsReconcile: true, unsupportedJobsUnallocated: true,
    forfeitureReconciles: true, efficiencyReconciles: true, nonnegativePayroll: true,
  };
  return {
    periodStart: row.period_start, periodEnd: row.period_end, config,
    completedJobs: 0, totalWorkValue: 0, poolAmount: 0, insidePoolTotal: 0,
    outsidePoolTotal: 0, payrollTotal: 0, activeTechnicians: 0,
    technicians: [], jobAllocations: [], coverage,
    diagnostics: row.run_diagnostics as CommissionDiagnostic[], invariants,
  };
}

function isCanonicalZero(row: CommissionCanonicalRunRow) {
  return [row.run_completed_jobs, row.run_total_work_value, row.run_pool_amount,
    row.run_inside_pool_total, row.run_outside_pool_total, row.run_payroll_total].every((value) => value === 0)
    && Array.isArray(row.employee_results) && row.employee_results.length === 0
    && Array.isArray(row.job_allocations) && row.job_allocations.length === 0;
}

function canonicalChildrenModel(
  row: CommissionCanonicalRunRow,
  config: ReturnType<typeof validateCommissionConfigValue>,
  persisted: CommissionReadModel,
): CommissionReadModel {
  const employees = arrayRecords(row.employee_results).map((employee) => ({
    ...employee,
    tierMultiplier: config.tierMultipliers[String(employee.tier) as CommissionTier],
  })) as CommissionTechnicianResult[];
  const allocations = arrayRecords(row.job_allocations) as unknown as CommissionJobAllocationResult[];
  return {
    ...persisted,
    completedJobs: number(row.run_completed_jobs, "completed_jobs"),
    totalWorkValue: number(row.run_total_work_value, "total_work_value"),
    poolAmount: number(row.run_pool_amount, "pool_amount"),
    insidePoolTotal: number(row.run_inside_pool_total, "inside_pool_total"),
    outsidePoolTotal: number(row.run_outside_pool_total, "outside_pool_total"),
    payrollTotal: number(row.run_payroll_total, "payroll_total"),
    activeTechnicians: employees.length, technicians: employees, jobAllocations: allocations,
    coverage: row.run_coverage as CommissionCoverage,
    diagnostics: row.run_diagnostics as CommissionDiagnostic[],
    invariants: row.run_invariants as CommissionInvariants,
  };
}

function compareReadModels(
  expected: CommissionReadModel,
  actual: CommissionReadModel,
  authority: string,
  canonicalStoragePrecision = false,
) {
  if (!same(expected.config, actual.config)) fail(`${authority} config does not match replay`);
  if (!same(sortTechnicians(expected.technicians), sortTechnicians(actual.technicians))) {
    fail(`${authority} technician payouts do not match canonical replay${firstDifferenceDetail(sortTechnicians(expected.technicians), sortTechnicians(actual.technicians))}`);
  }
  const expectedAllocations = sortAllocations(expected.jobAllocations, canonicalStoragePrecision);
  const actualAllocations = sortAllocations(actual.jobAllocations, canonicalStoragePrecision);
  if (!same(expectedAllocations, actualAllocations)) {
    fail(`${authority} job allocations do not match canonical replay${firstDifferenceDetail(expectedAllocations, actualAllocations)}`);
  }
  if (!same(expected.coverage, actual.coverage)) {
    fail(`${authority} coverage does not match canonical replay${firstDifferenceDetail(expected.coverage, actual.coverage)}`);
  }
  if (!same(expected.invariants, actual.invariants)) fail(`${authority} invariants do not match canonical replay`);
  if (!same(expected.diagnostics, actual.diagnostics)) fail(`${authority} diagnostics do not match canonical replay`);
  for (const key of ["completedJobs", "totalWorkValue", "poolAmount", "insidePoolTotal", "outsidePoolTotal", "payrollTotal", "activeTechnicians"] as const) {
    if (expected[key] !== actual[key]) fail(`${authority} scalar ${key} does not match canonical replay`);
  }
}

function firstDifferenceDetail(expected: unknown, actual: unknown): string {
  const difference = firstDifference(expected, actual, "$" );
  if (!difference) return "";
  return ` at ${difference.path}: expected ${boundedJson(difference.expected)}, received ${boundedJson(difference.actual)}`;
}

function firstDifference(
  expected: unknown,
  actual: unknown,
  path: string,
): { path: string; expected: unknown; actual: unknown } | null {
  if (same(expected, actual)) return null;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      const difference = firstDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference) return difference;
    }
  }
  if (recordOrNull(expected) && recordOrNull(actual)) {
    const left = expected as Record<string, unknown>;
    const right = actual as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const difference = firstDifference(left[key], right[key], `${path}.${key}`);
      if (difference) return difference;
    }
  }
  return { path, expected, actual };
}

function boundedJson(value: unknown): string {
  const encoded = commissionStableJson(value);
  return encoded.length <= 240 ? encoded : `${encoded.slice(0, 237)}...`;
}

function compareScalars(row: CommissionCanonicalRunRow, replay: CommissionReadModel) {
  const pairs: Array<[unknown, number, string]> = [
    [row.run_completed_jobs, replay.completedJobs, "completed_jobs"],
    [row.run_total_work_value, replay.totalWorkValue, "total_work_value"],
    [row.run_pool_amount, replay.poolAmount, "pool_amount"],
    [row.run_inside_pool_total, replay.insidePoolTotal, "inside_pool_total"],
    [row.run_outside_pool_total, replay.outsidePoolTotal, "outside_pool_total"],
    [row.run_payroll_total, replay.payrollTotal, "payroll_total"],
  ];
  for (const [actual, expected, name] of pairs) if (number(actual, name) !== expected) fail(`${name} does not match canonical replay`);
}

function validatePersonMapping(timesheet: Record<string, unknown>, mappings: CommissionHashManifestEntry[]) {
  const person = recordOrNull(timesheet.person);
  const employeeId = nullablePositiveId(timesheet.employeeId, "timesheet employeeId");
  const identity = person ? positiveId(person.personId, "personId") : `employee:${employeeId ?? "unmapped"}:unmapped`;
  const matches = mappings.filter((entry) => entry.sourceIdentity === identity);
  if (matches.length !== 1) fail(`timesheet person mapping ${identity} is missing or duplicated`);
  const mapping = requiredRecord(matches[0].input, `person mapping ${identity}`);
  const expected = {
    employeeId: timesheet.employeeId ?? null,
    person: timesheet.person ?? null,
    fieldClassification: timesheet.fieldClassification,
    fieldTechnician: timesheet.fieldTechnician,
  };
  if (!same(mapping, expected)) fail(`timesheet person mapping ${identity} does not match source classification`);
  return identity;
}

function parseOverride(row: Record<string, unknown>): CommissionTypedOverrideInput {
  const employeeId = positiveId(row.employee_id, "override employee_id");
  const field = String(row.field_name ?? "");
  const reason = nonempty(row.reason, "override reason");
  const value = row.after_value;
  const expectedPoolTreatment = field === "final_bonus" || field === "inside_pool_adjustment"
    ? "inside_pool"
    : field === "outside_pool_adjustment" ? "outside_pool" : "neutral";
  if (row.pool_treatment !== expectedPoolTreatment) fail("override pool treatment does not match its field contract");
  switch (field) {
    case "included":
      if (typeof value !== "boolean") fail("included override value is invalid");
      return { employeeId, field, value, reason, poolTreatment: "neutral" };
    case "allocated_value": {
      const numeric = requireFinite(value, `${field} override`);
      if (numeric < 0) fail(`${field} override is negative`);
      return { employeeId, field, value: numeric, reason, poolTreatment: "neutral" };
    }
    case "final_bonus": {
      const numeric = requireFinite(value, `${field} override`);
      if (numeric < 0) fail(`${field} override is negative`);
      return { employeeId, field, value: numeric, reason, poolTreatment: "inside_pool" };
    }
    case "inside_pool_adjustment": {
      const numeric = requireFinite(value, `${field} override`);
      return { employeeId, field, value: numeric, reason, poolTreatment: "inside_pool" };
    }
    case "outside_pool_adjustment": {
      const numeric = requireFinite(value, `${field} override`);
      return { employeeId, field, value: numeric, reason, poolTreatment: "outside_pool" };
    }
    case "tier":
      if (!isTier(value)) fail("tier override value is invalid");
      return { employeeId, field, value, reason, poolTreatment: "neutral" };
    case "notes":
      if (typeof value !== "string") fail("notes override value is invalid");
      return { employeeId, field, value, reason, poolTreatment: "neutral" };
    default: fail("override field is unsupported");
  }
}

export function requiredCommissionBackfillIdentities(periodStart: string, periodEnd: string, efficiencyEnabled: boolean) {
  const families = ["jobs", "job_nested", "employees", "timesheets", "jobs_from_timesheets"];
  if (efficiencyEnabled) families.push("quotes", "quote_nested");
  return monthStarts(periodStart, periodEnd).flatMap((month) => families.map((family) => `${family}:${month}`)).sort();
}

export function requiredCommissionReconciliationScopes(efficiencyEnabled: boolean) {
  return efficiencyEnabled ? ["jobs", "technicians", "quotes"] : ["jobs", "technicians"];
}

function monthStarts(periodStart: string, periodEnd: string) {
  const current = new Date(`${periodStart.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${periodEnd.slice(0, 7)}-01T00:00:00Z`);
  const months: string[] = [];
  while (current <= end) {
    months.push(current.toISOString().slice(0, 10));
    current.setUTCMonth(current.getUTCMonth() + 1);
  }
  return months;
}

function parseManifest(value: unknown) {
  if (!Array.isArray(value)) fail("input manifest is not an array");
  const entries = value.map((item) => {
    const entry = requiredRecord(item, "manifest entry");
    const inputType = String(entry.inputType ?? "");
    if (!commissionManifestInputTypes.includes(inputType as CommissionManifestInputType)) fail(`unsupported manifest input type ${inputType}`);
    return {
      inputType, sourceIdentity: nonempty(entry.sourceIdentity, "manifest sourceIdentity"),
      sourceVersion: nonempty(entry.sourceVersion, "manifest sourceVersion"),
      sourceHash: nonempty(entry.sourceHash, "manifest sourceHash"), input: entry.input,
    } satisfies CommissionHashManifestEntry;
  });
  if (new Set(entries.map((entry) => `${entry.inputType}:${entry.sourceIdentity}`)).size !== entries.length) fail("manifest identities are duplicated");
  const sorted = [...entries].sort((a, b) => a.inputType.localeCompare(b.inputType) || a.sourceIdentity.localeCompare(b.sourceIdentity));
  return sorted;
}

function groupManifest(manifest: CommissionHashManifestEntry[]) {
  const groups: ManifestGroups = {};
  for (const entry of manifest) {
    const type = entry.inputType as CommissionManifestInputType;
    groups[type] = [...(groups[type] ?? []), entry];
  }
  return groups;
}

function sortTechnicians(values: CommissionTechnicianResult[]) {
  return [...values].sort((a, b) => a.employeeId.localeCompare(b.employeeId, undefined, { numeric: true }));
}

function sortAllocations(values: CommissionJobAllocationResult[], canonicalStoragePrecision = false) {
  return values.map((value) => ({
    jobId: value.jobId,
    employeeId: value.employeeId,
    jobTotal: canonicalStoragePrecision ? roundToScale(value.jobTotal, 2) : value.jobTotal,
    employeeHours: canonicalStoragePrecision ? roundToScale(value.employeeHours, 2) : value.employeeHours,
    jobTotalHours: canonicalStoragePrecision ? roundToScale(value.jobTotalHours, 2) : value.jobTotalHours,
    share: canonicalStoragePrecision ? roundToScale(value.share, 8) : value.share,
    allocatedValue: canonicalStoragePrecision ? roundToScale(value.allocatedValue, 2) : value.allocatedValue,
    included: value.included,
  })).sort((a, b) => a.jobId.localeCompare(b.jobId, undefined, { numeric: true })
    || a.employeeId.localeCompare(b.employeeId, undefined, { numeric: true }));
}

function roundToScale(value: number, scale: number) {
  return Number(value.toFixed(scale));
}

function requireCount(values: unknown[] | undefined, count: number, label: string) {
  if (values?.length !== count) fail(`manifest must contain exactly ${count} ${label} row`);
}

function exactHash(value: unknown, label: string) {
  if (!isCommissionSha256(value)) fail(`${label} is not an exact SHA-256 hex value`);
  return value;
}

function hashEqual(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function same(left: unknown, right: unknown) {
  return commissionHashJson(left) === commissionHashJson(right);
}

function requiredRecord(value: unknown, label: string) {
  const result = recordOrNull(value);
  if (!result) fail(`${label} is not an object`);
  return result;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asRecord(value: unknown) {
  return recordOrNull(value) ?? {};
}

function arrayRecords(value: unknown) {
  if (!Array.isArray(value)) fail("expected an array of objects");
  return value.map((item) => requiredRecord(item, "array entry"));
}

function arrayStrings(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail("evidence identities must be strings");
  return [...new Set(value)].sort();
}

function positiveId(value: unknown, label: string) {
  const result = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!/^\d+$/.test(result) || result === "0") fail(`${label} is not a positive numeric ID`);
  return result;
}

function nullablePositiveId(value: unknown, label: string) {
  return value === null || value === undefined ? null : positiveId(value, label);
}

function requireFinite(value: unknown, label: string) {
  const result = finiteValue(value);
  if (result === null) fail(`${label} is not finite`);
  return result;
}

function finiteValue(value: unknown) {
  const result = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(result) ? result : null;
}

function number(value: unknown, label: string) {
  return requireFinite(value, label);
}

function nonempty(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is empty`);
  return value;
}

function requireDate(value: unknown, label: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} is invalid`);
  return value;
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) fail(label);
  return value;
}

function increment(value: number, step: number) {
  return Math.abs(value / step - Math.round(value / step)) < 1e-9;
}

function isTier(value: unknown): value is CommissionTier {
  return value === "Gold" || value === "Silver" || value === "Bronze" || value === "Standard";
}

function isEvidenceState(value: string): value is CommissionEvidenceState {
  return value === "complete" || value === "complete_no_qualifying_work" || value === "missing"
    || value === "loading" || value === "error";
}

function sum(values: Iterable<number>) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function fail(message: string): never {
  throw new CommissionIntegrityError(message);
}

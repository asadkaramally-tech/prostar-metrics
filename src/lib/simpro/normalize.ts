import { dealTier } from "@/lib/metrics/quotes";
import { isCompletedJobStage } from "@/lib/metrics/jobs";
import { pickId, pickName } from "@/lib/simpro/schemas";
import {
  resolveJobConvertedFrom,
  resolveQuoteDirectLinkedJobId,
} from "@/lib/simpro/relationship-provenance";
import {
  queryPostgres,
  withPostgresTransaction,
  type PostgresQuery,
} from "@/lib/store/postgres";
import { reprojectImportedJobCategories } from "@/lib/store/job-category-rebuild";
import {
  categoryForVerifiedConfiguredCostCenterId,
  QUOTE_CATEGORY_ADVISORY_LOCK_KEY,
} from "@/lib/store/quote-category-rebuild";
import {
  acquireQuoteClassificationAdvisoryLock,
  reclassifyPersistedQuote,
} from "@/lib/store/quote-classification-rebuild";
import { applyReviewedQuoteExclusionSeeds } from "@/lib/store/reviewed-quote-exclusions";

export type NormalizationEntity = "quotes" | "jobs" | "employees" | "timesheets" | "schedules" | "mobile_status";

export type NormalizationResult = {
  entity: NormalizationEntity;
  normalized: boolean;
  affectedPeriods: Array<{ scope: "quotes" | "jobs" | "technicians" | "commissions"; periodStart: string }>;
};

type SnapshotProvenance = {
  sourceSnapshotId: number | null;
  sourceHash: string | null;
  sourceVersion: string;
  fetchedAt: string | null;
};

export type CostCenterRollup = {
  sectionId: number;
  costCenterId: number;
  configuredCostCenterId: number | null;
  configuredCostCenterName: string | null;
  name: string | null;
  category: string;
  laborHours: number | null;
  sellValue: number | null;
  costValue: number | null;
  materialSellValue: number | null;
  materialCostValue: number | null;
  totals: JobFinancialTotals;
};

export type JobFinancialTotals = {
  nettProfitActual: number | null;
  nettProfitEstimate: number | null;
  nettMarginActual: number | null;
  nettMarginEstimate: number | null;
  grossProfitActual: number | null;
  grossProfitEstimate: number | null;
  grossMarginActual: number | null;
  grossMarginEstimate: number | null;
  materialsCostActual: number | null;
  materialsCostEstimate: number | null;
  laborCostActual: number | null;
  laborCostEstimate: number | null;
  laborHoursActual: number | null;
  laborHoursEstimate: number | null;
  overheadActual: number | null;
  overheadEstimate: number | null;
  resourceTotalActual: number | null;
  resourceTotalEstimate: number | null;
  commissionActual: number | null;
};

export type JobSource = {
  type: "Quote" | "Recurring" | "Direct service";
  id: number | null;
  convertedAt: string | null;
};

export type EmployeeCapacity = {
  availability: unknown[] | Record<string, unknown> | string | null;
  capacitySource: "simpro_availability" | "default_business_hours";
  weekdayCapacityHours: number | null;
  weeklyCapacityHours: number | null;
  schedule: Record<string, unknown>;
};

export const DEFAULT_EMPLOYEE_AVAILABILITY = {
  source: "default_business_hours",
  timezone: "America/Los_Angeles",
  weekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  start: "08:30",
  end: "17:00",
  lunchMinutes: 30,
  workHoursPerWeekday: 8,
} as const;

export async function normalizeSimproSnapshot(params: {
  entity: NormalizationEntity;
  entityId: string;
  payload: Record<string, unknown>;
  sourceSnapshotId?: number | null;
  sourceHash?: string | null;
  sourceVersion?: string;
  fetchedAt?: string | null;
  traversalGeneration?: number;
  query?: PostgresQuery;
}): Promise<NormalizationResult> {
  const provenance: SnapshotProvenance = {
    sourceSnapshotId: params.sourceSnapshotId ?? null,
    sourceHash: params.sourceHash ?? null,
    sourceVersion: params.sourceVersion ?? "current",
    fetchedAt: params.fetchedAt ?? null,
  };
  switch (params.entity) {
    case "quotes":
      return params.query
        ? normalizeQuote(params.entityId, params.payload, provenance, params.query)
        : withPostgresTransaction((query) => normalizeQuote(params.entityId, params.payload, provenance, query));
    case "jobs":
      return params.query
        ? normalizeJob(params.entityId, params.payload, provenance, params.query)
        : withPostgresTransaction((query) => normalizeJob(params.entityId, params.payload, provenance, query));
    case "employees":
      return normalizeEmployee(params.entityId, params.payload, provenance, params.query ?? queryPostgres);
    case "timesheets":
      return params.query
        ? normalizeTimesheet(params.entityId, params.payload, provenance, params.query)
        : withPostgresTransaction((query) => normalizeTimesheet(params.entityId, params.payload, provenance, query));
    case "schedules":
      return params.query
        ? normalizeSchedule(
            params.entityId,
            params.payload,
            provenance,
            params.query,
            params.traversalGeneration,
          )
        : withPostgresTransaction((query) => normalizeSchedule(
            params.entityId,
            params.payload,
            provenance,
            query,
            params.traversalGeneration,
          ));
    case "mobile_status":
      return params.query
        ? normalizeMobileStatus(params.entityId, params.payload, provenance, params.query)
        : withPostgresTransaction((query) => normalizeMobileStatus(params.entityId, params.payload, provenance, query));
    default:
      assertNever(params.entity);
  }
}

async function normalizeQuote(
  entityId: string,
  payload: Record<string, unknown>,
  provenance: SnapshotProvenance,
  query: PostgresQuery,
): Promise<NormalizationResult> {
  const quoteId = numericId(entityId);
  if (quoteId === null) {
    return { entity: "quotes", normalized: false, affectedPeriods: [] };
  }

  const totalValue = projectTotalExTax(payload, "quote", quoteId);
  await acquireQuoteClassificationAdvisoryLock(query);
  const previousQuote = await query<{ date_approved: string | null }>(
    `select date_approved::text
       from metrics.metrics_quotes
      where quote_id = $1`,
    [quoteId],
  );

  const dateIssued = dateValue(payload.DateIssued ?? payload.dateIssued ?? payload.date_issued);
  const dateApproved = dateValue(payload.DateApproved ?? payload.dateApproved ?? payload.date_approved);
  const { stageName, customerStageName } = extractQuoteStageNames(payload);
  const salesperson = payload.Salesperson ?? payload.Salesman ?? payload.SalesRep ?? payload.salesperson;
  const salespersonId = numericId(pickId(salesperson));
  const salespersonName = pickName(salesperson);
  const linkedJobId = extractQuoteLinkedJobId(payload);
  const status = payload.Status ?? payload.status;
  const customer = payload.Customer ?? payload.customer;
  const site = payload.Site ?? payload.site;
  const tier = dealTier(totalValue);

  if (salespersonId !== null) {
    await upsertPerson(salespersonId, salespersonName ?? `Employee ${salespersonId}`, "salesperson", true, false, query);
  }

  await query(
    `with category_serialization as materialized (
       select pg_advisory_xact_lock($31::bigint)
     )
     insert into metrics.metrics_quotes (
       quote_id, quote_no, date_issued, date_approved, stage, customer_stage,
       salesperson_id, salesperson_name, total, linked_job_id, job_no,
       won_reason, category, source_snapshot_id, source_hash, source_version,
       fetched_at, name, description, status_id, status_name, is_closed,
       customer_id, customer_name, site_id, site_name,
       outcome, outcome_reason, deal_tier, category_basis, updated_from_source_at
     )
     select
       $1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17::timestamptz, $18, $19, $20, $21, $22, $23, $24,
       $25, $26, $27, $28, $29, $30, now()
       from category_serialization
     on conflict (quote_id) do update set
       quote_no = excluded.quote_no,
       date_issued = excluded.date_issued,
       date_approved = excluded.date_approved,
       stage = excluded.stage,
       customer_stage = excluded.customer_stage,
       salesperson_id = excluded.salesperson_id,
       salesperson_name = excluded.salesperson_name,
       total = excluded.total,
       linked_job_id = excluded.linked_job_id,
       job_no = excluded.job_no,
       source_snapshot_id = excluded.source_snapshot_id,
       source_hash = excluded.source_hash,
       source_version = excluded.source_version,
       fetched_at = excluded.fetched_at,
       name = excluded.name,
       description = excluded.description,
       status_id = excluded.status_id,
       status_name = excluded.status_name,
       is_closed = excluded.is_closed,
       customer_id = excluded.customer_id,
       customer_name = excluded.customer_name,
       site_id = excluded.site_id,
       site_name = excluded.site_name,
       deal_tier = excluded.deal_tier,
       source_deleted_at = null,
       updated_from_source_at = now()`,
    [
      quoteId,
      stringValue(payload.QuoteNo ?? payload.quoteNo ?? payload.No ?? payload.No_),
      dateIssued,
      dateApproved,
      stageName,
      customerStageName,
      salespersonId,
      salespersonName,
      totalValue,
      linkedJobId,
      stringValue(payload.JobNo ?? payload.jobNo),
      "pending_persisted_reclassification",
      "Unclassified",
      provenance.sourceSnapshotId,
      provenance.sourceHash,
      provenance.sourceVersion,
      provenance.fetchedAt,
      stringValue(payload.Name ?? payload.Subject ?? payload.Description ?? payload.name) ?? `Quote ${quoteId}`,
      stringValue(payload.Description),
      numericId(pickId(status)),
      pickName(status),
      booleanValue(payload.IsClosed, false),
      numericId(pickId(customer)),
      customerDisplayName(customer),
      numericId(pickId(site)),
      pickName(site),
      "unknown",
      "pending_persisted_reclassification",
      tier,
      "nested traversal pending",
      QUOTE_CATEGORY_ADVISORY_LOCK_KEY,
    ],
  );

  await query(
    `with category_serialization as materialized (
       select pg_advisory_xact_lock($20::bigint)
     )
     insert into metrics.quote_snapshots (
       quote_id, quote_no, name, status_name, stage_name, customer_stage_name,
       salesperson_id, salesperson_name, owner_name, linked_job_id, job_no,
       date_issued, date_approved, total_value, won_value, deal_tier, category,
       category_basis, won, win_loss_reason, source_snapshot_id, updated_at
     )
     select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
            $12::date, $13::date, $14, $15, $16, q.category, q.category_basis,
            $17, $18, $19, now()
       from metrics.metrics_quotes q
       cross join category_serialization
      where q.quote_id = $1
     on conflict (quote_id) do update set
       quote_no = excluded.quote_no,
       name = excluded.name,
       status_name = excluded.status_name,
       stage_name = excluded.stage_name,
       customer_stage_name = excluded.customer_stage_name,
       salesperson_id = excluded.salesperson_id,
       salesperson_name = excluded.salesperson_name,
       owner_name = excluded.owner_name,
       linked_job_id = excluded.linked_job_id,
       job_no = excluded.job_no,
       date_issued = excluded.date_issued,
       date_approved = excluded.date_approved,
       total_value = excluded.total_value,
       deal_tier = excluded.deal_tier,
       source_snapshot_id = excluded.source_snapshot_id,
       updated_at = now()`,
    [
      quoteId,
      stringValue(payload.QuoteNo ?? payload.quoteNo ?? payload.No ?? payload.No_),
      stringValue(payload.Name ?? payload.Subject ?? payload.Description ?? payload.name) ?? `Quote ${quoteId}`,
      namedValue(payload.Status ?? payload.status),
      stageName,
      customerStageName,
      salespersonId,
      salespersonName,
      null,
      linkedJobId,
      stringValue(payload.JobNo ?? payload.jobNo),
      dateIssued,
      dateApproved,
      totalValue,
      0,
      tier,
      false,
      "pending_persisted_reclassification",
      provenance.sourceSnapshotId,
      QUOTE_CATEGORY_ADVISORY_LOCK_KEY,
    ],
  );

  await applyReviewedQuoteExclusionSeeds([quoteId], query);
  await reclassifyPersistedQuote(quoteId, query);

  const affectedPeriods = quoteTransitionPeriodStarts(
    previousQuote.rows[0]?.date_approved ?? null,
    dateApproved,
  ).map((periodStart) => ({ scope: "quotes" as const, periodStart }));
  return { entity: "quotes", normalized: true, affectedPeriods };
}

async function normalizeJob(
  entityId: string,
  payload: Record<string, unknown>,
  provenance: SnapshotProvenance,
  query: PostgresQuery,
): Promise<NormalizationResult> {
  const jobId = numericId(entityId);
  if (jobId === null) {
    return { entity: "jobs", normalized: false, affectedPeriods: [] };
  }

  const totalValue = projectTotalExTax(payload, "job", jobId);
  await acquireQuoteClassificationAdvisoryLock(query);
  const previousJob = await query<{
    completed_date: string | null;
    stage: string | null;
    converted_from_type: string | null;
    converted_from_id: string | null;
  }>(
    `select completed_date::text, stage, converted_from_type, converted_from_id::text
       from metrics.metrics_jobs
      where job_id = $1`,
    [jobId],
  );

  const completedDate = dateValue(payload.CompletedDate ?? payload.DateCompleted ?? payload.completedDate ?? payload.completed_date);
  const stageName = extractJobStageName(payload);
  const nextJobNo = stringValue(payload.JobNo ?? payload.jobNo ?? payload.No);
  const financials = extractJobFinancialTotals(payload);
  const grossProfit = financials.grossProfitActual;
  const grossMargin = financials.grossMarginActual;
  const customer = payload.Customer ?? payload.customer;
  const site = payload.Site ?? payload.site;
  const source = extractJobSource(payload);
  const sourceQuoteId = source.type === "Quote" ? source.id : null;
  const status = payload.Status ?? payload.status;
  const costCenters = extractCostCenterRollups(payload);
  const category = jobCategoryFromCostCenters(costCenters);
  const quotedLaborHours = sumNullable(costCenters.map((costCenter) => costCenter.laborHours));

  await query(
    `insert into metrics.metrics_jobs (
       job_id, job_no, completed_date, stage, customer_id, site_id, total,
       gross_profit_actual, gross_margin_actual, converted_from_type, converted_from_id,
       category, source_snapshot_id, source_hash, source_version, fetched_at,
       name, description, status_id, status_name, converted_from_at,
       net_profit_actual, net_margin_actual, materials_cost_actual, materials_cost_estimate,
       labor_cost_actual, labor_cost_estimate, labor_hours_actual, labor_hours_estimate,
       overhead_cost_actual, overhead_cost_estimate,
       total_resource_cost_actual, total_resource_cost_estimate,
       commission_cost_actual, job_source_type, job_source_id, customer_name, site_name,
       profit_capacity_normalized_at, updated_from_source_at
     )
     values (
       $1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16::timestamptz, $17, $18, $19, $20,
       $21::timestamptz, $22, $23, $24, $25, $26, $27, $28, $29,
       $30, $31, $32, $33, $34, $35, $36, $37, $38, now(), now()
     )
     on conflict (job_id) do update set
       job_no = excluded.job_no,
       completed_date = excluded.completed_date,
       stage = excluded.stage,
       customer_id = excluded.customer_id,
       site_id = excluded.site_id,
       total = excluded.total,
       gross_profit_actual = excluded.gross_profit_actual,
       gross_margin_actual = excluded.gross_margin_actual,
       converted_from_type = excluded.converted_from_type,
       converted_from_id = excluded.converted_from_id,
       category = excluded.category,
       source_snapshot_id = excluded.source_snapshot_id,
       source_hash = excluded.source_hash,
       source_version = excluded.source_version,
       fetched_at = excluded.fetched_at,
       name = excluded.name,
       description = excluded.description,
       status_id = excluded.status_id,
       status_name = excluded.status_name,
       converted_from_at = excluded.converted_from_at,
       net_profit_actual = excluded.net_profit_actual,
       net_margin_actual = excluded.net_margin_actual,
       materials_cost_actual = excluded.materials_cost_actual,
       materials_cost_estimate = excluded.materials_cost_estimate,
       labor_cost_actual = excluded.labor_cost_actual,
       labor_cost_estimate = excluded.labor_cost_estimate,
       labor_hours_actual = excluded.labor_hours_actual,
       labor_hours_estimate = excluded.labor_hours_estimate,
       overhead_cost_actual = excluded.overhead_cost_actual,
       overhead_cost_estimate = excluded.overhead_cost_estimate,
       total_resource_cost_actual = excluded.total_resource_cost_actual,
       total_resource_cost_estimate = excluded.total_resource_cost_estimate,
       commission_cost_actual = excluded.commission_cost_actual,
       job_source_type = excluded.job_source_type,
       job_source_id = excluded.job_source_id,
       customer_name = excluded.customer_name,
       site_name = excluded.site_name,
       profit_capacity_normalized_at = now(),
       source_deleted_at = null,
       updated_from_source_at = now()`,
    [
      jobId,
      nextJobNo,
      completedDate,
      stageName,
      numericId(pickId(customer)),
      numericId(pickId(site)),
      totalValue,
      grossProfit,
      grossMargin,
      source.type,
      source.id,
      category,
      provenance.sourceSnapshotId,
      provenance.sourceHash,
      provenance.sourceVersion,
      provenance.fetchedAt,
      stringValue(payload.Name ?? payload.Description ?? payload.name) ?? `Job ${jobId}`,
      stringValue(payload.Description),
      numericId(pickId(status)),
      pickName(status),
      source.convertedAt,
      financials.nettProfitActual,
      financials.nettMarginActual,
      financials.materialsCostActual,
      financials.materialsCostEstimate,
      financials.laborCostActual,
      financials.laborCostEstimate,
      financials.laborHoursActual,
      financials.laborHoursEstimate,
      financials.overheadActual,
      financials.overheadEstimate,
      financials.resourceTotalActual,
      financials.resourceTotalEstimate,
      financials.commissionActual,
      source.type,
      source.id,
      pickName(customer),
      pickName(site),
    ],
  );

  const priorJob = previousJob.rows[0];
  const quoteIdsToReclassify = await quoteIdsAffectedByJobEvidence({
    jobId,
    previousSourceQuoteId: priorJob?.converted_from_type?.trim().toLowerCase() === "quote"
      ? numericId(priorJob.converted_from_id)
      : null,
    nextSourceQuoteId: sourceQuoteId,
  }, query);

  await upsertJobCostCenters(jobId, costCenters, query);
  await reprojectImportedJobCategories([jobId], query);

  await query(
    `insert into metrics.job_snapshots (
       job_id, job_no, name, status_name, stage_name, completed_date,
       customer_id, customer_name, site_id, site_name, source_quote_id,
       sell_value, gross_profit, gross_margin_percent, labor_quoted_hours, labor_coverage,
       material_coverage, source_snapshot_id, updated_at
     )
     values ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'coverage_only', $17, now())
     on conflict (job_id) do update set
       job_no = excluded.job_no,
       name = excluded.name,
       status_name = excluded.status_name,
       stage_name = excluded.stage_name,
       completed_date = excluded.completed_date,
       customer_id = excluded.customer_id,
       customer_name = excluded.customer_name,
       site_id = excluded.site_id,
       site_name = excluded.site_name,
       source_quote_id = excluded.source_quote_id,
       sell_value = excluded.sell_value,
       gross_profit = excluded.gross_profit,
       gross_margin_percent = excluded.gross_margin_percent,
       labor_quoted_hours = excluded.labor_quoted_hours,
       labor_coverage = excluded.labor_coverage,
       source_snapshot_id = excluded.source_snapshot_id,
       updated_at = now()`,
    [
      jobId,
      nextJobNo,
      stringValue(payload.Name ?? payload.Description ?? payload.name) ?? `Job ${jobId}`,
      namedValue(payload.Status ?? payload.status),
      stageName,
      completedDate,
      numericId(pickId(customer)),
      pickName(customer),
      numericId(pickId(site)),
      pickName(site),
      sourceQuoteId,
      totalValue,
      grossProfit,
      grossMargin,
      quotedLaborHours,
      quotedLaborHours === null ? "unknown" : "quoted_labor_from_cost_centers",
      provenance.sourceSnapshotId,
    ],
  );

  for (const quoteId of quoteIdsToReclassify) {
    await reclassifyPersistedQuote(quoteId, query);
  }

  const prior = previousJob.rows[0];
  const affectedPeriods: NormalizationResult["affectedPeriods"] = jobTransitionPeriodStarts(
    { completedDate: prior?.completed_date ?? null, stageName: prior?.stage ?? null },
    { completedDate, stageName },
  ).flatMap((periodStart) => [
    { scope: "jobs" as const, periodStart },
    { scope: "technicians" as const, periodStart },
    { scope: "commissions" as const, periodStart },
  ]);

  if (quoteIdsToReclassify.length > 0) {
    const quotePeriods = await query<{ date_approved: string | null }>(
      `select date_approved::text
         from metrics.metrics_quotes
        where quote_id = any($1::bigint[])`,
      [quoteIdsToReclassify],
    );
    for (const quote of quotePeriods.rows) {
      if (quote.date_approved) {
        affectedPeriods.push({ scope: "quotes", periodStart: monthStart(quote.date_approved) });
      }
    }
  }

  const uniqueAffectedPeriods = [...new Map(
    affectedPeriods.map((affected) => [`${affected.scope}:${affected.periodStart}`, affected]),
  ).values()];
  return { entity: "jobs", normalized: true, affectedPeriods: uniqueAffectedPeriods };
}

async function normalizeEmployee(
  entityId: string,
  payload: Record<string, unknown>,
  provenance: SnapshotProvenance,
  query: PostgresQuery,
): Promise<NormalizationResult> {
  const employeeId = numericId(entityId);
  if (employeeId === null) {
    return { entity: "employees", normalized: false, affectedPeriods: [] };
  }

  const displayName = pickName(payload) ?? stringValue(payload.DisplayName ?? payload.Name) ?? `Employee ${employeeId}`;
  const archived = booleanValue(payload.Archived ?? payload.archived, false);
  const dateOfHire = dateValue(payload.DateOfHire ?? payload.dateOfHire ?? payload.date_of_hire);
  const position = stringValue(payload.Position);
  const capacity = normalizeEmployeeCapacity(payload.Availability ?? payload.availability);

  // Read the prior roster-relevant state before the upsert so position,
  // archived, hire-date, and availability changes can invalidate the
  // technician read models built from them.
  const previous = await query<{
    position: string | null;
    archived: boolean | null;
    date_of_hire: string | null;
    availability_json: unknown;
  }>(
    `select position, archived, date_of_hire::text, availability_json
       from metrics.dim_people
      where simpro_employee_id = $1`,
    [employeeId],
  );

  await query(
    `insert into metrics.employee_snapshots (employee_id, display_name, email, archived, source_snapshot_id, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (employee_id) do update set
       display_name = excluded.display_name,
       email = excluded.email,
       archived = excluded.archived,
       source_snapshot_id = excluded.source_snapshot_id,
       updated_at = now()`,
    [
      employeeId,
      displayName,
      stringValue(objectValue(payload.PrimaryContact)?.Email ?? payload.Email ?? payload.email),
      archived,
      provenance.sourceSnapshotId,
    ],
  );

  await upsertPerson(employeeId, displayName, "employee", !archived, true, query);
  await query(
    `update metrics.dim_people
        set email = $2,
            position = $3,
            source_created_at = $4::timestamptz,
            source_modified_at = $5::timestamptz,
            date_of_hire = $6::date,
            archived = $7,
            availability_json = $8::jsonb,
            capacity_source = $9,
            weekday_capacity_hours = $10,
            weekly_capacity_hours = $11,
            capacity_normalized_at = now(),
            last_seen_at = now()
      where simpro_employee_id = $1`,
    [
      employeeId,
      stringValue(objectValue(payload.PrimaryContact)?.Email ?? payload.Email ?? payload.email),
      position,
      timestampValue(payload.DateCreated),
      timestampValue(payload.DateModified),
      dateOfHire,
      archived,
      JSON.stringify(capacity.schedule),
      capacity.capacitySource,
      capacity.weekdayCapacityHours,
      capacity.weeklyCapacityHours,
    ],
  );

  const prior = previous.rows[0];
  // Roster membership follows recorded work, so any employee whose attributes
  // change can be a member of some month's roster.
  const rosterAttributesChanged = !prior
    || (prior.position ?? null) !== (position ?? null)
    || (prior.archived === true) !== archived
    || (prior.date_of_hire ?? null) !== (dateOfHire ?? null)
    || stableJsonText(prior.availability_json ?? null) !== stableJsonText(capacity.schedule ?? null);
  const affectedPeriods: NormalizationResult["affectedPeriods"] = rosterAttributesChanged
    ? employeeRosterPeriodStarts(pacificToday()).flatMap((periodStart) => [
        { scope: "technicians" as const, periodStart },
        { scope: "commissions" as const, periodStart },
      ])
    : [];

  return { entity: "employees", normalized: true, affectedPeriods };
}

async function normalizeTimesheet(
  entityId: string,
  payload: Record<string, unknown>,
  provenance: SnapshotProvenance,
  query: PostgresQuery,
): Promise<NormalizationResult> {
  const employeeId = numericId(payload.EmployeeID ?? payload.employeeId ?? entityId.split(":")[0]);
  const uid = stringValue(payload.UID ?? entityId);
  if (employeeId === null || !uid) {
    return { entity: "timesheets", normalized: false, affectedPeriods: [] };
  }

  const reference = stringValue(payload.Reference);
  const href = stringValue(payload._href);
  const referenceInfo = parseReference(payload.ScheduleType, reference, href);
  const workDate = dateValue(payload.Date);
  const startAt = dateTimeValue(workDate, payload.StartTime);
  const endAt = dateTimeValue(workDate, payload.EndTime);
  const totalHours = moneyValue(payload.TotalHrs ?? payload.TotalHours);
  const scheduleRateId = numericId(pickId(payload.ScheduleRate));
  const scheduleRateName = pickName(payload.ScheduleRate);

  await upsertPerson(employeeId, pickName(payload.Employee ?? payload.Staff) ?? `Employee ${employeeId}`, "employee", true, false, query);

  await query(
    `insert into metrics.metrics_employee_timesheets (
       timesheet_id, employee_id, person_id, reference_type, reference_id, reference_raw,
       work_date, start_time, end_time, total_hours, schedule_rate, schedule_rate_id,
       schedule_rate_name, cost,
       overhead_cost, total_cost, parse_status, source_snapshot_id, source_hash,
       fetched_at, updated_from_source_at
     )
     values (
       $1, $2,
       (select person_id from metrics.dim_people where simpro_employee_id = $2),
       $3, $4, $5, $6::date, $7::timestamptz, $8::timestamptz, $9, null, $10,
       $11, $12, $13, $14, $15, $16, $17, $18::timestamptz, now()
     )
     on conflict (employee_id, timesheet_id) do update set
       employee_id = excluded.employee_id,
       person_id = excluded.person_id,
       reference_type = excluded.reference_type,
       reference_id = excluded.reference_id,
       reference_raw = excluded.reference_raw,
       work_date = excluded.work_date,
       start_time = excluded.start_time,
       end_time = excluded.end_time,
       total_hours = excluded.total_hours,
       schedule_rate = null,
       schedule_rate_id = excluded.schedule_rate_id,
       schedule_rate_name = excluded.schedule_rate_name,
       cost = excluded.cost,
       overhead_cost = excluded.overhead_cost,
       total_cost = excluded.total_cost,
       parse_status = excluded.parse_status,
       source_snapshot_id = excluded.source_snapshot_id,
       source_hash = excluded.source_hash,
       fetched_at = excluded.fetched_at,
       updated_from_source_at = now()`,
    [
      uid,
      employeeId,
      referenceInfo.type,
      referenceInfo.id,
      reference,
      workDate,
      startAt,
      endAt,
      totalHours,
      scheduleRateId,
      scheduleRateName,
      moneyValueOrNull(payload.Cost),
      moneyValueOrNull(payload.OverheadCost),
      moneyValueOrNull(payload.TotalCost),
      referenceInfo.id === null ? "unparsed_reference" : "parsed",
      provenance.sourceSnapshotId,
      provenance.sourceHash,
      provenance.fetchedAt,
    ],
  );

  await query(
    `insert into metrics.timesheet_snapshots (
       employee_id, simpro_timesheet_id, reference_type, reference_id, reference_href,
       work_date, start_at, end_at, total_hours, cost_value, source_snapshot_id
     )
     values ($1, $2, $3, $4, $5, $6::date, $7::timestamptz, $8::timestamptz, $9, $10, $11)
     on conflict (employee_id, simpro_timesheet_id) do update set
       reference_type = excluded.reference_type,
       reference_id = excluded.reference_id,
       reference_href = excluded.reference_href,
       work_date = excluded.work_date,
       start_at = excluded.start_at,
       end_at = excluded.end_at,
       total_hours = excluded.total_hours,
       cost_value = excluded.cost_value,
       source_snapshot_id = excluded.source_snapshot_id`,
    [employeeId, uid, referenceInfo.type, referenceInfo.id === null ? null : String(referenceInfo.id), href, workDate, startAt, endAt, totalHours, moneyValueOrNull(payload.TotalCost ?? payload.Cost), provenance.sourceSnapshotId],
  );

  const affectedPeriods = await affectedPeriodsForReferencedJob(referenceInfo, query);
  return { entity: "timesheets", normalized: true, affectedPeriods };
}

async function normalizeSchedule(
  entityId: string,
  payload: Record<string, unknown>,
  provenance: SnapshotProvenance,
  query: PostgresQuery,
  traversalGeneration?: number,
): Promise<NormalizationResult> {
  const scheduleId = numericId(pickId(payload) ?? entityId);
  if (scheduleId === null) {
    return { entity: "schedules", normalized: false, affectedPeriods: [] };
  }

  const referenceInfo = scheduleReference(payload);
  await acquireScheduleAdvisoryLock(query, scheduleId);
  const currentSchedule = await query<{
    reference_type: string | null;
    reference_id: string | null;
    source_modified_at: string | Date | null;
    fetched_at: string | Date | null;
  }>(
    `select reference_type, reference_id::text, source_modified_at, fetched_at
       from metrics.metrics_schedules
      where schedule_id = $1
      for update`,
    [scheduleId],
  );
  const incomingSourceModifiedAt = timestampValue(payload.DateModified);
  const currentReferenceMatches = currentSchedule.rows[0]
    ? currentSchedule.rows[0].reference_type?.toLowerCase() === referenceInfo.type
      && numericId(currentSchedule.rows[0].reference_id) === referenceInfo.id
    : false;
  if (!schedulePublicationIsCurrent(
    currentSchedule.rows[0],
    currentReferenceMatches,
    incomingSourceModifiedAt,
    provenance.fetchedAt,
  )) {
    return { entity: "schedules", normalized: false, affectedPeriods: [] };
  }
  const staff = payload.Staff;
  const staffId = numericId(pickId(staff));
  if (staffId !== null) {
    await upsertPerson(staffId, pickName(staff) ?? `Employee ${staffId}`, "employee", true, false, query);
  }
  const scheduleDate = dateValue(payload.Date);
  const blocks = Array.isArray(payload.Blocks) ? payload.Blocks : [];
  const firstBlock = objectValue(blocks[0]);
  const scheduleRate = firstBlock?.ScheduleRate;

  const serializeQuoteWrite = referenceInfo.type === "quote";
  const scheduleValues: unknown[] = [
    scheduleId,
    referenceInfo.type,
    referenceInfo.id,
    staffId,
    scheduleDate,
    moneyValueOrNull(payload.TotalHours),
    timeOnly(firstBlockValue(blocks, "StartTime") ?? payload.StartTime),
    timeOnly(firstBlockValue(blocks, "EndTime") ?? payload.EndTime),
    dateTimeValue(scheduleDate, firstBlockValue(blocks, "StartTime") ?? payload.StartTime),
    dateTimeValue(scheduleDate, firstBlockValue(blocks, "EndTime") ?? payload.EndTime),
    numericId(pickId(scheduleRate)),
    pickName(scheduleRate),
    stringValue(payload.Reference),
    incomingSourceModifiedAt,
    provenance.sourceSnapshotId,
    provenance.sourceHash,
    provenance.fetchedAt,
    traversalGeneration ?? null,
  ];
  if (serializeQuoteWrite) scheduleValues.push(QUOTE_CATEGORY_ADVISORY_LOCK_KEY);
  await query(
    `${scheduleTraversalWriteCtes(referenceInfo.type, "$3", "$18", serializeQuoteWrite ? "$19" : null, traversalGeneration !== undefined)}
     insert into metrics.metrics_schedules (
       schedule_id, reference_type, reference_id, staff_person_id, schedule_date,
       total_hours, start_time, end_time, iso_start_time, iso_end_time,
       schedule_rate_id, schedule_rate_name, reference_raw, source_modified_at,
       source_snapshot_id, source_hash, fetched_at, traversal_generation, updated_from_source_at
     )
     select $1, $2, $3,
       (select person_id from metrics.dim_people where simpro_employee_id = $4),
       $5::date, $6, $7::time, $8::time, $9::timestamptz, $10::timestamptz,
       $11, $12, $13, $14::timestamptz, $15, $16, $17::timestamptz, $18, now()
       from current_traversal
     on conflict (schedule_id) do update set
       reference_type = excluded.reference_type,
       reference_id = excluded.reference_id,
       staff_person_id = excluded.staff_person_id,
       schedule_date = excluded.schedule_date,
       total_hours = excluded.total_hours,
       start_time = excluded.start_time,
       end_time = excluded.end_time,
       iso_start_time = excluded.iso_start_time,
       iso_end_time = excluded.iso_end_time,
       schedule_rate_id = excluded.schedule_rate_id,
       schedule_rate_name = excluded.schedule_rate_name,
       reference_raw = excluded.reference_raw,
       source_modified_at = excluded.source_modified_at,
       source_snapshot_id = excluded.source_snapshot_id,
       source_hash = excluded.source_hash,
       fetched_at = excluded.fetched_at,
       traversal_generation = excluded.traversal_generation,
       source_deleted_at = null,
       updated_from_source_at = now()`,
    scheduleValues,
  );

  const snapshotValues: unknown[] = [
    scheduleId,
    referenceInfo.type,
    referenceInfo.id === null ? null : String(referenceInfo.id),
    referenceInfo.type,
    referenceInfo.id === null ? null : String(referenceInfo.id),
    JSON.stringify(staff ? [staff] : []),
    JSON.stringify(blocks),
    dateTimeValue(scheduleDate, firstBlockValue(blocks, "StartTime") ?? payload.StartTime),
    dateTimeValue(scheduleDate, firstBlockValue(blocks, "EndTime") ?? payload.EndTime),
    provenance.sourceSnapshotId,
    traversalGeneration ?? null,
  ];
  if (serializeQuoteWrite) snapshotValues.push(QUOTE_CATEGORY_ADVISORY_LOCK_KEY);
  await query(
    `${scheduleTraversalWriteCtes(referenceInfo.type, "$5::bigint", "$11", serializeQuoteWrite ? "$12" : null, traversalGeneration !== undefined)}
     insert into metrics.schedule_snapshots (
       schedule_id, reference_type, reference_id, project_type, project_id,
       staff, blocks, planned_start_at, planned_end_at, source_snapshot_id,
       traversal_generation
     )
     select $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::timestamptz,
            $9::timestamptz, $10, $11 from current_traversal
     on conflict (schedule_id) do update set
       reference_type = excluded.reference_type,
       reference_id = excluded.reference_id,
       project_type = excluded.project_type,
       project_id = excluded.project_id,
       staff = excluded.staff,
       blocks = excluded.blocks,
       planned_start_at = excluded.planned_start_at,
       planned_end_at = excluded.planned_end_at,
       source_snapshot_id = excluded.source_snapshot_id,
       traversal_generation = excluded.traversal_generation`,
    snapshotValues,
  );

  const affectedPeriods = scheduleDate && referenceInfo.type === "job"
    ? [{ scope: "technicians" as const, periodStart: monthStart(scheduleDate) }]
    : [];
  return { entity: "schedules", normalized: true, affectedPeriods };
}

export function scheduleBlockIdentity(
  schedule: Record<string, unknown>,
  block: Record<string, unknown>,
) {
  const blockWorkOrder = objectValue(block.WorkOrder);
  const scheduleWorkOrder = objectValue(schedule.WorkOrder);
  return {
    workOrderId: numericId(
      pickId(blockWorkOrder)
      ?? block.WorkOrderID
      ?? pickId(scheduleWorkOrder)
      ?? schedule.WorkOrderID,
    ),
    cancelled: booleanValue(block.Cancelled ?? schedule.Cancelled, false),
  };
}

async function normalizeMobileStatus(
  entityId: string,
  payload: Record<string, unknown>,
  provenance: SnapshotProvenance,
  query: PostgresQuery,
): Promise<NormalizationResult> {
  const logId = numericId(pickId(payload) ?? entityId);
  if (logId === null) {
    return { entity: "mobile_status", normalized: false, affectedPeriods: [] };
  }

  const staff = payload.Staff;
  const staffId = numericId(pickId(staff));
  if (staffId !== null) {
    await upsertPerson(staffId, pickName(staff) ?? `Employee ${staffId}`, "employee", true, false, query);
  }
  const workOrder = objectValue(payload.WorkOrder);
  const loggedAt = timestampValue(payload.DateLogged);
  const projectId = numericId(workOrder?.ProjectID);

  await query(
    `insert into metrics.metrics_mobile_status_logs (
       simpro_log_id, staff_person_id, work_order_id, work_order_type, project_id,
       cost_center_id, status_id, status_name, latitude, longitude, date_logged,
       coverage_window_start, coverage_window_end, fetched_at, source_snapshot_id,
       source_hash
     )
     values (
       $1,
       (select person_id from metrics.dim_people where simpro_employee_id = $2),
       $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $11::timestamptz,
       $11::timestamptz, coalesce($12::timestamptz, now()), $13, $14
     )
     on conflict (simpro_log_id) do update set
       staff_person_id = excluded.staff_person_id,
       work_order_id = excluded.work_order_id,
       work_order_type = excluded.work_order_type,
       project_id = excluded.project_id,
       cost_center_id = excluded.cost_center_id,
       status_id = excluded.status_id,
       status_name = excluded.status_name,
       latitude = excluded.latitude,
       longitude = excluded.longitude,
       date_logged = excluded.date_logged,
       coverage_window_start = excluded.coverage_window_start,
       coverage_window_end = excluded.coverage_window_end,
       fetched_at = excluded.fetched_at,
       source_snapshot_id = excluded.source_snapshot_id,
       source_hash = excluded.source_hash`,
    [
      logId,
      staffId,
      numericId(workOrder?.ID),
      stringValue(workOrder?.Type),
      projectId,
      numericId(workOrder?.CostCenterID),
      numericId(pickId(payload.Status)),
      pickName(payload.Status),
      moneyValueOrNull(payload.Latitude),
      moneyValueOrNull(payload.Longitude),
      loggedAt,
      provenance.fetchedAt,
      provenance.sourceSnapshotId,
      provenance.sourceHash,
    ],
  );

  const affectedPeriods = loggedAt && projectId !== null
    ? [{ scope: "technicians" as const, periodStart: monthStart(loggedAt) }]
    : [];
  return { entity: "mobile_status", normalized: true, affectedPeriods };
}

async function upsertPerson(
  employeeId: number,
  displayName: string,
  roleType: string,
  active = true,
  authoritativeActive = false,
  query: PostgresQuery = queryPostgres,
) {
  const isPlaceholder = displayName.trim().toLowerCase() === `employee ${employeeId}`;
  await query(
    `insert into metrics.dim_people (simpro_employee_id, display_name, role_type, active, last_seen_at)
     values ($1, $2, $3, $4, now())
     on conflict (simpro_employee_id) do update set
       display_name = case
         when $5::boolean and metrics.dim_people.display_name !~* '^Employee [0-9]+$'
           then metrics.dim_people.display_name
         else excluded.display_name
       end,
       role_type = case
         when metrics.dim_people.role_type = 'unknown' then excluded.role_type
         else metrics.dim_people.role_type
       end,
       active = case when $6::boolean then excluded.active else metrics.dim_people.active end,
       last_seen_at = now()`,
    [employeeId, displayName, roleType, active, isPlaceholder, authoritativeActive],
  );
}

export async function quoteIdsAffectedByJobEvidence(
  params: {
    jobId: number;
    previousSourceQuoteId: number | null;
    nextSourceQuoteId: number | null;
  },
  query: PostgresQuery = queryPostgres,
): Promise<number[]> {
  const sourceQuoteIds = [params.previousSourceQuoteId, params.nextSourceQuoteId]
    .filter((value): value is number => value !== null);
  const result = await query<{ quote_id: string }>(
    `select q.quote_id::text
       from metrics.metrics_quotes q
       left join lateral (
         select raw.id, raw.payload
           from metrics.raw_simpro_snapshots raw
          where raw.entity_type in ('quote_details', 'quotes')
            and raw.entity_id = q.quote_id::text
            and raw.complete_traversal = true
            and raw.source_deleted_at is null
          order by raw.extracted_at desc, raw.id desc
          limit 1
       ) authoritative on true
      where q.source_deleted_at is null
        and (
          case when authoritative.id is null then null
               else metrics.authoritative_quote_linked_job_id(authoritative.payload)
           end = $1
          or q.quote_id = any($2::bigint[])
        )
      order by q.quote_id`,
    [params.jobId, sourceQuoteIds],
  );
  return result.rows.map((row) => Number(row.quote_id));
}

async function upsertJobCostCenters(
  jobId: number,
  costCenters: CostCenterRollup[],
  query: PostgresQuery = queryPostgres,
) {
  if (costCenters.length === 0) {
    return;
  }

  for (const costCenter of costCenters) {
    await query(
      `insert into metrics.metrics_job_cost_centers (
         job_id, section_id, cost_center_id, configured_cost_center_id,
         configured_cost_center_name, name, category, labor_quoted_hours,
         material_sell_value, material_cost_value, sell_value, cost_value,
         net_profit_actual, net_profit_estimate, net_margin_actual, net_margin_estimate,
         gross_profit_actual, gross_profit_estimate, gross_margin_actual, gross_margin_estimate,
         materials_cost_actual, materials_cost_estimate, labor_cost_actual, labor_cost_estimate,
         labor_hours_actual, labor_hours_estimate, overhead_cost_actual, overhead_cost_estimate,
         total_resource_cost_actual, total_resource_cost_estimate, commission_cost_actual,
         totals_authoritative, source_deleted_at, updated_from_source_at
       )
       values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
         $24, $25, $26, $27, $28, $29, $30, $31, true, null, now()
       )
       on conflict (job_id, section_id, cost_center_id) do update set
         configured_cost_center_id = excluded.configured_cost_center_id,
         configured_cost_center_name = excluded.configured_cost_center_name,
         name = excluded.name,
         category = excluded.category,
         labor_quoted_hours = excluded.labor_quoted_hours,
         material_sell_value = excluded.material_sell_value,
         material_cost_value = excluded.material_cost_value,
         sell_value = excluded.sell_value,
         cost_value = excluded.cost_value,
         net_profit_actual = excluded.net_profit_actual,
         net_profit_estimate = excluded.net_profit_estimate,
         net_margin_actual = excluded.net_margin_actual,
         net_margin_estimate = excluded.net_margin_estimate,
         gross_profit_actual = excluded.gross_profit_actual,
         gross_profit_estimate = excluded.gross_profit_estimate,
         gross_margin_actual = excluded.gross_margin_actual,
         gross_margin_estimate = excluded.gross_margin_estimate,
         materials_cost_actual = excluded.materials_cost_actual,
         materials_cost_estimate = excluded.materials_cost_estimate,
         labor_cost_actual = excluded.labor_cost_actual,
         labor_cost_estimate = excluded.labor_cost_estimate,
         labor_hours_actual = excluded.labor_hours_actual,
         labor_hours_estimate = excluded.labor_hours_estimate,
         overhead_cost_actual = excluded.overhead_cost_actual,
         overhead_cost_estimate = excluded.overhead_cost_estimate,
         total_resource_cost_actual = excluded.total_resource_cost_actual,
         total_resource_cost_estimate = excluded.total_resource_cost_estimate,
         commission_cost_actual = excluded.commission_cost_actual,
         totals_authoritative = true,
         source_deleted_at = null,
         updated_from_source_at = now()`,
      [
        jobId,
        costCenter.sectionId,
        costCenter.costCenterId,
        costCenter.configuredCostCenterId,
        costCenter.configuredCostCenterName,
        costCenter.name,
        costCenter.category,
        costCenter.laborHours,
        costCenter.materialSellValue,
        costCenter.materialCostValue,
        costCenter.sellValue,
        costCenter.costValue,
        costCenter.totals.nettProfitActual,
        costCenter.totals.nettProfitEstimate,
        costCenter.totals.nettMarginActual,
        costCenter.totals.nettMarginEstimate,
        costCenter.totals.grossProfitActual,
        costCenter.totals.grossProfitEstimate,
        costCenter.totals.grossMarginActual,
        costCenter.totals.grossMarginEstimate,
        costCenter.totals.materialsCostActual,
        costCenter.totals.materialsCostEstimate,
        costCenter.totals.laborCostActual,
        costCenter.totals.laborCostEstimate,
        costCenter.totals.laborHoursActual,
        costCenter.totals.laborHoursEstimate,
        costCenter.totals.overheadActual,
        costCenter.totals.overheadEstimate,
        costCenter.totals.resourceTotalActual,
        costCenter.totals.resourceTotalEstimate,
        costCenter.totals.commissionActual,
      ],
    );
  }

  await query(
    `update metrics.metrics_job_cost_centers
        set source_deleted_at = now(),
            updated_from_source_at = now()
      where job_id = $1
        and cost_center_id <> all($2::bigint[])
        and source_deleted_at is null`,
    [jobId, costCenters.map((costCenter) => costCenter.costCenterId)],
  );
}

export async function allocateJobGrossProfitToCostCenters(
  jobId: number,
  query: typeof queryPostgres = queryPostgres,
) {
  await query(
    `with basis as (
       select c.job_id, c.section_id, c.cost_center_id, c.sell_value,
              j.gross_profit_actual,
              sum(c.sell_value) filter (where c.sell_value is not null)
                over (partition by c.job_id) as total_sell,
              row_number() over (
                partition by c.job_id
                order by (c.sell_value is null), c.section_id, c.cost_center_id
              ) as allocation_row,
              count(*) filter (where c.sell_value is not null)
                over (partition by c.job_id) as allocation_rows
         from metrics.metrics_job_cost_centers c
         join metrics.metrics_jobs j on j.job_id = c.job_id
        where c.job_id = $1
          and c.source_deleted_at is null
          and not c.totals_authoritative
     ), preliminary as (
       select *,
              case
                when gross_profit_actual is null or sell_value is null then null
                when total_sell = 0 and allocation_rows = 1 then gross_profit_actual
                when total_sell = 0 then null
                else round(gross_profit_actual * sell_value / total_sell, 2)
              end as preliminary_profit
         from basis
     ), allocated as (
       select *,
              case
                when preliminary_profit is null then null
                when allocation_row = allocation_rows and total_sell <> 0
                  then gross_profit_actual - coalesce(
                    sum(preliminary_profit) over (
                      partition by job_id order by allocation_row
                      rows between unbounded preceding and 1 preceding
                    ), 0
                  )
                else preliminary_profit
              end as allocated_profit
         from preliminary
     )
     update metrics.metrics_job_cost_centers target
        set gross_profit_actual = allocated.allocated_profit,
            gross_margin_actual = case
              when allocated.sell_value is not null and allocated.sell_value <> 0
                and allocated.allocated_profit is not null
                then round(allocated.allocated_profit / allocated.sell_value * 100, 4)
              else null
            end,
            updated_from_source_at = now()
       from allocated
      where target.job_id = allocated.job_id
        and target.section_id = allocated.section_id
        and target.cost_center_id = allocated.cost_center_id`,
    [jobId],
  );
}

export function extractCostCenterRollups(payload: Record<string, unknown>): CostCenterRollup[] {
  const sections = Array.isArray(payload.Sections) ? payload.Sections : [];
  const rollups: CostCenterRollup[] = [];

  for (const section of sections) {
    const sectionRecord = objectValue(section);
    const sectionId = numericId(sectionRecord?.ID) ?? 0;
    const costCenters = Array.isArray(sectionRecord?.CostCenters) ? sectionRecord.CostCenters : [];
    for (const entry of costCenters) {
      const costCenter = objectValue(entry);
      if (!costCenter) {
        continue;
      }

      const id = numericId(costCenter.ID ?? costCenter.CostCenterID ?? pickId(costCenter.CostCenter));
      if (id === null) {
        continue;
      }

      const configuredCostCenter = costCenter.CostCenter;
      const configuredCostCenterId = numericId(pickId(configuredCostCenter));
      const configuredCostCenterName = namedValue(configuredCostCenter);
      const name = stringValue(costCenter.Name);
      const items = objectValue(costCenter.Items);
      const totals = extractJobFinancialTotals(costCenter);
      const itemLaborHours = sumNullable(itemArray(items?.Labors).map((item) => quantityValue(item.Total)));
      const laborHours = objectValue(costCenter.Totals) ? totals.laborHoursEstimate : itemLaborHours;
      const materialItems = [
        ...itemArray(items?.Catalogs),
        ...itemArray(items?.OneOffs),
        ...itemArray(items?.Prebuilds),
        ...itemArray(items?.Stock),
        ...itemArray(items?.ServiceFees),
      ];
      const materialSellValue = sumNullable(materialItems.map((item) => moneyValueOrNull(nestedValue(item.Total, ["Amount"]) ?? item.Total)));
      const costValue = sumNullable([totals.materialsCostActual, totals.resourceTotalActual]);

      rollups.push({
        sectionId,
        costCenterId: id,
        configuredCostCenterId,
        configuredCostCenterName,
        name,
        category: categoryForVerifiedConfiguredCostCenterId(configuredCostCenterId) ?? "Unclassified",
        laborHours,
        sellValue: moneyValueOrNull(costCenter.Total),
        costValue,
        materialSellValue,
        materialCostValue: totals.materialsCostActual,
        totals,
      });
    }
  }

  return rollups;
}

export function extractJobFinancialTotals(payload: Record<string, unknown>) {
  const totals = payload.Totals;
  const resources = pathValue(totals, ["ResourcesCost"]);
  return {
    nettProfitActual: moneyValueOrNull(pathValue(totals, ["NettProfitLoss", "Actual"])),
    nettProfitEstimate: moneyValueOrNull(pathValue(totals, ["NettProfitLoss", "Estimate"])),
    nettMarginActual: percentValue(pathValue(totals, ["NettMargin", "Actual"])),
    nettMarginEstimate: percentValue(pathValue(totals, ["NettMargin", "Estimate"])),
    grossProfitActual: moneyValueOrNull(pathValue(totals, ["GrossProfitLoss", "Actual"])),
    grossProfitEstimate: moneyValueOrNull(
      pathValue(totals, ["GrossProfitLoss", "Estimate"]) ??
        pathValue(totals, ["GrossProfit", "Estimate"]),
    ),
    grossMarginActual: percentValue(pathValue(totals, ["GrossMargin", "Actual"])),
    grossMarginEstimate: percentValue(
      pathValue(totals, ["GrossMargin", "Estimate"]) ??
        pathValue(totals, ["Margin", "Estimate"]),
    ),
    materialsCostActual: moneyValueOrNull(pathValue(totals, ["MaterialsCost", "Actual"])),
    materialsCostEstimate: moneyValueOrNull(pathValue(totals, ["MaterialsCost", "Estimate"])),
    laborCostActual: moneyValueOrNull(pathValue(resources, ["Labor", "Actual"])),
    laborCostEstimate: moneyValueOrNull(pathValue(resources, ["Labor", "Estimate"])),
    laborHoursActual: moneyValueOrNull(pathValue(resources, ["LaborHours", "Actual"])),
    laborHoursEstimate: moneyValueOrNull(pathValue(resources, ["LaborHours", "Estimate"])),
    overheadActual: moneyValueOrNull(pathValue(resources, ["Overhead", "Actual"])),
    overheadEstimate: moneyValueOrNull(pathValue(resources, ["Overhead", "Estimate"])),
    resourceTotalActual: moneyValueOrNull(pathValue(resources, ["Total", "Actual"])),
    resourceTotalEstimate: moneyValueOrNull(pathValue(resources, ["Total", "Estimate"])),
    commissionActual: moneyValueOrNull(pathValue(resources, ["Commission", "Actual"])),
  };
}

export function extractQuoteStageNames(payload: Record<string, unknown>) {
  return {
    stageName: namedValue(payload.Stage ?? payload.stage),
    customerStageName: namedValue(payload.CustomerStage ?? payload.customerStage ?? payload.customer_stage),
  };
}

export function extractQuoteLinkedJobId(payload: Record<string, unknown>): number | null {
  return resolveQuoteDirectLinkedJobId(payload);
}

export function extractJobStageName(payload: Record<string, unknown>): string | null {
  return namedValue(payload.Stage ?? payload.stage);
}

export function extractJobSourceQuoteId(payload: Record<string, unknown>): number | null {
  const source = extractJobSource(payload);
  return source.type === "Quote" ? source.id : null;
}

export function extractJobConvertedFromAt(payload: Record<string, unknown>): string | null {
  return extractJobSource(payload).convertedAt;
}

export function extractJobSource(payload: Record<string, unknown>): JobSource {
  const convertedFrom = resolveJobConvertedFrom(payload);
  const recurring = convertedFrom.type?.trim().toLowerCase().startsWith("recurring") === true;
  if (convertedFrom.type === "Quote" || recurring) {
    return {
      type: convertedFrom.type === "Quote" ? "Quote" : "Recurring",
      id: convertedFrom.id,
      convertedAt: convertedFrom.convertedAt ? timestampValue(convertedFrom.convertedAt) : null,
    };
  }

  return { type: "Direct service", id: null, convertedAt: null };
}

export function jobCategoryFromCostCenters(costCenters: CostCenterRollup[]) {
  const values = new Map<string, number>();
  for (const costCenter of costCenters) {
    const category = categoryForVerifiedConfiguredCostCenterId(costCenter.configuredCostCenterId);
    values.set(category, (values.get(category) ?? 0) + (costCenter.sellValue ?? 0));
  }
  return [...values.entries()]
    .sort(([leftCategory, leftValue], [rightCategory, rightValue]) => (
      rightValue - leftValue || leftCategory.localeCompare(rightCategory)
    ))[0]?.[0] ?? "Unclassified";
}

function itemArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.reduce<Array<Record<string, unknown>>>((items, item) => {
    const record = objectValue(item);
    if (record) {
      items.push(record);
    }
    return items;
  }, []);
}

function quantityValue(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return moneyValueOrNull(record.Qty ?? record.Quantity);
}

function sumNullable(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return valid.length > 0 ? valid.reduce((sum, value) => sum + value, 0) : null;
}

const DEFAULT_WEEKDAY_CAPACITY = {
  start: "08:30",
  end: "17:00",
  lunchMinutes: 30,
  workingHours: 8,
} as const;

export function normalizeEmployeeAvailability(value: unknown): Record<string, unknown> {
  if (value !== null && value !== undefined) {
    return { source: "simpro_availability", availability: value };
  }
  return { ...DEFAULT_EMPLOYEE_AVAILABILITY };
}

export function normalizeEmployeeCapacity(value: unknown): EmployeeCapacity {
  const availability = Array.isArray(value)
    ? value.filter((entry) => entry !== null && entry !== undefined)
    : typeof value === "string" && value.trim()
      ? value.trim()
      : objectValue(value);
  const hasExplicitAvailability = Array.isArray(availability)
    ? availability.length > 0
    : availability !== null && (typeof availability !== "object" || Object.keys(availability).length > 0);

  if (hasExplicitAvailability) {
    const entries = Array.isArray(availability) ? availability : [availability];
    const parsedHours = entries.flatMap((entry) => availabilityHours(String(entry)));
    const weeklyCapacityHours = parsedHours.length > 0
      ? parsedHours.reduce((sum, hours) => sum + hours, 0)
      : null;
    return {
      availability,
      capacitySource: "simpro_availability",
      weekdayCapacityHours: parsedHours.length === 5 && parsedHours.every((hours) => hours === parsedHours[0])
        ? parsedHours[0]
        : null,
      weeklyCapacityHours,
      schedule: { sourceAvailability: entries },
    };
  }

  return {
    availability: null,
    capacitySource: "default_business_hours",
    weekdayCapacityHours: DEFAULT_WEEKDAY_CAPACITY.workingHours,
    weeklyCapacityHours: DEFAULT_WEEKDAY_CAPACITY.workingHours * 5,
    schedule: {
      timezone: "America/Los_Angeles",
      weekdays: Object.fromEntries(
        ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day) => [day, DEFAULT_WEEKDAY_CAPACITY]),
      ),
    },
  };
}

function availabilityHours(value: string): number[] {
  const times = [...value.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].map((match) =>
    Number(match[1]) * 60 + Number(match[2]),
  );
  if (times.length < 2 || times[1] < times[0]) return [];
  const hours = (times[1] - times[0]) / 60;
  const normalized = value.toLowerCase();
  if (/weekdays?|monday\s*(?:-|to)\s*friday/.test(normalized)) return Array(5).fill(hours);
  return [hours];
}

export function projectTotalExTax(
  payload: Record<string, unknown>,
  projectType: "quote" | "job",
  projectId: number,
): number {
  const total = objectValue(payload.Total);
  const value = total && Object.prototype.hasOwnProperty.call(total, "ExTax")
    ? strictMoneyScalar(total.ExTax)
    : null;
  if (value === null) {
    throw new Error(`Invalid ${projectType} ${projectId} Total.ExTax: a finite explicit ExTax value is required.`);
  }
  return value;
}

function moneyValue(value: unknown) {
  return moneyValueOrNull(value) ?? 0;
}

function strictMoneyScalar(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^(?:[+-]?\$?|\$[+-]?)(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function moneyValueOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["ExTax", "IncTax", "Total", "SellPrice", "Sell", "Value", "Amount"]) {
      const nested = moneyValueOrNull(record[key]);
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
}

function percentValue(value: unknown): number | null {
  return moneyValueOrNull(value);
}

function dateValue(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function timestampValue(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function dateTimeValue(date: string | null, time: unknown): string | null {
  const cleanTime = timeOnly(time);
  if (!date || !cleanTime) {
    return null;
  }
  return `${date}T${cleanTime}:00`;
}

function timeOnly(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) {
    return null;
  }
  const hour = Math.min(23, Number(match[1]));
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function namedValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return pickName(value);
}

function customerDisplayName(value: unknown): string | null {
  const record = objectValue(value);
  if (!record) return pickName(value);
  const company = trimmedStringValue(record.CompanyName ?? record.companyName);
  const personal = [record.GivenName ?? record.givenName, record.FamilyName ?? record.familyName]
    .flatMap((part) => {
      const text = trimmedStringValue(part);
      return text ? [text] : [];
    })
    .join(" ");
  return company ?? (personal || null) ?? pickName(value);
}

function trimmedStringValue(value: unknown): string | null {
  const text = stringValue(value)?.trim();
  return text ? text : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

function numericId(value: unknown): number | null {
  const id = typeof value === "string" ? value.trim() : value;
  const number = Number(id);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function booleanValue(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }
  return fallback;
}

function monthStart(date: string) {
  return `${date.slice(0, 7)}-01`;
}

function pacificToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/**
 * Bounded invalidation window for employee roster-attribute changes: the
 * current business month plus the prior month. Employee evidence carries no
 * transition date, so this mirrors the bounded-recompute pattern used by the
 * other entity normalizers rather than fanning out over all history.
 */
export function employeeRosterPeriodStarts(referenceDate: string): string[] {
  const current = monthStart(referenceDate);
  const year = Number(current.slice(0, 4));
  const month = Number(current.slice(5, 7));
  const previous = month === 1
    ? `${year - 1}-12-01`
    : `${year}-${String(month - 1).padStart(2, "0")}-01`;
  return [previous, current];
}

function stableJsonText(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJsonValue(entry)]),
    );
  }
  return value;
}

export function quoteTransitionPeriodStarts(previousDate: string | null, nextDate: string | null) {
  return [...new Set([previousDate, nextDate].filter((date): date is string => Boolean(date)).map(monthStart))];
}

export function jobTransitionPeriodStarts(
  previous: { completedDate: string | null; stageName: string | null },
  next: { completedDate: string | null; stageName: string | null },
) {
  const dates = [
    previous.completedDate && isCompletedJobStage(previous.stageName) ? previous.completedDate : null,
    next.completedDate && isCompletedJobStage(next.stageName) ? next.completedDate : null,
  ];
  return [...new Set(dates.filter((date): date is string => Boolean(date)).map(monthStart))];
}

async function affectedPeriodsForReferencedJob(
  referenceInfo: { type: string | null; id: number | null },
  query: PostgresQuery,
) {
  if (referenceInfo.type !== "job" || referenceInfo.id === null) {
    return [];
  }

  const result = await query<{ completed_date: string | null; stage: string | null }>(
    `select completed_date::text, stage
       from metrics.metrics_jobs
      where job_id = $1
        and source_deleted_at is null
      limit 1`,
    [referenceInfo.id],
  );
  const job = result.rows[0];
  if (!job?.completed_date || !isCompletedJobStage(job.stage)) {
    return [];
  }

  const periodStart = monthStart(job.completed_date);
  return [
    { scope: "jobs" as const, periodStart },
    { scope: "technicians" as const, periodStart },
    { scope: "commissions" as const, periodStart },
  ];
}

function nestedValue(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return null;
}

const SCHEDULE_ADVISORY_LOCK_NAMESPACE = 717_000_000_000_000;

export type ScheduleTechnicianPeriod = {
  scope: "technicians";
  periodStart: string;
};

export type SchedulePublicationAuthority = {
  applied: boolean;
  scheduleId: number;
  referenceType: string | null;
  referenceId: number | null;
  affectedPeriods: ScheduleTechnicianPeriod[];
};

export async function acquireScheduleAdvisoryLock(
  query: PostgresQuery,
  scheduleId: number,
): Promise<void> {
  await query(
    "select pg_advisory_xact_lock($1::bigint + $2::bigint)",
    [SCHEDULE_ADVISORY_LOCK_NAMESPACE, scheduleId],
  );
}

export async function acquireSchedulePublicationAuthority(params: {
  entityId: string;
  payload: Record<string, unknown>;
  fetchedAt: string;
  query: PostgresQuery;
}): Promise<SchedulePublicationAuthority> {
  const scheduleId = numericId(pickId(params.payload) ?? params.entityId);
  if (scheduleId === null) {
    return { applied: false, scheduleId: 0, referenceType: null, referenceId: null, affectedPeriods: [] };
  }
  const referenceInfo = scheduleReference(params.payload);
  await acquireScheduleAdvisoryLock(params.query, scheduleId);
  const current = await lockCurrentSchedule(scheduleId, params.query);
  const sameReference = current
    ? current.reference_type?.toLowerCase() === referenceInfo.type
      && numericId(current.reference_id) === referenceInfo.id
    : false;
  const applied = schedulePublicationIsCurrent(
    current,
    sameReference,
    timestampValue(params.payload.DateModified),
    params.fetchedAt,
  );
  return {
    applied,
    scheduleId,
    referenceType: referenceInfo.type,
    referenceId: referenceInfo.id,
    affectedPeriods: applied ? await activeScheduleTechnicianPeriods(scheduleId, params.query) : [],
  };
}

export async function acquireMissingScheduleAuthority(params: {
  scheduleId: number;
  observedAt: string;
  query: PostgresQuery;
}): Promise<SchedulePublicationAuthority> {
  await acquireScheduleAdvisoryLock(params.query, params.scheduleId);
  const current = await lockCurrentSchedule(params.scheduleId, params.query);
  const incomingObservation = timestampMillis(params.observedAt);
  const currentObservation = timestampMillis(current?.fetched_at ?? null);
  const applied = incomingObservation !== null
    && (currentObservation === null || incomingObservation >= currentObservation);
  return {
    applied,
    scheduleId: params.scheduleId,
    referenceType: current?.reference_type?.toLowerCase() ?? null,
    referenceId: numericId(current?.reference_id),
    affectedPeriods: applied
      ? await activeScheduleTechnicianPeriods(params.scheduleId, params.query)
      : [],
  };
}

export async function activeScheduleTechnicianPeriods(
  scheduleId: number,
  query: PostgresQuery,
): Promise<ScheduleTechnicianPeriod[]> {
  const result = await query<{ period_start: string }>(
    `select distinct period_start::text
       from (
         select date_trunc('month', schedule_date)::date as period_start
           from metrics.metrics_schedules
          where schedule_id = $1
            and lower(reference_type) = 'job'
            and source_deleted_at is null
            and schedule_date is not null
         union
         select date_trunc('month', planned_start_at at time zone 'America/Los_Angeles')::date
           from metrics.metrics_schedule_blocks
          where schedule_id = $1
            and lower(reference_type) = 'job'
            and source_deleted_at is null
            and planned_start_at is not null
       ) periods
      order by period_start`,
    [scheduleId],
  );
  return result.rows.map((row) => ({ scope: "technicians", periodStart: row.period_start }));
}

async function lockCurrentSchedule(scheduleId: number, query: PostgresQuery) {
  const result = await query<{
    reference_type: string | null;
    reference_id: string | null;
    source_modified_at: string | Date | null;
    fetched_at: string | Date | null;
  }>(
    `select reference_type, reference_id::text, source_modified_at, fetched_at
       from metrics.metrics_schedules
      where schedule_id = $1
      for update`,
    [scheduleId],
  );
  return result.rows[0];
}

function scheduleReference(payload: Record<string, unknown>) {
  const project = objectValue(payload.Project);
  return parseReference(
    payload.Type,
    stringValue(payload.Reference) ?? stringValue(project?.ProjectID),
    stringValue(project?.ProjectID ?? payload.Project),
  );
}

function schedulePublicationIsCurrent(
  existing: { source_modified_at: string | Date | null; fetched_at: string | Date | null } | undefined,
  sameReference: boolean,
  incomingSourceModifiedAt: string | null,
  incomingFetchedAt: string | null,
): boolean {
  if (!existing) return true;
  const existingSourceModifiedAt = timestampMillis(existing.source_modified_at);
  const incomingSourceMillis = timestampMillis(incomingSourceModifiedAt);
  if (existingSourceModifiedAt !== null && incomingSourceMillis !== null) {
    if (!sameReference) return incomingSourceMillis > existingSourceModifiedAt;
    if (incomingSourceMillis !== existingSourceModifiedAt) {
      return incomingSourceMillis > existingSourceModifiedAt;
    }
    const existingFetchedAt = timestampMillis(existing.fetched_at);
    const incomingFetchedMillis = timestampMillis(incomingFetchedAt);
    return incomingFetchedMillis !== null
      && (existingFetchedAt === null || incomingFetchedMillis >= existingFetchedAt);
  }
  if (!sameReference) return existingSourceModifiedAt === null && incomingSourceMillis !== null;
  const existingFetchedAt = timestampMillis(existing.fetched_at);
  const incomingFetchedMillis = timestampMillis(incomingFetchedAt);
  return existingFetchedAt !== null
    && incomingFetchedMillis !== null
    && incomingFetchedMillis >= existingFetchedAt;
}

function timestampMillis(value: string | Date | null): number | null {
  if (value === null) return null;
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(millis) ? null : millis;
}

function pathValue(value: unknown, keys: string[]) {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current ?? null;
}

function scheduleTraversalWriteCtes(
  referenceType: string | null,
  projectIdPlaceholder: string,
  generationPlaceholder: string,
  quoteLockPlaceholder: string | null,
  guarded: boolean,
) {
  if (!guarded || (referenceType !== "quote" && referenceType !== "job")) {
    if (referenceType === "quote") {
      if (!quoteLockPlaceholder) throw new Error("Quote schedule writes require the category lock placeholder.");
      return `with category_serialization as materialized (
                select pg_advisory_xact_lock(${quoteLockPlaceholder}::bigint)
              ), current_traversal as materialized (
                select null::bigint as generation from category_serialization
              )`;
    }
    return `with current_traversal as materialized (select null::bigint as generation)`;
  }

  if (referenceType === "quote") {
    if (!quoteLockPlaceholder) throw new Error("Quote schedule writes require the category lock placeholder.");
    return `with category_serialization as materialized (
              select pg_advisory_xact_lock(${quoteLockPlaceholder}::bigint)
            ), current_traversal as materialized (
              select traversal.generation
                from category_serialization
                cross join metrics.project_nested_traversals traversal
               where traversal.project_type = 'quote'
                 and traversal.project_id = ${projectIdPlaceholder}
                 and traversal.generation = ${generationPlaceholder}::bigint
                 and traversal.status = 'active'
               for update of traversal
            )`;
  }

  return `with current_traversal as materialized (
            select traversal.generation
              from metrics.project_nested_traversals traversal
             where traversal.project_type = 'job'
               and traversal.project_id = ${projectIdPlaceholder}
               and traversal.generation = ${generationPlaceholder}::bigint
               and traversal.status = 'active'
             for update of traversal
          )`;
}

function parseReference(typeValue: unknown, reference: string | null, href?: string | null): { type: string | null; id: number | null } {
  const typeText = stringValue(typeValue)?.toLowerCase() ?? "";
  const path = href ?? "";
  const jobFromPath = path.match(/\/jobs\/(\d+)/i)?.[1];
  const quoteFromPath = path.match(/\/quotes\/(\d+)/i)?.[1];
  const leadFromPath = path.match(/\/leads\/(\d+)/i)?.[1];

  if (jobFromPath) {
    return { type: "job", id: numericId(jobFromPath) };
  }
  if (quoteFromPath) {
    return { type: "quote", id: numericId(quoteFromPath) };
  }
  if (leadFromPath) {
    return { type: "lead", id: numericId(leadFromPath) };
  }

  const firstReferenceId = numericId(reference?.split("-")[0]);
  if (typeText.includes("job")) {
    return { type: "job", id: firstReferenceId };
  }
  if (typeText.includes("quote")) {
    return { type: "quote", id: firstReferenceId };
  }
  if (typeText.includes("lead")) {
    return { type: "lead", id: firstReferenceId };
  }
  if (typeText.includes("activity")) {
    return { type: "activity", id: firstReferenceId };
  }

  return { type: firstReferenceId === null ? null : "unknown", id: firstReferenceId };
}

function firstBlockValue(blocks: unknown[], key: string): unknown {
  const first = objectValue(blocks[0]);
  return first?.[key] ?? first?.[key.charAt(0).toLowerCase() + key.slice(1)];
}

function assertNever(value: never): never {
  throw new Error(`Unhandled normalization entity: ${value}`);
}

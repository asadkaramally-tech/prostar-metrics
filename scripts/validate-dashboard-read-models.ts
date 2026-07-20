import { pathToFileURL } from "node:url";
import pg from "pg";
import type { QuoteAcceptancePath } from "@/lib/metrics/quotes";
import { buildTechnicianPerformanceReadModel, calculateTechnicianCapacity } from "@/lib/metrics/technicians";
import { buildPostgresSslConfig } from "@/lib/store/postgres";
import { readModelSourceHash } from "@/lib/store/read-model-rebuilds";
import {
  resolveJobConvertedFromQuoteId,
  resolveQuoteDirectLinkedJobId,
} from "@/lib/simpro/relationship-provenance";
import { parseTechnicianAvailability } from "@/lib/store/technician-read-model-inputs";
import { forbiddenInvoiceArDimensionPaths } from "./lib/api-dimension-policy.mjs";

export { forbiddenInvoiceArDimensionPaths };

export type ReadModelRow = {
  metric_family: "quotes" | "jobs" | "technicians" | "commissions";
  period_start: string;
  dimensions_json: Record<string, unknown>;
  values_json: Record<string, unknown>;
  status: string;
  source_hash: string | null;
  rebuilt_at: string;
};

export type ValidationMismatch = Record<string, unknown>;

export type QuoteSourceAggregate = {
  period_start: string;
  source_records: number;
  quote_count: number;
  quote_value: string | number;
  accepted_count: number;
  accepted_value: string | number;
  not_accepted_count: number;
  not_accepted_value: string | number;
  excluded_count: number;
  acceptance_rate_by_count: number;
  acceptance_rate_by_value: number;
  average_accepted_deal: number;
  override_count: number;
  excluded_without_date_approved: number;
  tiers: Record<QuoteTier, QuoteTierAggregate>;
  acceptance_paths: Record<QuoteAcceptancePath, number>;
  acceptance_path_values: Record<QuoteAcceptancePath, number>;
  quotes: QuoteSourceClassification[];
};

export const QUOTE_TIERS = ["Under $750", "$750-$2K", "$2K-$10K", "$10K+"] as const;
type QuoteTier = (typeof QUOTE_TIERS)[number];
type QuoteTierAggregate = {
  quoteCount: number;
  quoteValue: number;
  acceptedCount: number;
  acceptedValue: number;
  notAcceptedCount: number;
  notAcceptedValue: number;
};
export type QuoteSourceClassification = {
  quoteId: string;
  totalValue: number;
  outcome: "accepted" | "not_accepted" | "excluded";
  path: QuoteAcceptancePath;
  tier: QuoteTier;
};

export type QuoteSourceRow = {
  quote_id: string;
  date_approved: string | null;
  total: string | number;
  status_name: string | null;
  direct_source_snapshot_id: string | null;
  direct_payload?: unknown;
  direct_linked_job_id: string | null;
  direct_linked_job_id_alias: string | null;
  direct_linked_job_id_snake: string | null;
  direct_conversion_job_id: string | null;
  inverse_conversion_job_id: string | null;
  canonical_linked_job_id?: string | null;
  snapshot_linked_job_id?: string | null;
  expected_inverse_job_ids?: string[];
  canonical_inverse_job_ids?: string[];
  snapshot_inverse_job_ids?: string[];
  relationship_provenance_error?: string | null;
  override_outcome: string | null;
  won_override: boolean | null;
};

export type TechnicianUtilizationSourceRow = {
  period_start: string;
  employee_id: string;
  person_mapped: boolean;
  roster_member: boolean;
  productive_supported_job_hours: string | number;
  all_positive_recorded_hours: string | number;
};

export type CostCenterCategorySourceRow = {
  project_type: "job" | "quote";
  project_id: string;
  cost_center_id: string | null;
  configured_cost_center_id: string | number | null;
  category: string | null;
  sell_value: string | number | null;
  parent_category: string | null;
};

export type InvoiceRuntimeEvidence = {
  active_ingestion_jobs: string | number;
  active_ingestion_runs: string | number;
  active_backfill_units: string | number;
};

export type AppRoleSourceRow = {
  email: string;
  role: string;
};

export const REQUIRED_SEMANTIC_CONTRACT_CHECKS = [
  "technicianUtilization",
  "costCenterCategories",
  "invoiceRuntime",
  "apiDimensions",
  "productionOwners",
  "quoteConversionEvidence",
] as const;

const PRODUCTION_OWNER_EMAILS = [
  "asad@prostarmechanical.com",
  "laila@prostarmechanical.com",
] as const;

const PRODUCTION_ACCESS_ROLES = new Set(["admin", "finance"]);

export type JobSourceAggregate = {
  period_start: string;
  completed_jobs: number;
  total_sell_value: string | number;
  gross_profit_actual: string | number;
  gross_margin_included_jobs: number;
  gross_margin_covered_sell_value: string | number;
  gross_margin_covered_profit: string | number;
  net_profit_actual: string | number;
  net_margin_included_jobs: number;
  net_margin_covered_sell_value: string | number;
  net_margin_covered_profit: string | number;
  materials_actual: string | number;
  labor_actual: string | number;
  overhead_actual: string | number;
  commission_actual: string | number;
  materials_paired_actual: string | number;
  materials_paired_estimate: string | number;
  materials_paired_jobs: number;
  labor_paired_actual: string | number;
  labor_paired_estimate: string | number;
  labor_paired_jobs: number;
  overhead_paired_actual: string | number;
  overhead_paired_estimate: string | number;
  overhead_paired_jobs: number;
  total_paired_actual: string | number;
  total_paired_estimate: string | number;
  total_paired_jobs: number;
  sell_value_supported: number;
  gross_profit_supported: number;
  net_profit_supported: number;
  cost_totals_supported: number;
  field_support: Record<string, number>;
};

export type LaborEfficiencySourceAggregate = {
  period_start: string;
  total_jobs: number;
  jobs_with_timesheets: number;
  quote_generated_jobs: number;
  recurring_jobs: number;
  quote_generated_jobs_with_labor: number;
  recurring_jobs_with_labor: number;
  missing_labor_jobs: number;
  included_jobs: number;
  individual_jobs: number;
  crew_jobs: number;
  quote_quoted_hours: string | number;
  quote_actual_hours: string | number;
  quote_jobs: number;
  recurring_quoted_hours: string | number;
  recurring_actual_hours: string | number;
  recurring_included_jobs: number;
};

export type LaborEfficiencySourceRow = {
  period_start: string;
  job_source_type: string | null;
  job_source_id: string | null;
  quote_id: string | null;
  labor_hours_estimate: string | number | null;
  quote_quoted_hours: string | number | null;
  quote_labor_rows: number;
  technicians: number;
  actual_hours: string | number;
};

export type CapacitySourceRow = {
  period_start: string;
  period_end: string;
  employee_id: string;
  display_name: string | null;
  date_of_hire: string | null;
  archived: boolean | null;
  availability_json: unknown;
  holiday_hours: string | number;
  sick_personal_hours: string | number;
  pto_hours: string | number;
};

type CapacityCoverageAggregate = {
  period_start: string;
  holiday_hours: string | number;
  sick_personal_hours: string | number;
  pto_hours: string | number;
};

type CommissionRun = {
  run_id: string;
  completed_jobs: number;
  total_work_value: string;
  pool_amount: string;
  inside_pool_total: string;
  outside_pool_total: string;
  payroll_total: string;
  source_complete: boolean;
  source_status: string | null;
  invariants_json: Record<string, unknown>;
  inputs: CommissionInputRow[];
  employee_results: CommissionEmployeeResult[];
  job_allocations: CommissionJobAllocation[];
};

export type CommissionInputRow = {
  input_type: string;
  source_identity: string;
  input_json: Record<string, unknown>;
};

export type CommissionEmployeeResult = {
  employee_id: string;
  forfeited_bonus: string | number;
  reallocation_received: string | number;
  efficiency_json: Record<string, unknown> | null;
  outside_pool_adjustment: string | number;
  final_bonus: string | number;
  payroll_bonus: string | number;
};

export type CommissionJobAllocation = {
  job_id: string;
  employee_id: string;
  job_total: string | number;
  allocated_value: string | number;
};

export const COMMISSION_INVARIANTS = [
  "insidePoolReconciles",
  "outsidePoolReconciles",
  "jobAllocationsReconcile",
  "unsupportedJobsUnallocated",
  "forfeitureReconciles",
  "efficiencyReconciles",
  "nonnegativePayroll",
] as const;

const JOB_COST_FIELDS = [
  "netProfitActual", "netMarginActual",
  "materialsCostActual",
  "materialsCostEstimate",
  "laborCostActual",
  "laborCostEstimate",
  "laborHoursActual",
  "laborHoursEstimate",
  "overheadCostActual",
  "overheadCostEstimate",
  "totalResourceCostActual",
  "totalResourceCostEstimate",
  "commissionCostActual",
] as const;

const JOB_SOURCE_COLUMNS: Record<(typeof JOB_COST_FIELDS)[number], string> = {
  netProfitActual: "net_profit_actual",
  netMarginActual: "net_margin_actual",
  materialsCostActual: "materials_cost_actual",
  materialsCostEstimate: "materials_cost_estimate",
  laborCostActual: "labor_cost_actual",
  laborCostEstimate: "labor_cost_estimate",
  laborHoursActual: "labor_hours_actual",
  laborHoursEstimate: "labor_hours_estimate",
  overheadCostActual: "overhead_cost_actual",
  overheadCostEstimate: "overhead_cost_estimate",
  totalResourceCostActual: "total_resource_cost_actual",
  totalResourceCostEstimate: "total_resource_cost_estimate",
  commissionCostActual: "commission_cost_actual",
};

const technicianLaborSourceCache = new Map<string, "quote_generated" | "recurring" | "other">();

async function main() {
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString) throw new Error("AZURE_POSTGRES_CONNECTION_STRING is required");
  const client = new pg.Client({ connectionString, ssl: buildPostgresSslConfig() });
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    transactionOpen = true;
    const models = await client.query<ReadModelRow>(
      `select metric_family, period_start::text, dimensions_json, values_json, status, source_hash, rebuilt_at::text
         from metrics.dashboard_read_models
        where metric_family in ('quotes', 'jobs', 'technicians', 'commissions')
          and period_grain = 'month'
          and period_start >= date '2023-01-01'
          and superseded_at is null
        order by metric_family, period_start`,
    );
    const currentMonth = currentPacificMonth();
    const expectedMonths = monthStarts("2023-01-01", currentMonth);
    const [
      jobs,
      quoteSourceRows,
      laborEfficiency,
      capacityRows,
      capacityCoverage,
      utilizationRows,
      commissionRuns,
      categoryRows,
      invoiceRuntime,
      appRoles,
    ] = await Promise.all([
      readJobAggregates(client),
      readQuoteSourceRows(client),
      readLaborEfficiencyAggregates(client),
      readCapacityRows(client),
      readCapacityCoverage(client),
      readTechnicianUtilizationRows(client),
      readCommissionRuns(client),
      readCostCenterCategoryRows(client),
      readInvoiceRuntimeEvidence(client),
      readAppRoles(client),
    ]);
    const quotes = aggregateQuoteSources(quoteSourceRows, expectedMonths);
    const mismatches: ValidationMismatch[] = [];
    const technicianUtilizationMismatches: ValidationMismatch[] = [];
    const costCenterCategoryMismatches: ValidationMismatch[] = [];
    const invoiceRuntimeMismatches: ValidationMismatch[] = [];
    const apiDimensionMismatches: ValidationMismatch[] = [];
    const productionOwnerMismatches: ValidationMismatch[] = [];
    const quoteConversionMismatches: ValidationMismatch[] = [];
    const byFamily = new Map<string, ReadModelRow[]>();
    for (const row of models.rows) byFamily.set(row.metric_family, [...(byFamily.get(row.metric_family) ?? []), row]);

    for (const family of ["quotes", "jobs", "technicians", "commissions"] as const) {
      const rows = byFamily.get(family) ?? [];
      const actualMonths = rows.map((row) => row.period_start);
      if (JSON.stringify(actualMonths) !== JSON.stringify(expectedMonths)) {
        mismatches.push({ family, type: "month_inventory", expectedMonths, actualMonths });
      }
      for (const row of rows) {
        if (row.status !== "ready" || !row.source_hash) {
          mismatches.push({ family, periodStart: row.period_start, type: "publication_state", status: row.status, sourceHash: row.source_hash });
        }
        validatePayloadSourceHash(row, mismatches);
        if (family === "jobs") validateJobs(row, jobs.get(row.period_start), mismatches);
        if (family === "quotes") validateQuotes(row, quotes.get(row.period_start), mismatches);
        if (family === "technicians") {
          validateTechnicians(
            row,
            laborEfficiency.get(row.period_start),
            capacityRows.get(row.period_start) ?? [],
            capacityCoverage.get(row.period_start),
            mismatches,
          );
          validateTechnicianUtilization(
            row,
            utilizationRows.get(row.period_start) ?? [],
            technicianUtilizationMismatches,
          );
        }
        if (family === "commissions") validateCommissions(row, commissionRuns.get(row.period_start), mismatches);
      }
    }

    validateCostCenterCategories(categoryRows, costCenterCategoryMismatches);
    validateInvoiceRuntime(invoiceRuntime, invoiceRuntimeMismatches);
    validateNoInvoiceArApiDimensions(models.rows, apiDimensionMismatches);
    validateProductionOwnerAuthorization(process.env, appRoles, productionOwnerMismatches);
    validateQuoteConversionEvidence(quoteSourceRows, quoteConversionMismatches);
    mismatches.push(
      ...technicianUtilizationMismatches,
      ...costCenterCategoryMismatches,
      ...invoiceRuntimeMismatches,
      ...apiDimensionMismatches,
      ...productionOwnerMismatches,
      ...quoteConversionMismatches,
    );

    const contractChecks = {
      technicianUtilization: contractCheck(technicianUtilizationMismatches, {
        sourceMonths: utilizationRows.size,
      }),
      costCenterCategories: contractCheck(costCenterCategoryMismatches, {
        sourceRows: categoryRows.length,
      }),
      invoiceRuntime: contractCheck(invoiceRuntimeMismatches, invoiceRuntime),
      apiDimensions: contractCheck(apiDimensionMismatches, {
        readModels: models.rows.length,
      }),
      productionOwners: contractCheck(productionOwnerMismatches, {
        environmentOwners: productionEnvironmentOwnerEmails(process.env),
        appRoleOwners: uniqueSorted(appRoles.map((row) => normalizeEmail(row.email))),
      }),
      quoteConversionEvidence: contractCheck(quoteConversionMismatches, {
        sourceRows: quoteSourceRows.length,
      }),
    };

    const currentTechnicianRow = (byFamily.get("technicians") ?? []).at(-1);
    const currentTechnicians = currentTechnicianRow?.values_json;
    const currentCoverage = record(currentTechnicians?.coverage);
    const currentCapacity = currentTechnicianRow
      ? summarizeCapacities(expectedCapacities(currentTechnicianRow, capacityRows.get(currentTechnicianRow.period_start) ?? []))
      : null;
    const currentMobileEvidence = await readCurrentMobileEvidence(client, currentMonth);
    if (currentMobileEvidence.semanticsVerified && currentMobileEvidence.arrivalCandidates > 0 && numeric(currentCoverage?.arrivalCoveredVisits) === 0) {
      mismatches.push({ family: "technicians", periodStart: currentMonth, type: "verified_mobile_arrivals_not_applied", currentMobileEvidence });
    }
    if (currentMobileEvidence.semanticsVerified && currentMobileEvidence.completionCandidates > 0 && numeric(currentCoverage?.completionCoveredVisits) === 0) {
      mismatches.push({ family: "technicians", periodStart: currentMonth, type: "verified_mobile_completions_not_applied", currentMobileEvidence });
    }

    const result = {
      status: mismatches.length === 0 ? "matched" : "mismatch",
      expectedMonths: expectedMonths.length,
      readModels: Object.fromEntries([...byFamily].map(([family, rows]) => [family, {
        months: rows.length,
        first: rows[0]?.period_start ?? null,
        last: rows.at(-1)?.period_start ?? null,
      }])),
      sourceValidation: {
        quotes: sourceSummary(quotes, currentMonth),
        jobs: sourceSummary(jobs, currentMonth),
        laborEfficiency: sourceSummary(laborEfficiency, currentMonth),
        capacity: { months: capacityRows.size, currentRows: capacityRows.get(currentMonth)?.length ?? 0, currentExpected: currentCapacity },
        commissions: sourceSummary(commissionRuns, currentMonth),
      },
      currentTechnicianMobileCoverage: currentCoverage ? {
        scheduledVisits: numeric(currentCoverage.scheduledVisits),
        arrivalCoveredVisits: numeric(currentCoverage.arrivalCoveredVisits),
        completionCoveredVisits: numeric(currentCoverage.completionCoveredVisits),
        onTimeVisits: numeric(currentCoverage.onTimeVisits),
        uncoveredVisits: numeric(currentCoverage.uncoveredVisits),
        unverifiedMobileEvents: numeric(currentCoverage.unverifiedMobileEvents),
      } : null,
      currentMobileEvidence,
      contractChecks,
      mismatchCount: mismatches.length,
      mismatches: mismatches.slice(0, 100),
    };
    console.log(JSON.stringify(result, null, 2));
    if (mismatches.length > 0) process.exitCode = 1;
    await client.query("commit");
    transactionOpen = false;
  } finally {
    if (transactionOpen) await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

async function readCurrentMobileEvidence(client: pg.Client, periodStart: string) {
  const result = await client.query<{ semantics_verified: boolean; arrival_candidates: number; completion_candidates: number }>(
    `with config as (
       select mobile_status_verified, arrival_status_ids, completion_status_ids
         from metrics.technician_metric_configs
        where active and effective_start <= $1::date
          and (effective_end is null or effective_end >= ($1::date + interval '1 month - 1 day')::date)
        order by effective_start desc, revision desc limit 1
     ), visits as (
       select b.reference_id job_id, b.staff_id employee_id, b.planned_start_at, b.planned_end_at
         from metrics.metrics_schedule_blocks b
        where lower(trim(coalesce(b.reference_type, ''))) = 'job'
          and b.source_deleted_at is null
          and b.planned_start_at >= ($1::date::timestamp at time zone 'America/Los_Angeles')
          and b.planned_start_at < (($1::date + interval '1 month')::timestamp at time zone 'America/Los_Angeles')
     )
     select coalesce(c.mobile_status_verified, false) semantics_verified,
            count(*) filter (where m.status_id = any(c.arrival_status_ids))::int arrival_candidates,
            count(*) filter (where m.status_id = any(c.completion_status_ids))::int completion_candidates
       from config c
       left join visits v on true
       left join metrics.dim_people p on p.simpro_employee_id = v.employee_id
       left join metrics.metrics_mobile_status_logs m
         on m.project_id = v.job_id and m.staff_person_id = p.person_id
        and m.date_logged >= v.planned_start_at - interval '12 hours'
        and m.date_logged <= coalesce(v.planned_end_at, v.planned_start_at) + interval '24 hours'
      group by c.mobile_status_verified`,
    [periodStart],
  );
  return {
    semanticsVerified: Boolean(result.rows[0]?.semantics_verified),
    arrivalCandidates: Number(result.rows[0]?.arrival_candidates ?? 0),
    completionCandidates: Number(result.rows[0]?.completion_candidates ?? 0),
  };
}

export async function readQuoteSourceRows(client: pg.Client) {
  type QuoteRelationshipSource = {
    quote_id: string;
    date_approved: string | null;
    total: string;
    status_name: string | null;
    direct_source_snapshot_id: string | null;
    direct_payload: unknown;
    canonical_linked_job_id: string | null;
    snapshot_linked_job_id: string | null;
    override_outcome: string | null;
    won_override: boolean | null;
  };
  type JobRelationshipSource = {
    job_id: string;
    converted_from_type: string | null;
    converted_from_id: string | null;
    job_source_type: string | null;
    job_source_id: string | null;
    snapshot_source_quote_id: string | null;
    inverse_source_snapshot_id: string | null;
    inverse_payload: unknown;
  };
  const quoteResult = await client.query<QuoteRelationshipSource>(
    `select q.quote_id::text, q.date_approved::text, q.total::text, q.status_name,
            authoritative.id::text as direct_source_snapshot_id,
            authoritative.payload as direct_payload,
            q.linked_job_id::text as canonical_linked_job_id,
            snapshot.linked_job_id::text as snapshot_linked_job_id,
            active_override.outcome::text as override_outcome,
            active_override.won_override
       from metrics.metrics_quotes q
       left join metrics.quote_snapshots snapshot using (quote_id)
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
       left join lateral (
         select o.outcome, o.won_override
           from metrics.quote_classification_overrides o
          where o.quote_id = q.quote_id and o.active = true
          order by (o.outcome = 'excluded') desc, o.revision desc, o.created_at desc, o.id desc limit 1
       ) active_override on true
      where q.source_deleted_at is null
        and (q.date_approved >= date '2023-01-01' or q.date_approved is null)
      order by q.date_approved, q.quote_id`,
  );
  const jobResult = await client.query<JobRelationshipSource>(
    `select job.job_id::text, job.converted_from_type, job.converted_from_id::text,
            job.job_source_type, job.job_source_id::text,
            snapshot.source_quote_id::text as snapshot_source_quote_id,
            authoritative.id::text as inverse_source_snapshot_id,
            authoritative.payload as inverse_payload
       from metrics.metrics_jobs job
       left join metrics.job_snapshots snapshot using (job_id)
       left join lateral (
         select raw.id, raw.payload
           from metrics.raw_simpro_snapshots raw
          where raw.entity_type in ('job_details', 'jobs')
            and raw.entity_id = job.job_id::text
            and raw.complete_traversal = true
            and raw.source_deleted_at is null
          order by raw.extracted_at desc, raw.id desc
          limit 1
       ) authoritative on true
      where job.source_deleted_at is null
      order by job.job_id`,
  );

  const liveJobIds = new Set(jobResult.rows.map((row) => positiveIntegerString(row.job_id)).filter(isString));
  const expectedInverse = new Map<string, string[]>();
  const canonicalInverse = new Map<string, string[]>();
  const snapshotInverse = new Map<string, string[]>();
  const inverseErrors: string[] = [];
  for (const job of jobResult.rows) {
    const jobId = positiveIntegerString(job.job_id);
    if (jobId === null) {
      inverseErrors.push(`Invalid canonical job ID ${job.job_id}.`);
      continue;
    }
    if (job.inverse_source_snapshot_id !== null) {
      try {
        const sourceQuoteId = resolveJobConvertedFromQuoteId(job.inverse_payload);
        if (sourceQuoteId !== null) appendMapValue(expectedInverse, String(sourceQuoteId), jobId);
      } catch (error) {
        inverseErrors.push(`Job ${jobId}: ${errorMessage(error)}`);
      }
    }
    for (const [type, id] of [
      [job.converted_from_type, job.converted_from_id],
      [job.job_source_type, job.job_source_id],
    ] as const) {
      if (type?.trim().toLowerCase() === "quote") {
        const quoteId = positiveIntegerString(id);
        if (quoteId !== null) appendMapValue(canonicalInverse, quoteId, jobId);
      }
    }
    const snapshotQuoteId = positiveIntegerString(job.snapshot_source_quote_id);
    if (snapshotQuoteId !== null) appendMapValue(snapshotInverse, snapshotQuoteId, jobId);
  }

  return quoteResult.rows.map<QuoteSourceRow>((quote) => {
    const directPayload = isRecord(quote.direct_payload) ? quote.direct_payload : null;
    let directId: string | null = null;
    let directError: string | null = null;
    if (quote.direct_source_snapshot_id !== null) {
      try {
        const resolved = resolveQuoteDirectLinkedJobId(quote.direct_payload);
        directId = resolved === null ? null : String(resolved);
      } catch (error) {
        directError = errorMessage(error);
      }
    }
    const relationshipError = [directError, ...inverseErrors].filter(isString).join("; ") || null;
    const inverseJobIds = sortedUnique(expectedInverse.get(quote.quote_id) ?? []);
    return {
      quote_id: quote.quote_id,
      date_approved: quote.date_approved,
      total: quote.total,
      status_name: quote.status_name,
      direct_source_snapshot_id: quote.direct_source_snapshot_id,
      direct_payload: quote.direct_payload,
      direct_linked_job_id: scalarText(directPayload?.LinkedJobID),
      direct_linked_job_id_alias: scalarText(directPayload?.linkedJobId),
      direct_linked_job_id_snake: scalarText(directPayload?.linked_job_id),
      direct_conversion_job_id: directId !== null && liveJobIds.has(directId) ? directId : null,
      inverse_conversion_job_id: inverseJobIds[0] ?? null,
      canonical_linked_job_id: quote.canonical_linked_job_id,
      snapshot_linked_job_id: quote.snapshot_linked_job_id,
      expected_inverse_job_ids: inverseJobIds,
      canonical_inverse_job_ids: sortedUnique(canonicalInverse.get(quote.quote_id) ?? []),
      snapshot_inverse_job_ids: sortedUnique(snapshotInverse.get(quote.quote_id) ?? []),
      relationship_provenance_error: relationshipError,
      override_outcome: quote.override_outcome,
      won_override: quote.won_override,
    };
  });
}

export function aggregateQuoteSources(rows: QuoteSourceRow[], periods?: string[]) {
  const periodStarts = periods ?? [...new Set(rows.flatMap((row) => row.date_approved ? [`${row.date_approved.slice(0, 7)}-01`] : []))].sort();
  const missingApprovedDate = rows.filter((row) => !row.date_approved).length;
  const byPeriod = new Map(periodStarts.map((periodStart) => [periodStart, emptyQuoteSource(periodStart)]));
  for (const row of rows) {
    if (!row.date_approved) continue;
    const periodStart = `${row.date_approved.slice(0, 7)}-01`;
    const aggregate = byPeriod.get(periodStart);
    if (!aggregate) continue;
    const totalValue = numeric(row.total);
    const result = classifyQuoteSourceRow(row, totalValue);
    const classification: QuoteSourceClassification = {
      quoteId: row.quote_id,
      totalValue,
      outcome: result.acceptanceOutcome,
      path: result.path,
      tier: result.dealTier,
    };
    aggregate.source_records += 1;
    aggregate.acceptance_paths[result.path] += 1;
    aggregate.acceptance_path_values[result.path] += totalValue;
    aggregate.quotes.push(classification);
    if (row.override_outcome || row.won_override !== null) aggregate.override_count += 1;
    if (result.acceptanceOutcome === "excluded") {
      aggregate.excluded_count += 1;
      continue;
    }
    const tier = aggregate.tiers[result.dealTier];
    aggregate.quote_count += 1;
    aggregate.quote_value = numeric(aggregate.quote_value) + totalValue;
    tier.quoteCount += 1;
    tier.quoteValue += totalValue;
    if (result.accepted) {
      aggregate.accepted_count += 1;
      aggregate.accepted_value = numeric(aggregate.accepted_value) + totalValue;
      tier.acceptedCount += 1;
      tier.acceptedValue += totalValue;
    } else {
      aggregate.not_accepted_count += 1;
      aggregate.not_accepted_value = numeric(aggregate.not_accepted_value) + totalValue;
      tier.notAcceptedCount += 1;
      tier.notAcceptedValue += totalValue;
    }
  }
  for (const aggregate of byPeriod.values()) {
    aggregate.excluded_without_date_approved = missingApprovedDate;
    aggregate.acceptance_rate_by_count = aggregate.quote_count > 0 ? aggregate.accepted_count / aggregate.quote_count * 100 : 0;
    aggregate.acceptance_rate_by_value = numeric(aggregate.quote_value) > 0 ? numeric(aggregate.accepted_value) / numeric(aggregate.quote_value) * 100 : 0;
    aggregate.average_accepted_deal = aggregate.accepted_count > 0 ? numeric(aggregate.accepted_value) / aggregate.accepted_count : 0;
  }
  return byPeriod;
}

function classifyQuoteSourceRow(row: QuoteSourceRow, totalValue: number) {
  const excluded = row.override_outcome?.trim().toLowerCase() === "excluded";
  const acceptedOnline = row.status_name?.trim().toLowerCase() === "quote accepted online";
  const converted = positiveIntegerString(row.direct_conversion_job_id) !== null
    || positiveIntegerString(row.inverse_conversion_job_id) !== null;
  const acceptanceOutcome = excluded ? "excluded" : acceptedOnline || converted ? "accepted" : "not_accepted";
  const path: QuoteAcceptancePath = excluded
    ? "excluded"
    : acceptedOnline && converted
      ? "accepted_online_and_converted"
      : acceptedOnline
        ? "accepted_online_only"
        : converted
          ? "converted_only"
          : "not_accepted";
  return {
    acceptanceOutcome,
    accepted: acceptanceOutcome === "accepted",
    path,
    dealTier: independentDealTier(totalValue),
  } as const;
}

function independentDealTier(totalValue: number): QuoteTier {
  if (totalValue < 750) return "Under $750";
  if (totalValue < 2_000) return "$750-$2K";
  if (totalValue < 10_000) return "$2K-$10K";
  return "$10K+";
}

function actualDirectConversionId(row: QuoteSourceRow): { id: string | null; error: string | null } {
  const payload = row.direct_payload ?? {
    LinkedJobID: row.direct_linked_job_id,
    linkedJobId: row.direct_linked_job_id_alias,
    linked_job_id: row.direct_linked_job_id_snake,
  };
  try {
    const resolved = resolveQuoteDirectLinkedJobId(payload);
    return { id: resolved === null ? null : String(resolved), error: null };
  } catch (error) {
    const detail = errorMessage(error).toLowerCase();
    return {
      id: null,
      error: detail.includes("conflict")
        ? "conflicting_direct_conversion_ids"
        : "invalid_direct_conversion_id",
    };
  }
}

function positiveIntegerString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isSafeInteger(number) ? normalized : null;
}

function normalizedNullableId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return positiveIntegerString(value) ?? `invalid:${String(value)}`;
}

function appendMapValue(map: Map<string, string[]>, key: string, value: string): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => Number(left) - Number(right) || left.localeCompare(right));
}

function scalarText(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Malformed relationship provenance.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: string | null): value is string {
  return value !== null;
}

async function readJobAggregates(client: pg.Client) {
  const result = await client.query<Omit<JobSourceAggregate, "field_support"> & Record<string, unknown>>(
    `select to_char(completed_date, 'YYYY-MM-01') period_start,
            count(*)::int completed_jobs,
            coalesce(sum(total), 0)::text total_sell_value,
            coalesce(sum(gross_profit_actual), 0)::text gross_profit_actual,
            count(*) filter (where total is not null and gross_profit_actual is not null)::int gross_margin_included_jobs,
            coalesce(sum(total) filter (where total is not null and gross_profit_actual is not null), 0)::text gross_margin_covered_sell_value,
            coalesce(sum(gross_profit_actual) filter (where total is not null and gross_profit_actual is not null), 0)::text gross_margin_covered_profit,
            coalesce(sum(net_profit_actual), 0)::text net_profit_actual,
            count(*) filter (where total is not null and net_profit_actual is not null)::int net_margin_included_jobs,
            coalesce(sum(total) filter (where total is not null and net_profit_actual is not null), 0)::text net_margin_covered_sell_value,
            coalesce(sum(net_profit_actual) filter (where total is not null and net_profit_actual is not null), 0)::text net_margin_covered_profit,
            coalesce(sum(materials_cost_actual), 0)::text materials_actual,
            coalesce(sum(labor_cost_actual), 0)::text labor_actual,
            coalesce(sum(overhead_cost_actual), 0)::text overhead_actual,
            coalesce(sum(commission_cost_actual), 0)::text commission_actual,
            coalesce(sum(materials_cost_actual) filter (where materials_cost_actual is not null and materials_cost_estimate is not null), 0)::text materials_paired_actual,
            coalesce(sum(materials_cost_estimate) filter (where materials_cost_actual is not null and materials_cost_estimate is not null), 0)::text materials_paired_estimate,
            count(*) filter (where materials_cost_actual is not null and materials_cost_estimate is not null)::int materials_paired_jobs,
            coalesce(sum(labor_cost_actual) filter (where labor_cost_actual is not null and labor_cost_estimate is not null), 0)::text labor_paired_actual,
            coalesce(sum(labor_cost_estimate) filter (where labor_cost_actual is not null and labor_cost_estimate is not null), 0)::text labor_paired_estimate,
            count(*) filter (where labor_cost_actual is not null and labor_cost_estimate is not null)::int labor_paired_jobs,
            coalesce(sum(overhead_cost_actual) filter (where overhead_cost_actual is not null and overhead_cost_estimate is not null), 0)::text overhead_paired_actual,
            coalesce(sum(overhead_cost_estimate) filter (where overhead_cost_actual is not null and overhead_cost_estimate is not null), 0)::text overhead_paired_estimate,
            count(*) filter (where overhead_cost_actual is not null and overhead_cost_estimate is not null)::int overhead_paired_jobs,
            coalesce(sum(total_resource_cost_actual) filter (where total_resource_cost_actual is not null and total_resource_cost_estimate is not null), 0)::text total_paired_actual,
            coalesce(sum(total_resource_cost_estimate) filter (where total_resource_cost_actual is not null and total_resource_cost_estimate is not null), 0)::text total_paired_estimate,
            count(*) filter (where total_resource_cost_actual is not null and total_resource_cost_estimate is not null)::int total_paired_jobs,
            count(total)::int sell_value_supported,
            count(gross_profit_actual)::int gross_profit_supported,
            count(net_profit_actual)::int net_profit_supported,
            count(*) filter (where materials_cost_actual is not null or labor_cost_actual is not null or overhead_cost_actual is not null or total_resource_cost_actual is not null)::int cost_totals_supported,
            jsonb_build_object(
              'net_profit_actual', count(net_profit_actual), 'net_margin_actual', count(net_margin_actual),
              'materials_cost_actual', count(materials_cost_actual), 'materials_cost_estimate', count(materials_cost_estimate),
              'labor_cost_actual', count(labor_cost_actual), 'labor_cost_estimate', count(labor_cost_estimate),
              'labor_hours_actual', count(labor_hours_actual), 'labor_hours_estimate', count(labor_hours_estimate),
              'overhead_cost_actual', count(overhead_cost_actual), 'overhead_cost_estimate', count(overhead_cost_estimate),
              'total_resource_cost_actual', count(total_resource_cost_actual), 'total_resource_cost_estimate', count(total_resource_cost_estimate),
              'commission_cost_actual', count(commission_cost_actual)
            ) field_support
       from metrics.metrics_jobs
      where completed_date >= date '2023-01-01'
        and lower(trim(stage)) in ('complete', 'archived') and source_deleted_at is null
      group by 1 order by 1`,
  );
  return rowMap(result.rows.map((row) => ({ ...row, field_support: record(row.field_support) ?? {} } as JobSourceAggregate)));
}

async function readLaborEfficiencyAggregates(client: pg.Client) {
  const result = await client.query<LaborEfficiencySourceRow>(
    `with quote_labor as (
       select quote_id, sum(quantity_hours) quoted_hours, count(*) rows
         from metrics.metrics_quote_labor where source_deleted_at is null group by quote_id
     ), mapped_time as (
       select t.reference_id job_id, count(distinct t.employee_id)::int technicians, sum(t.total_hours) actual_hours
         from metrics.metrics_employee_timesheets t
         join metrics.dim_people p on p.simpro_employee_id = t.employee_id
        where lower(trim(coalesce(t.reference_type, ''))) = 'job'
          and t.reference_id is not null and t.source_deleted_at is null and t.total_hours > 0
        group by t.reference_id
     )
       select to_char(j.completed_date, 'YYYY-MM-01') period_start,
              j.job_source_type, j.job_source_id::text,
              sq.source_quote_id::text as quote_id,
              j.labor_hours_estimate::text,
              ql.quoted_hours::text as quote_quoted_hours,
              coalesce(ql.rows, 0)::int as quote_labor_rows,
              coalesce(mt.technicians, 0) technicians,
              coalesce(mt.actual_hours, 0)::text actual_hours
         from metrics.metrics_jobs j
         left join metrics.job_source_quotes sq on sq.job_id = j.job_id
         left join quote_labor ql on ql.quote_id = sq.source_quote_id
         left join mapped_time mt on mt.job_id = j.job_id
        where j.completed_date >= date '2023-01-01'
          and lower(trim(j.stage)) in ('complete', 'archived') and j.source_deleted_at is null
        order by j.completed_date, j.job_id`,
  );
  return aggregateLaborEfficiencySources(result.rows);
}

export function classifyTechnicianLaborSource(input: {
  jobSource?: string | null;
  quoteId?: string | null;
  recurringJobId?: string | null;
}): "quote_generated" | "recurring" | "other" {
  const cacheKey = JSON.stringify([input.jobSource ?? null, Boolean(input.quoteId), Boolean(input.recurringJobId)]);
  const cached = technicianLaborSourceCache.get(cacheKey);
  if (cached) return cached;
  const model = buildTechnicianPerformanceReadModel({
    jobs: [{
      jobId: "source-classifier",
      completedDate: "2000-01-01",
      sellValue: 0,
      jobSource: input.jobSource,
      quoteId: input.quoteId,
      recurringJobId: input.recurringJobId,
      quotedHours: null,
      timesheets: [],
    }],
    periodStart: "2000-01-01",
    periodEnd: "2000-01-01",
  });
  const result = model.coverage.quoteGeneratedJobs === 1
    ? "quote_generated"
    : model.coverage.recurringJobs === 1
      ? "recurring"
      : "other";
  technicianLaborSourceCache.set(cacheKey, result);
  return result;
}

export function aggregateLaborEfficiencySources(rows: LaborEfficiencySourceRow[]) {
  const byPeriod = new Map<string, LaborEfficiencySourceAggregate>();
  for (const row of rows) {
    const aggregate = byPeriod.get(row.period_start) ?? emptyLaborSource(row.period_start);
    const recurringJobId = row.job_source_type === "Recurring" ? row.job_source_id : null;
    const source = classifyTechnicianLaborSource({ jobSource: row.job_source_type, quoteId: row.quote_id, recurringJobId });
    const quotedHours = row.job_source_type === "Recurring" ? nullableNumeric(row.labor_hours_estimate) : nullableNumeric(row.quote_quoted_hours);
    const quoteLaborRows = row.job_source_type === "Recurring" && numeric(row.labor_hours_estimate) > 0 ? 1 : row.quote_labor_rows;
    const laborCovered = source !== "other" && quoteLaborRows > 0 && quotedHours !== null && quotedHours > 0;
    aggregate.total_jobs += 1;
    if (row.technicians > 0) aggregate.jobs_with_timesheets += 1;
    if (source === "quote_generated") aggregate.quote_generated_jobs += 1;
    if (source === "recurring") aggregate.recurring_jobs += 1;
    if (source === "quote_generated" && laborCovered) aggregate.quote_generated_jobs_with_labor += 1;
    if (source === "recurring" && laborCovered) aggregate.recurring_jobs_with_labor += 1;
    if (source !== "other" && !laborCovered) aggregate.missing_labor_jobs += 1;
    if (laborCovered && row.technicians > 0) {
      aggregate.included_jobs += 1;
      if (row.technicians === 1) aggregate.individual_jobs += 1;
      else aggregate.crew_jobs += 1;
      if (source === "quote_generated") {
        aggregate.quote_quoted_hours = numeric(aggregate.quote_quoted_hours) + numeric(quotedHours);
        aggregate.quote_actual_hours = numeric(aggregate.quote_actual_hours) + numeric(row.actual_hours);
        aggregate.quote_jobs += 1;
      } else {
        aggregate.recurring_quoted_hours = numeric(aggregate.recurring_quoted_hours) + numeric(quotedHours);
        aggregate.recurring_actual_hours = numeric(aggregate.recurring_actual_hours) + numeric(row.actual_hours);
        aggregate.recurring_included_jobs += 1;
      }
    }
    byPeriod.set(row.period_start, aggregate);
  }
  return byPeriod;
}

async function readCapacityRows(client: pg.Client) {
  const result = await client.query<CapacitySourceRow>(
    `with months as (
       select month_start::date period_start, (month_start + interval '1 month - 1 day')::date period_end
         from generate_series(date '2023-01-01', date_trunc('month', current_timestamp at time zone 'America/Los_Angeles')::date, interval '1 month') month_start
     )
     select m.period_start::text, m.period_end::text, p.simpro_employee_id::text employee_id,
            p.display_name, p.date_of_hire::text, p.archived, p.availability_json,
            coalesce(sum(t.total_hours) filter (where lower(trim(coalesce(t.reference_type, ''))) = 'activity' and t.reference_id = 47), 0)::text holiday_hours,
            coalesce(sum(t.total_hours) filter (where lower(trim(coalesce(t.reference_type, ''))) = 'activity' and t.reference_id = 2), 0)::text sick_personal_hours,
            coalesce(sum(t.total_hours) filter (where lower(trim(coalesce(t.reference_type, ''))) = 'activity' and t.reference_id = 181), 0)::text pto_hours
       from months m
       join metrics.effective_technician_roster er on er.simpro_employee_id is not null
        and exists (
          -- Owner rule: month roster = whoever recorded work in the month.
          select 1 from metrics.metrics_employee_timesheets tx
           where tx.employee_id = er.simpro_employee_id
             and tx.work_date between m.period_start and m.period_end
             and tx.source_deleted_at is null and tx.total_hours > 0
        )
       join metrics.dim_people p on p.person_id = er.person_id
       left join metrics.metrics_employee_timesheets t on t.employee_id = p.simpro_employee_id
        and t.work_date between m.period_start and m.period_end and t.source_deleted_at is null and t.total_hours > 0
      group by m.period_start, m.period_end, p.simpro_employee_id, p.display_name, p.date_of_hire, p.archived, p.availability_json
      order by m.period_start, p.simpro_employee_id`,
  );
  return groupedMap(result.rows);
}

async function readCapacityCoverage(client: pg.Client) {
  const result = await client.query<CapacityCoverageAggregate>(
    `select to_char(work_date, 'YYYY-MM-01') period_start,
            coalesce(sum(total_hours) filter (where lower(trim(coalesce(reference_type, ''))) = 'activity' and reference_id = 47 and total_hours > 0), 0)::text holiday_hours,
            coalesce(sum(total_hours) filter (where lower(trim(coalesce(reference_type, ''))) = 'activity' and reference_id = 2 and total_hours > 0), 0)::text sick_personal_hours,
            coalesce(sum(total_hours) filter (where lower(trim(coalesce(reference_type, ''))) = 'activity' and reference_id = 181 and total_hours > 0), 0)::text pto_hours
       from metrics.metrics_employee_timesheets
      where work_date >= date '2023-01-01' and source_deleted_at is null
      group by 1 order by 1`,
  );
  return rowMap(result.rows);
}

async function readTechnicianUtilizationRows(client: pg.Client) {
  const result = await client.query<TechnicianUtilizationSourceRow>(
    `select to_char(t.work_date, 'YYYY-MM-01') period_start,
            t.employee_id::text,
            (p.person_id is not null) person_mapped,
            exists (
              -- Owner rule: month roster = whoever recorded work in the month.
              select 1 from metrics.effective_technician_roster er
               where er.simpro_employee_id = t.employee_id
                 and exists (
                   select 1 from metrics.metrics_employee_timesheets tx
                    where tx.employee_id = t.employee_id
                      and tx.source_deleted_at is null
                      and tx.total_hours > 0
                      and date_trunc('month', tx.work_date) = date_trunc('month', t.work_date)
                 )
            ) roster_member,
            coalesce(sum(t.total_hours) filter (
              where t.total_hours > 0
                and lower(trim(coalesce(t.reference_type, ''))) = 'job'
                and t.reference_id is not null
                and lower(trim(coalesce(t.parse_status, 'parsed'))) = 'parsed'
                and j.job_id is not null
            ), 0)::text productive_supported_job_hours,
            coalesce(sum(t.total_hours) filter (where t.total_hours > 0), 0)::text all_positive_recorded_hours
       from metrics.metrics_employee_timesheets t
       left join metrics.dim_people p on p.simpro_employee_id = t.employee_id
       left join metrics.metrics_jobs j
         on lower(trim(coalesce(t.reference_type, ''))) = 'job'
        and j.job_id = t.reference_id
        and j.source_deleted_at is null
      where t.work_date >= date '2023-01-01'
        and t.source_deleted_at is null
      group by 1, date_trunc('month', t.work_date), t.employee_id, (p.person_id is not null)
      order by 1, t.employee_id`,
  );
  return groupedMap(result.rows);
}

async function readCostCenterCategoryRows(client: pg.Client) {
  const result = await client.query<CostCenterCategorySourceRow>(
    `select 'job'::text project_type, j.job_id::text project_id,
            c.cost_center_id::text, c.configured_cost_center_id::text,
            c.category, c.sell_value::text, j.category parent_category
       from metrics.metrics_jobs j
       left join metrics.metrics_job_cost_centers c
         on c.job_id = j.job_id and c.source_deleted_at is null
      where j.source_deleted_at is null
      union all
     select 'quote'::text project_type, q.quote_id::text project_id,
            c.cost_center_id::text, c.configured_cost_center_id::text,
            c.category, c.sell_value::text, q.category parent_category
       from metrics.metrics_quotes q
       left join metrics.metrics_quote_cost_centers c
         on c.quote_id = q.quote_id and c.source_deleted_at is null
      where q.source_deleted_at is null
      order by project_type, project_id, cost_center_id`,
  );
  return result.rows;
}

async function readInvoiceRuntimeEvidence(client: pg.Client) {
  const result = await client.query<InvoiceRuntimeEvidence>(
    `select
       (select count(*)::int from metrics.ingestion_jobs
         where entity_type::text in ('invoices', 'customer_invoice_logs')
           and status::text in ('queued', 'running', 'failed')) active_ingestion_jobs,
       (select count(*)::int from metrics.ingestion_runs
         where entity_type::text in ('invoices', 'customer_invoice_logs')
           and status::text in ('running', 'failed')) active_ingestion_runs,
       (select count(*)::int from metrics.backfill_source_month_ledger
         where source_family = 'invoices'
           and (required_for_completion or status::text in (
             'planned', 'queued', 'running', 'reconciliation_pending', 'dead_lettered'
           ))) active_backfill_units`,
  );
  return result.rows[0] ?? {
    active_ingestion_jobs: 0,
    active_ingestion_runs: 0,
    active_backfill_units: 0,
  };
}

async function readAppRoles(client: pg.Client) {
  const result = await client.query<AppRoleSourceRow>(
    `select lower(trim(email)) email, role::text
       from metrics.app_roles
      where active = true
      order by lower(trim(email)), role`,
  );
  return result.rows;
}

async function readCommissionRuns(client: pg.Client) {
  const result = await client.query<CommissionRun & { period_start: string }>(
    `with current_periods as (
       select distinct on (period_start) * from metrics.commission_periods
        where period_start >= date '2023-01-01' order by period_start, revision desc, id desc
     )
     select p.period_start::text, r.id::text as run_id, r.completed_jobs, r.total_work_value::text,
            r.pool_amount::text, r.inside_pool_total::text, r.outside_pool_total::text,
            r.payroll_total::text, r.source_complete,
            r.source_evidence->>'status' source_status, r.invariants_json,
            coalesce((
              select jsonb_agg(jsonb_build_object(
                'input_type', i.input_type,
                'source_identity', i.source_identity,
                'input_json', i.input_json
              ) order by i.input_type, i.source_identity)
                from metrics.commission_run_inputs i where i.run_id = r.id
            ), '[]'::jsonb) inputs,
            coalesce((
              select jsonb_agg(jsonb_build_object(
                'employee_id', e.employee_id::text,
                'forfeited_bonus', e.forfeited_bonus,
                'reallocation_received', e.reallocation_received,
                'efficiency_json', e.efficiency_json,
                'outside_pool_adjustment', e.outside_pool_adjustment,
                'final_bonus', e.final_bonus,
                'payroll_bonus', e.payroll_bonus
              ) order by e.employee_id)
                from metrics.commission_employee_results e where e.run_id = r.id
            ), '[]'::jsonb) employee_results,
            coalesce((
              select jsonb_agg(jsonb_build_object(
                'job_id', a.job_id::text,
                'employee_id', a.employee_id::text,
                'job_total', a.job_total,
                'allocated_value', a.allocated_value
              ) order by a.job_id, a.employee_id)
                from metrics.commission_job_allocations a where a.run_id = r.id
            ), '[]'::jsonb) job_allocations
       from current_periods p join metrics.commission_calculation_runs r on r.id = p.current_run_id
      order by p.period_start`,
  );
  return rowMap(result.rows);
}

export function validateQuotes(row: ReadModelRow, expected: QuoteSourceAggregate | undefined, mismatches: ValidationMismatch[]) {
  const source = expected ?? emptyQuoteSource(row.period_start);
  compare(row, "quoteCount", source.quote_count, mismatches);
  compare(row, "quoteValue", source.quote_value, mismatches);
  compare(row, "acceptedCount", source.accepted_count, mismatches);
  compare(row, "acceptedValue", source.accepted_value, mismatches);
  compare(row, "notAcceptedCount", source.not_accepted_count, mismatches);
  compare(row, "notAcceptedValue", source.not_accepted_value, mismatches);
  compare(row, "acceptanceDenominatorCount", source.quote_count, mismatches);
  compare(row, "acceptanceDenominatorValue", source.quote_value, mismatches);
  compare(row, "excludedCount", source.excluded_count, mismatches);
  compare(row, "acceptanceRateByCount", source.acceptance_rate_by_count, mismatches);
  compare(row, "acceptanceRateByValue", source.acceptance_rate_by_value, mismatches);
  compare(row, "averageAcceptedDeal", source.average_accepted_deal, mismatches);
  compare(row, "overrideCount", source.override_count, mismatches);
  compare(row, "excludedWithoutDateApproved", source.excluded_without_date_approved, mismatches);
  for (const path of ["accepted_online_and_converted", "accepted_online_only", "converted_only", "not_accepted", "excluded"] as const) {
    compare(row, `acceptancePaths.${path}`, source.acceptance_paths[path], mismatches);
  }
  for (const tier of QUOTE_TIERS) {
    for (const field of ["quoteCount", "quoteValue", "acceptedCount", "acceptedValue", "notAcceptedCount", "notAcceptedValue"] as const) {
      compare(row, `tiers.${tier}.${field}`, source.tiers[tier][field], mismatches);
    }
  }
  const dashboard = record(row.values_json.dashboard);
  const servedClassifications = array(dashboard?.classificationRows).map(record).filter((item): item is Record<string, unknown> => Boolean(item));
  const expectedClassificationRows = Math.min(source.source_records, numeric(numberAt(dashboard ?? {}, "pagination.pageSize")) || 50);
  if (servedClassifications.length !== expectedClassificationRows) {
    mismatches.push({
      family: "quotes", periodStart: row.period_start, type: "quote_classification_page_size",
      expected: expectedClassificationRows, actual: servedClassifications.length,
    });
  }
  const expectedByQuote = new Map(source.quotes.map((quote) => [quote.quoteId, quote]));
  compareValue(row, "dashboard.pagination.classificationTotal", numberAt(dashboard ?? {}, "pagination.classificationTotal"), source.source_records, mismatches);
  const servedDashboardPaths = new Map(array(dashboard?.acceptancePaths).flatMap((item) => {
    const path = record(item);
    return typeof path?.path === "string" ? [[path.path, path] as const] : [];
  }));
  for (const path of ["accepted_online_and_converted", "accepted_online_only", "converted_only", "not_accepted"] as const) {
    compareValue(row, `dashboard.acceptancePaths.${path}.count`, servedDashboardPaths.get(path)?.count, source.acceptance_paths[path], mismatches);
    compareValue(row, `dashboard.acceptancePaths.${path}.value`, servedDashboardPaths.get(path)?.value, source.acceptance_path_values[path], mismatches);
  }
  for (const served of servedClassifications) {
    const quoteId = String(served.quoteId ?? "");
    const expectedQuote = expectedByQuote.get(quoteId);
    if (!expectedQuote || served.outcome !== expectedQuote.outcome || served.acceptancePath !== expectedQuote.path || served.tier !== expectedQuote.tier) {
      mismatches.push({
        family: "quotes", periodStart: row.period_start, type: "quote_classification",
        quoteId, expected: expectedQuote ?? null,
        actual: { outcome: served.outcome ?? null, path: served.acceptancePath ?? null, tier: served.tier ?? null },
      });
    }
  }
  if (source.quote_count !== source.accepted_count + source.not_accepted_count) {
    mismatches.push({ family: "quotes", periodStart: row.period_start, type: "source_acceptance_partition", source });
  }
  for (const field of ["wonCount", "lostCount", "openCount", "unknownCount", "winRateByCount"]) {
    if (Object.hasOwn(row.values_json, field)) mismatches.push({ family: "quotes", periodStart: row.period_start, type: "obsolete_quote_semantics", field });
  }
}

export function validateJobs(row: ReadModelRow, expected: JobSourceAggregate | undefined, mismatches: ValidationMismatch[]) {
  const source = expected ?? emptyJobSource(row.period_start);
  compare(row, "completedJobCount", source.completed_jobs, mismatches);
  compare(row, "totalSellValue", source.total_sell_value, mismatches);
  compareValue(row, "averageJobValue", row.values_json.averageJobValue, source.completed_jobs > 0 ? numeric(source.total_sell_value) / source.completed_jobs : null, mismatches);
  compare(row, "grossProfitActual", source.gross_profit_actual, mismatches);
  compareValue(row, "grossMarginActual", row.values_json.grossMarginActual, percentOrNull(source.gross_margin_covered_profit, source.gross_margin_covered_sell_value), mismatches);
  compare(row, "netProfitActual", source.net_profit_actual, mismatches);
  compareValue(row, "netMarginActual", row.values_json.netMarginActual, percentOrNull(source.net_margin_covered_profit, source.net_margin_covered_sell_value), mismatches);
  compare(row, "profitBridge.revenue", source.total_sell_value, mismatches);
  compare(row, "profitBridge.materials", source.materials_actual, mismatches);
  compare(row, "profitBridge.labor", source.labor_actual, mismatches);
  compare(row, "profitBridge.overhead", source.overhead_actual, mismatches);
  compare(row, "profitBridge.commission", source.commission_actual, mismatches);
  compare(row, "profitBridge.netProfit", source.net_profit_actual, mismatches);
  const other = numeric(source.total_sell_value) - numeric(source.materials_actual) - numeric(source.labor_actual)
    - numeric(source.overhead_actual) - numeric(source.commission_actual) - numeric(source.net_profit_actual);
  compare(row, "profitBridge.other", other, mismatches);
  for (const [prefix, actual, estimate, jobs] of [
    ["materials", source.materials_paired_actual, source.materials_paired_estimate, source.materials_paired_jobs],
    ["labor", source.labor_paired_actual, source.labor_paired_estimate, source.labor_paired_jobs],
    ["overhead", source.overhead_paired_actual, source.overhead_paired_estimate, source.overhead_paired_jobs],
    ["total", source.total_paired_actual, source.total_paired_estimate, source.total_paired_jobs],
  ] as const) {
    compare(row, `costVariance.${prefix}Actual`, actual, mismatches);
    compare(row, `costVariance.${prefix}Estimate`, estimate, mismatches);
    compare(row, `costVariance.${prefix}PairedJobs`, jobs, mismatches);
  }
  const financialExpected: Record<string, number> = {
    totalJobs: source.completed_jobs,
    sellValueSupported: source.sell_value_supported,
    sellValueMissing: source.completed_jobs - source.sell_value_supported,
    grossProfitSupported: source.gross_profit_supported,
    grossProfitMissing: source.completed_jobs - source.gross_profit_supported,
    netProfitSupported: source.net_profit_supported,
    netProfitMissing: source.completed_jobs - source.net_profit_supported,
    costTotalsSupported: source.cost_totals_supported,
    grossMarginIncludedJobs: source.gross_margin_included_jobs,
    grossMarginCoveredSellValue: numeric(source.gross_margin_covered_sell_value),
    grossMarginCoveredProfit: numeric(source.gross_margin_covered_profit),
    netMarginIncludedJobs: source.net_margin_included_jobs,
    netMarginCoveredSellValue: numeric(source.net_margin_covered_sell_value),
    netMarginCoveredProfit: numeric(source.net_margin_covered_profit),
  };
  for (const [field, value] of Object.entries(financialExpected)) compare(row, `financialCoverage.${field}`, value, mismatches);
  compare(row, "grossMarginCoverage.fromSimproTotals", source.gross_profit_supported, mismatches);
  compare(row, "grossMarginCoverage.fallbackOrMissing", source.completed_jobs - source.gross_profit_supported, mismatches);
  for (const field of JOB_COST_FIELDS) {
    const supported = numeric(source.field_support[JOB_SOURCE_COLUMNS[field]]);
    compare(row, `fieldCoverage.${field}.total`, source.completed_jobs, mismatches);
    compare(row, `fieldCoverage.${field}.supported`, supported, mismatches);
    compare(row, `fieldCoverage.${field}.missing`, source.completed_jobs - supported, mismatches);
  }
}

export function laborEfficiencyServedTotals(values: Record<string, unknown>) {
  const totals = {
    quoteGenerated: { quotedHours: 0, actualHours: 0, jobs: 0 },
    recurring: { quotedHours: 0, actualHours: 0, jobs: 0 },
  };
  const allocations = array(values.allocations);
  if (allocations.length > 0) {
    const jobs = new Map<string, {
      source: "quote_generated" | "recurring";
      quotedHours: number;
      actualHours: number;
    }>();
    for (const item of allocations) {
      const allocation = record(item);
      if (allocation?.laborEfficiencyCovered !== true) continue;
      const source = allocation.jobSource === "recurring"
        ? "recurring"
        : allocation.jobSource === "quote_generated"
          ? "quote_generated"
          : null;
      const jobId = String(allocation.jobId ?? "").trim();
      if (!source || !jobId) continue;
      const current = jobs.get(jobId) ?? {
        source,
        quotedHours: numeric(allocation.quotedHours),
        actualHours: 0,
      };
      current.actualHours += numeric(allocation.actualHours);
      jobs.set(jobId, current);
    }
    for (const job of jobs.values()) {
      const target = job.source === "recurring" ? totals.recurring : totals.quoteGenerated;
      target.quotedHours += job.quotedHours;
      target.actualHours += job.actualHours;
      target.jobs += 1;
    }
    return totals;
  }

  // Legacy payload fallback. Current read models always include allocation rows.
  for (const item of array(values.technicians)) {
    const technician = record(item);
    const efficiency = record(technician?.laborEfficiency);
    addLaborSummary(totals.quoteGenerated, record(efficiency?.quoteGenerated));
    addLaborSummary(totals.recurring, record(efficiency?.recurring));
  }
  for (const item of array(values.crewLaborEfficiency)) {
    const crew = record(item);
    const target = crew?.source === "recurring" ? totals.recurring : crew?.source === "quote_generated" ? totals.quoteGenerated : null;
    if (target) addLaborSummary(target, crew);
  }
  return totals;
}

export function expectedCapacities(
  row: ReadModelRow,
  sourceRows: CapacitySourceRow[],
) {
  return sourceRows.map((source) => {
    const employeeId = source.employee_id;
    const holidayHours = numeric(source?.holiday_hours);
    const sickPersonalHours = numeric(source?.sick_personal_hours);
    const ptoHours = numeric(source?.pto_hours);
    const expected = calculateTechnicianCapacity({
      profile: {
        employeeId,
        displayName: source.display_name,
        dateOfHire: source.date_of_hire,
        archived: source.archived === true,
        availability: parseTechnicianAvailability(source.availability_json),
      },
      periodStart: row.period_start,
      periodEnd: source.period_end ?? endOfMonth(row.period_start),
      holidayHours,
      sickPersonalHours,
      ptoHours,
    });
    return { employeeId, source, ...expected };
  });
}

export function validateTechnicians(
  row: ReadModelRow,
  labor: LaborEfficiencySourceAggregate | undefined,
  capacityRows: CapacitySourceRow[],
  capacityCoverage: CapacityCoverageAggregate | undefined,
  mismatches: ValidationMismatch[],
) {
  const coverage = record(row.values_json.coverage);
  if (!coverage) {
    mismatches.push({ family: row.metric_family, periodStart: row.period_start, type: "missing_coverage" });
    return;
  }
  const source = labor ?? emptyLaborSource(row.period_start);
  const coverageExpected: Record<string, number> = {
    totalJobs: source.total_jobs,
    jobsWithTimesheets: source.jobs_with_timesheets,
    jobsMissingTimesheets: source.total_jobs - source.jobs_with_timesheets,
    quoteSourcedJobs: source.quote_generated_jobs,
    quoteGeneratedJobs: source.quote_generated_jobs,
    recurringJobs: source.recurring_jobs,
    jobsWithQuotedLabor: source.quote_generated_jobs_with_labor + source.recurring_jobs_with_labor,
    quoteGeneratedJobsWithLabor: source.quote_generated_jobs_with_labor,
    recurringJobsWithLabor: source.recurring_jobs_with_labor,
    quoteSourcedJobsMissingLabor: source.missing_labor_jobs,
    laborEfficiencyIncludedJobs: source.included_jobs,
    individualLaborEfficiencyJobs: source.individual_jobs,
    crewLaborEfficiencyJobs: source.crew_jobs,
  };
  for (const [field, value] of Object.entries(coverageExpected)) compare(row, `coverage.${field}`, value, mismatches);

  const servedLabor = laborEfficiencyServedTotals(row.values_json);
  compareValue(row, "laborEfficiency.quoteGenerated.quotedHours", servedLabor.quoteGenerated.quotedHours, source.quote_quoted_hours, mismatches);
  compareValue(row, "laborEfficiency.quoteGenerated.actualHours", servedLabor.quoteGenerated.actualHours, source.quote_actual_hours, mismatches);
  compareValue(row, "laborEfficiency.quoteGenerated.jobs", servedLabor.quoteGenerated.jobs, source.quote_jobs, mismatches);
  compareValue(row, "laborEfficiency.recurring.quotedHours", servedLabor.recurring.quotedHours, source.recurring_quoted_hours, mismatches);
  compareValue(row, "laborEfficiency.recurring.actualHours", servedLabor.recurring.actualHours, source.recurring_actual_hours, mismatches);
  compareValue(row, "laborEfficiency.recurring.jobs", servedLabor.recurring.jobs, source.recurring_included_jobs, mismatches);

  const expected = expectedCapacities(row, capacityRows);
  const servedByEmployee = new Map(array(row.values_json.technicians).flatMap((item) => {
    const technician = record(item);
    const id = String(technician?.employeeId ?? "");
    return id ? [[id, technician] as const] : [];
  }));
  let explicit = 0;
  let defaults = 0;
  let grossCapacity = 0;
  let adjustedCapacity = 0;
  for (const capacity of expected) {
    if (capacity.availabilitySource === "simpro") explicit += 1;
    else defaults += 1;
    grossCapacity += capacity.grossCapacityHours;
    adjustedCapacity += capacity.adjustedCapacityHours;
    const served = servedByEmployee.get(capacity.employeeId);
    if (!served) {
      mismatches.push({
        family: "technicians", periodStart: row.period_start, type: "missing_capacity_employee",
        employeeId: capacity.employeeId, availabilitySource: capacity.availabilitySource,
      });
    }
    for (const [field, value] of [
      ["grossCapacityHours", capacity.grossCapacityHours],
      ["adjustedCapacityHours", capacity.adjustedCapacityHours],
      ["eligibleWorkdays", capacity.eligibleWorkdays],
      ["holidayHours", capacity.holidayHours],
      ["sickPersonalHours", capacity.sickPersonalHours],
      ["ptoHours", capacity.ptoHours],
    ] as const) compareValue(row, `technicians.${capacity.employeeId}.${field}`, valueAt(served, field), value, mismatches);
    if (served?.availabilitySource !== capacity.availabilitySource || served?.dateOfHire !== capacity.dateOfHire || served?.archived !== capacity.archived) {
      mismatches.push({
        family: "technicians", periodStart: row.period_start, type: "capacity_input_parity", employeeId: capacity.employeeId,
        expected: { availabilitySource: capacity.availabilitySource, dateOfHire: capacity.dateOfHire, archived: capacity.archived },
        actual: { availabilitySource: served?.availabilitySource, dateOfHire: served?.dateOfHire, archived: served?.archived },
      });
    }
    const expectedAdjusted = Math.max(capacity.grossCapacityHours - capacity.holidayHours - capacity.sickPersonalHours - capacity.ptoHours, 0);
    if (!equalNumbers(capacity.adjustedCapacityHours, expectedAdjusted)) {
      mismatches.push({ family: "technicians", periodStart: row.period_start, type: "leave_subtraction", employeeId: capacity.employeeId, expectedAdjusted, capacity });
    }
  }
  compare(row, "coverage.grossCapacityHours", grossCapacity, mismatches);
  compare(row, "coverage.adjustedCapacityHours", adjustedCapacity, mismatches);
  compare(row, "coverage.holidayHours", capacityCoverage?.holiday_hours ?? 0, mismatches);
  compare(row, "coverage.sickPersonalHours", capacityCoverage?.sick_personal_hours ?? 0, mismatches);
  compare(row, "coverage.ptoHours", capacityCoverage?.pto_hours ?? 0, mismatches);
  const expectedEmployeeIds = new Set(expected.map((capacity) => capacity.employeeId));
  const servedEligible = expected.map((capacity) => servedByEmployee.get(capacity.employeeId));
  const servedExplicit = servedEligible.filter((item) => item?.availabilitySource === "simpro").length;
  const servedDefaults = servedEligible.filter((item) => item?.availabilitySource === "default").length;
  if (servedExplicit !== explicit || servedDefaults !== defaults) {
    mismatches.push({ family: "technicians", periodStart: row.period_start, type: "availability_source_counts", expected: { explicit, default: defaults }, actual: { explicit: servedExplicit, default: servedDefaults } });
  }
  for (const [employeeId, served] of servedByEmployee) {
    if (!served || expectedEmployeeIds.has(employeeId)) continue;
    if (["grossCapacityHours", "adjustedCapacityHours", "eligibleWorkdays", "unrecordedHours", "overCapacityHours"]
      .some((field) => !equalNumbers(numeric(served[field]), 0))) {
      mismatches.push({
        family: "technicians",
        periodStart: row.period_start,
        type: "unexpected_capacity_employee",
        employeeId,
      });
    }
  }

  const scheduled = numeric(coverage.scheduledVisits);
  const covered = numeric(coverage.arrivalCoveredVisits);
  const uncovered = numeric(coverage.uncoveredVisits);
  if (!equalNumbers(covered + uncovered, scheduled)) mismatches.push({ family: row.metric_family, periodStart: row.period_start, type: "visit_coverage_partition", scheduled, covered, uncovered });
  for (const item of array(row.values_json.technicians)) {
    const technician = record(item);
    if (!technician || !String(technician.displayName ?? "").trim()) {
      mismatches.push({ family: row.metric_family, periodStart: row.period_start, type: "missing_technician_name" });
      break;
    }
  }
}

export function validateTechnicianUtilization(
  row: ReadModelRow,
  sourceRows: TechnicianUtilizationSourceRow[],
  mismatches: ValidationMismatch[],
) {
  const coverage = record(row.values_json.coverage);
  if (!coverage) {
    mismatches.push({ family: "technicians", periodStart: row.period_start, type: "utilization_coverage_missing" });
    return;
  }

  const productiveHours = sumNumbers(sourceRows.map((source) => numeric(source.productive_supported_job_hours)));
  const allRecordedHours = sumNumbers(sourceRows.map((source) => numeric(source.all_positive_recorded_hours)));
  for (const field of ["productiveHours", "utilizationProductiveHours"] as const) {
    compareValue(row, `coverage.${field}`, coverage[field], productiveHours, mismatches);
  }
  for (const field of ["totalRecordedHours", "utilizationAllRecordedHours"] as const) {
    compareValue(row, `coverage.${field}`, coverage[field], allRecordedHours, mismatches);
  }

  // Per-employee promotion is gated on the effective technician roster:
  // mapped roster members must be served with matching utilization, while
  // mapped non-roster employees must never be promoted into the scorecard.
  const expectedByEmployee = new Map(
    sourceRows
      .filter((source) => source.person_mapped && source.roster_member)
      .map((source) => [source.employee_id, source] as const),
  );
  const servedByEmployee = new Map(array(row.values_json.technicians).flatMap((value) => {
    const technician = record(value);
    const employeeId = String(technician?.employeeId ?? "").trim();
    return technician && employeeId ? [[employeeId, technician] as const] : [];
  }));

  for (const source of sourceRows) {
    if (!source.person_mapped || source.roster_member) continue;
    if (servedByEmployee.has(source.employee_id)) {
      mismatches.push({
        family: "technicians",
        periodStart: row.period_start,
        type: "non_roster_employee_promoted",
        employeeId: source.employee_id,
      });
    }
  }

  for (const [employeeId, source] of expectedByEmployee) {
    if (!servedByEmployee.has(employeeId)) {
      mismatches.push({
        family: "technicians",
        periodStart: row.period_start,
        type: "missing_utilization_employee",
        employeeId,
      });
    }
    const numerator = numeric(source.productive_supported_job_hours);
    const denominator = numeric(source.all_positive_recorded_hours);
    const served = servedByEmployee.get(employeeId);
    compareValue(row, `technicians.${employeeId}.productiveHours`, served?.productiveHours, numerator, mismatches);
    compareValue(row, `technicians.${employeeId}.totalRecordedHours`, served?.totalRecordedHours, denominator, mismatches);
    compareValue(
      row,
      `technicians.${employeeId}.utilizationPercent`,
      served?.utilizationPercent,
      denominator > 0 ? numerator / denominator * 100 : null,
      mismatches,
    );
    const servedCoverage = record(served?.coverage);
    compareValue(
      row,
      `technicians.${employeeId}.coverage.utilizationProductiveHours`,
      servedCoverage?.utilizationProductiveHours,
      numerator,
      mismatches,
    );
    compareValue(
      row,
      `technicians.${employeeId}.coverage.utilizationAllRecordedHours`,
      servedCoverage?.utilizationAllRecordedHours,
      denominator,
      mismatches,
    );
  }

  for (const [employeeId, served] of servedByEmployee) {
    if (expectedByEmployee.has(employeeId)) continue;
    compareValue(row, `technicians.${employeeId}.productiveHours`, served.productiveHours, 0, mismatches);
    compareValue(row, `technicians.${employeeId}.totalRecordedHours`, served.totalRecordedHours, 0, mismatches);
    compareValue(row, `technicians.${employeeId}.utilizationPercent`, served.utilizationPercent, null, mismatches);
  }
}

export function validateCostCenterCategories(
  rows: CostCenterCategorySourceRow[],
  mismatches: ValidationMismatch[],
) {
  const byProject = new Map<string, CostCenterCategorySourceRow[]>();
  for (const row of rows) {
    const key = `${row.project_type}:${row.project_id}`;
    byProject.set(key, [...(byProject.get(key) ?? []), row]);
    if (row.cost_center_id === null) continue;
    const expected = independentCostCenterCategory(row.configured_cost_center_id);
    if (row.category !== expected) {
      mismatches.push({
        family: row.project_type === "job" ? "jobs" : "quotes",
        type: "cost_center_category_mapping",
        projectType: row.project_type,
        projectId: row.project_id,
        costCenterId: row.cost_center_id,
        configuredCostCenterId: row.configured_cost_center_id,
        expected,
        actual: row.category,
      });
    }
  }

  for (const [projectKey, projectRows] of byProject) {
    const contributions = projectRows.flatMap((row) => row.cost_center_id === null ? [] : [{
      category: independentCostCenterCategory(row.configured_cost_center_id),
      sellValue: numeric(row.sell_value),
    }]);
    const expected = dominantIndependentCategory(contributions);
    const actual = projectRows[0]?.parent_category ?? null;
    if (actual !== expected) {
      const [projectType, projectId] = projectKey.split(":");
      mismatches.push({
        family: projectType === "job" ? "jobs" : "quotes",
        type: "parent_category_projection",
        projectType,
        projectId,
        expected,
        actual,
      });
    }
  }
}

export function independentCostCenterCategory(value: string | number | null): "HVAC" | "Water Heating" | "Unclassified" {
  const id = nullableNumeric(value);
  if (id === 4 || id === 6 || id === 8) return "Water Heating";
  if (id === 5 || id === 7) return "HVAC";
  return "Unclassified";
}

function dominantIndependentCategory(
  contributions: Array<{ category: "HVAC" | "Water Heating" | "Unclassified"; sellValue: number }>,
) {
  const totals = new Map<string, number>();
  for (const contribution of contributions) {
    totals.set(contribution.category, (totals.get(contribution.category) ?? 0) + contribution.sellValue);
  }
  return [...totals]
    .sort(([leftCategory, leftValue], [rightCategory, rightValue]) => (
      rightValue - leftValue || leftCategory.localeCompare(rightCategory)
    ))[0]?.[0] ?? "Unclassified";
}

export function validateInvoiceRuntime(
  evidence: InvoiceRuntimeEvidence,
  mismatches: ValidationMismatch[],
) {
  for (const [field, value] of Object.entries(evidence)) {
    if (numeric(value) !== 0) {
      mismatches.push({ type: "active_invoice_runtime", field, count: numeric(value) });
    }
  }
}

export function validateNoInvoiceArApiDimensions(
  rows: Array<Pick<ReadModelRow, "metric_family" | "period_start" | "dimensions_json">>,
  mismatches: ValidationMismatch[],
) {
  for (const row of rows) {
    for (const path of forbiddenInvoiceArDimensionPaths(row.dimensions_json)) {
      mismatches.push({
        family: row.metric_family,
        periodStart: row.period_start,
        type: "forbidden_invoice_ar_api_dimension",
        path,
      });
    }
  }
}

export function validateProductionOwnerAuthorization(
  env: Readonly<Record<string, string | undefined>>,
  appRoles: AppRoleSourceRow[],
  mismatches: ValidationMismatch[],
) {
  if (env.METRICS_AUTH_MODE !== "easy-auth") {
    mismatches.push({ type: "production_auth_mode", expected: "easy-auth", actual: env.METRICS_AUTH_MODE ?? null });
  }
  for (const field of ["METRICS_ADMIN_EMAILS", "METRICS_FINANCE_EMAILS"] as const) {
    const actual = csvEmails(env[field]);
    if (!sameStringSet(actual, PRODUCTION_OWNER_EMAILS)) {
      mismatches.push({ type: "production_owner_environment", field, expected: PRODUCTION_OWNER_EMAILS, actual });
    }
  }
  for (const field of ["METRICS_OPERATOR_EMAILS", "METRICS_VIEWER_EMAILS"] as const) {
    const actual = csvEmails(env[field]);
    if (actual.length > 0) {
      mismatches.push({ type: "production_owner_environment", field, expected: [], actual });
    }
  }

  const appRoleOwners = uniqueSorted(appRoles.map((row) => normalizeEmail(row.email)));
  if (!sameStringSet(appRoleOwners, PRODUCTION_OWNER_EMAILS)) {
    mismatches.push({ type: "production_owner_app_roles", expected: PRODUCTION_OWNER_EMAILS, actual: appRoleOwners });
  }
  for (const owner of PRODUCTION_OWNER_EMAILS) {
    const roles = appRoles
      .filter((row) => normalizeEmail(row.email) === owner)
      .map((row) => row.role.trim().toLowerCase());
    if (!roles.some((role) => PRODUCTION_ACCESS_ROLES.has(role))) {
      mismatches.push({ type: "production_owner_app_role_access", owner, roles });
    }
  }
}

export function validateQuoteConversionEvidence(
  rows: QuoteSourceRow[],
  mismatches: ValidationMismatch[],
) {
  for (const row of rows) {
    if (row.direct_source_snapshot_id === null) {
      mismatches.push({ family: "quotes", type: "quote_direct_conversion_source_missing", quoteId: row.quote_id });
    }
    const direct = actualDirectConversionId(row);
    if (direct.error) {
      mismatches.push({ family: "quotes", type: direct.error, quoteId: row.quote_id });
    }
    if (row.relationship_provenance_error) {
      mismatches.push({
        family: "quotes",
        type: "invalid_quote_relationship_provenance",
        quoteId: row.quote_id,
        detail: row.relationship_provenance_error,
      });
    }
    if (direct.error === null && row.canonical_linked_job_id !== undefined
      && normalizedNullableId(row.canonical_linked_job_id) !== direct.id) {
      mismatches.push({
        family: "quotes",
        type: "canonical_direct_relationship_drift",
        quoteId: row.quote_id,
        expected: direct.id,
        actual: row.canonical_linked_job_id,
      });
    }
    if (direct.error === null && row.snapshot_linked_job_id !== undefined
      && normalizedNullableId(row.snapshot_linked_job_id) !== direct.id) {
      mismatches.push({
        family: "quotes",
        type: "snapshot_direct_relationship_drift",
        quoteId: row.quote_id,
        expected: direct.id,
        actual: row.snapshot_linked_job_id,
      });
    }
    if (row.expected_inverse_job_ids !== undefined
      && !sameStringSet(row.expected_inverse_job_ids, row.canonical_inverse_job_ids ?? [])) {
      mismatches.push({
        family: "quotes",
        type: "canonical_inverse_relationship_drift",
        quoteId: row.quote_id,
        expected: sortedUnique(row.expected_inverse_job_ids),
        actual: sortedUnique(row.canonical_inverse_job_ids ?? []),
      });
    }
    if (row.expected_inverse_job_ids !== undefined
      && !sameStringSet(row.expected_inverse_job_ids, row.snapshot_inverse_job_ids ?? [])) {
      mismatches.push({
        family: "quotes",
        type: "snapshot_inverse_relationship_drift",
        quoteId: row.quote_id,
        expected: sortedUnique(row.expected_inverse_job_ids),
        actual: sortedUnique(row.snapshot_inverse_job_ids ?? []),
      });
    }
    if (row.inverse_conversion_job_id !== null && positiveIntegerString(row.inverse_conversion_job_id) === null) {
      mismatches.push({ family: "quotes", type: "invalid_inverse_conversion_id", quoteId: row.quote_id });
    }
    if (row.direct_conversion_job_id !== null && positiveIntegerString(row.direct_conversion_job_id) === null) {
      mismatches.push({ family: "quotes", type: "invalid_direct_conversion_match_id", quoteId: row.quote_id });
    }
  }
}

export function validateCommissions(
  row: ReadModelRow,
  run: CommissionRun | undefined,
  mismatches: ValidationMismatch[],
) {
  if (!run) {
    mismatches.push({ family: row.metric_family, periodStart: row.period_start, type: "missing_current_run" });
    return;
  }
  compare(row, "completedJobs", run.completed_jobs, mismatches, "run.completedJobs");
  compare(row, "totalWorkValue", run.total_work_value, mismatches, "run.totalWorkValue");
  compare(row, "poolAmount", run.pool_amount, mismatches, "run.poolAmount");
  compare(row, "insidePoolTotal", run.inside_pool_total, mismatches, "run.insidePoolTotal");
  compare(row, "outsidePoolTotal", run.outside_pool_total, mismatches, "run.outsidePoolTotal");
  compare(row, "payrollTotal", run.payroll_total, mismatches, "run.payrollTotal");
  if (!run.source_complete || run.source_status !== "complete") mismatches.push({ family: row.metric_family, periodStart: row.period_start, type: "incomplete_run_evidence", run });
  const served = record(row.values_json.invariants);
  const persisted = record(run.invariants_json);
  const recomputed = recomputeCommissionInvariants(run);
  for (const invariant of COMMISSION_INVARIANTS) {
    if (recomputed[invariant] !== true || served?.[invariant] !== recomputed[invariant] || persisted?.[invariant] !== recomputed[invariant]) {
      mismatches.push({
        family: row.metric_family, periodStart: row.period_start, type: "commission_invariant_failure",
        invariant, recomputed: recomputed[invariant], served: served?.[invariant] ?? null, persisted: persisted?.[invariant] ?? null,
      });
    }
  }
}

export function recomputeCommissionInvariants(run: Pick<CommissionRun,
  "pool_amount" | "inputs" | "employee_results" | "job_allocations"
>) {
  const poolCents = cents(run.pool_amount);
  const finalBonusCents = sumNumbers(run.employee_results.map((employee) => cents(employee.final_bonus)));
  const outsidePoolCents = sumNumbers(run.employee_results.map((employee) => cents(employee.outside_pool_adjustment)));
  const payrollCents = sumNumbers(run.employee_results.map((employee) => cents(employee.payroll_bonus)));
  const forfeitedCents = sumNumbers(run.employee_results.map((employee) => cents(employee.forfeited_bonus)));
  const reallocatedCents = sumNumbers(run.employee_results.map((employee) => cents(employee.reallocation_received)));
  const efficiencyEffectCents = sumNumbers(run.employee_results.map((employee) => cents(record(employee.efficiency_json)?.effect)));

  const jobInputs = run.inputs.filter((input) => input.input_type === "job");
  const timesheetsByJob = new Map<string, CommissionInputRow[]>();
  for (const input of run.inputs.filter((candidate) => candidate.input_type === "timesheet")) {
    const jobId = String(input.input_json.jobId ?? "");
    if (jobId) timesheetsByJob.set(jobId, [...(timesheetsByJob.get(jobId) ?? []), input]);
  }
  const allocationsByJob = new Map<string, CommissionJobAllocation[]>();
  for (const allocation of run.job_allocations) {
    allocationsByJob.set(allocation.job_id, [...(allocationsByJob.get(allocation.job_id) ?? []), allocation]);
  }
  const supportedJobs = new Map<string, number>();
  const unsupportedJobs = new Set<string>();
  for (const input of jobInputs) {
    const jobId = String(input.input_json.jobId ?? input.source_identity);
    const sellValue = numeric(input.input_json.sellValue);
    const mappedFieldHours = (timesheetsByJob.get(jobId) ?? []).reduce((total, timesheet) => {
      const value = timesheet.input_json;
      const employeeId = String(value.employeeId ?? "").trim();
      return total + (employeeId && value.mapped !== false && value.fieldTechnician !== false && numeric(value.hours) > 0 ? numeric(value.hours) : 0);
    }, 0);
    if (sellValue > 0 && mappedFieldHours > 0) supportedJobs.set(jobId, cents(sellValue));
    else unsupportedJobs.add(jobId);
  }

  const jobAllocationsReconcile = [...supportedJobs].every(([jobId, jobTotalCents]) => {
    const allocations = allocationsByJob.get(jobId) ?? [];
    return allocations.length > 0
      && sumNumbers(allocations.map((allocation) => cents(allocation.allocated_value))) === jobTotalCents
      && allocations.every((allocation) => cents(allocation.job_total) === jobTotalCents);
  });
  const unsupportedJobsUnallocated = [...unsupportedJobs].every((jobId) => !(allocationsByJob.get(jobId)?.length));

  return {
    insidePoolReconciles: finalBonusCents === poolCents,
    outsidePoolReconciles: payrollCents === poolCents + outsidePoolCents,
    jobAllocationsReconcile,
    unsupportedJobsUnallocated,
    forfeitureReconciles: forfeitedCents === reallocatedCents,
    efficiencyReconciles: efficiencyEffectCents === 0,
    nonnegativePayroll: run.employee_results.every((employee) => cents(employee.payroll_bonus) >= 0),
  } satisfies Record<(typeof COMMISSION_INVARIANTS)[number], boolean>;
}

export function validatePayloadSourceHash(row: ReadModelRow, mismatches: ValidationMismatch[]) {
  const recomputed = readModelSourceHash(row.values_json);
  if (row.source_hash !== recomputed) {
    mismatches.push({
      family: row.metric_family,
      periodStart: row.period_start,
      type: "payload_source_hash",
      expected: recomputed,
      actual: row.source_hash,
    });
  }
}

function compare(row: ReadModelRow, field: string, expected: string | number, mismatches: ValidationMismatch[], label = field) {
  compareValue(row, label, numberAt(row.values_json, field), expected, mismatches);
}

function compareValue(row: ReadModelRow, field: string, actual: unknown, expected: unknown, mismatches: ValidationMismatch[]) {
  const actualNumber = nullableNumeric(actual);
  const expectedNumber = nullableNumeric(expected);
  if (actualNumber === null || expectedNumber === null ? actualNumber !== expectedNumber : !equalNumbers(actualNumber, expectedNumber)) {
    mismatches.push({ family: row.metric_family, periodStart: row.period_start, type: "value", field, expected: expectedNumber, actual: actualNumber });
  }
}

function addLaborSummary(target: { quotedHours: number; actualHours: number; jobs: number }, source: Record<string, unknown> | null) {
  target.quotedHours += numeric(source?.quotedHours);
  target.actualHours += numeric(source?.actualHours);
  target.jobs += numeric(source?.jobs);
}

function numberAt(root: Record<string, unknown>, path: string) {
  let value: unknown = root;
  for (const part of path.split(".")) value = record(value)?.[part];
  return value;
}

function valueAt(root: Record<string, unknown> | null | undefined, field: string) {
  return root?.[field];
}

function nullableNumeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numeric(value: unknown) {
  return nullableNumeric(value) ?? 0;
}

function percentOrNull(numerator: unknown, denominator: unknown) {
  const divisor = numeric(denominator);
  return divisor > 0 ? numeric(numerator) / divisor * 100 : null;
}

function cents(value: unknown) {
  return Math.round(numeric(value) * 100);
}

function sumNumbers(values: Iterable<number>) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function equalNumbers(left: number, right: number) {
  return Math.abs(left - right) < 0.005;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rowMap<T extends { period_start: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.period_start, row]));
}

function groupedMap<T extends { period_start: string }>(rows: T[]) {
  const result = new Map<string, T[]>();
  for (const row of rows) result.set(row.period_start, [...(result.get(row.period_start) ?? []), row]);
  return result;
}

function contractCheck(mismatches: ValidationMismatch[], evidence: unknown) {
  return {
    status: mismatches.length === 0 ? "matched" : "mismatch",
    mismatchCount: mismatches.length,
    evidence,
  };
}

export function productionEnvironmentOwnerEmails(env: Readonly<Record<string, string | undefined>>) {
  return uniqueSorted([
    ...csvEmails(env.METRICS_ADMIN_EMAILS),
    ...csvEmails(env.METRICS_FINANCE_EMAILS),
    ...csvEmails(env.METRICS_OPERATOR_EMAILS),
    ...csvEmails(env.METRICS_VIEWER_EMAILS),
  ]);
}

function csvEmails(value: string | undefined) {
  return uniqueSorted((value ?? "").split(",").map(normalizeEmail).filter(Boolean));
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function sameStringSet(actual: readonly string[], expected: readonly string[]) {
  return JSON.stringify(uniqueSorted(actual)) === JSON.stringify(uniqueSorted(expected));
}

function sourceSummary<T>(rows: Map<string, T>, currentMonth: string) {
  return { months: rows.size, currentMonth: rows.get(currentMonth) ?? null };
}

function summarizeCapacities(capacities: ReturnType<typeof expectedCapacities>) {
  return capacities.reduce((summary, capacity) => ({
    technicians: summary.technicians + 1,
    explicitAvailability: summary.explicitAvailability + (capacity.availabilitySource === "simpro" ? 1 : 0),
    defaultAvailability: summary.defaultAvailability + (capacity.availabilitySource === "default" ? 1 : 0),
    grossCapacityHours: summary.grossCapacityHours + capacity.grossCapacityHours,
    leaveHours: summary.leaveHours + capacity.holidayHours + capacity.sickPersonalHours + capacity.ptoHours,
    adjustedCapacityHours: summary.adjustedCapacityHours + capacity.adjustedCapacityHours,
  }), { technicians: 0, explicitAvailability: 0, defaultAvailability: 0, grossCapacityHours: 0, leaveHours: 0, adjustedCapacityHours: 0 });
}

function monthStarts(start: string, through: string) {
  const values: string[] = [];
  for (let value = start; value <= through; value = addMonth(value)) values.push(value);
  return values;
}

function addMonth(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

function endOfMonth(periodStart: string) {
  const next = addMonth(periodStart);
  const date = new Date(`${next}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function currentPacificMonth() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-01`;
}

function emptyQuoteSource(periodStart: string): QuoteSourceAggregate {
  const tier = (): QuoteTierAggregate => ({ quoteCount: 0, quoteValue: 0, acceptedCount: 0, acceptedValue: 0, notAcceptedCount: 0, notAcceptedValue: 0 });
  return {
    period_start: periodStart, source_records: 0, quote_count: 0, quote_value: 0,
    accepted_count: 0, accepted_value: 0, not_accepted_count: 0, not_accepted_value: 0,
    excluded_count: 0, acceptance_rate_by_count: 0, acceptance_rate_by_value: 0,
    average_accepted_deal: 0, override_count: 0, excluded_without_date_approved: 0,
    tiers: Object.fromEntries(QUOTE_TIERS.map((name) => [name, tier()])) as Record<QuoteTier, QuoteTierAggregate>,
    acceptance_paths: { accepted_online_and_converted: 0, accepted_online_only: 0, converted_only: 0, not_accepted: 0, excluded: 0 },
    acceptance_path_values: { accepted_online_and_converted: 0, accepted_online_only: 0, converted_only: 0, not_accepted: 0, excluded: 0 },
    quotes: [],
  };
}

function emptyJobSource(periodStart: string): JobSourceAggregate {
  return {
    period_start: periodStart, completed_jobs: 0, total_sell_value: 0, gross_profit_actual: 0,
    gross_margin_included_jobs: 0, gross_margin_covered_sell_value: 0, gross_margin_covered_profit: 0,
    net_profit_actual: 0, net_margin_included_jobs: 0, net_margin_covered_sell_value: 0, net_margin_covered_profit: 0,
    materials_actual: 0, labor_actual: 0, overhead_actual: 0, commission_actual: 0,
    materials_paired_actual: 0, materials_paired_estimate: 0, materials_paired_jobs: 0,
    labor_paired_actual: 0, labor_paired_estimate: 0, labor_paired_jobs: 0,
    overhead_paired_actual: 0, overhead_paired_estimate: 0, overhead_paired_jobs: 0,
    total_paired_actual: 0, total_paired_estimate: 0, total_paired_jobs: 0,
    sell_value_supported: 0, gross_profit_supported: 0, net_profit_supported: 0, cost_totals_supported: 0, field_support: {},
  };
}

function emptyLaborSource(periodStart: string): LaborEfficiencySourceAggregate {
  return {
    period_start: periodStart, total_jobs: 0, jobs_with_timesheets: 0, quote_generated_jobs: 0, recurring_jobs: 0,
    quote_generated_jobs_with_labor: 0, recurring_jobs_with_labor: 0, missing_labor_jobs: 0, included_jobs: 0,
    individual_jobs: 0, crew_jobs: 0, quote_quoted_hours: 0, quote_actual_hours: 0, quote_jobs: 0,
    recurring_quoted_hours: 0, recurring_actual_hours: 0, recurring_included_jobs: 0,
  };
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

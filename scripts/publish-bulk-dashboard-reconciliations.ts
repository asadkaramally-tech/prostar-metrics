import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { BACKFILL_START_MONTH, businessCurrentMonth } from "@/lib/backfill/plan";
import { isCompletedJobStage } from "@/lib/metrics/jobs";
import { flattenBulkProjectPage } from "@/lib/simpro/bulk-project-export";
import { sourceHash as payloadSourceHash } from "@/lib/simpro/client";
import {
  publishBulkDashboardReconciliations,
  type BulkDashboardReconciliationScope,
  type BulkDashboardReconciliationUnit,
} from "@/lib/store/bulk-dashboard-reconciliation";
import { compareExactSourceIds, exactSourceIdHash } from "@/lib/store/exact-source-identities";
import { verifyBulkArtifact } from "@/lib/store/bulk-project-bootstrap";
import { verifyOperationalBulkArtifact } from "@/lib/store/bulk-operational-bootstrap";
import { buildPostgresSslConfig } from "@/lib/store/postgres";
import type { ReconciliationProjectRow as ProjectRow } from "@/lib/store/project-reconciliation-deltas";
import type { BulkBootstrapEvidenceUnit } from "@/lib/store/bulk-bootstrap-evidence";
import {
  buildEvidenceUnits,
  BULK_EVIDENCE_FAMILIES,
} from "./publish-bulk-bootstrap-evidence";


type Summary = { ids: string[]; count: number; total: number };

type DashboardRow = {
  metric_family: BulkDashboardReconciliationScope;
  period_grain: "month";
  period_start: string;
  dimensions_json: Record<string, unknown>;
  values_json: Record<string, unknown>;
  source_hash: string | null;
  rebuilt_at: string;
  rebuilt_by_job_id: string | null;
};

type SourcePeriodRow = {
  source_family: string;
  period_start: string;
  coverage_status: string;
  reconciliation_status: string;
  source_id_hash: string | null;
  normalized_id_hash: string | null;
  source_value: unknown;
  normalized_value: unknown;
  evidence_json: Record<string, unknown>;
};

type ReconciliationQueryClient = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

const REQUIRED_EVIDENCE: Record<BulkDashboardReconciliationScope, string[]> = {
  jobs: ["jobs", "job_nested"],
  quotes: ["quotes", "quote_nested"],
  technicians: ["jobs", "job_nested", "employees", "timesheets", "jobs_from_timesheets", "schedules", "mobile_status"],
};
const REQUIRED_EVIDENCE_FAMILIES = [...new Set(Object.values(REQUIRED_EVIDENCE).flat())];

async function main() {
  const projectDirectory = path.resolve(
    argumentValue("--project-input") ?? path.join(".work", "simpro-bulk-export-20260710"),
  );
  const operationalDirectory = path.resolve(
    argumentValue("--operational-input") ?? path.join(".work", "simpro-operational-export-20260710"),
  );
  const [project, operational] = await Promise.all([
    verifyBulkArtifact(projectDirectory),
    verifyOperationalBulkArtifact(operationalDirectory),
  ]);
  const artifactSource = readProjectSource(project);
  const expectedEvidence = new Map(
    (await buildEvidenceUnits(project, operational, [...BULK_EVIDENCE_FAMILIES]))
      .map((unit) => [`${unit.sourceFamily}:${unit.periodStart}`, unit] as const),
  );
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString) throw new Error("AZURE_POSTGRES_CONNECTION_STRING is required");

  const client = new pg.Client({ connectionString, ssl: buildPostgresSslConfig() });
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query("begin isolation level serializable");
    transactionOpen = true;
    const verifiedDeltas = await readVerifiedProjectDeltas(client, project.manifest.completedAt);
    const sourceJobRows = applyVerifiedDeltas(artifactSource.jobs, verifiedDeltas.jobs);
    const sourceQuoteRows = applyVerifiedDeltas(artifactSource.quotes, verifiedDeltas.quotes);
    const throughMonth = argumentValue("--through") ?? businessCurrentMonth();
    const months = monthStarts(BACKFILL_START_MONTH, throughMonth);
    const evidence = await readEvidence(client, throughMonth);
    const currentJobIds = sourceJobRows.map((row) => row.id);
    const canonicalJobRows = await readCanonicalJobs(client, currentJobIds);
    const jobSnapshotRows = await readJobSnapshots(client, currentJobIds);
    const canonicalQuoteRows = await readCanonicalQuotes(client);
    const quoteSnapshotRows = await readQuoteSnapshots(client);
    await lockTechnicianSourceRows(client, throughMonth);
    const technicianStore = await readTechnicianStore(client, throughMonth);
    const dashboards = await readDashboards(client, throughMonth);
    const sourceJobs = group(sourceJobRows);
    const sourceQuotes = group(sourceQuoteRows);
    const canonicalJobs = group(canonicalJobRows);
    const jobSnapshots = group(jobSnapshotRows);
    const canonicalQuotes = group(canonicalQuoteRows);
    const quoteSnapshots = group(quoteSnapshotRows);
    const mismatches: Array<Record<string, unknown>> = [];
    const units: BulkDashboardReconciliationUnit[] = [];

    const through = (rows: ProjectRow[]) => rows.filter((row) => row.periodStart && row.periodStart <= throughMonth);
    mismatches.push(...compareExactProjectRows("jobs", through(sourceJobRows), through(canonicalJobRows), through(jobSnapshotRows)));
    mismatches.push(...compareExactProjectRows("quotes", through(sourceQuoteRows), through(canonicalQuoteRows), through(quoteSnapshotRows)));
    mismatches.push(...unverifiedPostArtifactRows(
      "jobs",
      through(canonicalJobRows),
      verifiedDeltas.jobs,
      project.manifest.completedAt,
    ));
    mismatches.push(...unverifiedPostArtifactRows(
      "quotes",
      through(canonicalQuoteRows),
      verifiedDeltas.quotes,
      project.manifest.completedAt,
    ));

    for (const month of months) {
      const periodEnd = inclusiveMonthEnd(month);
      const sourceJobsSummary = summary(sourceJobs.get(month) ?? []);
      const jobs = summary(canonicalJobs.get(month) ?? []);
      const jobSnapshot = summary(jobSnapshots.get(month) ?? []);
      const jobsDashboard = requiredDashboardRow(dashboards.get(`jobs:${month}`), "jobs", month);
      const jobsDashboardSummary = {
        count: requiredFiniteNumber(jobsDashboard.values_json.completedJobCount, "jobs", month, "completedJobCount"),
        total: requiredFiniteNumber(jobsDashboard.values_json.totalSellValue, "jobs", month, "totalSellValue"),
      };
      compareSummary("jobs_source_canonical", month, sourceJobsSummary, jobs, mismatches);
      compareSummary("jobs_snapshot_canonical", month, jobSnapshot, jobs, mismatches);
      compareValueSummary("jobs_dashboard_canonical", month, jobsDashboardSummary, jobs, mismatches);
      const jobsEvidence = requireEvidence("jobs", month, evidence, expectedEvidence, mismatches);
      units.push(unit({
        scope: "jobs",
        month,
        periodEnd,
        rollupValue: jobsDashboardSummary.total,
        snapshotValue: jobs.total,
        upstreamSampleValue: sourceJobsSummary.total,
        projectManifestSha256: project.manifestSha256,
        operationalManifestSha256: operational.manifestSha256,
        source: sourceJobsSummary,
        canonical: jobs,
        dashboard: jobsDashboardSummary,
        readModel: jobsDashboard,
        evidence: jobsEvidence,
        extra: { verifiedPostArtifactDeltas: verifiedDeltas.evidence.jobs },
      }));

      const sourceQuotesSummary = summary(sourceQuotes.get(month) ?? []);
      const quotes = summary(canonicalQuotes.get(month) ?? []);
      const quoteSnapshot = summary(quoteSnapshots.get(month) ?? []);
      const classifiedQuotes = summary((canonicalQuotes.get(month) ?? []).filter((row) => row.outcome !== "excluded"));
      const quoteDashboard = requiredDashboardRow(dashboards.get(`quotes:${month}`), "quotes", month);
      const quoteDashboardSummary = {
        count: requiredFiniteNumber(quoteDashboard.values_json.quoteCount, "quotes", month, "quoteCount"),
        total: requiredFiniteNumber(quoteDashboard.values_json.quoteValue, "quotes", month, "quoteValue"),
      };
      compareSummary("quotes_source_canonical", month, sourceQuotesSummary, quotes, mismatches);
      compareSummary("quotes_snapshot_canonical", month, quoteSnapshot, quotes, mismatches);
      compareValueSummary("quotes_dashboard_classified_canonical", month, quoteDashboardSummary, classifiedQuotes, mismatches);
      const quoteEvidence = requireEvidence("quotes", month, evidence, expectedEvidence, mismatches);
      units.push(unit({
        scope: "quotes",
        month,
        periodEnd,
        rollupValue: quoteDashboardSummary.total,
        snapshotValue: classifiedQuotes.total,
        upstreamSampleValue: sourceQuotesSummary.total,
        projectManifestSha256: project.manifestSha256,
        operationalManifestSha256: operational.manifestSha256,
        source: sourceQuotesSummary,
        canonical: classifiedQuotes,
        dashboard: quoteDashboardSummary,
        readModel: quoteDashboard,
        evidence: quoteEvidence,
        extra: {
          verifiedPostArtifactDeltas: verifiedDeltas.evidence.quotes,
          upstreamApprovedQuotes: quotes,
          excludedOutcomeCount: quotes.count - classifiedQuotes.count,
          excludedOutcomeValue: money(quotes.total - classifiedQuotes.total),
        },
      }));

      const technicianCanonical = technicianStore.get(month);
      if (!technicianCanonical) throw new Error(`technicians/${month}/canonical aggregate row is absent.`);
      const technicianDashboard = requiredDashboardRow(dashboards.get(`technicians:${month}`), "technicians", month);
      const coverage = requiredRecord(technicianDashboard.values_json.coverage, "technicians", month, "coverage");
      const technicians = requiredRecordArray(
        technicianDashboard.values_json.technicians,
        "technicians",
        month,
        "technicians",
      );
      const outsideRoster = requiredRecordArray(
        technicianDashboard.values_json.outsideRoster,
        "technicians",
        month,
        "outsideRoster",
      );
      const allTechnicians = [...technicians, ...outsideRoster];
      const technicianDashboardSummary = {
        totalJobs: requiredFiniteNumber(coverage.totalJobs, "technicians", month, "coverage.totalJobs"),
        jobsWithTimesheets: requiredFiniteNumber(coverage.jobsWithTimesheets, "technicians", month, "coverage.jobsWithTimesheets"),
        allocatedSellValue: money(allTechnicians.reduce((sum, row, index) => (
          sum + requiredFiniteNumber(row.allocatedSellValue, "technicians", month, `technicians[${index}].allocatedSellValue`)
        ), 0)),
        actualJobHours: money(allTechnicians.reduce((sum, row, index) => (
          sum + requiredFiniteNumber(row.actualJobHours, "technicians", month, `technicians[${index}].actualJobHours`)
        ), 0)),
      };
      compareTechnicians(month, technicianDashboardSummary, technicianCanonical, mismatches);
      const technicianEvidence = requireEvidence("technicians", month, evidence, expectedEvidence, mismatches);
      units.push(unit({
        scope: "technicians",
        month,
        periodEnd,
        rollupValue: technicianDashboardSummary.allocatedSellValue,
        snapshotValue: technicianCanonical.allocatedSellValue,
        upstreamSampleValue: null,
        projectManifestSha256: project.manifestSha256,
        operationalManifestSha256: operational.manifestSha256,
        source: sourceJobsSummary,
        canonical: technicianCanonical,
        dashboard: technicianDashboardSummary,
        readModel: technicianDashboard,
        evidence: technicianEvidence,
        extra: { verifiedPostArtifactDeltas: verifiedDeltas.evidence.jobs },
      }));
    }

    if (mismatches.length > 0) {
      await client.query("rollback");
      transactionOpen = false;
      console.log(JSON.stringify({
        status: "mismatch",
        projectManifestSha256: project.manifestSha256,
        projectFinancialCoverage: project.financialCoverage,
        operationalManifestSha256: operational.manifestSha256,
        mismatchCount: mismatches.length,
        mismatches: mismatches.slice(0, 100),
      }, null, 2));
      process.exitCode = 1;
      return;
    }

    const summaryResult = {
      status: "matched",
      mode: process.argv.includes("--execute") ? "execute" : "verified-dry-run",
      projectManifestSha256: project.manifestSha256,
      projectFinancialCoverage: project.financialCoverage,
      operationalManifestSha256: operational.manifestSha256,
      months: months.length,
      reconciliationChecks: units.length,
    };
    if (!process.argv.includes("--execute")) {
      await client.query("rollback");
      transactionOpen = false;
      console.log(JSON.stringify(summaryResult, null, 2));
      return;
    }
    const publication = await publishBulkDashboardReconciliations(units, client, { transaction: "existing" });
    await client.query("commit");
    transactionOpen = false;
    console.log(JSON.stringify({ ...summaryResult, publication }, null, 2));
  } catch (error) {
    if (transactionOpen) await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export async function readVerifiedProjectDeltas(client: ReconciliationQueryClient, completedAt: string) {
  const read = async (family: "jobs" | "quotes") => {
    const entityType = family === "jobs" ? "job_details" : "quote_details";
    const table = family === "jobs" ? "metrics.metrics_jobs" : "metrics.metrics_quotes";
    const idColumn = family === "jobs" ? "job_id" : "quote_id";
    const rows = await client.query<{
      id: string;
      snapshot_entity_id: string;
      payload: Record<string, unknown>;
      snapshot_source_hash: string;
      canonical_source_hash: string | null;
      extracted_at: string;
    }>(
      `select canonical.${idColumn}::text id, snapshot.entity_id snapshot_entity_id,
              snapshot.payload, snapshot.source_hash snapshot_source_hash,
              canonical.source_hash canonical_source_hash,
              snapshot.extracted_at::text
         from ${table} canonical
         join metrics.raw_simpro_snapshots snapshot
           on snapshot.id = canonical.source_snapshot_id
        where snapshot.entity_type = $1
          and snapshot.extracted_at > $2::timestamptz
        order by canonical.${idColumn}
        for share of canonical, snapshot`,
      [entityType, completedAt],
    );
    const deltas = rows.rows.map((row) => {
      const payloadId = requiredPositiveId(row.payload.ID, `${family} raw delta payload ID`);
      const calculatedSourceHash = payloadSourceHash(row.payload);
      if (row.id !== row.snapshot_entity_id || row.id !== String(payloadId)) {
        throw new Error(
          `${family} verified raw delta identity mismatch: canonical ID=${row.id}, `
          + `snapshot.entity_id=${row.snapshot_entity_id}, payload ID=${payloadId}`,
        );
      }
      if (
        !row.canonical_source_hash
        || row.canonical_source_hash !== row.snapshot_source_hash
        || row.snapshot_source_hash !== calculatedSourceHash
      ) {
        throw new Error(
          `${family} verified raw delta source-hash mismatch for ID ${row.id}: `
          + `canonical=${row.canonical_source_hash ?? "missing"}, snapshot=${row.snapshot_source_hash}, payload=${calculatedSourceHash}`,
        );
      }
      const project = flattenBulkProjectPage(family === "jobs" ? "job" : "quote", [row.payload], row.extracted_at).projects[0]!;
      const date = family === "jobs" ? project.completedDate : project.dateIssued;
      const included = Boolean(date && (family === "quotes" || isCompletedJobStage(project.stageName)));
      return {
        id: row.id,
        periodStart: included ? `${date!.slice(0, 7)}-01` : null,
        total: project.totalExTax,
        fetchedAt: row.extracted_at,
        sourceHash: row.snapshot_source_hash,
      } satisfies ProjectRow & { sourceHash: string };
    });
    return {
      deltas,
      evidence: deltas.map((row) => ({
        id: row.id,
        periodStart: row.periodStart,
        sourceHash: row.sourceHash,
        extractedAt: row.fetchedAt,
      })),
    };
  };
  const [jobs, quotes] = await Promise.all([read("jobs"), read("quotes")]);
  return {
    jobs: jobs.deltas,
    quotes: quotes.deltas,
    evidence: { jobs: jobs.evidence, quotes: quotes.evidence },
  };
}

export function readProjectSource(artifact: Awaited<ReturnType<typeof verifyBulkArtifact>>) {
  const jobs: ProjectRow[] = [];
  const quotes: ProjectRow[] = [];
  for (const source of Object.values(artifact.sources)) {
    for (const payload of source.rows) {
      const row = flattenBulkProjectPage(source.family === "jobs" ? "job" : "quote", [payload], artifact.manifest.completedAt).projects[0]!;
      const date = source.family === "jobs" ? row.completedDate : row.dateIssued;
      const included = Boolean(date && (source.family === "quotes" || isCompletedJobStage(row.stageName)));
      const periodStart = included ? `${date!.slice(0, 7)}-01` : null;
      const target = source.family === "jobs" ? jobs : quotes;
      target.push({ id: String(row.projectId), periodStart, total: row.totalExTax });
    }
  }
  return { jobs, quotes };
}

async function readCanonicalJobs(client: ReconciliationQueryClient, expectedIds: readonly string[]) {
  const result = await client.query<{
    id: string; period_start: string | null; stage: string | null; total: string | null; fetched_at: string | null;
  }>(`
    select job_id::text id, to_char(completed_date, 'YYYY-MM-01') period_start,
           stage, total::text total, fetched_at::text
      from metrics.metrics_jobs
     where source_deleted_at is null
       and (completed_date >= date '2023-01-01' or job_id = any($1::bigint[]))
     order by job_id
     for share
  `, [expectedIds]);
  return result.rows.map((row) => ({
    id: row.id,
    periodStart: row.period_start && isCompletedJobStage(row.stage) ? row.period_start : null,
    total: requiredFiniteNumber(row.total, "jobs", row.period_start ?? "undated", `canonical ID ${row.id} total`),
    fetchedAt: row.fetched_at,
  }));
}

async function readJobSnapshots(client: ReconciliationQueryClient, expectedIds: readonly string[]) {
  const result = await client.query<{ id: string; period_start: string | null; stage: string | null; total: string | null }>(`
    select job_id::text id, to_char(completed_date, 'YYYY-MM-01') period_start,
           stage_name stage, sell_value::text total
      from metrics.job_snapshots
     where completed_date >= date '2023-01-01' or job_id = any($1::bigint[])
     order by job_id
     for share
  `, [expectedIds]);
  return result.rows.map((row) => ({
    id: row.id,
    periodStart: row.period_start && isCompletedJobStage(row.stage) ? row.period_start : null,
    total: requiredFiniteNumber(row.total, "jobs", row.period_start ?? "undated", `snapshot ID ${row.id} total`),
  }));
}

async function readCanonicalQuotes(client: ReconciliationQueryClient) {
  const result = await client.query<{
    id: string; period_start: string | null; total: string | null; outcome: string | null; fetched_at: string | null;
  }>(`
    select quote_id::text id, to_char(date_issued, 'YYYY-MM-01') period_start,
           total::text total, outcome, fetched_at::text
      from metrics.metrics_quotes
     where source_deleted_at is null
     order by quote_id
     for share
  `);
  return result.rows.map((row) => ({
    id: row.id,
    periodStart: row.period_start,
    total: requiredFiniteNumber(row.total, "quotes", row.period_start ?? "undated", `canonical ID ${row.id} total`),
    outcome: row.outcome,
    fetchedAt: row.fetched_at,
  }));
}

async function readQuoteSnapshots(client: ReconciliationQueryClient) {
  const result = await client.query<{ id: string; period_start: string | null; total: string | null }>(`
    select quote_id::text id, to_char(date_issued, 'YYYY-MM-01') period_start,
           total_value::text total
     from metrics.quote_snapshots
     order by quote_id
     for share
  `);
  return result.rows.map((row) => ({
    id: row.id,
    periodStart: row.period_start,
    total: requiredFiniteNumber(row.total, "quotes", row.period_start ?? "undated", `snapshot ID ${row.id} total`),
  }));
}

async function readTechnicianStore(client: ReconciliationQueryClient, throughMonth: string) {
  const result = await client.query<{
    period_start: string;
    total_jobs: string;
    jobs_with_timesheets: string;
    allocated_sell_value: string;
    actual_job_hours: string;
  }>(`
    with periods as (
      select generate_series($1::date, $2::date, interval '1 month')::date period_start
    ), completed_jobs as (
      select j.job_id, j.completed_date, j.total
        from metrics.metrics_jobs j
       where j.completed_date >= date '2023-01-01'
         and lower(trim(j.stage)) in ('complete', 'archived')
         and j.source_deleted_at is null
    ), mapped_job_hours as (
      select t.reference_id job_id, sum(t.total_hours) hours
        from metrics.metrics_employee_timesheets t
        join metrics.dim_people p on p.simpro_employee_id = t.employee_id
       where lower(trim(coalesce(t.reference_type, ''))) = 'job'
         and t.reference_id is not null
         and t.source_deleted_at is null
         and t.total_hours > 0
       group by t.reference_id
    )
    select p.period_start::text period_start,
           count(j.job_id)::text total_jobs,
           count(h.job_id)::text jobs_with_timesheets,
           case when count(h.job_id) = 0 then 0
                else sum(j.total) filter (where h.job_id is not null) end::text allocated_sell_value,
           case when count(h.job_id) = 0 then 0 else sum(h.hours) end::text actual_job_hours
      from periods p
      left join completed_jobs j
        on date_trunc('month', j.completed_date)::date = p.period_start
      left join mapped_job_hours h on h.job_id = j.job_id
     group by p.period_start order by p.period_start
  `, [BACKFILL_START_MONTH, throughMonth]);
  return new Map(result.rows.map((row) => [row.period_start, {
    totalJobs: requiredFiniteNumber(row.total_jobs, "technicians", row.period_start, "canonical total job count"),
    jobsWithTimesheets: requiredFiniteNumber(row.jobs_with_timesheets, "technicians", row.period_start, "canonical jobs-with-timesheets count"),
    allocatedSellValue: money(requiredFiniteNumber(row.allocated_sell_value, "technicians", row.period_start, "canonical allocated sell value")),
    actualJobHours: money(requiredFiniteNumber(row.actual_job_hours, "technicians", row.period_start, "canonical actual job hours")),
  }]));
}

async function lockTechnicianSourceRows(client: ReconciliationQueryClient, throughMonth: string) {
  await client.query(
    `select t.employee_id, t.timesheet_id, p.person_id, j.job_id
       from metrics.metrics_employee_timesheets t
       join metrics.metrics_jobs j
         on lower(trim(coalesce(t.reference_type, ''))) = 'job'
        and j.job_id = t.reference_id
       join metrics.dim_people p on p.simpro_employee_id = t.employee_id
      where j.completed_date >= date '2023-01-01'
        and j.completed_date < ($1::date + interval '1 month')
        and lower(trim(j.stage)) in ('complete', 'archived')
        and j.source_deleted_at is null
        and t.source_deleted_at is null
        and t.total_hours > 0
      for share of t, j, p`,
    [throughMonth],
  );
}

async function readDashboards(client: ReconciliationQueryClient, throughMonth: string) {
  const result = await client.query<DashboardRow>(`
    select metric_family, period_grain, period_start::text, dimensions_json, values_json,
           source_hash, rebuilt_at::text, rebuilt_by_job_id::text
      from metrics.dashboard_read_models
     where metric_family in ('jobs', 'quotes', 'technicians')
       and period_grain = 'month'
       and period_start >= date '2023-01-01'
       and period_start <= $1::date
       and dimensions_json = '{}'::jsonb
       and superseded_at is null
     order by metric_family, period_start
     for update
  `, [throughMonth]);
  return new Map(result.rows.map((row) => [`${row.metric_family}:${row.period_start}`, row]));
}

async function readEvidence(client: ReconciliationQueryClient, throughMonth: string) {
  const result = await client.query<SourcePeriodRow>(`
    select source_family, period_start::text, coverage_status, reconciliation_status,
           source_id_hash, normalized_id_hash, source_value, normalized_value, evidence_json
      from metrics.source_period_manifests
     where source_family = any($1::text[])
       and period_start >= date '2023-01-01'
       and period_start <= $2::date
     order by period_start, source_family
     for share
  `, [REQUIRED_EVIDENCE_FAMILIES, throughMonth]);
  return new Map(result.rows.map((row) => [`${row.source_family}:${row.period_start}`, row]));
}

function requireEvidence(
  scope: BulkDashboardReconciliationScope,
  month: string,
  rows: Map<string, SourcePeriodRow>,
  expectedRows: Map<string, BulkBootstrapEvidenceUnit>,
  mismatches: Array<Record<string, unknown>>,
) {
  return REQUIRED_EVIDENCE[scope].map((family) => {
    const row = rows.get(`${family}:${month}`);
    const expected = expectedRows.get(`${family}:${month}`);
    const verification = verifySourcePeriodEvidence(scope, month, family, row, expected);
    if (!verification.valid) mismatches.push({ type: "source_period_evidence", ...verification });
    return verification.detail;
  });
}

export function verifySourcePeriodEvidence(
  scope: BulkDashboardReconciliationScope,
  month: string,
  family: string,
  row: SourcePeriodRow | undefined,
  expected: BulkBootstrapEvidenceUnit | undefined,
) {
  if (!row || !expected) {
    return {
      valid: false,
      scope,
      month,
      family,
      reason: !row ? "persisted evidence row is absent" : "current verified expectation is absent",
      row: row ?? null,
      expected: expected ?? null,
      detail: {
        family,
        coverageStatus: row?.coverage_status ?? null,
        reconciliationStatus: row?.reconciliation_status ?? null,
        sourceIdHash: row?.source_id_hash ?? null,
        expectedSourceIdHash: null,
        sourceValue: null,
        normalizedValue: null,
        artifactSha256: null,
        manifestSha256: null,
      },
    };
  }
  const evidence = record(row.evidence_json) ?? {};
  const expectedSourceIdHash = exactSourceIdHash(expected.exactSourceIds);
  const expectedSourceValue = requiredFiniteNumber(expected.sourceValue, family, month, "expected source_value");
  const expectedNormalizedValue = requiredFiniteNumber(expected.normalizedValue, family, month, "expected normalized_value");
  const sourceValue = requiredFiniteNumber(row.source_value, family, month, "source_value");
  const normalizedValue = requiredFiniteNumber(row.normalized_value, family, month, "normalized_value");
  const valid = row.coverage_status === "complete"
    && row.reconciliation_status === "matched"
    && row.source_id_hash === expectedSourceIdHash
    && row.normalized_id_hash === expectedSourceIdHash
    && close(sourceValue, expectedSourceValue)
    && close(normalizedValue, expectedNormalizedValue)
    && evidence.exactSourceIdHash === expectedSourceIdHash
    && evidence.artifactSha256 === expected.artifactSha256
    && evidence.manifestSha256 === expected.manifestSha256
    && evidence.checksumVerifiedFullUniverseArtifact === true
    && evidence.fabricatedApiResponse === false;
  return {
    valid,
    scope,
    month,
    family,
    expected: {
      sourceIdHash: expectedSourceIdHash,
      sourceValue: expectedSourceValue,
      normalizedValue: expectedNormalizedValue,
      artifactSha256: expected.artifactSha256,
      manifestSha256: expected.manifestSha256,
    },
    actual: {
      coverageStatus: row.coverage_status,
      reconciliationStatus: row.reconciliation_status,
      sourceIdHash: row.source_id_hash,
      normalizedIdHash: row.normalized_id_hash,
      sourceValue,
      normalizedValue,
      exactSourceIdHash: evidence.exactSourceIdHash ?? null,
      artifactSha256: evidence.artifactSha256 ?? null,
      manifestSha256: evidence.manifestSha256 ?? null,
    },
    detail: {
      family,
      coverageStatus: row.coverage_status,
      reconciliationStatus: row.reconciliation_status,
      sourceIdHash: row.source_id_hash,
      expectedSourceIdHash,
      sourceValue,
      normalizedValue,
      artifactSha256: typeof evidence.artifactSha256 === "string" ? evidence.artifactSha256 : null,
      manifestSha256: typeof evidence.manifestSha256 === "string" ? evidence.manifestSha256 : null,
    },
  };
}

function unit(params: {
  scope: BulkDashboardReconciliationScope;
  month: string;
  periodEnd: string;
  rollupValue: number;
  snapshotValue: number;
  upstreamSampleValue: number | null;
  projectManifestSha256: string;
  operationalManifestSha256: string;
  source: unknown;
  canonical: unknown;
  dashboard: unknown;
  readModel: DashboardRow;
  evidence: unknown;
  extra?: Record<string, unknown>;
}): BulkDashboardReconciliationUnit {
  return {
    scope: params.scope,
    periodStart: params.month,
    periodEnd: params.periodEnd,
    rollupValue: params.rollupValue,
    snapshotValue: params.snapshotValue,
    upstreamSampleValue: params.upstreamSampleValue,
    readModelVersion: {
      metricFamily: params.readModel.metric_family,
      periodGrain: params.readModel.period_grain,
      periodStart: params.readModel.period_start,
      dimensionsJson: params.readModel.dimensions_json,
      sourceHash: params.readModel.source_hash,
      rebuiltAt: params.readModel.rebuilt_at,
      rebuiltByJobId: params.readModel.rebuilt_by_job_id,
    },
    detail: {
      verificationStatus: "matched",
      authority: "checksum_verified_bulk_artifacts",
      sourceBasis: params.scope === "jobs"
        ? "Simpro CompletedDate with Stage Complete or Archived only; job Status is not used."
        : params.scope === "quotes"
          ? "Simpro DateIssued activity with persisted app-owned outcome classification and overrides."
          : "Derived from completed jobs and app-owned Simpro timesheets, schedules, and verified mobile status semantics.",
      projectManifestSha256: params.projectManifestSha256,
      operationalManifestSha256: params.operationalManifestSha256,
      source: params.source,
      canonical: params.canonical,
      dashboard: params.dashboard,
      dashboardSourceHash: params.readModel.source_hash,
      dashboardRebuiltAt: params.readModel.rebuilt_at,
      dashboardRebuiltByJobId: params.readModel.rebuilt_by_job_id,
      sourcePeriodEvidence: params.evidence,
      ...params.extra,
    },
  };
}

export function applyVerifiedDeltas(
  artifactRows: readonly ProjectRow[],
  verifiedDeltas: readonly ProjectRow[],
): ProjectRow[] {
  const byId = new Map<string, ProjectRow>();
  for (const row of artifactRows) {
    if (byId.has(row.id)) throw new Error(`Verified artifact contains duplicate project ID ${row.id}.`);
    byId.set(row.id, row);
  }
  const deltaIds = new Set<string>();
  for (const row of verifiedDeltas) {
    if (deltaIds.has(row.id)) throw new Error(`Verified raw deltas contain duplicate project ID ${row.id}.`);
    deltaIds.add(row.id);
    byId.set(row.id, row);
  }
  return [...byId.values()].sort((left, right) => compareExactSourceIds(left.id, right.id));
}

export function compareExactProjectRows(
  family: "jobs" | "quotes",
  sourceRows: readonly ProjectRow[],
  canonicalRows: readonly ProjectRow[],
  snapshotRows: readonly ProjectRow[],
) {
  const source = projectRowsById(sourceRows, family, "source");
  const canonical = projectRowsById(canonicalRows, family, "canonical");
  const snapshots = projectRowsById(snapshotRows, family, "snapshot");
  const ids = [...new Set([...source.keys(), ...canonical.keys(), ...snapshots.keys()])].sort(compareExactSourceIds);
  return ids.flatMap((id) => {
    const sourceTotal = source.get(id)?.total;
    const canonicalTotal = canonical.get(id)?.total;
    const snapshotTotal = snapshots.get(id)?.total;
    return sourceTotal !== undefined
      && canonicalTotal !== undefined
      && snapshotTotal !== undefined
      && close(sourceTotal, canonicalTotal)
      && close(sourceTotal, snapshotTotal)
      ? []
      : [{
          type: `${family}_source_canonical_snapshot_id_total`,
          id,
          source: sourceTotal ?? null,
          canonical: canonicalTotal ?? null,
          snapshot: snapshotTotal ?? null,
          diagnostic: `${family} ID ${id}: source=${sourceTotal ?? "missing"}, canonical=${canonicalTotal ?? "missing"}, snapshot=${snapshotTotal ?? "missing"}`,
        }];
  });
}

function projectRowsById(rows: readonly ProjectRow[], family: string, authority: string) {
  const byId = new Map<string, ProjectRow>();
  for (const row of rows) {
    if (byId.has(row.id)) throw new Error(`${family}/${authority} contains duplicate ID ${row.id}.`);
    byId.set(row.id, row);
  }
  return byId;
}

export function unverifiedPostArtifactRows(
  family: "jobs" | "quotes",
  canonicalRows: readonly ProjectRow[],
  verifiedDeltas: readonly ProjectRow[],
  artifactCompletedAt: string,
) {
  const cutoff = Date.parse(artifactCompletedAt);
  if (!Number.isFinite(cutoff)) throw new Error(`Invalid project artifact completedAt: ${artifactCompletedAt}.`);
  const deltaIds = new Set(verifiedDeltas.map((row) => row.id));
  return canonicalRows.flatMap((row) => {
    if (!row.fetchedAt) return [];
    const fetchedAt = Date.parse(row.fetchedAt);
    if (!Number.isFinite(fetchedAt)) {
      return [{ type: `${family}_invalid_canonical_fetched_at`, id: row.id, fetchedAt: row.fetchedAt }];
    }
    return fetchedAt > cutoff && !deltaIds.has(row.id)
      ? [{
          type: `${family}_unverified_post_artifact_canonical`,
          id: row.id,
          fetchedAt: row.fetchedAt,
          artifactCompletedAt,
        }]
      : [];
  });
}

function compareSummary(
  type: string,
  month: string,
  left: Summary,
  right: Summary,
  mismatches: Array<Record<string, unknown>>,
) {
  if (JSON.stringify(left.ids) !== JSON.stringify(right.ids) || !close(left.total, right.total)) {
    mismatches.push({ type, month, left, right });
  }
}

function compareValueSummary(
  type: string,
  month: string,
  left: { count: number; total: number },
  right: Summary,
  mismatches: Array<Record<string, unknown>>,
) {
  if (left.count !== right.count || !close(left.total, right.total)) mismatches.push({ type, month, left, right });
}

function compareTechnicians(
  month: string,
  left: { totalJobs: number; jobsWithTimesheets: number; allocatedSellValue: number; actualJobHours: number },
  right: { totalJobs: number; jobsWithTimesheets: number; allocatedSellValue: number; actualJobHours: number },
  mismatches: Array<Record<string, unknown>>,
) {
  if (
    left.totalJobs !== right.totalJobs
    || left.jobsWithTimesheets !== right.jobsWithTimesheets
    || !close(left.allocatedSellValue, right.allocatedSellValue)
    || !close(left.actualJobHours, right.actualJobHours)
  ) {
    mismatches.push({ type: "technician_dashboard_canonical", month, dashboard: left, canonical: right });
  }
}

function summary(rows: readonly ProjectRow[]): Summary {
  const sorted = [...rows].sort((left, right) => compareExactSourceIds(left.id, right.id));
  return {
    ids: sorted.map((row) => row.id),
    count: sorted.length,
    total: money(sorted.reduce((sum, row) => sum + row.total, 0)),
  };
}

function group(rows: readonly ProjectRow[]) {
  const result = new Map<string, ProjectRow[]>();
  for (const row of rows) {
    if (!row.periodStart) continue;
    result.set(row.periodStart, [...(result.get(row.periodStart) ?? []), row]);
  }
  return result;
}

function monthStarts(start: string, end: string) {
  const months: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= last) {
    months.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function inclusiveMonthEnd(month: string) {
  const date = new Date(`${month}T00:00:00.000Z`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

function argumentValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredDashboardRow(
  value: DashboardRow | undefined,
  scope: BulkDashboardReconciliationScope,
  month: string,
) {
  if (!value) throw new Error(`${scope}/${month}/dashboard read model is absent.`);
  return value;
}

function requiredRecord(value: unknown, scope: string, month: string, field: string) {
  const parsed = record(value);
  if (!parsed) throw new Error(`${scope}/${month}/${field} is absent or not an object.`);
  return parsed;
}

function requiredRecordArray(value: unknown, scope: string, month: string, field: string) {
  if (!Array.isArray(value)) throw new Error(`${scope}/${month}/${field} is absent or not an array.`);
  return value.map((nested, index) => {
    const parsed = record(nested);
    if (!parsed) throw new Error(`${scope}/${month}/${field}[${index}] is not an object.`);
    return parsed;
  });
}

export function requiredFiniteNumber(value: unknown, scope: string, month: string, field: string) {
  const label = `${scope}/${month}/${field}`;
  if (value === undefined) throw new Error(`${label} is absent; a finite number is required.`);
  if (value === null) throw new Error(`${label} is null; a finite number is required.`);
  if (typeof value === "boolean") throw new Error(`${label} is boolean; a finite number is required.`);
  if (typeof value === "string" && !value.trim()) throw new Error(`${label} is blank; a finite number is required.`);
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`${label} has type ${typeof value}; a finite number is required.`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is nonnumeric or non-finite.`);
  return parsed;
}

function money(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function requiredPositiveId(value: unknown, label: string) {
  if (value === null || value === undefined || typeof value === "boolean" || (typeof value === "string" && !value.trim())) {
    throw new Error(`${label} must be a positive integer.`);
  }
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function close(left: number, right: number) {
  return Math.abs(left - right) < 0.01;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

import { isSimproNotFound, sourceHash, type RequestBudget } from "@/lib/simpro/client";
import { SimproEndpoints } from "@/lib/simpro/endpoints";
import { ingestChangeLogPage, type ChangeLogFamily } from "@/lib/simpro/ingest-change-logs";
import { ingestProjectNested } from "@/lib/simpro/ingest-nested";
import {
  enqueueAffectedRollups,
  markProjectSourceUnavailable,
  markScheduleSourceUnavailable,
  persistScheduleBlocks,
} from "@/lib/simpro/normalize-nested";
import {
  acquireSchedulePublicationAuthority,
  activeScheduleTechnicianPeriods,
  normalizeSimproSnapshot,
} from "@/lib/simpro/normalize";
import { pickId } from "@/lib/simpro/schemas";
import { queryPostgres, withPostgresTransaction } from "@/lib/store/postgres";
import type { RollupScope } from "@/lib/store/rollups";
import { snapshotTimestamp, writeRawSnapshot } from "@/lib/store/snapshots";

export type IngestionEntity = "quotes" | "quote_logs" | "quote_nested" | "jobs" | "job_logs" | "job_nested" | "jobs_from_timesheets" | "employees" | "timesheets" | "schedules" | "schedule_logs" | "mobile_status";
export type SummaryIngestionEntity = Exclude<IngestionEntity, "quote_logs" | "quote_nested" | "job_logs" | "job_nested" | "jobs_from_timesheets" | "timesheets" | "schedule_logs" | "mobile_status">;

export type IngestionResult = {
  entity: IngestionEntity;
  snapshotsWritten: number;
  normalizedWritten: number;
  affectedPeriods: Array<{ scope: RollupScope; periodStart: string }>;
  continuationToken: Record<string, unknown> | null;
  requestsUsed: number;
  tombstonedCount?: number;
  candidateRefreshes?: Array<{
    entity: "quote_nested" | "job_nested" | "employees" | "schedules";
    entityId: number;
    sourceHash: string;
    params?: Record<string, unknown>;
  }>;
};

export async function ingestEntityPage(params: {
  endpoints: SimproEndpoints;
  entity: IngestionEntity;
  page?: number;
  continuationToken?: Record<string, unknown> | null;
  params?: Record<string, unknown>;
  requestBudget: RequestBudget;
  ingestionRunId?: number | null;
}): Promise<IngestionResult> {
  switch (params.entity) {
    case "quotes": {
      const entityId = optionalPositiveId(params.params?.entityId);
      return entityId
        ? ingestExplicitProject({ ...params, entity: "quotes", entityId })
        : ingestSummaryPage({ ...params, entity: "quotes" }, "/quotes/");
    }
    case "quote_logs":
    case "job_logs":
    case "schedule_logs":
    case "mobile_status": {
      const log = await ingestChangeLogPage({
        endpoints: params.endpoints,
        sourceFamily: params.entity as ChangeLogFamily,
        continuationToken: params.continuationToken,
        requestBudget: params.requestBudget,
        ingestionRunId: params.ingestionRunId,
      });
      return { entity: params.entity, ...log };
    }
    case "quote_nested": {
      const nested = await ingestProjectNested({
        ...params,
        projectType: "quote",
        projectId: nestedProjectId(params),
      });
      return { entity: "quote_nested", ...nested };
    }
    case "jobs": {
      const entityId = optionalPositiveId(params.params?.entityId);
      return entityId
        ? ingestExplicitProject({ ...params, entity: "jobs", entityId })
        : ingestSummaryPage({ ...params, entity: "jobs" }, "/jobs/");
    }
    case "job_nested": {
      const nested = await ingestProjectNested({
        ...params,
        projectType: "job",
        projectId: nestedProjectId(params),
      });
      return { entity: "job_nested", ...nested };
    }
    case "jobs_from_timesheets":
      return ingestJobsFromTimesheets(params);
    case "employees": {
      const entityId = optionalPositiveId(params.params?.entityId);
      return entityId
        ? ingestExplicitEmployee({ ...params, entityId })
        : ingestSummaryPage({ ...params, entity: "employees" }, "/employees/");
    }
    case "timesheets":
      return ingestEmployeeTimesheets(params);
    case "schedules": {
      const entityId = optionalPositiveId(params.params?.entityId);
      return entityId
        ? ingestExplicitSchedule({ ...params, entityId })
        : ingestSummaryPage({ ...params, entity: "schedules" }, "/schedules/");
    }
    default:
      assertNever(params.entity);
  }
}

async function ingestExplicitProject(params: {
  endpoints: SimproEndpoints;
  entity: "quotes" | "jobs";
  entityId: number;
  requestBudget: RequestBudget;
  ingestionRunId?: number | null;
}): Promise<IngestionResult> {
  const projectType = params.entity === "quotes" ? "quote" : "job";
  let detail: Record<string, unknown>;
  try {
    detail = params.entity === "quotes"
      ? await params.endpoints.getQuote(params.entityId, params.requestBudget)
      : await params.endpoints.getJob(params.entityId, params.requestBudget);
  } catch (error) {
    if (!isSimproNotFound(error)) throw error;
    const tombstone = {
      sourceUnavailable: true,
      reason: "not_found",
      status: 404,
      projectType,
      projectId: params.entityId,
    };
    const sourceUnavailable = await markProjectSourceUnavailable(projectType, params.entityId, {
      tombstoneSnapshot: {
        entityType: `${projectType}_details`,
        entityId: String(params.entityId),
        sourcePath: `/${params.entity}/${params.entityId}`,
        payload: tombstone,
        sourceHash: sourceHash(tombstone),
        ingestionRunId: params.ingestionRunId,
        parentIdentity: { projectType, projectId: params.entityId },
        pageWindow: { source: "backfill_detail" },
      },
    });
    return {
      entity: params.entity,
      snapshotsWritten: sourceUnavailable.snapshotInserted ? 1 : 0,
      normalizedWritten: 0,
      affectedPeriods: sourceUnavailable.affectedPeriods,
      continuationToken: null,
      requestsUsed: params.requestBudget.used,
    };
  }

  const detailHash = sourceHash(detail);
  const snapshot = await writeRawSnapshot({
    entityType: `${projectType}_details`,
    entityId: String(params.entityId),
    sourcePath: `/${params.entity}/${params.entityId}`,
    payload: detail,
    sourceHash: detailHash,
    sourceUpdatedAt: sourceTimestamp(detail),
    ingestionRunId: params.ingestionRunId,
    pageWindow: { source: "backfill_detail" },
  });
  const normalization = await normalizeSimproSnapshot({
    entity: params.entity,
    entityId: String(params.entityId),
    payload: detail,
    sourceSnapshotId: snapshot.id,
    sourceHash: detailHash,
    fetchedAt: snapshotTimestamp(snapshot.extracted_at),
  });
  return {
    entity: params.entity,
    snapshotsWritten: snapshot.inserted ? 1 : 0,
    normalizedWritten: normalization.normalized ? 1 : 0,
    affectedPeriods: normalization.affectedPeriods,
    continuationToken: null,
    requestsUsed: params.requestBudget.used,
    candidateRefreshes: [{
      entity: params.entity === "quotes" ? "quote_nested" : "job_nested",
      entityId: params.entityId,
      sourceHash: detailHash,
      params: { trigger: "backfill_detail" },
    }],
  };
}

async function ingestSummaryPage(
  params: {
    endpoints: SimproEndpoints;
    entity: SummaryIngestionEntity;
    page?: number;
    continuationToken?: Record<string, unknown> | null;
    params?: Record<string, unknown>;
    requestBudget: RequestBudget;
    ingestionRunId?: number | null;
  },
  sourcePath: string,
): Promise<IngestionResult> {
  const page = await listPage(params);
  let snapshotsWritten = 0;
  const candidateRefreshes: NonNullable<IngestionResult["candidateRefreshes"]> = [];

  // A summary page is discovery evidence. Detail normalization is delegated to
  // idempotent candidates so one list request can cover every row on the page.
  for (const planned of planSummaryRows(params.entity, page.rows)) {
    const summary = await writeRawSnapshot({
      entityType: params.entity,
      entityId: planned.id,
      sourcePath,
      payload: planned.row,
      sourceHash: planned.sourceHash,
      sourceUpdatedAt: sourceTimestamp(planned.row),
      ingestionRunId: params.ingestionRunId,
      pageWindow: { page: page.page, pageSize: page.pageSize },
    });
    snapshotsWritten += summary.inserted ? 1 : 0;
    candidateRefreshes.push(planned.candidate);
  }

  return {
    entity: params.entity,
    snapshotsWritten,
    normalizedWritten: 0,
    affectedPeriods: [],
    continuationToken: page.continuationToken,
    requestsUsed: params.requestBudget.used,
    candidateRefreshes,
  };
}

export function planSummaryRows(entity: SummaryIngestionEntity, rows: Array<Record<string, unknown>>) {
  return rows.flatMap((row) => {
    const id = pickId(row);
    const entityId = Number(id);
    if (!id || !Number.isInteger(entityId) || entityId <= 0) return [];
    const hash = sourceHash(row);
    const candidateEntity: NonNullable<IngestionResult["candidateRefreshes"]>[number]["entity"] = entity === "quotes"
      ? "quote_nested"
      : entity === "jobs"
        ? "job_nested"
        : entity;
    const sourceModifiedAt = sourceTimestamp(row);
    return [{
      row,
      id,
      sourceHash: hash,
      candidate: {
        entity: candidateEntity,
        entityId,
        sourceHash: hash,
        params: {
          trigger: "summary",
          ...(sourceModifiedAt ? { sourceModifiedAt } : {}),
        },
      },
    }];
  });
}

function listPage(params: {
  endpoints: SimproEndpoints;
  entity: IngestionEntity;
  page?: number;
  continuationToken?: Record<string, unknown> | null;
  params?: Record<string, unknown>;
  requestBudget: RequestBudget;
  ingestionRunId?: number | null;
}) {
  const options = { page: params.page, budget: params.requestBudget, query: params.params };
  switch (params.entity) {
    case "quotes":
      return params.endpoints.listQuotes(options);
    case "jobs":
      return params.endpoints.listJobs(options);
    case "jobs_from_timesheets":
      throw new Error("Timesheet-referenced jobs are ingested from app-owned timesheet references, not from a summary page.");
    case "quote_nested":
    case "job_nested":
      throw new Error("Nested project resources are ingested from an explicit parent ID, not from a summary page.");
    case "quote_logs":
    case "job_logs":
    case "schedule_logs":
    case "mobile_status":
      throw new Error("Change logs use durable high-water-mark traversal.");
    case "employees":
      return params.endpoints.listEmployees(options);
    case "timesheets":
      throw new Error("Timesheets are ingested per employee, not from a summary page.");
    case "schedules":
      return params.endpoints.listSchedules(options);
    case "mobile_status":
      return params.endpoints.listMobileStatusLogs(options);
    default:
      assertNever(params.entity);
  }
}

async function ingestJobsFromTimesheets(params: {
  endpoints: SimproEndpoints;
  continuationToken?: Record<string, unknown> | null;
  params?: Record<string, unknown>;
  requestBudget: RequestBudget;
  ingestionRunId?: number | null;
}): Promise<IngestionResult> {
  const jobIds = await listTimesheetReferencedJobIds(params.params);
  let offset = numberFromToken(params.continuationToken?.offset, 0);
  let snapshotsWritten = 0;
  let normalizedWritten = 0;
  const affectedPeriodKeys = new Set<string>();
  const affectedPeriods: Array<{ scope: RollupScope; periodStart: string }> = [];
  const candidateRefreshes: NonNullable<IngestionResult["candidateRefreshes"]> = [];

  while (offset < jobIds.length && params.requestBudget.used < params.requestBudget.limit) {
    const jobId = jobIds[offset];
    let detail: Record<string, unknown>;
    try {
      detail = await params.endpoints.getJob(jobId, params.requestBudget);
    } catch (error) {
      if (!isSimproNotFound(error)) throw error;
      const tombstone = { sourceUnavailable: true, reason: "not_found", status: 404, projectType: "job", projectId: jobId };
      const hash = sourceHash(tombstone);
      const sourceUnavailable = await markProjectSourceUnavailable("job", jobId, {
        tombstoneSnapshot: {
          entityType: "job_details",
          entityId: String(jobId),
          sourcePath: `/jobs/${encodeURIComponent(String(jobId))}`,
          payload: tombstone,
          sourceHash: hash,
          ingestionRunId: params.ingestionRunId,
          parentIdentity: { projectType: "job", projectId: jobId },
          pageWindow: { source: "timesheet_references", offset, total: jobIds.length },
        },
      });
      snapshotsWritten += sourceUnavailable.snapshotInserted ? 1 : 0;
      for (const affected of sourceUnavailable.affectedPeriods) {
        const key = `${affected.scope}:${affected.periodStart}`;
        if (!affectedPeriodKeys.has(key)) {
          affectedPeriodKeys.add(key);
          affectedPeriods.push(affected);
        }
      }
      offset += 1;
      continue;
    }
    const detailHash = sourceHash(detail);
    const snapshot = await writeRawSnapshot({
      entityType: "job_details",
      entityId: String(jobId),
      sourcePath: `/jobs/${encodeURIComponent(String(jobId))}`,
      payload: detail,
      sourceHash: detailHash,
      sourceUpdatedAt: sourceTimestamp(detail),
      ingestionRunId: params.ingestionRunId,
      pageWindow: { source: "timesheet_references", offset, total: jobIds.length },
    });
    snapshotsWritten += snapshot.inserted ? 1 : 0;
    if (snapshot.inserted) {
      candidateRefreshes.push({ entity: "job_nested", entityId: jobId, sourceHash: detailHash });
    }

    const normalization = await normalizeSimproSnapshot({
      entity: "jobs",
      entityId: String(jobId),
      payload: detail,
      sourceSnapshotId: snapshot.id,
      sourceHash: detailHash,
      fetchedAt: snapshotTimestamp(snapshot.extracted_at),
    });
    if (normalization.normalized) {
      normalizedWritten += 1;
    }
    for (const affected of normalization.affectedPeriods) {
      const key = `${affected.scope}:${affected.periodStart}`;
      if (!affectedPeriodKeys.has(key)) {
        affectedPeriodKeys.add(key);
        affectedPeriods.push(affected);
      }
    }
    offset += 1;
  }

  return {
    entity: "jobs_from_timesheets",
    snapshotsWritten,
    normalizedWritten,
    affectedPeriods,
    continuationToken: offset < jobIds.length ? { offset, total: jobIds.length } : null,
    requestsUsed: params.requestBudget.used,
    candidateRefreshes,
  };
}

async function listTimesheetReferencedJobIds(params?: Record<string, unknown>): Promise<number[]> {
  const defaultEnd = new Date();
  const defaultStart = new Date(defaultEnd);
  defaultStart.setUTCDate(defaultStart.getUTCDate() - 120);
  const start = stringValue(params?.StartDate ?? params?.startDate) ?? defaultStart.toISOString().slice(0, 10);
  const end = stringValue(params?.EndDate ?? params?.endDate) ?? defaultEnd.toISOString().slice(0, 10);
  const result = await queryPostgres<{ reference_id: string }>(
    `select distinct t.reference_id::text as reference_id
     from metrics.metrics_employee_timesheets t
     left join metrics.metrics_jobs j on j.job_id = t.reference_id
     where t.reference_type = 'job'
       and t.reference_id is not null
       and t.work_date between $1::date and $2::date
       and t.source_deleted_at is null
       and (j.job_id is null or j.completed_date is null)
     order by reference_id`,
    [start, end],
  );
  return result.rows.map((row) => Number(row.reference_id)).filter((id) => Number.isInteger(id) && id > 0);
}

async function ingestEmployeeTimesheets(params: {
  endpoints: SimproEndpoints;
  page?: number;
  continuationToken?: Record<string, unknown> | null;
  params?: Record<string, unknown>;
  requestBudget: RequestBudget;
  ingestionRunId?: number | null;
}): Promise<IngestionResult> {
  const employees = await listTimesheetEmployees();
  // One window for the whole drain: the API query and the tombstone scope must
  // describe the same date range, and default windows must not drift per call.
  const window = buildEmployeeTimesheetQuery(params.params);
  let employeeOffset = numberFromToken(params.continuationToken?.employeeOffset, Math.max(0, (params.page ?? 1) - 1));
  let timesheetPage = numberFromToken(params.continuationToken?.timesheetPage, 1);
  let snapshotsWritten = 0;
  let normalizedWritten = 0;
  let tombstonedCount = 0;
  const affectedPeriodKeys = new Set<string>();
  const affectedPeriods: Array<{ scope: RollupScope; periodStart: string }> = [];
  const mergeAffectedPeriods = (periods: Array<{ scope: RollupScope; periodStart: string }>) => {
    for (const affected of periods) {
      const key = `${affected.scope}:${affected.periodStart}`;
      if (!affectedPeriodKeys.has(key)) {
        affectedPeriodKeys.add(key);
        affectedPeriods.push(affected);
      }
    }
  };

  while (employeeOffset < employees.length && params.requestBudget.used < params.requestBudget.limit) {
    const employeeId = employees[employeeOffset];
    const startedAtFirstPage = timesheetPage === 1;
    const seenTimesheetIds: string[] = [];
    const seenSnapshotEntityIds: string[] = [];
    const page = await params.endpoints.listEmployeeTimesheets(employeeId, {
      page: timesheetPage,
      budget: params.requestBudget,
      query: window,
    });

    for (const row of page.rows) {
      const uid = pickId(row) ?? stringValue(row.UID) ?? `${employeeId}:${row.Date ?? ""}:${row.StartTime ?? ""}:${row.Reference ?? ""}`;
      const entityId = `${employeeId}:${uid}`;
      const payload = { ...row, EmployeeID: employeeId };
      const payloadHash = sourceHash(payload);
      const snapshot = await writeRawSnapshot({
        entityType: "timesheets",
        entityId,
        sourcePath: `/employees/${encodeURIComponent(String(employeeId))}/timesheets/`,
        payload,
        sourceHash: payloadHash,
        ingestionRunId: params.ingestionRunId,
        pageWindow: { page: page.page, pageSize: page.pageSize, employeeId },
      });
      snapshotsWritten += snapshot.inserted ? 1 : 0;

      const normalization = await normalizeSimproSnapshot({
        entity: "timesheets",
        entityId,
        payload,
        sourceSnapshotId: snapshot.id,
        sourceHash: payloadHash,
        fetchedAt: snapshotTimestamp(snapshot.extracted_at),
      });
      if (normalization.normalized) {
        normalizedWritten += 1;
      }
      mergeAffectedPeriods(normalization.affectedPeriods);

      seenSnapshotEntityIds.push(entityId);
      // Match normalizeTimesheet's identity derivation exactly so the seen set
      // aligns with metrics_employee_timesheets.timesheet_id.
      const normalizedTimesheetId = stringValue(row.UID ?? entityId);
      if (normalizedTimesheetId) seenTimesheetIds.push(normalizedTimesheetId);
    }

    const tombstonePlan = planEmployeeTimesheetTombstone({
      employeeId,
      window,
      startedAtFirstPage,
      continuationToken: page.continuationToken,
      seenTimesheetIds,
      seenSnapshotEntityIds,
    });
    if (tombstonePlan) {
      const tombstoned = await tombstoneAbsentEmployeeTimesheets(tombstonePlan);
      tombstonedCount += tombstoned.tombstonedCount;
      mergeAffectedPeriods(tombstoned.affectedPeriods);
    }

    if (page.continuationToken) {
      timesheetPage = page.continuationToken.page;
      break;
    }

    employeeOffset += 1;
    timesheetPage = 1;
  }

  return {
    entity: "timesheets",
    snapshotsWritten,
    normalizedWritten,
    affectedPeriods,
    continuationToken:
      employeeOffset < employees.length
        ? { employeeOffset, timesheetPage, employeeCount: employees.length }
        : null,
    requestsUsed: params.requestBudget.used,
    tombstonedCount,
  };
}

export type EmployeeTimesheetTombstonePlan = {
  employeeId: number;
  startDate: string;
  endDate: string;
  seenTimesheetIds: string[];
  seenSnapshotEntityIds: string[];
};

/**
 * Decides whether an employee's hourly timesheet traversal is authoritative
 * enough to tombstone absent rows, mirroring the bulk bootstrap's
 * complete-traversal semantics (finalizeAuthoritativeFamily) at per-employee,
 * per-window scope.
 *
 * Tombstoning is only sound when the traversal provably covered the employee's
 * entire window in this invocation:
 * - a saved continuation means the source has more pages (partial evidence);
 * - a traversal resumed above page 1 lacks the earlier pages' seen set.
 * Either case returns null so absent rows stay intact.
 */
export function planEmployeeTimesheetTombstone(params: {
  employeeId: number;
  window: EmployeeTimesheetQuery;
  startedAtFirstPage: boolean;
  continuationToken: Record<string, unknown> | null;
  seenTimesheetIds: string[];
  seenSnapshotEntityIds: string[];
}): EmployeeTimesheetTombstonePlan | null {
  if (!params.startedAtFirstPage || params.continuationToken) {
    return null;
  }
  return {
    employeeId: params.employeeId,
    startDate: params.window.StartDate,
    endDate: params.window.EndDate,
    seenTimesheetIds: [...new Set(params.seenTimesheetIds)],
    seenSnapshotEntityIds: [...new Set(params.seenSnapshotEntityIds)],
  };
}

/**
 * Tombstones timesheet rows that a provably complete employee-window traversal
 * no longer observed in Simpro, scoped strictly to that employee and window.
 * Mirrors the bulk bootstrap's authoritative finalization for the timesheets
 * family: soft-delete the fact rows, remove the serving snapshots, and
 * tombstone the raw evidence rows.
 */
export async function tombstoneAbsentEmployeeTimesheets(
  plan: EmployeeTimesheetTombstonePlan,
  transaction: typeof withPostgresTransaction = withPostgresTransaction,
): Promise<{ tombstonedCount: number; affectedPeriods: Array<{ scope: RollupScope; periodStart: string }> }> {
  return transaction(async (query) => {
    const facts = await query<{ tombstoned_count: number | string; period_starts: string[] }>(
      `with tombstoned as (
         update metrics.metrics_employee_timesheets fact
            set source_deleted_at = coalesce(fact.source_deleted_at, now()),
                updated_from_source_at = now()
          where fact.employee_id = $1::bigint
            and fact.work_date >= $2::date and fact.work_date <= $3::date
            and fact.source_deleted_at is null
            and not (fact.timesheet_id = any($4::text[]))
          returning fact.reference_type, fact.reference_id
       ), affected as (
         select distinct to_char(date_trunc('month', job.completed_date), 'YYYY-MM-DD') as period_start
           from tombstoned
           join metrics.metrics_jobs job on job.job_id = tombstoned.reference_id
          where tombstoned.reference_type = 'job'
            and job.source_deleted_at is null
            and job.completed_date is not null
            and lower(job.stage) in ('complete', 'archived')
       )
       select (select count(*)::int from tombstoned) as tombstoned_count,
              coalesce((select array_agg(period_start order by period_start) from affected), '{}') as period_starts`,
      [plan.employeeId, plan.startDate, plan.endDate, plan.seenTimesheetIds],
    );
    await query(
      `delete from metrics.timesheet_snapshots fact
        where fact.employee_id = $1::bigint
          and fact.work_date >= $2::date and fact.work_date <= $3::date
          and not (fact.simpro_timesheet_id = any($4::text[]))`,
      [plan.employeeId, plan.startDate, plan.endDate, plan.seenTimesheetIds],
    );
    await query(
      `update metrics.raw_simpro_snapshots raw
          set source_deleted_at = coalesce(raw.source_deleted_at, now())
        where raw.entity_type = 'timesheets'
          and raw.entity_id like $1::text || ':%'
          and raw.payload->>'Date' >= $2 and raw.payload->>'Date' <= $3
          and raw.source_deleted_at is null
          and not (raw.entity_id = any($4::text[]))`,
      [String(plan.employeeId), plan.startDate, plan.endDate, plan.seenSnapshotEntityIds],
    );
    const row = facts.rows[0];
    const affectedPeriods = (row?.period_starts ?? []).flatMap((periodStart) => [
      { scope: "jobs" as const, periodStart },
      { scope: "technicians" as const, periodStart },
      { scope: "commissions" as const, periodStart },
    ]);
    return { tombstonedCount: Number(row?.tombstoned_count) || 0, affectedPeriods };
  });
}

async function ingestExplicitEmployee(params: {
  endpoints: SimproEndpoints;
  entityId: number;
  requestBudget: RequestBudget;
  ingestionRunId?: number | null;
}): Promise<IngestionResult> {
  const detail = await params.endpoints.getEmployee(params.entityId, params.requestBudget);
  const payloadHash = sourceHash(detail);
  const snapshot = await writeRawSnapshot({
    entityType: "employee_details",
    entityId: String(params.entityId),
    sourcePath: `/employees/${params.entityId}`,
    payload: detail,
    sourceHash: payloadHash,
    sourceUpdatedAt: sourceTimestamp(detail),
    ingestionRunId: params.ingestionRunId,
    parentIdentity: { employeeId: params.entityId },
  });
  const normalization = await normalizeSimproSnapshot({
    entity: "employees",
    entityId: String(params.entityId),
    payload: detail,
    sourceSnapshotId: snapshot.id,
    sourceHash: payloadHash,
    fetchedAt: snapshotTimestamp(snapshot.extracted_at),
  });
  return {
    entity: "employees",
    snapshotsWritten: snapshot.inserted ? 1 : 0,
    normalizedWritten: normalization.normalized ? 1 : 0,
    affectedPeriods: normalization.affectedPeriods,
    continuationToken: null,
    requestsUsed: params.requestBudget.used,
  };
}

async function ingestExplicitSchedule(params: {
  endpoints: SimproEndpoints;
  entityId: number;
  requestBudget: RequestBudget;
  ingestionRunId?: number | null;
}): Promise<IngestionResult> {
  let detail: Record<string, unknown>;
  try {
    detail = await params.endpoints.getSchedule(params.entityId, params.requestBudget);
  } catch (error) {
    if (!isSimproNotFound(error)) throw error;
    const observedAt = new Date().toISOString();
    const unavailable = await recordMissingSchedule({
      scheduleId: params.entityId,
      ingestionRunId: params.ingestionRunId,
      pageWindow: { source: "schedule_candidate" },
      observedAt,
    });
    return {
      entity: "schedules",
      snapshotsWritten: unavailable.snapshotsWritten,
      normalizedWritten: 0,
      affectedPeriods: unavailable.affectedPeriods,
      continuationToken: null,
      requestsUsed: params.requestBudget.used,
    };
  }
  const observedAt = new Date().toISOString();
  const payloadHash = sourceHash(detail);
  const publication = await withPostgresTransaction(async (query) => {
    const authority = await acquireSchedulePublicationAuthority({
      entityId: String(params.entityId),
      payload: detail,
      fetchedAt: observedAt,
      query,
    });
    if (!authority.applied) return null;
    const snapshot = await writeRawSnapshot({
      entityType: "schedule_details",
      entityId: String(params.entityId),
      sourcePath: `/schedules/${params.entityId}`,
      payload: detail,
      sourceHash: payloadHash,
      sourceUpdatedAt: sourceTimestamp(detail),
      ingestionRunId: params.ingestionRunId,
      parentIdentity: { scheduleId: params.entityId },
    }, query);
    const normalization = await normalizeSimproSnapshot({
      entity: "schedules",
      entityId: String(params.entityId),
      payload: detail,
      sourceSnapshotId: snapshot.id,
      sourceHash: payloadHash,
      fetchedAt: observedAt,
      query,
    });
    if (normalization.normalized) {
      await persistScheduleBlocks({
        scheduleId: params.entityId,
        payload: detail,
        provenance: { sourceSnapshotId: snapshot.id, sourceHash: payloadHash, fetchedAt: observedAt },
        referenceType: authority.referenceType,
        referenceId: authority.referenceId,
        query,
      });
    }
    const currentPeriods = await activeScheduleTechnicianPeriods(params.entityId, query);
    const affectedPeriods = uniqueRollupPeriods([...authority.affectedPeriods, ...currentPeriods]);
    await enqueueAffectedRollups(
      affectedPeriods,
      `schedule ${params.entityId} publication`,
      query,
    );
    return { snapshot, normalization, affectedPeriods };
  });
  return {
    entity: "schedules",
    snapshotsWritten: publication?.snapshot.inserted ? 1 : 0,
    normalizedWritten: publication?.normalization.normalized ? 1 : 0,
    affectedPeriods: publication?.affectedPeriods ?? [],
    continuationToken: null,
    requestsUsed: params.requestBudget.used,
  };
}

async function recordMissingSchedule(params: {
  scheduleId: number;
  ingestionRunId?: number | null;
  pageWindow: Record<string, unknown>;
  observedAt: string;
}) {
  const tombstone = {
    sourceUnavailable: true,
    reason: "not_found",
    status: 404,
    scheduleId: params.scheduleId,
  };
  const payloadHash = sourceHash(tombstone);
  const result = await markScheduleSourceUnavailable(params.scheduleId, {
    observedAt: params.observedAt,
    tombstoneSnapshot: {
      entityType: "schedule_details",
      entityId: String(params.scheduleId),
      sourcePath: `/schedules/${params.scheduleId}`,
      payload: tombstone,
      sourceHash: payloadHash,
      ingestionRunId: params.ingestionRunId,
      parentIdentity: { scheduleId: params.scheduleId },
      pageWindow: params.pageWindow,
    },
  });
  return {
    snapshotsWritten: result.snapshotInserted ? 1 : 0,
    affectedPeriods: result.affectedPeriods,
  };
}

async function listTimesheetEmployees(): Promise<number[]> {
  const result = await queryPostgres<{ employee_id: string }>(
    `select employee_id::text
     from metrics.employee_snapshots
     where archived = false
     order by employee_id`,
  );
  return result.rows.map((row) => Number(row.employee_id)).filter((id) => Number.isInteger(id) && id > 0);
}

export type EmployeeTimesheetQuery = {
  StartDate: string;
  EndDate: string;
};

export function buildEmployeeTimesheetQuery(params?: Record<string, unknown>): EmployeeTimesheetQuery {
  const defaultEnd = new Date();
  const defaultStart = new Date(defaultEnd);
  defaultStart.setUTCDate(defaultStart.getUTCDate() - 90);
  const start = stringValue(params?.StartDate ?? params?.startDate) ?? defaultStart.toISOString().slice(0, 10);
  const end = stringValue(params?.EndDate ?? params?.endDate) ?? defaultEnd.toISOString().slice(0, 10);
  return {
    StartDate: start,
    EndDate: end,
  };
}

function numberFromToken(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

function sourceTimestamp(payload: Record<string, unknown>): string | null {
  return stringValue(payload.DateModified ?? payload.DateLogged ?? payload.DateSynced);
}

function uniqueRollupPeriods<T extends { scope: RollupScope; periodStart: string }>(periods: T[]): T[] {
  return [...new Map(periods.map((period) => [`${period.scope}:${period.periodStart}`, period])).values()];
}

function nestedProjectId(params: {
  continuationToken?: Record<string, unknown> | null;
  params?: Record<string, unknown>;
}) {
  const value = params.params?.entityId ?? params.params?.projectId ?? params.continuationToken?.projectId;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Nested project ingestion requires params.entityId with a positive Simpro ID.");
  }
  return id;
}

function optionalPositiveId(value: unknown) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled ingestion entity: ${value}`);
}

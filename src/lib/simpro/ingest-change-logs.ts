import { sourceHash, type RequestBudget, type SimproPage } from "@/lib/simpro/client";
import { SimproEndpoints } from "@/lib/simpro/endpoints";
import { normalizeSimproSnapshot } from "@/lib/simpro/normalize";
import { pickId } from "@/lib/simpro/schemas";
import type { RollupScope } from "@/lib/store/rollups";
import {
  commitSourceWatermark,
  getSourceWatermark,
  markSourceWatermarkAttempt,
  upsertSourceChangeEvent,
} from "@/lib/store/source-changes";
import { snapshotTimestamp, writeRawSnapshot } from "@/lib/store/snapshots";

export type ChangeLogFamily = "quote_logs" | "job_logs" | "schedule_logs" | "mobile_status";

export type ChangeLogCandidate = {
  entity: "quote_nested" | "job_nested" | "schedules";
  entityId: number;
  sourceHash: string;
  params?: Record<string, unknown>;
};

export type ChangeLogIngestionResult = {
  snapshotsWritten: number;
  normalizedWritten: number;
  affectedPeriods: Array<{ scope: RollupScope; periodStart: string }>;
  continuationToken: Record<string, unknown> | null;
  requestsUsed: number;
  candidateRefreshes: ChangeLogCandidate[];
};

type LogCursor = { dateLogged: string; logId: number };

export async function ingestChangeLogPage(params: {
  endpoints: SimproEndpoints;
  sourceFamily: ChangeLogFamily;
  continuationToken?: Record<string, unknown> | null;
  requestBudget: RequestBudget;
  ingestionRunId?: number | null;
  now?: Date;
}): Promise<ChangeLogIngestionResult> {
  const now = params.now ?? new Date();
  const expectedThrough = now.toISOString();
  const watermark = await getSourceWatermark(params.sourceFamily);
  const overlapStart = stringValue(params.continuationToken?.overlapStart)
    ?? calculateOverlapStart(watermark?.committedDateLogged, now);
  const pageNumber = positiveInt(params.continuationToken?.page) ?? 1;
  const page = await listLogs(params, pageNumber);
  let snapshotsWritten = 0;
  let normalizedWritten = 0;
  let gapDetected = Boolean(params.continuationToken?.gapDetected);
  let boundaryReached = false;
  let previousCursor = parseCursor(params.continuationToken?.lastCursor);
  let observedMax = parseCursor(params.continuationToken?.observedMax);
  let recordCount = nonNegativeInt(params.continuationToken?.recordCount) ?? 0;
  let aggregateHash = stringValue(params.continuationToken?.aggregateHash);
  const affected = new Map<string, { scope: RollupScope; periodStart: string }>();
  const candidates = new Map<string, ChangeLogCandidate>();

  for (const row of page.rows) {
    const payload = asRecord(row);
    const cursor = logCursor(payload);
    if (!cursor) {
      gapDetected = true;
      continue;
    }
    if (previousCursor && compareLogCursor(cursor, previousCursor) > 0) {
      gapDetected = true;
    }
    previousCursor = cursor;
    if (!observedMax || compareLogCursor(cursor, observedMax) > 0) observedMax = cursor;
    if (new Date(cursor.dateLogged).getTime() < new Date(overlapStart).getTime()) {
      boundaryReached = true;
      break;
    }

    const payloadHash = sourceHash(payload);
    aggregateHash = sourceHash([aggregateHash, payloadHash]);
    const mapping = logMapping(params.sourceFamily, payload);
    const snapshot = await writeRawSnapshot({
      entityType: params.sourceFamily,
      entityId: String(cursor.logId),
      sourcePath: mapping.sourcePath,
      payload,
      sourceHash: payloadHash,
      sourceUpdatedAt: cursor.dateLogged,
      ingestionRunId: params.ingestionRunId,
      parentIdentity: mapping.sourceEntityId
        ? { sourceEntityType: mapping.sourceEntityType, sourceEntityId: mapping.sourceEntityId }
        : {},
      pageWindow: { page: pageNumber, overlapStart, expectedThrough },
    });
    snapshotsWritten += snapshot.inserted ? 1 : 0;
    recordCount += 1;
    await upsertSourceChangeEvent({
      sourceFamily: params.sourceFamily,
      logId: cursor.logId,
      dateLogged: cursor.dateLogged,
      sourceEntityType: mapping.sourceEntityType,
      sourceEntityId: mapping.sourceEntityId === null ? null : String(mapping.sourceEntityId),
      message: stringValue(payload.Message),
      staffId: positiveInt(pickId(payload.Staff)),
      payload,
      payloadHash,
      ingestionRunId: params.ingestionRunId,
    });

    if (params.sourceFamily === "mobile_status") {
      const normalization = await normalizeSimproSnapshot({
        entity: "mobile_status",
        entityId: String(cursor.logId),
        payload,
        sourceSnapshotId: snapshot.id,
        sourceHash: payloadHash,
        fetchedAt: snapshotTimestamp(snapshot.extracted_at),
      });
      normalizedWritten += normalization.normalized ? 1 : 0;
      for (const item of normalization.affectedPeriods) affected.set(`${item.scope}:${item.periodStart}`, item);
    } else if (mapping.candidate) {
      const key = `${mapping.candidate.entity}:${mapping.candidate.entityId}`;
      candidates.set(key, {
        ...mapping.candidate,
        sourceHash: payloadHash,
        params: {
          trigger: "change_log",
          sourceLogId: cursor.logId,
          sourceLoggedAt: cursor.dateLogged,
        },
      });
    }
  }

  const completeWindow = boundaryReached || !page.continuationToken;
  if (completeWindow) {
    const committed = maxCursor(observedMax, watermark?.committedDateLogged && watermark.committedLogId
      ? { dateLogged: watermark.committedDateLogged, logId: watermark.committedLogId }
      : null);
    await commitSourceWatermark({
      sourceFamily: params.sourceFamily,
      committedDateLogged: committed?.dateLogged ?? null,
      committedLogId: committed?.logId ?? null,
      overlapStart,
      expectedThrough,
      recordCount,
      sourceHash: aggregateHash,
      gapDetected,
    });
    return {
      snapshotsWritten,
      normalizedWritten,
      affectedPeriods: [...affected.values()],
      continuationToken: null,
      requestsUsed: params.requestBudget.used,
      candidateRefreshes: [...candidates.values()],
    };
  }

  const continuationToken = {
    page: page.continuationToken?.page ?? pageNumber + 1,
    overlapStart,
    expectedThrough,
    lastCursor: previousCursor,
    observedMax,
    recordCount,
    aggregateHash,
    gapDetected,
  };
  await markSourceWatermarkAttempt({
    sourceFamily: params.sourceFamily,
    overlapStart,
    pageCursor: continuationToken,
    expectedThrough,
    gapDetected,
  });
  return {
    snapshotsWritten,
    normalizedWritten,
    affectedPeriods: [...affected.values()],
    continuationToken,
    requestsUsed: params.requestBudget.used,
    candidateRefreshes: [...candidates.values()],
  };
}

function listLogs(
  params: Parameters<typeof ingestChangeLogPage>[0],
  page: number,
): Promise<SimproPage<Record<string, unknown>>> {
  const options = { page, pageSize: 250, budget: params.requestBudget, query: { orderby: "-DateLogged,-ID" } };
  let result: Promise<SimproPage<unknown>>;
  switch (params.sourceFamily) {
    case "quote_logs": result = params.endpoints.listQuoteLogs(options); break;
    case "job_logs": result = params.endpoints.listJobLogs(options); break;
    case "schedule_logs": result = params.endpoints.listScheduleLogs(options); break;
    case "mobile_status": result = params.endpoints.listMobileStatusLogs(options); break;
  }
  return result.then((value) => ({ ...value, rows: value.rows.map(asRecord) }));
}

function logMapping(sourceFamily: ChangeLogFamily, payload: Record<string, unknown>) {
  if (sourceFamily === "quote_logs") {
    const entityId = positiveInt(payload.QuoteID);
    return {
      sourcePath: "/logs/quotes/",
      sourceEntityType: "quote",
      sourceEntityId: entityId,
      candidate: entityId ? { entity: "quote_nested" as const, entityId } : null,
    };
  }
  if (sourceFamily === "job_logs") {
    const entityId = positiveInt(payload.JobID);
    return {
      sourcePath: "/logs/jobs/",
      sourceEntityType: "job",
      sourceEntityId: entityId,
      candidate: entityId ? { entity: "job_nested" as const, entityId } : null,
    };
  }
  if (sourceFamily === "schedule_logs") {
    const entityId = positiveInt(payload.ScheduleID);
    return {
      sourcePath: "/logs/schedules/",
      sourceEntityType: "schedule",
      sourceEntityId: entityId,
      candidate: entityId ? { entity: "schedules" as const, entityId } : null,
    };
  }
  const workOrder = asOptionalRecord(payload.WorkOrder);
  return {
    sourcePath: "/logs/mobileStatus/",
    sourceEntityType: "job",
    sourceEntityId: positiveInt(workOrder?.ProjectID),
    candidate: null,
  };
}

export function calculateOverlapStart(committedDateLogged: string | null | undefined, now: Date, overlapHours = 2) {
  const committed = committedDateLogged ? new Date(committedDateLogged) : now;
  const baseline = Number.isNaN(committed.getTime()) ? now : committed;
  return new Date(baseline.getTime() - overlapHours * 60 * 60 * 1000).toISOString();
}

export function compareLogCursor(left: LogCursor, right: LogCursor) {
  const dateDifference = new Date(left.dateLogged).getTime() - new Date(right.dateLogged).getTime();
  return dateDifference === 0 ? left.logId - right.logId : dateDifference;
}

function maxCursor(left: LogCursor | null, right: LogCursor | null) {
  if (!left) return right;
  if (!right) return left;
  return compareLogCursor(left, right) >= 0 ? left : right;
}

function logCursor(payload: Record<string, unknown>): LogCursor | null {
  const dateLogged = stringValue(payload.DateLogged);
  const logId = positiveInt(pickId(payload));
  if (!dateLogged || logId === null || Number.isNaN(new Date(dateLogged).getTime())) return null;
  return { dateLogged: new Date(dateLogged).toISOString(), logId };
}

function parseCursor(value: unknown): LogCursor | null {
  const row = asOptionalRecord(value);
  const dateLogged = stringValue(row?.dateLogged);
  const logId = positiveInt(row?.logId);
  return dateLogged && logId !== null ? { dateLogged, logId } : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  const row = asOptionalRecord(value);
  if (!row) throw new Error("Expected Simpro change-log object");
  return row;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

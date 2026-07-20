import { isSimproNotFound, sourceHash, type RequestBudget, type SimproPage } from "@/lib/simpro/client";
import { SimproEndpoints } from "@/lib/simpro/endpoints";
import {
  beginProjectNestedTraversal,
  emptyNestedTraversalSeen,
  enqueueAffectedRollups,
  finalizeProjectNestedTraversal,
  mapCostCenterFact,
  mapItemFact,
  mapLaborFact,
  mapWorkOrderFact,
  markProjectSourceUnavailable,
  persistProjectCostCenter,
  persistProjectItem,
  persistProjectLabor,
  persistProjectWorkOrder,
  persistScheduleBlocks,
  withCurrentProjectNestedTraversal,
  type NestedTraversalSeen,
  type ProjectItemType,
  type ProjectType,
  type SourceProvenance,
} from "@/lib/simpro/normalize-nested";
import {
  acquireSchedulePublicationAuthority,
  activeScheduleTechnicianPeriods,
  normalizeSimproSnapshot,
  projectTotalExTax,
} from "@/lib/simpro/normalize";
import { pickId } from "@/lib/simpro/schemas";
import type { PostgresQuery } from "@/lib/store/postgres";
import type { RollupScope } from "@/lib/store/rollups";
import { snapshotTimestamp, writeRawSnapshot } from "@/lib/store/snapshots";

type CollectionKind = "labor" | "catalogs" | "serviceFees" | "oneOffs" | "prebuilds" | "schedules" | "workOrders" | "stock";
type DetailKind = "costCenter" | Exclude<CollectionKind, "stock">;

type NestedTask =
  | { kind: "projectDetail" }
  | { kind: "sections"; page: number }
  | { kind: "costCenters"; sectionId: number; page: number }
  | { kind: "collection"; sectionId: number; costCenterId: number; collection: CollectionKind; page: number }
  | { kind: "detail"; sectionId: number; costCenterId: number; detail: DetailKind; resourceId: number };

type NestedState = {
  version: 2;
  projectType: ProjectType;
  projectId: number;
  generation: number;
  rootSnapshotId: number | null;
  pending: NestedTask[];
  seen: NestedTraversalSeen;
};

export type NestedIngestionResult = {
  snapshotsWritten: number;
  normalizedWritten: number;
  affectedPeriods: Array<{ scope: RollupScope; periodStart: string }>;
  continuationToken: Record<string, unknown> | null;
  requestsUsed: number;
};

export async function ingestProjectNested(params: {
  endpoints: SimproEndpoints;
  projectType: ProjectType;
  projectId: number;
  continuationToken?: Record<string, unknown> | null;
  requestBudget: RequestBudget;
  ingestionRunId?: number | null;
}): Promise<NestedIngestionResult> {
  const state = await restoreState(params);
  let snapshotsWritten = 0;
  let normalizedWritten = 0;
  const affected = new Map<string, { scope: RollupScope; periodStart: string }>();

  const recordAffected = (rows: Array<{ scope: RollupScope; periodStart: string }>) => {
    for (const row of rows) affected.set(`${row.scope}:${row.periodStart}`, row);
  };
  const publishCurrent = <T>(callback: (query: PostgresQuery) => Promise<T>) =>
    withCurrentProjectNestedTraversal({
      projectType: params.projectType,
      projectId: params.projectId,
      generation: state.generation,
      callback,
    });
  const staleTraversalResult = (): NestedIngestionResult => ({
    snapshotsWritten,
    normalizedWritten,
    affectedPeriods: [...affected.values()],
    continuationToken: null,
    requestsUsed: params.requestBudget.used,
  });

  while (state.pending.length > 0 && params.requestBudget.used < params.requestBudget.limit) {
    const task = state.pending.shift();
    if (!task) break;

    if (task.kind === "projectDetail") {
      let payload: Record<string, unknown>;
      try {
        payload = asRecord(params.projectType === "quote"
          ? await params.endpoints.getQuote(params.projectId, params.requestBudget)
          : await params.endpoints.getJob(params.projectId, params.requestBudget));
      } catch (error) {
        if (!isSimproNotFound(error)) throw error;
        const entityType = `${params.projectType}_details`;
        const tombstone = {
          sourceUnavailable: true,
          reason: "not_found",
          status: 404,
          projectType: params.projectType,
          projectId: params.projectId,
          traversalGeneration: state.generation,
        };
        const sourceUnavailable = await markProjectSourceUnavailable(params.projectType, params.projectId, {
          expectedGeneration: state.generation,
          tombstoneSnapshot: {
            entityType,
            entityId: String(params.projectId),
            sourcePath: `/${params.projectType === "quote" ? "quotes" : "jobs"}/${params.projectId}`,
            payload: tombstone,
            sourceHash: sourceHash(tombstone),
            ingestionRunId: params.ingestionRunId,
            parentIdentity: { projectType: params.projectType, projectId: params.projectId },
          },
        });
        snapshotsWritten += sourceUnavailable.snapshotInserted ? 1 : 0;
        recordAffected(sourceUnavailable.affectedPeriods);
        return {
          snapshotsWritten,
          normalizedWritten,
          affectedPeriods: [...affected.values()],
          continuationToken: null,
          requestsUsed: params.requestBudget.used,
        };
      }
      const rawInput = {
        params,
        entityType: `${params.projectType}_details`,
        entityId: String(params.projectId),
        path: `/${params.projectType === "quote" ? "quotes" : "jobs"}/${params.projectId}`,
        payload,
        parentIdentity: { projectType: params.projectType, projectId: params.projectId },
      };
      try {
        projectTotalExTax(payload, params.projectType, params.projectId);
      } catch (error) {
        const quarantined = await publishCurrent((query) => persistRaw(rawInput, query));
        if (!quarantined.applied || !quarantined.value) return staleTraversalResult();
        snapshotsWritten += quarantined.value.inserted ? 1 : 0;
        throw error;
      }
      const guardedNormalization = await publishCurrent(async (query) => {
        const snapshot = await persistRaw(rawInput, query);
        const normalization = await normalizeSimproSnapshot({
          entity: params.projectType === "quote" ? "quotes" : "jobs",
          entityId: String(params.projectId),
          payload,
          sourceSnapshotId: snapshot.id,
          sourceHash: snapshot.hash,
          fetchedAt: snapshot.extractedAt,
          query,
        });
        return { snapshot, normalization };
      });
      if (!guardedNormalization.applied || !guardedNormalization.value) return staleTraversalResult();
      const { snapshot, normalization } = guardedNormalization.value;
      snapshotsWritten += snapshot.inserted ? 1 : 0;
      state.rootSnapshotId = snapshot.id;
      normalizedWritten += normalization.normalized ? 1 : 0;
      recordAffected(normalization.affectedPeriods);
      state.pending.unshift({ kind: "sections", page: 1 });
      continue;
    }

    if (task.kind === "sections") {
      const page = params.projectType === "quote"
        ? await params.endpoints.listQuoteSections(params.projectId, pageOptions(task.page, params.requestBudget))
        : await params.endpoints.listJobSections(params.projectId, pageOptions(task.page, params.requestBudget));
      if (page.continuationToken) state.pending.unshift({ ...task, page: page.continuationToken.page });
      for (const row of page.rows) {
        const payload = asRecord(row);
        const sectionId = requiredId(payload, "section");
        const publication = await publishCurrent((query) => persistRaw({
          params,
          entityType: `${params.projectType}_section`,
          entityId: `${params.projectId}:${sectionId}`,
          path: projectBase(params.projectType, params.projectId, sectionId),
          payload,
          parentIdentity: { projectType: params.projectType, projectId: params.projectId, sectionId },
          page: task.page,
        }, query));
        if (!publication.applied || !publication.value) return staleTraversalResult();
        const snapshot = publication.value;
        snapshotsWritten += snapshot.inserted ? 1 : 0;
        state.pending.push({ kind: "costCenters", sectionId, page: 1 });
      }
      continue;
    }

    if (task.kind === "costCenters") {
      const page = params.projectType === "quote"
        ? await params.endpoints.listQuoteCostCenters(params.projectId, task.sectionId, pageOptions(task.page, params.requestBudget))
        : await params.endpoints.listJobCostCenters(params.projectId, task.sectionId, pageOptions(task.page, params.requestBudget));
      if (page.continuationToken) state.pending.unshift({ ...task, page: page.continuationToken.page });
      for (const row of page.rows) {
        const payload = asRecord(row);
        const costCenterId = requiredId(payload, "cost center");
        const publication = await publishCurrent(async (query) => {
          const snapshot = await persistRaw({
            params,
            entityType: `${params.projectType}_cost_center`,
            entityId: `${params.projectId}:${task.sectionId}:${costCenterId}`,
            path: costCenterPath(params.projectType, params.projectId, task.sectionId, costCenterId),
            payload,
            parentIdentity: { projectType: params.projectType, projectId: params.projectId, sectionId: task.sectionId, costCenterId },
            page: task.page,
          }, query);
          await persistProjectCostCenter({
            projectType: params.projectType,
            projectId: params.projectId,
            fact: mapCostCenterFact(task.sectionId, payload),
            provenance: snapshot.provenance,
            traversalGeneration: state.generation,
            query,
          });
          return snapshot;
        });
        if (!publication.applied || !publication.value) return staleTraversalResult();
        const snapshot = publication.value;
        snapshotsWritten += snapshot.inserted ? 1 : 0;
        normalizedWritten += 1;
        addSeen(state.seen.costCenters, `${task.sectionId}:${costCenterId}`);
        state.pending.push({ kind: "detail", sectionId: task.sectionId, costCenterId, detail: "costCenter", resourceId: costCenterId });
        for (const collection of collectionsFor(params.projectType)) {
          state.pending.push({ kind: "collection", sectionId: task.sectionId, costCenterId, collection, page: 1 });
        }
      }
      continue;
    }

    if (task.kind === "collection") {
      const page = await listCollection(params, task);
      if (page.continuationToken) state.pending.unshift({ ...task, page: page.continuationToken.page });
      for (const row of page.rows) {
        const payload = asRecord(row);
        const resourceId = collectionResourceId(task.collection, payload);
        const identity = `${params.projectId}:${task.sectionId}:${task.costCenterId}:${task.collection}:${resourceId}`;
        const publication = await publishCurrent(async (query) => {
          const snapshot = await persistRaw({
            params,
            entityType: `${params.projectType}_${singular(task.collection)}`,
            entityId: identity,
            path: `${costCenterPath(params.projectType, params.projectId, task.sectionId, task.costCenterId)}/${task.collection}/`,
            payload,
            parentIdentity: {
              projectType: params.projectType,
              projectId: params.projectId,
              sectionId: task.sectionId,
              costCenterId: task.costCenterId,
              ...(task.collection === "schedules" ? { scheduleId: resourceId } : {}),
            },
            page: task.page,
          }, query);
          const normalized = await persistCollectionRow(params, state, task, payload, snapshot.provenance, query);
          return { snapshot, normalized };
        });
        if (!publication.applied || !publication.value) return staleTraversalResult();
        const { snapshot, normalized } = publication.value;
        snapshotsWritten += snapshot.inserted ? 1 : 0;
        normalizedWritten += normalized;
        if (task.collection !== "stock") {
          state.pending.push({
            kind: "detail",
            sectionId: task.sectionId,
            costCenterId: task.costCenterId,
            detail: task.collection,
            resourceId,
          });
        }
      }
      continue;
    }

    const payload = await getDetail(params, task);
    const observedAt = new Date().toISOString();
    const path = detailPath(params.projectType, params.projectId, task);
    if (task.detail === "schedules") {
      const guardedSchedule = await withCurrentProjectNestedTraversal({
        projectType: params.projectType,
        projectId: params.projectId,
        generation: state.generation,
        callback: async (query) => {
          const enriched = { ...payload, Type: params.projectType, Reference: `${params.projectId}-${task.costCenterId}` };
          const authority = await acquireSchedulePublicationAuthority({
            entityId: String(task.resourceId),
            payload: enriched,
            fetchedAt: observedAt,
            query,
          });
          if (!authority.applied) return { stale: true as const };
          const snapshot = await persistRaw({
            params,
            entityType: `${params.projectType}_${singular(task.detail)}_detail`,
            entityId: `${params.projectId}:${task.sectionId}:${task.costCenterId}:${task.detail}:${task.resourceId}`,
            path,
            payload,
            parentIdentity: {
              projectType: params.projectType,
              projectId: params.projectId,
              sectionId: task.sectionId,
              costCenterId: task.costCenterId,
              scheduleId: task.resourceId,
            },
            fetchedAt: observedAt,
          }, query);
          const normalization = await normalizeSimproSnapshot({
            entity: "schedules",
            entityId: String(task.resourceId),
            payload: enriched,
            sourceSnapshotId: snapshot.provenance.sourceSnapshotId,
            sourceHash: snapshot.provenance.sourceHash,
            fetchedAt: snapshot.provenance.fetchedAt,
            traversalGeneration: state.generation,
            query,
          });
          if (normalization.normalized) {
            await persistScheduleBlocks({
              scheduleId: task.resourceId,
              payload: enriched,
              provenance: snapshot.provenance,
              referenceType: params.projectType,
              referenceId: params.projectId,
              traversalGeneration: state.generation,
              query,
            });
          }
          const currentPeriods = await activeScheduleTechnicianPeriods(task.resourceId, query);
          const affectedPeriods = [...authority.affectedPeriods, ...currentPeriods];
          await enqueueAffectedRollups(
            affectedPeriods,
            `schedule ${task.resourceId} nested publication`,
            query,
          );
          return { stale: false as const, snapshot, normalization, affectedPeriods };
        },
      });
      if (!guardedSchedule.applied || !guardedSchedule.value) {
        return {
          snapshotsWritten,
          normalizedWritten,
          affectedPeriods: [...affected.values()],
          continuationToken: null,
          requestsUsed: params.requestBudget.used,
        };
      }
      if (guardedSchedule.value.stale) continue;
      snapshotsWritten += guardedSchedule.value.snapshot.inserted ? 1 : 0;
      normalizedWritten += guardedSchedule.value.normalization.normalized ? 1 : 0;
      recordAffected(guardedSchedule.value.affectedPeriods);
      continue;
    }
    const publication = await publishCurrent(async (query) => {
      const snapshot = await persistRaw({
        params,
        entityType: `${params.projectType}_${singular(task.detail)}_detail`,
        entityId: `${params.projectId}:${task.sectionId}:${task.costCenterId}:${task.detail}:${task.resourceId}`,
        path,
        payload,
        parentIdentity: { projectType: params.projectType, projectId: params.projectId, sectionId: task.sectionId, costCenterId: task.costCenterId },
      }, query);
      if (task.detail === "costCenter") {
        await persistProjectCostCenter({
          projectType: params.projectType,
          projectId: params.projectId,
          fact: mapCostCenterFact(task.sectionId, payload),
          provenance: snapshot.provenance,
          traversalGeneration: state.generation,
          query,
        });
        return { snapshot, normalized: 1 };
      }
      const normalized = await persistCollectionDetail(
        params,
        state,
        task,
        payload,
        snapshot.provenance,
        query,
      );
      return { snapshot, normalized };
    });
    if (!publication.applied || !publication.value) return staleTraversalResult();
    const { snapshot, normalized } = publication.value;
    snapshotsWritten += snapshot.inserted ? 1 : 0;
    normalizedWritten += normalized;
  }

  if (state.pending.length === 0) {
    if (state.rootSnapshotId === null) {
      throw new Error("Completed nested traversal is missing its exact root snapshot identity.");
    }
    const finalization = await finalizeProjectNestedTraversal({
      projectType: params.projectType,
      projectId: params.projectId,
      generation: state.generation,
      rootSnapshotId: state.rootSnapshotId,
      seen: state.seen,
    });
    recordAffected(finalization.affectedPeriods);
  }

  return {
    snapshotsWritten,
    normalizedWritten,
    affectedPeriods: [...affected.values()],
    continuationToken: state.pending.length ? state as unknown as Record<string, unknown> : null,
    requestsUsed: params.requestBudget.used,
  };
}

async function persistCollectionRow(
  params: Parameters<typeof ingestProjectNested>[0],
  state: NestedState,
  task: Extract<NestedTask, { kind: "collection" }>,
  payload: Record<string, unknown>,
  provenance: SourceProvenance,
  query: PostgresQuery,
) {
  if (task.collection === "labor") {
    const fact = mapLaborFact(task.sectionId, task.costCenterId, payload);
    await persistProjectLabor({ projectType: params.projectType, projectId: params.projectId, fact, provenance, traversalGeneration: state.generation, query });
    addSeen(state.seen.labor, `${task.sectionId}:${task.costCenterId}:${fact.laborId}`);
    return 1;
  }
  if (isItemCollection(task.collection)) {
    const fact = mapItemFact(task.sectionId, task.costCenterId, itemType(task.collection), payload);
    await persistProjectItem({ projectType: params.projectType, projectId: params.projectId, fact, provenance, traversalGeneration: state.generation, query });
    addSeen(state.seen.items, `${task.sectionId}:${task.costCenterId}:${fact.itemType}:${fact.itemId}`);
    return 1;
  }
  if (task.collection === "workOrders") {
    const fact = mapWorkOrderFact(task.sectionId, task.costCenterId, payload);
    await persistProjectWorkOrder({ projectType: params.projectType, projectId: params.projectId, fact, provenance, traversalGeneration: state.generation, query });
    addSeen(state.seen.workOrders, `${task.sectionId}:${task.costCenterId}:${fact.workOrderId}`);
    return 1;
  }
  return 0;
}

async function persistCollectionDetail(
  params: Parameters<typeof ingestProjectNested>[0],
  state: NestedState,
  task: Extract<NestedTask, { kind: "detail" }>,
  payload: Record<string, unknown>,
  provenance: SourceProvenance,
  query: PostgresQuery,
) {
  if (task.detail === "labor") {
    const fact = mapLaborFact(task.sectionId, task.costCenterId, payload);
    await persistProjectLabor({ projectType: params.projectType, projectId: params.projectId, fact, provenance, traversalGeneration: state.generation, query });
    addSeen(state.seen.labor, `${task.sectionId}:${task.costCenterId}:${fact.laborId}`);
    return 1;
  }
  if (isItemCollection(task.detail)) {
    const fact = mapItemFact(task.sectionId, task.costCenterId, itemType(task.detail), payload);
    await persistProjectItem({ projectType: params.projectType, projectId: params.projectId, fact, provenance, traversalGeneration: state.generation, query });
    addSeen(state.seen.items, `${task.sectionId}:${task.costCenterId}:${fact.itemType}:${fact.itemId}`);
    return 1;
  }
  if (task.detail === "workOrders") {
    const fact = mapWorkOrderFact(task.sectionId, task.costCenterId, payload);
    await persistProjectWorkOrder({ projectType: params.projectType, projectId: params.projectId, fact, provenance, traversalGeneration: state.generation, query });
    addSeen(state.seen.workOrders, `${task.sectionId}:${task.costCenterId}:${fact.workOrderId}`);
    return 1;
  }
  return 0;
}

async function listCollection(
  params: Parameters<typeof ingestProjectNested>[0],
  task: Extract<NestedTask, { kind: "collection" }>,
): Promise<SimproPage<Record<string, unknown>>> {
  const options = pageOptions(task.page, params.requestBudget);
  const args = [params.projectId, task.sectionId, task.costCenterId] as const;
  let page: SimproPage<unknown>;
  if (params.projectType === "quote") {
    switch (task.collection) {
      case "labor": page = await params.endpoints.listQuoteLabor(...args, options); break;
      case "catalogs": page = await params.endpoints.listQuoteCatalogs(...args, options); break;
      case "serviceFees": page = await params.endpoints.listQuoteServiceFees(...args, options); break;
      case "oneOffs": page = await params.endpoints.listQuoteOneOffs(...args, options); break;
      case "prebuilds": page = await params.endpoints.listQuotePrebuilds(...args, options); break;
      case "schedules": page = await params.endpoints.listQuoteSchedules(...args, options); break;
      case "workOrders": page = await params.endpoints.listQuoteWorkOrders(...args, options); break;
      case "stock": throw new Error("Swagger does not expose quote stock");
    }
  } else if (task.collection === "stock") {
    const rows = await params.endpoints.listJobStock(...args, params.requestBudget);
    page = { rows, page: 1, pageSize: rows.length, hasMore: false, continuationToken: null };
  } else {
    switch (task.collection) {
      case "labor": page = await params.endpoints.listJobLabor(...args, options); break;
      case "catalogs": page = await params.endpoints.listJobCatalogs(...args, options); break;
      case "serviceFees": page = await params.endpoints.listJobServiceFees(...args, options); break;
      case "oneOffs": page = await params.endpoints.listJobOneOffs(...args, options); break;
      case "prebuilds": page = await params.endpoints.listJobPrebuilds(...args, options); break;
      case "schedules": page = await params.endpoints.listJobSchedules(...args, options); break;
      case "workOrders": page = await params.endpoints.listJobWorkOrders(...args, options); break;
    }
  }
  return { ...page, rows: page.rows.map(asRecord) };
}

async function getDetail(
  params: Parameters<typeof ingestProjectNested>[0],
  task: Extract<NestedTask, { kind: "detail" }>,
): Promise<Record<string, unknown>> {
  const args = [params.projectId, task.sectionId, task.costCenterId] as const;
  let payload: unknown;
  if (params.projectType === "quote") {
    switch (task.detail) {
      case "costCenter": payload = await params.endpoints.getQuoteCostCenter(...args, params.requestBudget); break;
      case "labor": payload = await params.endpoints.getQuoteLabor(...args, task.resourceId, params.requestBudget); break;
      case "catalogs": payload = await params.endpoints.getQuoteCatalog(...args, task.resourceId, params.requestBudget); break;
      case "serviceFees": payload = await params.endpoints.getQuoteServiceFee(...args, task.resourceId, params.requestBudget); break;
      case "oneOffs": payload = await params.endpoints.getQuoteOneOff(...args, task.resourceId, params.requestBudget); break;
      case "prebuilds": payload = await params.endpoints.getQuotePrebuild(...args, task.resourceId, params.requestBudget); break;
      case "schedules": payload = await params.endpoints.getQuoteSchedule(...args, task.resourceId, params.requestBudget); break;
      case "workOrders": payload = await params.endpoints.getQuoteWorkOrder(...args, task.resourceId, params.requestBudget); break;
    }
  } else {
    switch (task.detail) {
      case "costCenter": payload = await params.endpoints.getJobCostCenter(...args, params.requestBudget); break;
      case "labor": payload = await params.endpoints.getJobLabor(...args, task.resourceId, params.requestBudget); break;
      case "catalogs": payload = await params.endpoints.getJobCatalog(...args, task.resourceId, params.requestBudget); break;
      case "serviceFees": payload = await params.endpoints.getJobServiceFee(...args, task.resourceId, params.requestBudget); break;
      case "oneOffs": payload = await params.endpoints.getJobOneOff(...args, task.resourceId, params.requestBudget); break;
      case "prebuilds": payload = await params.endpoints.getJobPrebuild(...args, task.resourceId, params.requestBudget); break;
      case "schedules": payload = await params.endpoints.getJobSchedule(...args, task.resourceId, params.requestBudget); break;
      case "workOrders": payload = await params.endpoints.getJobWorkOrder(...args, task.resourceId, params.requestBudget); break;
    }
  }
  return asRecord(payload);
}

async function persistRaw(input: {
  params: Parameters<typeof ingestProjectNested>[0];
  entityType: string;
  entityId: string;
  path: string;
  payload: Record<string, unknown>;
  parentIdentity: Record<string, unknown>;
  page?: number;
  fetchedAt?: string;
}, query?: PostgresQuery) {
  const hash = sourceHash(input.payload);
  const snapshot = await writeRawSnapshot({
    entityType: input.entityType,
    entityId: input.entityId,
    sourcePath: input.path,
    payload: input.payload,
    sourceHash: hash,
    sourceUpdatedAt: stringValue(input.payload.DateModified ?? input.payload.DateLogged),
    ingestionRunId: input.params.ingestionRunId,
    parentIdentity: input.parentIdentity,
    pageWindow: input.page ? { page: input.page } : null,
  }, query);
  const extractedAt = snapshotTimestamp(snapshot.extracted_at);
  const fetchedAt = input.fetchedAt ?? extractedAt;
  return {
    id: snapshot.id,
    inserted: snapshot.inserted,
    hash,
    extractedAt,
    provenance: { sourceSnapshotId: snapshot.id, sourceHash: hash, fetchedAt },
  };
}

async function restoreState(params: Parameters<typeof ingestProjectNested>[0]): Promise<NestedState> {
  const token = params.continuationToken;
  if (token?.version === 2 && token.projectType === params.projectType && Number(token.projectId) === params.projectId && Array.isArray(token.pending)) {
    const generation = Number(token.generation);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error("Nested continuation token has an invalid traversal generation.");
    }
    return {
      version: 2,
      projectType: params.projectType,
      projectId: params.projectId,
      generation,
      rootSnapshotId: positiveIntegerOrNull(token.rootSnapshotId),
      pending: token.pending as NestedTask[],
      seen: normalizeSeen(token.seen),
    };
  }
  return {
    version: 2,
    projectType: params.projectType,
    projectId: params.projectId,
    generation: await beginProjectNestedTraversal(params.projectType, params.projectId),
    rootSnapshotId: null,
    pending: [{ kind: "projectDetail" }],
    seen: emptyNestedTraversalSeen(),
  };
}

function normalizeSeen(value: unknown): NestedTraversalSeen {
  const row = asOptionalRecord(value);
  return {
    costCenters: stringArray(row?.costCenters),
    labor: stringArray(row?.labor),
    items: stringArray(row?.items),
    workOrders: stringArray(row?.workOrders),
  };
}

function pageOptions(page: number, budget: RequestBudget) {
  return { page, pageSize: 250, budget, query: { orderby: "ID" } };
}

function collectionsFor(projectType: ProjectType): CollectionKind[] {
  const shared: CollectionKind[] = ["labor", "catalogs", "serviceFees", "oneOffs", "prebuilds", "schedules", "workOrders"];
  return projectType === "job" ? [...shared, "stock"] : shared;
}

function projectBase(projectType: ProjectType, projectId: number, sectionId: number) {
  return `/${projectType === "quote" ? "quotes" : "jobs"}/${projectId}/sections/${sectionId}`;
}

function costCenterPath(projectType: ProjectType, projectId: number, sectionId: number, costCenterId: number) {
  return `${projectBase(projectType, projectId, sectionId)}/costCenters/${costCenterId}`;
}

function detailPath(projectType: ProjectType, projectId: number, task: Extract<NestedTask, { kind: "detail" }>) {
  const base = costCenterPath(projectType, projectId, task.sectionId, task.costCenterId);
  return task.detail === "costCenter" ? base : `${base}/${task.detail}/${task.resourceId}`;
}

function singular(value: CollectionKind | DetailKind) {
  const names: Record<CollectionKind | DetailKind, string> = {
    costCenter: "cost_center",
    labor: "labor",
    catalogs: "catalog",
    serviceFees: "service_fee",
    oneOffs: "one_off",
    prebuilds: "prebuild",
    schedules: "schedule",
    workOrders: "work_order",
    stock: "stock",
  };
  return names[value];
}

function itemType(collection: Extract<CollectionKind, "catalogs" | "serviceFees" | "oneOffs" | "prebuilds" | "stock">): ProjectItemType {
  return ({ catalogs: "catalog", serviceFees: "service_fee", oneOffs: "one_off", prebuilds: "prebuild", stock: "stock" } as const)[collection];
}

function isItemCollection(value: CollectionKind | DetailKind): value is Extract<CollectionKind, "catalogs" | "serviceFees" | "oneOffs" | "prebuilds" | "stock"> {
  return ["catalogs", "serviceFees", "oneOffs", "prebuilds", "stock"].includes(value);
}

function collectionResourceId(collection: CollectionKind, payload: Record<string, unknown>) {
  if (collection === "stock") {
    const id = Number(pickId(payload.Catalog));
    if (Number.isInteger(id) && id > 0) return id;
  }
  return requiredId(payload, collection);
}

function requiredId(payload: Record<string, unknown>, label: string) {
  const id = Number(pickId(payload));
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Missing ${label} ID`);
  return id;
}

function addSeen(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  const row = asOptionalRecord(value);
  if (!row) throw new Error("Expected Simpro object payload");
  return row;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function positiveIntegerOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

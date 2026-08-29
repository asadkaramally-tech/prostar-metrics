import { sourceHash } from "@/lib/simpro/client";
import {
  acquireMissingScheduleAuthority,
  acquireScheduleAdvisoryLock,
  allocateJobGrossProfitToCostCenters,
  extractJobFinancialTotals,
  quoteIdsAffectedByJobEvidence,
  scheduleBlockIdentity,
  type JobFinancialTotals,
} from "@/lib/simpro/normalize";
import { pickId, pickName } from "@/lib/simpro/schemas";
import { businessCurrentMonth } from "@/lib/backfill/plan";
import { DASHBOARD_HISTORY_START } from "@/lib/metrics/periods";
import {
  queryPostgres,
  withPostgresTransaction,
  type PostgresQuery,
} from "@/lib/store/postgres";
import { reprojectImportedJobCategories } from "@/lib/store/job-category-rebuild";
import {
  acquireQuoteCategoryAdvisoryLock,
  categoryForVerifiedConfiguredCostCenterId,
  QUOTE_CATEGORY_ADVISORY_LOCK_KEY,
  reprojectPersistedQuoteCategory,
} from "@/lib/store/quote-category-rebuild";
import {
  acquireQuoteClassificationAdvisoryLock,
  reclassifyPersistedQuote,
} from "@/lib/store/quote-classification-rebuild";
import { enqueueRollupRebuild } from "@/lib/store/read-model-rebuilds";
import {
  writeRawSnapshot,
  type RawSnapshotWrite,
} from "@/lib/store/snapshots";

export type ProjectType = "quote" | "job";
export type ProjectItemType = "catalog" | "service_fee" | "one_off" | "prebuild" | "stock";

export type SourceProvenance = {
  sourceSnapshotId: number | null;
  sourceHash: string;
  fetchedAt: string | null;
};

export type NestedTraversalSeen = {
  costCenters: string[];
  labor: string[];
  items: string[];
  workOrders: string[];
};

export type NestedFinalizationTransaction = <T>(
  callback: (query: PostgresQuery) => Promise<T>,
) => Promise<T>;

export type NestedFinalizationResult = {
  applied: boolean;
  affectedPeriods: Array<{ scope: "quotes" | "jobs" | "technicians" | "commissions"; periodStart: string }>;
};

type AffectedPeriod = NestedFinalizationResult["affectedPeriods"][number];

export type SourceUnavailableResult = NestedFinalizationResult & {
  snapshotInserted?: boolean;
};

export type CostCenterFact = {
  sectionId: number;
  costCenterId: number;
  configuredCostCenterId: number | null;
  configuredCostCenterName: string | null;
  name: string | null;
  category: string;
  laborHours: number | null;
  sellValue: number | null;
  costValue: number | null;
  materialCostValue: number | null;
  totals: JobFinancialTotals;
};

export type LaborFact = {
  sectionId: number;
  costCenterId: number;
  laborId: number;
  laborTypeId: number | null;
  laborTypeName: string | null;
  quantityHours: number | null;
  sellExTax: number | null;
  actualCost: number | null;
};

export type ItemFact = {
  sectionId: number;
  costCenterId: number;
  itemType: ProjectItemType;
  itemId: string;
  sourceItemId: number | null;
  description: string | null;
  quantity: number | null;
  billableStatus: string | null;
  sellExTax: number | null;
  estimatedCost: number | null;
  actualCost: number | null;
};

export type WorkOrderFact = {
  sectionId: number;
  costCenterId: number;
  workOrderId: number;
  staffId: number | null;
  workOrderDate: string | null;
  approved: boolean | null;
  scheduledHours: number | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
};

export function emptyNestedTraversalSeen(): NestedTraversalSeen {
  return { costCenters: [], labor: [], items: [], workOrders: [] };
}

export async function beginProjectNestedTraversal(
  projectType: ProjectType,
  projectId: number,
  transaction: NestedFinalizationTransaction = withPostgresTransaction,
): Promise<number> {
  return transaction(async (query) => {
    if (projectType === "quote") await acquireQuoteCategoryAdvisoryLock(query);
    const result = await query<{ generation: string }>(
      `insert into metrics.project_nested_traversals (
         project_type, project_id, generation, status, started_at, finalized_at, updated_at
       ) values ($1, $2, 1, 'active', now(), null, now())
       on conflict (project_type, project_id) do update set
         generation = metrics.project_nested_traversals.generation + 1,
         status = 'active',
         started_at = now(),
         finalized_at = null,
         updated_at = now()
       returning generation::text`,
      [projectType, projectId],
    );
    const generation = Number(result.rows[0]?.generation);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error(`Unable to start ${projectType} ${projectId} nested traversal.`);
    }
    return generation;
  });
}

export async function withCurrentProjectNestedTraversal<T>(params: {
  projectType: ProjectType;
  projectId: number;
  generation: number;
  callback: (query: PostgresQuery) => Promise<T>;
  transaction?: NestedFinalizationTransaction;
}): Promise<{ applied: boolean; value: T | null }> {
  const transaction = params.transaction ?? withPostgresTransaction;
  return transaction(async (query) => {
    if (params.projectType === "quote") {
      await acquireQuoteClassificationAdvisoryLock(query);
      await acquireQuoteCategoryAdvisoryLock(query);
    }
    const authority = await query(
      `select generation
         from metrics.project_nested_traversals
        where project_type = $1 and project_id = $2
          and generation = $3 and status = 'active'
        for update`,
      [params.projectType, params.projectId, params.generation],
    );
    if (!authority.rows[0]) return { applied: false, value: null };
    return { applied: true, value: await params.callback(query) };
  });
}

export function mapCostCenterFact(sectionId: number, payload: Record<string, unknown>): CostCenterFact {
  const costCenterId = requiredId(payload.ID, "cost center ID");
  const configuredCostCenterId = numericId(pickId(payload.CostCenter));
  const configuredName = pickName(payload.CostCenter);
  const name = stringValue(payload.Name) ?? configuredName;
  const totals = extractJobFinancialTotals(payload);

  return {
    sectionId,
    costCenterId,
    configuredCostCenterId,
    configuredCostCenterName: configuredName,
    name,
    category: categoryForVerifiedConfiguredCostCenterId(configuredCostCenterId) ?? "Unclassified",
    laborHours: totals.laborHoursEstimate,
    sellValue: moneyAt(payload.Total, "ExTax"),
    costValue: sumPresent(
      totals.materialsCostActual ?? totals.materialsCostEstimate,
      totals.resourceTotalActual ?? totals.resourceTotalEstimate,
    ),
    materialCostValue: totals.materialsCostActual ?? totals.materialsCostEstimate,
    totals,
  };
}

export function mapLaborFact(
  sectionId: number,
  costCenterId: number,
  payload: Record<string, unknown>,
): LaborFact {
  const quantity = moneyAt(payload.Total, "Qty");
  const laborRate = numberValue(payload.LaborRate);
  return {
    sectionId,
    costCenterId,
    laborId: requiredId(payload.ID, "labor ID"),
    laborTypeId: numericId(pickId(payload.LaborType)),
    laborTypeName: pickName(payload.LaborType),
    quantityHours: quantity,
    sellExTax: moneyAt(pathValue(payload.Total, ["Amount"]), "ExTax"),
    actualCost: quantity !== null && laborRate !== null ? roundMoney(quantity * laborRate) : null,
  };
}

export function mapItemFact(
  sectionId: number,
  costCenterId: number,
  itemType: ProjectItemType,
  payload: Record<string, unknown>,
): ItemFact {
  const referenceField = itemType === "catalog"
    ? "Catalog"
    : itemType === "service_fee"
      ? "ServiceFee"
      : itemType === "prebuild"
        ? "Prebuild"
        : itemType === "stock"
          ? "Catalog"
          : null;
  const sourceReference = referenceField ? payload[referenceField] : null;
  const sourceItemId = numericId(pickId(sourceReference));
  const ownId = numericId(payload.ID);
  const itemId = String(ownId ?? sourceItemId ?? requiredString(payload.Description, "nested item identity"));
  const quantity = itemType === "stock"
    ? moneyAt(payload.Quantity, "Required")
    : moneyAt(payload.Total, "Qty");
  const baseCost = firstNumber(payload.EstimatedCost, payload.BasePrice, pathValue(payload.Totals, ["Cost"]));
  const actualCost = firstNumber(payload.ActualCost, pathValue(payload.Claimed, ["Cost"]));
  const description = stringValue(payload.Description) ?? pickName(sourceReference) ?? stringValue(pathValue(sourceReference, ["PartNo"]));

  return {
    sectionId,
    costCenterId,
    itemType,
    itemId,
    sourceItemId,
    description,
    quantity,
    billableStatus: stringValue(payload.BillableStatus),
    sellExTax: itemType === "stock"
      ? multiplyPresent(quantity, firstNumber(pathValue(payload.Catalog, ["SellPrice"])))
      : moneyAt(pathValue(payload.Total, ["Amount"]), "ExTax"),
    estimatedCost: multiplyPresent(quantity, baseCost),
    actualCost: multiplyPresent(quantity, actualCost),
  };
}

export function mapWorkOrderFact(
  sectionId: number,
  costCenterId: number,
  payload: Record<string, unknown>,
): WorkOrderFact {
  return {
    sectionId,
    costCenterId,
    workOrderId: requiredId(payload.ID, "work order ID"),
    staffId: numericId(pickId(payload.Staff)),
    workOrderDate: dateValue(payload.WorkOrderDate),
    approved: booleanValue(payload.Approved),
    scheduledHours: firstNumber(payload.ScheduledHrs),
    scheduledStartAt: timestampValue(payload.ISO8601ScheduledStartTime),
    scheduledEndAt: timestampValue(payload.ISO8601ScheduledEndTime),
  };
}

export async function persistProjectCostCenter(params: {
  projectType: ProjectType;
  projectId: number;
  fact: CostCenterFact;
  provenance: SourceProvenance;
  traversalGeneration?: number;
  query?: PostgresQuery;
}) {
  const { projectType, projectId, fact, provenance, query = queryPostgres } = params;
  if (projectType === "quote") {
    await query(
      `${nestedTraversalWriteCtes("quote", "$1", "$13", "$14", params.traversalGeneration !== undefined)}
       insert into metrics.metrics_quote_cost_centers (
         quote_id, section_id, cost_center_id, configured_cost_center_id, name, category,
         labor_hours, sell_value, cost_value, source_snapshot_id, source_hash,
         traversal_generation, source_deleted_at, fetched_at, updated_from_source_at
       ) select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $13,
                null, coalesce($12::timestamptz, now()), now()
           from current_traversal
       on conflict (quote_id, section_id, cost_center_id) do update set
         section_id = excluded.section_id,
         configured_cost_center_id = excluded.configured_cost_center_id,
         name = excluded.name,
         category = excluded.category,
         labor_hours = excluded.labor_hours,
         sell_value = excluded.sell_value,
         cost_value = excluded.cost_value,
         source_snapshot_id = excluded.source_snapshot_id,
         source_hash = excluded.source_hash,
         traversal_generation = excluded.traversal_generation,
         source_deleted_at = null,
         fetched_at = excluded.fetched_at,
         updated_from_source_at = now()`,
      [projectId, fact.sectionId, fact.costCenterId, fact.configuredCostCenterId, fact.name, fact.category, fact.laborHours, fact.sellValue, fact.costValue, provenance.sourceSnapshotId, provenance.sourceHash, provenance.fetchedAt, params.traversalGeneration ?? null, QUOTE_CATEGORY_ADVISORY_LOCK_KEY],
    );
    return;
  }

  await query(
    `${nestedTraversalWriteCtes("job", "$1", "$30", null, params.traversalGeneration !== undefined)}
     insert into metrics.metrics_job_cost_centers (
       job_id, section_id, cost_center_id, configured_cost_center_id,
       configured_cost_center_name, name, category,
       labor_quoted_hours, material_cost_value, sell_value, cost_value,
       net_profit_actual, net_margin_actual, gross_profit_actual, gross_margin_actual,
       materials_cost_actual, materials_cost_estimate, labor_cost_actual, labor_cost_estimate,
       labor_hours_actual, labor_hours_estimate, overhead_cost_actual, overhead_cost_estimate,
       total_resource_cost_actual, total_resource_cost_estimate, commission_cost_actual,
       source_snapshot_id, source_hash, traversal_generation, source_deleted_at, fetched_at, updated_from_source_at
     ) select
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
       $27, $28, $30, null, coalesce($29::timestamptz, now()), now()
       from current_traversal
     on conflict (job_id, section_id, cost_center_id) do update set
       section_id = excluded.section_id,
       configured_cost_center_id = excluded.configured_cost_center_id,
       configured_cost_center_name = excluded.configured_cost_center_name,
       name = excluded.name,
       category = excluded.category,
       labor_quoted_hours = excluded.labor_quoted_hours,
       material_cost_value = excluded.material_cost_value,
       sell_value = excluded.sell_value,
       cost_value = excluded.cost_value,
       net_profit_actual = excluded.net_profit_actual,
       net_margin_actual = excluded.net_margin_actual,
       gross_profit_actual = excluded.gross_profit_actual,
       gross_margin_actual = excluded.gross_margin_actual,
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
       source_snapshot_id = excluded.source_snapshot_id,
       source_hash = excluded.source_hash,
       traversal_generation = excluded.traversal_generation,
       source_deleted_at = null,
       fetched_at = excluded.fetched_at,
       updated_from_source_at = now()`,
    [
      projectId,
      fact.sectionId,
      fact.costCenterId,
      fact.configuredCostCenterId,
      fact.configuredCostCenterName,
      fact.name,
      fact.category,
      fact.laborHours,
      fact.materialCostValue,
      fact.sellValue,
      fact.costValue,
      fact.totals.nettProfitActual,
      fact.totals.nettMarginActual,
      fact.totals.grossProfitActual,
      fact.totals.grossMarginActual,
      fact.totals.materialsCostActual,
      fact.totals.materialsCostEstimate,
      fact.totals.laborCostActual,
      fact.totals.laborCostEstimate,
      fact.totals.laborHoursActual,
      fact.totals.laborHoursEstimate,
      fact.totals.overheadActual,
      fact.totals.overheadEstimate,
      fact.totals.resourceTotalActual,
      fact.totals.resourceTotalEstimate,
      fact.totals.commissionActual,
      provenance.sourceSnapshotId,
      provenance.sourceHash,
      provenance.fetchedAt,
      params.traversalGeneration ?? null,
    ],
  );
}

export async function persistProjectLabor(params: {
  projectType: ProjectType;
  projectId: number;
  fact: LaborFact;
  provenance: SourceProvenance;
  traversalGeneration?: number;
  query?: PostgresQuery;
}) {
  const table = params.projectType === "quote" ? "metrics.metrics_quote_labor" : "metrics.metrics_job_labor";
  const idColumn = params.projectType === "quote" ? "quote_id" : "job_id";
  const fact = params.fact;
  const serializeQuoteWrite = params.projectType === "quote";
  const values: unknown[] = [params.projectId, fact.sectionId, fact.costCenterId, fact.laborId, fact.laborTypeId, fact.laborTypeName, fact.quantityHours, fact.sellExTax, fact.actualCost, params.provenance.sourceSnapshotId, params.provenance.sourceHash, params.provenance.fetchedAt];
  values.push(params.traversalGeneration ?? null);
  if (serializeQuoteWrite) values.push(QUOTE_CATEGORY_ADVISORY_LOCK_KEY);
  await (params.query ?? queryPostgres)(
    `${nestedTraversalWriteCtes(params.projectType, "$1", "$13", serializeQuoteWrite ? "$14" : null, params.traversalGeneration !== undefined)}
     insert into ${table} (
       ${idColumn}, section_id, cost_center_id, labor_id, labor_type_id, labor_type_name,
       quantity_hours, sell_ex_tax, actual_cost, source_snapshot_id, source_hash,
       traversal_generation, source_deleted_at, fetched_at
     ) select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $13, null,
              coalesce($12::timestamptz, now()) from current_traversal
     on conflict (${idColumn}, section_id, cost_center_id, labor_id) do update set
       labor_type_id = excluded.labor_type_id,
       labor_type_name = excluded.labor_type_name,
       quantity_hours = excluded.quantity_hours,
       sell_ex_tax = excluded.sell_ex_tax,
       actual_cost = excluded.actual_cost,
       source_snapshot_id = excluded.source_snapshot_id,
       source_hash = excluded.source_hash,
       traversal_generation = excluded.traversal_generation,
       source_deleted_at = null,
       fetched_at = excluded.fetched_at`,
    values,
  );
}

export async function persistProjectItem(params: {
  projectType: ProjectType;
  projectId: number;
  fact: ItemFact;
  provenance: SourceProvenance;
  traversalGeneration?: number;
  query?: PostgresQuery;
}) {
  const table = params.projectType === "quote" ? "metrics.metrics_quote_items" : "metrics.metrics_job_items";
  const idColumn = params.projectType === "quote" ? "quote_id" : "job_id";
  const fact = params.fact;
  const serializeQuoteWrite = params.projectType === "quote";
  const values: unknown[] = [params.projectId, fact.sectionId, fact.costCenterId, fact.itemType, fact.itemId, fact.sourceItemId, fact.description, fact.quantity, fact.billableStatus, fact.sellExTax, fact.estimatedCost, fact.actualCost, params.provenance.sourceSnapshotId, params.provenance.sourceHash, params.provenance.fetchedAt];
  values.push(params.traversalGeneration ?? null);
  if (serializeQuoteWrite) values.push(QUOTE_CATEGORY_ADVISORY_LOCK_KEY);
  await (params.query ?? queryPostgres)(
    `${nestedTraversalWriteCtes(params.projectType, "$1", "$16", serializeQuoteWrite ? "$17" : null, params.traversalGeneration !== undefined)}
     insert into ${table} (
       ${idColumn}, section_id, cost_center_id, item_type, item_id, source_item_id,
       description, quantity, billable_status, sell_ex_tax, estimated_cost, actual_cost,
       source_snapshot_id, source_hash, traversal_generation, source_deleted_at, fetched_at
     ) select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
              $16, null, coalesce($15::timestamptz, now()) from current_traversal
     on conflict (${idColumn}, section_id, cost_center_id, item_type, item_id) do update set
       source_item_id = excluded.source_item_id,
       description = excluded.description,
       quantity = excluded.quantity,
       billable_status = excluded.billable_status,
       sell_ex_tax = excluded.sell_ex_tax,
       estimated_cost = excluded.estimated_cost,
       actual_cost = excluded.actual_cost,
       source_snapshot_id = excluded.source_snapshot_id,
       source_hash = excluded.source_hash,
       traversal_generation = excluded.traversal_generation,
       source_deleted_at = null,
       fetched_at = excluded.fetched_at`,
    values,
  );
}

export async function persistProjectWorkOrder(params: {
  projectType: ProjectType;
  projectId: number;
  fact: WorkOrderFact;
  provenance: SourceProvenance;
  traversalGeneration?: number;
  query?: PostgresQuery;
}) {
  const fact = params.fact;
  const serializeQuoteWrite = params.projectType === "quote";
  const values: unknown[] = [params.projectType, params.projectId, fact.sectionId, fact.costCenterId, fact.workOrderId, fact.staffId, fact.workOrderDate, fact.approved, fact.scheduledHours, fact.scheduledStartAt, fact.scheduledEndAt, params.provenance.sourceSnapshotId, params.provenance.sourceHash, params.provenance.fetchedAt];
  values.push(params.traversalGeneration ?? null);
  if (serializeQuoteWrite) values.push(QUOTE_CATEGORY_ADVISORY_LOCK_KEY);
  await (params.query ?? queryPostgres)(
    `${nestedTraversalWriteCtes(params.projectType, "$2", "$15", serializeQuoteWrite ? "$16" : null, params.traversalGeneration !== undefined)}
     insert into metrics.metrics_work_orders (
       project_type, project_id, section_id, cost_center_id, work_order_id, staff_id,
       work_order_date, approved, scheduled_hours, scheduled_start_at, scheduled_end_at,
       source_snapshot_id, source_hash, traversal_generation, source_deleted_at, fetched_at
     ) select $1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10::timestamptz,
              $11::timestamptz, $12, $13, $15, null, coalesce($14::timestamptz, now())
         from current_traversal
     on conflict (project_type, project_id, section_id, cost_center_id, work_order_id) do update set
       staff_id = excluded.staff_id,
       work_order_date = excluded.work_order_date,
       approved = excluded.approved,
       scheduled_hours = excluded.scheduled_hours,
       scheduled_start_at = excluded.scheduled_start_at,
       scheduled_end_at = excluded.scheduled_end_at,
       source_snapshot_id = excluded.source_snapshot_id,
       source_hash = excluded.source_hash,
       traversal_generation = excluded.traversal_generation,
       source_deleted_at = null,
       fetched_at = excluded.fetched_at`,
    values,
  );
}

export async function persistScheduleBlocks(params: {
  scheduleId: number;
  payload: Record<string, unknown>;
  provenance: SourceProvenance;
  referenceType: string | null;
  referenceId: number | null;
  traversalGeneration?: number;
  query?: PostgresQuery;
}) {
  const blocks = arrayRecords(params.payload.Blocks);
  const staffId = numericId(pickId(params.payload.Staff));
  const projectType = params.referenceType?.toLowerCase() === "quote" ? "quote" : "job";
  const serializeQuoteWrite = projectType === "quote";
  const query = params.query ?? queryPostgres;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const identity = scheduleBlockIdentity(params.payload, block);
    const values: unknown[] = [params.scheduleId, index, staffId, params.referenceType, params.referenceId, numericId(pickId(block.ScheduleRate)), firstNumber(block.Hrs), timestampValue(block.ISO8601StartTime), timestampValue(block.ISO8601EndTime), identity.workOrderId, identity.cancelled, params.provenance.sourceSnapshotId, params.provenance.sourceHash, params.provenance.fetchedAt, params.traversalGeneration ?? null];
    if (serializeQuoteWrite) values.push(QUOTE_CATEGORY_ADVISORY_LOCK_KEY);
    await query(
      `${nestedTraversalWriteCtes(projectType, "$5", "$15", serializeQuoteWrite ? "$16" : null, params.traversalGeneration !== undefined)}
       insert into metrics.metrics_schedule_blocks (
         schedule_id, block_index, staff_id, reference_type, reference_id, schedule_rate_id,
         planned_hours, planned_start_at, planned_end_at, work_order_id, cancelled,
         source_snapshot_id, source_hash,
         traversal_generation, source_deleted_at, fetched_at
       ) select $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz,
                $10, $11, $12, $13, $15, null, coalesce($14::timestamptz, now())
           from current_traversal
       on conflict (schedule_id, block_index) do update set
         staff_id = excluded.staff_id,
         reference_type = excluded.reference_type,
         reference_id = excluded.reference_id,
         schedule_rate_id = excluded.schedule_rate_id,
         planned_hours = excluded.planned_hours,
         planned_start_at = excluded.planned_start_at,
         planned_end_at = excluded.planned_end_at,
         work_order_id = excluded.work_order_id,
         cancelled = excluded.cancelled,
         source_snapshot_id = excluded.source_snapshot_id,
         source_hash = excluded.source_hash,
         traversal_generation = excluded.traversal_generation,
         source_deleted_at = null,
         fetched_at = excluded.fetched_at`,
      values,
    );
  }
  const cleanupValues: unknown[] = [params.scheduleId, blocks.length, params.provenance.fetchedAt, params.traversalGeneration ?? null, params.referenceId];
  if (serializeQuoteWrite) cleanupValues.push(QUOTE_CATEGORY_ADVISORY_LOCK_KEY);
  if (!serializeQuoteWrite && params.traversalGeneration === undefined) cleanupValues.length = 3;
  await query(
    `${nestedTraversalWriteCtes(projectType, "$5", "$4", serializeQuoteWrite ? "$6" : null, params.traversalGeneration !== undefined)}
     update metrics.metrics_schedule_blocks
        set source_deleted_at = now(), fetched_at = coalesce($3::timestamptz, now())
      where schedule_id = $1 and block_index >= $2 and source_deleted_at is null
        and exists (select 1 from current_traversal)`,
    cleanupValues,
  );
}

export async function markScheduleSourceUnavailable(
  scheduleId: number,
  options: {
    observedAt: string;
    tombstoneSnapshot: RawSnapshotWrite;
    query?: PostgresQuery;
    transaction?: NestedFinalizationTransaction;
  },
): Promise<SourceUnavailableResult> {
  if (options.query && !options.transaction) {
    throw new Error("Schedule source-unavailable publication requires an explicit transaction when a query is injected.");
  }
  const transaction = options.transaction ?? withPostgresTransaction;
  return transaction(async (transactionQuery) => {
    if (options.query && options.query !== transactionQuery) {
      throw new Error("Schedule source-unavailable publication must use the query supplied by its transaction.");
    }
    const authority = await acquireMissingScheduleAuthority({
      scheduleId,
      observedAt: options.observedAt,
      query: transactionQuery,
    });
    if (!authority.applied) return { applied: false, affectedPeriods: [] };

    const tombstone = await writeRawSnapshot(options.tombstoneSnapshot, transactionQuery);
    await transactionQuery(
      `update metrics.metrics_schedules
          set source_deleted_at = coalesce(source_deleted_at, $2::timestamptz),
              fetched_at = $2::timestamptz,
              updated_from_source_at = now()
        where schedule_id = $1`,
      [scheduleId, options.observedAt],
    );
    await transactionQuery(
      `delete from metrics.schedule_snapshots where schedule_id = $1`,
      [scheduleId],
    );
    await transactionQuery(
      `update metrics.metrics_schedule_blocks
          set source_deleted_at = coalesce(source_deleted_at, $2::timestamptz),
              fetched_at = $2::timestamptz
        where schedule_id = $1`,
      [scheduleId, options.observedAt],
    );
    await transactionQuery(
      `update metrics.raw_simpro_snapshots
          set source_deleted_at = coalesce(source_deleted_at, $2::timestamptz)
        where parent_identity->>'scheduleId' = $1::text
           or (entity_type = 'schedule_details' and entity_id = $1::text)
           or (
             entity_type in ('quote_schedule', 'job_schedule', 'quote_schedule_detail', 'job_schedule_detail')
             and right(entity_id, length($1::text) + 1) = ':' || $1::text
           )`,
      [scheduleId, options.observedAt],
    );
    await enqueueAffectedRollups(
      authority.affectedPeriods,
      `schedule ${scheduleId} source unavailable`,
      transactionQuery,
    );
    return {
      applied: true,
      snapshotInserted: tombstone.inserted,
      affectedPeriods: authority.affectedPeriods,
    };
  });
}

export async function finalizeProjectNestedTraversal(params: {
  projectType: ProjectType;
  projectId: number;
  generation: number;
  rootSnapshotId: number;
  seen: NestedTraversalSeen;
  query?: PostgresQuery;
  transaction?: NestedFinalizationTransaction;
}) {
  if (params.query && !params.transaction) {
    throw new Error("Nested traversal finalization requires an explicit transaction when a query is injected.");
  }

  const transaction = params.transaction ?? withPostgresTransaction;
  return transaction(async (transactionQuery) => {
    if (params.query && params.query !== transactionQuery) {
      throw new Error("Nested traversal finalization must use the query supplied by its transaction.");
    }
    return finalizeProjectNestedTraversalInTransaction({
      projectType: params.projectType,
      projectId: params.projectId,
      generation: params.generation,
      rootSnapshotId: params.rootSnapshotId,
      query: transactionQuery,
    });
  });
}

async function finalizeProjectNestedTraversalInTransaction(params: {
  projectType: ProjectType;
  projectId: number;
  generation: number;
  rootSnapshotId: number;
  query: PostgresQuery;
}): Promise<NestedFinalizationResult> {
  const { projectType, projectId, generation, rootSnapshotId, query } = params;
  const costCenterTable = projectType === "quote" ? "metrics.metrics_quote_cost_centers" : "metrics.metrics_job_cost_centers";
  const laborTable = projectType === "quote" ? "metrics.metrics_quote_labor" : "metrics.metrics_job_labor";
  const itemTable = projectType === "quote" ? "metrics.metrics_quote_items" : "metrics.metrics_job_items";
  const idColumn = projectType === "quote" ? "quote_id" : "job_id";

  await acquireQuoteClassificationAdvisoryLock(query);
  if (projectType === "quote") {
    await acquireQuoteCategoryAdvisoryLock(query);
  }

  const authority = await query<{ generation: string }>(
    `select generation::text
       from metrics.project_nested_traversals
      where project_type = $1 and project_id = $2
        and generation = $3 and status = 'active'
      for update`,
    [projectType, projectId, generation],
  );
  if (!authority.rows[0]) return { applied: false, affectedPeriods: [] };
  await acquireProjectScheduleAdvisoryLocks(projectType, projectId, query);
  const projectPeriods = await projectAffectedPeriods(projectType, projectId, query);
  const previousSourceQuoteId = projectType === "job"
    ? await authoritativeJobSourceQuoteId(projectId, query)
    : null;

  await query(
    `update ${costCenterTable} set source_deleted_at = now(), updated_from_source_at = now()
      where ${idColumn} = $1
        and traversal_generation is distinct from $2::bigint
        and source_deleted_at is null`,
    [projectId, generation],
  );
  await query(
    `update ${laborTable} set source_deleted_at = now(), fetched_at = now()
      where ${idColumn} = $1
        and traversal_generation is distinct from $2::bigint
        and source_deleted_at is null`,
    [projectId, generation],
  );
  await query(
    `update ${itemTable} set source_deleted_at = now(), fetched_at = now()
      where ${idColumn} = $1
        and traversal_generation is distinct from $2::bigint
        and source_deleted_at is null`,
    [projectId, generation],
  );
  await query(
    `update metrics.metrics_work_orders set source_deleted_at = now(), fetched_at = now()
      where project_type = $1 and project_id = $2
        and traversal_generation is distinct from $3::bigint
        and source_deleted_at is null`,
    [projectType, projectId, generation],
  );
  await query(
    `update metrics.metrics_schedules set source_deleted_at = now(), updated_from_source_at = now()
      where lower(reference_type) = $1 and reference_id = $2
        and traversal_generation is distinct from $3::bigint
        and source_deleted_at is null`,
    [projectType, projectId, generation],
  );
  await query(
    `delete from metrics.schedule_snapshots
      where lower(project_type) = $1 and project_id = $2::text
        and traversal_generation is distinct from $3::bigint`,
    [projectType, projectId, generation],
  );
  await query(
    `update metrics.metrics_schedule_blocks set source_deleted_at = now(), fetched_at = now()
      where lower(reference_type) = $1 and reference_id = $2
        and traversal_generation is distinct from $3::bigint
        and source_deleted_at is null`,
    [projectType, projectId, generation],
  );

  if (projectType === "quote") {
    await query(
      `with labor as (
         select cost_center_id, sum(quantity_hours) as hours
           from metrics.metrics_quote_labor
          where quote_id = $1 and source_deleted_at is null
          group by cost_center_id
       )
       update metrics.metrics_quote_cost_centers c
          set labor_hours = labor.hours, updated_from_source_at = now()
         from labor
        where c.quote_id = $1 and c.cost_center_id = labor.cost_center_id`,
      [projectId],
    );
    const categoryAffectedPeriods = await updateProjectCategory("quote", projectId, query);
    const categoryQueued = new Set(categoryAffectedPeriods.map((period) => period.periodStart));
    await completeProjectRootSnapshot(projectType, projectId, rootSnapshotId, query);
    const classificationPeriods = (await reclassifyPersistedQuote(projectId, query)).map((period) => ({
      scope: "quotes" as const,
      periodStart: period.period_start,
    }));
    const affectedPeriods = uniquePeriods([...projectPeriods, ...classificationPeriods]);
    await enqueueAffectedRollups(
      affectedPeriods.filter((period) => !categoryQueued.has(period.periodStart)),
      `nested quote ${projectId} finalization`,
      query,
    );
    await completeProjectNestedTraversal(projectType, projectId, generation, query);
    return { applied: true, affectedPeriods };
  }

  await query(
    `with labor as (
       select cost_center_id, sum(quantity_hours) as hours
         from metrics.metrics_job_labor
        where job_id = $1 and source_deleted_at is null
        group by cost_center_id
     ), items as (
       select cost_center_id, sum(sell_ex_tax) as sell, sum(coalesce(actual_cost, estimated_cost)) as cost
         from metrics.metrics_job_items
        where job_id = $1 and source_deleted_at is null
        group by cost_center_id
     )
     update metrics.metrics_job_cost_centers c
        set labor_quoted_hours = coalesce(labor.hours, c.labor_quoted_hours),
            material_sell_value = items.sell,
            material_cost_value = items.cost,
            updated_from_source_at = now()
       from labor full join items using (cost_center_id)
      where c.job_id = $1 and c.cost_center_id = coalesce(labor.cost_center_id, items.cost_center_id)`,
    [projectId],
  );
  await allocateJobGrossProfitToCostCenters(projectId, query);
  await updateProjectCategory("job", projectId, query);
  await completeProjectRootSnapshot(projectType, projectId, rootSnapshotId, query);
  const nextSourceQuoteId = await authoritativeJobSourceQuoteId(projectId, query);
  const quoteIdsToReclassify = await quoteIdsAffectedByJobEvidence({
    jobId: projectId,
    previousSourceQuoteId,
    nextSourceQuoteId,
  }, query);
  const relationshipPeriods: AffectedPeriod[] = [];
  for (const quoteId of quoteIdsToReclassify) {
    const periods = await reclassifyPersistedQuote(quoteId, query);
    relationshipPeriods.push(...periods.map((period) => ({
      scope: "quotes" as const,
      periodStart: period.period_start,
    })));
  }
  const affectedPeriods = uniquePeriods([...projectPeriods, ...relationshipPeriods]);
  await enqueueAffectedRollups(affectedPeriods, `nested job ${projectId} finalization`, query);
  await completeProjectNestedTraversal(projectType, projectId, generation, query);
  return { applied: true, affectedPeriods };
}

export async function markProjectSourceUnavailable(
  projectType: ProjectType,
  projectId: number,
  options: {
    expectedGeneration?: number;
    tombstoneSnapshot?: RawSnapshotWrite;
    query?: PostgresQuery;
    transaction?: NestedFinalizationTransaction;
  } = {},
): Promise<SourceUnavailableResult> {
  if (options.query && !options.transaction) {
    throw new Error("Source-unavailable publication requires an explicit transaction when a query is injected.");
  }

  const transaction = options.transaction ?? withPostgresTransaction;
  return transaction(async (transactionQuery) => {
    if (options.query && options.query !== transactionQuery) {
      throw new Error("Source-unavailable publication must use the query supplied by its transaction.");
    }
    await acquireQuoteClassificationAdvisoryLock(transactionQuery);
    if (projectType === "quote") await acquireQuoteCategoryAdvisoryLock(transactionQuery);
    return markProjectSourceUnavailableInTransaction(
      projectType,
      projectId,
      options.expectedGeneration,
      options.tombstoneSnapshot,
      transactionQuery,
    );
  });
}

async function markProjectSourceUnavailableInTransaction(
  projectType: ProjectType,
  projectId: number,
  expectedGeneration: number | undefined,
  tombstoneSnapshot: RawSnapshotWrite | undefined,
  query: PostgresQuery,
): Promise<SourceUnavailableResult> {
  const rootTable = projectType === "quote" ? "metrics.metrics_quotes" : "metrics.metrics_jobs";
  const snapshotTable = projectType === "quote" ? "metrics.quote_snapshots" : "metrics.job_snapshots";
  const costCenterTable = projectType === "quote" ? "metrics.metrics_quote_cost_centers" : "metrics.metrics_job_cost_centers";
  const laborTable = projectType === "quote" ? "metrics.metrics_quote_labor" : "metrics.metrics_job_labor";
  const itemTable = projectType === "quote" ? "metrics.metrics_quote_items" : "metrics.metrics_job_items";
  const idColumn = projectType === "quote" ? "quote_id" : "job_id";

  const authority = expectedGeneration === undefined
    ? await query<{ generation: string }>(
        `insert into metrics.project_nested_traversals (
           project_type, project_id, generation, status, started_at, finalized_at, updated_at
         ) values ($1, $2, 1, 'source_deleted', now(), now(), now())
         on conflict (project_type, project_id) do update set
           generation = metrics.project_nested_traversals.generation + 1,
           status = 'source_deleted',
           started_at = now(),
           finalized_at = now(),
           updated_at = now()
         returning generation::text`,
        [projectType, projectId],
      )
    : await query<{ generation: string }>(
        `update metrics.project_nested_traversals
            set status = 'source_deleted', finalized_at = now(), updated_at = now()
          where project_type = $1 and project_id = $2
            and generation = $3 and status = 'active'
        returning generation::text`,
        [projectType, projectId, expectedGeneration],
      );
  if (!authority.rows[0]) return { applied: false, affectedPeriods: [] };

  await acquireProjectScheduleAdvisoryLocks(projectType, projectId, query);
  const projectPeriods = await projectAffectedPeriods(projectType, projectId, query);
  let quoteIdsToReclassify: number[] = [];
  if (projectType === "job") {
    const jobEvidence = await query<{
      converted_from_type: string | null;
      converted_from_id: string | null;
    }>(
      `select converted_from_type, converted_from_id::text
         from metrics.metrics_jobs
        where job_id = $1
        for update`,
      [projectId],
    );
    const evidence = jobEvidence.rows[0];
    quoteIdsToReclassify = await quoteIdsAffectedByJobEvidence({
      jobId: projectId,
      previousSourceQuoteId: evidence?.converted_from_type?.toLowerCase() === "quote"
        ? numericId(evidence.converted_from_id)
        : null,
      nextSourceQuoteId: null,
    }, query);
  }

  const tombstone = tombstoneSnapshot
    ? await writeRawSnapshot(tombstoneSnapshot, query)
    : null;

  await query(
    `with root_deleted as (
       update ${rootTable}
          set source_deleted_at = coalesce(source_deleted_at, now()),
              updated_from_source_at = now()
        where ${idColumn} = $1
       returning 1
     ), cost_centers_deleted as (
       update ${costCenterTable}
          set source_deleted_at = coalesce(source_deleted_at, now()),
              updated_from_source_at = now()
        where ${idColumn} = $1
     ), labor_deleted as (
       update ${laborTable}
          set source_deleted_at = coalesce(source_deleted_at, now()),
              fetched_at = now()
        where ${idColumn} = $1
     ), items_deleted as (
       update ${itemTable}
          set source_deleted_at = coalesce(source_deleted_at, now()),
              fetched_at = now()
        where ${idColumn} = $1
     ), work_orders_deleted as (
       update metrics.metrics_work_orders
          set source_deleted_at = coalesce(source_deleted_at, now()),
              fetched_at = now()
        where project_type = $2 and project_id = $1
     ), schedules_deleted as (
       update metrics.metrics_schedules
          set source_deleted_at = coalesce(source_deleted_at, now()),
              updated_from_source_at = now()
        where lower(reference_type) = $2 and reference_id = $1
     ), schedule_blocks_deleted as (
       update metrics.metrics_schedule_blocks
          set source_deleted_at = coalesce(source_deleted_at, now()),
              fetched_at = now()
        where lower(reference_type) = $2 and reference_id = $1
     ), schedule_snapshots_deleted as (
       delete from metrics.schedule_snapshots
        where lower(project_type) = $2 and project_id = $1::text
     ), raw_snapshots_deleted as (
       update metrics.raw_simpro_snapshots
          set source_deleted_at = coalesce(source_deleted_at, now())
        where (
          (entity_type = $3 and entity_id = $1::text)
          or (parent_identity->>'projectType' = $2
            and parent_identity->>'projectId' = $1::text)
          or ($2 = 'quote' and parent_identity->>'quoteId' = $1::text)
          or ($2 = 'job' and parent_identity->>'jobId' = $1::text)
        )
     ), current_snapshot_deleted as (
       delete from ${snapshotTable} where ${idColumn} = $1
     )
     select 1 from root_deleted`,
    [projectId, projectType, `${projectType}_details`],
  );

  const affectedPeriods = [...projectPeriods];
  for (const quoteId of quoteIdsToReclassify) {
    const quotePeriods = await reclassifyPersistedQuote(quoteId, query);
    for (const quotePeriod of quotePeriods) {
      affectedPeriods.push({ scope: "quotes", periodStart: quotePeriod.period_start });
    }
  }
  const uniqueAffectedPeriods = uniquePeriods(affectedPeriods);
  await enqueueAffectedRollups(
    uniqueAffectedPeriods,
    `${projectType} ${projectId} source unavailable`,
    query,
  );
  return {
    applied: true,
    affectedPeriods: uniqueAffectedPeriods,
    ...(tombstone ? { snapshotInserted: tombstone.inserted } : {}),
  };
}

async function projectAffectedPeriods(
  projectType: ProjectType,
  projectId: number,
  query: PostgresQuery,
): Promise<AffectedPeriod[]> {
  if (projectType === "quote") {
    const result = await query<{ metric_date: string | null }>(
      `select date_approved::text as metric_date
         from metrics.metrics_quotes
        where quote_id = $1`,
      [projectId],
    );
    const metricDate = result.rows[0]?.metric_date;
    return metricDate
      ? [{ scope: "quotes", periodStart: monthStart(metricDate) }]
      : [];
  }

  const result = await query<{ metric_date: string | null; stage: string | null }>(
    `select completed_date::text as metric_date, stage
       from metrics.metrics_jobs
      where job_id = $1`,
    [projectId],
  );
  const job = result.rows[0];
  const affected: AffectedPeriod[] = [];
  if (job?.metric_date && ["complete", "archived"].includes(job.stage?.trim().toLowerCase() ?? "")) {
    const periodStart = monthStart(job.metric_date);
    affected.push(
      { scope: "jobs", periodStart },
      { scope: "technicians", periodStart },
      { scope: "commissions", periodStart },
    );
  }
  const schedulePeriods = await query<{ period_start: string }>(
    `select distinct date_trunc('month', schedule_date)::date::text as period_start
       from metrics.metrics_schedules
      where lower(reference_type) = 'job' and reference_id = $1
        and source_deleted_at is null and schedule_date is not null`,
    [projectId],
  );
  for (const schedule of schedulePeriods.rows) {
    affected.push({ scope: "technicians", periodStart: schedule.period_start });
  }
  return uniquePeriods(affected);
}

async function acquireProjectScheduleAdvisoryLocks(
  projectType: ProjectType,
  projectId: number,
  query: PostgresQuery,
): Promise<void> {
  const schedules = await query<{ schedule_id: string }>(
    `select schedule_id::text
       from metrics.metrics_schedules
      where lower(reference_type) = $1 and reference_id = $2
      order by schedule_id`,
    [projectType, projectId],
  );
  for (const schedule of schedules.rows) {
    const scheduleId = Number(schedule.schedule_id);
    if (!Number.isSafeInteger(scheduleId) || scheduleId <= 0) {
      throw new Error(`Invalid schedule identity ${schedule.schedule_id} for ${projectType} ${projectId}.`);
    }
    await acquireScheduleAdvisoryLock(query, scheduleId);
  }
}

export async function enqueueAffectedRollups(
  affectedPeriods: AffectedPeriod[],
  reason: string,
  query: PostgresQuery,
): Promise<void> {
  for (const affected of uniquePeriods(affectedPeriods)) {
    // Simpro contains legitimate schedules outside the dashboard's fixed
    // Jan-2023-through-current serving window. Persist that source evidence,
    // but do not turn an intentionally unserved month into a parent-ingestion
    // failure. Malformed periods still fail closed through the queue owner.
    if (isValidMonthOutsideServingWindow(affected.periodStart)) continue;
    const queued = await enqueueRollupRebuild({
      metricFamily: affected.scope,
      periodStart: affected.periodStart,
      reason,
    }, query);
    if (!queued) {
      throw new Error(`Unable to queue ${affected.scope} rollup for ${affected.periodStart}.`);
    }
  }
}

function isValidMonthOutsideServingWindow(periodStart: string): boolean {
  if (!/^\d{4}-\d{2}-01$/.test(periodStart)) return false;
  const parsed = new Date(`${periodStart}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== periodStart) return false;
  return periodStart < DASHBOARD_HISTORY_START || periodStart > businessCurrentMonth();
}

function uniquePeriods(affectedPeriods: AffectedPeriod[]): AffectedPeriod[] {
  return [...new Map(
    affectedPeriods.map((period) => [`${period.scope}:${period.periodStart}`, period]),
  ).values()];
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

async function completeProjectNestedTraversal(
  projectType: ProjectType,
  projectId: number,
  generation: number,
  query: PostgresQuery,
) {
  const result = await query(
    `update metrics.project_nested_traversals
        set status = 'completed', finalized_at = now(), updated_at = now()
      where project_type = $1 and project_id = $2
        and generation = $3 and status = 'active'`,
    [projectType, projectId, generation],
  );
  if (result.rowCount !== 1) {
    throw new Error(`Lost ${projectType} ${projectId} traversal generation ${generation} before commit.`);
  }
}

async function completeProjectRootSnapshot(
  projectType: ProjectType,
  projectId: number,
  rootSnapshotId: number,
  query: PostgresQuery,
) {
  const result = await query(
    `update metrics.raw_simpro_snapshots
        set complete_traversal = true
      where id = $1 and entity_type = $2 and entity_id = $3
        and source_deleted_at is null`,
    [rootSnapshotId, `${projectType}_details`, String(projectId)],
  );
  if (result.rowCount !== 1) {
    throw new Error(`Root snapshot ${rootSnapshotId} is unavailable for ${projectType} ${projectId} traversal completion.`);
  }
}

async function authoritativeJobSourceQuoteId(
  jobId: number,
  query: PostgresQuery,
): Promise<number | null> {
  const result = await query<{ source_quote_id: string | null }>(
    `select case when authoritative.id is null then null
                 else metrics.authoritative_job_source_quote_id(authoritative.payload)::text
             end as source_quote_id
       from metrics.metrics_jobs job
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
      where job.job_id = $1 and job.source_deleted_at is null`,
    [jobId],
  );
  const sourceQuoteId = result.rows[0]?.source_quote_id;
  if (sourceQuoteId === null || sourceQuoteId === undefined) return null;
  const parsed = Number(sourceQuoteId);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Authoritative relationship provenance for job ${jobId} is invalid.`);
  }
  return parsed;
}

async function updateProjectCategory(
  projectType: ProjectType,
  projectId: number,
  query: PostgresQuery = queryPostgres,
) {
  if (projectType === "quote") {
    const projection = await reprojectPersistedQuoteCategory(projectId, query);
    return projection.affectedPeriods.map((periodStart) => ({ scope: "quotes" as const, periodStart }));
  }

  await reprojectImportedJobCategories([projectId], query);
  await query(
    `update metrics.job_snapshots j
        set labor_quoted_hours = facts.labor_hours,
            labor_coverage = case when facts.labor_hours is null then 'unknown' else 'nested_labor_complete' end,
            material_coverage = 'nested_items_complete',
            updated_at = now()
       from (
         select sum(labor_quoted_hours) as labor_hours
           from metrics.metrics_job_cost_centers
          where job_id = $1 and source_deleted_at is null
       ) facts
      where j.job_id = $1`,
    [projectId],
  );
  return [];
}

export function provenanceFor(payload: unknown, sourceSnapshotId: number | null, fetchedAt: string | null): SourceProvenance {
  return { sourceSnapshotId, sourceHash: sourceHash(payload), fetchedAt };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordValue).filter((row): row is Record<string, unknown> => Boolean(row)) : [];
}

function nestedTraversalWriteCtes(
  projectType: ProjectType,
  projectIdPlaceholder: string,
  generationPlaceholder: string,
  quoteLockPlaceholder: string | null,
  guarded: boolean,
) {
  if (projectType === "quote") {
    if (!quoteLockPlaceholder) throw new Error("Quote nested writes require the category lock placeholder.");
    return guarded
      ? `with category_serialization as materialized (
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
         )`
      : `with category_serialization as materialized (
           select pg_advisory_xact_lock(${quoteLockPlaceholder}::bigint)
         ), current_traversal as materialized (
           select null::bigint as generation from category_serialization
         )`;
  }

  return guarded
    ? `with current_traversal as materialized (
         select traversal.generation
           from metrics.project_nested_traversals traversal
          where traversal.project_type = 'job'
            and traversal.project_id = ${projectIdPlaceholder}
            and traversal.generation = ${generationPlaceholder}::bigint
            and traversal.status = 'active'
          for update of traversal
       )`
    : `with current_traversal as materialized (
         select null::bigint as generation
       )`;
}

function pathValue(value: unknown, path: string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    const record = recordValue(cursor);
    if (!record) return null;
    cursor = record[key];
  }
  return cursor;
}

function moneyAt(value: unknown, key: string): number | null {
  return firstNumber(pathValue(value, [key]));
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[$,]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = numberValue(value);
    if (number !== null) return number;
  }
  return null;
}

function sumPresent(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? roundMoney(present.reduce((sum, value) => sum + value, 0)) : null;
}

function multiplyPresent(left: number | null, right: number | null): number | null {
  return left !== null && right !== null ? roundMoney(left * right) : null;
}

function numericId(value: unknown): number | null {
  const number = numberValue(value);
  return number !== null && Number.isInteger(number) && number > 0 ? number : null;
}

function requiredId(value: unknown, label: string): number {
  const id = numericId(value);
  if (id === null) throw new Error(`Missing ${label}`);
  return id;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`Missing ${label}`);
  return result;
}

function dateValue(value: unknown): string | null {
  const string = stringValue(value);
  const match = string?.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

function timestampValue(value: unknown): string | null {
  const string = stringValue(value);
  if (!string) return null;
  const date = new Date(string);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && ["true", "false"].includes(value.toLowerCase())) return value.toLowerCase() === "true";
  return null;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

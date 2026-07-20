import {
  queryPostgres,
  withPostgresTransaction,
  type PostgresQuery,
  type QueryResult,
} from "@/lib/store/postgres";

export type DirectReconciliationScope = "quotes" | "jobs";
export type ReconciliationContinuationStatus =
  | "collecting"
  | "repair_pending"
  | "completed"
  | "superseded"
  | "failed";
export type ReconciliationCursorPhase = "list" | "details" | "complete";

export type ReconciliationContinuationEntity = {
  id: string;
  totalValue: number;
  stageName?: string | null;
};

export type ReconciliationContinuationState = {
  cursorDay: string | null;
  cursorPage: number;
  cursorPhase: ReconciliationCursorPhase;
  cursorDetailIndex: number;
  continuationPage: number | null;
  pendingDetailIds: string[];
  listedSourceIds: string[];
  sourceEntities: Record<string, ReconciliationContinuationEntity>;
  requestsUsed: number;
  completedPageCount: number;
  completedDayCount: number;
};

export type ReconciliationContinuationClaim = ReconciliationContinuationState & {
  scope: DirectReconciliationScope;
  periodStart: string;
  periodEnd: string;
  generation: number;
  fenceToken: number;
  status: ReconciliationContinuationStatus;
  leaseOwner: string;
};

export type ReconciliationContinuationClaimResult =
  | { acquired: true; claim: ReconciliationContinuationClaim }
  | { acquired: false; reason: "busy" };

export type ReconciliationContinuationTransaction = <T>(
  callback: (query: PostgresQuery) => Promise<T>,
) => Promise<T>;

export type ReconciliationContinuationStore = {
  claim(params: {
    scope: DirectReconciliationScope;
    periodStart: string;
    periodEnd: string;
    leaseOwner: string;
  }): Promise<ReconciliationContinuationClaimResult>;
  checkpoint(
    claim: ReconciliationContinuationClaim,
    state: ReconciliationContinuationState,
    query?: PostgresQuery,
  ): Promise<boolean>;
  reserveRequest(
    claim: ReconciliationContinuationClaim,
    maxRequests: number,
    query?: PostgresQuery,
  ): Promise<number | null>;
  publish(
    claim: ReconciliationContinuationClaim,
    checkId: number,
    status: "matched" | "mismatch",
    query?: PostgresQuery,
  ): Promise<boolean>;
  release(claim: ReconciliationContinuationClaim, query?: PostgresQuery): Promise<boolean>;
  restartGeneration(params: {
    scope: DirectReconciliationScope;
    periodStart: string;
    periodEnd: string;
    leaseOwner: string;
  }): Promise<ReconciliationContinuationClaim>;
  hasIncomplete(scope: DirectReconciliationScope, periodStart: string): Promise<boolean>;
};

type ContinuationRow = {
  scope: DirectReconciliationScope;
  period_start: Date | string;
  period_end: Date | string;
  generation: number | string;
  fence_token: number | string;
  status: ReconciliationContinuationStatus;
  cursor_day: Date | string | null;
  cursor_page: number | string;
  cursor_phase: ReconciliationCursorPhase;
  cursor_detail_index: number | string;
  continuation_page: number | string | null;
  pending_detail_ids: unknown;
  listed_source_ids: unknown;
  source_entities: unknown;
  requests_used: number | string;
  completed_page_count: number | string;
  completed_day_count: number | string;
  lease_owner: string | null;
  lease_available?: boolean;
};

const continuationColumns = `scope, period_start::text, period_end::text, generation,
  fence_token, status, cursor_day::text, cursor_page, cursor_phase,
  cursor_detail_index, continuation_page, pending_detail_ids,
  listed_source_ids, source_entities, requests_used,
  completed_page_count, completed_day_count, lease_owner`;

export function createPostgresReconciliationContinuationStore(options: {
  query?: PostgresQuery;
  transaction?: ReconciliationContinuationTransaction;
  leaseMs?: number;
} = {}): ReconciliationContinuationStore {
  const query = options.query ?? queryPostgres;
  const transaction = options.transaction
    ?? (options.query
      ? async <T>(callback: (transactionQuery: PostgresQuery) => Promise<T>) => callback(query)
      : withPostgresTransaction);
  const leaseMs = boundedLeaseMs(options.leaseMs ?? 300_000);

  return {
    async claim(params) {
      validatePeriod(params.periodStart, params.periodEnd);
      validateLeaseOwner(params.leaseOwner);
      return transaction(async (transactionQuery) => {
        await ensureContinuationHead(transactionQuery, params);
        const head = await transactionQuery<{ active_generation: number | string }>(
          `select active_generation
             from metrics.reconciliation_continuation_heads
            where scope = $1 and period_start = $2::date
            for update`,
          [params.scope, params.periodStart],
        );
        const activeGeneration = numericInteger(head.rows[0]?.active_generation, 0);
        if (activeGeneration > 0) {
          const active = await transactionQuery<ContinuationRow>(
            `select ${continuationColumns},
                    (lease_owner is null or lease_owner = $4 or lease_expires_at <= clock_timestamp()) as lease_available
               from metrics.reconciliation_continuations
              where scope = $1 and period_start = $2::date and generation = $3
              for update`,
            [params.scope, params.periodStart, activeGeneration, params.leaseOwner],
          );
          const row = active.rows[0];
          if (row && (row.status === "collecting" || row.status === "repair_pending")) {
            if (!row.lease_available) return { acquired: false, reason: "busy" };
            const resumed = await transactionQuery<ContinuationRow>(
              `update metrics.reconciliation_continuations
                  set fence_token = fence_token + 1,
                      lease_owner = $4,
                      lease_expires_at = clock_timestamp() + ($5::integer * interval '1 millisecond'),
                      updated_at = clock_timestamp()
                where scope = $1 and period_start = $2::date and generation = $3
                returning ${continuationColumns}`,
              [params.scope, params.periodStart, activeGeneration, params.leaseOwner, leaseMs],
            );
            return { acquired: true, claim: mapClaim(requiredRow(resumed), params.leaseOwner) };
          }
        }

        const generation = activeGeneration + 1;
        const inserted = await transactionQuery<ContinuationRow>(
          `insert into metrics.reconciliation_continuations (
             scope, period_start, period_end, generation, fence_token, status,
             cursor_day, cursor_page, cursor_phase, cursor_detail_index,
             lease_owner, lease_expires_at
           ) values (
             $1, $2::date, $3::date, $4, 1, 'collecting',
             $2::date, 1, 'list', 0, $5,
             clock_timestamp() + ($6::integer * interval '1 millisecond')
           )
           returning ${continuationColumns}`,
          [params.scope, params.periodStart, params.periodEnd, generation, params.leaseOwner, leaseMs],
        );
        await transactionQuery(
          `update metrics.reconciliation_continuation_heads
              set active_generation = $3, period_end = $4::date, updated_at = clock_timestamp()
            where scope = $1 and period_start = $2::date`,
          [params.scope, params.periodStart, generation, params.periodEnd],
        );
        return { acquired: true, claim: mapClaim(requiredRow(inserted), params.leaseOwner) };
      });
    },

    async checkpoint(claim, state, queryOverride) {
      validateState(state, claim.periodStart, claim.periodEnd);
      const result = await (queryOverride ?? query)(
        `update metrics.reconciliation_continuations continuation
            set cursor_day = $6::date,
                cursor_page = $7,
                cursor_phase = $8,
                cursor_detail_index = $9,
                continuation_page = $10,
                pending_detail_ids = $11::jsonb,
                listed_source_ids = $12::jsonb,
                source_entities = $13::jsonb,
                requests_used = $14,
                completed_page_count = $15,
                completed_day_count = $16,
                status = case when status = 'repair_pending' then 'repair_pending' else 'collecting' end,
                lease_expires_at = clock_timestamp() + ($17::integer * interval '1 millisecond'),
                updated_at = clock_timestamp()
          where continuation.scope = $1
            and continuation.period_start = $2::date
            and continuation.generation = $3
            and continuation.fence_token = $4
            and continuation.lease_owner = $5
            and continuation.status in ('collecting', 'repair_pending')
            and exists (
              select 1 from metrics.reconciliation_continuation_heads head
               where head.scope = continuation.scope
                 and head.period_start = continuation.period_start
                 and head.active_generation = continuation.generation
            )`,
        [
          claim.scope,
          claim.periodStart,
          claim.generation,
          claim.fenceToken,
          claim.leaseOwner,
          state.cursorDay,
          state.cursorPage,
          state.cursorPhase,
          state.cursorDetailIndex,
          state.continuationPage,
          JSON.stringify(sortedIds(state.pendingDetailIds)),
          JSON.stringify(sortedIds(state.listedSourceIds)),
          JSON.stringify(sortedEntities(state.sourceEntities)),
          state.requestsUsed,
          state.completedPageCount,
          state.completedDayCount,
          leaseMs,
        ],
      );
      return result.rowCount === 1;
    },

    async reserveRequest(claim, maxRequests, queryOverride) {
      if (!Number.isInteger(maxRequests) || maxRequests <= 0) {
        throw new Error("Reconciliation request limit must be a positive integer.");
      }
      const result = await (queryOverride ?? query)<{ requests_used: number | string }>(
        `update metrics.reconciliation_continuations continuation
            set requests_used = continuation.requests_used + 1,
                lease_expires_at = clock_timestamp() + ($7::integer * interval '1 millisecond'),
                updated_at = clock_timestamp()
          where continuation.scope = $1
            and continuation.period_start = $2::date
            and continuation.generation = $3
            and continuation.fence_token = $4
            and continuation.lease_owner = $5
            and continuation.status in ('collecting', 'repair_pending')
            and continuation.requests_used < $6::bigint
            and exists (
              select 1 from metrics.reconciliation_continuation_heads head
               where head.scope = continuation.scope
                 and head.period_start = continuation.period_start
                 and head.active_generation = continuation.generation
            )
        returning continuation.requests_used`,
        [
          claim.scope,
          claim.periodStart,
          claim.generation,
          claim.fenceToken,
          claim.leaseOwner,
          maxRequests,
          leaseMs,
        ],
      );
      const reserved = result.rows[0]?.requests_used;
      return reserved === undefined ? null : numericInteger(reserved);
    },

    async publish(claim, checkId, status, queryOverride) {
      const result = await (queryOverride ?? query)(
        `update metrics.reconciliation_continuations continuation
            set status = case when $7 = 'matched' then 'completed' else 'repair_pending' end,
                last_check_id = $6,
                completed_at = case when $7 = 'matched' then clock_timestamp() else null end,
                lease_owner = null,
                lease_expires_at = null,
                updated_at = clock_timestamp()
          where continuation.scope = $1
            and continuation.period_start = $2::date
            and continuation.generation = $3
            and continuation.fence_token = $4
            and continuation.lease_owner = $5
            and continuation.cursor_phase = 'complete'
            and continuation.status in ('collecting', 'repair_pending')
            and exists (
              select 1 from metrics.reconciliation_continuation_heads head
               where head.scope = continuation.scope
                 and head.period_start = continuation.period_start
                 and head.active_generation = continuation.generation
            )`,
        [claim.scope, claim.periodStart, claim.generation, claim.fenceToken, claim.leaseOwner, checkId, status],
      );
      return result.rowCount === 1;
    },

    async release(claim, queryOverride) {
      const result = await (queryOverride ?? query)(
        `update metrics.reconciliation_continuations
            set lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp()
          where scope = $1 and period_start = $2::date and generation = $3
            and fence_token = $4 and lease_owner = $5
            and status in ('collecting', 'repair_pending')`,
        [claim.scope, claim.periodStart, claim.generation, claim.fenceToken, claim.leaseOwner],
      );
      return result.rowCount === 1;
    },

    async restartGeneration(params) {
      validatePeriod(params.periodStart, params.periodEnd);
      validateLeaseOwner(params.leaseOwner);
      return transaction(async (transactionQuery) => {
        await ensureContinuationHead(transactionQuery, params);
        const head = await transactionQuery<{ active_generation: number | string }>(
          `select active_generation
             from metrics.reconciliation_continuation_heads
            where scope = $1 and period_start = $2::date
            for update`,
          [params.scope, params.periodStart],
        );
        const previousGeneration = numericInteger(head.rows[0]?.active_generation, 0);
        if (previousGeneration > 0) {
          await transactionQuery(
            `update metrics.reconciliation_continuations
                set status = 'superseded', lease_owner = null, lease_expires_at = null,
                    updated_at = clock_timestamp()
              where scope = $1 and period_start = $2::date and generation = $3
                and status in ('collecting', 'repair_pending')`,
            [params.scope, params.periodStart, previousGeneration],
          );
        }
        const generation = previousGeneration + 1;
        const inserted = await transactionQuery<ContinuationRow>(
          `insert into metrics.reconciliation_continuations (
             scope, period_start, period_end, generation, fence_token, status,
             cursor_day, cursor_page, cursor_phase, cursor_detail_index,
             lease_owner, lease_expires_at
           ) values (
             $1, $2::date, $3::date, $4, 1, 'collecting',
             $2::date, 1, 'list', 0, $5,
             clock_timestamp() + ($6::integer * interval '1 millisecond')
           ) returning ${continuationColumns}`,
          [params.scope, params.periodStart, params.periodEnd, generation, params.leaseOwner, leaseMs],
        );
        await transactionQuery(
          `update metrics.reconciliation_continuation_heads
              set active_generation = $3, period_end = $4::date, updated_at = clock_timestamp()
            where scope = $1 and period_start = $2::date`,
          [params.scope, params.periodStart, generation, params.periodEnd],
        );
        return mapClaim(requiredRow(inserted), params.leaseOwner);
      });
    },

    async hasIncomplete(scope, periodStart) {
      const result = await query<{ present: boolean }>(
        `select exists (
           select 1
             from metrics.reconciliation_continuation_heads head
             join metrics.reconciliation_continuations continuation
               on continuation.scope = head.scope
              and continuation.period_start = head.period_start
              and continuation.generation = head.active_generation
            where head.scope = $1 and head.period_start = $2::date
              and continuation.status in ('collecting', 'repair_pending')
         ) as present`,
        [scope, periodStart],
      );
      return result.rows[0]?.present === true;
    },
  };
}

async function ensureContinuationHead(
  query: PostgresQuery,
  params: {
    scope: DirectReconciliationScope;
    periodStart: string;
    periodEnd: string;
  },
) {
  await query(
    `insert into metrics.reconciliation_continuation_heads (
       scope, period_start, period_end, active_generation
     )
     select $1, $2::date, $3::date,
            greatest(
              coalesce((
                select max(manifest_generation)
                  from metrics.source_period_manifests
                 where period_start = $2::date
                   and source_family in (
                     $1,
                     case when $1 = 'quotes' then 'quote_nested' else 'job_nested' end
                   )
              ), 0),
              coalesce((
                select max(generation)
                  from metrics.reconciliation_checks
                 where scope = $1 and period_start = $2::date
              ), 0),
              coalesce((
                select max(generation)
                  from metrics.reconciliation_continuations
                 where scope = $1 and period_start = $2::date
              ), 0)
            )
     on conflict (scope, period_start) do update
       set period_end = excluded.period_end,
           active_generation = greatest(
             metrics.reconciliation_continuation_heads.active_generation,
             excluded.active_generation
           ),
           updated_at = clock_timestamp()`,
    [params.scope, params.periodStart, params.periodEnd],
  );
}

function requiredRow(result: QueryResult<ContinuationRow>) {
  const row = result.rows[0];
  if (!row) throw new Error("Reconciliation continuation claim was not persisted.");
  return row;
}

function mapClaim(row: ContinuationRow, leaseOwner: string): ReconciliationContinuationClaim {
  return {
    scope: row.scope,
    periodStart: dateText(row.period_start),
    periodEnd: dateText(row.period_end),
    generation: numericInteger(row.generation),
    fenceToken: numericInteger(row.fence_token),
    status: row.status,
    leaseOwner,
    cursorDay: row.cursor_day ? dateText(row.cursor_day) : null,
    cursorPage: numericInteger(row.cursor_page, 1),
    cursorPhase: row.cursor_phase,
    cursorDetailIndex: numericInteger(row.cursor_detail_index, 0),
    continuationPage: row.continuation_page === null ? null : numericInteger(row.continuation_page),
    pendingDetailIds: stringArray(row.pending_detail_ids),
    listedSourceIds: stringArray(row.listed_source_ids),
    sourceEntities: entityRecord(row.source_entities),
    requestsUsed: numericInteger(row.requests_used, 0),
    completedPageCount: numericInteger(row.completed_page_count, 0),
    completedDayCount: numericInteger(row.completed_day_count, 0),
  };
}

function validateState(state: ReconciliationContinuationState, periodStart: string, periodEnd: string) {
  if (state.cursorDay && (state.cursorDay < periodStart || state.cursorDay > periodEnd)) {
    throw new Error(`Reconciliation cursor day ${state.cursorDay} is outside ${periodStart} through ${periodEnd}.`);
  }
  for (const [label, value, minimum] of [
    ["cursorPage", state.cursorPage, 1],
    ["cursorDetailIndex", state.cursorDetailIndex, 0],
    ["requestsUsed", state.requestsUsed, 0],
    ["completedPageCount", state.completedPageCount, 0],
    ["completedDayCount", state.completedDayCount, 0],
  ] as const) {
    if (!Number.isInteger(value) || value < minimum) throw new Error(`${label} is invalid.`);
  }
  if (state.cursorPhase === "complete" && state.cursorDay !== null) {
    throw new Error("A complete reconciliation cursor cannot retain a day.");
  }
}

function validatePeriod(periodStart: string, periodEnd: string) {
  if (!/^\d{4}-\d{2}-01$/.test(periodStart)) throw new Error(`Invalid reconciliation period start: ${periodStart}.`);
  const end = new Date(`${periodStart}T00:00:00.000Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  if (end.toISOString().slice(0, 10) !== periodEnd) {
    throw new Error(`Invalid reconciliation period end: ${periodEnd}.`);
  }
}

function validateLeaseOwner(value: string) {
  if (!value.trim() || value.length > 200) throw new Error("A reconciliation lease owner is required.");
}

function boundedLeaseMs(value: number) {
  if (!Number.isInteger(value) || value < 1_000 || value > 1_800_000) {
    throw new Error("Reconciliation continuation leaseMs must be from 1000 through 1800000.");
  }
  return value;
}

function numericInteger(value: number | string | null | undefined, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function dateText(value: Date | string) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? sortedIds(value.map(String)) : [];
}

function entityRecord(value: unknown): Record<string, ReconciliationContinuationEntity> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entities: Record<string, ReconciliationContinuationEntity> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const totalValue = Number(record.totalValue);
    entities[id] = {
      id,
      totalValue: Number.isFinite(totalValue) ? totalValue : 0,
      stageName: typeof record.stageName === "string" ? record.stageName : null,
    };
  }
  return sortedEntities(entities);
}

function sortedIds(values: string[]) {
  return [...new Set(values.filter((value) => /^\d+$/.test(value)))]
    .sort((left, right) => Number(left) - Number(right));
}

function sortedEntities(value: Record<string, ReconciliationContinuationEntity>) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([id]) => /^\d+$/.test(id))
      .sort(([left], [right]) => Number(left) - Number(right)),
  );
}

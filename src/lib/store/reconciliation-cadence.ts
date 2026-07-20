import {
  runSimproReconciliation,
  type ReconciliationOptions,
  type ReconciliationResult,
  type ReconciliationScope,
} from "@/lib/store/reconciliation";
import { queryPostgres, withPostgresTransaction } from "@/lib/store/postgres";

export const RECONCILIATION_CADENCE_MODES = ["trailing-24-months", "older-stable-history", "all-months"] as const;
export type ReconciliationCadenceMode = (typeof RECONCILIATION_CADENCE_MODES)[number];

export type ReconciliationCadenceOptions = {
  mode: ReconciliationCadenceMode;
  scope: ReconciliationScope;
  batchMonths: number;
  runtimeMinutes: number;
  requestBudget: number;
  force?: boolean;
};

export type ReconciliationCadenceStore = {
  loadCursor(mode: ReconciliationCadenceMode, initialCursor: string): Promise<string>;
  advanceCursor(mode: ReconciliationCadenceMode, expectedCursor: string, nextCursor: string): Promise<boolean>;
  listStableHistoryMonths(cutoffMonth: string): Promise<string[]>;
};

export type ReconciliationCadenceRun = {
  mode: ReconciliationCadenceMode;
  cutoffMonth: string;
  cursorStart: string;
  cursorEnd: string;
  requestsUsed: number;
  stopReason: "batch-limit" | "request-budget" | "runtime-limit" | "no-eligible-months" | "cursor-conflict" | "incomplete-month" | "complete";
  processed: Array<{
    periodStart: string;
    requestsUsed: number;
    results: ReconciliationResult[];
  }>;
};

type QueryResult<T> = {
  rows: T[];
  rowCount: number | null;
};

export type ReconciliationCadenceQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<QueryResult<T>>;

export type ReconciliationCadenceTransaction = <T>(
  callback: (query: ReconciliationCadenceQuery) => Promise<T>,
) => Promise<T>;

type ReconciliationCadenceDependencies = {
  store?: ReconciliationCadenceStore;
  reconcile?: (options: ReconciliationOptions) => Promise<ReconciliationResult[]>;
  clock?: () => Date;
};

const cursorEntity = "reconciliation_cadence";
const stableScopes = ["quotes", "jobs", "technicians", "commissions"] as const;
export const ALL_MONTHS_CURSOR_RESET_CONFIRMATION = "RESET-ALL-MONTHS-RECONCILIATION";

export async function resetAllMonthsReconciliationCursor(params: {
  actorEmail: string;
  confirmation: string;
  query?: ReconciliationCadenceQuery;
  transaction?: ReconciliationCadenceTransaction;
}) {
  const actorEmail = params.actorEmail.trim().toLowerCase();
  if (!actorEmail) throw new Error("actorEmail is required.");
  if (params.confirmation !== ALL_MONTHS_CURSOR_RESET_CONFIRMATION) {
    throw new Error(`confirmation must equal ${ALL_MONTHS_CURSOR_RESET_CONFIRMATION}.`);
  }
  const query = params.query ?? queryPostgres;
  const transaction = params.transaction
    ?? (params.query ? async <T>(callback: (transactionQuery: ReconciliationCadenceQuery) => Promise<T>) => callback(query) : withPostgresTransaction);
  return transaction(async (transactionQuery) => {
    await transactionQuery(
      `insert into metrics.ingestion_watermarks (
         entity, window_key, status, source_hash, last_attempt_at, updated_at
       ) values ($1, 'all-months', 'current', '2023-01-01', now(), now())
       on conflict (entity, window_key) do nothing`,
      [cursorEntity],
    );
    const previous = await transactionQuery<{ source_hash: string | null }>(
      `select source_hash
         from metrics.ingestion_watermarks
        where entity = $1 and window_key = 'all-months'
        for update`,
      [cursorEntity],
    );
    const previousCursor = previous.rows[0]?.source_hash ?? null;
    const reset = await transactionQuery<{ source_hash: string }>(
      `update metrics.ingestion_watermarks
          set status = 'current', source_hash = '2023-01-01',
              last_attempt_at = now(), updated_at = now()
        where entity = $1 and window_key = 'all-months'
        returning source_hash`,
      [cursorEntity],
    );
    const currentCursor = reset.rows[0]?.source_hash;
    const audited = await transactionQuery<{ id: string }>(
      `insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason
       ) values (
         $1, 'reconciliation_all_months_cursor_reset', 'reconciliation_cadence',
         'all-months', jsonb_build_object('cursor', $2::text),
         jsonb_build_object('cursor', $3::text),
         'Explicit full-history production reconciliation campaign reset.'
       )
       returning id::text`,
      [actorEmail, previousCursor, currentCursor],
    );
    const row = {
      previous_cursor: previousCursor,
      current_cursor: currentCursor ?? "",
      audit_id: audited.rows[0]?.id ?? "",
    };
    if (row.current_cursor !== "2023-01-01" || !row.audit_id) {
      throw new Error("All-month reconciliation cursor reset did not persist atomically.");
    }
    return row;
  });
}

export function createPostgresReconciliationCadenceStore(
  query: ReconciliationCadenceQuery = queryPostgres,
): ReconciliationCadenceStore {
  return {
    async loadCursor(mode, initialCursor) {
      await query(
        `insert into metrics.ingestion_watermarks (
           entity, window_key, status, source_hash, last_attempt_at, updated_at
         )
         values ($1, $2, 'current', $3, now(), now())
         on conflict (entity, window_key) do nothing`,
        [cursorEntity, mode, initialCursor],
      );
      const result = await query<{ source_hash: string | null }>(
        `select source_hash
           from metrics.ingestion_watermarks
          where entity = $1 and window_key = $2`,
        [cursorEntity, mode],
      );
      return result.rows[0]?.source_hash ?? initialCursor;
    },

    async advanceCursor(mode, expectedCursor, nextCursor) {
      const result = await query<{ source_hash: string }>(
        `update metrics.ingestion_watermarks
            set source_hash = $4,
                status = 'current',
                last_success_at = now(),
                last_attempt_at = now(),
                updated_at = now()
          where entity = $1
            and window_key = $2
            and source_hash = $3
        returning source_hash`,
        [cursorEntity, mode, expectedCursor, nextCursor],
      );
      return result.rowCount === 1;
    },

    async listStableHistoryMonths(cutoffMonth) {
      const result = await query<{ period_start: string }>(
        `with ranked as (
           select id, scope, period_start, status, rollup_value, snapshot_value,
                  upstream_sample_value, detail,
                  row_number() over (
                    partition by scope, period_start
                    order by checked_at desc, id desc
                  ) as position
             from metrics.reconciliation_checks
            where period_start < $1::date
              and scope = any($2::text[])
         ), latest as (
           select * from ranked where position = 1
         ), previous as (
           select * from ranked where position = 2
         )
         select latest.period_start::text as period_start
           from latest
           join previous
             on previous.scope = latest.scope
            and previous.period_start = latest.period_start
          where latest.status = 'matched'
            and previous.status = 'matched'
            and latest.rollup_value is not distinct from previous.rollup_value
            and latest.snapshot_value is not distinct from previous.snapshot_value
            and latest.upstream_sample_value is not distinct from previous.upstream_sample_value
            and (latest.detail #>> '{dashboard,sourceHash}')
                is not distinct from (previous.detail #>> '{dashboard,sourceHash}')
          group by latest.period_start
         having count(distinct latest.scope) = $3
          order by latest.period_start`,
        [cutoffMonth, stableScopes, stableScopes.length],
      );
      return result.rows.map((row) => row.period_start);
    },
  };
}

export async function runReconciliationCadence(
  options: ReconciliationCadenceOptions,
  dependencies: ReconciliationCadenceDependencies = {},
): Promise<ReconciliationCadenceRun> {
  validateOptions(options);
  const store = dependencies.store ?? createPostgresReconciliationCadenceStore();
  const injectedReconcile = dependencies.reconcile;
  const reconcile = injectedReconcile
    ? (reconciliationOptions: ReconciliationOptions) => injectedReconcile({
        ...reconciliationOptions,
        ...(options.force === true ? { onlyIfNeeded: false } : {}),
      })
    : (reconciliationOptions: ReconciliationOptions) => runSimproReconciliation({
        ...reconciliationOptions,
        onlyIfNeeded: options.force !== true,
      });
  const clock = dependencies.clock ?? (() => new Date());
  const startedAt = clock();
  const deadlineMs = startedAt.getTime() + options.runtimeMinutes * 60_000;
  const trailingMonths = trailingMonthStarts(startedAt);
  const cutoffMonth = trailingMonths[0];

  if (options.mode === "trailing-24-months") {
    return runTrailingCadence({ options, store, reconcile, clock, deadlineMs, trailingMonths, cutoffMonth });
  }
  if (options.mode === "older-stable-history") {
    return runStableHistoryCadence({ options, store, reconcile, clock, deadlineMs, cutoffMonth });
  }
  if (options.mode === "all-months") {
    return runAllMonthsCadence({ options, store, reconcile, clock, deadlineMs, cutoffMonth, startedAt });
  }
  throw new Error(`Unknown reconciliation cadence mode: ${String(options.mode)}`);
}

export function pacificMonthStart(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Unable to determine the current Pacific month.");
  return `${year}-${month}-01`;
}

export function trailingMonthStarts(date = new Date()): string[] {
  const current = pacificMonthStart(date);
  return Array.from({ length: 24 }, (_, index) => addMonths(current, index - 23));
}

export function allMonthStarts(date = new Date()): string[] {
  const current = pacificMonthStart(date);
  const months: string[] = [];
  for (let month = "2023-01-01"; month <= current; month = addMonths(month, 1)) months.push(month);
  return months;
}

async function runTrailingCadence(params: {
  options: ReconciliationCadenceOptions;
  store: ReconciliationCadenceStore;
  reconcile: (options: ReconciliationOptions) => Promise<ReconciliationResult[]>;
  clock: () => Date;
  deadlineMs: number;
  trailingMonths: string[];
  cutoffMonth: string;
}): Promise<ReconciliationCadenceRun> {
  const { options, store, reconcile, clock, deadlineMs, trailingMonths, cutoffMonth } = params;
  let cursor = await store.loadCursor(options.mode, cutoffMonth);
  const cursorStart = cursor;
  if (!trailingMonths.includes(cursor)) {
    const reset = await store.advanceCursor(options.mode, cursor, cutoffMonth);
    if (!reset) return emptyRun(options.mode, cutoffMonth, cursorStart, cursor, "cursor-conflict");
    cursor = cutoffMonth;
  }

  const processed: ReconciliationCadenceRun["processed"] = [];
  let requestsUsed = 0;
  let stopReason: ReconciliationCadenceRun["stopReason"] = "batch-limit";

  while (processed.length < options.batchMonths) {
    if (clock().getTime() >= deadlineMs) {
      stopReason = "runtime-limit";
      break;
    }
    if (requestsUsed >= options.requestBudget) {
      stopReason = "request-budget";
      break;
    }

    const periodStart = trailingMonths.includes(cursor) ? cursor : cutoffMonth;
    const remainingBudget = options.requestBudget - requestsUsed;
    const results = await reconcile({
      scope: options.scope,
      periodStart,
      requestBudget: remainingBudget,
    });
    const monthRequests = Math.min(remainingBudget, reconciliationRequestsUsed(results));
    requestsUsed += monthRequests;
    processed.push({ periodStart, requestsUsed: monthRequests, results });

    const position = trailingMonths.indexOf(periodStart);
    const nextCursor = trailingMonths[(position + 1) % trailingMonths.length];
    if (!await store.advanceCursor(options.mode, cursor, nextCursor)) {
      stopReason = "cursor-conflict";
      break;
    }
    cursor = nextCursor;
  }

  return { mode: options.mode, cutoffMonth, cursorStart, cursorEnd: cursor, requestsUsed, stopReason, processed };
}

async function runStableHistoryCadence(params: {
  options: ReconciliationCadenceOptions;
  store: ReconciliationCadenceStore;
  reconcile: (options: ReconciliationOptions) => Promise<ReconciliationResult[]>;
  clock: () => Date;
  deadlineMs: number;
  cutoffMonth: string;
}): Promise<ReconciliationCadenceRun> {
  const { options, store, reconcile, clock, deadlineMs, cutoffMonth } = params;
  const eligibleMonths = await store.listStableHistoryMonths(cutoffMonth);
  const initialCursor = eligibleMonths[0] ?? cutoffMonth;
  let cursor = await store.loadCursor(options.mode, initialCursor);
  const cursorStart = cursor;
  if (eligibleMonths.length === 0) {
    return emptyRun(options.mode, cutoffMonth, cursorStart, cursor, "no-eligible-months");
  }

  const remaining = eligibleMonths.filter((month) => month >= cursor);
  const candidates = (remaining.length > 0 ? remaining : eligibleMonths).slice(0, options.batchMonths);
  const processed: ReconciliationCadenceRun["processed"] = [];
  let requestsUsed = 0;
  let stopReason: ReconciliationCadenceRun["stopReason"] = "batch-limit";

  for (const periodStart of candidates) {
    if (clock().getTime() >= deadlineMs) {
      stopReason = "runtime-limit";
      break;
    }
    if (requestsUsed >= options.requestBudget) {
      stopReason = "request-budget";
      break;
    }

    const remainingBudget = options.requestBudget - requestsUsed;
    const results = await reconcile({
      scope: options.scope,
      periodStart,
      requestBudget: remainingBudget,
    });
    const monthRequests = Math.min(remainingBudget, reconciliationRequestsUsed(results));
    requestsUsed += monthRequests;
    processed.push({ periodStart, requestsUsed: monthRequests, results });

    const nextCursor = addMonths(periodStart, 1);
    if (!await store.advanceCursor(options.mode, cursor, nextCursor)) {
      stopReason = "cursor-conflict";
      break;
    }
    cursor = nextCursor;
  }

  return { mode: options.mode, cutoffMonth, cursorStart, cursorEnd: cursor, requestsUsed, stopReason, processed };
}

async function runAllMonthsCadence(params: {
  options: ReconciliationCadenceOptions;
  store: ReconciliationCadenceStore;
  reconcile: (options: ReconciliationOptions) => Promise<ReconciliationResult[]>;
  clock: () => Date;
  deadlineMs: number;
  cutoffMonth: string;
  startedAt: Date;
}): Promise<ReconciliationCadenceRun> {
  const { options, store, reconcile, clock, deadlineMs, cutoffMonth, startedAt } = params;
  const eligibleMonths = allMonthStarts(startedAt);
  const firstMonth = eligibleMonths[0];
  const monthAfterCurrent = addMonths(eligibleMonths.at(-1)!, 1);
  let cursor = await store.loadCursor(options.mode, firstMonth);
  const cursorStart = cursor;
  if (cursor === monthAfterCurrent) {
    return emptyRun(options.mode, cutoffMonth, cursorStart, cursor, "complete");
  }
  if (!eligibleMonths.includes(cursor)) {
    if (!await store.advanceCursor(options.mode, cursor, firstMonth)) {
      return emptyRun(options.mode, cutoffMonth, cursorStart, cursor, "cursor-conflict");
    }
    cursor = firstMonth;
  }

  const processed: ReconciliationCadenceRun["processed"] = [];
  let requestsUsed = 0;
  let stopReason: ReconciliationCadenceRun["stopReason"] = "batch-limit";
  while (processed.length < options.batchMonths && cursor <= eligibleMonths.at(-1)!) {
    if (clock().getTime() >= deadlineMs) {
      stopReason = "runtime-limit";
      break;
    }
    if (requestsUsed >= options.requestBudget) {
      stopReason = "request-budget";
      break;
    }

    const remainingBudget = options.requestBudget - requestsUsed;
    const results = await reconcile({
      scope: options.scope,
      periodStart: cursor,
      requestBudget: remainingBudget,
    });
    const monthRequests = Math.min(remainingBudget, reconciliationRequestsUsed(results));
    requestsUsed += monthRequests;
    processed.push({ periodStart: cursor, requestsUsed: monthRequests, results });

    if (!isCompleteReconciliationMonth(options.scope, cursor, results)) {
      stopReason = "incomplete-month";
      break;
    }

    const nextCursor = addMonths(cursor, 1);
    if (!await store.advanceCursor(options.mode, cursor, nextCursor)) {
      stopReason = "cursor-conflict";
      break;
    }
    cursor = nextCursor;
    if (cursor === monthAfterCurrent) {
      stopReason = "complete";
      break;
    }
  }
  if (stopReason === "batch-limit" && requestsUsed >= options.requestBudget) stopReason = "request-budget";
  return { mode: options.mode, cutoffMonth, cursorStart, cursorEnd: cursor, requestsUsed, stopReason, processed };
}

function isCompleteReconciliationMonth(
  scope: ReconciliationScope,
  periodStart: string,
  results: ReconciliationResult[],
) {
  const expectedScopes = scope === "all" ? stableScopes : [scope];
  if (results.length !== expectedScopes.length) return false;
  const matchedScopes = new Set(
    results
      .filter((result) => result.periodStart === periodStart && result.status === "matched")
      .filter((result) => result.completeTraversal !== false)
      .map((result) => result.scope),
  );
  return expectedScopes.every((expectedScope) => matchedScopes.has(expectedScope));
}

function reconciliationRequestsUsed(results: ReconciliationResult[]): number {
  return results.reduce((maximum, result) => {
    const used = Number(result.detail.requestsUsed);
    return Number.isInteger(used) && used >= 0 ? Math.max(maximum, used) : maximum;
  }, 0);
}

function emptyRun(
  mode: ReconciliationCadenceMode,
  cutoffMonth: string,
  cursorStart: string,
  cursorEnd: string,
  stopReason: ReconciliationCadenceRun["stopReason"],
): ReconciliationCadenceRun {
  return { mode, cutoffMonth, cursorStart, cursorEnd, requestsUsed: 0, stopReason, processed: [] };
}

function validateOptions(options: ReconciliationCadenceOptions) {
  if (!RECONCILIATION_CADENCE_MODES.includes(options.mode)) {
    throw new Error(`Unknown reconciliation cadence mode: ${String(options.mode)}`);
  }
  const maximumBatchMonths = options.mode === "all-months" ? 60 : 3;
  if (!Number.isInteger(options.batchMonths) || options.batchMonths < 1 || options.batchMonths > maximumBatchMonths) {
    throw new Error(`Reconciliation cadence batchMonths must be an integer from 1 through ${maximumBatchMonths}.`);
  }
  if (!Number.isFinite(options.runtimeMinutes) || options.runtimeMinutes <= 0 || options.runtimeMinutes > 20) {
    throw new Error("Reconciliation cadence runtimeMinutes must be greater than 0 and no more than 20.");
  }
  if (!Number.isInteger(options.requestBudget) || options.requestBudget < 1 || options.requestBudget > 1000) {
    throw new Error("Reconciliation cadence requestBudget must be an integer from 1 through 1000.");
  }
  if (options.force !== undefined && typeof options.force !== "boolean") {
    throw new Error("Reconciliation cadence force must be a boolean.");
  }
}

function addMonths(monthStart: string, count: number): string {
  if (!/^\d{4}-\d{2}-01$/.test(monthStart)) throw new Error(`Invalid month start: ${monthStart}`);
  const [year, month] = monthStart.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + count, 1)).toISOString().slice(0, 10);
}

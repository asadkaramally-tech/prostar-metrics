import {
  COMMISSION_INITIALIZATION_QUEUE_REASON,
  COMMISSION_INITIALIZATION_START_MONTH,
  LOCKED_COMMISSION_POLICY_EVIDENCE,
  commissionInitializationQueueKey,
  normalizeCommissionInitializationActor,
  resolveCommissionInitializationMonth,
} from "@/lib/store/commission-period-initialization";
import {
  readCommissionInitializationPrerequisites,
  type CommissionInitializationPrerequisiteStatus,
} from "@/lib/store/commission-initialization-prerequisites";
import {
  queryPostgres,
  withPostgresTransaction,
  type PostgresQuery,
} from "@/lib/store/postgres";
import type { RollupRebuildJob } from "@/lib/store/read-model-rebuilds";

const REPAIR_ACTION = "commission_initialization_rebuild_requeued";

export type { CommissionInitializationPrerequisiteStatus };

export type CommissionInitializationQueueStatus = {
  throughMonth: string;
  expectedPeriods: number;
  auditedPeriods: number;
  linkedQueues: number;
  statuses: Record<string, number>;
  incompleteMonths: string[];
};

type QueueStatusRow = {
  period_start: string;
  audit_count: number;
  rebuild_action: string | null;
  queue_id: string | null;
  status: string | null;
  raw_queue_count: number;
};

type RepairRow = {
  id: string;
  status: string;
  attempts: number;
  error_message: string | null;
  idempotency_key: string;
};

type CanonicalQueueIdentityRow = {
  id: string;
  period_start: string;
};

export function commissionInitializationDrainConfirmationToken(throughMonth: string): string {
  return `DRAIN-COMMISSION-INITIALIZATION-${COMMISSION_INITIALIZATION_START_MONTH}-THROUGH-${throughMonth}`;
}

export function commissionInitializationRepairConfirmationToken(month: string): string {
  return `REQUEUE-COMMISSION-INITIALIZATION-${month}`;
}

export async function getCommissionInitializationQueueStatus(
  throughMonth: string,
  query: PostgresQuery = queryPostgres,
): Promise<CommissionInitializationQueueStatus> {
  const through = resolveCommissionInitializationMonth(throughMonth);
  const result = await query<QueueStatusRow>(
    `with months as (
       select generate_series($1::date, $2::date, interval '1 month')::date as period_start
     ), latest_periods as (
       select distinct on (period_start) id, period_start
         from metrics.commission_periods
        where period_start between $1::date and $2::date
        order by period_start, revision desc, id desc
     ), evidence as (
       select p.period_start, count(a.initialization_audit_id)::int as audit_count,
              min(a.after_value ->> 'rebuildAction') as rebuild_action
         from latest_periods p
         join metrics.commission_initialization_v2_audit_records a
           on a.period_id = p.id
          and a.migration_036_sha256 = $3
        group by p.period_start
     )
     select m.period_start::text, coalesce(e.audit_count, 0)::int as audit_count,
            e.rebuild_action, exact.id::text as queue_id, exact.status::text,
            (select count(*)::int
               from metrics.rollup_rebuild_queue raw
              where raw.idempotency_key = 'commissions:month:' || m.period_start::text || ':commission-period-initialization-v2') as raw_queue_count
       from months m
       left join evidence e on e.period_start = m.period_start
       left join metrics.commission_initialization_v2_queue_records exact
         on exact.period_start = m.period_start
        and exact.migration_036_sha256 = $3
       order by m.period_start`,
    [
      `${COMMISSION_INITIALIZATION_START_MONTH}-01`,
      `${through}-01`,
      LOCKED_COMMISSION_POLICY_EVIDENCE.integrityMigration.sha256,
    ],
  );
  const statuses: Record<string, number> = {};
  const incompleteMonths: string[] = [];
  for (const row of result.rows) {
    const status = queueStatusLabel(row);
    statuses[status] = (statuses[status] ?? 0) + 1;
    if (!queueStatusComplete(row, status)) incompleteMonths.push(row.period_start.slice(0, 7));
  }
  return {
    throughMonth: through,
    expectedPeriods: result.rows.length,
    auditedPeriods: result.rows.filter((row) => row.audit_count === 1).length,
    linkedQueues: result.rows.filter((row) => row.queue_id !== null).length,
    statuses,
    incompleteMonths,
  };
}

export async function checkCommissionInitializationPrerequisites(
  throughMonth: string,
  query: PostgresQuery = queryPostgres,
): Promise<CommissionInitializationPrerequisiteStatus> {
  const through = resolveCommissionInitializationMonth(throughMonth);
  return readCommissionInitializationPrerequisites(COMMISSION_INITIALIZATION_START_MONTH, through, query);
}

export async function getCanonicalCommissionInitializationQueueIds(
  throughMonth: string,
  query: PostgresQuery = queryPostgres,
): Promise<number[]> {
  const through = resolveCommissionInitializationMonth(throughMonth);
  const result = await query<CanonicalQueueIdentityRow>(
    `select q.id::text, q.period_start::text
       from metrics.rollup_rebuild_queue q
       join metrics.schema_migrations migration
         on migration.filename = '036_commission_initialization_integrity.sql'
        and migration.sha256 = $3
      where q.period_start between $1::date and $2::date
        and q.metric_family = 'commissions'
        and q.period_grain = 'month'
        and q.dimensions_json = '{}'::jsonb
        and q.reason = $4
        and q.idempotency_key = 'commissions:month:' || q.period_start::text || ':commission-period-initialization-v2'
        and q.created_at >= migration.applied_at
        and exists (
          select 1
            from metrics.commission_periods period
           where period.period_start = q.period_start
             and not exists (
               select 1
                 from metrics.commission_periods newer
                where newer.period_start = period.period_start
                  and (newer.revision > period.revision
                    or (newer.revision = period.revision and newer.id > period.id))
             )
             and (
               select count(*)
                 from metrics.audit_events audit
                where audit.entity_type = 'commission_period'
                  and audit.entity_id = period.id::text
                  and audit.action = 'commission_period_historical_initialization_evidenced'
                  and lower(audit.actor_email) in ('asad@prostarmechanical.com', 'laila@prostarmechanical.com')
                  and audit.after_value ->> 'initializationVersion' = 'commission-period-initialization-v2'
                  and audit.after_value ->> 'periodRevision' = period.revision::text
                  and audit.after_value -> 'evidence' -> 'integrityMigration' ->> 'sha256' = migration.sha256
                  and audit.after_value -> 'rebuildQueue' = jsonb_build_object(
                    'id', q.id::text,
                    'metricFamily', q.metric_family,
                    'periodGrain', q.period_grain,
                    'periodStart', q.period_start::text,
                    'dimensions', q.dimensions_json,
                    'reason', q.reason,
                    'idempotencyKey', q.idempotency_key,
                    'createdAt', to_char(q.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                  )
             ) = 1
        )
      order by q.period_start`,
    [
      `${COMMISSION_INITIALIZATION_START_MONTH}-01`,
      `${through}-01`,
      LOCKED_COMMISSION_POLICY_EVIDENCE.integrityMigration.sha256,
      COMMISSION_INITIALIZATION_QUEUE_REASON,
    ],
  );
  const expectedPeriods = initializationPeriodStarts(through);
  const actualPeriods = result.rows.map((row) => row.period_start.slice(0, 10));
  if (JSON.stringify(actualPeriods) !== JSON.stringify(expectedPeriods)) {
    throw new Error("Commission initialization drain requires one canonical audited queue identity for every month in the range.");
  }
  const ids = result.rows.map((row) => Number(row.id));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw new Error("Commission initialization drain canonical queue identities are invalid or duplicated.");
  }
  return ids;
}

export async function claimCommissionInitializationRebuild(
  params: {
    throughMonth: string;
    workerId: string;
    excludeJobIds?: number[];
    rangePrerequisitesVerified?: boolean;
    verifiedQueueIds?: number[];
  },
  query: PostgresQuery = queryPostgres,
): Promise<RollupRebuildJob | null> {
  const through = resolveCommissionInitializationMonth(params.throughMonth);
  const verifiedQueueIds = params.verifiedQueueIds?.filter((id) => Number.isSafeInteger(id) && id > 0);
  if (params.verifiedQueueIds && verifiedQueueIds?.length !== params.verifiedQueueIds.length) {
    throw new Error("Verified commission initialization queue IDs must be positive safe integers.");
  }
  const queueIdentityPredicate = verifiedQueueIds
    ? "q.id = any($5::bigint[])"
    : `exists (
         select 1
           from metrics.commission_initialization_v2_queue_records exact
          where exact.id = q.id
            and exact.migration_036_sha256 = $5
       )`;
  const prerequisitePredicate = params.rangePrerequisitesVerified && verifiedQueueIds
    ? "true"
    : "metrics.commission_initialization_prerequisites_accepted(period_start)";
  const result = await query<RollupRebuildJob>(
    `with candidate as materialized (
       select q.id, q.period_start
         from metrics.rollup_rebuild_queue q
        where q.period_start between $1::date and $2::date
          and ${queueIdentityPredicate}
          and not (q.id = any($3::bigint[]))
          and ((q.status = 'queued' and (q.locked_until is null or q.locked_until < now()))
            or (q.status = 'running' and q.locked_until < now() and q.attempts < 5))
        order by q.period_start, q.id
        for update of q skip locked
        limit 1
     ), eligible as materialized (
       select id
         from candidate
        where ${prerequisitePredicate}
     )
     update metrics.rollup_rebuild_queue q
        set status = 'running',
            attempts = case when q.status = 'queued' and q.error_message is null then 1 else q.attempts + 1 end,
            locked_by = $4,
            locked_until = now() + interval '10 minutes',
            finished_at = null
       from eligible
      where q.id = eligible.id
      returning q.id, q.metric_family, q.period_grain, q.period_start::text,
                q.dimensions_json, q.locked_by`,
    [
      `${COMMISSION_INITIALIZATION_START_MONTH}-01`,
      `${through}-01`,
      params.excludeJobIds ?? [],
      params.workerId,
      verifiedQueueIds ?? LOCKED_COMMISSION_POLICY_EVIDENCE.integrityMigration.sha256,
    ],
  );
  return result.rows[0] ?? null;
}

function initializationPeriodStarts(throughMonth: string): string[] {
  const [startYear, startMonth] = COMMISSION_INITIALIZATION_START_MONTH.split("-").map(Number);
  const [endYear, endMonth] = throughMonth.split("-").map(Number);
  const start = startYear * 12 + startMonth - 1;
  const end = endYear * 12 + endMonth - 1;
  return Array.from({ length: end - start + 1 }, (_, index) => {
    const value = start + index;
    return `${Math.floor(value / 12)}-${String(value % 12 + 1).padStart(2, "0")}-01`;
  });
}

export async function repairFailedCommissionInitializationRebuild(
  params: {
    month: string;
    actorEmail: string;
    reason: string;
    confirmation: string;
  },
  transaction = withPostgresTransaction,
): Promise<{ queueId: string; status: "queued" }> {
  const month = resolveCommissionInitializationMonth(params.month);
  const actorEmail = normalizeCommissionInitializationActor(params.actorEmail);
  const reason = params.reason.trim();
  if (params.confirmation !== commissionInitializationRepairConfirmationToken(month)) {
    throw new Error(`Repair requires --confirm ${commissionInitializationRepairConfirmationToken(month)}.`);
  }
  if (reason.length < 10 || reason.length > 1000) throw new Error("--reason must be between 10 and 1000 characters.");

  const run = () => transaction(async (query) => {
    await query("set transaction isolation level serializable");
    await query("select pg_advisory_xact_lock(hashtextextended('metrics:historical-commission-period-initialization', 0))");
    const prerequisites = await readCommissionInitializationPrerequisites(month, month, query);
    if (!prerequisites.ready) {
      throw new Error(`${month} source reconciliation prerequisites are not accepted; repair made no queue changes.`);
    }
    const selected = await query<RepairRow>(
      `select q.id::text, q.status::text, q.attempts, q.error_message, q.idempotency_key
         from metrics.commission_initialization_v2_queue_records exact
         join metrics.rollup_rebuild_queue q on q.id = exact.id
        where exact.period_start = $1::date
          and exact.migration_036_sha256 = $2
        for update of q`,
      [`${month}-01`, LOCKED_COMMISSION_POLICY_EVIDENCE.integrityMigration.sha256],
    );
    if (selected.rows.length !== 1) {
      throw new Error(`${month} does not have exactly one complete initialization-v2 rebuild queue identity.`);
    }
    const row = selected.rows[0];
    if (row.status !== "failed") throw new Error(`${month} initialization queue ${row.id} is ${row.status}; only failed records may be repaired.`);

    const updated = await query<{ id: string }>(
      `update metrics.rollup_rebuild_queue
          set status = 'queued', attempts = 0, locked_by = null, locked_until = null,
              finished_at = null, error_message = null
        where id = $1::bigint and status = 'failed'
        returning id::text`,
      [row.id],
    );
    if (updated.rows.length !== 1) throw new Error(`Failed queue ${row.id} changed concurrently.`);
    await query(
      `insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason
       ) values ($1, $2, 'rollup_rebuild_queue', $3, $4::jsonb, $5::jsonb, $6)`,
      [
        actorEmail,
        REPAIR_ACTION,
        row.id,
        JSON.stringify({ status: row.status, attempts: row.attempts, errorMessage: row.error_message }),
        JSON.stringify({
          status: "queued",
          attempts: 0,
          idempotencyKey: row.idempotency_key,
          reason: COMMISSION_INITIALIZATION_QUEUE_REASON,
        }),
        reason,
      ],
    );
    return { queueId: row.id, status: "queued" as const };
  });

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 3 || !isSerializationFailure(error)) throw error;
    }
  }
}

export async function assertCommissionInitializationRebuildCompleted(
  job: Pick<RollupRebuildJob, "id" | "period_start">,
  verifiedQueueIds?: number[],
  query: PostgresQuery = queryPostgres,
): Promise<void> {
  const useVerifiedIdentity = verifiedQueueIds !== undefined;
  const normalizedJobId = Number(job.id);
  if (!Number.isSafeInteger(normalizedJobId) || normalizedJobId <= 0) {
    throw new Error(`Commission initialization rebuild ${job.id} has an invalid queue identity.`);
  }
  if (useVerifiedIdentity && !verifiedQueueIds.includes(normalizedJobId)) {
    throw new Error(`Commission initialization rebuild ${job.id} is outside the verified queue identity set.`);
  }
  const queueSource = useVerifiedIdentity
    ? "metrics.rollup_rebuild_queue exact"
    : "metrics.commission_initialization_v2_queue_records exact";
  const migrationPredicate = useVerifiedIdentity ? "" : "and exact.migration_036_sha256 = $3";
  const result = await query<{ id: string }>(
    `select exact.id::text
       from ${queueSource}
       join metrics.dashboard_read_models read_model
         on read_model.metric_family = exact.metric_family
        and read_model.period_grain = exact.period_grain
        and read_model.period_start = exact.period_start
        and read_model.dimensions_json = exact.dimensions_json
        and read_model.rebuilt_by_job_id = exact.id
        and read_model.status = 'ready'
        and read_model.superseded_at is null
      where exact.id = $1::bigint
        and exact.period_start = $2::date
        ${migrationPredicate}
        and exact.status = 'succeeded'`,
    useVerifiedIdentity
      ? [job.id, job.period_start]
      : [job.id, job.period_start, LOCKED_COMMISSION_POLICY_EVIDENCE.integrityMigration.sha256],
  );
  if (!result.rows[0]) {
    throw new Error(`Commission initialization rebuild ${job.id} did not retain exact queue ownership through successful publication.`);
  }
}

export function expectedCommissionInitializationQueueIdentity(periodStart: string) {
  return {
    idempotencyKey: commissionInitializationQueueKey(periodStart),
    reason: COMMISSION_INITIALIZATION_QUEUE_REASON,
  };
}

function queueStatusLabel(row: QueueStatusRow): string {
  if (row.audit_count !== 1) return "missing_audit";
  if (!(["enqueue", "use_existing", "not_needed"] as Array<string | null>).includes(row.rebuild_action)) return "invalid_audit";
  if (row.rebuild_action === "not_needed") {
    return row.queue_id === null && row.raw_queue_count === 0 ? "no_queue" : "invalid_queue";
  }
  return row.queue_id === null || row.raw_queue_count !== 1 ? "invalid_queue" : row.status ?? "invalid_queue";
}

function queueStatusComplete(row: QueueStatusRow, status: string): boolean {
  return row.audit_count === 1
    && ((row.rebuild_action === "not_needed" && status === "no_queue") || status === "succeeded");
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "40001";
}

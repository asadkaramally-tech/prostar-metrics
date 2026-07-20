import { randomUUID } from "node:crypto";
import { queryPostgres, type PostgresQuery } from "@/lib/store/postgres";

export const OPERATIONAL_HEALTH_EVENT = "prostar_metrics_operational_health" as const;
export const INGESTION_FAILURE_ALERT_ID = "ingestion-three-consecutive-failures" as const;
export const DEAD_LETTER_ALERT_ID = "dead-letter-immediate" as const;

export type OperationalTelemetrySignal = {
  event: typeof OPERATIONAL_HEALTH_EVENT;
  severity: "critical";
  alertId: typeof INGESTION_FAILURE_ALERT_ID | typeof DEAD_LETTER_ALERT_ID;
  eventKey: string;
  sourceFamily: string;
  consecutiveFailures: number;
  deadLetterCount: number;
  evidenceKind: "ingestion_run" | "ingestion_job" | "backfill_work_unit";
  evidenceId: string;
  occurredAt: string;
};

type EmissionRow = {
  event_key: string;
  event_name: OperationalTelemetrySignal["alertId"];
  source_family: string;
  evidence_kind: OperationalTelemetrySignal["evidenceKind"];
  evidence_id: string;
  occurred_at: Date | string;
  metric_value: number | string;
};

const discoverOperationalTelemetrySql = `
with completed_runs as materialized (
  select id,
         coalesce(nullif(source_family, ''), entity_type::text) as source_family,
         status::text as status,
         finished_at
    from metrics.ingestion_runs
   where finished_at is not null
     and status::text in ('queued', 'succeeded', 'failed', 'cancelled')
), sequenced_runs as (
  select completed_runs.*,
         sum(case when status <> 'failed' then 1 else 0 end) over (
           partition by source_family
           order by finished_at desc, id desc
           rows between unbounded preceding and current row
         ) as reset_count
    from completed_runs
), current_failure_runs as (
  select id, source_family, finished_at
    from sequenced_runs
   where status = 'failed'
     and reset_count = 0
), failure_streaks as (
  select source_family,
         count(*)::integer as consecutive_failures,
         (array_agg(id order by finished_at, id))[3] as threshold_run_id,
         (array_agg(finished_at order by finished_at, id))[3] as threshold_crossed_at
    from current_failure_runs
   group by source_family
  having count(*) >= 3
), dead_letters as materialized (
  select 'ingestion_job'::text as evidence_kind,
         id::text as evidence_id,
         entity_type::text as source_family,
         dead_lettered_at as occurred_at
    from metrics.ingestion_jobs
   where status::text = 'failed'
     and dead_lettered_at is not null
  union all
  select 'backfill_work_unit'::text,
         id::text,
         source_family,
         dead_lettered_at
    from metrics.backfill_source_month_ledger
   where status = 'dead_lettered'
     and dead_lettered_at is not null
), candidates as (
  select 'ingestion-failure-streak:' || source_family || ':' || threshold_run_id::text as event_key,
         '${INGESTION_FAILURE_ALERT_ID}'::text as event_name,
         source_family,
         'ingestion_run'::text as evidence_kind,
         threshold_run_id::text as evidence_id,
         threshold_crossed_at as occurred_at,
         consecutive_failures as metric_value
    from failure_streaks
  union all
  select 'dead-letter:' || evidence_kind || ':' || evidence_id || ':' || occurred_at::text,
         '${DEAD_LETTER_ALERT_ID}'::text,
         source_family,
         evidence_kind,
         evidence_id,
         occurred_at,
         1::integer
    from dead_letters
), discovered as (
  insert into metrics.operational_telemetry_emissions (
    event_key, event_name, source_family, evidence_kind, evidence_id, occurred_at, metric_value
  )
  select event_key, event_name, source_family, evidence_kind, evidence_id, occurred_at, metric_value
    from candidates
  on conflict (event_key) do nothing
  returning event_key
)
select count(*)::integer as discovered_count from discovered`;

const claimOperationalTelemetrySql = `
with claimable as materialized (
  select emission.event_key
    from metrics.operational_telemetry_emissions emission
   where emission.delivery_status = 'pending'
     and (
       emission.lease_owner is null
       or emission.lease_owner = $1::text
       or emission.lease_expires_at <= clock_timestamp()
     )
   order by emission.occurred_at, emission.event_key
   limit $3::integer
   for update skip locked
), claimed as (
  update metrics.operational_telemetry_emissions emission
     set lease_owner = $1::text,
         lease_expires_at = clock_timestamp() + ($2::integer * interval '1 millisecond'),
         delivery_attempts = emission.delivery_attempts + 1,
         last_attempted_at = clock_timestamp()
    from claimable
   where emission.event_key = claimable.event_key
  returning emission.event_key, emission.event_name, emission.source_family,
            emission.evidence_kind, emission.evidence_id, emission.occurred_at,
            emission.metric_value
)
select event_key, event_name, source_family, evidence_kind, evidence_id, occurred_at, metric_value
  from claimed
 order by occurred_at, event_key`;

export async function claimOperationalTelemetrySignals(
  query: PostgresQuery = queryPostgres,
  options: {
    leaseOwner?: string;
    leaseMs?: number;
    batchSize?: number;
  } = {},
): Promise<OperationalTelemetrySignal[]> {
  const leaseOwner = options.leaseOwner ?? `operational-telemetry-${randomUUID()}`;
  if (!leaseOwner.trim()) throw new Error("Operational telemetry leaseOwner is required.");
  const leaseMs = boundedInteger(options.leaseMs ?? 60_000, 1_000, 15 * 60_000, "leaseMs");
  const batchSize = boundedInteger(options.batchSize ?? 100, 1, 1_000, "batchSize");
  await query(discoverOperationalTelemetrySql);
  const result = await query<EmissionRow>(claimOperationalTelemetrySql, [leaseOwner, leaseMs, batchSize]);
  return result.rows.map((row) => {
    const metricValue = Number(row.metric_value);
    const consecutiveFailure = row.event_name === INGESTION_FAILURE_ALERT_ID;
    return {
      event: OPERATIONAL_HEALTH_EVENT,
      severity: "critical",
      alertId: row.event_name,
      eventKey: row.event_key,
      sourceFamily: row.source_family,
      consecutiveFailures: consecutiveFailure ? metricValue : 0,
      deadLetterCount: consecutiveFailure ? 0 : metricValue,
      evidenceKind: row.evidence_kind,
      evidenceId: row.evidence_id,
      occurredAt: timestamp(row.occurred_at),
    };
  });
}

export async function acknowledgeOperationalTelemetrySignal(
  eventKey: string,
  leaseOwner: string,
  query: PostgresQuery = queryPostgres,
): Promise<boolean> {
  if (!eventKey.trim()) throw new Error("Operational telemetry eventKey is required.");
  if (!leaseOwner.trim()) throw new Error("Operational telemetry leaseOwner is required.");
  const result = await query<{ event_key: string }>(
    `update metrics.operational_telemetry_emissions
        set delivery_status = 'delivered',
            delivered_at = clock_timestamp(),
            lease_owner = null,
            lease_expires_at = null
      where event_key = $1::text
        and delivery_status = 'pending'
        and lease_owner = $2::text
      returning event_key`,
    [eventKey, leaseOwner],
  );
  return result.rows.length === 1;
}

function timestamp(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Operational telemetry returned an invalid timestamp: ${String(value)}`);
  return date.toISOString();
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string) {
  const integer = Math.trunc(value);
  if (!Number.isFinite(value) || integer < minimum || integer > maximum) {
    throw new Error(`Operational telemetry ${name} must be between ${minimum} and ${maximum}.`);
  }
  return integer;
}

create schema if not exists metrics;

-- F-06: retain the original bucket columns for compatibility while making the
-- monotonic theoretical-arrival timestamp the authoritative limiter state.
alter table metrics.simpro_rate_limit_buckets
  add column if not exists next_permitted_at timestamptz,
  add column if not exists reservation_count bigint not null default 0;

update metrics.simpro_rate_limit_buckets
   set next_permitted_at = coalesce(next_permitted_at, greatest(window_started_at, updated_at)),
       reservation_count = greatest(reservation_count, request_count::bigint)
 where next_permitted_at is null
    or reservation_count < request_count::bigint;

alter table metrics.simpro_rate_limit_buckets
  alter column next_permitted_at set not null;

comment on table metrics.simpro_rate_limit_buckets is
  'Authoritative cross-process Simpro GCRA reservation state. next_permitted_at is monotonic per bucket; reservations commit before callers sleep and are intentionally retained if a caller crashes.';
comment on column metrics.simpro_rate_limit_buckets.window_started_at is
  'Deprecated fixed-window compatibility column. Runtime limiting uses next_permitted_at.';
comment on column metrics.simpro_rate_limit_buckets.request_count is
  'Deprecated fixed-window compatibility counter. Runtime limiting uses reservation_count and next_permitted_at.';

-- F-07: current-period freshness requires explicit page completion and a
-- reconciliation from the same manifest generation. Existing historical
-- manifests remain readable and are not upgraded with invented page proof.
alter table metrics.source_period_manifests
  add column if not exists manifest_generation bigint,
  add column if not exists reconciliation_generation bigint,
  add column if not exists expected_page_count integer,
  add column if not exists completed_page_count integer,
  add column if not exists reconciled_at timestamptz;

create index if not exists source_period_manifests_generation_idx
  on metrics.source_period_manifests (source_family, period_start, manifest_generation);

comment on column metrics.source_period_manifests.manifest_generation is
  'Generation that produced this exact period/page manifest. NULL means legacy evidence and cannot satisfy the current-period freshness gate.';
comment on column metrics.source_period_manifests.reconciliation_generation is
  'Manifest generation checked by reconciliation. Current freshness requires equality with manifest_generation.';
comment on column metrics.source_period_manifests.expected_page_count is
  'Exact number of authoritative source pages expected in this generation.';
comment on column metrics.source_period_manifests.completed_page_count is
  'Exact number of authoritative source pages committed in this generation.';

-- F-10/Q-24: one head row serializes generation changes without relying on a
-- session lock. The outer all-month cadence cursor remains in ingestion_watermarks.
create table if not exists metrics.reconciliation_continuation_heads (
  scope text not null check (scope in ('quotes', 'jobs')),
  period_start date not null,
  period_end date not null,
  active_generation bigint not null default 0 check (active_generation >= 0),
  updated_at timestamptz not null default now(),
  primary key (scope, period_start),
  constraint reconciliation_continuation_head_month_check check (
    extract(day from period_start) = 1
    and period_end = (period_start + interval '1 month - 1 day')::date
  )
);

create table if not exists metrics.reconciliation_continuations (
  scope text not null check (scope in ('quotes', 'jobs')),
  period_start date not null,
  period_end date not null,
  generation bigint not null check (generation > 0),
  fence_token bigint not null default 0 check (fence_token >= 0),
  status text not null default 'collecting' check (
    status in ('collecting', 'repair_pending', 'completed', 'superseded', 'failed')
  ),
  cursor_day date,
  cursor_page integer not null default 1 check (cursor_page > 0),
  cursor_phase text not null default 'list' check (cursor_phase in ('list', 'details', 'complete')),
  cursor_detail_index integer not null default 0 check (cursor_detail_index >= 0),
  continuation_page integer,
  pending_detail_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(pending_detail_ids) = 'array'),
  listed_source_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(listed_source_ids) = 'array'),
  source_entities jsonb not null default '{}'::jsonb check (jsonb_typeof(source_entities) = 'object'),
  requests_used bigint not null default 0 check (requests_used >= 0),
  completed_page_count integer not null default 0 check (completed_page_count >= 0),
  completed_day_count integer not null default 0 check (completed_day_count >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  last_check_id bigint references metrics.reconciliation_checks(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (scope, period_start, generation),
  constraint reconciliation_continuation_month_check check (
    extract(day from period_start) = 1
    and period_end = (period_start + interval '1 month - 1 day')::date
  )
);

create index if not exists reconciliation_continuations_resume_idx
  on metrics.reconciliation_continuations (scope, period_start, status, generation desc);

comment on table metrics.reconciliation_continuation_heads is
  'Authoritative generation pointer for resumable quote/job reconciliation. This is an inner month cursor and never replaces the all-month outer cadence cursor.';
comment on table metrics.reconciliation_continuations is
  'Mutable, fenced full-month traversal state. Exact IDs, detail totals, day/page/detail cursor, and cumulative request accounting are checkpointed before budget exit.';

alter table metrics.reconciliation_checks
  add column if not exists generation bigint,
  add column if not exists complete_traversal boolean not null default false,
  add column if not exists source_manifest_generations jsonb not null default '{}'::jsonb,
  add column if not exists source_count numeric(18, 4),
  add column if not exists source_value numeric(18, 4),
  add column if not exists normalized_count numeric(18, 4),
  add column if not exists normalized_value numeric(18, 4);

alter table metrics.reconciliation_checks
  alter column complete_traversal set default false;

-- Rows written before the platform trust contract have no generation proof.
-- They remain available in the legacy table but cannot be promoted by adding
-- this column or by a generationless bulk check.
update metrics.reconciliation_checks
   set complete_traversal = false
 where generation is null
    or generation <= 0
    or jsonb_typeof(source_manifest_generations) <> 'object'
    or source_manifest_generations = '{}'::jsonb;

alter table metrics.reconciliation_checks
  drop constraint if exists reconciliation_complete_generation_proof_check;
alter table metrics.reconciliation_checks
  add constraint reconciliation_complete_generation_proof_check check (
    not complete_traversal
    or (
      generation is not null
      and generation > 0
      and jsonb_typeof(source_manifest_generations) = 'object'
      and source_manifest_generations <> '{}'::jsonb
    )
  );

create index if not exists reconciliation_checks_authoritative_idx
  on metrics.reconciliation_checks (scope, period_start, checked_at desc, id desc)
  where complete_traversal;

create or replace view metrics.authoritative_reconciliation_checks as
select distinct on (reconciliation.scope, reconciliation.period_start)
       reconciliation.id, reconciliation.scope, reconciliation.period_start,
       reconciliation.period_end, reconciliation.generation,
       reconciliation.complete_traversal, reconciliation.status,
       reconciliation.source_count, reconciliation.source_value,
       reconciliation.normalized_count, reconciliation.normalized_value,
       reconciliation.rollup_value, reconciliation.snapshot_value,
       reconciliation.upstream_sample_value,
       reconciliation.source_manifest_generations, reconciliation.detail,
       reconciliation.checked_at
  from metrics.reconciliation_checks reconciliation
 where reconciliation.complete_traversal
   and reconciliation.generation is not null
   and reconciliation.generation > 0
   and jsonb_typeof(reconciliation.source_manifest_generations) = 'object'
   and reconciliation.source_manifest_generations <> '{}'::jsonb
   and case reconciliation.scope
     when 'quotes' then
       reconciliation.source_manifest_generations ? 'quotes'
       and reconciliation.source_manifest_generations ? 'quote_nested'
     when 'jobs' then
       reconciliation.source_manifest_generations ? 'jobs'
       and reconciliation.source_manifest_generations ? 'job_nested'
     when 'commissions' then
       reconciliation.source_manifest_generations ? 'jobs'
       and reconciliation.source_manifest_generations ? 'job_nested'
     when 'technicians' then
       reconciliation.source_manifest_generations ?& array[
         'jobs', 'job_nested', 'employees', 'timesheets',
         'jobs_from_timesheets', 'schedules', 'mobile_status'
       ]::text[]
     else false
   end
   and not exists (
     select 1
       from jsonb_each_text(reconciliation.source_manifest_generations) declared(source_family, generation)
       left join metrics.source_period_manifests manifest
         on manifest.source_family = declared.source_family
        and manifest.period_start = reconciliation.period_start
        and manifest.period_end = reconciliation.period_end
        and manifest.manifest_generation = reconciliation.generation
        and manifest.reconciliation_generation = reconciliation.generation
        and manifest.coverage_status = 'complete'
        and manifest.reconciliation_status = 'matched'
        and manifest.continuation_token is null
        and manifest.expected_page_count > 0
        and manifest.completed_page_count = manifest.expected_page_count
        and manifest.reconciled_at is not null
      where declared.generation <> reconciliation.generation::text
         or manifest.source_family is null
   )
 order by reconciliation.scope, reconciliation.period_start,
          reconciliation.checked_at desc, reconciliation.id desc;

create or replace view metrics.authoritative_reconciliation_results as
select id, scope, period_start, period_end, generation, status,
       rollup_value, snapshot_value, upstream_sample_value,
       source_manifest_generations, detail, checked_at
  from metrics.authoritative_reconciliation_checks;

comment on table metrics.reconciliation_checks is
  'Immutable reconciliation ledger. Legacy and incomplete rows remain readable here but are excluded from authoritative views.';
comment on view metrics.authoritative_reconciliation_checks is
  'Latest generation-fenced reconciliation per scope and period whose complete, matched source manifests exactly prove every declared generation.';
comment on view metrics.authoritative_reconciliation_results is
  'Compatibility projection of authoritative_reconciliation_checks for existing jobs, technician, freshness, and data-health readers.';
comment on table metrics.reconciliation_runs is
  'DEPRECATED read-only compatibility ledger. New runtime reconciliation uses reconciliation_continuations and publishes final results to reconciliation_checks.';
comment on table metrics.reconciliation_differences is
  'DEPRECATED read-only compatibility detail for reconciliation_runs. New runtime differences are exact IDs in reconciliation_checks.detail and continuation state.';

-- Operational telemetry is an evidence projection, not an inferred platform
-- execution count. The primary key makes each threshold crossing or durable
-- dead-letter episode claimable exactly once across concurrent workers.
create table if not exists metrics.operational_telemetry_emissions (
  event_key text primary key,
  event_name text not null check (
    event_name in ('ingestion-three-consecutive-failures', 'dead-letter-immediate')
  ),
  source_family text not null,
  evidence_kind text not null check (evidence_kind in ('ingestion_run', 'ingestion_job', 'backfill_work_unit')),
  evidence_id text not null,
  occurred_at timestamptz not null,
  metric_value integer not null check (metric_value > 0),
  recorded_at timestamptz not null default clock_timestamp(),
  delivery_status text not null default 'pending' check (delivery_status in ('pending', 'delivered')),
  delivery_attempts integer not null default 0 check (delivery_attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  last_attempted_at timestamptz,
  delivered_at timestamptz
);

alter table metrics.operational_telemetry_emissions
  add column if not exists delivery_status text not null default 'pending',
  add column if not exists delivery_attempts integer not null default 0,
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_attempted_at timestamptz,
  add column if not exists delivered_at timestamptz;

create index if not exists operational_telemetry_emissions_time_idx
  on metrics.operational_telemetry_emissions (event_name, occurred_at desc);

create index if not exists operational_telemetry_emissions_delivery_idx
  on metrics.operational_telemetry_emissions (delivery_status, lease_expires_at, occurred_at)
  where delivery_status = 'pending';

comment on table metrics.operational_telemetry_emissions is
  'Idempotent durable outbox for app-owned operational signals. Evidence discovery creates pending rows; a leased worker acknowledges delivery only after stdout/App Insights handoff.';

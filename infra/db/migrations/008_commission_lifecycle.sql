create schema if not exists metrics;

-- WP-08/WP-09 commission revisions are append-only financial records. The
-- period row is the mutable workflow envelope; runs, manifests, and artifacts
-- are immutable once inserted.
alter table metrics.commission_periods
  add column if not exists config_revision integer not null default 1,
  add column if not exists edit_revision integer not null default 0,
  add column if not exists current_run_id bigint,
  add column if not exists supersedes_period_id bigint references metrics.commission_periods(id) on delete restrict,
  add column if not exists reviewed_by text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists exported_by text,
  add column if not exists exported_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists locked_at timestamptz,
  add column if not exists source_changed_after_export boolean not null default false,
  add column if not exists calculation_stale boolean not null default true,
  add column if not exists revision_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'commission_periods_current_run_fk'
       and conrelid = 'metrics.commission_periods'::regclass
  ) then
    alter table metrics.commission_periods
      add constraint commission_periods_current_run_fk
      foreign key (current_run_id) references metrics.commission_calculation_runs(id) on delete restrict;
  end if;
end $$;

alter table metrics.commission_period_configs
  add column if not exists active boolean not null default true,
  add column if not exists superseded_at timestamptz,
  add column if not exists idempotency_key text;

with ranked_configs as (
  select period_id, revision,
         row_number() over (partition by period_id order by revision desc, created_at desc) as position
    from metrics.commission_period_configs
)
update metrics.commission_period_configs c
   set active = ranked_configs.position = 1,
       superseded_at = case when ranked_configs.position = 1 then null else coalesce(c.superseded_at, now()) end
  from ranked_configs
 where c.period_id = ranked_configs.period_id
   and c.revision = ranked_configs.revision
   and (
     c.active is distinct from (ranked_configs.position = 1)
     or (ranked_configs.position > 1 and c.superseded_at is null)
   );

create unique index if not exists commission_period_configs_idempotency_idx
  on metrics.commission_period_configs (idempotency_key)
  where idempotency_key is not null;

create unique index if not exists commission_period_configs_active_idx
  on metrics.commission_period_configs (period_id)
  where active;

alter table metrics.commission_overrides
  add column if not exists value_type text,
  add column if not exists active boolean not null default true,
  add column if not exists superseded_at timestamptz,
  add column if not exists idempotency_key text;

alter table metrics.commission_overrides drop constraint if exists commission_overrides_pool_treatment_check;

update metrics.commission_overrides
   set pool_treatment = case pool_treatment
     when 'included' then 'inside_pool'
     when 'excluded' then 'outside_pool'
     else pool_treatment
   end
 where pool_treatment in ('included', 'excluded');

update metrics.commission_overrides
   set value_type = case field_name
     when 'included' then 'boolean'
     when 'allocated_value' then 'number'
     when 'inside_pool_adjustment' then 'number'
     when 'outside_pool_adjustment' then 'number'
     when 'final_bonus' then 'number'
     when 'tier' then 'tier'
     when 'notes' then 'string'
     else 'json'
   end
 where value_type is null;

with ranked_overrides as (
  select id,
         row_number() over (
           partition by period_id, employee_id, field_name
           order by revision desc, created_at desc, id desc
         ) as position
    from metrics.commission_overrides
)
update metrics.commission_overrides o
   set active = ranked_overrides.position = 1,
       superseded_at = case when ranked_overrides.position = 1 then null else coalesce(o.superseded_at, now()) end
  from ranked_overrides
 where o.id = ranked_overrides.id
   and (
     o.active is distinct from (ranked_overrides.position = 1)
     or (ranked_overrides.position > 1 and o.superseded_at is null)
   );

alter table metrics.commission_overrides alter column value_type set not null;
alter table metrics.commission_overrides
  add constraint commission_overrides_pool_treatment_check
  check (pool_treatment in ('neutral', 'inside_pool', 'outside_pool'));
alter table metrics.commission_overrides
  drop constraint if exists commission_overrides_field_name_check;
alter table metrics.commission_overrides
  add constraint commission_overrides_field_name_check
  check (field_name in (
    'included', 'allocated_value', 'tier', 'inside_pool_adjustment',
    'outside_pool_adjustment', 'final_bonus', 'notes'
  ));

create unique index if not exists commission_overrides_idempotency_idx
  on metrics.commission_overrides (idempotency_key)
  where idempotency_key is not null;

create unique index if not exists commission_overrides_active_field_idx
  on metrics.commission_overrides (period_id, employee_id, field_name)
  where active;

create index if not exists commission_overrides_history_idx
  on metrics.commission_overrides (period_id, employee_id, field_name, revision desc, id desc);

alter table metrics.commission_calculation_runs
  add column if not exists read_model jsonb,
  add column if not exists coverage_json jsonb not null default '{}'::jsonb,
  add column if not exists diagnostics_json jsonb not null default '[]'::jsonb,
  add column if not exists invariants_json jsonb not null default '{}'::jsonb,
  add column if not exists config_revision integer not null default 1,
  add column if not exists completed_jobs integer not null default 0,
  add column if not exists total_work_value numeric(14, 2) not null default 0,
  add column if not exists pool_amount numeric(14, 2) not null default 0,
  add column if not exists inside_pool_total numeric(14, 2) not null default 0,
  add column if not exists outside_pool_total numeric(14, 2) not null default 0,
  add column if not exists payroll_total numeric(14, 2) not null default 0;

alter table metrics.commission_employee_results
  add column if not exists display_name text,
  add column if not exists rank integer,
  add column if not exists included boolean not null default true,
  add column if not exists effective_allocated_value numeric(14, 2),
  add column if not exists base_bonus numeric(14, 2) not null default 0,
  add column if not exists below_minimum boolean not null default false,
  add column if not exists post_forfeiture_bonus numeric(14, 2) not null default 0,
  add column if not exists efficiency_json jsonb,
  add column if not exists override_redistribution numeric(14, 2) not null default 0,
  add column if not exists final_bonus_locked boolean not null default false,
  add column if not exists payroll_bonus numeric(14, 2) not null default 0;

alter table metrics.commission_job_allocations
  add column if not exists included boolean not null default false;

alter table metrics.commission_exports
  add column if not exists filename text,
  add column if not exists content_bytes bytea,
  add column if not exists status text not null default 'available';

alter table metrics.commission_exports drop constraint if exists commission_exports_status_check;
alter table metrics.commission_exports
  add constraint commission_exports_status_check check (status in ('available', 'failed', 'expired'));

create unique index if not exists commission_exports_run_type_hash_idx
  on metrics.commission_exports (calculation_run_id, export_type, file_hash);

create or replace function metrics.reject_commission_immutable_change()
returns trigger
language plpgsql
as $$
begin
  raise exception '% records are immutable', tg_table_name using errcode = '55000';
end;
$$;

create or replace function metrics.protect_commission_export_identity()
returns trigger
language plpgsql
as $$
begin
  if new.calculation_run_id <> old.calculation_run_id
     or new.export_type <> old.export_type
     or new.storage_key <> old.storage_key
     or new.file_hash <> old.file_hash
     or new.filename is distinct from old.filename
     or new.content_type is distinct from old.content_type
     or new.file_size_bytes is distinct from old.file_size_bytes
     or new.content_bytes is distinct from old.content_bytes
     or new.exported_by <> old.exported_by
     or new.exported_at <> old.exported_at
     or new.retained_until <> old.retained_until
     or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'commission export identity and content are immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function metrics.protect_commission_config_identity()
returns trigger
language plpgsql
as $$
begin
  if new.period_id <> old.period_id
     or new.revision <> old.revision
     or new.pool_pct <> old.pool_pct
     or new.min_bonus_pct <> old.min_bonus_pct
     or new.efficiency_enabled <> old.efficiency_enabled
     or new.max_efficiency_adjustment_pct <> old.max_efficiency_adjustment_pct
     or new.on_time_threshold_minutes <> old.on_time_threshold_minutes
     or new.config_json <> old.config_json
     or new.config_hash <> old.config_hash
     or new.actor_email <> old.actor_email
     or new.created_at <> old.created_at
     or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'commission config revision content is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function metrics.protect_commission_period_revision()
returns trigger
language plpgsql
as $$
begin
  if new.period_start <> old.period_start
     or new.period_end <> old.period_end
     or new.revision <> old.revision
     or new.supersedes_period_id is distinct from old.supersedes_period_id then
    raise exception 'commission period revision identity is immutable' using errcode = '55000';
  end if;

  if old.status = 'locked' and new is distinct from old then
    raise exception 'locked commission revisions are immutable' using errcode = '55000';
  end if;

  if old.status = 'exported' and (
       new.config is distinct from old.config
       or new.config_revision <> old.config_revision
       or new.source_watermarks is distinct from old.source_watermarks
       or new.override_hash <> old.override_hash
       or new.current_run_id is distinct from old.current_run_id
     ) then
    raise exception 'exported commission revisions require a new draft revision' using errcode = '55000';
  end if;

  if old.status = 'draft' and new.status not in ('draft', 'reviewed') then
    raise exception 'draft commission revision may only move to reviewed' using errcode = '23514';
  elsif old.status = 'reviewed' and new.status not in ('draft', 'reviewed', 'exported') then
    raise exception 'reviewed commission revision may only move to draft or exported' using errcode = '23514';
  elsif old.status = 'exported' and new.status not in ('exported', 'locked') then
    raise exception 'exported commission revision may only move to locked' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists commission_runs_immutable on metrics.commission_calculation_runs;
create trigger commission_runs_immutable
  before update or delete on metrics.commission_calculation_runs
  for each row execute function metrics.reject_commission_immutable_change();

drop trigger if exists commission_run_inputs_immutable on metrics.commission_run_inputs;
create trigger commission_run_inputs_immutable
  before update or delete on metrics.commission_run_inputs
  for each row execute function metrics.reject_commission_immutable_change();

drop trigger if exists commission_employee_results_immutable on metrics.commission_employee_results;
create trigger commission_employee_results_immutable
  before update or delete on metrics.commission_employee_results
  for each row execute function metrics.reject_commission_immutable_change();

drop trigger if exists commission_job_allocations_immutable on metrics.commission_job_allocations;
create trigger commission_job_allocations_immutable
  before update or delete on metrics.commission_job_allocations
  for each row execute function metrics.reject_commission_immutable_change();

drop trigger if exists commission_configs_immutable on metrics.commission_period_configs;
create trigger commission_configs_immutable
  before update on metrics.commission_period_configs
  for each row execute function metrics.protect_commission_config_identity();

drop trigger if exists commission_configs_no_delete on metrics.commission_period_configs;
create trigger commission_configs_no_delete
  before delete on metrics.commission_period_configs
  for each row execute function metrics.reject_commission_immutable_change();

drop trigger if exists commission_exports_identity_immutable on metrics.commission_exports;
create trigger commission_exports_identity_immutable
  before update on metrics.commission_exports
  for each row execute function metrics.protect_commission_export_identity();

drop trigger if exists commission_exports_no_delete on metrics.commission_exports;
create trigger commission_exports_no_delete
  before delete on metrics.commission_exports
  for each row execute function metrics.reject_commission_immutable_change();

drop trigger if exists commission_period_revision_protection on metrics.commission_periods;
create trigger commission_period_revision_protection
  before update on metrics.commission_periods
  for each row execute function metrics.protect_commission_period_revision();

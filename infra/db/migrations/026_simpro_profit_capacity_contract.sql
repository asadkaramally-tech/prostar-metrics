create schema if not exists metrics;

-- Unbounded PostgreSQL numeric preserves Simpro decimal values without app-owned rounding.
alter table metrics.metrics_jobs
  alter column total drop not null,
  alter column total drop default,
  alter column total type numeric using total::numeric,
  alter column gross_profit_actual type numeric using gross_profit_actual::numeric,
  alter column gross_margin_actual type numeric using gross_margin_actual::numeric,
  add column if not exists net_profit_actual numeric,
  add column if not exists net_margin_actual numeric,
  add column if not exists materials_cost_actual numeric,
  add column if not exists materials_cost_estimate numeric,
  add column if not exists labor_cost_actual numeric,
  add column if not exists labor_cost_estimate numeric,
  add column if not exists labor_hours_actual numeric,
  add column if not exists labor_hours_estimate numeric,
  add column if not exists overhead_cost_actual numeric,
  add column if not exists overhead_cost_estimate numeric,
  add column if not exists total_resource_cost_actual numeric,
  add column if not exists total_resource_cost_estimate numeric,
  add column if not exists commission_cost_actual numeric,
  add column if not exists job_source_type text,
  add column if not exists job_source_id bigint,
  add column if not exists customer_name text,
  add column if not exists site_name text,
  add column if not exists profit_capacity_normalized_at timestamptz;

update metrics.metrics_jobs
   set job_source_type = case
         when lower(coalesce(converted_from_type, '')) = 'quote' then 'Quote'
         when lower(coalesce(converted_from_type, '')) like 'recurring%' then 'Recurring'
         else 'Direct service'
       end,
       job_source_id = case
         when lower(coalesce(converted_from_type, '')) = 'quote'
           or lower(coalesce(converted_from_type, '')) like 'recurring%'
           then converted_from_id
         else null
       end
 where job_source_type is null;

create or replace function metrics.normalize_job_source_contract()
returns trigger
language plpgsql
as $$
declare source_type text;
begin
  source_type := lower(coalesce(new.job_source_type, new.converted_from_type, ''));
  if tg_op = 'UPDATE' and new.converted_from_type is distinct from old.converted_from_type then
    source_type := lower(coalesce(new.converted_from_type, ''));
  end if;

  if source_type = 'quote' then
    new.job_source_type := 'Quote';
    new.converted_from_type := 'Quote';
    new.job_source_id := coalesce(new.job_source_id, new.converted_from_id);
    new.converted_from_id := new.job_source_id;
  elsif source_type like 'recurring%' then
    new.job_source_type := 'Recurring';
    new.converted_from_type := 'Recurring';
    new.job_source_id := coalesce(new.job_source_id, new.converted_from_id);
    new.converted_from_id := new.job_source_id;
  else
    new.job_source_type := 'Direct service';
    new.converted_from_type := 'Direct service';
    new.job_source_id := null;
    new.converted_from_id := null;
    new.converted_from_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists metrics_jobs_normalize_source_contract on metrics.metrics_jobs;
create trigger metrics_jobs_normalize_source_contract
before insert or update of job_source_type, job_source_id, converted_from_type, converted_from_id
on metrics.metrics_jobs
for each row execute function metrics.normalize_job_source_contract();

alter table metrics.metrics_jobs
  drop constraint if exists metrics_jobs_job_source_type_check;
alter table metrics.metrics_jobs
  add constraint metrics_jobs_job_source_type_check
  check (
    job_source_type in ('Recurring', 'Quote', 'Direct service')
    and (job_source_type <> 'Direct service' or job_source_id is null)
  );

alter table metrics.metrics_job_cost_centers
  alter column gross_profit_actual type numeric using gross_profit_actual::numeric,
  alter column gross_margin_actual type numeric using gross_margin_actual::numeric,
  alter column labor_quoted_hours type numeric using labor_quoted_hours::numeric,
  alter column material_sell_value type numeric using material_sell_value::numeric,
  alter column material_cost_value type numeric using material_cost_value::numeric,
  alter column sell_value type numeric using sell_value::numeric,
  alter column cost_value type numeric using cost_value::numeric,
  add column if not exists configured_cost_center_name text,
  add column if not exists net_profit_actual numeric,
  add column if not exists net_profit_estimate numeric,
  add column if not exists net_margin_actual numeric,
  add column if not exists net_margin_estimate numeric,
  add column if not exists gross_profit_estimate numeric,
  add column if not exists gross_margin_estimate numeric,
  add column if not exists materials_cost_actual numeric,
  add column if not exists materials_cost_estimate numeric,
  add column if not exists labor_cost_actual numeric,
  add column if not exists labor_cost_estimate numeric,
  add column if not exists labor_hours_actual numeric,
  add column if not exists labor_hours_estimate numeric,
  add column if not exists overhead_cost_actual numeric,
  add column if not exists overhead_cost_estimate numeric,
  add column if not exists total_resource_cost_actual numeric,
  add column if not exists total_resource_cost_estimate numeric,
  add column if not exists commission_cost_actual numeric,
  add column if not exists totals_authoritative boolean not null default false;

alter table metrics.dim_people
  add column if not exists date_of_hire date,
  add column if not exists archived boolean,
  add column if not exists availability_json jsonb,
  add column if not exists capacity_source text,
  add column if not exists weekday_capacity_hours numeric,
  add column if not exists weekly_capacity_hours numeric,
  add column if not exists capacity_normalized_at timestamptz;

alter table metrics.dim_people drop constraint if exists dim_people_capacity_source_check;
alter table metrics.dim_people
  add constraint dim_people_capacity_source_check
  check (capacity_source is null or capacity_source in ('simpro_availability', 'default_business_hours'));

create or replace function metrics.simpro_json_numeric(payload jsonb, variadic path text[])
returns numeric
language plpgsql
immutable
as $$
declare value text;
begin
  value := jsonb_extract_path_text(payload, variadic path);
  if value is null or btrim(value) = '' or value !~ '^-?[0-9]+([.][0-9]+)?$' then return null; end if;
  return value::numeric;
end;
$$;

create or replace function metrics.apply_authoritative_job_cost_center_totals()
returns trigger
language plpgsql
as $$
declare detail jsonb;
begin
  select snapshot.payload into detail
    from metrics.raw_simpro_snapshots snapshot
   where snapshot.entity_type = 'job_cost_center_detail'
     and snapshot.source_deleted_at is null
     and snapshot.parent_identity @> jsonb_build_object(
       'projectType', 'job', 'projectId', new.job_id,
       'sectionId', new.section_id, 'costCenterId', new.cost_center_id
     )
   order by snapshot.extracted_at desc, snapshot.id desc
   limit 1;
  if detail is null then return new; end if;

  new.configured_cost_center_id := nullif(detail #>> '{CostCenter,ID}', '')::bigint;
  new.configured_cost_center_name := nullif(detail #>> '{CostCenter,Name}', '');
  new.name := nullif(detail ->> 'Name', '');
  new.net_profit_actual := metrics.simpro_json_numeric(detail, 'Totals', 'NettProfitLoss', 'Actual');
  new.net_profit_estimate := metrics.simpro_json_numeric(detail, 'Totals', 'NettProfitLoss', 'Estimate');
  new.net_margin_actual := metrics.simpro_json_numeric(detail, 'Totals', 'NettMargin', 'Actual');
  new.net_margin_estimate := metrics.simpro_json_numeric(detail, 'Totals', 'NettMargin', 'Estimate');
  new.gross_profit_actual := metrics.simpro_json_numeric(detail, 'Totals', 'GrossProfitLoss', 'Actual');
  new.gross_profit_estimate := metrics.simpro_json_numeric(detail, 'Totals', 'GrossProfitLoss', 'Estimate');
  new.gross_margin_actual := metrics.simpro_json_numeric(detail, 'Totals', 'GrossMargin', 'Actual');
  new.gross_margin_estimate := metrics.simpro_json_numeric(detail, 'Totals', 'GrossMargin', 'Estimate');
  new.materials_cost_actual := metrics.simpro_json_numeric(detail, 'Totals', 'MaterialsCost', 'Actual');
  new.materials_cost_estimate := metrics.simpro_json_numeric(detail, 'Totals', 'MaterialsCost', 'Estimate');
  new.labor_cost_actual := metrics.simpro_json_numeric(detail, 'Totals', 'ResourcesCost', 'Labor', 'Actual');
  new.labor_cost_estimate := metrics.simpro_json_numeric(detail, 'Totals', 'ResourcesCost', 'Labor', 'Estimate');
  new.labor_hours_actual := metrics.simpro_json_numeric(detail, 'Totals', 'ResourcesCost', 'LaborHours', 'Actual');
  new.labor_hours_estimate := metrics.simpro_json_numeric(detail, 'Totals', 'ResourcesCost', 'LaborHours', 'Estimate');
  new.overhead_cost_actual := metrics.simpro_json_numeric(detail, 'Totals', 'ResourcesCost', 'Overhead', 'Actual');
  new.overhead_cost_estimate := metrics.simpro_json_numeric(detail, 'Totals', 'ResourcesCost', 'Overhead', 'Estimate');
  new.total_resource_cost_actual := metrics.simpro_json_numeric(detail, 'Totals', 'ResourcesCost', 'Total', 'Actual');
  new.total_resource_cost_estimate := metrics.simpro_json_numeric(detail, 'Totals', 'ResourcesCost', 'Total', 'Estimate');
  new.commission_cost_actual := metrics.simpro_json_numeric(detail, 'Totals', 'ResourcesCost', 'Commission', 'Actual');
  new.material_cost_value := new.materials_cost_actual;
  new.cost_value := case
    when new.materials_cost_actual is null and new.total_resource_cost_actual is null then null
    else coalesce(new.materials_cost_actual, 0) + coalesce(new.total_resource_cost_actual, 0)
  end;
  new.labor_quoted_hours := new.labor_hours_estimate;
  new.totals_authoritative := true;
  return new;
end;
$$;

drop trigger if exists metrics_job_cost_centers_authoritative_totals on metrics.metrics_job_cost_centers;
create trigger metrics_job_cost_centers_authoritative_totals
before insert or update on metrics.metrics_job_cost_centers
for each row execute function metrics.apply_authoritative_job_cost_center_totals();

-- Replays already-fetched raw detail through the authoritative trigger without a Simpro request.
update metrics.metrics_job_cost_centers set updated_from_source_at = updated_from_source_at;

create index if not exists metrics_jobs_profit_capacity_backfill_idx
  on metrics.metrics_jobs (completed_date, job_id)
  where source_deleted_at is null and stage in ('Complete', 'Archived')
    and profit_capacity_normalized_at is null;

create index if not exists dim_people_capacity_backfill_idx
  on metrics.dim_people (simpro_employee_id)
  where simpro_employee_id is not null and capacity_normalized_at is null;

comment on column metrics.metrics_jobs.commission_cost_actual is
  'Simpro Totals.ResourcesCost.Commission.Actual cost; not evidence that a commission was paid.';
comment on column metrics.metrics_job_cost_centers.commission_cost_actual is
  'Simpro Totals.ResourcesCost.Commission.Actual cost; not evidence that a commission was paid.';
comment on column metrics.metrics_job_cost_centers.totals_authoritative is
  'True only for Simpro job/cost-center Totals; child item sparsity is never treated as actual cost.';
comment on column metrics.dim_people.availability_json is
  'Explicit Simpro Availability when supplied; otherwise weekdays 08:30-17:00 with eight work hours after lunch.';

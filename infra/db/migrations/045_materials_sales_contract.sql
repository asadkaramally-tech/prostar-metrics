-- Materials dashboard contract (owner-approved 2026-07-19 brief §4.5).
-- Mirror of material lines billed on completed jobs, walked live from Simpro
-- (sections → costCenters → catalogs/oneOffs/prebuilds). Expand-only.

create table if not exists metrics.metrics_material_lines (
  job_id bigint not null,
  section_id bigint not null,
  cost_center_id bigint not null,
  line_type text not null check (line_type in ('catalog', 'one_off', 'prebuild')),
  line_id bigint not null,
  period_start date not null,
  completed_date date not null,
  catalog_id bigint,
  prebuild_id bigint,
  name text,
  part_no text,
  qty numeric not null default 0,
  extended_ex_tax numeric not null default 0,
  base_price numeric,
  one_off_type text,
  fetched_at timestamptz not null default now(),
  updated_from_source_at timestamptz not null default now(),
  primary key (job_id, section_id, cost_center_id, line_type, line_id)
);

create index if not exists metrics_material_lines_period_idx
  on metrics.metrics_material_lines (period_start, job_id);

create index if not exists metrics_material_lines_catalog_idx
  on metrics.metrics_material_lines (catalog_id)
  where catalog_id is not null;

-- Persistent catalog product-group cache. Group hierarchy changes rarely; the
-- ingestion worker refreshes entries lazily when they go stale.
create table if not exists metrics.catalog_groups (
  catalog_id bigint primary key,
  name text,
  part_no text,
  group_name text,
  parent_group_name text,
  fetched_at timestamptz not null default now()
);

-- Per-month walk bookkeeping: which months of the materials mirror are
-- complete, when they were walked, and how much source work they took.
create table if not exists metrics.materials_month_walks (
  period_start date primary key,
  status text not null default 'complete' check (status in ('complete', 'failed')),
  walked_at timestamptz not null default now(),
  job_count integer not null default 0,
  line_count integer not null default 0,
  requests_used integer not null default 0,
  error_message text
);

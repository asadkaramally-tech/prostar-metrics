create schema if not exists metrics;

create table if not exists metrics.source_period_manifests (
  source_family text not null,
  period_start date not null,
  period_end date not null,
  coverage_status text not null default 'building' check (
    coverage_status in ('building', 'complete', 'partial', 'suspect', 'failed')
  ),
  reconciliation_status text not null default 'pending' check (
    reconciliation_status in ('pending', 'matched', 'mismatch', 'unavailable')
  ),
  listed_count integer,
  detail_count integer,
  normalized_count integer,
  source_id_hash text,
  normalized_id_hash text,
  source_value numeric(18, 2),
  normalized_value numeric(18, 2),
  continuation_token jsonb,
  evidence_as_of timestamptz not null,
  completed_at timestamptz,
  mutable_period boolean not null default false,
  evidence_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (source_family, period_start),
  constraint source_period_manifest_month_check check (
    extract(day from period_start) = 1
    and period_end = (period_start + interval '1 month - 1 day')::date
  ),
  constraint source_period_manifest_complete_check check (
    coverage_status <> 'complete'
    or (
      reconciliation_status = 'matched'
      and continuation_token is null
      and listed_count is not null
      and detail_count is not null
      and normalized_count is not null
      and listed_count = detail_count
      and detail_count = normalized_count
      and source_id_hash is not null
      and normalized_id_hash is not null
      and source_id_hash = normalized_id_hash
      and completed_at is not null
    )
  )
);

create index if not exists source_period_manifests_period_status_idx
  on metrics.source_period_manifests (period_start, coverage_status, source_family);

comment on table metrics.source_period_manifests is
  'Serving projection derived atomically from authoritative traversal manifests and source-to-normalized reconciliation. A successful request or nonempty local table is never sufficient for complete status.';

create or replace function metrics.enforce_mutable_source_period_manifest()
returns trigger
language plpgsql
as $$
declare
  current_pacific_month date := date_trunc('month', now() at time zone 'America/Los_Angeles')::date;
begin
  new.mutable_period := new.period_start = current_pacific_month;
  if new.mutable_period and new.coverage_status = 'complete' then
    -- Current-month evidence is a checkpoint, never a permanent historical seal.
    new.evidence_json := coalesce(new.evidence_json, '{}'::jsonb)
      || jsonb_build_object('mutableCheckpoint', true);
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists enforce_mutable_source_period_manifest on metrics.source_period_manifests;
create trigger enforce_mutable_source_period_manifest
before insert or update on metrics.source_period_manifests
for each row execute function metrics.enforce_mutable_source_period_manifest();

create schema if not exists metrics;

create table if not exists metrics.backfill_traversal_manifests (
  work_unit_id bigint primary key references metrics.backfill_source_month_ledger(id) on delete cascade,
  generation integer not null default 1 check (generation > 0),
  contract_version integer not null check (contract_version > 0),
  manifest_status text not null default 'collecting' check (manifest_status in (
    'collecting', 'completed', 'provisional', 'invalid', 'unavailable'
  )),
  filter_contract jsonb not null,
  as_of_watermark timestamptz not null,
  observed_boundary jsonb not null,
  required_target_keys jsonb not null default '[]'::jsonb check (jsonb_typeof(required_target_keys) = 'array'),
  completed_target_keys jsonb not null default '[]'::jsonb check (jsonb_typeof(completed_target_keys) = 'array'),
  exact_source_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(exact_source_ids) = 'array'),
  listed_source_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(listed_source_ids) = 'array'),
  detailed_source_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(detailed_source_ids) = 'array'),
  exclusions jsonb not null default '[]'::jsonb check (jsonb_typeof(exclusions) = 'array'),
  continuation_token jsonb,
  detail_coverage_required boolean not null default false,
  page_count integer not null default 0 check (page_count >= 0),
  record_count integer not null default 0 check (record_count >= 0),
  empty_proof jsonb,
  open_quote_discovery jsonb not null default '{"required":false,"status":"not_required"}'::jsonb,
  violations jsonb not null default '[]'::jsonb check (jsonb_typeof(violations) = 'array'),
  completed_at timestamptz,
  reopened_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint authoritative_manifest_completion_check check (
    manifest_status not in ('completed', 'provisional')
    or (
      continuation_token is null
      and page_count > 0
      and completed_target_keys @> required_target_keys
      and (not detail_coverage_required or detailed_source_ids @> listed_source_ids)
      and jsonb_array_length(violations) = 0
      and (record_count > 0 or empty_proof is not null)
      and (
        coalesce((open_quote_discovery->>'required')::boolean, false) = false
        or open_quote_discovery->>'status' = 'complete'
      )
    )
  )
);

create table if not exists metrics.backfill_traversal_pages (
  id bigserial primary key,
  work_unit_id bigint not null references metrics.backfill_source_month_ledger(id) on delete cascade,
  generation integer not null check (generation > 0),
  ingestion_run_id bigint references metrics.ingestion_runs(id) on delete set null,
  ordinal integer not null check (ordinal > 0),
  target_key text not null,
  source_method text not null,
  page_number integer not null check (page_number > 0),
  page_size integer not null check (page_size >= 0),
  row_count integer not null check (row_count >= 0),
  exact_ids jsonb not null check (jsonb_typeof(exact_ids) = 'array'),
  request_query jsonb not null,
  terminal boolean not null,
  continuation_page integer,
  observed_min_date date,
  observed_max_date date,
  response_hash text not null check (response_hash ~ '^[a-f0-9]{64}$'),
  synthetic boolean not null default false,
  observed_at timestamptz not null default now(),
  unique (work_unit_id, generation, ingestion_run_id, ordinal),
  constraint authoritative_page_terminal_check check (
    (terminal and continuation_page is null)
    or (not terminal and continuation_page is not null)
  ),
  constraint authoritative_page_exact_count_check check (jsonb_array_length(exact_ids) <= row_count)
);

create index if not exists backfill_traversal_pages_manifest_idx
  on metrics.backfill_traversal_pages (work_unit_id, generation, target_key, page_number, id);

create table if not exists metrics.backfill_repair_plans (
  id bigserial primary key,
  work_unit_id bigint not null references metrics.backfill_source_month_ledger(id) on delete cascade,
  reconciliation_result_id bigint references metrics.backfill_reconciliation_results(id) on delete cascade,
  action text not null check (action in (
    'refresh_or_normalize',
    'verify_deletion_or_window_move',
    'tombstone_after_authoritative_confirmation',
    'repair_nested_traversal'
  )),
  entity_ids jsonb not null check (jsonb_typeof(entity_ids) = 'array'),
  rationale text not null,
  destructive_write_performed boolean not null default false check (destructive_write_performed = false),
  status text not null default 'planned' check (status in ('planned', 'reviewed', 'superseded', 'completed')),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists backfill_repair_plans_unit_idx
  on metrics.backfill_repair_plans (work_unit_id, status, id);

create or replace function metrics.record_authoritative_backfill_slice(
  p_work_unit_id bigint,
  p_ingestion_run_id bigint,
  p_pages jsonb,
  p_traversal jsonb,
  p_ingestion_complete boolean
)
returns table (recorded_work_unit_id bigint, recorded_manifest_status text)
language plpgsql
as $$
begin
  insert into metrics.backfill_traversal_pages (
    work_unit_id, generation, ingestion_run_id, ordinal, target_key, source_method,
    page_number, page_size, row_count, exact_ids, request_query, terminal,
    continuation_page, observed_min_date, observed_max_date, response_hash, synthetic
  )
  select p_work_unit_id, (p_traversal->>'generation')::integer, p_ingestion_run_id,
         page.ordinal, page.target_key, page.source_method, page.page_number, page.page_size,
         page.row_count, page.exact_ids, page.request_query, page.terminal,
         page.continuation_page, page.observed_min_date::date, page.observed_max_date::date,
         page.response_hash, page.synthetic
    from jsonb_to_recordset(p_pages) as page(
      ordinal integer,
      target_key text,
      source_method text,
      page_number integer,
      page_size integer,
      row_count integer,
      exact_ids jsonb,
      request_query jsonb,
      terminal boolean,
      continuation_page integer,
      observed_min_date text,
      observed_max_date text,
      response_hash text,
      synthetic boolean
    )
  on conflict (work_unit_id, generation, ingestion_run_id, ordinal) do nothing;

  insert into metrics.backfill_traversal_manifests (
    work_unit_id, generation, contract_version, manifest_status, filter_contract,
    as_of_watermark, observed_boundary, required_target_keys, completed_target_keys,
    exact_source_ids, listed_source_ids, detailed_source_ids, exclusions,
    continuation_token, detail_coverage_required, empty_proof, open_quote_discovery,
    violations
  )
  values (
    p_work_unit_id,
    (p_traversal->>'generation')::integer,
    (p_traversal->>'version')::integer,
    case
      when not (p_traversal->>'valid')::boolean then 'invalid'
      when p_traversal->'filterContract'->>'sourceFamily' = 'mobile_status' then 'unavailable'
      else 'collecting'
    end,
    p_traversal->'filterContract',
    (p_traversal->>'asOfWatermark')::timestamptz,
    p_traversal->'observedBoundary',
    p_traversal->'filterContract'->'requiredTargetKeys',
    p_traversal->'completedTargetKeys',
    p_traversal->'sourceIds',
    p_traversal->'listedSourceIds',
    p_traversal->'detailedSourceIds',
    p_traversal->'exclusions',
    nullif(p_traversal->'continuation', 'null'::jsonb),
    (p_traversal->>'detailCoverageRequired')::boolean,
    nullif(p_traversal->'emptyProof', 'null'::jsonb),
    p_traversal->'openQuoteDiscovery',
    p_traversal->'violations'
  )
  on conflict (work_unit_id) do update set
    contract_version = excluded.contract_version,
    manifest_status = case
      when metrics.backfill_traversal_manifests.manifest_status = 'invalid'
        or excluded.manifest_status = 'invalid' then 'invalid'
      when excluded.manifest_status = 'unavailable' then 'unavailable'
      else 'collecting'
    end,
    filter_contract = excluded.filter_contract,
    observed_boundary = excluded.observed_boundary,
    required_target_keys = excluded.required_target_keys,
    completed_target_keys = (
      select coalesce(jsonb_agg(to_jsonb(value) order by value), '[]'::jsonb)
        from (
          select jsonb_array_elements_text(metrics.backfill_traversal_manifests.completed_target_keys) as value
          union
          select jsonb_array_elements_text(excluded.completed_target_keys) as value
        ) merged
    ),
    exact_source_ids = (
      select coalesce(jsonb_agg(to_jsonb(value) order by value), '[]'::jsonb)
        from (
          select jsonb_array_elements_text(metrics.backfill_traversal_manifests.exact_source_ids) as value
          union
          select jsonb_array_elements_text(excluded.exact_source_ids) as value
        ) merged
    ),
    listed_source_ids = (
      select coalesce(jsonb_agg(to_jsonb(value) order by value), '[]'::jsonb)
        from (
          select jsonb_array_elements_text(metrics.backfill_traversal_manifests.listed_source_ids) as value
          union
          select jsonb_array_elements_text(excluded.listed_source_ids) as value
        ) merged
    ),
    detailed_source_ids = (
      select coalesce(jsonb_agg(to_jsonb(value) order by value), '[]'::jsonb)
        from (
          select jsonb_array_elements_text(metrics.backfill_traversal_manifests.detailed_source_ids) as value
          union
          select jsonb_array_elements_text(excluded.detailed_source_ids) as value
        ) merged
    ),
    exclusions = metrics.backfill_traversal_manifests.exclusions || excluded.exclusions,
    continuation_token = excluded.continuation_token,
    detail_coverage_required = excluded.detail_coverage_required,
    empty_proof = coalesce(excluded.empty_proof, metrics.backfill_traversal_manifests.empty_proof),
    open_quote_discovery = case
      when metrics.backfill_traversal_manifests.open_quote_discovery->>'status' = 'complete'
        then metrics.backfill_traversal_manifests.open_quote_discovery
      else excluded.open_quote_discovery
    end,
    violations = metrics.backfill_traversal_manifests.violations || excluded.violations,
    updated_at = now()
  where metrics.backfill_traversal_manifests.generation = excluded.generation;

  if not (p_traversal->>'valid')::boolean then
    with excluded_ids as (
      select coalesce(jsonb_agg(to_jsonb(entity_id) order by entity_id), '[]'::jsonb) as ids
        from (
          select distinct exclusion->>'entityId' as entity_id
            from jsonb_array_elements(p_traversal->'exclusions') exclusion
           where nullif(exclusion->>'entityId', '') is not null
        ) candidates
    )
    insert into metrics.backfill_repair_plans (
      work_unit_id, action, entity_ids, rationale, evidence
    )
    select p_work_unit_id, plan.action, excluded_ids.ids, plan.rationale,
           jsonb_build_object('automaticWrite', false, 'manifestGeneration', (p_traversal->>'generation')::integer)
      from excluded_ids
      cross join (values
        ('verify_deletion_or_window_move',
         'A listed source ID failed its required detail request; verify deletion, archive, or concurrent movement.'),
        ('tombstone_after_authoritative_confirmation',
         'Tombstone only after an independent detail lookup or second complete traversal confirms deletion.')
      ) as plan(action, rationale)
     where jsonb_array_length(excluded_ids.ids) > 0;
  end if;

  with proof as (
    select m.work_unit_id,
           count(page.id)::integer as observed_page_count,
           jsonb_array_length(m.exact_source_ids) as observed_record_count,
           case
             when jsonb_array_length(m.exact_source_ids) = 0 and p_ingestion_complete
               then jsonb_build_object(
                 'authoritative', jsonb_array_length(m.violations) = 0,
                 'asOfWatermark', m.as_of_watermark,
                 'completedTargetKeys', m.completed_target_keys,
                 'filterContractVersion', m.contract_version
               )
             else m.empty_proof
           end as observed_empty_proof,
           m.manifest_status,
           m.continuation_token,
           m.completed_target_keys,
           m.required_target_keys,
           m.detail_coverage_required,
           m.detailed_source_ids,
           m.listed_source_ids,
           m.violations,
           m.open_quote_discovery,
           m.filter_contract
      from metrics.backfill_traversal_manifests m
      left join metrics.backfill_traversal_pages page
        on page.work_unit_id = m.work_unit_id and page.generation = m.generation
     where m.work_unit_id = p_work_unit_id
       and m.generation = (p_traversal->>'generation')::integer
     group by m.work_unit_id
  )
  update metrics.backfill_traversal_manifests m
     set page_count = proof.observed_page_count,
         record_count = proof.observed_record_count,
         empty_proof = proof.observed_empty_proof,
         manifest_status = case
           when proof.manifest_status in ('invalid', 'unavailable') then proof.manifest_status
           when p_ingestion_complete
             and proof.continuation_token is null
             and proof.observed_page_count > 0
             and proof.completed_target_keys @> proof.required_target_keys
             and (not proof.detail_coverage_required or proof.detailed_source_ids @> proof.listed_source_ids)
             and jsonb_array_length(proof.violations) = 0
             and (proof.observed_record_count > 0 or proof.observed_empty_proof is not null)
             and (
               coalesce((proof.open_quote_discovery->>'required')::boolean, false) = false
               or proof.open_quote_discovery->>'status' = 'complete'
             )
           then case when coalesce((proof.filter_contract->>'provisional')::boolean, false)
                     then 'provisional' else 'completed' end
           else 'collecting'
         end,
         completed_at = case
           when p_ingestion_complete
             and proof.continuation_token is null
             and proof.observed_page_count > 0
             and proof.completed_target_keys @> proof.required_target_keys
             and (not proof.detail_coverage_required or proof.detailed_source_ids @> proof.listed_source_ids)
             and jsonb_array_length(proof.violations) = 0
             and (proof.observed_record_count > 0 or proof.observed_empty_proof is not null)
             and (
               coalesce((proof.open_quote_discovery->>'required')::boolean, false) = false
               or proof.open_quote_discovery->>'status' = 'complete'
             )
           then now() else null end,
         updated_at = now()
    from proof
   where m.work_unit_id = proof.work_unit_id;

  return query
    select m.work_unit_id, m.manifest_status
      from metrics.backfill_traversal_manifests m
     where m.work_unit_id = p_work_unit_id
       and m.generation = (p_traversal->>'generation')::integer;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'backfill_declared_total_capacity_check'
       and conrelid = 'metrics.backfill_capacity_days'::regclass
  ) then
    alter table metrics.backfill_capacity_days
      add constraint backfill_declared_total_capacity_check check (
        current_requests + reconciliation_requests + backfill_requests + backfill_reserved_requests
          <= daily_request_ceiling
      ) not valid;
  end if;
end
$$;

create or replace function metrics.enforce_authoritative_backfill_manifest()
returns trigger
language plpgsql
as $$
declare
  manifest metrics.backfill_traversal_manifests%rowtype;
  current_pacific_month date := date_trunc('month', now() at time zone 'America/Los_Angeles')::date;
begin
  if new.reconciliation_status = 'matched' or new.status = 'completed' then
    select * into manifest
      from metrics.backfill_traversal_manifests
     where work_unit_id = new.id;

    if not found then
      raise exception 'work unit % cannot match or complete without an authoritative traversal manifest', new.id;
    end if;

    if new.required_for_completion then
      if new.month_start = current_pacific_month then
        if manifest.manifest_status not in ('completed', 'provisional') then
          raise exception 'current work unit % requires a completed or provisional authoritative manifest', new.id;
        end if;
      elsif manifest.manifest_status <> 'completed' then
        raise exception 'historical work unit % requires a completed authoritative manifest', new.id;
      end if;
    elsif manifest.manifest_status not in ('completed', 'provisional', 'unavailable') then
      raise exception 'optional work unit % lacks authoritative coverage or an explicit unavailable manifest', new.id;
    end if;

    if new.source_family = 'quotes'
       and new.month_start = current_pacific_month
       and (
         coalesce((manifest.open_quote_discovery->>'required')::boolean, false) = false
         or manifest.open_quote_discovery->>'status' <> 'complete'
       ) then
      raise exception 'current quote work unit % lacks authoritative open-quote discovery', new.id;
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists enforce_authoritative_backfill_manifest on metrics.backfill_source_month_ledger;
create trigger enforce_authoritative_backfill_manifest
before insert or update of reconciliation_status, status
on metrics.backfill_source_month_ledger
for each row execute function metrics.enforce_authoritative_backfill_manifest();

drop view if exists metrics.backfill_month_coverage;
create view metrics.backfill_month_coverage as
  select
    l.month_start,
    count(*) filter (where l.required_for_completion) as required_source_count,
    count(*) filter (
      where l.required_for_completion
        and l.status = 'completed'
        and l.reconciliation_status = 'matched'
        and m.manifest_status = 'completed'
    ) as completed_required_source_count,
    bool_and(
      l.status = 'completed'
      and l.reconciliation_status = 'matched'
      and m.manifest_status = 'completed'
    ) filter (where l.required_for_completion) as required_sources_complete,
    count(*) filter (where l.source_family = 'mobile_status' and l.reconciliation_status = 'partial')
      as mobile_partial_source_count,
    count(*) filter (where l.source_family = 'mobile_status' and l.reconciliation_status = 'unavailable')
      as mobile_unavailable_source_count,
    sum(l.actual_requests) as actual_requests,
    max(l.updated_at) as updated_at
  from metrics.backfill_source_month_ledger l
  left join metrics.backfill_traversal_manifests m on m.work_unit_id = l.id
  group by l.month_start;

comment on table metrics.backfill_traversal_manifests is
  'Authoritative source/month traversal proof. Raw-vs-normalized equality cannot substitute for this manifest.';

comment on table metrics.backfill_traversal_pages is
  'Immutable observed page evidence, including exact source IDs, request filters, terminal pages, and response hashes.';

comment on table metrics.backfill_repair_plans is
  'Non-destructive backfill repair and tombstone candidates. This ledger never performs production tombstones itself.';

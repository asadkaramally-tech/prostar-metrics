create schema if not exists metrics;

-- Migrations 033 and 034 may already be recorded by hash in deployed databases.
-- Supersede their descriptive-number semantics additively and converge persisted projections.
create or replace function metrics.authoritative_relationship_scalar_id(
  p_value jsonb,
  p_context text
)
returns bigint
language plpgsql
immutable
as $function$
declare
  value_type text;
  scalar_text text;
  numeric_value numeric;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return null;
  end if;

  value_type := jsonb_typeof(p_value);
  if value_type = 'string' then
    scalar_text := p_value #>> '{}';
    scalar_text := trim(scalar_text);
  elsif value_type = 'number' then
    scalar_text := p_value::text;
  else
    raise exception '% is not a numeric or string scalar ID.', p_context
      using errcode = '22023';
  end if;

  begin
    numeric_value := scalar_text::numeric;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception '% is not a positive scalar ID.', p_context
        using errcode = '22023';
  end;

  if numeric_value <> trunc(numeric_value)
     or numeric_value <= 0
     or numeric_value > 9007199254740991 then
    raise exception '% is not a positive safe-integer scalar ID.', p_context
      using errcode = '22023';
  end if;

  return numeric_value::bigint;
end;
$function$;

create or replace function metrics.authoritative_quote_linked_job_id(p_payload jsonb)
returns bigint
language plpgsql
immutable
as $function$
declare
  field_name text;
  candidate_id bigint;
  resolved_id bigint;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Authoritative raw quote payload is not an object.'
      using errcode = '22023';
  end if;

  foreach field_name in array array['LinkedJobID', 'linkedJobId', 'linked_job_id'] loop
    if not (p_payload ? field_name) then
      continue;
    end if;
    candidate_id := metrics.authoritative_relationship_scalar_id(
      p_payload -> field_name,
      'Raw quote ' || field_name
    );
    if candidate_id is null then
      continue;
    end if;
    if resolved_id is not null and resolved_id <> candidate_id then
      raise exception 'Authoritative raw quote direct-link scalar fields conflict.'
        using errcode = '22023';
    end if;
    resolved_id := candidate_id;
  end loop;

  return resolved_id;
end;
$function$;

create or replace function metrics.authoritative_job_source_quote_id(p_payload jsonb)
returns bigint
language plpgsql
immutable
as $function$
declare
  field_name text;
  converted_from_field_name text;
  id_field_name text;
  candidate jsonb;
  candidate_type text;
  resolved_type text;
  candidate_id bigint;
  resolved_id bigint;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Authoritative raw job payload is not an object.'
      using errcode = '22023';
  end if;

  foreach converted_from_field_name in array array['ConvertedFrom', 'convertedFrom', 'converted_from'] loop
    if not (p_payload ? converted_from_field_name)
       or jsonb_typeof(p_payload -> converted_from_field_name) = 'null' then
      continue;
    end if;
    candidate := p_payload -> converted_from_field_name;
    if jsonb_typeof(candidate) <> 'object' then
      raise exception 'Authoritative raw job % provenance is not an object.', converted_from_field_name
        using errcode = '22023';
    end if;
    foreach field_name in array array['Type', 'type'] loop
      if not (candidate ? field_name)
         or jsonb_typeof(candidate -> field_name) = 'null' then
        continue;
      end if;
      if jsonb_typeof(candidate -> field_name) <> 'string' then
        raise exception 'Authoritative raw job ConvertedFrom.% is not a string.', field_name
          using errcode = '22023';
      end if;
      candidate_type := candidate ->> field_name;
      if resolved_type is not null and resolved_type <> candidate_type then
        raise exception 'Authoritative raw job ConvertedFrom type aliases conflict.'
          using errcode = '22023';
      end if;
      resolved_type := candidate_type;
    end loop;

    foreach id_field_name in array array['ID', 'Id', 'id'] loop
      if not (candidate ? id_field_name) then
        continue;
      end if;
      candidate_id := metrics.authoritative_relationship_scalar_id(
        candidate -> id_field_name,
        'Raw job ConvertedFrom.' || id_field_name
      );
      if candidate_id is null then
        continue;
      end if;
      if resolved_id is not null and resolved_id <> candidate_id then
        raise exception 'Authoritative raw job ConvertedFrom ID aliases conflict.'
          using errcode = '22023';
      end if;
      resolved_id := candidate_id;
    end loop;
  end loop;

  if resolved_type is distinct from 'Quote' then
    return null;
  end if;
  if resolved_id is null then
    raise exception 'Authoritative raw job ConvertedFrom.Type is Quote but no valid ConvertedFrom ID is present.'
      using errcode = '22023';
  end if;
  return resolved_id;
end;
$function$;

create temporary table quote_authoritative_direct_relationships on commit drop as
select q.quote_id,
       authoritative.id as source_snapshot_id,
       case
         when authoritative.id is null then null
         else metrics.authoritative_quote_linked_job_id(authoritative.payload)
       end as linked_job_id
  from metrics.metrics_quotes q
  left join lateral (
    select raw.id, raw.payload
      from metrics.raw_simpro_snapshots raw
     where raw.entity_type in ('quote_details', 'quotes')
       and raw.entity_id = q.quote_id::text
       and raw.complete_traversal = true
       and raw.source_deleted_at is null
     order by raw.extracted_at desc, raw.id desc
     limit 1
  ) authoritative on true
 where q.source_deleted_at is null;

do $block$
declare
  missing_quote_ids text;
begin
  select string_agg(quote_id::text, ', ' order by quote_id)
    into missing_quote_ids
    from quote_authoritative_direct_relationships
   where source_snapshot_id is null;
  if missing_quote_ids is not null then
    raise exception 'Active quotes lack authoritative latest complete live raw quote provenance (missing: %).',
      missing_quote_ids using errcode = '22023';
  end if;
end;
$block$;

create temporary table quote_authoritative_inverse_relationships on commit drop as
select j.job_id,
       j.converted_from_type as old_converted_from_type,
       j.converted_from_id as old_converted_from_id,
       j.job_source_type as old_job_source_type,
       j.job_source_id as old_job_source_id,
       snapshot.job_id is not null as has_snapshot,
       snapshot.source_quote_id as old_snapshot_source_quote_id,
       authoritative.id as source_snapshot_id,
       case when authoritative.id is null then null
            else metrics.authoritative_job_source_quote_id(authoritative.payload)
        end as quote_id
  from metrics.metrics_jobs j
  left join metrics.job_snapshots snapshot using (job_id)
  left join lateral (
    select raw.id, raw.payload
      from metrics.raw_simpro_snapshots raw
     where raw.entity_type in ('job_details', 'jobs')
       and raw.entity_id = j.job_id::text
       and raw.complete_traversal = true
       and raw.source_deleted_at is null
     order by raw.extracted_at desc, raw.id desc
     limit 1
  ) authoritative on true
 where j.source_deleted_at is null;

create temporary table quote_acceptance_semantics_projection on commit drop as
with source_evidence as (
  select q.quote_id,
         q.date_approved as canonical_date_approved,
         q.date_issued as canonical_date_issued,
         q.total,
         q.linked_job_id as old_canonical_linked_job_id,
         q.outcome as old_canonical_outcome,
         q.outcome_reason as old_canonical_reason,
         q.won_reason as old_canonical_won_reason,
         direct.source_snapshot_id as authoritative_quote_source_snapshot_id,
         direct.linked_job_id as authoritative_linked_job_id,
         direct_job.job_id as direct_conversion_job_id,
         inverse_job.job_id as inverse_conversion_job_id,
         inverse_job.source_snapshot_id as inverse_source_snapshot_id,
         inverse_drift.job_ids as inverse_relationship_drift_job_ids,
         lower(trim(coalesce(q.status_name, ''))) = 'quote accepted online' as accepted_online,
         direct_job.job_id is not null or inverse_job.job_id is not null as converted,
         exists (
           select 1
             from metrics.quote_classification_overrides exclusion
            where exclusion.quote_id = q.quote_id
              and exclusion.active
              and exclusion.outcome = 'excluded'
         ) as excluded,
         snapshot.quote_id is not null as has_snapshot,
         snapshot.date_approved as snapshot_date_approved,
         snapshot.date_issued as snapshot_date_issued,
         snapshot.linked_job_id as old_snapshot_linked_job_id,
         snapshot.won as old_snapshot_won,
         snapshot.won_value as old_snapshot_won_value,
         snapshot.win_loss_reason as old_snapshot_reason
    from metrics.metrics_quotes q
    join quote_authoritative_direct_relationships direct using (quote_id)
    left join metrics.quote_snapshots snapshot using (quote_id)
    left join lateral (
      select job.job_id
        from metrics.metrics_jobs job
       where job.job_id = direct.linked_job_id
         and job.source_deleted_at is null
       limit 1
    ) direct_job on true
    left join lateral (
      select inverse.job_id, inverse.source_snapshot_id
        from quote_authoritative_inverse_relationships inverse
       where inverse.quote_id = q.quote_id
       order by inverse.job_id
       limit 1
    ) inverse_job on true
    left join lateral (
      select array_agg(inverse.job_id order by inverse.job_id) as job_ids
        from quote_authoritative_inverse_relationships inverse
       where (
         inverse.quote_id = q.quote_id
         or (
           lower(trim(coalesce(inverse.old_converted_from_type, ''))) = 'quote'
           and inverse.old_converted_from_id = q.quote_id
         )
         or (
           lower(trim(coalesce(inverse.old_job_source_type, ''))) = 'quote'
           and inverse.old_job_source_id = q.quote_id
         )
         or inverse.old_snapshot_source_quote_id = q.quote_id
       )
         and (
           inverse.quote_id is distinct from inverse.old_converted_from_id
           or inverse.quote_id is distinct from inverse.old_job_source_id
           or inverse.quote_id is distinct from inverse.old_snapshot_source_quote_id
           or (inverse.quote_id is not null and (
             inverse.old_converted_from_type is distinct from 'Quote'
             or inverse.old_job_source_type is distinct from 'Quote'
           ))
           or (inverse.quote_id is null and (
             lower(trim(coalesce(inverse.old_converted_from_type, ''))) = 'quote'
             or lower(trim(coalesce(inverse.old_job_source_type, ''))) = 'quote'
             or inverse.old_snapshot_source_quote_id is not null
           ))
         )
    ) inverse_drift on true
   where q.source_deleted_at is null
), classified as (
  select source.*,
         case
           when source.excluded then 'excluded'
           when source.accepted_online or source.converted then 'won'
           else 'lost'
         end as new_outcome,
         case
           when source.excluded then 'manual_excluded'
           when source.accepted_online and source.converted then 'accepted_online_and_converted'
           when source.accepted_online then 'accepted_online'
           when source.converted then 'converted_job'
           else 'no_acceptance_evidence'
         end as new_reason
    from source_evidence source
)
select classified.*,
       classified.old_canonical_linked_job_id is distinct from classified.authoritative_linked_job_id
       or classified.old_canonical_outcome is distinct from classified.new_outcome
       or classified.old_canonical_reason is distinct from classified.new_reason
       or classified.old_canonical_won_reason is distinct from classified.new_reason
       or classified.inverse_relationship_drift_job_ids is not null
       or (
         classified.has_snapshot
         and (
           classified.old_snapshot_linked_job_id is distinct from classified.authoritative_linked_job_id
           or classified.old_snapshot_won is distinct from (classified.new_outcome = 'won')
           or classified.old_snapshot_won_value is distinct from (
             case when classified.new_outcome = 'won' then coalesce(classified.total, 0) else 0 end
           )
           or classified.old_snapshot_reason is distinct from classified.new_reason
         )
       ) as needs_repair
  from classified;

update metrics.metrics_jobs job
   set converted_from_type = case when relationship.quote_id is null then 'Direct service' else 'Quote' end,
       converted_from_id = relationship.quote_id,
       job_source_type = case when relationship.quote_id is null then 'Direct service' else 'Quote' end,
       job_source_id = relationship.quote_id,
       updated_from_source_at = now()
  from quote_authoritative_inverse_relationships relationship
 where job.job_id = relationship.job_id
   and (
     (relationship.quote_id is not null and (
       job.converted_from_type is distinct from 'Quote'
       or job.converted_from_id is distinct from relationship.quote_id
       or job.job_source_type is distinct from 'Quote'
       or job.job_source_id is distinct from relationship.quote_id
     ))
     or (relationship.quote_id is null and (
       lower(trim(coalesce(job.converted_from_type, ''))) = 'quote'
       or lower(trim(coalesce(job.job_source_type, ''))) = 'quote'
     ))
   );

update metrics.job_snapshots snapshot
   set source_quote_id = relationship.quote_id,
       updated_at = now()
  from quote_authoritative_inverse_relationships relationship
 where snapshot.job_id = relationship.job_id
   and snapshot.source_quote_id is distinct from relationship.quote_id;

update metrics.metrics_quotes q
   set linked_job_id = projection.authoritative_linked_job_id,
       outcome = projection.new_outcome,
       outcome_reason = projection.new_reason,
       won_reason = projection.new_reason,
       updated_from_source_at = now()
  from quote_acceptance_semantics_projection projection
 where q.quote_id = projection.quote_id
   and (
     q.linked_job_id is distinct from projection.authoritative_linked_job_id
     or q.outcome is distinct from projection.new_outcome
     or q.outcome_reason is distinct from projection.new_reason
     or q.won_reason is distinct from projection.new_reason
   );

update metrics.quote_snapshots snapshot
   set linked_job_id = projection.authoritative_linked_job_id,
       won = projection.new_outcome = 'won',
       won_value = case when projection.new_outcome = 'won' then coalesce(projection.total, 0) else 0 end,
       win_loss_reason = projection.new_reason,
       updated_at = now()
  from quote_acceptance_semantics_projection projection
 where snapshot.quote_id = projection.quote_id
   and (
     snapshot.linked_job_id is distinct from projection.authoritative_linked_job_id
     or snapshot.won is distinct from (projection.new_outcome = 'won')
     or snapshot.won_value is distinct from (
       case when projection.new_outcome = 'won' then coalesce(projection.total, 0) else 0 end
     )
     or snapshot.win_loss_reason is distinct from projection.new_reason
   );

insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'migration-035@prostarmechanical.com',
       'quote_acceptance_semantics_repaired',
       'quote',
       projection.quote_id::text,
       jsonb_build_object(
         'canonical_linked_job_id', projection.old_canonical_linked_job_id,
         'canonical_outcome', projection.old_canonical_outcome,
         'canonical_reason', projection.old_canonical_reason,
         'canonical_won_reason', projection.old_canonical_won_reason,
         'snapshot_present', projection.has_snapshot,
         'snapshot_linked_job_id', projection.old_snapshot_linked_job_id,
         'snapshot_won', projection.old_snapshot_won,
         'snapshot_won_value', projection.old_snapshot_won_value,
         'snapshot_reason', projection.old_snapshot_reason
         ,'inverse_relationship_drift_job_ids', projection.inverse_relationship_drift_job_ids
       ),
       jsonb_build_object(
         'canonical_linked_job_id', projection.authoritative_linked_job_id,
         'snapshot_linked_job_id', case
           when projection.has_snapshot then projection.authoritative_linked_job_id else null
         end,
         'outcome', projection.new_outcome,
         'reason_code', projection.new_reason,
         'authoritative_quote_source_snapshot_id', projection.authoritative_quote_source_snapshot_id,
         'direct_provenance_state', case
           when projection.authoritative_quote_source_snapshot_id is null
             then 'missing_latest_complete_raw_quote'
           when projection.authoritative_linked_job_id is null
             then 'present_without_direct_link'
           else 'present_with_direct_link'
         end,
         'direct_conversion_job_id', projection.direct_conversion_job_id,
         'inverse_conversion_job_id', projection.inverse_conversion_job_id,
         'inverse_source_snapshot_id', projection.inverse_source_snapshot_id,
         'inverse_relationship_reconciled_job_ids', projection.inverse_relationship_drift_job_ids,
         'classification_authority', 'exact_status_or_current_raw_relationship',
         'source_paths', jsonb_build_array(
           'accepted_online_status',
           'latest_complete_raw_quote_linked_job_id',
           'authoritative_inverse_converted_from_quote'
         ),
         'descriptive_number_evidence', false,
         'provenance', '035_remove_job_no_quote_acceptance'
       ),
       'Persisted quote relationships and outcomes repaired from authoritative conversion provenance.'
  from quote_acceptance_semantics_projection projection
 where projection.needs_repair;

insert into metrics.rollup_rebuild_queue (
  metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
)
select 'quotes',
       'month',
       affected.period_start,
       '{}'::jsonb,
       'quote_acceptance_semantics_repair',
       'migration-035:quote:' || projection.quote_id || ':' || affected.period_start::text
  from quote_acceptance_semantics_projection projection
  cross join lateral (
    select distinct date_trunc('month', source_date)::date as period_start
      from (values
        (projection.canonical_date_approved),
        (projection.canonical_date_issued),
        (projection.snapshot_date_approved),
        (projection.snapshot_date_issued)
      ) dates(source_date)
     where source_date is not null
  ) affected
 where projection.needs_repair
   and affected.period_start >= date '2023-01-01'
   and affected.period_start
         <= date_trunc('month', now() at time zone 'America/Los_Angeles')::date
on conflict (idempotency_key) do nothing;

create or replace function metrics.apply_reviewed_quote_exclusion_seeds(p_quote_ids bigint[])
returns table(applied_count integer)
language sql
as $function$
  with classification_lock as materialized (
    select pg_advisory_xact_lock(716630417::bigint)
  ), targets as materialized (
    select q.quote_id, q.category, q.date_approved, q.date_issued, q.total,
           seed.reason, seed.actor_email, seed.reviewed_on,
           seed.evidence_sha256, seed.idempotency_key, seed.provenance,
           case
             when lower(trim(coalesce(q.status_name, ''))) = 'quote accepted online'
               or direct_job.job_id is not null
               or inverse_job.job_id is not null then 'won'
             else 'lost'
           end as source_outcome
      from metrics.reviewed_quote_exclusion_seeds seed
      join metrics.metrics_quotes q using (quote_id)
      cross join classification_lock
      left join lateral (
        select raw.id, raw.payload
          from metrics.raw_simpro_snapshots raw
         where raw.entity_type in ('quote_details', 'quotes')
           and raw.entity_id = q.quote_id::text
           and raw.complete_traversal = true
           and raw.source_deleted_at is null
         order by raw.extracted_at desc, raw.id desc
         limit 1
      ) quote_source on true
      cross join lateral (
        select metrics.authoritative_quote_linked_job_id(quote_source.payload) as linked_job_id
      ) direct_source
      left join lateral (
        select job.job_id
          from metrics.metrics_jobs job
         where job.job_id = direct_source.linked_job_id
           and job.source_deleted_at is null
         limit 1
      ) direct_job on true
      left join lateral (
        select job.job_id
          from metrics.metrics_jobs job
          left join lateral (
            select raw.id, raw.payload
              from metrics.raw_simpro_snapshots raw
             where raw.entity_type in ('job_details', 'jobs')
               and raw.entity_id = job.job_id::text
               and raw.complete_traversal = true
               and raw.source_deleted_at is null
             order by raw.extracted_at desc, raw.id desc
             limit 1
          ) job_source on true
          cross join lateral (
            select case when job_source.id is null then null
                        else metrics.authoritative_job_source_quote_id(job_source.payload)
                    end as quote_id
          ) source_relationship
         where job.source_deleted_at is null
           and source_relationship.quote_id = q.quote_id
         order by job.job_id
         limit 1
      ) inverse_job on true
     where seed.enabled
       and q.source_deleted_at is null
       and q.quote_id = any(p_quote_ids)
     order by q.quote_id
     for update of q
  ), inserted as (
    insert into metrics.quote_classification_overrides (
      quote_id, category, won_override, action, outcome, previous_outcome,
      reason, evidence_url, actor_email, revision, idempotency_key, active
    )
    select target.quote_id, coalesce(target.category, 'Unclassified'), null,
           'exclude'::metrics.quote_override_action, 'excluded', target.source_outcome,
           target.reason, null, target.actor_email,
           coalesce((
             select max(history.revision)
               from metrics.quote_classification_overrides history
              where history.quote_id = target.quote_id
                and history.outcome in ('excluded', 'manual_reinstated')
           ), 0) + 1,
           target.idempotency_key, true
      from targets target
     where not exists (
       select 1 from metrics.quote_classification_overrides active_override
        where active_override.quote_id = target.quote_id and active_override.active
     )
       and not exists (
         select 1 from metrics.quote_classification_overrides prior_seed
          where prior_seed.idempotency_key = target.idempotency_key
       )
    returning *
  ), canonical_updated as (
    update metrics.metrics_quotes q
       set outcome = 'excluded',
           outcome_reason = 'manual_excluded',
           won_reason = 'manual_excluded',
           updated_from_source_at = now()
      from inserted
     where q.quote_id = inserted.quote_id
    returning q.quote_id, q.date_approved, q.date_issued, q.total
  ), snapshot_updated as (
    update metrics.quote_snapshots snapshot
       set won = false,
           won_value = 0,
           win_loss_reason = 'manual_excluded',
           updated_at = now()
      from inserted
     where snapshot.quote_id = inserted.quote_id
    returning snapshot.quote_id
  ), audit_written as (
    insert into metrics.audit_events (
      actor_email, action, entity_type, entity_id, before_value, after_value, reason
    )
    select inserted.actor_email, 'reviewed_quote_exclusion_seed_applied',
           'quote_classification_override', inserted.quote_id::text,
           jsonb_build_object(
             'source_outcome', inserted.previous_outcome,
             'active_exclusion_revision', 0
           ),
           jsonb_build_object(
             'action', 'exclude',
             'outcome', 'excluded',
             'reason_code', 'manual_excluded',
             'revision', inserted.revision,
             'override_id', inserted.id,
             'idempotency_key', inserted.idempotency_key,
             'reviewed_on', target.reviewed_on,
             'evidence_sha256', target.evidence_sha256,
             'registry_provenance', target.provenance,
             'provenance', '035_remove_job_no_quote_acceptance'
           ),
           inserted.reason
      from inserted
      join targets target using (quote_id)
    returning id
  ), rollup_requested as (
    insert into metrics.rollup_rebuild_queue (
      metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
    )
    select 'quotes', 'month', affected.period_start,
           '{}'::jsonb, 'reviewed_quote_exclusion_seed',
           inserted.idempotency_key || ':quotes:' || affected.period_start::text
      from inserted
      join metrics.metrics_quotes q using (quote_id)
      left join metrics.quote_snapshots snapshot using (quote_id)
      cross join lateral (
        select distinct date_trunc('month', source_date)::date as period_start
          from (values
            (q.date_approved),
            (q.date_issued),
            (snapshot.date_approved),
            (snapshot.date_issued)
          ) dates(source_date)
         where source_date is not null
      ) affected
     where affected.period_start >= date '2023-01-01'
       and affected.period_start
             <= date_trunc('month', now() at time zone 'America/Los_Angeles')::date
    on conflict (idempotency_key) do nothing
    returning id
  )
  select count(*)::integer from inserted
  where (select count(*) from canonical_updated) >= 0
    and (select count(*) from snapshot_updated) >= 0
    and (select count(*) from audit_written) >= 0
    and (select count(*) from rollup_requested) >= 0;
$function$;

insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'migration-035@prostarmechanical.com',
       'quote_acceptance_semantics_locked',
       'database_migration',
       '035_remove_job_no_quote_acceptance',
       null,
       jsonb_build_object(
         'accepted_online_status', 'normalized_exact_match',
         'direct_relationship', 'latest_complete_raw_quote_link_to_live_job',
         'inverse_relationship', 'authoritative_converted_from_quote_to_live_job',
         'descriptive_number_evidence', false,
         'active_exclusion_precedence', true,
         'provenance', '035_remove_job_no_quote_acceptance'
       ),
       'Quote acceptance now requires exact status or an authoritative current conversion relationship.'
 where not exists (
   select 1
     from metrics.audit_events existing
    where existing.action = 'quote_acceptance_semantics_locked'
      and existing.entity_type = 'database_migration'
      and existing.entity_id = '035_remove_job_no_quote_acceptance'
 );

create schema if not exists metrics;

create table if not exists metrics.schema_migrations (
  filename text primary key,
  sha256 text not null,
  applied_at timestamptz not null default now()
);

-- Commission approval and initialization evidence is append-only. The period,
-- config, override, and calculation records it authenticates are already
-- revisioned or immutable; their approval audit must not be mutable either.
create or replace function metrics.protect_commission_approval_audit()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.action in (
      'commission_override_revised',
      'commission_period_config_evidence_seeded',
      'commission_tier_config_upgraded',
      'commission_config_revised',
      'commission_period_historical_initialization_evidenced',
      'commission_initialization_rebuild_requeued'
    ) then
      raise exception 'commission approval audit events are immutable' using errcode = '55000';
    end if;
    return old;
  end if;

  if old.action in (
       'commission_override_revised',
       'commission_period_config_evidence_seeded',
       'commission_tier_config_upgraded',
       'commission_config_revised',
       'commission_period_historical_initialization_evidenced',
       'commission_initialization_rebuild_requeued'
     )
     or new.action in (
       'commission_override_revised',
       'commission_period_config_evidence_seeded',
       'commission_tier_config_upgraded',
       'commission_config_revised',
       'commission_period_historical_initialization_evidenced',
       'commission_initialization_rebuild_requeued'
     ) then
    raise exception 'commission approval audit events are immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists commission_approval_audit_immutable on metrics.audit_events;
create trigger commission_approval_audit_immutable
  before update or delete on metrics.audit_events
  for each row execute function metrics.protect_commission_approval_audit();

create unique index if not exists commission_override_approval_audit_idx
  on metrics.audit_events ((after_value ->> 'override_id'))
  where entity_type = 'commission_period'
    and action = 'commission_override_revised';

create unique index if not exists commission_period_initialization_audit_idx
  on metrics.audit_events (entity_id)
  where entity_type = 'commission_period'
    and action = 'commission_period_historical_initialization_evidenced';

create or replace function metrics.commission_initialization_prerequisite_status(
  p_period_start date
)
returns table(evidence text, accepted boolean)
language sql
stable
as $$
  with required_backfill(source_family) as (
    values ('jobs'::text), ('job_nested'), ('employees'), ('timesheets'), ('jobs_from_timesheets')
  ), backfill as (
    select 'backfill:' || required.source_family as evidence,
           coalesce(
             ledger.required_for_completion
             and ledger.status = 'completed'
             and ledger.reconciliation_status = 'matched'
             and ledger.continuation_token is null
             and ledger.plan_hash ~ '^[0-9a-f]{64}$',
             false
           ) as accepted
      from required_backfill required
      left join metrics.backfill_source_month_ledger ledger
        on ledger.source_family = required.source_family
       and ledger.month_start = p_period_start
  ), required_reconciliation(scope, source_families) as (
    values
      ('jobs'::text, array['jobs', 'job_nested']::text[]),
      ('technicians'::text, array[
        'jobs', 'job_nested', 'employees', 'timesheets', 'jobs_from_timesheets',
        'schedules', 'mobile_status'
      ]::text[])
  ), reconciliations as (
    select 'reconciliation:' || required.scope as evidence,
           coalesce(
             authority.status = 'matched'
             and authority.complete_traversal
             and authority.generation is not null
             and authority.period_end = (p_period_start + interval '1 month - 1 day')::date
             and (
               select count(*)
                 from unnest(required.source_families) family(source_family)
                 join metrics.source_period_manifests manifest
                   on manifest.source_family = family.source_family
                  and manifest.period_start = p_period_start
                  and manifest.period_end = authority.period_end
                  and manifest.coverage_status = 'complete'
                  and manifest.reconciliation_status = 'matched'
                  and manifest.continuation_token is null
                  and manifest.manifest_generation = authority.generation
                  and manifest.reconciliation_generation = manifest.manifest_generation
                  and manifest.expected_page_count > 0
                  and manifest.completed_page_count = manifest.expected_page_count
                  and manifest.reconciled_at is not null
                  and authority.source_manifest_generations ->> manifest.source_family = manifest.manifest_generation::text
             ) = cardinality(required.source_families),
             false
           ) as accepted
      from required_reconciliation required
      left join metrics.authoritative_reconciliation_checks authority
        on authority.scope = required.scope
       and authority.period_start = p_period_start
  )
  select * from backfill
  union all
  select * from reconciliations;
$$;

create or replace function metrics.commission_initialization_prerequisites_accepted(
  p_period_start date
)
returns boolean
language sql
stable
as $$
  select count(*) = 7 and bool_and(accepted)
    from metrics.commission_initialization_prerequisite_status(p_period_start);
$$;

create or replace function metrics.commission_canonical_json(p_value jsonb)
returns text
language plpgsql
immutable
strict
parallel safe
as $$
declare
  value_type text := jsonb_typeof(p_value);
  canonical text;
begin
  if value_type = 'array' then
    select '[' || coalesce(string_agg(metrics.commission_canonical_json(item), ',' order by ordinal), '') || ']'
      into canonical
      from jsonb_array_elements(p_value) with ordinality elements(item, ordinal);
    return canonical;
  elsif value_type = 'object' then
    select '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || metrics.commission_canonical_json(value), ',' order by key collate "C"), '') || '}'
      into canonical
      from jsonb_each(p_value) entries(key, value);
    return canonical;
  elsif value_type = 'number' then
    return to_jsonb((p_value #>> '{}')::double precision)::text;
  end if;
  return p_value::text;
end;
$$;

create or replace function metrics.commission_canonical_json_sha256(p_value jsonb)
returns text
language sql
immutable
strict
parallel safe
as $$
  select encode(sha256(convert_to(metrics.commission_canonical_json(p_value), 'UTF8')), 'hex');
$$;

create or replace view metrics.commission_initialization_v2_audit_records as
select a.id as initialization_audit_id, a.actor_email, a.reason as initialization_reason,
       a.before_value, a.after_value, p.id as period_id, p.period_start,
       p.period_end, p.revision as period_revision,
       migration_019.sha256 as migration_019_sha256,
       migration_025.sha256 as migration_025_sha256,
       migration_036.sha256 as migration_036_sha256,
       migration_036.applied_at as integrity_migration_applied_at
  from metrics.audit_events a
  join metrics.commission_periods p
    on p.id::text = a.entity_id
  join metrics.commission_period_configs config
    on config.period_id = p.id
   and config.revision = p.config_revision
   and config.active
  join metrics.commission_period_configs predecessor
    on predecessor.period_id = p.id
   and predecessor.revision = config.revision - 1
   and not predecessor.active
   and predecessor.superseded_at is not null
  join metrics.audit_events audit_019
    on audit_019.entity_type = 'commission_period'
   and audit_019.entity_id = p.id::text
   and audit_019.action = 'commission_period_config_evidence_seeded'
  join metrics.audit_events audit_025
    on audit_025.entity_type = 'commission_period'
   and audit_025.entity_id = p.id::text
   and audit_025.action = 'commission_tier_config_upgraded'
  join metrics.schema_migrations migration_019
    on migration_019.filename = '019_seed_verified_commission_period_configs.sql'
   and migration_019.sha256 = '32a9947998e3e8c7e7f0403ef87b18ca53b2536d78a1a4892d738ef3cf5a5f60'
  join metrics.schema_migrations migration_025
    on migration_025.filename = '025_upgrade_verified_commission_tier_config.sql'
   and migration_025.sha256 = '68437467608d41cfe828a03c9f5a2637b079a6feb0dc6a5169a96f6446bc1178'
  join metrics.schema_migrations migration_036
    on migration_036.filename = '036_commission_initialization_integrity.sql'
   and migration_036.sha256 ~ '^[0-9a-f]{64}$'
 cross join lateral (
   select
     case when a.after_value ->> 'periodRevision' ~ '^[1-9][0-9]*$'
       then (a.after_value ->> 'periodRevision')::integer end as audit_period_revision,
     case when a.after_value ->> 'rosterEntries' ~ '^[1-9][0-9]*$'
       then (a.after_value ->> 'rosterEntries')::integer end as roster_entries,
     case when a.after_value ->> 'overrideCount' ~ '^[0-9]+$'
       then (a.after_value ->> 'overrideCount')::integer end as override_count,
     case when a.after_value ->> 'effectiveOverrideCount' ~ '^[0-9]+$'
       then (a.after_value ->> 'effectiveOverrideCount')::integer end as effective_override_count
 ) parsed
 cross join lateral (
   select count(*)::integer as roster_entries,
          coalesce(bool_and(
            rows.included
            and rows.tier = 'standard'
            and rows.effective_end is null
            and rows.notes = 'Eligibility and effective date seeded from the prior Pro Star commissions dashboard EMPLOYEES configuration.'
            and rows.seed_audit_count = 1
            and rows.seed_audit_valid
          ), false) as valid,
          coalesce(
            jsonb_agg(rows.id::text order by rows.employee_id, rows.effective_start, rows.id),
            '[]'::jsonb
          ) as row_ids,
          metrics.commission_canonical_json_sha256(coalesce(
            jsonb_agg(
              jsonb_build_object(
                'rosterId', rows.id::text,
                'employeeId', rows.employee_id::text,
                'displayName', rows.display_name,
                'included', rows.included,
                'tier', rows.tier,
                'effectiveStart', rows.effective_start::text,
                'effectiveEnd', rows.effective_end::text,
                'notes', rows.notes,
                'seedAuditId', rows.seed_audit_id
              ) order by rows.employee_id::text collate "C", rows.id
            ),
            '[]'::jsonb
          )) as roster_hash
     from (
       select roster.*,
              seed.seed_audit_count,
              seed.seed_audit_id,
              seed.seed_audit_valid
         from metrics.commission_roster roster
        cross join lateral (
          select count(*)::integer as seed_audit_count,
                 min(roster_audit.id)::text as seed_audit_id,
                 coalesce(bool_and(
                   roster_audit.actor_email = 'system:migration-009'
                   and roster_audit.reason = 'Seed effective-dated commission eligibility from the prior commissions dashboard evidence.'
                   and roster_audit.after_value = jsonb_build_object(
                     'employeeId', roster.employee_id,
                     'displayName', roster.display_name,
                     'included', true,
                     'effectiveStart', roster.effective_start
                   )
                 ), false) as seed_audit_valid
            from metrics.audit_events roster_audit
           where roster_audit.entity_type = 'commission_roster'
             and roster_audit.entity_id = roster.id::text
             and roster_audit.action = 'commission_roster_seeded'
        ) seed
        where roster.effective_start <= p.period_end
          and (roster.effective_end is null or roster.effective_end >= p.period_start)
     ) rows
 ) roster_evidence
 cross join lateral (
   with override_rows as materialized (
     select override_row.*, override_period.revision as period_revision,
            approval.audit_count, approval.audit_id, approval.audit_valid
       from metrics.commission_overrides override_row
       join metrics.commission_periods override_period on override_period.id = override_row.period_id
      cross join lateral (
        select count(*)::integer as audit_count,
               min(override_audit.id) as audit_id,
               coalesce(bool_and(
                 lower(override_audit.actor_email) = lower(override_row.actor_email)
                 and override_audit.entity_id = override_row.period_id::text
                 and override_audit.reason = override_row.reason
                 and override_audit.before_value = jsonb_build_object(
                   'field', override_row.field_name,
                   'value', override_row.before_value
                 )
                 and override_audit.after_value = jsonb_build_object(
                   'field', override_row.field_name,
                   'value', override_row.after_value,
                   'override_id', override_row.id,
                   'override_revision', override_row.revision
                 )
               ), false) as audit_valid
          from metrics.audit_events override_audit
         where override_audit.action = 'commission_override_revised'
           and override_audit.entity_type = 'commission_period'
           and override_audit.after_value ->> 'override_id' = override_row.id::text
      ) approval
      where override_period.period_start = p.period_start
   ), ranked_effective as (
     select override_rows.*,
            row_number() over (
              partition by employee_id, field_name
              order by period_revision desc, revision desc, id desc
            ) as effective_rank
       from override_rows
      where active
   )
   select (select count(*)::integer from override_rows) as override_count,
          (select count(*)::integer from ranked_effective where effective_rank = 1) as effective_override_count,
          coalesce((
            select bool_and(
              audit_count = 1
              and audit_valid
              and lower(actor_email) in ('asad@prostarmechanical.com', 'laila@prostarmechanical.com')
              and idempotency_key ~ '^[0-9a-f]{64}$'
              and active = (superseded_at is null)
              and exists (
                select 1
                  from metrics.commission_roster roster
                 where roster.employee_id = override_rows.employee_id
                   and roster.effective_start <= p.period_end
                   and (roster.effective_end is null or roster.effective_end >= p.period_start)
              )
            ) from override_rows
          ), true) as valid,
          coalesce((
            select jsonb_agg(id::text order by employee_id::text collate "C", field_name collate "C", revision, id)
              from override_rows
          ), '[]'::jsonb) as row_ids,
          coalesce((
            select jsonb_agg(audit_id::text order by audit_id)
              from override_rows
          ), '[]'::jsonb) as audit_ids,
          metrics.commission_canonical_json_sha256(coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'overrideId', id::text,
                'periodId', period_id::text,
                'periodRevision', period_revision,
                'employeeId', employee_id::text,
                'field', field_name,
                'before', before_value,
                'after', after_value,
                'valueType', value_type,
                'reason', reason,
                'evidenceUrl', evidence_url,
                'actorEmail', lower(actor_email),
                'poolTreatment', pool_treatment,
                'revision', revision,
                'active', active,
                'supersededAt', superseded_at::text,
                'idempotencyKey', idempotency_key,
                'createdAt', created_at::text
              ) order by employee_id::text collate "C", field_name collate "C", revision, id
            )
              from ranked_effective
             where effective_rank = 1
          ), '[]'::jsonb)) as override_hash
 ) override_evidence
 where a.action = 'commission_period_historical_initialization_evidenced'
   and a.entity_type = 'commission_period'
   and a.actor_email in ('asad@prostarmechanical.com', 'laila@prostarmechanical.com')
   and a.reason = 'Initialize the monthly commission period from locked prior-dashboard config and effective-dated roster evidence without changing existing commission policy or overrides.'
   and jsonb_typeof(a.after_value) = 'object'
   and (select count(*) from jsonb_object_keys(a.after_value)) = 19
   and a.after_value ->> 'initializationVersion' = 'commission-period-initialization-v2'
   and a.after_value ->> 'periodAction' in ('create', 'preserve')
   and a.after_value ->> 'configAction' in ('insert_locked', 'preserve')
   and a.after_value ->> 'rebuildAction' in ('enqueue', 'use_existing', 'not_needed')
   and a.after_value ->> 'periodStart' = p.period_start::text
   and a.after_value ->> 'periodEnd' = p.period_end::text
   and parsed.audit_period_revision = p.revision
   and (select count(*) from metrics.commission_period_configs chain where chain.period_id = p.id) = 2
   and predecessor.config_json = '{"poolPercent":0.5,"minBonusPercent":5,"efficiencyEnabled":false,"maxEfficiencyAdjustmentPercent":20}'::jsonb
   and predecessor.config_hash = '5966f042954aea4d9e8d7499655b76f7d4df9748693972cd386a8a7fb6735553'
   and predecessor.pool_pct = 0.50
   and predecessor.min_bonus_pct = 5.00
   and not predecessor.efficiency_enabled
   and predecessor.max_efficiency_adjustment_pct = 20.00
   and predecessor.on_time_threshold_minutes = 15
   and predecessor.actor_email = 'system:migration-019'
   and predecessor.idempotency_key = 'verified-prior-dashboard-config:' || p.period_start::text
   and audit_019.actor_email = 'system:migration-019'
   and audit_019.before_value is null
   and audit_019.reason = 'Persist period-effective evidence for the commission config already specified by the authoritative prior dashboard and locked implementation plan.'
   and audit_019.after_value = jsonb_build_object(
     'periodStart', p.period_start,
     'periodEnd', p.period_end,
     'configRevision', predecessor.revision,
     'configHash', predecessor.config_hash,
     'config', predecessor.config_json,
     'evidence', jsonb_build_object(
       'source', 'docs/prostar-metrics/reference/commissions-dashboard.html',
       'sourceSha256', '037b1f6e0e5b7a4156a8eee8180307e92dfc3f0f17b8f19b5ea7011f2852538b',
       'sourceLines', '604-610',
       'planSection', '6.4 Technician Commissions / Base calculation order',
       'historicalBasis', 'The prior dashboard declares one global CONFIG used by its monthly calculations.'
     )
   )
   and a.after_value ->> 'configHash' = '719dd0fb880a4ffd7447f35a97b8989a0c9bbf1350071edbcc5fb708ffa574fc'
   and a.after_value ->> 'configHash' = config.config_hash
   and a.after_value ->> 'configEvidenceActor' = 'system:migration-025'
   and config.actor_email = 'system:migration-025'
   and config.idempotency_key = 'verified-tier-config:025:' || p.id::text
   and config.superseded_at is null
   and config.pool_pct = 0.50
   and config.min_bonus_pct = 5.00
   and not config.efficiency_enabled
   and config.max_efficiency_adjustment_pct = 20.00
   and config.on_time_threshold_minutes = 15
   and config.config_json = '{"poolPercent":0.5,"minBonusPercent":5,"efficiencyEnabled":false,"maxEfficiencyAdjustmentPercent":20,"tierMultipliers":{"Gold":1.3,"Silver":1.2,"Bronze":1.1,"Standard":1}}'::jsonb
   and p.config = config.config_json
   and audit_025.actor_email = 'system:migration-025'
   and audit_025.reason = 'Added the locked default tier multipliers to the verified prior-dashboard config and queued an immutable recalculation.'
   and audit_025.before_value = jsonb_build_object(
     'configHash', predecessor.config_hash,
     'tierMultipliers', null
   )
   and jsonb_typeof(audit_025.after_value) = 'object'
   and (select count(*) from jsonb_object_keys(audit_025.after_value)) = 4
   and audit_025.after_value ->> 'configRevision' = config.revision::text
   and audit_025.after_value ->> 'configHash' = config.config_hash
   and audit_025.after_value -> 'tierMultipliers' = config.config_json -> 'tierMultipliers'
   and jsonb_typeof(audit_025.after_value -> 'rebuildQueued') = 'boolean'
   and (select count(*) from metrics.audit_events config_audit
         where config_audit.entity_type = 'commission_period'
           and config_audit.entity_id = p.id::text
           and config_audit.action in (
             'commission_period_config_evidence_seeded',
             'commission_tier_config_upgraded',
             'commission_config_revised'
           )) = 2
   and (
     (a.after_value ->> 'periodAction' = 'create'
       and p.created_by = a.actor_email
       and p.revision_reason = 'Initialized from locked prior-dashboard commission policy evidence.')
     or a.after_value ->> 'periodAction' = 'preserve'
   )
   and (
     (a.after_value ->> 'periodAction' = 'create' and a.before_value = 'null'::jsonb)
     or (a.after_value ->> 'periodAction' = 'preserve'
       and a.before_value = jsonb_build_object(
         'periodPreserved', true,
         'configPreserved', a.after_value ->> 'configAction' = 'preserve',
         'overridesPreserved', parsed.override_count
       ))
   )
   and roster_evidence.valid
   and roster_evidence.roster_entries > 0
   and parsed.roster_entries = roster_evidence.roster_entries
   and a.after_value -> 'rosterRowIds' = roster_evidence.row_ids
   and a.after_value ->> 'rosterHash' = roster_evidence.roster_hash
   and override_evidence.valid
   and parsed.override_count = override_evidence.override_count
   and parsed.effective_override_count = override_evidence.effective_override_count
   and a.after_value -> 'overrideRowIds' = override_evidence.row_ids
   and a.after_value -> 'overrideAuditIds' = override_evidence.audit_ids
   and a.after_value ->> 'overrideHash' = override_evidence.override_hash
   and (
     (a.after_value ->> 'rebuildAction' = 'not_needed' and a.after_value -> 'rebuildQueue' = 'null'::jsonb)
     or (a.after_value ->> 'rebuildAction' in ('enqueue', 'use_existing')
       and jsonb_typeof(a.after_value -> 'rebuildQueue') = 'object')
   )
   and a.after_value -> 'evidence' = jsonb_build_object(
     'priorDashboard', jsonb_build_object(
       'path', 'docs/prostar-metrics/reference/commissions-dashboard.html',
       'sha256', '037b1f6e0e5b7a4156a8eee8180307e92dfc3f0f17b8f19b5ea7011f2852538b',
       'configLines', '603-610', 'rosterLines', '613-623'
     ),
     'lockedPlan', jsonb_build_object(
       'path', 'docs/prostar-metrics/execution-plan.md',
       'sha256', '7392ad68fb810b840175604291a9b43cb57a3a4dce23de546f3e1c057abca3e5',
       'section', '6.4 Technician Commissions'
     ),
     'rosterMigration', jsonb_build_object(
       'path', 'infra/db/migrations/009_commission_roster_seed.sql',
       'sha256', '3601b7b7dbf0031f59828600ef4726cf616006c79875a2c3ac9b923d3c8599b5'
     ),
     'configMigrations', jsonb_build_array(
       jsonb_build_object(
         'path', 'infra/db/migrations/019_seed_verified_commission_period_configs.sql',
         'sha256', migration_019.sha256
       ),
       jsonb_build_object(
         'path', 'infra/db/migrations/025_upgrade_verified_commission_tier_config.sql',
         'sha256', migration_025.sha256
       )
     ),
     'integrityMigration', jsonb_build_object(
       'path', 'infra/db/migrations/036_commission_initialization_integrity.sql',
       'sha256', migration_036.sha256
     ),
     'lockedConfigHash', '719dd0fb880a4ffd7447f35a97b8989a0c9bbf1350071edbcc5fb708ffa574fc'
   );

create or replace view metrics.commission_initialization_v2_queue_records as
select q.id, q.metric_family, q.period_grain, q.period_start, q.dimensions_json,
       q.reason, q.status, q.attempts, q.locked_by, q.locked_until,
       q.idempotency_key, q.created_at, q.finished_at, q.error_message,
       audit.period_id, audit.period_revision, audit.initialization_audit_id,
       audit.migration_019_sha256, audit.migration_025_sha256, audit.migration_036_sha256
  from metrics.rollup_rebuild_queue q
  join metrics.commission_initialization_v2_audit_records audit
    on audit.after_value ->> 'rebuildAction' in ('enqueue', 'use_existing')
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
 where q.metric_family = 'commissions'
   and q.period_grain = 'month'
   and q.dimensions_json = '{}'::jsonb
   and q.period_start = audit.period_start
   and q.reason = 'Historical commission period initialization v2 from locked evidence'
   and q.idempotency_key = 'commissions:month:' || q.period_start::text || ':commission-period-initialization-v2'
   and q.created_at >= audit.integrity_migration_applied_at
   and not exists (
     select 1
       from metrics.commission_periods newer
      where newer.period_start = audit.period_start
        and (
          newer.revision > audit.period_revision
          or (newer.revision = audit.period_revision and newer.id > audit.period_id)
        )
   );

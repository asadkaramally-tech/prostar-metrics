create schema if not exists metrics;

create table if not exists metrics.technician_metric_configs (
  id bigserial primary key,
  effective_start date not null,
  effective_end date,
  revision integer not null check (revision > 0),
  on_time_threshold_minutes integer not null check (on_time_threshold_minutes between 0 and 240),
  mobile_status_verified boolean not null default false,
  arrival_status_ids bigint[] not null default '{}'::bigint[],
  completion_status_ids bigint[] not null default '{}'::bigint[],
  evidence_json jsonb not null default '{}'::jsonb,
  config_hash text not null,
  actor_email text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (effective_start, revision),
  unique (config_hash),
  check (effective_end is null or effective_end >= effective_start),
  check (not (arrival_status_ids && completion_status_ids)),
  check (
    not mobile_status_verified
    or (cardinality(arrival_status_ids) > 0 and cardinality(completion_status_ids) > 0)
  )
);

create index if not exists technician_metric_configs_effective_idx
  on metrics.technician_metric_configs (effective_start desc, revision desc)
  where active;

insert into metrics.technician_metric_configs (
  effective_start, effective_end, revision, on_time_threshold_minutes,
  mobile_status_verified, arrival_status_ids, completion_status_ids,
  evidence_json, config_hash, actor_email, active
)
select
  date '2023-01-01', null, 1, 15, true,
  array[40]::bigint[], array[38, 39, 42, 70]::bigint[],
  jsonb_build_object(
    'source', 'checksum-verified Simpro mobile-status export plus read-only production sequence analysis',
    'sourceManifestSha256', '9c1559ffbf72514783acddf90d1d3eba21ec47b0008998103b76a829e2c091b0',
    'evidenceThrough', '2026-07-10',
    'statusNames', jsonb_build_object(
      '40', 'Onsite',
      '38', 'Maintenance Complete',
      '39', 'Install Complete',
      '42', 'Follow Up Required',
      '70', 'Completed'
    ),
    'arrivalEvidence', jsonb_build_object(
      'onsiteEventsSince2023', 14757,
      'mappedJobs', 9926,
      'mappedPeople', 27,
      'basis', 'Onsite is the explicit technician on-site transition and follows Travelling/Travel Stopped in sampled job timelines.'
    ),
    'completionEvidence', jsonb_build_object(
      'basis', 'Only explicit completed or visit-ending work outcomes are accepted; audit, break, travel, survey, awaiting, and other statuses remain unverified.',
      'sampleSequence', 'Onsite precedes the selected terminal outcomes for the same employee and job.'
    )
  ),
  'f02e80b7beccea77a2d6ff5ec8116e649c2d8c9f34fc50a6ed5db0da73d85e69',
  'metrics-contract@prostarmechanical.com', true
where not exists (
  select 1 from metrics.technician_metric_configs
   where config_hash = 'f02e80b7beccea77a2d6ff5ec8116e649c2d8c9f34fc50a6ed5db0da73d85e69'
);

insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select
  'metrics-contract@prostarmechanical.com',
  'technician_mobile_semantics_verified',
  'technician_metric_config',
  config.id::text,
  null,
  jsonb_build_object(
    'effectiveStart', config.effective_start,
    'onTimeThresholdMinutes', config.on_time_threshold_minutes,
    'arrivalStatusIds', config.arrival_status_ids,
    'completionStatusIds', config.completion_status_ids,
    'configHash', config.config_hash,
    'evidence', config.evidence_json
  ),
  'Persist the production-verified Simpro mobile event semantics required for technician-specific arrival, duration, and on-time calculations.'
from metrics.technician_metric_configs config
where config.config_hash = 'f02e80b7beccea77a2d6ff5ec8116e649c2d8c9f34fc50a6ed5db0da73d85e69'
  and not exists (
    select 1 from metrics.audit_events audit
     where audit.action = 'technician_mobile_semantics_verified'
       and audit.entity_type = 'technician_metric_config'
       and audit.entity_id = config.id::text
  );

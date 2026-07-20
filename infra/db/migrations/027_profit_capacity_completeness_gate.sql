create or replace view metrics.simpro_profit_capacity_completeness as
select
  (select count(*)::bigint
     from metrics.metrics_jobs job
    where job.source_deleted_at is null
      and job.stage in ('Complete', 'Archived')) as completed_jobs_total,
  (select count(*)::bigint
     from metrics.metrics_jobs job
    where job.source_deleted_at is null
      and job.stage in ('Complete', 'Archived')
      and job.profit_capacity_normalized_at is null) as completed_jobs_missing,
  (select count(*)::bigint
     from metrics.metrics_job_cost_centers cost_center
     join metrics.metrics_jobs job on job.job_id = cost_center.job_id
    where job.source_deleted_at is null
      and job.stage in ('Complete', 'Archived')
      and cost_center.source_deleted_at is null) as active_completed_cost_centers_total,
  (select count(*)::bigint
     from metrics.metrics_job_cost_centers cost_center
     join metrics.metrics_jobs job on job.job_id = cost_center.job_id
    where job.source_deleted_at is null
      and job.stage in ('Complete', 'Archived')
      and cost_center.source_deleted_at is null
      and not cost_center.totals_authoritative) as active_completed_cost_centers_missing,
  (select count(*)::bigint
     from metrics.dim_people person
    where person.simpro_employee_id is not null) as people_total,
  (select count(*)::bigint
     from metrics.dim_people person
    where person.simpro_employee_id is not null
      and person.capacity_normalized_at is null) as people_missing;

comment on view metrics.simpro_profit_capacity_completeness is
  'Serving gate. Jobs and technicians cannot be current/matched until all migration-026 missing counts are zero.';

create schema if not exists metrics;

create or replace view metrics.job_source_quotes as
select j.job_id,
       coalesce(
         case
           when lower(trim(coalesce(j.converted_from_type, ''))) = 'quote'
             then j.converted_from_id
           else null
         end,
         linked.quote_id
       ) as source_quote_id,
       case
         when lower(trim(coalesce(j.converted_from_type, ''))) = 'quote'
              and j.converted_from_id is not null then 'converted_from'
         when linked.quote_id is not null then 'quote_linked_job'
         else null
       end as resolution_basis
  from metrics.metrics_jobs j
  left join lateral (
    select q.quote_id
      from metrics.metrics_quotes q
     where q.linked_job_id = j.job_id
       and q.source_deleted_at is null
     order by q.quote_id
     limit 1
  ) linked on true
 where j.source_deleted_at is null;

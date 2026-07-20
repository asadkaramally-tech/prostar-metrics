-- Quote customer/site identity for the open-quote follow-up queue and the
-- direct-service follow-up linkage. Follows the migration-026 pattern that
-- added metrics_jobs.customer_name/site_name: add the columns, keep them
-- populated from the authoritative raw Simpro payload via a trigger, then
-- replay already-fetched payloads without any Simpro request.
-- 039/040 are reserved for in-flight roster/ingestion work by other passes.

create schema if not exists metrics;

alter table metrics.metrics_quotes
  add column if not exists customer_id bigint,
  add column if not exists customer_name text,
  add column if not exists site_id bigint,
  add column if not exists site_name text;

create or replace function metrics.apply_quote_customer_site_identity()
returns trigger
language plpgsql
as $$
declare detail jsonb;
begin
  select snapshot.payload into detail
    from metrics.raw_simpro_snapshots snapshot
   where snapshot.entity_type in ('quote_details', 'quotes')
     and snapshot.entity_id = new.quote_id::text
     and snapshot.source_deleted_at is null
   order by snapshot.extracted_at desc, snapshot.id desc
   limit 1;
  if detail is null then return new; end if;

  new.customer_id := nullif(regexp_replace(coalesce(detail #>> '{Customer,ID}', ''), '[^0-9]', '', 'g'), '')::bigint;
  new.customer_name := coalesce(
    nullif(btrim(coalesce(detail #>> '{Customer,CompanyName}', '')), ''),
    nullif(btrim(concat_ws(' ', detail #>> '{Customer,GivenName}', detail #>> '{Customer,FamilyName}')), '')
  );
  new.site_id := nullif(regexp_replace(coalesce(detail #>> '{Site,ID}', ''), '[^0-9]', '', 'g'), '')::bigint;
  new.site_name := nullif(btrim(coalesce(detail #>> '{Site,Name}', '')), '');
  return new;
end;
$$;

drop trigger if exists metrics_quotes_customer_site_identity on metrics.metrics_quotes;
create trigger metrics_quotes_customer_site_identity
before insert or update on metrics.metrics_quotes
for each row execute function metrics.apply_quote_customer_site_identity();

-- Replays already-fetched raw quote payloads through the trigger without a
-- Simpro request (same replay technique as migration 026).
update metrics.metrics_quotes set updated_from_source_at = updated_from_source_at;

comment on column metrics.metrics_quotes.customer_name is
  'Simpro Customer CompanyName (or Given+Family name) from the latest raw quote payload; display identity only, never acceptance evidence.';
comment on column metrics.metrics_quotes.site_name is
  'Simpro Site Name from the latest raw quote payload; display identity only.';
comment on column metrics.metrics_quotes.site_id is
  'Simpro Site ID from the latest raw quote payload; used for same-site follow-up linkage.';
comment on column metrics.metrics_quotes.customer_id is
  'Simpro Customer ID from the latest raw quote payload.';

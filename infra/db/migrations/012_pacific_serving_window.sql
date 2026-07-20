-- Align the database serving boundary with the Pacific business calendar used
-- by the dashboard and reject non-canonical monthly period keys.

create or replace function metrics.enforce_dashboard_serving_period()
returns trigger
language plpgsql
as $$
declare
  pacific_current_month date := date_trunc(
    'month',
    current_timestamp at time zone 'America/Los_Angeles'
  )::date;
begin
  if new.period_start <> date_trunc('month', new.period_start)::date
     or new.period_start < date '2023-01-01'
     or new.period_start > pacific_current_month then
    raise exception 'Period % is outside the approved canonical 2023-current Pacific dashboard serving window', new.period_start
      using errcode = '22023';
  end if;
  return new;
end;
$$;

-- Effective-dated eligibility evidence from the prior Pro Star commissions dashboard.
with roster(employee_id, display_name, effective_start) as (
  values
    (17::bigint,  'Rob Sires'::text,        '2007-08-23'::date),
    (134::bigint, 'Roberto Villalta'::text, '2022-11-21'::date),
    (168::bigint, 'Ernie Hernandez'::text,  '2023-03-08'::date),
    (205::bigint, 'Juan Serrato'::text,     '2023-12-06'::date),
    (209::bigint, 'Justin Molina'::text,    '2024-05-08'::date),
    (216::bigint, 'Jeffrey Perry'::text,    '2025-04-21'::date),
    (251::bigint, 'Erick Eudave'::text,     '2025-09-18'::date),
    (252::bigint, 'Cole Bender'::text,      '2025-10-13'::date),
    (253::bigint, 'Victor Contreras'::text, '2025-11-17'::date)
), inserted as (
  insert into metrics.commission_roster (
    employee_id, display_name, included, tier, effective_start, effective_end, notes
  )
  select r.employee_id, r.display_name, true, 'standard', r.effective_start, null,
         'Eligibility and effective date seeded from the prior Pro Star commissions dashboard EMPLOYEES configuration.'
    from roster r
   where not exists (
     select 1
       from metrics.commission_roster existing
      where existing.employee_id = r.employee_id
        and existing.effective_start = r.effective_start
   )
  returning id, employee_id, display_name, effective_start
)
insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, after_value, reason
)
select 'system:migration-009', 'commission_roster_seeded', 'commission_roster', id::text,
       jsonb_build_object(
         'employeeId', employee_id,
         'displayName', display_name,
         'included', true,
         'effectiveStart', effective_start
       ),
       'Seed effective-dated commission eligibility from the prior commissions dashboard evidence.'
  from inserted;

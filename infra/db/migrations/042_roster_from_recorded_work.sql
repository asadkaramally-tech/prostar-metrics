-- Owner rule (2026-07-16): the technician roster for a month is simply the
-- people who recorded work in that month. The prior position-based definition
-- was not an owner decision and is replaced here.
--
-- The month-scoped membership test lives in the read-model query (a view cannot
-- be parameterised by month); this view is now the person dimension it draws
-- from, retaining position/archived/hire purely as display and capacity
-- evidence.

create schema if not exists metrics;

create or replace view metrics.effective_technician_roster as
select p.person_id,
       p.simpro_employee_id,
       p.display_name,
       p.position,
       p.date_of_hire,
       coalesce(p.archived, false) as archived,
       (coalesce(p.archived, false) = false) as is_field_technician
  from metrics.dim_people p
 where p.simpro_employee_id is not null;

comment on view metrics.effective_technician_roster is
  'Person dimension for technician read models. Roster membership for a month is decided by recorded work in that month (see getEffectiveTechnicianRosterRows), not by position. is_field_technician means the person is not archived; it does not gate membership.';

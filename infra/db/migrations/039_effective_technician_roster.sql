-- Effective technician roster derived from verified Simpro employee evidence
-- already stored in metrics.dim_people (position, archived, date_of_hire).
--
-- This is the owner-facing technician-performance roster. It is intentionally
-- independent of metrics.commission_roster, which is commission ELIGIBILITY
-- evidence from the prior dashboard and is NOT a technician-performance roster
-- (takeover brief section 9, defects 1-3 and 7).
--
-- Verified live Simpro position strings (employees endpoint, 2026-07-15):
--   'Service Technician ' (source value carries a trailing space; 8 employees)
--   'Apprentice'          (1 employee)
-- Matching is therefore trim + case-insensitive. Do not add positions that are
-- not verified in dim_people. If these strings must change, also update
-- FIELD_TECHNICIAN_POSITIONS in src/lib/metrics/technicians.ts.
--
-- Row semantics:
--   * One row per field-position person (including archived people, so that
--     history rows are preserved).
--   * is_field_technician is true only while the person is not archived.
--   * Roster membership for a reporting month is evaluated by consumers as:
--       is_field_technician and (date_of_hire is null or date_of_hire <= month end)
--     Archived field-position people remain visible for a month only when they
--     have verified in-month work, and they accrue zero capacity.
create or replace view metrics.effective_technician_roster as
select p.person_id,
       p.simpro_employee_id,
       p.display_name,
       p.position,
       p.date_of_hire,
       coalesce(p.archived, false) as archived,
       (coalesce(p.archived, false) = false) as is_field_technician
  from metrics.dim_people p
 where p.simpro_employee_id is not null
   and lower(trim(coalesce(p.position, ''))) in ('service technician', 'apprentice');

comment on view metrics.effective_technician_roster is
  'Effective technician-performance roster derived from dim_people position/archived/date_of_hire evidence. Independent of commission_roster (eligibility only). Field positions verified from Simpro on 2026-07-15: Service Technician, Apprentice (trim + case-insensitive match).';
comment on column metrics.effective_technician_roster.is_field_technician is
  'True when the person currently holds a verified field position and is not archived. Month membership additionally requires date_of_hire on or before the month end.';
comment on column metrics.effective_technician_roster.archived is
  'Current Simpro archived state (null in dim_people is treated as not archived). Archived people keep history rows but must accrue zero capacity.';

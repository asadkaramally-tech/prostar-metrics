# Canonical Metrics Table Mapping

Migrations 004-006 are forward-only releases. They do not drop or rename a
production table; key changes preserve existing rows and explicitly mark unknown
legacy section identity as migration-only section `0`.

| Required domain | Canonical authority | Existing duplicate/compatibility | 004-006 action | Contract-release action |
| --- | --- | --- | --- | --- |
| Raw Simpro payloads | metrics.raw_simpro_snapshots | metrics.source_entities_raw | Alter canonical provenance; retain duplicate read-only | Migrate missing provenance, switch all consumers, then retire duplicate |
| Quotes | metrics.metrics_quotes | metrics.quote_snapshots | Add provenance, five-state outcome, display/status fields, relationship fields, tier, and category basis | Switch remaining readers, then retire duplicate |
| Quote cost centers/labor/items | metrics.metrics_quote_cost_centers plus new labor/items tables | embedded quote_snapshots fields | Add normalized facts and widen authority key to quote/section/cost-center | Remove embedded-data dependency |
| Jobs | metrics.metrics_jobs | metrics.job_snapshots | Add provenance, display/status, and converted-from timestamp fields | Switch remaining readers, then retire duplicate |
| Job cost centers/labor/items | metrics.metrics_job_cost_centers plus new labor/items tables | embedded job_snapshots fields | Add normalized facts and widen authority key to job/section/cost-center | Remove embedded-data dependency |
| Employees | metrics.dim_people | metrics.employee_snapshots | Add email, position, and source lifecycle timestamps | Retire duplicate after consumer switch |
| Timesheets | metrics.metrics_employee_timesheets | metrics.timesheet_snapshots | Add provenance/rate reference fields and enforce employee/UID identity | Migrate and retire duplicate |
| Schedules | metrics.metrics_schedules plus metrics.metrics_schedule_blocks | metrics.schedule_snapshots | Alter canonical and add blocks | Migrate and retire duplicate |
| Mobile status | metrics.metrics_mobile_status_logs | metrics.mobile_status_snapshots | Alter canonical provenance | Migrate and retire duplicate |
| Invoices | metrics.invoice_snapshots plus metrics.invoice_job_links | none | Create and add nullable-safe job-link identity | Keep |
| Change feed | metrics.source_change_events | none | Create | Keep |
| Freshness | metrics.metrics_freshness | plan name metrics.source_freshness | Alter canonical; expose compatibility view | Keep canonical table and view |
| Reconciliation | metrics.reconciliation_runs plus metrics.reconciliation_differences | metrics.reconciliation_checks | Create detailed canonical structures; retain legacy checks | Switch readers and retire legacy checks |
| Read models | metrics.dashboard_read_models | metrics.metric_rollups | Keep both for distinct JSON read-model versus scalar rollup roles | Document consumer boundary; do not duplicate same metric authority |
| Commission config | metrics.commission_period_configs | commission_periods.config | Create versioned config; retain legacy JSON | Backfill version 1 and switch writes |
| Commission runs | metrics.commission_calculation_runs plus metrics.commission_run_inputs | run JSON columns | Alter run provenance and create immutable inputs | Populate inputs for supported historical runs |
| Exports | metrics.commission_exports | plan name metrics.report_exports | Alter canonical; expose compatibility view | Keep canonical table and view |
| Audit | metrics.audit_events | plan name metrics.audit_log | Reuse canonical; expose compatibility view | Keep canonical table and view |
| Aggregate Simpro limiter | metrics.simpro_rate_limit_buckets | process-local limiter | Create global fixed-window bucket authority | Keep; process-local limiter is secondary only |

## Deferred Data Movement

Migrations 004-006 create and expand the target structures but intentionally do
not reinterpret ambiguous legacy payloads. WP-03/WP-04 must backfill source facts
through documented Simpro endpoints and verify hashes before legacy snapshot
consumers are retired. No destructive contract migration is permitted until the
previous web and worker revisions are retired.

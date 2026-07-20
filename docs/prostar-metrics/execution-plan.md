# Pro Star Metrics Dashboard - Authoritative Completion and Execution Plan

Revision: 2026-07-13
Status: LOCKED FOR IMPLEMENTATION
Independent review: REQUIRED AGAIN AFTER CURRENT NOT-SHIP FINDINGS ARE CLOSED
Application: Pro Star Metrics Dashboard
Production resource group: prostar-payroll
Production Container App: aca-prostar-metrics-prod
Repository: /Users/asadkaramally/Documents/New project/prostar-metrics-dashboard

This document is the sole implementation authority for completing the Pro Star Metrics Dashboard. It replaces every earlier version of the plan, all stale checklist decisions, and any assumptions inferred from partially implemented code.

The implementation team must not begin or continue work from an older copy of the plan. If current code conflicts with this document, this document controls unless Asad explicitly changes a business decision.

---

## 0. Execution Contract

### 0.1 Authority order

When sources disagree, use this order:

1. Explicit decisions in Section 1 of this document.
2. Metric and feature contracts in Sections 6 and 7.
3. The Simpro Swagger specification and verified read-only production API samples.
4. The prior Quote Activity and Technician Commissions dashboards for operator-facing feature parity, subject only to the exhaustive exclusions in LD-08.
5. Current application code.

Current code is evidence of implementation state, not evidence that a business rule is correct.

### 0.2 Required v1 product surfaces

All four pages are mandatory v1 scope:

1. Quote Metrics
2. Job Metrics
3. Technician Performance
4. Technician Commissions, including the monthly worksheet and monthly/quarterly/annual summary

No agent may defer Job Metrics or Technician Performance, convert them to placeholders, or remove required visualizations without an explicit written decision from Asad.

### 0.3 Meaning of DONE

A requirement is DONE only when all of the following are true:

- production code implements the complete requirement;
- calculations use app-owned production data, not static or generated business data;
- the required unit and integration tests pass;
- the rendered result has been exercised in a browser;
- the result has been reconciled against app-owned snapshots and read-only Simpro samples;
- loading, empty, stale, error, and partial-coverage states are handled;
- desktop and mobile evidence exists for user-facing changes;
- no known defect makes the result misleading;
- the assigned feature ID is updated with evidence.

The implementation baseline in Section 7 and the mutable execution evidence in
`docs/prostar-metrics/feature-status.json` are separate. `npm run plan:sync`
preserves a baseline `VERIFIED DONE` status and preserves later evidence fields;
it must never silently downgrade a verified baseline. Final release acceptance is
certified only by the post-deploy evidence gate defined in WP-11 and Section 9.

Visual presence alone is not completion. A chart with incorrect semantics, hard-coded zeroes, mislabeled coverage, missing history, or placeholder output is NOT DONE.

### 0.4 Allowed execution statuses

During implementation, every feature ID must have exactly one status:

- VERIFIED DONE
- IN PROGRESS
- PARTIAL
- NOT STARTED
- TECHNICALLY BLOCKED
- DEFERRED BY ASAD
- REMOVED BY OWNER DECISION

TECHNICALLY BLOCKED requires evidence of the failed investigation and cannot be used for a question an agent can answer from the repository, Swagger, Azure, or read-only Simpro access.

### 0.5 No silent scope changes

Agents may not:

- delete or defer a listed feature;
- reinterpret a metric to fit currently available data;
- replace a required metric with a coverage percentage while keeping the original label;
- invent an unresolved business blocker when the answer is discoverable technically;
- use job Status to determine completion;
- treat DateApproved as proof a quote was accepted;
- reintroduce a quote owner field;
- expose salesperson as a metric, dimension, filter, label, or quote-owner substitute;
- make efficiency informational-only;
- add the prior active/pending dispatch dashboard;
- mark a phase complete with PARTIAL, NOT STARTED, or unverified requirements.

---

## 1. Locked Decisions

These are final implementation decisions, not open questions.

### LD-01 - Four pages remain v1

Quote Metrics, Job Metrics, Technician Performance, and Technician Commissions are all required for release.

### LD-02 - App-owned serving data

The application must use its own Azure Database for PostgreSQL Flexible Server, app-owned snapshots, and app-owned rollups. It must not depend on any preexisting Supabase table, mirror, view, cache, edge function, or sync.

Prohibited runtime dependencies include the old Supabase project, legacy v_* views, old simpro_* mirror tables, quote_data, ops_commissions, ops_commission_cache, and simpro-sync.

### LD-03 - No request-time Simpro fan-out

Dashboard page and API requests query app-owned snapshots and rollups. Simpro requests occur only in bounded background ingestion, reconciliation, authorized narrow refreshes, and narrow record drilldowns.

Changing a month, technician, category, tier, or other filter must never trigger a broad Simpro pull.

### LD-04 - Completed-job rule

A job is complete only when:

- CompletedDate falls within the selected reporting period; and
- Simpro Stage is exactly Complete or Archived, compared case-insensitively.

Job Status must not be used to determine completion.

Stage Invoiced is not complete for this dashboard.

### LD-05 - Quote activity and acceptance rules

DateApproved determines the Quote Metrics activity month. DateApproved by itself is not evidence that a quote was accepted.

A non-excluded quote is Accepted only when at least one of these is true:

- its verified Simpro source value is Accepted Online;
- its `LinkedJobID` identifies an exact live Simpro job;
- a live Simpro job has an exact `ConvertedFrom.Type = Quote` and `ConvertedFrom.ID` relationship to it.

Every other active non-excluded quote is Not Accepted. Numeric or descriptive `JobNo` equality is never evidence. Quote Stage, CustomerStage, Status values other than the verified Accepted Online value, DateApproved, names, customers, and sites never determine acceptance. Audited manual overrides may exclude or reinstate a quote, but may not manufacture acceptance.

### LD-06 - No quote owner

There is no quote owner field in Simpro for this product. Do not display, filter, ingest, or require quote owner. Simpro salesperson fields may remain only inside immutable raw source payloads as unused provenance; they must not be normalized into a serving dimension or displayed, filtered, labeled, or substituted for quote owner.

### LD-07 - Efficiency is functional

The commission efficiency adjustment is a real calculation input when enabled. It changes final technician allocation and every payroll/export output derived from the run.

It must have persisted controls, bounded adjustment, calculation tests, audit history, coverage disclosure, and immutable-run evidence. It must not be presented as a nonfunctional simulation.

### LD-08 - Prior-dashboard carry-forward boundary

All operator-facing features and visualizations in the prior Quote Activity dashboard and the Technician Commissions monthly and Summary views are mandatory unless explicitly excluded below. Omission from Section 7 is a plan defect and does not remove a prior feature from scope.

Do not carry forward unrelated components from the old Pro Star Dashboard. The following exclusions are exhaustive:

- quote owner or salesperson metrics, labels, dimensions, and filters;
- open-quote/open-pipeline cohorts or visualizations;
- Quote Stage or CustomerStage-derived outcomes, labels, and filters;
- manual Accepted/Not Accepted overrides; manual exclusion/reinstatement remains required;
- pending-jobs KPIs;
- active/pending job filters or tables;
- dispatch queue UI;
- weekly technician dispatch timeline;
- the old active-job detail modal.

### LD-09 - Initial access

Initial authenticated users are:

- Asad - Owner/Admin and Finance
- Laila - Owner/Admin and Finance

Server-side authorization is required. A complex organization-wide role hierarchy is not required for initial release.

### LD-10 - No fake or misleading output

Do not ship demo business data, hard-coded metrics, generated history, placeholder values presented as real, or mislabeled coverage metrics.

When coverage is incomplete, show the real value that can be supported and explicitly disclose the numerator, denominator, source window, and reason for missing coverage.

### LD-11 - Material accuracy

Material accuracy remains coverage-only until quoted and actual material values are proven to share the same cost or sell basis. Do not fabricate a savings or accuracy percentage.

### LD-12 - Technical mapping work is not a user blocker

Endpoint paths, field mappings, pagination behavior, stage samples, schedule/mobile semantics, and nested-resource traversal must be resolved by inspecting Swagger, current source payloads, and read-only Simpro samples. Do not push those questions back to Asad unless contradictory business behavior remains after technical evidence is collected.

### LD-13 - Time, money, and boundary standards

- Business timezone is America/Los_Angeles.
- Store source timestamps in UTC and convert to business timezone before assigning a reporting date.
- Monthly periods use an inclusive local start and exclusive next-month start.
- Cross-midnight events retain UTC timestamps and are grouped by the applicable local business date defined by the metric.
- Currency is USD.
- Persist source money at database decimal precision and round only at presentation, except commission payouts which use the deterministic cent-allocation rule in Section 6.4.
- Financial comparisons use the validated ex-tax sell-value basis.
- Quote tiers are Under $750 for values below 750; $750-$2K for values from 750 inclusive to 2,000 exclusive; $2K-$10K for values from 2,000 inclusive to 10,000 exclusive; and $10K+ for values at or above 10,000.

### LD-14 - Callback scope

Callback metrics are excluded from v1. Do not add or infer callback performance unless Asad explicitly reopens that scope.

---

## 2. Audited Baseline

This baseline records the verified state as of 2026-07-09. Agents must use it to avoid redoing completed work and to avoid mistaking partial implementations for finished features.

### 2.1 Production user experience

The real production page was opened in Chrome using the authenticated Pro Star session.

Observed flow:

1. Microsoft Entra sign-in completes successfully.
2. Azure EasyAuth records LoginComplete with an authenticated Pro Star identity.
3. EasyAuth forwards the authenticated request to http://127.0.0.1:3000.
4. The connection is refused.
5. The user receives HTTP 500 instead of the dashboard.

Root cause:

- Dockerfile sets PORT=3000 but does not set HOSTNAME=0.0.0.0.
- Next.js starts on the replica hostname rather than an address EasyAuth can reach through loopback.
- The Container App has no HOSTNAME environment override.

Production access is therefore P0 BLOCKED even though authentication itself is configured.

### 2.2 Local verification already passing

- npm run test: 33 of 33 tests passed.
- npm run lint: passed.
- npm run guard:no-mirror: passed.
- npm run build: passed.
- npm audit --omit=dev: zero known production dependency vulnerabilities.

These tests are not sufficient release evidence. The suite lacks production-auth, end-to-end, ingestion integration, reconciliation, lifecycle, and export-layout coverage. At least one current unit test enforces the incorrect DateApproved-equals-Accepted behavior and must be replaced.

### 2.3 Verified production data samples

June 2026:

- quotes in DateApproved cohort: 189;
- quote value: $2,153,285.12;
- currently displayed quote wins: 189 and 100 percent, which is invalid under LD-05;
- completed jobs: 271;
- completed stages: 265 Archived and 6 Complete;
- completed-job sell value: $400,697.61;
- gross profit: $276,568.07;
- gross margin: approximately 69.38 percent;
- quote-source labor cohort: 84 jobs;
- labor-included cohort: 72 jobs;
- technician allocation: 10 technicians and approximately 1,063 job hours;
- mobile-status coverage: 196 of 271 completed jobs;
- commission pool: approximately $2,003.49.

Historical coverage:

- 2,416 quote snapshots exist.
- quote DateIssued coverage begins 2025-03-31, not 2023-01-01;
- quote DateApproved history entirely omits March and April 2026;
- all 2,416 normalized quotes have zero linked-job IDs;
- completed-job coverage begins 2026-01-16;
- timesheet coverage begins 2026-03-02;
- the required 2023-current backfill is not complete.

Current-period integrity:

- July job reconciliation observed $183,872.76 upstream versus $0 in the app rollup;
- the UI still reported Data current;
- jobs, technicians, and commissions can therefore show false-green freshness.

Queue health:

- current July jobs have long-lived continuation work;
- one July job scan reached page 54, used roughly 1,298 requests across repeated attempts, and remained queued;
- employees, timesheets, jobs-from-timesheets, schedules, mobile status, and rollup jobs are not all scheduled at the required cadence.

### 2.4 Existing implementation that must be reused

The following foundations exist and should be corrected or extended, not rewritten without cause:

- Next.js App Router and TypeScript application shell;
- four dashboard routes and responsive visual system;
- Azure PostgreSQL migrations and normalized/read-model tables;
- Simpro HTTP client with pagination, retry, request budgets, and rate limiting;
- ingestion queue, locks, continuation state, and rollup rebuild concepts;
- Entra EasyAuth integration and server-side role checks;
- no-mirror guard;
- completed-job Stage helper already restricted to Complete and Archived;
- timesheet-share job and sell-value allocation;
- commission pool, tier, forfeiture, redistribution, and immutable run structures;
- bounded efficiency multiplier in current commission math;
- private Blob export persistence and audited download metadata;
- payroll CSV, calculation-detail CSV, and a minimal PDF generator.

### 2.5 Known implementation defects

P0:

- authenticated production page returns HTTP 500 due to host binding;
- quote acceptance logic is invalid;
- quote/job nested and cross-reference ingestion is incomplete;
- backfill and freshness state are not trustworthy.

P1:

- commission overrides lose field semantics and can alter the wrong value;
- category sell values are hard-coded to zero;
- technician on-time is actually global mobile coverage;
- technician names are not rendered;
- utilization is missing;
- commission lifecycle and full summary are missing;
- production schedules are far below the required cadence.

P2:

- PDF worksheet is not a usable payroll review artifact;
- filters and record-level drilldowns are incomplete;
- database network, backup, retention, monitoring, and restore controls do not meet this plan;
- browser and integration tests are insufficient.

---

## 3. Target Architecture

### 3.1 Runtime flow

Simpro is the upstream system of record. Azure PostgreSQL is the dashboard serving store.

Data flow:

1. Scheduled or manual ingestion creates bounded app-owned queue jobs.
2. Workers call documented Simpro endpoints under the shared rate limiter.
3. Raw payloads, hashes, source windows, and watermarks are persisted.
4. Typed normalized tables are upserted idempotently.
5. Changed source hashes invalidate only affected periods and dimensions.
6. Rollup jobs rebuild affected read models.
7. Reconciliation compares upstream samples, normalized snapshots, and rollups.
8. Dashboard routes query PostgreSQL only.
9. User selections query existing snapshots/rollups and never launch broad synchronous Simpro work.

### 3.2 Required environments

- development database and app;
- production database and app;
- production deployments through a new Container App revision;
- forward-only schema migrations;
- rollback through prior application revision plus documented migration mitigation.

### 3.3 Server boundaries

Browser:

- sends authenticated page/API requests;
- never receives database credentials or Simpro credentials;
- never connects directly to PostgreSQL, Blob Storage, or Simpro.

Web application:

- enforces access server-side;
- reads snapshots and rollups;
- writes only app-owned overrides, lifecycle actions, audit entries, and authorized queue requests;
- streams authorized exports.

Workers:

- own Simpro reads, normalization, backfill, reconciliation, and rollup rebuilds;
- never bypass request budgets or rate limits.

### 3.4 No broad live fallback

If a rollup is missing:

- use a bounded PostgreSQL aggregation when snapshots are complete enough; or
- enqueue a rollup rebuild and show Building with last-good data.

Do not fall back to a broad live Simpro request from a dashboard route.

---

## 4. Simpro Data Contract

The vendored docs/prostar-metrics/reference/simpro-swagger.json copy, hashed from /Users/asadkaramally/Downloads/swagger.json during WP-00, is the reproducible endpoint contract. Live read-only samples verify tenant-specific shapes and semantics.

### 4.1 Required endpoint families

Quotes:

- quote list and detail;
- quote sections;
- section cost centers;
- labor, catalog, service-fee, one-off, stock, and other documented cost-center item collections needed to calculate labor/category values;
- linked/converted job references where documented.

Jobs:

- job list and detail;
- job sections;
- section cost centers;
- labor, catalog, service-fee, one-off, stock, and other documented nested collections;
- work orders where required for schedule or actual-duration context;
- converted-from quote relationship;

People and time:

- employees;
- all employee timesheets, including job and non-job categories needed for utilization;
- schedules for candidate jobs/quotes;
- mobile-status logs and detail.

Change feeds:

- quote logs;
- job logs;
- schedule logs;
- mobile-status logs;

The Swagger routes for /logs/quotes/, /logs/jobs/, /logs/schedules/, and /logs/mobileStatus/ are the primary incremental candidate feeds when live contract verification succeeds.

### 4.2 Endpoint implementation rule

Do not assume display=all embeds documented nested resources. The client must implement explicit typed wrappers for required nested routes.

For every required field, the data dictionary must record:

- endpoint and HTTP method;
- JSON field path;
- source type and nullable behavior;
- normalization rule;
- source hash coverage;
- sample quote/job/employee ID used for verification;
- fallback path, if documented;
- metric families invalidated when the field changes.

### 4.3 Client behavior

All endpoint wrappers must support:

- page and pageSize;
- deterministic ordering where supported;
- columns and filters where supported;
- typed response parsing;
- bounded request budget;
- shared cap of five requests per second or lower during nested traversal;
- exponential backoff with jitter for 429 and transient 5xx;
- no blind retry of permanent 4xx;
- continuation cursor persistence;
- request and page telemetry without secret logging;
- payload hash and fetched timestamp.

The rate limit is aggregate across every web-triggered manual run and Container App worker. Implement a PostgreSQL-backed distributed token bucket, or route all Simpro execution through one exclusive dispatcher. A process-local limiter is insufficient; measured aggregate throughput may never exceed five requests per second.

### 4.4 Candidate discovery

Primary incremental discovery uses monotonically persisted log high-water marks composed of DateLogged plus log ID:

- poll with a two-hour overlap;
- deduplicate by source log ID and payload hash;
- advance the durable high-water mark only after every page through the observed boundary commits;
- detect non-monotonic ordering, missing pages, and cursor gaps;
- enqueue affected quote/job/schedule IDs for detail refresh;
- fall back to deterministic list scans when a log family is unavailable or fails contract verification.

Deterministic list scans remain required for reconciliation, deletion detection, and gap repair. Where reliable modified timestamps or logs do not exist:

- use deterministic paged scans;
- store list-row hashes;
- enqueue detail work only for new IDs, changed hashes, linked IDs, manual targets, or reconciliation samples;
- save continuation state before the request budget is exhausted;
- prevent duplicate jobs with idempotency keys.

Date filters must be verified against live response samples. A filter that is accepted syntactically but ignored is a failed implementation.

For every normalized update, compare the prior and new state transactionally. Invalidate the union of old and new periods and dimensions when DateApproved, CompletedDate, technician allocation, category, exact conversion evidence, total, or job Stage changes. Quote Stage, CustomerStage, and salesperson provenance do not invalidate serving outcomes because they are not serving dimensions or acceptance evidence. Tombstone deleted parents and removed nested children only after a complete authoritative traversal. Propagate invalidation through linked quote/job, technician, and commission periods.

### 4.5 Backfill

Required initial window: 2023-01-01 through current date.

Backfill includes:

- quote list/detail, nested cost centers, classification fields, linked jobs, and old manual-exception candidates;
- completed jobs, converted-from relationships, Totals fields, nested cost centers, and labor;
- employees and aliases;
- all employee timesheets needed for job allocation and utilization;
- schedule records required for historical technician comparisons;
- commission source inputs, but not reconstructed immutable payout runs before WP-08 passes;
- best-effort mobile history using a bounded resumable traversal.

Include every quote in the required DateApproved window and every exact live job referenced by an in-window quote, even when the job's own reporting date falls outside the window. No separate open-quote traversal exists.

Backfill must be:

- resumable;
- idempotent;
- low-concurrency;
- safe to stop and resume;
- visible through queue progress;
- reconciled month by month before a period is marked complete.

No period may be marked backfilled solely because some rows exist.

Before execution, WP-04 must produce a source/month capacity ledger containing expected pages and records, estimated nested requests, daily request ceiling, queue priority, retry count, actual requests, normalized coverage, and reconciliation result. Current ingestion receives at least 60 percent of available request capacity, reconciliation 15 percent, and backfill at most 25 percent. Backfill must average no more than one Simpro request per second and must yield whenever a current-source queue approaches its freshness SLA.

### 4.6 Required cadence

| Source or operation | Cadence |
| --- | --- |
| Quote/job/schedule/mobile change logs | Every 15 minutes with two-hour overlap |
| Quote list reconciliation | Every 6 hours for current month plus trailing 90 days; nightly trailing 24 months in batches |
| Quote detail and nested data | Every 30 minutes for new/hash-changed candidates |
| Job list reconciliation | Every 6 hours for current month plus trailing 90 days and linked candidates; nightly trailing 24 months |
| Job detail and nested data | Every 60 minutes for new/hash-changed candidates |
| Employees | Daily at 2:00 AM Pacific and on missing-ID demand |
| Timesheets | Every 60 minutes, current month plus trailing 60 days |
| Schedules | Every 60 minutes for bounded candidate jobs/quotes |
| Mobile status | Every 15 minutes from a stable high-water mark |
| Commission rebuild | Nightly at 3:00 AM Pacific after source ingestion, plus authorized manual rebuild |
| Trailing 24-month reconciliation | Nightly in bounded batches |
| Older stable history | Monthly after two unchanged successful reconciliations |

One worker is acceptable initially. Each worker execution runs for at most 20 minutes or 1,000 Simpro requests, whichever occurs first. Each queue item uses at most 250 requests before saving continuation state. Locks expire after 10 minutes unless heartbeated every 60 seconds. Transient work receives at most five attempts before dead-letter status and alerting. A scheduled run drains work until its runtime/request limit rather than processing one row and exiting. Oldest queue age must remain below the applicable freshness SLA.

### 4.7 Freshness semantics

Freshness is complete-window state, not last-successful-request state.

A metric family is current only when:

- all required source jobs for the declared source window succeeded;
- no required continuation remains queued or running for that window;
- the normalized maximum source date reaches the declared watermark;
- impacted rollups completed after the last source change;
- reconciliation has no unacknowledged material drift;
- required core coverage meets the matrix below; incomplete secondary coverage is explicitly marked partial.

SLA:

- Quote Metrics stale after 60 minutes.
- Job Metrics stale after 2 hours.
- Timesheets stale after 2 hours.
- Technician schedule/timesheet metrics stale after 2 hours.
- Forward-polled mobile metrics stale after 30 minutes.
- Commissions stale after 24 hours or any source change after the latest run.
- Trailing 24-month history stale after 48 hours without reconciliation.

| Metric family | Required source state for core result | Partial coverage allowed | Maximum age |
| --- | --- | --- | --- |
| Quote core | Complete quote candidate window, detail rows, classification relationship checks, and rollup | Category/nested segmentation may be partial but must show exact coverage | 60 minutes |
| Job core | Complete completed-job candidate window, detail/Totals rows, and rollup | Labor, category, and material panels may be partial independently | 2 hours |
| Technician allocation | Complete completed-job facts and timesheet traversal; all employee IDs mapped or disclosed | Schedule/mobile and quote-labor panels may be partial | 2 hours |
| Mobile/on-time | Complete forward log window through high-water mark | Historical and event-pair coverage may be partial | 30 minutes |
| Commission exportable run | Complete jobs, details, timesheets, roster mapping, config, overrides, and source hashes | No missing core source is allowed for payroll export | 24 hours and no later source change |

Any core source coverage below 100 percent produces PARTIAL or BUILDING, never CURRENT. Secondary panels calculate from supported rows and display exact numerator/denominator rather than suppressing the page.

Status precedence is:

1. FAILED when required work is dead-lettered or the latest required run failed with no later success.
2. SUSPECT when reconciliation count drift is nonzero or money drift exceeds one cent.
3. STALE when a required watermark exceeds maximum age.
4. BUILDING when required initial/refresh work is incomplete but still within SLA.
5. PARTIAL when core sources are complete but a supported secondary metric has less than 100 percent coverage.
6. CURRENT only when none of the preceding conditions applies.

The UI must show:

- data-through timestamp;
- covered source window;
- source families contributing;
- queue state when building;
- last reconciliation result;
- partial-coverage warning;
- last-good data when a refresh fails.

The page-level badge uses the highest-precedence status among required panels. Each secondary panel retains its own coverage/status so one partial schedule, category, or labor source does not hide otherwise valid core KPIs.

### 4.8 Reconciliation

For each sampled period:

1. Query the upstream Simpro cohort using verified filters or deterministic list traversal.
2. Compare IDs, counts, and money totals to normalized snapshots.
3. Compare normalized snapshots to rollups.
4. Record absolute and percentage drift.
5. Mark affected rollups suspect when drift exceeds tolerance.
6. Enqueue bounded repair/rebuild work.
7. Alert after repeated or material drift.

Money reconciliation tolerance is one cent after documented rounding. Count tolerance is zero. Coverage differences must identify the exact excluded IDs and reason. Automated count and money reconciliation must pass for every month from January 2023 through the current month; representative record samples supplement but never replace the all-month check.

---

## 5. App-Owned Storage Contract

Existing migrations must be diffed against this minimum contract. Extend through forward-only migrations; do not destructively recreate production tables.

### 5.1 Source and queue tables

- raw_simpro_snapshots
- source_change_events
- ingestion_jobs
- ingestion_runs
- ingestion_watermarks
- source_freshness
- reconciliation_runs
- reconciliation_differences
- rollup_rebuild_queue
- metric_rollups

Required queue fields include entity, operation, source window, page/cursor, request budget, attempts, priority, lock owner, lock expiry, idempotency key, status, error summary, and timestamps.

### 5.2 Normalized dimensions and facts

- dim_people
- metrics_quotes
- metrics_quote_cost_centers
- metrics_quote_labor
- metrics_jobs
- metrics_job_cost_centers
- metrics_job_labor
- employee_snapshots
- timesheet_snapshots
- schedule_snapshots
- mobile_status_snapshots

dim_people must preserve Simpro employee ID, display name, active state, role type, aliases, and first/last seen timestamps. Historical inactive people remain selectable.

### 5.3 Quote exclusion override tables

quote_classification_overrides must store:

- quote ID;
- action: exclude or reinstate;
- previous exclusion state and reason;
- new exclusion state and reason;
- evidence/reference;
- effective revision;
- actor email;
- created timestamp;
- superseded timestamp where applicable.

Overrides are append-only revisions. Editing creates a new row and preserves history. No override may set Accepted or Not Accepted; the locked evidence rule determines that partition after active exclusions are removed.

Quote override writes require an idempotency key, expected latest revision, and actor identity from the verified EasyAuth principal. A stale expected revision returns HTTP 409. The override row, audit entry, and rollup-rebuild enqueue commit in one transaction.

### 5.4 Commission tables

- commission_roster with effective dates, inclusion, and notes;
- commission_periods;
- commission_period_configs;
- commission_overrides;
- commission_calculation_runs;
- commission_run_inputs;
- commission_employee_results;
- commission_job_allocations;
- report_exports;
- audit_log.

Every calculation-affecting config and override must be reconstructable for a historical run.

commission_run_inputs is an immutable seven-year manifest of the exact normalized source row versions and calculation inputs consumed by a run, including job, timesheet, roster, config, override, quote-labor, and field-basis values. A hash alone is not sufficient once mutable source tables or 18-month raw payloads change.

Commission period/config/override tables require revision numbers and optimistic-concurrency constraints. Calculation runs require run status, immutable input-manifest hash, source hash, config hash, override hash, and unique period/revision identity. Exports require idempotency key and a unique run/type/content-hash constraint so retries cannot create inconsistent duplicate artifacts.

### 5.5 Retention

- raw source payloads: minimum 18 months;
- normalized and rollup history: minimum seven years where used for financial reporting;
- overrides, audit history, calculation runs, and exports: minimum seven years;
- commission_run_inputs: minimum seven years;
- exports in private Blob Storage with lifecycle policy matching retention.

---

## 6. Metric Contracts

### 6.1 Quote Metrics

#### Activity cohort

Include active quotes whose DateApproved is within the selected period unless the latest audited override marks the quote excluded.

DateApproved is the reporting-date basis only. It does not set Accepted.

#### Outcome classification precedence

1. Latest active manual exclusion removes the quote from the cohort; reinstatement restores source-derived classification.
2. Accepted Online from the exact verified Simpro source value.
3. Exact quote `LinkedJobID` relationship to a live Simpro job.
4. Exact live job `ConvertedFrom.Type = Quote` and `ConvertedFrom.ID` relationship to the quote.
5. Not Accepted for every other active non-excluded quote, including every numeric or descriptive `JobNo` equality.

Persist exactly one serving outcome: won, lost, or excluded. `won` is displayed as
Accepted and `lost` is displayed as Not Accepted. Those internal values implement a
two-way operator partition plus exclusion; they do not restore a separate Lost or
Open operator cohort. Quote Stage and CustomerStage are raw provenance only. Status
is raw provenance except for the exact verified Accepted Online value.

Store reason codes such as:

- manual_excluded;
- manual_reinstated;
- accepted_online;
- linked_job;
- converted_job;
- not_accepted_no_evidence.

#### Quote formulas

- Quotes sent/activity = count of non-excluded cohort quotes.
- Quote value = sum of cohort quote total.
- Quotes Accepted = count where classification is won/Accepted.
- Accepted value = sum of quote total where classification is won/Accepted.
- Activity count = Accepted count + Not Accepted count, which equals all non-excluded cohort quotes.
- Activity value = Accepted value + Not Accepted value, which equals all non-excluded cohort value.
- Acceptance rate by count = Accepted count / activity count.
- Acceptance rate by value = Accepted value / activity value.
- Average accepted deal size = Accepted value / Accepted count.

All zero denominators render N/A, not zero percent.

#### Q-22 removed open-quote cohort

Removed by owner decision. The tenant does not have a canonical open outcome for
this dashboard. A quote without accepted-online or exact conversion evidence is
Not Accepted; do not infer an open pipeline from Stage or Status. Follow-up analysis
uses only the locked Accepted/Not Accepted partition and does not expose owner,
salesperson, Stage, or CustomerStage.

#### Historical and rolling windows

- If the selected month is complete, trailing 12 includes that month plus the preceding 11 complete months.
- If the selected month is partial/current, stable trailing 12 excludes it and uses the preceding 12 complete months.
- Three- and 12-month acceptance rates are aggregate ratios: sum(Accepted) divided by sum(activity), not averages of monthly percentages.
- Same-day YoY compares local calendar days 1 through the selected as-of day in both years; the prior-year full-month value is shown separately.
- Category mapping comes from persisted cost-center classification rules: Water Heating, HVAC, and Unclassified. Do not infer category from customer or free-text notes.

#### Historical exceptions from prior dashboard

The old reviewed set must be reconciled against the locked source-backed rule:

- 31 PM/maintenance classifications previously reviewed as accepted are acceptance candidates only; they become Accepted only when current exact source evidence supports them;
- confirmed Not Accepted records Q796, Q797, and Q602 remain Not Accepted under the default rule and do not require an override;
- five test/blank records previously excluded become audited exclusion records after exact ID matching.

Before inserting exclusions or recording reconciliation evidence, match legacy quote numbers to exact current Simpro quote IDs. Do not hard-code acceptance outcomes in calculation code.

### 6.2 Job Metrics

#### Completed cohort

Include a job only when:

- CompletedDate is in the selected period; and
- lower(Stage) is complete or archived.

Ignore Job Status for completion. A job whose Stage is Invoiced is excluded even when Job Status suggests completion.

#### Financial metrics

- Completed jobs = count of completed cohort.
- Total sell value = sum of the validated Simpro job Total/Totals sell-value field.
- Average job value = total sell value / completed jobs.
- Gross profit = sum of Simpro Totals GrossProfit Actual where present.
- Gross margin = sum gross profit / sum sell value across rows with supported gross-profit and sell-value fields.

Record field-path basis and missing coverage. Do not mix incompatible tax or cost bases.

#### Labor

Quote-sourced jobs only for quoted-vs-actual comparison.

- Quoted hours = sum of documented nested quote/job labor quantities on the source quote/job.
- Actual hours = sum of all employee timesheets referencing each completed-cohort job, regardless of the timesheet's own month.
- Variance hours = actual minus quoted.
- Variance percent = variance hours / quoted hours.
- Labor overrun = max(actual minus quoted, 0).

Aggregate variance percent is (sum actual hours - sum quoted hours) / sum quoted hours across included jobs. Do not average job-level percentages. The UI must call this Labor Hours Variance or Quoted vs Actual Labor. It must not call raw variance an accuracy score.

Show:

- quote-sourced jobs;
- jobs with quoted hours;
- jobs with actual hours;
- jobs included;
- jobs excluded by reason.

#### Category and cost center

Category job count, sell value, gross profit, gross margin, quoted hours, and actual hours must be aggregated from persisted nested cost-center rows. Hard-coded zero values are prohibited.

- Category value is additive cost-center contribution.
- Category job count is distinct jobs with a contribution and is labeled non-additive because one job may span categories.
- A separate primary-category count assigns each job to the category with the largest persisted sell contribution, breaking ties by category name.
- Any difference between job total and cost-center sell total appears as Unallocated rather than being silently discarded.

Owner scope decision, July 10, 2026: Pro Star does not perform invoicing in Simpro. Job Metrics must not calculate or display invoice value, payment, aging, invoice-lag, or unbilled metrics from Simpro. Invoicing is not a freshness, reconciliation, backfill, or release dependency for this dashboard.

### 6.3 Technician Performance

#### Attribution

For each completed job:

- total supported job hours = sum of mapped employee timesheet hours;
- employee share = employee job hours / total supported job hours;
- employee completed-job credit = share;
- employee allocated sell value = job sell value multiplied by share;
- employee allocated gross profit = job gross profit multiplied by share where supported.

Jobs without mapped timesheets are excluded from technician allocation and disclosed.

#### Utilization

- Productive hours = timesheet hours assigned to supported jobs.
- Total recorded hours = all employee timesheet hours for the selected period, including non-job categories.
- Utilization = productive hours / total recorded hours.

Do not use job hours as both numerator and denominator. Show non-job-hour coverage and unmapped categories.

Utilization uses timesheets whose own work date falls in the selected month. Completed-job credit, sell allocation, and completed-job labor use the completed-job cohort and all timesheets belonging to those jobs. These are intentionally different cohorts and must be labeled.

#### Labor efficiency

For quote-sourced jobs:

- quoted hours are allocated to technicians by actual job-hour share;
- actual hours are technician job timesheet hours;
- efficiency ratio = allocated quoted hours / actual hours;
- display ratio, quoted hours, actual hours, included jobs, and coverage.

#### Planned versus actual and on-time

- Planned start/end come from persisted schedule records.
- Actual arrival uses the first verified on-site mobile-status event.
- Actual completion uses the verified completion/departure event when available.
- Arrival variance minutes = actual arrival minus planned start.
- Duration variance minutes = actual duration minus planned duration.
- On-time means arrival no later than 15 minutes after planned start; the threshold is persisted configuration.

Before calculating, verify mobile event semantics using production samples. Missing events produce uncovered rows, not late rows.

On-time rate is calculated per technician from that technician's covered scheduled visits. A global mobile-coverage ratio must never be labeled on-time.

Matching rules:

- match by employee plus job/work-order identity before using time proximity;
- treat each non-cancelled schedule block as one planned visit;
- when several candidate blocks remain, choose the nearest planned start within 12 hours before through 24 hours after and enforce one-to-one matching;
- use the earliest valid on-site event after the preceding visit boundary and the first valid completion/departure event after arrival;
- deduplicate identical source-log IDs and timestamps;
- preserve UTC ordering before local-time display;
- allow visits to cross midnight;
- exclude cancelled schedule blocks from the denominator;
- retain unmatched schedule blocks and unmatched mobile events as separate coverage counts.

### 6.4 Technician Commissions

#### Source cohort

Use jobs in the completed cohort from Section 6.2 and mapped field-technician timesheets. Eligibility comes from effective-dated commission_roster rows. The roster stores eligibility and notes, not permanent Gold/Silver/Bronze rank tiers.

Total commission work value includes every positive-sell-value job in the completed cohort, matching the prior dashboard. A job without supported technician hours remains in total work value and the pool basis but appears in excluded-job coverage. Only eligible mapped technicians participate in payout weights. Work allocated to an ineligible technician remains disclosed but is redistributed through the eligible weighting rather than reducing the pool.

An official historical run may be created only where effective-dated roster and period config evidence exists. Source facts may be backfilled to 2023, but payout history must never be reconstructed from present-day roster/config defaults. Unsupported historical periods display Unavailable and the missing evidence.

#### Base calculation order

Period defaults and control bounds:

- pool_pct default 0.50 percent; selectable from 0.25 through 1.00 percent in 0.05-point increments;
- min_bonus_pct default 5.00 percent of average eligible pre-forfeiture bonus;
- efficiency enabled state is persisted;
- max efficiency adjustment default 20 percent; selectable from 5 through 50 percent in one-point increments;
- changing these defaults requires a new locked decision.

Normative calculation:

1. Validate a complete immutable source manifest for jobs, details, timesheets, roster, config, overrides, and source watermarks.
2. Calculate total work value from the full completed cohort.
3. For each job with mapped hours, allocate sell value across all mapped technicians by technician job hours / total mapped job hours.
4. Apply effective-dated inclusion. Keep excluded allocation in coverage but remove excluded technicians from eligible weights.
5. Apply nonnegative allocated_value overrides to relative payout basis only. They do not change total work value or pool.
6. Pool = total completed-cohort work value multiplied by pool_pct / 100.
7. Rank eligible technicians by effective allocated value descending, breaking ties by employee ID ascending.
8. Derive rank tier for the run: rank 1 Gold 1.30, rank 2 Silver 1.20, rank 3 Bronze 1.10, all others Standard 1.00. A typed period/employee tier override may replace the derived tier.
9. Base share = effective allocated value / total eligible effective allocated value multiplied by pool.
10. Multiply base shares by tier multipliers and normalize to the pool.
11. Threshold = average eligible normalized bonus multiplied by min_bonus_pct / 100. Set below-threshold bonuses to zero and redistribute their forfeited amount pro-rata by remaining normalized bonus. If no eligible technician remains, waive forfeiture and retain pre-threshold bonuses.
12. When efficiency is enabled, multiply post-forfeiture bonuses by the efficiency multiplier and normalize back to the same inside-pool total.
13. Apply final_bonus locks and inside-pool adjustments under the override rules below, redistributing the remaining pool across unlocked eligible technicians.
14. Apply outside-pool adjustments after the inside-pool total is final.
15. Allocate integer cents using the deterministic largest-remainder rule and persist immutable results/job allocations.

If there is no eligible technician or total eligible effective allocated value is zero, fail the calculation run and prohibit export. Do not create a zero-payout successful run.

#### Efficiency

- technician ratio = sum allocated quoted hours / sum actual hours across that technician's qualifying quote-sourced jobs;
- qualifying jobs require positive quoted hours and positive actual hours;
- maximum adjustment uses the persisted period value;
- ratio at or below 0.50 maps to 1 - max adjustment;
- ratio at or above 1.50 maps to 1 + max adjustment;
- ratios between 0.50 and 1.50 interpolate linearly, with ratio 1.00 mapping to multiplier 1.00;
- employees without qualifying coverage receive multiplier 1.00;
- enabled state, max adjustment, coverage, multiplier, and effect are stored in the run config/results;
- when enabled, the multiplier changes displayed and exported final bonuses.

#### Override semantics

Override precedence is inclusion, allocated value, tier, base/tier/threshold/efficiency calculation, final-bonus/inside-pool changes, outside-pool adjustment, then notes.

Each field has explicit behavior:

- included: eligibility is applied after all-technician job allocation; exclusion does not alter job hours, shares, total work value, or pool and only removes that technician's allocation from payout weights;
- allocated_value: replace nonnegative relative allocation basis and recalculate weights without changing pool;
- tier: replace derived tier for the period run;
- inside_pool_adjustment: add/subtract from an unlocked technician, floor at zero, and redistribute the inverse amount among other unlocked eligible technicians;
- outside_pool_adjustment: add/subtract after pool allocation and change payroll total; final payroll amount may not be negative;
- final_bonus: lock a nonnegative technician inside-pool amount and redistribute the remaining pool among unlocked eligible technicians;
- notes: informational only and never parsed as numeric.

An active final_bonus override and inside_pool_adjustment for the same technician/revision are mutually exclusive and return conflict. If locked final bonuses exceed the pool, fail with conflict and do not create a run. Negative allocated value, negative final bonus, non-finite values, and unknown tiers are rejected.

If an inside-pool change cannot be absorbed by at least one other unlocked eligible technician without producing a negative bonus, reject the change with conflict rather than changing the pool.

Every override requires reason, actor from the verified EasyAuth principal, timestamp, before/after value, field type, pool treatment, and expected period revision. Rebuilds reapply typed overrides. A stale expected revision returns HTTP 409 and never overwrites another owner's edit.

#### Deterministic cents

Perform intermediate math at database decimal precision. For each normalized distribution:

1. calculate exact dollar shares;
2. floor each share to integer cents;
3. distribute remaining cents by largest fractional remainder;
4. break equal remainders by employee ID ascending.

Inside-pool cents must equal pool cents exactly. Apply outside-pool cents separately.

#### Invariants

- inside-pool final bonuses sum exactly to the pool after cent rounding;
- outside-pool adjustments reconcile separately;
- no unsupported job receives technician allocation;
- derived tier and efficiency affect payouts in the normative order above;
- forfeiture and redistribution conserve the pool;
- the displayed worksheet, payroll CSV, PDF, and detail CSV reference the same immutable run;
- an exported or locked historical run remains reproducible.

#### Lifecycle

Status sequence:

- draft;
- reviewed;
- exported;
- locked.

All rebuild, override, review, export, and lock operations acquire a per-period database advisory/row lock, verify expected revision, and commit status plus audit records transactionally.

- Draft and reviewed periods may be rebuilt by authorized users.
- Payroll CSV export of the current successful run changes the revision to exported. PDF/detail exports do not change lifecycle status.
- Any calculation-affecting edit or source change after the first payroll export creates a new draft revision; prior runs and exports remain immutable.
- Re-downloading an existing export does not create a revision.
- Locked revisions remain immutable. An authorized change creates a new draft revision with reason.
- Source changes mark draft/reviewed revisions stale and enqueue rebuild. Exported/locked revisions remain reproducible and show Source changed after export while a new draft revision is prepared.
- Export is prohibited unless the run is successful, current for its revision, fully source-complete, and matches the latest override/config hashes.

#### Worksheet and summary denominators

- Monthly Completed Jobs equals the full Section 6.2 completed cohort.
- Commission-supported and excluded/no-timesheet jobs are disclosed separately.
- Monthly Active Technicians counts eligible result technicians and separately identifies zero/forfeited payouts.
- Summary Average Monthly Pool divides by loaded finalized monthly runs in the selected year; missing months are N/A and are not zero-filled.
- Summary Active Technicians is the distinct count with final bonus greater than zero in at least one loaded run.
- Peak Month displays both month and pool value.
- Monthly/quarterly/annual summary totals aggregate immutable finalized runs only and identify draft/missing months.

---

## 7. Feature Requirements and Current State

Every item below is required unless explicitly labeled recommended post-v1. The Baseline column uses only the allowed statuses from Section 0.4. PARTIAL includes features that render but are invalid, misleading, historically incomplete, or verified for only one sample month.

### 7.1 Foundation and data

| ID | Baseline | Requirement |
| --- | --- | --- |
| F-01 | VERIFIED DONE | Next.js/TypeScript application contains all four v1 routes |
| F-02 | PARTIAL | Migrations implement the full source, normalized, rollup, override, audit, lifecycle, and export contract |
| F-03 | PARTIAL | P0: Entra authentication works and Asad/Laila can open every production page |
| F-04 | PARTIAL | Typed Simpro client implements all required list, detail, nested, schedule, mobile, employee, and timesheet endpoints |
| F-05 | PARTIAL | Queue supports idempotency, locks, retry, continuation, priority, budgets, and safe multi-worker behavior |
| F-06 | PARTIAL | Distributed Simpro limiter caps aggregate traffic from every worker/manual run at five requests per second |
| F-07 | PARTIAL | Freshness represents complete source windows and reconciliation, not any successful request |
| F-08 | VERIFIED DONE | Static guard blocks every legacy mirror/runtime identifier |
| F-09 | PARTIAL | No production path uses demo, generated, hard-coded, or placeholder business metrics |
| F-10 | PARTIAL | Reconciliation compares upstream IDs/totals to snapshots and rollups with repair behavior |
| F-11 | NOT STARTED | Required schedules and worker-drain behavior meet Section 4.6 |
| F-12 | NOT STARTED | Resumable 2023-current backfill is complete and period coverage is proven |
| F-13 | NOT STARTED | Owner-visible queue/freshness/reconciliation diagnostics exist |
| F-14 | NOT STARTED | Azure monitoring alerts on freshness, drift, failures, queue age, and infrastructure health |
| F-15 | NOT STARTED | Production operations baseline meets Section 10 |
| F-16 | NOT STARTED | Authenticated browser and integration test suite protects critical flows |
| F-17 | NOT STARTED | Authorized bounded manual refresh/backfill shows queue status, respects rate limits, and writes audit history |
| F-18 | PARTIAL | Every period/filter selection reads app-owned data and never launches broad synchronous Simpro work |

### 7.2 Quote Metrics

| ID | Baseline | Requirement |
| --- | --- | --- |
| Q-01 | PARTIAL | Snapshot compares Sent, Accepted, count acceptance rate, Total Value, and Accepted Value across selected month, prior month, and prior-year same month; partial periods also show prior-year full-month context |
| Q-02 | PARTIAL | Provisional alert shows elapsed days, month days, and pace |
| Q-03 | PARTIAL | Partial-month YoY comparison uses the same elapsed-day cutoff |
| Q-04 | PARTIAL | Pace strip covers quote count, Accepted count, and quote value |
| Q-05 | PARTIAL | Trailing-12 Accepted/Not Accepted donut excludes partial month and uses the locked source-backed partition |
| Q-06 | PARTIAL | YoY table includes sent, Accepted, acceptance rates, values, and average accepted deal |
| Q-07 | PARTIAL | Tiers are Under $750, $750-$2K, $2K-$10K, and $10K+ |
| Q-08 | PARTIAL | Quote volume by tier stacked bar |
| Q-09 | PARTIAL | Monthly acceptance rate by tier line chart |
| Q-10 | PARTIAL | Count acceptance-rate trend includes monthly, three-month rolling, and 12-month reference |
| Q-11 | PARTIAL | Value acceptance-rate trend includes monthly, three-month rolling, and 12-month reference |
| Q-12 | PARTIAL | Tier-by-month heatmap shows percentage, Accepted/total, and provisional month |
| Q-13 | PARTIAL | Trailing-12 KPI row preserves Total Quotes Sent, Total Quote Value, Quotes Accepted, and Overall Acceptance Rate with prior-month deltas, supporting context, and sparklines |
| Q-14 | PARTIAL | Monthly breakdown contains sent, values, Accepted, average accepted deal, both acceptance rates, provisional marker, and trailing-12 total/average footer |
| Q-15 | PARTIAL | Not Accepted follow-up table contains quote, age, value, category, tier, and missing acceptance-evidence explanation; no owner, salesperson, Stage, or CustomerStage |
| Q-16 | PARTIAL | HVAC/Water Heating/category segmentation uses selected scope and shows unclassified coverage |
| Q-17 | PARTIAL | Methodology footer states the locked acceptance rule, DateApproved basis, provisional behavior, and exclusion count |
| Q-18 | NOT STARTED | Audited exclusion/reinstatement override API and UI that cannot manufacture acceptance |
| Q-19 | PARTIAL | Every classification exposes a reason code and evidence basis |
| Q-20 | NOT STARTED | Filters for period, category, tier, and acceptance path use app-owned data; no owner, salesperson, Stage, or CustomerStage filter |
| Q-21 | NOT STARTED | Classification drilldown identifies source evidence and override history |
| Q-22 | REMOVED BY OWNER DECISION | No canonical open cohort exists; all non-excluded quotes without accepted-online or exact conversion evidence are Not Accepted |
| Q-23 | NOT STARTED | Legacy reviewed exclusions are seeded as audited records; prior PM/Not Accepted decisions are reconciled to exact source evidence without acceptance overrides |
| Q-24 | NOT STARTED | 2023-current history and each month reconcile to upstream/snapshot samples |

### 7.3 Job Metrics

| ID | Baseline | Requirement |
| --- | --- | --- |
| J-01 | PARTIAL | Completed jobs KPI is verified for June and still requires full historical evidence |
| J-02 | PARTIAL | Total sell value KPI is verified for June and still requires full historical evidence |
| J-03 | PARTIAL | Average job value KPI is verified for June and still requires full historical evidence |
| J-04 | PARTIAL | Gross profit and margin use Simpro Totals with coverage; June is verified |
| J-05 | PARTIAL | Quoted-versus-actual labor variance for quote-sourced jobs |
| J-06 | PARTIAL | Labor cohort and exclusion coverage counts |
| J-07 | PARTIAL | Material metric remains coverage-only until basis alignment is proven |
| J-08 | PARTIAL | Category/cost-center table has real sell value, margin, labor, and counts |
| J-09 | VERIFIED DONE | Completion uses CompletedDate plus Stage Complete/Archived only |
| J-10 | VERIFIED DONE | No active/pending dispatch queue UI |
| J-11 | NOT STARTED | Multi-month job count, value, margin, and labor trends |
| J-12 | NOT STARTED | Filters for period, category/cost center, and supported technician attribution |
| J-13 | NOT STARTED | Completed-job drilldown explains inclusion, financial basis, and labor coverage |
| J-14 | NOT STARTED | 2023-current monthly reconciliation and history coverage |
| J-15 | REMOVED BY OWNER DECISION | Out of scope because Pro Star does not invoice in Simpro; no invoice coverage KPI is permitted |
| J-16 | REMOVED BY OWNER DECISION | Out of scope because Pro Star does not invoice in Simpro; no invoice-lag or unbilled KPI is permitted |

### 7.4 Technician Performance

| ID | Baseline | Requirement |
| --- | --- | --- |
| T-01 | PARTIAL | Completed-job credit shared by actual timesheet hours; June is verified |
| T-02 | PARTIAL | Sell value allocated by timesheet share; June is verified |
| T-03 | PARTIAL | Actual job hours from timesheets; June is verified |
| T-04 | NOT STARTED | Utilization uses all recorded timesheet hours as denominator |
| T-05 | PARTIAL | Planned-versus-actual and on-time use technician schedule/mobile events |
| T-06 | PARTIAL | Quoted-versus-actual labor efficiency uses persisted nested labor |
| T-07 | PARTIAL | Every metric discloses source coverage and exclusions |
| T-08 | PARTIAL | Multi-technician allocation uses actual job-hour share; June is verified |
| T-09 | VERIFIED DONE | No legacy mobile-status mirror dependency |
| T-10 | VERIFIED DONE | No active dispatch timeline |
| T-11 | PARTIAL | UI displays employee names, with ID only as secondary drilldown data |
| T-12 | NOT STARTED | Technician revenue/hour and gross-profit/hour where financial coverage exists |
| T-13 | NOT STARTED | Filters for period and technician plus record-level allocation drilldown |
| T-14 | NOT STARTED | Historical trends and coverage reconcile by technician and month |

### 7.5 Technician Commissions

| ID | Baseline | Requirement |
| --- | --- | --- |
| C-01 | PARTIAL | Separate year/month selector and explicit load/apply action |
| C-02 | PARTIAL | Config banner shows pool, tier boosts, minimum, efficiency config, period, and work value |
| C-03 | PARTIAL | KPI cards show full completed cohort, commission-supported/excluded jobs, work value, pool, and active technicians; June is verified |
| C-04 | PARTIAL | Bonus-by-technician chart, not a generic pool waterfall |
| C-05 | PARTIAL | Ranked leaderboard preserves medal/rank presentation |
| C-06 | PARTIAL | Gold/Silver/Bronze/Standard and below-min tags |
| C-07 | PARTIAL | Raw bonus, forfeiture, reallocation, efficiency effect, and adjustments visible |
| C-08 | VERIFIED DONE | Proportional bonus bars |
| C-09 | PARTIAL | Per-tech allocation details include job, customer, job value, hours, share, and allocated value |
| C-10 | PARTIAL | Functional efficiency panel includes persisted toggle/slider, loading/error/coverage states, and per-tech quote jobs, quoted hours, actual hours, ratio, multiplier, percent effect, dollar effect, and neutral reason |
| C-11 | NOT STARTED | Editable pool, tiers, minimum, roster inclusion, allocated value, tier, adjustments, final bonus, and notes |
| C-12 | PARTIAL | Typed overrides persist and apply with correct field semantics |
| C-13 | PARTIAL | Immutable runs store config, watermarks, hashes, employee results, and job allocations |
| C-14 | NOT STARTED | Draft/reviewed/exported/locked lifecycle and revision transitions |
| C-15 | PARTIAL | Payroll CSV matches the displayed immutable run and outside adjustments |
| C-16 | PARTIAL | PDF is a formatted review worksheet with signatures/status/detail, not a technical stub |
| C-17 | PARTIAL | Calculation-detail CSV fully reconciles jobs, technicians, inputs, and outputs |
| C-18 | PARTIAL | Private, audited, retained exports are linked to immutable runs |
| C-19 | NOT STARTED | Summary has year selector and Monthly/Quarterly/Annual segmented view |
| C-20 | PARTIAL | Summary stats show annual pool, average across loaded finalized runs, peak month and value, and distinct technicians with final bonus greater than zero |
| C-21 | NOT STARTED | Period and annual per-tech tables include totals, rank, jobs, work value, average, sparklines, and no-data cells |
| C-22 | NOT STARTED | Summary loading progress and diagnostics from prior dashboard |
| C-23 | NOT STARTED | Team-total rows reconcile every summary view |
| C-24 | NOT STARTED | Export history exposes type, run, actor, timestamp, status, and re-download |
| C-25 | NOT STARTED | Override and lifecycle audit history is visible to Asad and Laila |
| C-26 | NOT STARTED | Locked-period change creates a revision without modifying prior exports |

---

## 8. Detailed Work Packages

Only the Integration Owner may close a work package. Parallel agents may implement isolated packages, but the Integration Owner owns shared contracts, migrations, final reconciliation, and release evidence.

### 8.0 Accountable feature assignment

Each feature has one accountable work package even when implementation requires supporting changes elsewhere.

| Work package | Accountable feature IDs |
| --- | --- |
| WP-00 | F-01, F-08 |
| WP-01 | F-03 |
| WP-02 | F-02, F-04 |
| WP-03 | F-05, F-06, F-07, F-10, F-11, F-13, F-17 |
| WP-04 | F-12 |
| WP-05A | Q-17 through Q-19, Q-23, Q-24 |
| WP-05B | Q-01 through Q-14 |
| WP-05C | Q-15, Q-16, Q-20, Q-21 |
| WP-06A | J-01 through J-10 and J-14; J-15/J-16 removed by owner decision |
| WP-06B | J-11 through J-13 |
| WP-07 | T-01 through T-14 |
| WP-08 | C-10 through C-14 and C-26 |
| WP-09A | C-01 through C-09 |
| WP-09B | C-19 through C-23 |
| WP-09C | C-15 through C-18, C-24, C-25 |
| WP-10 | F-14, F-15 |
| WP-11 | F-09, F-16, F-18 |

Required evidence locations in the repository:

- docs/prostar-metrics/feature-status.json - machine-readable status and evidence links for every feature ID;
- docs/prostar-metrics/data-dictionary.md - endpoint and field contract;
- docs/prostar-metrics/reconciliation/ - period/source reconciliation artifacts;
- docs/prostar-metrics/verification/G-*/ - gate-specific test logs, browser evidence, export renders, and operational proof.

Before parallel implementation, feature-status.json must expand every feature ID individually. Each record requires:

- feature ID and exact requirement text;
- execution status from Section 0.4;
- priority;
- one accountable work package and named agent/worktree;
- dependent feature and technical-investigation IDs;
- owned code paths, API contracts, and database tables;
- named unit, integration, reconciliation, E2E, and accessibility test IDs;
- expected evidence paths;
- implementing commit SHA and deployed revision when applicable;
- independent reviewer identity and review result.
- exactly one accepting phase gate.

CI must reject missing IDs, duplicate accountability, unknown status values, absent required evidence for VERIFIED DONE, or feature text that diverges from Section 7.

Reference artifacts must be vendored before implementation:

- docs/prostar-metrics/reference/simpro-swagger.json;
- docs/prostar-metrics/reference/quote-dashboard.html;
- docs/prostar-metrics/reference/commissions-dashboard.html;
- docs/prostar-metrics/reference/manifest.sha256.

The manifest records source absolute path, copied filename, SHA-256, and copy timestamp. Parity requirements must cite the vendored artifact and source element/line.

Initial path ownership:

| Owner | Primary paths |
| --- | --- |
| Integration/Storage owner | infra/db/migrations/**, shared contracts, feature-status.json, integration branch |
| Data-contract owner | src/lib/simpro/** and data dictionary |
| Pipeline owner | ingestion workers/jobs, freshness, reconciliation, Azure job definitions |
| Quote page owner | quote metric/read-model modules, quote API, quote page/components |
| Job owner | job metric/read-model modules, job API, job page/components |
| Technician owner | technician metric/read-model modules, technician API, technician page/components |
| Commission owner | commission metric/store/API modules, commission page/components, export generators |
| Verification owner | tests/evidence only; no primary production implementation ownership |

The current shared src/lib/store/read-model-rebuilds.ts must remain Integration Owner-only until it is split into domain-specific quote, job, technician, and commission rebuild modules. Migration numbering is reserved by the Integration/Storage owner beginning with the next unused number after 003. No other agent creates or renumbers a migration.

### WP-00 - Corrected plan and baseline lock

Dependencies: none

Tasks:

- use this document as the repository execution contract;
- create a machine-readable feature-status file keyed by every F/Q/J/T/C ID;
- record the audited baseline values and known production defects;
- add a CI check that no mandatory feature ID disappears;
- map each work package to an owner/worktree before parallel execution.
- create the required evidence directories and define the JSON schema for status/evidence records.
- vendor and hash the three authoritative reference artifacts;
- split or reserve shared read-model files and publish the migration-number allocation.
- revalidate every preexisting VERIFIED DONE entry; automatically downgrade any item lacking required evidence and independent approval to PARTIAL.

Evidence:

- feature-status inventory includes every ID in Section 7;
- no stale Invoiced, quote-owner, simulation-only, or complex-role requirement remains.
- reference hashes are committed and every ID has one accountable owner, dependency set, test IDs, and evidence paths.

### WP-01 - Restore authenticated production access

Dependencies: WP-00
Priority: P0
Primary touchpoints: Dockerfile, infra/azure/metrics.bicep, deployment scripts, auth smoke tests

Tasks:

1. Set HOSTNAME=0.0.0.0 in the production image and IaC environment.
2. Build and run the production image locally with loopback health verification.
3. Deploy a new revision without changing auth policy.
4. Sign in through the real Entra flow.
5. Open /quotes, /jobs, /technicians, /commissions, and their GET APIs.
6. Confirm Asad and Laila receive Owner/Admin plus Finance capabilities.
7. Confirm unauthenticated access redirects to sign-in.
8. Confirm no development auth bypass exists in production.

Gate:

- authenticated desktop and mobile Chrome screenshots for all four pages;
- no 401, 403, or 500 for authorized users;
- EasyAuth logs show successful forwarding;
- health endpoint and application logs remain clean.

### WP-02 - Complete Simpro endpoint and field contract

Dependencies: WP-00
Priority: P0
Primary touchpoints: src/lib/simpro, schemas, data dictionary, Swagger contract tests

Tasks:

1. Inventory required Swagger routes.
2. Add typed wrappers for quote/job sections, cost centers, nested labor/items, work orders, and all required change-log families.
3. Add all-timesheet extraction needed for utilization.
4. Verify schedule and mobile event field meanings with bounded production samples.
5. Verify quote link/converted-job relationships in both directions.
6. Verify list filter and ordering behavior; reject ignored filters.
7. Persist field-path basis and source hashes.
8. Add fixture and contract tests for every wrapper.
9. Diff every table in Section 5 against the production schema and add forward migrations for missing tables, keys, foreign keys, check constraints, unique/idempotency constraints, revision fields, tombstones, source provenance, and indexes.
10. Run migrations from a production-schema clone and prove both clean install and upgrade from the current schema.
11. Create a canonical table-mapping ledger that assigns reuse, alter, rename, or create to every Section 5 table and maps existing names such as metrics_freshness, commission_exports, and audit_events. One authoritative table per domain is required; parallel duplicate systems of record are prohibited.

Gate:

- data dictionary is complete;
- selected quote/job fixtures show nested labor/category values;
- selected converted quote/job fixture proves relationship storage;
- no required metric depends on undocumented embedded display=all behavior.
- schema diff is empty after migration and upgrade tests pass without destructive data loss.
- canonical table ledger is independently approved and production contains one authoritative table per required domain.

### WP-03 - Repair ingestion, cadence, freshness, and reconciliation

Dependencies: WP-02
Priority: P0
Primary touchpoints: workers, ingestion queue, Azure Container App Jobs, freshness, reconciliation

Tasks:

1. Implement every cadence in Section 4.6.
2. Ensure scheduled workers drain bounded work until time/request budget, not one queue row.
3. Correct idempotency and continuation behavior for date-window scans.
4. Record complete-window watermarks and outstanding continuation counts.
5. Make freshness depend on complete source families and post-source rollups.
6. Add suspect state for reconciliation drift.
7. Add queue depth, oldest age, failed jobs, and drift telemetry.
8. Emit alert-ready telemetry and implement the F-13 owner diagnostic UI. WP-10 exclusively owns Azure alert rules, action groups, recipients, and test firing for F-14.
9. Prove July no longer reports current while rollup value is zero.
10. Implement authorized manual refresh/backfill creation, queue-status display, idempotency, rate-limit enforcement, and audit history.

Gate:

- oldest queue age remains below each numeric SLA during a 24-hour observation;
- induced failed ingestion leaves last-good data and displays stale/error;
- induced rollup drift is detected and repaired;
- current-month reconciliation reaches zero count drift and cent-level money agreement.
- five-attempt dead-letter, lock-expiry recovery, duplicate idempotency, and manual-refresh audit tests pass.

### WP-04 - Complete and verify 2023-current backfill

Dependencies: WP-02, WP-03
Priority: P0

Tasks:

1. Produce and approve the source/month capacity and completion ledger required by Section 4.5.
2. Create explicit monthly backfill jobs for all required source families.
3. Run low-concurrency resumable source-fact backfill.
4. Verify each month's source maximum date, IDs, snapshot counts, and nested coverage.
5. Repair missing March/April 2026 quotes.
6. Backfill quote/job links and converted relationships.
7. Backfill employees, all timesheets, nested labor/category facts, and schedules.
8. Record mobile historical coverage separately from other source completeness.
9. Mark a source/month complete only after reconciliation.
10. Stop at reconciled normalized source facts. Domain packages own rollup rebuilding after their formula tests pass; WP-08 owns historical commission runs.

Gate:

- coverage report from January 2023 through current month;
- no unexplained missing month;
- no false complete periods;
- restart test proves idempotency;
- request usage remains bounded and observable.
- source-fact completion is recorded independently from domain rollups and commission runs so an unapproved formula cannot create official history.

### WP-05 - Correct and finish Quote Metrics

Implementation dependencies: WP-00 and the quote contracts/fixtures from WP-02
Production validation dependencies: WP-03 and WP-04
Priority: P0/P1
Primary touchpoints: quote metrics, read models, override API/UI, quote page

Independent subpackages:

| Subpackage | Scope | Subgate |
| --- | --- | --- |
| WP-05A classification and overrides | Q-17 through Q-19, Q-23, Q-24 | classification fixtures, override concurrency/audit, legacy seeds, all-month source/rollup reconciliation |
| WP-05B historical analytics | Q-01 through Q-14 | every chart/table formula test plus desktop/mobile evidence over complete history |
| WP-05C follow-up and filters | Q-15, Q-16, Q-20, Q-21 | accepted/not-accepted partition tests, app-owned filter E2E, age/value reconciliation |

WP-05B and WP-05C may use frozen WP-05A contracts/fixtures in parallel. The parent gate closes only after all three subgates pass.

Tasks:

1. Remove DateApproved-equals-Accepted logic and its incorrect test.
2. Implement classification precedence and reason codes from Section 6.1.
3. Seed only audited legacy exclusion overrides after exact ID matching; reconcile prior PM/Not Accepted decisions without acceptance overrides.
4. Add exclusion/reinstatement create/revise/history API and owner UI.
5. Rebuild all historical quote rollups.
6. Correct every Q-01 through Q-24 visualization and table.
7. Restore prior trailing KPI selection using the locked partition, including Overall Acceptance Rate.
8. Add the Not Accepted follow-up table with age, value, category, tier, and explicit missing-evidence reason.
9. Add required filters and classification drilldown without owner, salesperson, Stage, or CustomerStage controls.
10. Ensure every panel uses and labels its time scope.

Gate:

- Q-01 through Q-24 are VERIFIED DONE;
- DateApproved-only fixture is Not Accepted;
- Accepted Online and each independent exact conversion path classify correctly;
- active exclusion and reinstatement revisions work without creating acceptance;
- every month from January 2023 through current reconciles for count and money; selected record samples provide reason-level evidence;
- prior reviewed exceptions appear as audit records;
- desktop/mobile screenshots show real values and no owner, salesperson, Stage, CustomerStage, or open-pipeline operator control.

### WP-06 - Finish Job Metrics

Implementation dependencies: WP-00 and the job contracts/fixtures from WP-02
Production validation dependencies: WP-03 and WP-04
Priority: P1

Independent subpackages:

| Subpackage | Scope | Subgate |
| --- | --- | --- |
| WP-06A data and formulas | J-01 through J-10 and J-14 | formula tests and source-fact/rollup reconciliation for every month |
| WP-06B trends and drilldowns | J-11 through J-13 | filter/drilldown E2E and desktop/mobile evidence consuming frozen WP-06A contracts |

WP-06B may implement against fixtures after the WP-06A read-model contract freezes. The parent gate closes only after both subgates pass.

Tasks:

1. Preserve Stage-only Complete/Archived rule.
2. Rebuild historical job rollups only after job formula tests pass.
3. Persist category/cost-center sell and margin values from nested facts.
4. Replace hard-coded zero category values.
5. Rename/recalculate labor panel as quoted-versus-actual variance.
6. Add multi-month trends, filters, and record drilldown.
7. Add coverage/exclusion detail for financial and labor metrics.
8. Reconcile every month to source totals and representative records.

Gate:

- J-01 through J-14 are VERIFIED DONE, with J-15/J-16 recorded as removed by the owner decision above;
- an Invoiced-only fixture is excluded;
- changing Job Status cannot change completion;
- category totals reconcile to job totals or disclose unallocated difference;
- labor cohort reproduces job-level inputs.

### WP-07 - Finish Technician Performance

Implementation dependencies: WP-00, technician contracts/fixtures from WP-02, and stable job attribution contracts from WP-06
Production validation dependencies: WP-03 and WP-04
Priority: P1

Tasks:

1. Join dim_people and render technician names.
2. Ingest and classify all timesheet categories.
3. Calculate utilization from productive versus total recorded hours.
4. Implement technician-specific schedule/mobile matching.
5. Calculate arrival and duration variance plus on-time rate.
6. Complete quote-labor efficiency from persisted nested data.
7. Rebuild historical technician rollups only after technician formula tests pass.
8. Add allocated gross profit, revenue/hour, and gross-profit/hour where covered.
9. Add filters, historical trends, drilldowns, and coverage detail.

Gate:

- T-01 through T-14 are VERIFIED DONE;
- no technician row repeats a global coverage value as performance;
- missing mobile events are uncovered rather than late;
- multi-tech fixture allocation sums to one job and its value;
- utilization numerator/denominator is reproducible.

### WP-08 - Correct commission engine, overrides, and lifecycle

Implementation dependencies: WP-00, commission source contracts from WP-02, and stable job/timesheet/labor attribution contracts from WP-06
Production validation dependencies: WP-03 and WP-04; WP-07 schedule/mobile UI is not a dependency
Priority: P0/P1
Primary touchpoints: commission math, override store/API, calculation runs, lifecycle API

Tasks:

1. Implement typed override parsing and application.
2. Implement final-bonus lock and remaining-pool redistribution.
3. Persist editable period config and effective roster.
4. Add efficiency enable and max-adjustment controls that affect payout.
5. Store efficiency coverage/effect in immutable results.
6. Implement draft, reviewed, exported, locked transitions.
7. Enforce revision behavior for exported/locked periods.
8. Add server authorization and audit for every action.
9. Rebuild fixture months and compare them with the prior dashboard. Every payout difference must be attributable exclusively to the normative Section 6.4 calculation or an explicit locked decision; any other variance fails the gate.
10. Create historical commission runs only after engine tests pass; keep generated historical revisions draft until their period-effective roster/config evidence is reviewed.

Gate:

- C-10 through C-14 and C-26 are VERIFIED DONE;
- commission invariants pass for zero, single-tech, multi-tech, forfeiture, tier, efficiency, inside-pool, outside-pool, final-bonus, and rounding cases;
- overrides survive rebuild with correct field semantics;
- locked history remains unchanged;
- displayed and exported totals match the same run.

### WP-09 - Complete commission worksheet, summary, and exports

Dependencies: WP-08
Priority: P1

Independent subpackages:

| Subpackage | Scope | Subgate |
| --- | --- | --- |
| WP-09A monthly worksheet | C-01 through C-09 | monthly interaction E2E, allocation drilldown reconciliation, desktop/mobile evidence |
| WP-09B summary | C-19 through C-23 | monthly/quarterly/annual aggregation tests, no-data cases, totals/sparkline evidence |
| WP-09C exports and audit UI | C-15 through C-18, C-24, C-25 | byte/content assertions, PDF render review, immutable-run/export/audit reconciliation |

Subpackages may proceed in separate worktrees against the frozen WP-08 API/read-model contract. The parent gate closes only after all three subgates pass.

Tasks:

1. Restore accountable C-01 through C-09 and C-15 through C-25 UI/export features and consume the verified WP-08 contracts.
2. Replace pool waterfall with bonus-by-technician visualization.
3. Restore medals, tiers, proportional bars, and complete allocation drilldown.
4. Build editable worksheet controls and audit history.
5. Build Monthly/Quarterly/Annual summary with prior-dashboard stats, tables, totals, sparklines, progress, and diagnostics.
6. Produce a US Letter PDF worksheet containing branded header, period/run/revision/status, config, source freshness, technician rank/tier/payout/adjustments, team totals, review/signature/date areas, and audit/export identifiers. Render at 144 DPI and fail validation on clipped text, overlapping elements, blank pages, missing totals, or a mismatch with the immutable run.
7. Add export history and authorized re-download.
8. Visually verify PDF pages.

Gate:

- C-01 through C-09 and C-15 through C-25 are VERIFIED DONE; WP-08-owned IDs remain VERIFIED DONE under integration;
- payroll CSV, PDF, and detail CSV reconcile to one immutable run;
- PDF content assertions pass and every rendered page is visually reviewed at 144 DPI with no clipping, overlap, blank page, or total mismatch;
- summary totals equal monthly runs;
- desktop/mobile screenshots preserve prior useful interactions.

### WP-10 - Production infrastructure and security baseline

Dependencies: WP-01, can proceed in parallel with WP-05 through WP-09
Priority: P1

Tasks:

1. Preserve the current production network topology. This plan does not authorize a new VNet, private endpoint, private DNS zone, shadow Container Apps environment, hostname cutover, firewall-rule replacement, or disabling PostgreSQL public network access. Any future network architecture change requires separate explicit owner approval and is not a release dependency for this project.
2. Increase point-in-time restore retention to at least 35 days.
3. Enable storage autogrow and PgBouncer/Azure-supported pooling. Cap each web replica at 10 database connections and each worker at 5; configured maximum aggregate connections must remain below 70 percent of the server limit.
4. Use a single-zone v1 database with a four-hour RTO and 15-minute RPO, protected by PITR and restore drills. A future HA upgrade does not block v1 unless restore testing cannot meet those objectives.
5. Configure database diagnostics and alerts.
6. Store secrets in Key Vault references with managed identity where supported.
7. Add Blob lifecycle policy for seven-year export retention.
8. Configure Application Insights/Azure Monitor alerts for app, queue, ingestion, reconciliation, database, and export failures.
9. Run and document a restore drill.
10. Remove obsolete credentials after cutover.

Gate:

- IaC represents the actual production configuration;
- deployment what-if is reviewed;
- restore drill succeeds;
- alerts are test-fired;
- retention policies are visible in Azure.
- production networking is unchanged, pool limits are proven under load, and the documented RTO/RPO is met by the restore drill.

### WP-11 - End-to-end release verification and cutover

Dependencies: WP-01 through WP-10
Priority: final gate

Tasks:

1. Run all static, unit, integration, contract, reconciliation, and E2E suites.
2. Sign in as both initial owners.
3. Exercise every filter, override, rebuild, lifecycle, and export flow.
4. Rerun automated reconciliation for every month from January 2023 through current, then inspect representative record-level samples.
5. Verify stale, failed, empty, partial, and building states.
6. Capture desktop/mobile screenshots and PDF renders.
7. Load-test dashboard reads and worker/database connections.
8. Confirm dashboard requests make no broad Simpro calls.
9. Complete rollback rehearsal.
10. Retire temporary previews and obsolete revisions only after acceptance.
11. After deployment and production validation, replace placeholder evidence paths with concrete non-empty evidence files and record the deployed Container App revision, independent reviewer, and `SHIP` result for every verified feature.
12. Run `npm run release:evidence:check` only after the post-deploy evidence ledger is complete. This final acceptance gate is intentionally excluded from pre-deploy and build gates because a real deployed revision does not exist yet.

Gate:

- every mandatory feature ID is VERIFIED DONE and every non-mandatory ID is explicitly REMOVED BY OWNER DECISION;
- no PARTIAL or NOT STARTED item remains;
- all four production pages work through real auth;
- no material reconciliation drift;
- `npm run release:evidence:check` passes against concrete post-deploy evidence files, deployed revision, independent reviewer, and `SHIP` result;
- owner acceptance evidence is recorded.

---

## 9. Automated Verification Requirements

The Integration Owner must provide stable package scripts:

- npm run lint
- npm run guard:no-mirror
- npm run test
- npm run test:integration
- npm run test:e2e
- npm run test:a11y
- npm run reconcile:all-months
- npm run build
- npm run release:evidence:check (post-deploy final acceptance only; never a pre-deploy dependency)

Test IDs use UNIT-<feature>-<case>, INT-<feature>-<case>, REC-<feature>-<period>, E2E-<feature>-<flow>, and A11Y-<route>-<viewport>. feature-status.json lists the exact required IDs for each feature.

Browser evidence uses Chromium at 1440x1000 desktop and 390x844 mobile. Screenshots use <feature-id>-<route>-<period>-<viewport>-<deployed-revision>.png. E2E results record URL, authenticated actor, deployed revision, console errors, failed requests, and screenshot path.

Accessibility checks include automated axe analysis, keyboard access to every interactive control, visible focus, meaningful chart/table alternatives, form labels, and color-contrast validation. Critical/serious accessibility violations fail the gate.

Only the independent Verification owner may change an implementation status to VERIFIED DONE after checking the required evidence. Implementing agents stop at IN PROGRESS or request review.

The final release-evidence gate rejects every mandatory feature whose execution
status is not `VERIFIED DONE`; only `REMOVED BY OWNER DECISION` is exempt. Each
verified feature must name one or more project-relative, existing, non-empty
evidence files under `docs/prostar-metrics/verification` or
`docs/prostar-metrics/reconciliation`, the actual deployed revision, an independent reviewer distinct
from the implementation owner, and review result `SHIP`. Template directories,
missing files, placeholder values, and pre-deploy revision guesses fail closed.
`plan:check`, `reference:check`, and the normal release tests remain pre-deploy
gates; `release:evidence:check` runs after deployment, production reconciliation,
and authenticated desktop/mobile validation.

### 9.1 Unit tests

Quotes:

- DateApproved alone is Not Accepted;
- exact live linked job is Accepted;
- JobNo-only equality is Not Accepted;
- exact inverse ConvertedFrom job is Accepted;
- exact verified Accepted Online source value is Accepted;
- active exclusion/reinstatement precedence cannot manufacture acceptance;
- zero denominator produces N/A;
- partial-month and same-day YoY math;
- rolling averages and tier boundaries.

Jobs:

- Stage Complete/Archived accepted case-insensitively;
- Stage Invoiced rejected;
- Job Status never changes completion;
- period uses CompletedDate;
- financial and labor formulas;
- missing-coverage behavior.

Technicians:

- multi-tech credit/value allocation;
- unmapped timesheet exclusion;
- utilization denominator includes non-job time;
- on-time threshold and missing-event handling;
- labor-efficiency allocation.

Commissions:

- pool/tier normalization;
- efficiency enabled/disabled and bounds;
- forfeiture/redistribution;
- cent rounding;
- every override type;
- inside/outside pool invariants;
- lifecycle and immutable revision behavior;
- summary aggregation.

### 9.2 Integration tests

- every Simpro wrapper against recorded schema-safe fixtures;
- ignored-filter detection;
- pagination and continuation;
- retry behavior;
- hash-no-change skip;
- source change invalidates correct rollup;
- failed continuation prevents current freshness;
- override creates audit and rebuild work;
- export references exact run;
- authorization enforced server-side.

### 9.3 Reconciliation tests

Automated count/money reconciliation runs for every month from January 2023 through current. In addition, retain record-level evidence for at least:

- one historical full month;
- current partial month;
- a month with manual quote overrides;
- a multi-technician commission month.

Evidence must include upstream IDs/counts/totals, normalized counts/totals, rollup counts/totals, differences, and excluded IDs/reasons.

### 9.4 Browser E2E

Use real production-equivalent auth configuration for release smoke tests.

Required paths:

- sign-in redirect and callback;
- all four page loads;
- period/filter changes;
- quote override;
- commission config edit and rebuild;
- lifecycle review/export/lock;
- CSV/PDF/detail downloads;
- stale/error banner;
- unauthorized denial;
- mobile navigation and tables/charts.

Tests must fail on console errors, HTTP 5xx, inaccessible primary controls, clipped critical content, or chart panels with invalid empty dimensions.

### 9.5 Performance

Targets under normal production load:

- dashboard API p95 below 1.5 seconds for cached/read-model requests;
- page usable content below 3 seconds after auth;
- no dashboard request performs broad Simpro work;
- database connection count remains within configured pool;
- ingestion remains within rate limits and freshness SLA.

---

## 10. Operations, Deployment, and Rollback

### 10.1 Production database baseline

- TLS required;
- existing production network topology retained without an infrastructure cutover;
- 35-day minimum PITR;
- autogrow enabled;
- pooling configured at the limits in WP-10;
- alerts for CPU, memory, storage, connections, deadlocks, long queries, backup/restore health;
- maintenance outside reporting hours;
- quarterly restore drill.

Minimum alerts:

- web HTTP 5xx above 1 percent for five minutes;
- authenticated-route failure count above zero in release smoke;
- API p95 above three seconds for ten minutes;
- database CPU above 80 percent for 15 minutes;
- storage above 75 percent warning and 85 percent critical;
- connections above 70 percent of configured maximum;
- queue oldest age above the source SLA;
- three consecutive ingestion failures or any dead-letter row;
- any count drift or money drift above one cent;
- export/run total mismatch above zero.

Alerts notify the Pro Star owner operations recipients for Asad and Laila and are test-fired before cutover.

### 10.2 Deployment sequence

Database changes use expand/backfill/contract releases:

1. Expand with additive tables/columns/indexes that remain compatible with the current and previous web/worker revisions.
2. Deploy code that can read old and new shapes where required.
3. Backfill and verify.
4. Switch reads/writes after evidence.
5. Perform destructive contract cleanup only in a later release after rollback revisions are retired.

Every migration in a canary release must support the previous web and worker revisions. A migration that breaks rollback compatibility is rejected.

1. Pass repository gates.
2. Review migration SQL and backup/restore state.
3. Apply forward-only migrations.
4. Deploy worker/IaC changes.
5. Run bounded smoke ingestion.
6. Configure multiple-revision mode for controlled release.
7. Deploy the web revision with HOSTNAME correction at zero external traffic and validate its revision URL/internal health where supported.
8. Route 10 percent traffic, validate real Entra sign-in and smoke routes, then route 100 percent only after gates pass.
9. Run all-month reconciliation and the E2E smoke suite.
10. Retain the prior known-good revision until the observation window passes.
11. Monitor errors, latency, queue, freshness, and connections for at least 60 minutes.

Required release command templates must be captured with actual revision names in G-10 evidence:

    az containerapp revision set-mode --name aca-prostar-metrics-prod --resource-group prostar-payroll --mode multiple
    az containerapp ingress traffic set --name aca-prostar-metrics-prod --resource-group prostar-payroll --revision-weight OLD_REVISION=90 NEW_REVISION=10
    az containerapp ingress traffic set --name aca-prostar-metrics-prod --resource-group prostar-payroll --revision-weight NEW_REVISION=100

Rollback:

    az containerapp ingress traffic set --name aca-prostar-metrics-prod --resource-group prostar-payroll --revision-weight OLD_REVISION=100

### 10.3 Rollback

- retain prior known-good Container App revision until acceptance;
- application rollback must not require destructive database rollback;
- migrations require mitigation/downstream compatibility notes;
- failed ingestion leaves last-good snapshots and rollups;
- disable new schedules if they create unsafe API pressure while preserving queue state;
- never delete immutable commission runs or exports during rollback.

Rollback triggers include any authorized-user auth failure, HTTP 5xx above 1 percent for five minutes, API p95 above three seconds for ten minutes, new reconciliation drift, export mismatch, migration incompatibility, or sustained source queue age above SLA. Rollback routes 100 percent traffic to the prior revision, disables only newly introduced schedules that are causing pressure, preserves queue state, and opens an audited incident. Target rollback completion is 30 minutes within the four-hour service RTO.

### 10.4 Production write boundary

Dashboard work may write only to app-owned storage for ingestion, overrides, audit, lifecycle, and exports.

No Simpro mutation is required for this project. Agents must not update Simpro jobs, quotes, notes, statuses, or attachments while executing this plan.

---

## 11. Recommended Operator KPI Enhancements

These enhancements are valuable but must not displace required parity work. This section does not defer or reclassify requirements already present in Section 7. T-12 economics, C-21 payout sparklines, and F-13 owner diagnostics remain mandatory v1 requirements. Only analysis beyond the defined feature requirements is post-v1.

### R-01 - Quote follow-up and conversion analysis

- Not Accepted count/value by aging bucket;
- high-value Not Accepted exception table;
- category/tier acceptance matrix;
- quote-to-job conversion lag.

Q-22 remains REMOVED BY OWNER DECISION. These analyses use only the locked Accepted/Not Accepted partition and never add an open cohort, salesperson/owner dimension, or Stage/CustomerStage-derived outcome.

### R-02 - Job profitability exceptions

- gross-margin distribution;
- low/negative-margin completed-job exceptions;
- labor overrun hours and value by category;

### R-03 - Technician economics

- allocated revenue per productive hour;
- allocated gross profit per productive hour;
- utilization versus labor efficiency quadrant;
- schedule adherence distribution, not only a single rate.

### R-04 - Commission movement

- month-over-month rank change;
- payout trend by technician;
- efficiency contribution trend with coverage;
- exception list for unusually large overrides or source changes.

### R-05 - Owner data-health view

Provide an owner-only diagnostic surface or drawer showing:

- source watermarks;
- queue depth and oldest age;
- failed jobs;
- reconciliation drift;
- backfill completeness;
- per-metric coverage;
- latest alerts.

This is operational diagnostics, not the excluded dispatch dashboard.

---

## 12. Agent Orchestration Rules

### 12.1 Roles

Integration Owner:

- owns this plan, shared contracts, feature status, migrations, integration branch, production evidence, and final gates.

Data-contract agent:

- owns Simpro wrappers, schemas, normalization, field dictionary, and contract tests.

Pipeline/operations agent:

- owns queue, workers, cadence, freshness, reconciliation, Azure Jobs, monitoring, and backfill.

Page agents:

- one isolated owner each for Quotes, Jobs, and Technician Performance.

Commission agent:

- owns calculation, overrides, lifecycle, worksheet, summary, and exports.

Verification agent:

- independently reviews formulas, runs reconciliations, opens rendered pages, and rejects unsupported completion claims.

### 12.2 File ownership

Before parallel work begins, assign non-overlapping primary file ownership. Shared types, migrations, and common components require Integration Owner coordination.

An agent must not overwrite another agent's in-progress changes or revert unrelated user changes.

### 12.3 Required agent completion report

Every work package report must include:

- work package and feature IDs;
- files and migrations changed;
- business formulas implemented;
- tests added and exact results;
- source/sample IDs used for verification;
- reconciliation output;
- browser routes exercised;
- screenshot/export evidence paths;
- remaining PARTIAL or blocked items;
- deployment or rollback impact.

Statements such as implemented, wired, should work, or scaffolded are not acceptable evidence.

### 12.4 Independent adversarial review

The Verification Agent may not be the primary author of the work package being reviewed.

The review must ask:

- Does the calculation match the locked metric contract?
- Is the result real, or a placeholder/coverage proxy?
- Does it reconcile to source and snapshot records?
- Are missing records counted as failures, late events, or zero values incorrectly?
- Are historical and current selections consistent?
- Did the implementation preserve every operator-facing prior-dashboard feature not explicitly excluded by LD-08, including a feature accidentally omitted from Section 7?
- Can an authorized owner complete the workflow in the actual browser?
- Could rate limits, queue backlog, stale state, or connection limits break it?
- Is rollback possible without losing immutable financial history?

The reviewer must list all unknowns. An unknown that can be resolved technically is returned as work, not escalated as a business question.

---

## 13. Phase Gates

| Gate | Required evidence |
| --- | --- |
| G-0 Plan lock | This document, expanded per-ID traceability file, reference hashes, path/migration ownership, owners assigned |
| G-1 Production entry | Real Entra sign-in and all four routes/API paths load without 5xx |
| G-2 Data contract | Nested/change-log endpoint fixtures, field dictionary, converted-link proof, production-clone migration tests |
| G-3 Pipeline | Cadence, queue drain, stale failure, reconciliation repair, alerts |
| G-4 Source backfill | 2023-current source/month capacity ledger, normalized source-fact completeness, and upstream-to-snapshot reconciliation only |
| G-5 Quotes | WP-05A/B/C subgates, Q-01 through Q-21 and Q-23/Q-24 verified, Q-22 recorded as removed, all-month snapshot-to-rollup reconciliation, browser evidence |
| G-6 Jobs | WP-06A/B subgates, J-01 through J-14 with J-15/J-16 recorded as removed, all-month snapshot-to-rollup reconciliation, browser evidence |
| G-7 Technicians | T-01 through T-14, coverage report, all-month snapshot-to-rollup reconciliation, browser evidence |
| G-8 Commissions | WP-08 and WP-09A/B/C subgates, C-01 through C-26, invariants, lifecycle, exports, summary, browser/PDF evidence |
| G-9 Infrastructure | Unchanged production networking, retention, restore drill, alerts, IaC proof |
| G-10 Release | All IDs resolved, E2E/load/rollback complete, owner acceptance, and post-deploy `release:evidence:check` passes |

No later gate can be used to excuse a failed earlier dependency.

---

## 14. Technical Investigations With Default Resolution

These investigations are executable dependencies:

| Investigation | Owner/work package | Blocks | Required committed artifact |
| --- | --- | --- | --- |
| TI-01 Accepted Online source evidence | Data-contract owner / WP-02 | Q-05 through Q-24 | exact source-field contract with payload hashes and sample IDs |
| TI-02 quote/job relationship | Data-contract owner / WP-02 | Q-05 through Q-24, J-05, T-06, C-10 | relationship mapping with bidirectional samples |
| TI-03 timesheet categories | Data-contract owner / WP-02 | T-01 through T-08, C-03 through C-17 | category map and unmapped report |
| TI-04 mobile event semantics | Data-contract owner / WP-02 | T-05, T-07, T-14 | event-state map and matched/unmatched samples |
| TI-05 financial basis | Data-contract and Storage owners / WP-02 | J-02 through J-14, T-02/T-12, commission value/export IDs | field-path/tax-basis dictionary and cent reconciliation |
| TI-06 commission roster history | Commission owner / WP-08 | C-01 through C-26 | effective-dated eligibility/config evidence ledger |

No blocked feature may become VERIFIED DONE until its investigation artifact is independently accepted.

These are assigned engineering tasks, not user questions.

### TI-01 - Accepted Online source evidence

Inspect Swagger and bounded production quote samples. Record the exact source field and normalized exact value that mean Accepted Online, with payload hashes and sample IDs. Quote Stage and CustomerStage never determine acceptance. Until the Accepted Online evidence contract is proven, only exact live conversion relationships can classify a quote as Accepted.

### TI-02 - Quote/job relationship

Traverse both quote and job directions using documented endpoints. Persist the relationship that can be proved. Do not infer from matching names or customers.

### TI-03 - Timesheet categories

Ingest all employee timesheets and classify job versus non-job categories using structured reference/type fields. Unmapped categories remain visible and excluded from numerator classification until resolved.

### TI-04 - Mobile event semantics

Use read-only samples to map status names/timestamps to arrival and completion. Historical absence is coverage loss, not lateness.

### TI-05 - Financial basis

Record the exact Simpro Total/Totals paths used for sell value and gross profit. Keep tax basis consistent and reconcile to samples.

### TI-06 - Commission roster seed

Seed effective-dated eligibility from prior commission configuration evidence. Derive monthly rank tiers during each run; do not persist permanent roster tiers. Record explicit exclusions and do not infer eligibility from owner access or present-day population. Mark historical periods unavailable when period-effective roster/config evidence cannot be established.

---

## 15. Final Definition of Complete

The project is complete only when:

- Asad and Laila can sign in to the actual production URL;
- all four v1 pages are functional and preserve every required prior-dashboard feature;
- Quote Metrics uses only Accepted Online or exact live conversion evidence for Accepted, treats every other active non-excluded quote as Not Accepted, and never derives an outcome from DateApproved, Stage, CustomerStage, salesperson, owner, names, customers, or sites;
- Job Metrics uses CompletedDate and Stage Complete/Archived only;
- Technician Performance shows names, real utilization, real technician-specific schedule performance, and coverage;
- Commissions provide functional efficiency, typed editing, immutable revisions, lifecycle, full summary, and usable exports;
- the app-owned 2023-current data store is complete, monitored, and reconciled;
- freshness cannot report current over incomplete required source windows;
- no dashboard request performs broad Simpro fan-out;
- infrastructure meets the security, backup, retention, and alert baseline;
- every feature ID has objective evidence;
- an independent reviewer finds no unresolved release blocker;
- the post-deploy release-evidence gate passes for every mandatory feature and every owner-removed feature is recorded explicitly;
- owner acceptance is recorded.

There are no unresolved business decisions required before execution. Any future policy change must be added as a new locked decision and must not silently modify this document's existing requirements.

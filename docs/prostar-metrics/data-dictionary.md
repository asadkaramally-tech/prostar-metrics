# WP-02 Canonical Simpro Data Dictionary

This document is the canonical source-to-storage contract for the Pro Star Metrics
Dashboard. It implements WP-02 from the [execution plan](./execution-plan.md) and
must be read with the [canonical table mapping](./canonical-table-mapping.md), the
vendored [Simpro Swagger contract](./reference/simpro-swagger.json), and the current
[schemas](../../src/lib/simpro/schemas.ts),
[endpoint wrappers](../../src/lib/simpro/endpoints.ts), and
[normalizer](../../src/lib/simpro/normalize.ts).

The dictionary defines required behavior. Where current code differs, the rule in
this document and the execution plan wins. Static Swagger evidence is not a
substitute for the bounded tenant samples required by WP-02; unverified semantic
mappings are called out instead of being guessed.

## 1. Contract Conventions

- Endpoint paths below are `GET` paths relative to
  `/api/v1.0/companies/{companyID}`. List and nested collection routes must use
  explicit pagination or the route's documented bounded date filters. A detail
  route is never replaced by assumed `display=all` embedding.
- Source `integer|string ID` means the Zod adapters accept either representation;
  canonical IDs are positive `bigint` where the value is numeric. Invalid or empty
  IDs are rejected, not coerced to zero.
- `date` means source `YYYY-MM-DD`. `timestamp` means RFC3339. Source timestamps are
  stored in UTC; reporting dates are assigned in `America/Los_Angeles`. Reporting
  periods use an inclusive local start and exclusive next-month start.
- Source money is stored at database decimal precision. The canonical financial
  basis is explicit `ExTax`; generic object-first-number coercion is prohibited.
  A missing amount is `NULL` plus incomplete coverage, never an invented zero.
- Every fetched detail or nested collection is stored first in
  `metrics.raw_simpro_snapshots` with `source_path`, parent identity, payload,
  canonical payload hash, source version/modified timestamp when available,
  fetch/run timestamps, page window, and complete-traversal state. Each normalized
  row carries `source_snapshot_id`, `source_hash`, and `fetched_at`. The hash covers
  the complete response object or collection page, including required fields and
  unknown passthrough fields; a projection-only hash is insufficient.
- `source_deleted_at` is set only after a complete authoritative parent traversal
  proves a previously seen row is absent. An empty, failed, partial, or
  budget-exhausted traversal never tombstones rows.
- Persisted cost-center category values are `Water Heating`, `HVAC`, or
  `Unclassified`. A parent spanning categories retains each additive contribution;
  its derived primary category is the largest sell contribution with category-name
  tie-break, not a stored `Mixed` category.
- A changed row invalidates the union of old and new reporting periods and
  dimensions. At minimum this includes changes to `DateApproved`, `CompletedDate`,
  technician allocation, category, exact quote/job conversion evidence, money, job
  Stage, schedule block or source deletion. Quote salesperson, Stage, and
  CustomerStage provenance never invalidate serving quote outcomes.
- Canonical tables are the authorities named below. Compatibility tables are
  read-only migration sources and must not receive new product dependencies.

### 1.1 Locked semantic rules

1. There is **no quote owner**. Simpro has no quote-owner field for this product.
   Do not ingest, display, filter, or require one. The deprecated
   `metrics.quote_snapshots.owner_name` column remains `NULL` until that duplicate
   table is retired.
2. No salesperson metric, label, dimension, or filter is permitted. Simpro
   salesperson fields may remain only inside immutable raw source payloads as
   unused provenance. They must not be normalized into a serving dimension or used
   as a substitute for a nonexistent quote owner.
3. Quote `DateApproved` determines the activity month only. It is not evidence of
   acceptance and must never set outcome or `won=true` by itself.
4. The operator partition is exactly Accepted or Not Accepted after active
   exclusions are removed. Accepted means the exact verified Accepted Online source
   value, an exact live `LinkedJobID`, or an inverse job `ConvertedFrom`
   relationship. Descriptive or numeric `JobNo` equality is never evidence. Every other active non-excluded quote is Not
   Accepted. Internal `won`/`lost` values may implement this partition, but there is
   no separate Lost, Open, Pending, Declined, unknown, or stage-derived operator
   cohort. Manual overrides may exclude or reinstate; they cannot create acceptance.
5. Simpro `Stage` is a source **string** and canonical `text`, not an object or
   named reference. `Status` is a separate object and never substitutes for Stage.
6. A job is in the completed cohort only when `CompletedDate` is in the selected
   period and `trim(lower(Stage))` is exactly `complete` or `archived`. `Invoiced`
   is not complete. Job `Status.ID` or `Status.Name` never determines completion.
7. `Quote.LinkedJobID` maps quote to job. Job `ConvertedFrom.Type = "Quote"` and
   `ConvertedFrom.ID` map job to source quote. Deprecated `ConvertedFromQuote.ID`
   may remain in immutable raw provenance but is never relationship or acceptance
   evidence. Quote and job `JobNo` values are descriptive and equality between them
   is never conversion evidence. Names, customers, and sites are also not
   relationship evidence.

## 2. Canonical Authorities

| Domain | Canonical app-owned table(s) | Canonical grain/key | Compatibility or implementation note |
| --- | --- | --- | --- |
| Raw source | `metrics.raw_simpro_snapshots` | One immutable payload version per entity/path/hash; DB key `id`, unique source identity/hash | `metrics.source_entities_raw` is read-only and must be retired after provenance migration. |
| Quotes | `metrics.metrics_quotes` | One row per `quote_id` | `metrics.quote_snapshots` is a duplicate. Before retirement, add/migrate `name`, `status_id`, `status_name`, `is_closed`, `outcome`, `outcome_reason`, `deal_tier`, and `category_basis`. Never migrate owner. |
| Quote cost centers | `metrics.metrics_quote_cost_centers` | One row per `(quote_id, section_id, cost_center_id)` | Migration `006_canonical_field_contract.sql` widens the key; legacy embedded rows use explicit migration-only section `0`. |
| Quote labor/items | `metrics.metrics_quote_labor`, `metrics.metrics_quote_items` | Labor: `(quote_id, section_id, cost_center_id, labor_id)`; item: `(quote_id, section_id, cost_center_id, item_type, item_id)` | Explicit nested routes only. No embedded snapshot dependency. |
| Jobs | `metrics.metrics_jobs` | One row per `job_id` | `metrics.job_snapshots` is a duplicate. Before retirement, add/migrate `name`, `description`, `status_id`, `status_name`, `converted_from_at`, and required coverage fields. |
| Job cost centers | `metrics.metrics_job_cost_centers` | One row per `(job_id, section_id, cost_center_id)` | Migration `006_canonical_field_contract.sql` widens the key; legacy embedded rows use explicit migration-only section `0`. |
| Job labor/items | `metrics.metrics_job_labor`, `metrics.metrics_job_items` | Labor: `(job_id, section_id, cost_center_id, labor_id)`; item: `(job_id, section_id, cost_center_id, item_type, item_id)` | Job item types include `stock`; quote item types do not. |
| Work orders | `metrics.metrics_work_orders` | `(project_type, project_id, section_id, cost_center_id, work_order_id)` | `project_type` is `quote` or `job`. |
| People | `metrics.dim_people` | One person per unique `simpro_employee_id`; surrogate `person_id` | `metrics.employee_snapshots` is transitional. Required additive fields are `email`, `position`, `source_created_at`, and `source_modified_at`. |
| Timesheets | `metrics.metrics_employee_timesheets` | Contract grain `(employee_id, UID)` | `metrics.timesheet_snapshots` is transitional. Migration `006_canonical_field_contract.sql` enforces the composite identity without assuming global UID uniqueness. |
| Schedules | `metrics.metrics_schedules`, `metrics.metrics_schedule_blocks` | Schedule `(schedule_id)`; block `(schedule_id, block_index)` | `metrics.schedule_snapshots` JSON is transitional. Every block is normalized; the first block is not a schedule substitute. |
| Mobile status | `metrics.metrics_mobile_status_logs` | One row per `simpro_log_id` | `metrics.mobile_status_snapshots` is transitional. Raw status is retained even before event semantics are verified. |
| Legacy invoice storage | `metrics.invoice_snapshots`, `metrics.invoice_job_links` | Historical non-serving records only | Pro Star does not invoice in Simpro. These tables are excluded from dashboard reads, freshness, reconciliation, backfill, commissions, and release gates. |
| Change feeds | `metrics.source_change_events` | `(source_family, log_id)` | Durable cursor is `(DateLogged, ID)`, not page number alone. |
| Cursor/freshness | `metrics.ingestion_watermarks`, `metrics.metrics_freshness` | Watermark `(entity, window_key)`; freshness `page_key` | `metrics.source_freshness` is a compatibility view only. |

## 3. Dataset Register

The `Hash scope` column names the payload stored in `raw_simpro_snapshots`; every
normalized child row references that hash. `Q`, `J`, `T`, and `C` refer to Quote
Metrics, Job Metrics, Technician Performance, and Technician Commissions feature
IDs in the execution plan.

| Dataset | Source endpoint(s) | Canonical grain/key | Refresh and cursor | Hash scope | KPI/page consumers |
| --- | --- | --- | --- | --- | --- |
| Quote candidate list | `/quotes/` | List row by `ID`; discovery only | Six-hour current/trailing-90-day scan; nightly trailing 24 months; deterministic `orderby` plus persisted page; compare list-row hashes | Each list page and query window | Quote freshness/reconciliation; enqueues detail for Q-01 through Q-24 |
| Quote detail | `/quotes/{quoteID}` | `metrics_quotes.quote_id` | Event/hash candidate detail every 30 minutes; relationship/reconciliation/manual-exclusion targets; backfill DateApproved activity from 2023-current | Complete detail object | Quote page Q-01 through Q-24; quote-sourced labor links for J-05/T-06/C-10 |
| Quote sections/cost centers | `/quotes/{quoteID}/sections/`, detail, `/costCenters/`, detail | Parent + section + cost-center instance | With changed quote detail; collection page cursor per parent; tombstone only after complete traversal | Every section and cost-center collection/detail | Q-16 category; J-05/J-08; T-06; C-10; coverage drilldowns |
| Quote labor | Quote cost-center `/labor/` and `/labor/{laborID}` | Quote + section + cost center + labor | With quote nested refresh; explicit page cursor | Labor collection/detail | Quoted hours J-05/J-06, T-06/T-07, C-10/C-13/C-17 |
| Quote items | Quote cost-center `/catalogs/`, `/serviceFees/`, `/oneOffs/`, `/prebuilds/` and detail | Quote + section + cost center + type + item | With quote nested refresh; cursor per collection | Each item collection/detail | Q-16 and J-07/J-08 material/category coverage; supporting drilldown |
| Quote schedules/work orders | Quote cost-center `/schedules/`, `/workOrders/` and detail | Schedule/block or quote work-order key | Bounded candidate quotes every 60 minutes; quote nested changes also enqueue | Each collection/detail | T-05/T-07/T-14 context and coverage; no direct quote acceptance signal |
| Job candidate list | `/jobs/` | List row by `ID`; discovery only | Six-hour current/trailing-90-day and linked scan; nightly trailing 24 months; deterministic page cursor | Each list page/query window | Job freshness/reconciliation; enqueues J/T/C source details |
| Job detail | `/jobs/{jobID}` | `metrics_jobs.job_id` | New/hash-changed/linked detail every 60 minutes; 2023-current backfill | Complete detail object | J-01 through J-14; T-01/T-02/T-06/T-12; C-03/C-09/C-13/C-17; quote conversion Q-05/Q-19 |
| Job sections/cost centers | `/jobs/{jobID}/sections/`, detail, `/costCenters/`, detail | Parent + section + cost-center instance | With changed job detail; cursor per parent | Every section and cost-center collection/detail | J-04 through J-08/J-13; T-06/T-12; C-10/C-13 |
| Job labor | Job cost-center `/labor/` and detail | Job + section + cost center + labor | With job nested refresh | Labor collection/detail | J-05/J-06; T-06/T-07; C-10/C-13/C-17 |
| Job items/stock | Job cost-center `/catalogs/`, `/serviceFees/`, `/oneOffs/`, `/prebuilds/`, `/stock/` and detail | Job + section + cost center + type + item | With job nested refresh; stock collection is explicitly traversed | Each item collection/detail | J-07/J-08 material/category coverage; T-12 financial coverage |
| Job schedules/work orders | Job cost-center `/schedules/`, `/workOrders/` and detail | Schedule/block or job work-order key | Bounded candidate jobs every 60 minutes | Each collection/detail | T-05/T-07/T-14 planned visit and mobile identity matching |
| Employees | `/employees/`, `/employees/{employeeID}` | `dim_people.simpro_employee_id` | Daily 02:00 Pacific and on missing-ID demand; deterministic list cursor | List page and each detail | Technician/commission names, roster joins, and coverage only; quote salesperson is not a consumer |
| Employee timesheets | `/employees/{employeeID}/timesheets/` with `StartDate`/`EndDate` | `(employeeID, UID)` | Every 60 minutes for current month plus trailing 60 days; all employees and all schedule types; bounded date windows are the cursor | Complete employee/date-window response | J-05/J-06; T-01 through T-14; C-03/C-09/C-10/C-13/C-17 |
| Global schedules | `/schedules/`, `/schedules/{scheduleID}` | Schedule and all child blocks | Schedule logs every 15 minutes; bounded candidate detail every 60 minutes; list fallback by page and verified filters | List page and detail | T-05/T-07/T-14 |
| Quote/job/schedule logs | `/logs/quotes/`, `/logs/jobs/`, `/logs/schedules/` and detail | `(source_family, log ID)` | Every 15 minutes; durable `(DateLogged, ID)` cursor; two-hour overlap; dedupe ID + hash | Each log page/detail | No direct KPI value; candidate discovery, freshness, invalidation, and reconciliation for Q/J/T/C |
| Mobile status logs | `/logs/mobileStatus/`, `/logs/mobileStatus/{logID}` | Log event by `ID` | Every 15 minutes with stable `(DateLogged, ID)` cursor and two-hour overlap | Each page/detail | T-05/T-07/T-14 arrival, completion, duration, and on-time coverage after semantics verification |

Swagger documents job stock but no quote stock route. Therefore quote items are
limited to the four documented item families above. Do not fabricate quote stock
from job routes or embedded payloads. If a future Swagger revision adds a quote
stock route, add a typed wrapper, fixture, canonical `item_type`, and migration
before consuming it.

## 4. Quote Field Contract

Source: `GET /quotes/{quoteID}` unless otherwise stated.

| JSON field path | Source type / nullable | Canonical target | Normalization and null/coverage behavior | Invalidates |
| --- | --- | --- | --- | --- |
| `ID` | integer, required | `metrics_quotes.quote_id` | Positive ID; reject detail if invalid. | All quote periods and links |
| `QuoteNo` | optional tenant extension; not in vendored Swagger | `metrics_quotes.quote_no` | Preserve when supplied by validated tenant payload. No fallback to name/customer; UI may display `ID` when absent. | Quote drilldown only |
| `Name` | string, required | `metrics_quotes.name` (required additive column) | Trim only. Current canonical table needs this legacy-only field before `quote_snapshots` retirement. | Quote drilldown |
| `Salesperson.ID`, `.Name`, `.Type`, `.TypeId` | structured reference, nullable | Immutable raw source payload only | Retain unchanged as unused provenance. Do not resolve into `dim_people`, populate a serving salesperson dimension, display a label, build a coverage bucket, filter, group, or invalidate a quote rollup from it. Transitional canonical salesperson fields are non-serving and must receive no new product dependency. | None |
| `DateIssued` | date; Swagger required, business-null tolerant | `metrics_quotes.date_issued` | Age basis for the Not Accepted follow-up table only. Missing date displays Unknown age and is excluded from age-bucket arithmetic without changing acceptance. | Not Accepted age analysis |
| `DateApproved` | date; nullable in current schema/tenant behavior | `metrics_quotes.date_approved` | **Activity date only.** Missing excludes the quote from monthly activity; non-null never proves acceptance. | Old/new Quote Metrics month |
| `Stage` | **string**, required | Raw snapshot; transitional `metrics_quotes.stage` provenance only | Store exact source text. Never parse as `{ID,Name}` and never classify, display, filter, group, or invalidate a quote outcome from it. Job Stage has a separate completion contract. | None for quote outcome |
| `CustomerStage` | string, nullable | Raw snapshot; transitional `metrics_quotes.customer_stage` provenance only | Store exact source text only. `Accepted`, `Declined`, `Pending`, and every other value are not serving outcome evidence and are not operator filters or labels. | None |
| `IsClosed` | boolean, required | Raw snapshot; transitional `metrics_quotes.is_closed` provenance only | Preserve for source reconciliation. It does not determine acceptance or create an operator cohort. | None |
| `Status.ID`, `Status.Name` | integer/string, required object | `metrics_quotes.status_id`, `status_name` (required additive columns) | Preserve exact workflow provenance. Only the separately verified exact Accepted Online value is acceptance evidence; no other status creates acceptance or another cohort. | Acceptance only when exact Accepted Online evidence changes |
| `LinkedJobID` | integer/string, nullable | `metrics_quotes.linked_job_id` | Fetch the referenced job and require it to resolve to the exact live job. A valid verified link produces outcome reason `linked_job`; absent or invalid evidence falls through to another exact path or Not Accepted. | Quote outcome; linked job, J/T/C periods |
| `JobNo` | numeric/string, nullable | `metrics_quotes.job_no` | Preserve the original text for display only. Never promote it to `linked_job_id` or use equality with a job number as acceptance evidence. | Quote drilldown only |
| `Total.ExTax` | number, required by Swagger | `metrics_quotes.total` | USD ex-tax sell value. Null/invalid makes money KPIs partial; never default to zero. | Quote value/tier/Accepted-value rollups |
| `Total.Tax`, `Total.IncTax` | number, required | Raw snapshot; optional reconciliation columns | Retain for source reconciliation, not mixed into ex-tax KPIs. | Reconciliation only |
| `DateModified` | timestamp, required | Source modified/provenance column | Parse RFC3339 and store UTC. It is candidate metadata, not the only deletion/change detector. | Candidate/hash refresh |
| No source field | absent by contract | No `owner` canonical column | `owner_name` is prohibited and remains `NULL` in the compatibility table. | None |

### 4.1 Quote acceptance and relationship mapping

| Evidence, in precedence order | Canonical result/reason | Verification rule |
| --- | --- | --- |
| Latest active audited exclusion | `excluded/manual_excluded` | Revisioned exclusion/reinstatement with actor, reason, evidence, and effective revision. It removes or restores cohort membership but cannot create acceptance. |
| Exact verified Accepted Online source value | `won/accepted_online` | Match the approved normalized exact source value; no regex, substring, Stage, or CustomerStage substitute. |
| `Quote.LinkedJobID = J` | `won/linked_job` | `GET /jobs/J` succeeds and identifies exact live job `J`; persist quote-to-job link. |
| `Job.ConvertedFrom.Type = Quote` and `.ID = Q` | `won/converted_job` for quote `Q` | Persist the exact inverse job-to-quote relation from latest complete live raw job provenance. Deprecated `ConvertedFromQuote.ID` is ignored as relationship evidence. |
| Anything else | `lost/not_accepted_no_evidence` | Every active non-excluded quote without exact status or a direct/inverse relationship is Not Accepted and remains in all activity denominators. Numeric or descriptive `JobNo` equality is included here. |

Quote Stage and CustomerStage never provide outcome evidence, regardless of value.
`DateApproved`, `IsClosed`, names, customers, and sites are intentionally absent
from the acceptance-evidence table.
Persist the selected result and reason in
`metrics.metrics_quotes.outcome` and `outcome_reason`; retain the current
`won_reason` only as migration input. The serving result is the locked two-way
Accepted/Not Accepted partition plus explicit exclusion.
Derive and persist `deal_tier` from ex-tax `total`; `category_basis` records the
approved configured cost-center rule version.

### 4.2 Quote nested fields

| Dataset / JSON field path | Source type / nullable | Canonical target | Rule and coverage |
| --- | --- | --- | --- |
| Section `ID`, `Name`, `Description`, `DisplayOrder`, detail `IsVariation`, `DateModified` | Required ID/strings/integer; detail metadata required | Raw section snapshot; child `section_id` | Sections have parent grain `(quote_id, section_id)`. No standalone section fact is required, but every child must retain section identity. |
| Cost center `ID` | integer, required | `metrics_quote_cost_centers.cost_center_id` | This is the quote cost-center row/instance ID. |
| Cost center `CostCenter.ID`, `.Name` | ID/string, required | `configured_cost_center_id`, `name` | Configured account ID is distinct from row ID. Category comes from persisted configured cost-center mapping; unknown maps to `Unclassified`. Do not infer category from quote/customer/free-text notes. |
| Cost center `Total.ExTax` | number, required | `sell_value` | Additive category sell contribution; reconcile sum to quote total and expose difference as `Unallocated`. |
| Cost center `Totals.*`, `Stage`, `StartDate`, `EndDate`, `DateModified` | object/string/date/timestamp; stage/dates nullable | Provenance and supported cost/margin columns | Only field paths with a verified common basis become metrics; otherwise retain raw and mark the panel partial. |
| Labor `ID`, `LaborType.ID`, `LaborType.Name` | required | Labor key, `labor_type_id`, `labor_type_name` | One row per explicit labor detail. |
| Labor `Total.Qty` | number, required | `quantity_hours` | Quoted labor hours. Missing/invalid excludes that row from hours and lowers exact labor coverage. |
| Labor `Total.Amount.ExTax` | number, required | `sell_ex_tax` | Ex-tax labor sell contribution. |
| Labor `LaborRate`, `LaborMarkup`, `ProjectedTime`, `Claimed` | numbers/object; route-dependent | Raw; `actual_cost` only after basis verification | Do not label rate, projected time, or claimed value as actual cost without an accepted field-basis sample. |
| Item `ID` | integer, required | `item_id`; `source_item_id` where applicable | `item_type` is `catalog`, `service_fee`, `one_off`, or `prebuild`. |
| Item named ref (`Catalog`, `ServiceFee`, `Prebuild`) and one-off `Description`/`Type` | object/string | `source_item_id`, `description` | Preserve structured type; one-off `Type=Labor` is not silently merged into labor facts. |
| Item `Total.Qty`, `Total.Amount.ExTax`, `BillableStatus` | number/number/string | `quantity`, `sell_ex_tax`, `billable_status` | Required sell coverage; no `IncTax` mixing. |
| Item `EstimatedCost`, `ActualCost`, `BasePrice`, `LaborCost` | number; family-dependent | `estimated_cost`, `actual_cost` only with field-basis metadata | Material accuracy remains coverage-only until compared values share a proven basis. |

## 5. Job Field Contract

Source: `GET /jobs/{jobID}` unless otherwise stated.

| JSON field path | Source type / nullable | Canonical target | Normalization and null/coverage behavior | Invalidates |
| --- | --- | --- | --- | --- |
| `ID` | integer, required | `metrics_jobs.job_id` | Positive ID; reject invalid detail. | All linked J/T/C periods |
| `JobNo` | optional string/tenant field | `metrics_jobs.job_no` | Descriptive only. | Drilldown only |
| `Name`, `Description` | strings, required | `metrics_jobs.name`, `description` (required additive columns) | Needed for drilldown; migrate required legacy-only display fields before retiring `job_snapshots`. | Drilldown |
| `Stage` | **string**, required; Swagger enum `Pending`, `Progress`, `Complete`, `Invoiced`, `Archived` | `metrics_jobs.stage` | Preserve source string. Completion predicate is exact case-insensitive `Complete` or `Archived` only. | Old/new completed cohort |
| `Status.ID`, `Status.Name` | required object | `metrics_jobs.status_id`, `status_name` (required additive columns) | Workflow display only. **Never determines completion.** | Drilldown only |
| `CompletedDate` | date, nullable | `metrics_jobs.completed_date` | A job is complete only when date is in period and exact Stage predicate also passes. Missing date means not in completed cohort. | Old/new J/T/C month |
| `ConvertedFrom.Type`, `.ID`, `.Date` | object described as nullable; Type `Quote` or `Recurring` | `converted_from_type`, `converted_from_id`, `converted_from_at` (last is additive) | Only exact `Type=Quote` with a valid scalar ID creates a quote relation. Conflicting or malformed aliases fail closed. Store conversion timestamp as provenance. | Quote outcome and linked J/T/C periods |
| `ConvertedFromQuote.ID` | object, deprecated | Immutable raw source payload only | Preserve when supplied for source fidelity, but never normalize or use it as relationship, acceptance, routing, or reconciliation evidence. | None |
| `Customer.ID`, `Site.ID` | required objects/IDs | `customer_id`, `site_id` | Exact dimensions for drilldown; names retained in raw/canonical display columns where needed. | Dimension drilldown |
| `Total.ExTax` | number, required | `metrics_jobs.total` | USD ex-tax sell value for J-02/J-03, technician allocation, and commission work value. Invalid/missing is partial, never zero-filled. | J/T/C money rollups |
| `Total.Tax`, `Total.IncTax` | numbers, required | Raw/provenance | Reconciliation only; never mixed with ex-tax metrics. | Reconciliation |
| `Totals.GrossProfitLoss.Actual` | number, required in Swagger job totals | `gross_profit_actual` | Exact actual gross-profit path. Missing row is excluded from GP-supported denominator and disclosed. | J-04/T-12 |
| `Totals.GrossMargin.Actual` | number, required in Swagger job totals | `gross_margin_actual` | Retain source value for row validation. Aggregate gross margin is `sum(gross profit) / sum(sell)` over supported rows, not an average of percentages. | J-04/T-12 |
| `DateModified` | timestamp, required | Source modified/provenance | UTC; candidate metadata plus hash. | Candidate/hash refresh |

### 5.1 Completed-job predicate

```text
included =
  CompletedDate >= local_period_start
  AND CompletedDate < local_next_period_start
  AND trim(lower(Stage)) IN ('complete', 'archived')
  AND source_deleted_at IS NULL
```

No `Status` field appears in this predicate. `Stage = Invoiced` is excluded even
when status text contains "complete" or the job has invoices.

### 5.2 Job nested fields

Job sections, cost centers, labor, catalog, service-fee, one-off, and prebuild
fields follow the quote nested contract with `job_id` keys and the following
additions:

| Dataset / JSON field path | Source type / nullable | Canonical target | Rule and coverage |
| --- | --- | --- | --- |
| Cost center `JobID`, `ID`, `CostCenter.ID`, `CostCenter.Name` | required IDs/string | `job_id`, `cost_center_id`, `configured_cost_center_id`, `name` | Route parent and source `JobID` must agree. Mismatch is suspect. |
| Cost center `Total.ExTax`, `Totals.GrossProfitLoss.Actual`, `Totals.GrossMargin.Actual` | numbers | `sell_value`; additive `gross_profit_actual`, `gross_margin_actual` | Category contribution is additive. Job-total minus cost-center total is shown as `Unallocated`. Aggregate category margin uses summed GP / summed sell. |
| Cost center `Totals.ResourcesCost.LaborHours.*` | numeric object | `labor_quoted_hours` only for an approved basis | Prefer summed explicit labor `Total.Qty`; retain totals as reconciliation/fallback with its field path recorded. |
| Cost center `Totals.MaterialsCost.Actual`, item cost fields | numbers | `material_cost_value` and item cost only after basis validation | Material savings/accuracy remains unavailable until cost/sell bases align. |
| Stock path `stockID`, `Catalog.ID/Name/PartNo`, `Quantity.Required`, `Quantity.Assigned`, `AssignedBreakdown[]` | path ID plus required object | `metrics_job_items` with `item_type=stock` | `item_id` comes from route/path identity because the response has no top-level `ID`; `source_item_id=Catalog.ID`. Derived sell/cost values remain null unless an accepted basis defines quantity and unit value. |
| Work order `ID`, `Staff.ID`, `WorkOrderDate`, `Approved` | required | Work-order key, `staff_id`, `work_order_date`, `approved` | Preserve project/section/cost-center identity for mobile matching. |
| Work order `ScheduledHrs`, `ISO8601ScheduledStartTime`, `ISO8601ScheduledEndTime`, `Blocks[]` | number/timestamps/array | `scheduled_hours`, `scheduled_start_at`, `scheduled_end_at`; schedule-block provenance | Prefer RFC3339 timestamps. Missing work-order timing is coverage loss, not zero duration. |

## 6. People, Timesheet, Schedule, and Mobile Contracts

### 6.1 Employees and person resolution

Source: `GET /employees/` and `GET /employees/{employeeID}`.

| JSON field path | Source type / nullable | Canonical target | Rule and coverage |
| --- | --- | --- | --- |
| `ID` | integer, required | `dim_people.simpro_employee_id` | Stable natural key; one canonical person is reused for employee, schedule staff, timesheet parent, work order, and mobile staff references. Quote salesperson provenance does not create or resolve a serving person. |
| `Name` | string, required | `display_name`; `aliases_json` | Latest label is display name; prior non-empty labels remain aliases. Missing detail is fetched on demand. |
| `Position` | string, required | `dim_people.position` (required additive column) | Do not infer commission eligibility from position. |
| `PrimaryContact.Email` | string, required by Swagger object | `dim_people.email` (required additive column) | Exact path is `PrimaryContact.Email`, not top-level `Email`. Empty email is allowed and does not remove the person. |
| `Archived` | boolean, required | `active = NOT Archived` | Inactive people remain selectable historically. |
| `DateCreated`, `DateModified` | timestamps, required | Additive `source_created_at`, `source_modified_at` | Store UTC; `first_seen_at` is ingestion observation, not a replacement for source creation time. |
| Usage context (employee detail, schedule/mobile staff) | structured refs | `role_type` plus aliases | Role describes observed serving source use. It does not create separate people for the same employee ID. Quote salesperson remains unused raw provenance. |

### 6.2 Employee timesheets

Source: `GET /employees/{employeeID}/timesheets/`.

| JSON field/path | Source type / nullable | Canonical target | Rule and coverage |
| --- | --- | --- | --- |
| Path `{employeeID}` | ID, required | `employee_id`, resolved `person_id` | Parent is authoritative employee identity; payload need not repeat it. Unresolved person triggers employee detail fetch and remains disclosed. |
| `UID` | string, required | `timesheet_id` | Contract key is `(employee_id, UID)` until global UID uniqueness is proven. |
| `ScheduleType` | enum `Activity`, `Job`, `Lead`, `Quote` | `reference_type` | Normalize lowercase. Ingest every type; non-job rows are required for utilization denominator. |
| `_href` | string, required | Reference provenance | Parse structured `/jobs/{id}` or `/quotes/{id}` first. |
| `Reference` | string, required | `reference_raw`, fallback `reference_id` | Hyphen parsing is fallback only. Unparsed rows remain with `parse_status=unparsed_reference`; never drop them. |
| `Date` | date, required | `work_date` | Utilization month uses this date. Completed-job allocation uses all timesheets linked to cohort jobs regardless of timesheet month. |
| `StartTime`, `EndTime` | local time strings, required | `start_time`, `end_time` | Interpret with work date in `America/Los_Angeles`, handling cross-midnight end explicitly. Do not cast naive strings directly to UTC. |
| `TotalHrs` | number, required | `total_hours` | Source duration is authoritative. Invalid value lowers coverage; do not infer zero. |
| `ScheduleRate.ID`, `.Name` | object with string/ID and name | `metrics_employee_timesheets.schedule_rate_id`, `schedule_rate_name` (required additive columns) | It is not a money object. The current numeric `schedule_rate` column cannot represent this field and must not be populated by object coercion. |
| `Cost`, `OverheadCost`, `TotalCost` | numbers, required | Same-named decimal columns | Cost coverage only; sell-value KPIs continue to use job ex-tax total. |

Productive hours are rows with a verified job reference. Total recorded hours are
all employee rows in the selected work-date period, including `Activity`, `Lead`,
`Quote`, and unmapped categories. Unmapped references are visible and excluded
from productive numerator classification until resolved; they remain in the total
recorded denominator when the employee/date/hours are valid.

### 6.3 Schedules and blocks

Source: global or nested schedule list/detail routes.

| JSON field path | Source type / nullable | Canonical target | Rule and coverage |
| --- | --- | --- | --- |
| `ID` | integer, required | `metrics_schedules.schedule_id` | Stable parent key. |
| `Type` | enum `lead`, `quote`, `job`, `activity` | `reference_type` | Normalize lowercase. |
| `Reference`, `Project`, `_href` | strings; `Project` null for activity/lead | `reference_id` plus raw reference provenance | Parse structured project identity and verify against nested route parent. Ambiguous rows remain unmatched. |
| `Staff.ID`, `.Name`, `.Type`, `.TypeId` | required object | `staff_person_id`; block `staff_id` | Resolve employee ID through `dim_people`; preserve source label/type. |
| `Date`, `TotalHours` | date/number, required | `schedule_date`, `total_hours` | Parent summary only; visit calculations use blocks. |
| `Blocks[]` array order | required array | `metrics_schedule_blocks.block_index` | Persist every block in response order. One non-cancelled block is one planned visit. |
| `Blocks[].Hrs` | number, required | `planned_hours` | Invalid duration marks that block partial. |
| `Blocks[].ISO8601StartTime`, `ISO8601EndTime` | timestamps, required | `planned_start_at`, `planned_end_at` | Preferred timing; store UTC and allow cross-midnight. |
| `Blocks[].StartTime`, `EndTime` | local time strings, required | Parent convenience times/fallback provenance | Use only as a timezone-aware fallback when ISO values are absent; mark fallback coverage. |
| `Blocks[].ScheduleRate.ID`, `.Name` | required object | `schedule_rate_id` and source label/provenance | Do not coerce object to money. |
| `DateModified` | timestamp, required | Source modified/provenance | Candidate/hash metadata. |

No cancellation field or status-to-cancellation mapping is established in the
current typed schedule schema. Until a tenant sample proves it, cancellation
coverage is partial and no block may be assumed cancelled from message text alone.

### 6.4 Mobile status events

Source: `GET /logs/mobileStatus/` and detail.

| JSON field path | Source type / nullable | Canonical target | Rule and coverage |
| --- | --- | --- | --- |
| `ID` | integer, required | `simpro_log_id` | Dedup key and cursor tie-breaker. |
| `Staff.ID`, `.Name` | required object | `staff_person_id`, person alias | Resolve through `dim_people`. |
| `WorkOrder.ID`, `.Type` | ID and enum `Job`/`Quote` | `work_order_id`, `work_order_type` | Match to canonical work order; Type is project type, not event type. |
| `WorkOrder.ProjectID`, `.CostCenterID`, `._href` | required IDs/string | `project_id`, `cost_center_id`, route provenance | Match employee + job/work-order identity before time proximity. |
| `Status.ID`, `.Name`, `.Color` | required object; Swagger says numeric Name while adapter accepts string/number | `status_id`, `status_name`, raw snapshot | Normalize Name to text without assigning arrival/completion semantics until verified. |
| `Latitude`, `Longitude` | numbers, required | Same-named decimals | Supporting evidence only; no geofence is defined by this contract. |
| `DateLogged` | timestamp, required | `date_logged` | Store UTC; high-water cursor component and event order. |

Arrival is the first verified on-site event after the preceding visit boundary;
completion is the first verified completion/departure event after arrival. Status
IDs/names for those meanings require approved production samples. Missing history
or an unmatched event is uncovered, never late. On-time is calculated only for
covered visits and means arrival no later than 15 minutes after planned start.

## 7. Invoicing Exclusion

Owner decision, July 10, 2026: Pro Star does not perform invoicing in Simpro.
Invoice value, payment, aging, invoice-lag, and unbilled calculations are therefore
not valid Simpro-backed business metrics and must not appear in any dashboard,
commission calculation, freshness requirement, reconciliation, or release gate.

## 8. Change-Log Contract

Source families used by this product are `quote`, `job`, `schedule`, and
`mobile_status`. All persist to `metrics.source_change_events`; mobile events also
normalize to `metrics.metrics_mobile_status_logs`.

| Source field | Type / nullable | Canonical column | Rule |
| --- | --- | --- | --- |
| `ID` | integer, required | `log_id` | Dedup key within `source_family`; tie-breaker in cursor. |
| `DateLogged` | timestamp, required | `date_logged` | Primary cursor component, stored UTC. |
| `Message` | string, required except mobile | `message` | Audit/candidate context only. Do not parse business outcomes from free text. |
| `Staff.ID` | ID, nullable on non-mobile logs | `staff_id` | Preserve when present; absence does not invalidate the event. |
| Quote `QuoteID` | string/ID, nullable | `source_entity_type=quote`, `source_entity_id` | Enqueue quote detail when valid. |
| Job `JobID` | string/ID, nullable | `source_entity_type=job`, `source_entity_id` | Enqueue job detail when valid. |
| Schedule `ScheduleID`, `ScheduleEmployee.ID`, `Type` | nullable ID/object; Type required | Schedule source identity and payload | Enqueue schedule detail; employee/type assist coverage only. |
| Mobile `WorkOrder.ProjectID` | integer, required | Project source identity | Enqueue matching work-order/schedule context as needed. |
| Complete log object | object | `payload`, `payload_hash`, `fetched_at`, `ingestion_run_id` | Preserve unknown fields and exact source evidence. |

The cursor is lexicographic `(DateLogged, ID)`. Poll from two hours before the
committed high-water timestamp, dedupe by `(source_family, ID)` and payload hash,
and advance the committed cursor only after every page through the observed
boundary commits. Persist `page_cursor`, overlap start, expected-through value,
and gap state. Non-monotonic order, ignored date filters, missing pages, or gaps
fail contract verification and activate deterministic list-scan fallback.

A log with a null entity ID is retained but cannot enqueue a detail by identity;
count it as unmatched change-feed coverage. Logs discover candidates but do not
  prove deletion, quote outcome, or job completion.

## 9. Refresh, Backfill, and Coverage

### 9.1 Cursor and traversal rules

- List endpoints support `search`, `columns`, `pageSize`, `page`, `orderby`, and
  `limit` in Swagger. Filters/order are used only after live samples prove they
  affect results. Persist page and query window before a request budget is
  exhausted.
- Nested collection cursors include parent IDs and collection name. A completed
  labor collection does not imply item, schedule, or work-order completion.
- Worker limits are 20 minutes or 1,000 requests per run and 250 requests per queue
  item before continuation. Aggregate Simpro traffic is capped at five requests
  per second; backfill averages no more than one request per second.
- Initial backfill is 2023-01-01 through current date for DateApproved quote
  activity, plus every exact job linked to an in-window quote, all employee timesheets needed
  for allocation/utilization, historical schedule records, and best-effort bounded
  mobile history. Every source/month is resumable, idempotent, and reconciled.

### 9.2 Null and coverage matrix

| Dataset | Core completeness | Allowed partial behavior |
| --- | --- | --- |
| Quote detail/relationship | 100% of candidate detail rows plus all four independent acceptance-evidence checks for core Quote Metrics | Missing nested category is partial; missing `DateIssued` creates Unknown age only. Every active non-excluded quote is always Accepted or Not Accepted and remains in the activity denominator. |
| Job detail | 100% of candidate detail/Totals rows for completed-job core | Labor, category, and material panels may each be partial without hiding supported job count/value. Missing Stage or CompletedDate never qualifies as complete. |
| Nested cost centers/labor/items | Complete parent traversal and exact child denominator | Supported rows calculate; missing rows/fields report numerator, denominator, IDs, and reason. Material remains coverage-only until basis validation. |
| People | Every referenced employee ID resolved or disclosed | Historical archived people remain valid; unresolved labels use ID only and mark coverage partial. |
| Timesheets | Complete employee/date-window traversal and every completed-job reference needed for allocation | Unparsed/non-job categories remain visible. Jobs without mapped timesheets are excluded from technician allocation and disclosed, but remain in completed-job and commission-pool totals. |
| Schedules/mobile | Complete declared forward window plus matched/unmatched counts | Missing events are uncovered, not late; on-time denominator includes covered matched visits only. Historical absence remains coverage loss. |
| Commission inputs | Complete jobs, details, timesheets, roster, config, overrides, and source hashes | No partial core source is exportable. Each source row/version is copied into immutable `commission_run_inputs`. |

Freshness is complete-window state, not the timestamp of the last successful
request. Quote core is stale after 60 minutes; job/timesheet/schedule metrics after
two hours; mobile after 30 minutes; commissions
after 24 hours or any source change after the run. Any incomplete core source is
`BUILDING` or `PARTIAL`, never `CURRENT`.

## 10. Static Contract and Live Verification Ledger

Bounded read-only tenant samples were verified on 2026-07-09 and persisted in the
app-owned production store with raw payload hashes. These samples prove shape,
field path, relationship direction, and selected arithmetic only. They do not
promote unreviewed stage names or mobile statuses into business semantics.

| Required evidence | Static contract status | Required sample record | Current evidence state |
| --- | --- | --- | --- |
| Accepted Online source evidence | Source route and field documented | Quote ID per exact Accepted Online value, payload hash, normalized exact value, reviewer | **Locked mapping:** only the separately verified exact Accepted Online value is direct acceptance evidence. Quote Stage and CustomerStage values, including Accepted, Declined, and Pending, never classify a serving outcome. `IsClosed` and `DateApproved` do not prove acceptance. |
| Quote conversion direction | Fields and wrappers documented | Quote ID + direct `LinkedJobID` or job `ConvertedFrom` | **Verified live:** jobs associated with quotes `31` and `2560` point back through `ConvertedFrom { Type: Quote }`. Their descriptive `JobNo` values may also happen to align, but that equality is never evidence. `LinkedJobID` remains the direct relationship when present. |
| Job `ConvertedFrom` direction and deprecated `ConvertedFromQuote` presence | Both fields documented; only exact `ConvertedFrom.Type=Quote` is authoritative | Job ID + source quote ID + job detail hash | **Verified:** job `17319` has `ConvertedFrom.Type=Quote` and `ConvertedFrom.ID=2688`; quote `2688` resolves inverse linked job `17319`. The observed deprecated `ConvertedFromQuote.ID` is raw provenance only and is not evidence. |
| Nested quote/job labor and category | Explicit routes and schemas documented | Quote/job IDs with section, cost center, labor/item IDs and ex-tax/hour reconciliation | **Verified:** quote `2686`, section `55435`, cost center `30408`, labor `56701` stores 6 hours and $2,100 ex-tax; job `17319`, section `90716`, cost center `60576`, labor `85138` stores 3 quoted hours and $705 ex-tax. Both classify from configured cost center `6`, Water Heating Service. |
| Timesheet job/non-job classification | All-timesheet route and enum documented | Employee ID, date window, examples for each ScheduleType and unmapped case | **No sample ID committed.** |
| Schedule cancellation and mobile arrival/completion meanings | Routes/raw fields documented | Schedule/work-order/staff IDs plus status IDs/names and matched/unmatched timestamps | **Shape verified, semantics unresolved:** schedule `172490` maps employee `258`, job `17319`, cost center `60576`, and one ISO-timestamped block. Cancellation and mobile arrival/completion mappings remain partial. |

## 11. Known Drift in Current Adapters

These are implementation defects or incomplete areas, not alternative contracts:

- The legacy quote-override API still accepts a binary `wonOverride`; WP-05A must
  replace it with exclusion/reinstatement-only revisions, concurrency, and UI history.
- Generic money extraction currently defaults some missing totals to zero and may
  choose `IncTax` or another first available field. Canonical mappings require
  explicit `ExTax` and null coverage.
- Accepted Online source-field evidence, all-timesheet category samples, and mobile
  arrival/completion semantics still require bounded tenant evidence. Quote Stage
  and CustomerStage require no outcome mapping because they are prohibited inputs.
- Old/new period-and-dimension invalidation is not yet transactional for every
  changed normalized row; WP-03 must close that before freshness can be CURRENT.

Resolving these drifts changes only implementation behavior; it does not require a
new product decision.

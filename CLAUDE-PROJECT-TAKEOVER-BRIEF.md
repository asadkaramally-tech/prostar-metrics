# Pro Star Metrics Dashboard: Claude Project Takeover Brief

Prepared: 2026-07-14
Owner: Asad Karamally
Repository: `/Users/asadkaramally/Documents/New project/prostar-metrics-dashboard`
Production app: `aca-prostar-metrics-prod`

## Paste-Ready Assignment

You are taking over the Pro Star Metrics Dashboard as the senior product designer, data engineer, and application engineer responsible for getting it to an owner-approved production release.

This is a custom analytics product for the owners of a midsize HVAC and water-heating company. It is not an engineering console, a generic admin portal, or a showcase for every backend capability. Its job is to let Asad and Laila understand current and historical operating performance quickly, trust every number, identify problems and opportunities, and drill into the small number of records that require attention.

The current application has substantial reusable backend and frontend work, but the product has gone off track. It contains invented workflows, excessive audit and diagnostic UI, very long lists where visual analysis should exist, broken or misleading technician data, weak information hierarchy, and pages that do not meet the requested professional design standard. Do not patch individual symptoms or preserve current UI merely because tests pin it. Reset the product composition while reusing valid data, calculations, ingestion, infrastructure, and prior-dashboard functionality.

Your first deliverable is not application code. First audit the sources in this brief, create a concise owner-question/content map, and then create complete responsive mockups for every user-facing dashboard screen. Show the mockups to Asad and obtain explicit approval. Only after approval may you implement them. The approved mockups become the visual and compositional source of truth. Reproduce them exactly in the application and prove the match with full-page, high-resolution browser evidence at every required viewport. There is no "close enough" acceptance standard.

Continue through implementation, data correction, validation, deployment, authenticated production verification, and owner acceptance. Do not stop at a scaffold, status report, sign-in screen, green test suite, or unverified deployment.

## 1. Governing Authority

Use this precedence whenever sources conflict:

1. Asad's direct decisions and feedback recorded in this brief.
2. Mockups explicitly approved by Asad, once approval is recorded.
3. The locked metric and architecture decisions in this brief.
4. Verified Simpro Swagger contracts and read-only production source evidence.
5. Genuine operator-facing features in the prior Quote Activity dashboard and the prior Technician Commissions and Commission Summary views.
6. Current application behavior and tests, which are implementation evidence only.
7. Older plans, briefs, and mockups.

Never silently change scope, reinterpret a metric to fit available code, or preserve an invented feature because it already exists.

### Superseded artifacts

The following artifacts remain useful as evidence, but they are not authoritative in full:

- `ProStar_Metrics_Implementation_Plan.md` contains important data and architecture decisions, but its commission lifecycle, review, lock, audit, export, revision, and operator-admin requirements are explicitly rejected. Do not treat its label "LOCKED FOR IMPLEMENTATION" as overriding this newer owner feedback.
- `redesign-handoff/codex-design-package/CODEX-DESIGN-IMPLEMENTATION-BRIEF.md` is useful for visual tokens and styling. Its instructions to preserve every action, export, audit, status, worksheet lifecycle, rebuild/review/lock stepper, revision chip, manifest hash, and roster editor are superseded.
- The package's existing commissions mockup contains rejected product content. It is a visual-language reference, not a page-composition reference.
- Current tests that require rejected UI or invented processes must be replaced with tests for the approved product contract. Do not weaken valid metric tests, but do not let contaminated tests dictate scope.
- In particular, `tests/components/commissions-dashboard.test.ts` currently asserts `Audit History`, `Rebuild`, and `Payroll CSV`. Those assertions encode the superseded product contract and must not be used to preserve those owner-facing surfaces.

## 2. Owner's Target Standard and Parameters

These are release requirements, not design aspirations.

### Product standard

- Build an owner-facing KPI dashboard for Asad and Laila, the two initial users.
- The product must support both near-real-time operating awareness and useful historical analysis.
- Each screen must answer a short set of recognizable owner questions: what happened, how it compares, where performance changed, what is driving it, and what requires attention.
- Every visible element must earn its place by answering an owner question or enabling a natural drilldown/action. Remove everything else.
- The first viewport must communicate the page's main operating story. Do not spend it on notices, methodology, coverage prose, setup controls, or internal state.
- Pages must be deliberately composed and concise. The current 6,463 to 8,517 pixel desktop pages are evidence of failure, not a target. Use progressive disclosure, tabs, drawers, bounded tables, and focused chart modes instead of permanent page stacks.
- Use charts for trends, comparisons, distributions, contribution, and exceptions. Use tables only for ranked actionable records or drilldown detail. A long list is not a visualization.
- Do not repeat the same metric as a KPI, chart, explanatory block, and table unless each treatment answers a different owner question.
- Do not ship fabricated business data, hard-coded KPIs, misleading zeroes, fake history, or a polished number whose data basis is unsupported. Use truthful `N/A` or a concise coverage state when needed.
- Internal reconciliation, ingestion, manifest, revision, audit, and diagnostic machinery must not dominate the owner experience. Operational diagnostics belong in restricted secondary tooling, logs, or a compact data-health surface.

### Visual standard

- The result must be indistinguishable in polish from a professionally designed premium product, with the restraint and precision associated with Linear and Ramp.
- It must look intentionally designed at the full-screen level, not like independently styled cards accumulated down a page.
- Exact hierarchy, spacing, alignment, typography, chart treatment, density, and responsive behavior matter for every element.
- Use the supplied design package for its visual language: self-hosted Inter, restrained neutral surfaces, dark navigation rail, precise hairlines and shadows, and one accent `#5b63d3`.
- Use the accent only for the primary metric/series and focus or active navigation. Green and red are reserved for semantic positive/negative states. Avoid decorative color.
- Avoid nested cards, card-heavy page sections, excessive pills, large rounded containers, dense internal scrolling, tiny text, duplicated headings, and visually equal treatment of every metric.
- Controls must use familiar patterns: icons for tools, segmented controls for modes, toggles for binary settings, and compact selects/sliders for bounded options.
- No explanatory essays, methodology walls, instructional copy, implementation terminology, or made-up process labels in the primary UI. Use concise labels, tooltips where genuinely necessary, and a short source/freshness line.
- Charts must render actual data, remain legible, use direct labels where useful, and never be blank, clipped, overlapped, or replaced by a text list.
- Mobile and tablet designs must be composed for those sizes, not merely desktop cards stacked vertically.
- Required viewports are 1440x1000, 1024x768, 768x1024, and 390x844.
- Full-page high-resolution review is mandatory. A top-of-page skim does not count.

### Pixel-perfect standard

- Before implementation, Asad must approve the complete mockups.
- After approval, the mockup is the source of truth for content, geometry, hierarchy, typography, spacing, and responsive behavior.
- Compare implementation screenshots against the approved mockups with overlays and image diffs using the same browser, viewport, fonts, and deterministic data fixture.
- Inspect the entire full-page image at 100 percent and zoomed detail, not only a viewport crop.
- Fix every visible mismatch, overflow, clipping, alignment error, broken chart, inconsistent control, or unintended wrapping. Do not use an arbitrary diff threshold to excuse visible differences.
- Any intentional deviation from an approved mockup requires Asad's explicit approval before it is implemented.

## 3. What Went Wrong

Treat this as a root-cause diagnosis so the same failure is not repeated.

### Product-purpose failure

The application drifted from an owner KPI product into a developer/admin console. It optimized for exposing system machinery rather than helping an HVAC business owner understand performance.

### Scope failure

The implementation plan accumulated unrequested lifecycle, audit, export, diagnostics, evidence, and configuration workflows. A later design brief incorrectly declared all of them immutable, and the design pass polished the clutter instead of questioning it.

### Data-trust failure

The technician roster is wrong and July economics can be allocated to a person with no July work. Current green tests reproduce this logic rather than independently proving that it matches Simpro and the owner's interpretation.

### Information-architecture failure

All available information was placed on the primary page. Jobs, quotes, technicians, and commissions became 6,000 to 8,500 pixel documents with little prioritization or progressive disclosure.

### Visualization failure

Important operating patterns were often presented as lists, repeated tables, coverage grids, or prose instead of purpose-built charts and bounded exception views.

### Visual-design failure

Individual components received a premium skin, but full screens remained disorganized, overlong, inconsistently dense, and poorly fitted. Styling components is not the same as designing a product screen.

### Responsive and polish failure

Prior review focused on whether elements existed and whether gross overflow occurred. It did not inspect every complete screen at high resolution for typography, spacing, chart framing, wrapping, density, and visual intent.

### Delivery-process failure

Passing tests, infrastructure hardening, and reaching a sign-in screen were repeatedly reported as progress toward release even though the actual owner experience and live data had not been proven. Release completion means an authenticated owner can use the real production product and trust it.

## 4. Explicitly Rejected Product Scope

Do not put any of the following into the owner-facing product unless Asad later requests and approves it:

- worksheet lifecycle or state-machine UI;
- Rebuild, Review, Export, or Lock process steppers;
- revision, edit, run, manifest, or source-hash chips;
- giant audit logs or audit-history tables;
- export boxes, export history, download counts, or export status columns;
- a generic or hallucinated Status column;
- revision history;
- diagnostics/run-message panels;
- roster inclusion admin tables on the main dashboard;
- change-reason and evidence-URL bureaucracy;
- source-completeness implementation details in the hero;
- long data-contract-gap lists;
- reconciliation-history tables;
- giant coverage matrices on primary pages;
- migration field-coverage panels;
- methodology footers that read like engineering documentation;
- the old Pending Jobs/dispatch dashboard, dispatch queue, weekly dispatch timeline, active-job filters, or old active-job modal;
- quote owner, salesperson metrics, salesperson filters, or a salesperson substitute;
- open quote/open pipeline metrics or visualizations;
- invoice, accounts-receivable, collections, payment-aging, unbilled, or invoice-lag metrics;
- a complex organization-wide role hierarchy;
- a new VNet/private endpoint/private DNS/network redesign;
- broad request-time Simpro pulls;
- callback metrics in v1.

Backend records needed for correctness, security, or recoverability may remain behind the product. Their existence is not a reason to expose them to owners.

## 5. Required V1 Product Surfaces

All four are required. None may be deferred, replaced by a placeholder, or silently reduced:

1. Quote Metrics
2. Job Metrics
3. Technician Performance
4. Technician Commissions, including the genuine monthly view and monthly/quarterly/annual historical summary

Initial access is only Asad and Laila through existing Microsoft Entra EasyAuth. Server-side authorization remains required. Do not build a complex role system.

## 6. Locked Business and Data Rules

### Global

- Business timezone: `America/Los_Angeles`.
- Currency: USD.
- Selected months use local inclusive month start and exclusive next-month start.
- Store source timestamps in UTC and convert before reporting-date assignment.
- Do not silently substitute a coverage percentage for a requested KPI.
- Net profit, gross profit, commissions, utilization, capacity utilization, and labor efficiency are different concepts and must remain distinct.

### Completed jobs

A job belongs to the selected completed-job cohort only when:

- `CompletedDate` is in the selected month; and
- Simpro `Stage`, not Job Status, is `Complete` or `Archived`, case-insensitively.

Never use Job Status to decide completion. `Invoiced` is not a completion stage for this dashboard.

### Quotes

- `DateApproved` determines the Quote Metrics activity month but does not prove acceptance.
- A non-excluded quote is Accepted only when it is Accepted Online from the verified Simpro source value or has an exact verified conversion relationship to a live job.
- Exact conversion evidence may come from `LinkedJobID`, exact numeric `JobNo`, or a live job's `ConvertedFrom.Type = Quote` and matching quote ID.
- Every other active, non-excluded quote is Not Accepted.
- There is no separate canonical Open outcome for this product.
- Never derive acceptance from Quote Stage, CustomerStage, ordinary Status values, customer name, site, DateApproved, salesperson, or a fabricated quote owner.
- Manual exclusion/reinstatement may remove test or invalid records. It may not manufacture acceptance.
- Quote tiers are Under $750, $750-$2K, $2K-$10K, and $10K+.
- Zero denominators render `N/A`, not zero percent.

### Jobs and financials

- Completed jobs, sell value, gross profit, gross margin, net profit, and net margin must come from the supported completed cohort and validated Simpro financial fields.
- Net profit is more useful to the owners than gross profit and should be prominent; gross profit remains useful in combination and for explaining the bridge to net.
- Pro Star does not perform invoicing in Simpro. Omit invoicing and collections metrics rather than calling missing invoices a data-quality problem.
- Material accuracy may only appear if quoted and actual material values are proven to use the same cost/sell basis.

### Technician performance

- The owner-facing roster must be the actual effective technician roster, not the commission roster and not every employee with any timesheet.
- Active/archived state, position/role evidence, hire dates, effective dates, and actual work evidence must be handled explicitly.
- Default technician availability is Monday-Friday, 8:30 AM-5:00 PM, with a 30-minute lunch, yielding eight productive hours per day. Use verified individual Simpro availability or leave where present; otherwise use this default.
- Productive utilization = supported job hours / all recorded hours for the selected work month.
- Capacity utilization must use available capacity after supported leave/availability adjustments. There is enough data to calculate it; do not call it an unresolved gap.
- Quote-linked labor efficiency is useful.
- Recurring-job labor efficiency is also useful and supported by recurring job estimate/actual data.
- Planned-vs-actual and punctuality use technician-specific schedule/mobile evidence. Missing events are uncovered, not late.
- The primary selected-month technician view must not claim a technician earned July revenue/profit when that technician recorded no supported July work. Do not silently mix a work-date cohort with all historical hours on jobs completed in the month.
- If completed-job economics are retained as a separate analysis, label their different cohort explicitly and keep it secondary. The selected-month performance view must remain semantically coherent.

### Technician commissions

- This is a calculated commission model, not proof that payroll payment occurred and not Simpro payout data.
- Use one concise owner-facing disclaimer: `Calculated, not paid. These amounts do not confirm that payment was made.`
- The efficiency adjustment is functional. When enabled, it changes the displayed calculated commission amounts according to the approved bounded formula; it is not a simulation-only control.
- Retain the genuine prior-dashboard controls and analyses only: selected month/year, pool-percent control, efficiency toggle, maximum-adjustment slider, efficiency comparison, completed jobs, work value, commission pool, technicians earning commission, calculated amount by technician, ranked leaderboard, expandable job detail, and monthly/quarterly/annual summary.
- Do not infer payment status, payment history, or paid commission from calculated results.
- Do not expose the rejected lifecycle, audit, status, export-history, revision, manifest, roster-admin, or evidence-entry processes.

## 7. Genuine Prior-Dashboard Carry-Forward

Use the old dashboards as feature references, not as data-semantic authority. Their hard-coded/demo data and old acceptance assumptions are not valid source truth.

### Quote Activity dashboard features to retain or thoughtfully consolidate

- selected-month snapshot;
- comparison to prior month and prior year;
- current partial-month pace only when it is mathematically honest and clearly labeled;
- acceptance by count and by value;
- quote volume by deal-size tier;
- acceptance rate by tier;
- monthly acceptance trends with 3-month and 12-month context;
- tier-by-month acceptance heatmap;
- historical/monthly breakdown;
- useful drilldown into the largest Not Accepted opportunities.

These may be consolidated with mode toggles or progressive disclosure. Feature parity does not mean reproducing every old block as a permanent full-width section.

### Technician Commissions and Commission Summary features to retain

- month/year selector;
- commission pool-percent selector;
- functional efficiency toggle and bounded max-adjustment slider;
- understandable efficiency comparison by technician;
- KPIs for completed jobs, work value, pool, and technicians earning commission;
- calculated commission-by-technician visualization;
- ranked leaderboard with expandable job detail;
- a separate compact historical summary with monthly, quarterly, and annual modes;
- annual total, average month, peak month, active earning technicians, and technician/period comparison.

Do not carry forward any other view from `prostar-dashboard.html`.

## 8. Screen-Level Product Direction

This is a starting content contract for mockup exploration. Claude must still produce the owner-question map and justify every element against available data before seeking approval.

### Global composition

- Compact page header, selected period, and quiet freshness indicator.
- One visually dominant outcome, a small supporting KPI cluster, two to four primary analytical visualizations, and one bounded actionable drilldown.
- Use tabs, segmented chart modes, drawers, or detail expansion for secondary analyses.
- Keep internal data health out of the primary flow. A compact owner-readable freshness/data-quality entry point is acceptable.
- Historical comparisons should be immediately understandable in business language, not data-engineering terminology.

### Quote Metrics

Owner questions:

- How many quotes were sent and what were they worth?
- What share was accepted by count and value?
- Is acceptance improving or declining?
- Which deal sizes perform best?
- Which large Not Accepted quotes deserve attention?

Strong candidate composition:

- acceptance-rate hero with activity count/value context;
- current vs prior month/prior year comparison;
- count/value acceptance trend as a mode switch rather than duplicate giant panels;
- volume and acceptance by tier;
- tier-by-month heatmap;
- bounded largest-Not-Accepted table with record detail in a drawer.

Remove duplicate snapshot tables, giant evidence lists, methodology sections, open-pipeline analyses, and owner/salesperson controls.

### Job Metrics

Owner questions:

- How much revenue, gross profit, and net profit did completed work produce?
- Is profit improving, and what explains the gap between revenue, gross, and net?
- Which jobs, categories, customers, or sites create profit or losses?
- Where is estimated labor being exceeded?

Strong candidate composition:

- net-profit hero with revenue and gross-profit support;
- revenue/gross/net historical trend;
- gross-to-net or revenue-to-net bridge only where the underlying components reconcile;
- completed-job trend and average value context;
- quoted/estimated vs actual labor, including quote-linked and recurring work where appropriate;
- loss-job/net-margin exception view;
- focused top-N category/customer/site profitability chart or mode switch;
- bounded completed-job drilldown.

Do not put migration coverage, reconciliation history, verbose basis tables, invoice panels, or engineering methodology on the main screen.

### Technician Performance

Owner questions:

- Who was actually on the technician roster in the selected month?
- How much available capacity was used productively?
- Who is over/under capacity or under-recording time?
- Who completes quoted or recurring labor efficiently?
- Who arrives on time?
- Which technicians are contributing profitable work, using a cohort the owner can understand?

Strong candidate composition:

- a team outcome selected only after the roster/cohort audit; do not automatically reuse allocated net profit as the hero;
- team capacity and productive-utilization visualization;
- quote and recurring labor-efficiency modes;
- punctuality/schedule-adherence distribution;
- compact technician comparison scorecard;
- selected-technician drilldown with work, capacity, efficiency, punctuality, and supported economics;
- exceptions such as unused capacity, unrecorded hours, over-capacity, or loss-heavy work when data supports them.

Do not expose a massive full-history heatmap, giant coverage tables, every employee, or economics allocated from work outside the selected month without a clearly separate cohort.

### Technician Commissions

Owner questions:

- What is the calculated commission amount for the selected month?
- What work value and pool produced it?
- How is it distributed among eligible technicians?
- How does the efficiency setting change the distribution?
- How do technicians and periods compare historically?

Strong candidate composition:

- calculated-commission-due hero;
- work value, pool, completed jobs, and earning-technician support KPIs;
- compact pool-percent and efficiency controls that update the calculation functionally;
- calculated commission distribution chart;
- ranked leaderboard with bounded expandable job detail;
- separate Summary tab/view with monthly, quarterly, and annual modes.

Remove the current worksheet lifecycle card, status column, export box/history, revision history, audit history, diagnostics, roster editor, manifest/run metadata, evidence fields, and process stepper.

## 9. Confirmed Technician/Data Defects

These are known defects, not open-ended questions. Verify the exact current lines before editing, then fix the contracts and add independent tests.

1. The roster query currently includes anyone in `commission_roster` or anyone with a selected-month timesheet. It does not establish that the person is an active technician by position/effective roster evidence.
   - `src/lib/store/technician-read-model-inputs.ts`, around `getTechnicianCapacityProfiles`.
2. Capacity and the displayed technician population are built from a union of allocation, utilization, schedule, and capacity identities. This promotes non-roster people into the technician scorecard.
   - `src/lib/metrics/technicians.ts`, around the technician assembly loop.
3. Migration `infra/db/migrations/009_commission_roster_seed.sql` seeded nine employees with open-ended commission eligibility. That is not a valid technician-performance roster.
4. Archived people can still receive a full month of capacity. The archived flag is returned but does not stop capacity accumulation.
   - `src/lib/metrics/technicians.ts`, `calculateTechnicianCapacity`.
5. Jobs completed in the selected month currently allocate economics using every positive mapped timesheet ever attached to those jobs, without a `work_date` condition.
   - `src/lib/store/technician-read-model-inputs.ts`, `getTechnicianJobs` CTE `job_timesheets`.
6. Selected-month utilization uses only timesheets whose own work date is in the month. This creates the visible contradiction: allocated July economics with zero July utilization/hours.
7. Any mapped employee can receive technician economics; allocation is not restricted to a valid effective technician roster.
8. Hourly timesheet ingestion does not tombstone rows removed from Simpro after a complete employee traversal, while the bulk bootstrap path does.
   - `src/lib/simpro/ingest.ts`, `ingestEmployeeTimesheets`.
   - Compare `src/lib/store/bulk-operational-bootstrap.ts`, `finalizeAuthoritativeFamily`.
9. Employee changes update `dim_people` but return no affected technician periods, so roster/archived/position changes do not rebuild relevant read models.
   - `src/lib/simpro/normalize.ts`, `normalizeEmployee`.
10. Technician reconciliation checks only count, sell value, and hours. It does not independently validate the roster, gross profit, net profit, work dates, or source-timesheet identity.
    - `src/lib/store/technician-reconciliation.ts`.
11. `scripts/validate-dashboard-read-models.ts` repeats the same commission-roster-or-timesheet population rule, so validation currently agrees with the defect.

Required correction direction:

- Introduce or derive a dedicated effective-dated technician roster independent of commission eligibility.
- Use Simpro position/role, archived/active state, hire dates, and verified work evidence. Do not guess names or eligibility.
- Preserve source work dates in allocation evidence.
- Make the selected-work-month cohort and completed-job cohort explicit and separate.
- Do not promote non-roster employee allocation into the technician leaderboard. Reconcile/disclose it separately.
- Tombstone absent timesheets after complete authoritative traversals.
- Invalidate/rebuild affected periods when employee roster attributes change.
- Reconcile technician IDs, roster membership, timesheet IDs/dates, sell, gross profit, and net profit independently of the serving calculation.
- Use July 2026 as a mandatory regression case because that is where the owner identified the contradiction.

## 10. Other Known Release-Blocking Backend Risks

An independent review identified these P1 integrity risks. They must be investigated and fixed before production release even if the UI is redesigned:

1. Ingestion lease fencing occurs after durable entity writes. An expired worker can continue writing snapshots/facts before its next heartbeat proves it still owns the job.
   - `src/lib/store/ingestion-jobs.ts`, expired-job recovery and `startIngestionRun`.
   - `workers/ingest-simpro.ts`, `ingestEntityPage` runs before the post-write heartbeat error check.
2. Direct reconciliation manifest upserts may affect zero rows under a stale generation while the surrounding transaction can still proceed unless row ownership is asserted.
   - `src/lib/store/reconciliation.ts`, manifest publication around `persistDirectReconciliation`.
3. Reconciliation comparisons read dashboard/source summaries before the publication transaction and are not fully bound to the exact database state that is published.
   - `src/lib/store/reconciliation.ts`, `reconcileQuotes`, `reconcileJobs`, and the later publication transaction.

Do not turn these into owner-facing UI. Fix and test them as backend correctness boundaries.

## 11. Data Architecture and Runtime Behavior

The architecture decision is already made:

- Simpro is the upstream system of record.
- Azure Database for PostgreSQL Flexible Server is the app-owned serving store.
- The app owns normalized snapshots, facts, rollups, read models, freshness, and reconciliation tables.
- Do not depend on preexisting Supabase tables, old mirror views, old caches, old edge functions, or `simpro-sync`.
- "No preexisting tables" meant create/use app-owned storage for this product. It did not mean pull all data live on every dashboard request.
- Dashboard requests and filter changes query app-owned PostgreSQL read models only.
- Changing month, technician, tier, category, or mode must not trigger a broad Simpro fetch.
- Simpro pulls run as bounded background ingestion with persisted queues, rate limiting, continuation, retries, tombstoning, invalidation, and reconciliation.
- Incremental change discovery should run approximately every 15 minutes where the API supports it. Page freshness targets remain roughly 60 minutes for quotes and two hours for jobs/technician facts. Commission results refresh after relevant source/config changes and must disclose their as-of time.
- A one-time bulk export/import is acceptable for historical bootstrap when it is materially faster, followed by incremental ingestion. Reuse the existing bootstrap scripts.
- Do not add a private-network/VNet architecture. Preserve the current production topology unless Asad separately approves a network project.
- The UI may show a quiet `Updated X minutes ago` state. Do not label stale/incomplete data "Live."

## 12. Source Material to Inspect

Read these before designing:

### Core repository and current implementation

- `/Users/asadkaramally/Documents/New project/prostar-metrics-dashboard`
- `src/components/jobs-dashboard.tsx`
- `src/components/quotes/quote-metrics-dashboard.tsx`
- `src/components/technicians-dashboard.tsx`
- `src/components/commissions-dashboard.tsx`
- `src/app/globals.css`
- shared shell, navigation, header, period, KPI, panel, table, chart, pill, empty-state, and loading/error components under `src/components/`
- API/read-model/metric/ingestion code under `src/lib/`, `src/app/api/`, `workers/`, and `scripts/`

### Current plan, useful but contaminated

- `/Users/asadkaramally/Library/CloudStorage/OneDrive-ProStarMechanical/Claude PSM/AI Tools/ProStar_Metrics_Implementation_Plan.md`

Use it for validated metric details, architecture, data contracts, and existing work inventory. Override its rejected UI/process scope using this brief.

### Simpro contract

- `/Users/asadkaramally/Downloads/swagger.json`
- `/Users/asadkaramally/.codex/skills/prostar-simpro/SKILL.md`

Use Swagger and read-only Simpro evidence to resolve technical mappings. There is no quote owner. Do not push discoverable endpoint/field questions back to Asad.

### Genuine prior feature sources

- Quote Activity only:
  `/Users/asadkaramally/Library/CloudStorage/OneDrive-ProStarMechanical/Claude PSM/AI Tools/Quote Dashboard/quote_dashboard.html`
- Technician Commissions and Commission Summary views only:
  `/Users/asadkaramally/Library/CloudStorage/OneDrive-ProStarMechanical/Claude PSM/AI Tools/ProStar Dashboard/prostar-dashboard.html`

Do not carry forward Pending Jobs or any other unrelated view from the second file.

### Visual-language source

- `/Users/asadkaramally/Documents/New project/prostar-metrics-dashboard/redesign-handoff/codex-design-package/`
- `mockups/jobs.CANONICAL.html` and PNG
- `mockups/quotes.html` and PNG
- `mockups/technicians.html` and PNG
- `mockups/commissions.html` and PNG
- `reference-styles.css`
- `fonts/*.woff2`
- `CODEX-DESIGN-IMPLEMENTATION-BRIEF.md`
- `README.txt`

Reuse the visual language and exact low-level values where they serve the newly approved composition. Do not reuse rejected commissions content or the instruction to preserve all existing UI.

### Current browser evidence showing page bloat

- `.work/browser-evidence/candidate/final/jobs-1440.png` - 1440x8517
- `.work/browser-evidence/candidate/final/quotes-1440.png` - 1440x7634
- `.work/browser-evidence/candidate/final-independent/technicians-1440.png` - 1440x6538
- `.work/browser-evidence/candidate/final-independent/commissions-1440.png` - 1440x6463
- Additional viewport captures are under `.work/browser-evidence/candidate/` and `redesign-handoff/screenshots/`.

Inspect these full-size. Do not evaluate only thumbnails or top crops.

## 13. Current Production Reality

As of 2026-07-14:

- Production URL: `https://aca-prostar-metrics-prod.thankfulmushroom-31ebfcb1.westus2.azurecontainerapps.io`
- Tested login entry point: `https://aca-prostar-metrics-prod.thankfulmushroom-31ebfcb1.westus2.azurecontainerapps.io/.auth/login/aad?post_login_redirect_uri=%2Fjobs`
- Azure resource group: `prostar-payroll`
- Container App: `aca-prostar-metrics-prod`
- Current single active/latest-ready revision: `aca-prostar-metrics-prod--0000106`
- Traffic: 100 percent to the latest revision in single-revision mode.
- PostgreSQL server/database: `pg-prostar-metrics-prod` / `prostar_metrics`
- Key Vault: `kv-prostar-metrics-prod`
- Database secret name: `azure-postgres-connection-string`

The bare app returns 401 before an EasyAuth session, which is expected. Reaching Microsoft sign-in is not proof that the product works. Production acceptance requires authenticated route access and use of all four pages as Asad or Laila.

The latest redesign/data corrections were not promoted after the owner identified release-blocking product and technician-data defects. Treat production as an existing baseline, not as completion.

Credentials are intentionally not stored in plaintext in the repository. On a trusted local Mac with Azure access, retrieve secrets from Key Vault directly into process environment; never paste them into chat or commit them. A cloud sandbox that cannot reach Azure/PostgreSQL has a network limitation, not a missing-credentials mystery. It may create mockups and work from sanitized exports, but live validation and production release must run from an environment with the required network/auth access.

## 13A. Credential and Access Runbook

Do this access preflight once, at the beginning. Do not wait until implementation or deployment to discover missing access, and do not ask Asad repeatedly for similar permissions.

### Execution environment

- Use Claude Code/Desktop on this Mac, or another trusted local execution environment that can access the absolute source paths, Azure CLI, the local Simpro MCP server, and an authenticated browser.
- Claude's cloud sandbox cannot reach Azure PostgreSQL or Microsoft login and cannot use the Mac's signed-in browser session. Do not spend time trying to solve that with a connection string. Use the local environment for live-data and production work.
- Never paste, print, summarize, log, commit, or place a secret value in a prompt, artifact, screenshot, shell history, or source file.

### Azure control-plane identity

The expected Azure account is:

- User: `asad@prostarmechanical.com`
- Tenant: `515fbfd7-12b1-4238-bb6c-f827588dd488`
- Subscription: `d7a98155-9693-4c6b-ad27-39e945c0f751`
- Resource group: `prostar-payroll`
- Release CLI config: `/Users/asadkaramally/Documents/New project/.work/azure`

On 2026-07-14 both the default Azure CLI profile and the release profile were signed into that exact enabled subscription. Recheck without printing tokens:

```bash
export AZURE_CONFIG_DIR="/Users/asadkaramally/Documents/New project/.work/azure"
az account show --query '{user:user.name,tenantId:tenantId,subscription:id,state:state}' -o json
az account set --subscription d7a98155-9693-4c6b-ad27-39e945c0f751
```

If the session has expired, use interactive device login. Never request Asad's password or MFA code:

```bash
az login --tenant 515fbfd7-12b1-4238-bb6c-f827588dd488 --use-device-code
az account set --subscription d7a98155-9693-4c6b-ad27-39e945c0f751
```

The signed-in user currently has Azure subscription Owner/User Access Administrator control-plane rights. That does not automatically grant Key Vault data-plane access.

### Production Key Vault and secret inventory

Vault: `kv-prostar-metrics-prod`

Required runtime secret names:

| Secret | Purpose | Who should consume it |
|---|---|---|
| `azure-postgres-connection-string` | App-owned PostgreSQL serving connection | Container App/jobs through managed-identity Key Vault references; trusted local validation only when specifically required |
| `simpro-bearer-token` | Direct dashboard ingestion from Simpro | Container App jobs through managed identity; local direct scripts only if the MCP path is unavailable |
| `microsoft-provider-authentication-secret` | Entra EasyAuth app registration secret | Container App EasyAuth only; Claude does not need to read it |
| `postgres-ssl-ca-cert-base64` | Optional PostgreSQL CA bundle | Runtime/migration process only when `includePostgresSslCaCertSecret=true`; current production parameters set it false |

The current Asad Azure CLI principal was explicitly tested on 2026-07-14 and receives `ForbiddenByRbac` for both Key Vault secret metadata/value access and Key Vault key reads. Therefore this command is not currently a valid credential solution:

```bash
az keyvault secret show --vault-name kv-prostar-metrics-prod --name azure-postgres-connection-string
```

Do not repeatedly retry it or claim the secret is missing. The issue is Key Vault data-plane RBAC.

The application and scheduled jobs already consume the runtime secrets through the existing managed identity `id-prostar-dispatch-prod`; no human secret read is needed for normal production runtime.

### Local PostgreSQL access

- Local dashboard/database scripts expect `AZURE_POSTGRES_CONNECTION_STRING`.
- The guarded production deploy expects the privileged value under the separate variable `AZURE_POSTGRES_MIGRATION_CONNECTION_STRING` and deletes it from the parent process after loading it.
- TLS verification must remain enabled. Never use `NODE_TLS_REJECT_UNAUTHORIZED=0` or disable PostgreSQL certificate verification.
- Direct access may also require a temporary source-IP firewall rule. Do not make a permanent broad firewall change. The guarded deploy creates and removes its own exact temporary rule.
- Do not assume the runtime app connection is migration-capable. Confirm the intended migration credential securely before release. If the existing Key Vault database secret is the approved migration credential, load the same value under the migration variable without displaying it. Otherwise Asad must securely inject the dedicated migration connection into the trusted local process.

Safe pattern after the required narrow access exists:

```bash
export AZURE_POSTGRES_CONNECTION_STRING="$(az keyvault secret show \
  --vault-name kv-prostar-metrics-prod \
  --name azure-postgres-connection-string \
  --query value -o tsv)"

# Use only if this exact credential is confirmed as the approved migration credential.
export AZURE_POSTGRES_MIGRATION_CONNECTION_STRING="$AZURE_POSTGRES_CONNECTION_STRING"
```

Unset both variables when the operation completes. Never echo them.

### Simpro access

Preferred local access requires no token handoff:

- MCP server: `prostar-simpro`
- Server entry point: `/Users/asadkaramally/Documents/New project/mcp/prostar-simpro-mcp/src/server.mjs`
- Skill: `/Users/asadkaramally/.codex/skills/prostar-simpro/SKILL.md`
- The MCP server loads its existing local environment file internally. Do not open, print, copy, or paste the token.
- Start with the MCP `simpro_health` tool, which verifies configuration without exposing secrets.
- Use read-only MCP operations for source validation. Do not perform Simpro writes for dashboard work.

For repository ingestion scripts, the equivalent environment is:

```text
SIMPRO_BASE_URL=https://prostarmechanical.simprosuite.com/api/v1.0
SIMPRO_COMPANY_ID=0
SIMPRO_BEARER_TOKEN=<secret>
SIMPRO_REQUESTS_PER_SECOND=5
```

The bearer token is available to production through Key Vault and to the local MCP through its existing private environment. Claude should not need Asad to paste it.

### Entra/EasyAuth and owner-browser access

- Tenant ID: `515fbfd7-12b1-4238-bb6c-f827588dd488`
- App/client ID: `369bef95-48a6-45db-bad6-1e16278fa229`
- Initial authorized owner emails: `asad@prostarmechanical.com`, `laila@prostarmechanical.com`
- Client secret: Key Vault secret `microsoft-provider-authentication-secret`; do not retrieve it for local design or browser testing.
- Local development may use `METRICS_DEV_AUTH_BYPASS=true` only when `NODE_ENV` is not production.
- Production browser validation must use an existing authenticated Asad/Laila Microsoft session in local Chrome or the in-app browser. If Microsoft requires interaction, ask Asad to complete sign-in once. Never request or store a password, MFA code, cookie, or bearer token.

### ACR, Container Apps, storage, and evidence keys

- Registry: `acrprostardispatchprod`; repository: `prostar-metrics`.
- No registry username/password is required. `az acr build` uses the authenticated Azure CLI identity; production pulls use the existing managed identity.
- Storage account `stprostarmetricsexports` uses managed identity. The rejected owner-facing export UI does not create a need for a storage key.
- Release evidence uses three Key Vault keys: `prostar-release-gate-evidence`, `prostar-release-browser-evidence`, and `prostar-release-reviewer-evidence`.
- Claude never needs the private key material. The dedicated managed identities perform signing. The release orchestrator does need metadata read access to resolve the three versioned key IDs.
- The current Asad CLI principal receives `ForbiddenByRbac` on that key metadata. Before deployment, provide a narrow, temporary non-signing metadata-read assignment such as the existing custom role `ProStar Evidence Public Key Reader`; never grant the human account Crypto User, Crypto Officer, or signing permission.

### One batched access request

At the start, test the following without exposing values:

1. Correct Azure tenant/subscription session.
2. Simpro MCP `simpro_health`.
3. Existing authenticated owner browser session.
4. Ability to query the required production APIs and Container App state.
5. Whether direct PostgreSQL access is actually required for the next phase.
6. Before release, availability of the approved migration connection and metadata-only reads for the three evidence keys.

If anything is missing, make one consolidated request covering all required temporary access for the whole project. The expected narrow grants are:

- secure process injection of the approved migration connection, or temporary `Key Vault Secrets User` on the exact database secret only;
- `ProStar Evidence Public Key Reader` for metadata-only access to the evidence keys during release;
- existing Azure control-plane permission to run ACR build, ARM deployment/what-if, Container Apps operations, monitoring verification, and the guarded temporary PostgreSQL firewall rule;
- one interactive Asad/Laila browser sign-in if no reusable authenticated session exists.

Request Simpro-secret read only if the configured MCP and managed production job paths both fail. Do not request EasyAuth-client-secret read. Record every temporary role-assignment ID when it is created, remove it in a `finally`/cleanup step, verify removal, and unset all sensitive environment variables.

### Production release command

After all mockup, implementation, data, test, and access gates pass, the only authorized routine production release command is:

```bash
npm run deploy:prod
```

Run it from the repository root with `AZURE_POSTGRES_MIGRATION_CONNECTION_STRING` securely loaded. Do not run a separate ACR build, direct Bicep deployment, individual Container App update, ad hoc migration, or manual canary. The orchestrator owns build, migrations, exact app-plus-job deployment, health/auth verification, rollback, and provenance.

## 14. Mandatory Mockup and Approval Phase

Do not change application presentation code before this phase is approved.

Create:

- `redesign-handoff/product-reset/PRODUCT-CONTENT-MAP.md`
- `redesign-handoff/product-reset/MOCKUP-DECISIONS.md`
- `redesign-handoff/product-reset/mockups/jobs.html`
- `redesign-handoff/product-reset/mockups/quotes.html`
- `redesign-handoff/product-reset/mockups/technicians.html`
- `redesign-handoff/product-reset/mockups/commissions.html`
- responsive screenshot evidence under `redesign-handoff/product-reset/screenshots/`

### Content map format

For every proposed element, record:

| Owner question | Metric/visual | Exact cohort/formula | Source/read model | Owner action or decision | Keep/remove rationale |
|---|---|---|---|---|---|

Anything without a clear owner question and decision value is removed.

### Mockup requirements

- Build complete interactive HTML mockups, not wireframes or component fragments.
- Use representative real current data only where it is already trustworthy.
- Do not use a fake technician roster. If roster data remains disputed, use clearly marked structure-only values until the roster is verified, then replace them before approval.
- Include loading, empty, partial/stale, and error treatments without allowing those states to dominate the normal screen.
- Include all intended charts, controls, tabs, drilldowns, and bounded tables.
- Make the mockups responsive at 1440x1000, 1024x768, 768x1024, and 390x844.
- Capture both viewport and full-page screenshots at every target width.
- For Technicians, show the team overview and a selected-technician drilldown state.
- For Commissions, show both the monthly view and the historical Summary state, including representative monthly/quarterly/annual modes.
- Present the 1440 and 390 renderings of every primary screen directly to Asad, with links to all other captures.
- Explain only the small number of consequential product choices. Do not bury the mockups in a long engineering report.

### Approval gate

- Ask all genuine business-policy questions in one batch before or alongside the first mockups. Do not ask questions that Swagger, source code, Simpro, PostgreSQL, or the prior dashboards can answer.
- Record Asad's feedback and revise the mockups.
- Continue until Asad explicitly approves every screen and major alternate state.
- No application implementation begins before approval.

## 15. Implementation Phase

After mockup approval:

1. Save an immutable copy/hash of the approved HTML and screenshots.
2. Create a route-by-route component and data-contract map.
3. Update the contaminated implementation plan and feature-status contract so rejected features are removed and approved screens are authoritative.
4. Reuse existing backend/read-model work wherever its semantics are correct.
5. Fix technician roster/cohort defects before presenting technician economics as valid.
6. Implement shared design tokens and primitives only where they support the approved screens.
7. Implement one route at a time against its approved mockup.
8. Preserve approved filters, calculations, drilldowns, and controls exactly.
9. Remove rejected owner-facing surfaces and their contaminated UI tests. Backend audit/security records may remain.
10. Do not rebuild stable infrastructure, ingestion, auth, or data contracts unnecessarily.

The codebase is Next.js 16, React 19, Tailwind 4, TypeScript, PostgreSQL, and Recharts. Use the existing stack and self-hosted font assets. Do not add a new frontend framework.

## 16. Data Validation Requirements

Rendering is not validation. For every visible metric/chart/table:

- verify the route/API payload;
- trace the value to the exact PostgreSQL facts/read model;
- reconcile aggregates and selected records to read-only Simpro source evidence;
- confirm period, timezone, stage, acceptance, and cohort semantics;
- verify chart labels and tooltip values against the payload;
- prove no unsupported value is rendered as zero;
- prove filters change only the intended cohort;
- prove changing filters does not trigger a broad live Simpro pull;
- verify historical windows, prior-month, prior-year, rolling, and partial-month math;
- verify real technician names and effective roster membership;
- verify July 2026 technician work/economics specifically;
- verify quote-linked and recurring labor efficiency separately;
- verify capacity from 8:30-5:00 defaults plus supported exceptions;
- verify calculated commissions conserve the configured pool as intended and respond functionally to efficiency controls;
- verify the UI never implies calculated commission was paid.

Use independent source queries/tests rather than repeating the serving algorithm as the validator.

## 17. Visual and Functional Validation

For each approved screen and major state:

- run the actual application in a real browser;
- authenticate where the route requires it;
- capture 1440x1000, 1024x768, 768x1024, and 390x844 viewport and full-page images;
- overlay/diff each implementation capture against the approved mockup;
- inspect the full-resolution image manually;
- verify all charts contain nonblank pixels and expected labels/series;
- verify no horizontal overflow, clipping, overlap, accidental scroll region, truncated text, or unstable layout;
- verify control states, filters, tabs, drawers, drilldowns, and empty/error states;
- verify keyboard navigation, visible focus, screen-reader names, semantic state labels, and useful touch targets;
- verify responsive composition rather than simple stacking;
- verify real values fit, including long technician/customer/site/job names and large currency values.

Do not claim pixel-perfect completion based on tests, DOM snapshots, a thumbnail, or one viewport.

## 18. Engineering Verification

At minimum, rerun and pass:

```bash
npm test
npm run test:integration
npm exec -- tsc --noEmit --pretty false
npm run lint -- --max-warnings=0
npm run build
npm run plan:check
npm run reference:check
npm run guard:no-mirror
```

The prior reported baseline was 769 unit/component tests and 275 integration assertions passing, plus TypeScript, lint, and build. That baseline is useful but not proof of product correctness because some tests encode rejected UI and defective cohort assumptions. Rerun from the actual takeover state and report exact results.

## 19. Production Release Completion

The project is complete only when all of the following are true:

- Asad explicitly approved every mockup and the implemented screens match them exactly.
- All four required pages are complete and use real app-owned production data.
- The actual technician roster and July 2026 attribution defects are corrected and independently reconciled.
- Every owner-visible metric has proven semantics and source evidence.
- No rejected lifecycle/audit/export/diagnostics/admin clutter remains in the owner UI.
- No known P1 data-integrity or release blocker remains.
- Automated, data, browser, visual, accessibility, and responsive validation pass.
- A candidate production revision is tested before traffic promotion.
- The real production URL and correct login URL are opened and tested, not merely printed.
- Asad and Laila can authenticate and use all four production routes.
- Production charts render real data and match the validated API/read models.
- Freshness is truthful and broad Simpro fan-out never occurs on page/filter requests.
- Rollback is available and the prior revision remains recoverable during cutover.
- Final production screenshots and reconciliation evidence are retained.
- Asad performs final owner acceptance on the live product.

Do not call the project done because code exists, tests pass, a deployment command succeeded, or Microsoft sign-in appeared.

## 20. Working and Communication Rules

- Start by inspecting the product and sources, not by trusting a prior status summary.
- State what is known, what is inferred, and what is still unverified.
- Resolve technical questions yourself from the repo, Swagger, Simpro, PostgreSQL, Azure, and browser evidence.
- Batch any unavoidable owner questions. Do not repeatedly interrupt for similar permissions.
- Never fabricate a blocker such as "if Simpro fields can be mapped" when the mapping is technically discoverable.
- Never silently remove a required page or visualization.
- Never silently preserve an invented feature.
- Do not present scaffolds or outlines as finished product work.
- Do not symptom-patch the current screens. Redesign the page composition from the owner questions and approved mockups.
- Keep progress tied to release outcomes: approved design, correct data, implemented screen, validated route, deployed candidate, authenticated production proof.
- Do not spend days adding generic hardening while owner-visible blockers remain.
- Do not give Asad an untested URL.
- At each gate, provide evidence concise enough to review, then continue when approved.

## Immediate Next Action

Read every source listed above, open the current local and production screens in a real browser, inspect the full-page evidence, verify the existing data contracts, and produce the content map plus complete first-round mockups. Do not edit the application UI before showing those mockups to Asad.

# Pro Star Metrics: Claude Design Visual Handoff

## Preflight: No Credentials Or Live Data Required

Start this assignment from the repository source, existing component tests/fixtures, and the supplied baseline screenshots. **Do not perform a credential search or a production connectivity investigation.** A failed Azure, PostgreSQL, Simpro, Key Vault, or production-API connection is expected in a cloud sandbox and does not block any required work in this handoff.

If you already attempted a production connection, stop that investigation now and continue the frontend redesign. Do not return a credentials or network-access blocker. Codex will render and validate the completed frontend against authenticated production data after integration.

## Assignment

You are the senior product designer and frontend design engineer for Pro Star Metrics, an authenticated operational dashboard used by the two owners of a midsize HVAC and water-heating company. Improve the visual design and frontend usability to a genuinely polished, professional standard while preserving every existing feature, metric, business rule, data state, and workflow.

This is not a concept exercise. Inspect the current application, implement the visual improvements in the existing Next.js codebase, and verify the result at desktop and mobile sizes. The result should feel like a serious owner/operator system used repeatedly throughout the week, not a marketing site, template gallery, or generic SaaS demo.

Repository:

`/Users/asadkaramally/Documents/New project/prostar-metrics-dashboard`

Primary routes:

- `/quotes`
- `/jobs`
- `/technicians`
- `/commissions`

## Hard Boundary: Frontend Only

Do not make backend, data-contract, metric, security, infrastructure, or deployment changes. This boundary is absolute.

You do not need and must not search for, request, expose, or attempt to use production credentials. Do not connect to Azure PostgreSQL, Azure Key Vault, Simpro, Azure CLI, or any production API. Lack of production-network access is expected and is not a blocker to this assignment. Codex owns all authenticated live-data execution, browser reconciliation, deployment, and production validation after your frontend changes are returned.

You may edit presentation-layer files such as:

- `src/app/globals.css`
- route `loading.tsx` and `error.tsx` presentation
- `src/components/app-shell.tsx`
- `src/components/mobile-nav.tsx`
- `src/components/dashboard-page.tsx`
- `src/components/period-selector.tsx`
- `src/components/freshness-banner.tsx`
- `src/components/kpi-card.tsx`
- presentation markup in `src/components/data-health-drawer.tsx`
- `src/components/quotes/quote-metrics-dashboard.tsx`
- `src/components/jobs-dashboard.tsx`
- `src/components/technicians-dashboard.tsx`
- `src/components/commissions-dashboard.tsx`
- new reusable presentation-only components under `src/components/`

Do not edit:

- `infra/**`
- `workers/**`
- `scripts/**`
- `src/lib/store/**`
- `src/lib/simpro/**`
- `src/lib/metrics/**`
- `src/app/api/**`
- authentication or authorization code
- database migrations, queries, schemas, queue behavior, reconciliation, ingestion, or release tooling
- package dependencies unless Codex explicitly approves them first

Do not rename, remove, reinterpret, recompute, merge, or invent metrics. Do not add mocked values or fallback business values. Do not change URL parameters, API payloads, form submissions, mutation semantics, exports, audit behavior, commission lifecycle behavior, data freshness logic, loading logic, empty-state truthfulness, or error handling. Visual grouping and progressive disclosure are allowed only when every current feature remains discoverable and usable.

If a desired improvement appears to require new data or a changed contract, document it separately as a future idea and do not implement it.

## Business Semantics That Must Remain Visible And Correct

- Completed jobs use `CompletedDate` in the selected month and `Stage` exactly `Complete` or `Archived`. Job Status is never completion evidence.
- Quote acceptance uses exact accepted-online evidence or a real direct/inverse quote-to-job relationship. `JobNo` equality is never acceptance evidence. An active exclusion wins.
- Quotes without acceptance evidence are `Not Accepted`; there is no quote-owner, salesperson, open-quote, or quote-Stage KPI.
- Quote categories come only from configured cost-center IDs. Missing or unsupported mappings remain `Unclassified`.
- Net profit is distinct from gross profit and should receive at least equal visual prominence. Simpro commission-cost fields are not proof of technician commission payout.
- Quote-generated labor efficiency and recurring-job labor efficiency are distinct views.
- Technician utilization is productive supported job hours divided by all positive recorded hours.
- Capacity utilization is a separate metric based on weekday availability, with the default schedule of 8:30 AM to 5:00 PM and eight productive hours after lunch unless source availability overrides it.
- Commission calculated due is a functioning owner workflow. Never imply that an exported or calculated amount has already been paid.
- Freshness, coverage, provisional periods, exclusions, unavailable values, reconciliation, and source gaps are factual states, not decorative warnings. `N/A` must never become zero.

## Current Frontend And Reference Material

The application currently uses Next.js 16, React 19, Tailwind CSS 4, Recharts, and Lucide icons. Use those existing tools. Do not add a second design system or chart library.

The current visual system is mostly inline Tailwind classes with a small token set in `src/app/globals.css`. The core brand colors are navy `#123a63`, deep navy `#08233f`, and red `#c73f2f`. Retain recognizable Pro Star identity, but introduce a balanced neutral and semantic palette so the interface is not a one-note blue/slate system. Reserve red, amber, and green for meaningful states.

Last live-page screenshots are the required visual baseline for this assignment:

- `.work/browser-evidence/final-current-quotes.png`
- `.work/browser-evidence/final-current-jobs.png`
- `.work/browser-evidence/final-current-technicians.png`
- `.work/browser-evidence/final-current-commissions.png`

These screenshots show the previously deployed revision and are visual references only. The current presentation source code is authoritative and may already differ. Inspect both. Do not block on capturing a new database-backed baseline and do not attempt to obtain credentials to do so.

Existing prior-dashboard references that informed the feature set are:

- `docs/prostar-metrics/reference/quote-dashboard.html`
- `docs/prostar-metrics/reference/commissions-dashboard.html`

Do not copy their outdated structure blindly. Preserve the useful feature coverage while raising the visual and interaction quality.

## Design Objective

Design for owners who need to answer, quickly and accurately:

1. What changed this month, and is the current period complete or provisional?
2. Are quote volume, acceptance, completed work, revenue, net profit, labor performance, and capacity moving in the right direction?
3. Where are the exceptions that require attention now?
4. Which customers, sites, categories, cost centers, jobs, and technicians explain the result?
5. Is the data sufficiently current and complete to trust the decision?
6. For commissions, what state is the worksheet in and what owner action is available next?

The first viewport should prioritize decision-making, not methodology prose. Keep source coverage and methodology truthful and easy to reach, but compress repetitive explanation into well-labeled status treatments, concise annotations, disclosures, or lower-page reference sections. Never hide a material data-quality warning.

## Required Visual Improvements

### 1. Shared owner-facing hierarchy

- Establish a consistent page structure across all four routes: compact page context, period and freshness controls, headline KPIs, exceptions/attention, trends/comparisons, segment analysis, then record-level drilldown and methodology.
- Make the selected period and data state immediately legible without dominating the header.
- Make current, provisional, building, stale, suspect, failed, and missing states visually distinct using icon, label, and color rather than color alone.
- Use tabular numerals for financial values, counts, hours, rates, and comparison deltas.
- Standardize panel headers, chart legends, tooltips, table density, badges, filter bars, empty states, and loading skeletons.
- Keep cards at 8px radius or less. Do not place cards inside cards or turn whole page sections into floating card stacks.
- Reduce unnecessary vertical whitespace and repeated instructional copy. This is a working dashboard, so optimize for scanning and repeated use.
- Preserve strong keyboard focus and clear hover/pressed/disabled states.

### 2. Navigation and context

- Give desktop navigation a clear active-route state and improve scanability without making the sidebar visually heavy.
- Keep mobile navigation compact, obvious, keyboard accessible, and non-overlapping with the data-health control.
- Keep the owner identity understated.
- Ensure data health is always discoverable but does not obscure page controls or content.
- Do not create a landing page. The first screen must remain the usable dashboard.

### 3. KPI presentation

- Create a reusable KPI treatment with disciplined label, value, comparison, coverage/context, and optional status affordances.
- Rank metrics by owner importance rather than presenting every value with equal weight.
- Use semantic deltas carefully: a higher value is not automatically good for costs, labor variance, late arrival, excluded jobs, or loss-making jobs.
- Do not show trend arrows where directionality is ambiguous.
- Keep exact values available; compact `$222K` treatments may be used for overview only when the exact value remains accessible in context.

### 4. Charts

- Improve chart hierarchy, labeling, legends, tooltips, axes, target/reference lines where existing data already supports them, and empty-state behavior.
- Use stable chart heights and responsive containers so loading, legends, or long names never shift the layout.
- Avoid rainbow palettes. Use a restrained categorical palette with sufficient contrast and consistent meaning across routes.
- Use direct labels or clear legends. Never rely on color alone.
- Make charts answer a specific owner question; supporting explanation should be concise.
- Preserve every existing chart and analytic view unless the same information is presented more effectively with no loss of capability. Document any consolidation explicitly.

### 5. Tables and drilldowns

- Improve dense-table readability with consistent alignment, tabular numbers, sticky headers where helpful, restrained row separators, clear selected/expanded rows, and intentional horizontal scrolling on mobile.
- Keep important identity columns visible where practical.
- Make row actions obvious through familiar Lucide icons and tooltips.
- Preserve all filters, pagination, expansion, override history, audit history, exports, and record-level evidence.
- Do not solve mobile tables by deleting columns or hiding facts without an accessible way to reveal them.

### 6. Responsive behavior

- Design and verify at minimum at 1440x1000, 1024x768, 768x1024, and 390x844.
- No overlapping text, controls, data-health trigger, navigation, tooltips, chart labels, legends, or tables.
- Long technician, customer, site, category, and quote names must truncate or wrap intentionally with the full value still accessible.
- Controls need stable dimensions and must not resize when labels, loading text, or values change.
- Mobile should preserve an owner-usable hierarchy rather than merely stacking every desktop panel into an excessively long undifferentiated page.

## Route-Specific Priorities

### Quote Metrics

- Lead with selected-period quote activity, count and value acceptance, quote value, accepted value, and average accepted deal, with clear prior-month and prior-year context.
- Compress the large current/prior snapshot into a more scannable comparison without removing selected month, prior month, same-day prior year, full prior year, pace, or stable trailing context.
- Give acceptance trends, tier/category performance, largest Not Accepted quotes, and acceptance evidence a clear decision hierarchy.
- Keep active exclusions, classification evidence, audit history, and exclusion/reinstatement controls fully functional.
- Keep `Unclassified` coverage visible without letting the warning consume the whole first viewport.

### Job Metrics

- Make net profit and net margin primary owner metrics. Keep gross profit/margin as complementary, not substituted, values.
- Keep completed jobs, total sell value, average job value, net profit per actual hour, loss-making jobs, labor variance, and coverage easy to scan.
- Preserve every current trend, profit bridge, margin distribution, source analysis, category/cost-center analysis, customer/site profitability view, and completed-job drilldown.
- Make Category, Cost Center, and Technician filters compact and clearly active; preserve their current URL/form behavior.
- Keep the `CompletedDate + Complete/Archived Stage` methodology visible but visually subordinate to the operating result unless it is an active warning.

### Technician Performance

- Clearly separate completed-job economics, productive-time utilization, capacity utilization, quote-generated labor efficiency, recurring-job labor efficiency, on-time arrival, and schedule variance.
- Never visually conflate utilization and capacity utilization.
- Preserve technician filter, team view, individual detail, trend/history, reconciliation/coverage, heatmap, allocation, leaderboard, and drilldown behavior.
- Make under-capacity, low-efficiency, late-arrival, or loss-contribution exceptions easy to find using only thresholds already present in the model. Do not invent targets.
- Prefer net-profit allocation over gross-profit-only storytelling while preserving both available values.

### Technician Commissions

- Treat this as an owner control surface, not just a reporting page.
- Give worksheet state, source completeness, current revision/run, and the next valid action a strong, unambiguous hierarchy.
- Preserve rebuild, review, lock, configuration, roster inclusion, technician details, overrides, exports, revision history, audit history, and monthly/quarterly/annual summaries.
- Clearly distinguish work value, commission pool, final bonus, outside-pool adjustment, and calculated commission due.
- Keep disabled actions understandable, with the existing reason visible.
- Make configuration and override areas feel deliberate and high trust; use strong grouping and confirmation cues without changing any command behavior.
- Never label calculated or exported amounts as paid.

## States That Must Be Designed, Not Ignored

For every route, verify and visually handle:

- loading
- complete/current data
- provisional current month
- partial/building data
- stale/suspect data
- failed/missing data
- legitimate zero
- `N/A`/unavailable
- no matching filtered records
- coverage warnings
- permission-disabled controls
- action in progress, success, and failure
- long values and large tables
- mobile navigation and data-health drawer open/closed

Do not replace truthful unavailable states with polished-looking zeros.

## Accessibility And Interaction Requirements

- Meet WCAG 2.2 AA contrast for text, controls, focus indicators, chart annotations, and semantic states.
- Preserve native semantics and useful headings, labels, descriptions, table headers, `aria-current`, live regions, and dialog behavior.
- Every interaction must be keyboard reachable with a visible focus state.
- Icon-only buttons require an accessible name and tooltip/title.
- Charts need a useful adjacent textual summary or accessible equivalent using data already present in the model.
- Respect reduced-motion preferences. Use subtle transitions only where they clarify state; no decorative motion.
- Maintain touch targets of roughly 40px or larger on mobile.

## Process

1. Inspect all current presentation components, route markup, TypeScript read-model types, existing UI tests, and the supplied live-page screenshots. Do not connect to a live or local database.
2. Use the supplied screenshots as the before baseline. A fresh database-backed before capture is not required in your environment.
3. Produce a short visual audit and an explicit component-level change map. Verify that every current feature is accounted for before editing.
4. Implement a coherent shared visual system first, then improve each route without changing its data or behavior.
5. Exercise presentation behavior through existing unit/component tests and any already-available non-production fixture path. Do not add mocked business values to production code and do not make a database connection a prerequisite for completing the redesign.
6. Capture after screenshots at the required viewport sizes only if the existing application can render without production credentials. Otherwise, perform code-level responsive review and clearly identify the visual checks Codex must run against the authenticated deployment after integration.
7. Run the validation commands below.
8. Return a changed-file list, before/after screenshot paths, test results, remaining visual limitations, and a signed-off checklist proving that no backend/data-contract files changed.

Do not deploy. Codex owns integration, data validation, production deployment, and final release evidence.

## Validation Commands

Run at minimum:

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

Where the application can render without production credentials, also run browser checks for all four routes at the required viewports, including:

- no console errors
- no failed application requests
- no horizontal page overflow
- no overlapping or clipped controls/text
- keyboard navigation and visible focus
- mobile navigation and data-health drawer behavior
- loading, empty, unavailable, warning, and error states where fixtures or safe local conditions permit

If database-backed routes cannot render in your environment, report that single environment limitation and continue the full frontend implementation. Do not treat it as a credentials task and do not stop the redesign. Codex will perform the required authenticated live-browser checks after integrating your changes.

## Acceptance Checklist

The handoff is complete only when all are true:

- All four routes look and behave like one coherent professional product.
- The first viewport on each route supports owner decision-making.
- Every existing visualization, table, filter, drilldown, action, export, audit, and status remains present and functional.
- No business term or metric meaning has changed.
- Net profit remains distinct from gross profit and commissions.
- Quote and job completion semantics remain exact.
- Technician utilization, capacity utilization, and labor-efficiency concepts remain distinct.
- Commission actions and calculated-due semantics remain functional and honest.
- Data freshness, provisional periods, coverage gaps, and `N/A` values remain truthful.
- Desktop, tablet, and mobile layouts have no overlap, clipping, or incoherent overflow.
- Accessibility checks pass.
- No prohibited backend, API, data, security, infrastructure, dependency, or deployment file changed.
- Codex receives enough evidence to review and integrate the frontend work without reconstructing what was done.

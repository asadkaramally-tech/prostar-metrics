# PSM Metrics application audit and practical improvement roadmap

> **Follow-up:** Initial local stabilization work is recorded in [`../releases/2026-08-28-stabilization-worklog.md`](../releases/2026-08-28-stabilization-worklog.md). This audit remains the point-in-time record of what was observed before implementation.

**Audit date:** 2026-08-28
**Production URL:** `https://metrics.psm.photos`
**Audit mode:** read-only; no source import, refactor, deployment, deletion, credential rotation, production mutation, or dependency installation was performed
**Intended audience:** owner, maintainer, and future coding agents

## 1. Executive summary

PSM Metrics is a small internal dashboard with a comparatively sophisticated data and release system. Its core shape is sound: a Next.js application reads an app-owned Azure PostgreSQL serving store; bounded background workers read Simpro; Azure Easy Auth protects the application; Azure Container Apps runs the web process and scheduled jobs; Key Vault holds production secrets. A rewrite, microservice migration, database redesign, new alerting platform, or new frontend design system is not justified by this audit.

The urgent problems are trust and authority:

1. The repository in which this audit was requested is empty. The strongest Metrics source is elsewhere, and GitHub's default branch is 71 commits behind the strongest candidate.
2. The signed-in production UI currently reports **7 active data-health alerts, 114 unresolved failed items, 113 dead-lettered items, and a rollup queue with an oldest item around 50 days old**. Quotes are marked suspect; Jobs, Technicians, and Commissions freshness are marked failed. These are observed operational states, not yet diagnosed code defects.
3. The GitHub repository is public, GitHub Pages is enabled, and tracked material contains named people, operational details, Azure resource identifiers, topology, and historical IP addresses. This is verified exposure, not proof that a credential leaked.
4. Governing documentation contradicts itself and the strongest deployment evidence. A careful agent could faithfully follow obsolete instructions, copy an old `.env.local`, or use a one-off infrastructure deployment path that newer guidance forbids.
5. There is no hosted CI or branch protection. The default routine deployment can accept new source without running the full local quality gate. A concrete client-side injection path also exists in chart tooltip HTML.

The practical response is controlled stabilization:

- Preserve all candidate checkouts and evidence before changing branches, visibility, or files.
- Bind the maintained Git commit, build-context hash, image digest, Azure revision, and live traffic state in one sanitized release receipt.
- Trace and resolve the production data-health failures, starting with commission/payroll and financial pages.
- Scan the full public history and worktrees for secrets and inappropriate operational data; then let the owner decide repository visibility and Pages.
- Establish a clean-clone test baseline, add read-only CI, and require a SHA-bound gate before routine production deployment.
- Fix the small set of verified security, accessibility, concurrency, and mobile defects.
- Replace competing authority documents with a short authority index and current runbook.
- Split large modules only when they are being changed and only behind behavior-parity tests.

## 2. Evidence labels used in this report

To avoid turning suspicion into fact, every finding belongs to one of these classes:

- **Verified fact:** confirmed from Git, source, configuration, a deployment artifact, GitHub's read-only API, or authenticated live UI.
- **Observed production condition:** displayed by the live application, but root cause is not yet diagnosed.
- **Verified defect:** a reproducible source or UX problem with a concrete failure mechanism.
- **Documented but not re-replicated:** asserted by an older document or receipt, not independently exercised during this audit.
- **Concrete risk:** a plausible failure with source/configuration evidence, but no observed incident.
- **Unknown:** requires authorized cloud access, a clean environment, owner input, or an actual drill.

An unauthenticated in-app browser reaching Microsoft sign-in is expected behavior, not a defect. Missing `node_modules`/`tsx` means tests were not executable in that checkout, not that the source tests failed. One clean page console does not establish site-wide console health.

## 3. Repository, copy, and release inventory

### 3.1 Requested workspace

`/Users/asadkaramally/Documents/ChatGPT/PSM Metrics APP` was an empty Git repository at audit start: no commits, remote, application files, branches, or stashes. This report is the only added artifact. No application source should be copied here until the source-of-truth decision and preservation work are complete.

The nearby `PSM Web App` repository is a different product (`ops.psm.photos`, repository `prostar-quote-workflow`) and must not be treated as a Metrics source.

### 3.2 Metrics source candidates

| Candidate | State | Assessment |
|---|---|---|
| `Documents/Codex/2026-07-27/prostar-metrics` | Branch `redesign/approved-mockups-2026-07-20`, commit `7571b13`; matches origin; only generated/install drift in `next-env.d.ts` and `package-lock.json`; ignored `.env.local` and `.next` | Strongest clean tracked candidate |
| `Documents/Codex/2026-07-20/i/work/prostar-metrics` | Same commit, but four modified tracked files, 18 untracked prototypes/design items, ignored deployment/evidence records | Preserve; valuable deployment evidence and unfinished overlays |
| `Documents/Codex/2026-07-20/prostar-metrics-restyle` | Commit `ea36447`, 40 commits behind; dirty Materials work and untracked screenshots/components | Preserve; historical/unfinished work, not baseline |
| `.../prostar-metrics-release-1d981b5` | Clean linked worktree, one commit behind `7571b13` | Release-era reference, not newest baseline |

Two dirty repositories contain unreachable stash-structure commits after lost stash refs. No deletion or garbage collection should occur until those objects and all dirty/untracked overlays are exported with hashes.

### 3.3 GitHub and release facts

- Remote: `asadkaramally-tech/prostar-metrics`.
- Repository is currently **public** and non-archived.
- GitHub Pages is public from `main` root.
- Default `main` is `105f33e` and is a strict ancestor, 71 commits behind `7571b13`.
- `main` and the redesign branch are unprotected.
- No repository-owned CI workflows, open issues, or open pull requests were found. GitHub's dynamic Pages deployment is the only reported workflow.
- The tracked tree is about 136.75 MB. `redesign-handoff/` is about 104.65 MB; 99 tracked PNGs total about 97 MB; the Simpro Swagger artifact is about 23.9 MB. Historical visual evidence dominates the maintained checkout.
- A preserved deployment manifest records healthy revision `aca-prostar-metrics-prod--0000152`, 100% traffic, image digest `sha256:074bf8...090b7`, and Docker context SHA `202c4d8b...eef0` on 2026-07-23.
- Independently exporting clean commit `7571b13` and running the repository's Docker-context hash produced that exact context SHA and 815 entries. This strongly binds commit `7571b13` to revision 152's build input.
- The manifest does not itself record the Git commit. A follow-up read-only Azure Portal check on 2026-08-28 confirmed revision 152 is the sole active revision, Running, with 100% traffic and 1/1 replicas. Combined with the exact build-context match, `7571b13` is now the verified deployed-source baseline. The image digest is bound through the immutable revision's manifest rather than independently re-read from the portal.
- `DEPLOY.md` still calls revision 124 / commit `64574fd` current. That statement is stale relative to the later manifest.

## 4. Live sitemap and owner workflows

The authenticated Chrome session was used page by page. The shell showed the signed-in owner/admin identity. `/` redirects to `/quotes`.

| Route | Navigation | Purpose and principal workflow | Observed state on 2026-08-28 |
|---|---|---|---|
| `/quotes` | Primary | Month selection; quote KPIs, trend, deal-size analysis, heatmap, monthly breakdown, CSV, and classification/exclusion review | Updated label said 36 days ago; reconciliation and source coverage marked suspect for `quotes` and `quote_nested` |
| `/jobs` | Primary | Month selection; revenue/profit/margin, trend, revenue allocation, work-source analysis, hours variance, site/category profitability, job detail/filter/pagination, CSV | Financial data rendered; updated label said 36 days ago; Data Health marked Jobs freshness failed |
| `/materials` | Primary | Month/range material usage and cost, category analysis, item-to-job drilldown, CSV | Header said updated about 3 hours ago/data current through Aug 28, while a second warning said selected-period coverage missing and current-month KPIs were `N/A` |
| `/technicians` | Primary | Utilization, recorded-time split, labor efficiency, punctuality, sortable scorecard, technician drilldown, profit allocation | Data rendered; updated label said 36 days ago; Data Health marked freshness failed |
| `/commissions` | Primary | Commission period, worksheet/summary, technician allocations, lifecycle/config/export operations by role | August calculation still building; latest ingestion failed; amounts correctly withheld rather than shown as `$0` |
| `/today` | Hidden from primary nav | Live-month pace for revenue, jobs, quotes, pool, capacity and comparisons | Route works; it repeats stale/failed Jobs and suspect Quotes state. Owner must decide whether this hidden route remains wanted |

Shared owner workflow:

1. Sign in through Microsoft Entra/Easy Auth.
2. Select a Pacific-time month.
3. Review summarized read-model data and freshness status.
4. Drill into rows/charts; download CSV where provided.
5. Open the Data Health drawer for pipeline details.
6. Admins can queue a bounded record/period refresh; commission roles can use guarded lifecycle/config/override/export actions.

### 4.1 Live Data Health evidence

The expanded production drawer reported:

- Overall state: Critical; 7 active alerts.
- 13 queued, 114 failed, 113 dead-lettered.
- Rollup queue: 3 queued; oldest about 50 days 18 hours.
- Historical backfill: 340/344 required source-month units, 42/43 months, 98.8%.
- Quotes freshness: suspect; 33.3% source coverage.
- Jobs freshness: failed; 20% source coverage.
- Technician freshness: failed; 33.3% source coverage.
- Commission freshness: failed; 16.7% source coverage.
- A commission integrity run refused publication because `source_complete` was false.
- Many dead letters said a technician rollup for `2026-09-01` could not be queued.
- Reconciliation rows said Jobs, Quotes, and Technicians matched with `$0.00` discrepancy, but Jobs/Technicians reconciliation timestamps were from July while freshness was failing in August.

This is evidence that the application's fail-closed health and commission controls are working visibly. It is also an urgent operational trust issue. The audit does not yet establish whether the cause is scheduling, queue deduplication, period-boundary handling, source availability, or bad data.

## 5. Architecture and data flow

```text
Simpro (business source of truth)
        |
        | bounded, GET-only background readers; rate limit/retry/budgets
        v
Container Apps jobs/workers (ingest, normalize, reconcile, roll up, backfill)
        |
        v
Azure PostgreSQL (app-owned snapshots, queues, audit, read models)
        |
        +--> Next.js Server Components / API routes --> authenticated browser
        |
        +--> commission export blobs

Entra/Easy Auth --> request identity/role policy
Key Vault + managed identity --> runtime secrets
Azure Monitor/Log Analytics/App Insights --> owner alerts and operational telemetry
ACR + deploy orchestrator --> digest-pinned app and job revisions
```

### Frontend

- Next.js 16 / React 19, seven page routes, a shared authenticated shell, six loading/error boundaries.
- Primary pages are thin async Server Components. They validate the month, use 60–120 second server caches, query PostgreSQL read models, and pass typed models to client dashboards.
- Browser requests are interaction-scoped: full job cohort, material item-to-job detail, commission allocation detail, quote overrides, and admin health refresh operations.
- 56 TSX components, 29 client components. The active visual family is primarily `reset/`, `band/`, and `charts/`; an older `ui/` family partly remains.
- Large dashboards: Jobs 1,941 lines, Commissions 1,570, Technicians 1,399, Quotes 1,067, Data Health 824. `globals.css` is 1,339 lines with order-sensitive legacy and redesign layers.

### Backend and database

- 19 API route files: session, health, dashboard reads, job/material detail and CSV, quote overrides, commission allocations/config/overrides/lifecycle/rebuild/exports, and bounded data refresh.
- `/api/health` is public and configuration/database-oriented; dashboard routes require admin/finance, with narrower role rules for writes. Production auth fails closed; local bypass is disabled in production.
- The app reads its PostgreSQL serving store at request time. It does not perform broad request-time Simpro pulls.
- 51 ordered, SHA-tracked, forward-only migrations (`001`–`039`, then `041`–`052`; no `040` file). Migrations use an advisory lock and a transaction per file.
- Schema families cover source snapshots, normalized facts, read models, freshness, queues/watermarks, reconciliation/backfill, commissions, materials, telemetry, and leases.
- Documentation calls some snapshot tables duplicates to retire, but current code still reads/writes them. They are not dead and must not be removed until a consumer graph reaches zero.

### Workers and schedules

Infrastructure source and tests define an exact 24 Container Apps jobs across bounded ingestion, log ingestion, reconciliation, rollups, backfill, health, materials, and commissions. These are scheduled job definitions, not 24 independently owned microservices. `DEPLOY.md` says 23 in one place; source and current infra documentation say 24.

## 6. Dependencies and integrations

| Dependency/integration | Role | Authority/boundary | Audit note |
|---|---|---|---|
| Simpro | Quotes, jobs, people, schedules, time, costs/materials | Business source of truth; bounded direct background readers only | No browser/operator-UI/mirror fallback; no broad request-time reads |
| Azure PostgreSQL | Serving store, snapshots, queues, read models, commission audit | App-owned operational store, not business truth | 35-day backup retention declared; actual restore evidence unknown |
| Entra / Easy Auth | Authentication | Request identity; app maps email allowlists to roles | Expected Microsoft sign-in in fresh browser |
| Key Vault + managed identity | Runtime secret delivery | Production secret authority | Old docs telling agents to copy `.env.local` conflict with this |
| Azure Blob Storage | Commission exports and release-evidence handoffs | App-owned artifacts | Commission storage is LRS; soft delete/lifecycle are not an independent regional backup |
| Azure Container Apps / ACR | Web and jobs; image registry | Deployment runtime | Output images are digest-pinned; base image is not digest-pinned |
| Azure Monitor / Log Analytics / App Insights | Health, performance, job, DB, and dead-letter alerts | Operations telemetry | Alert acceptance exists in design; inbox receipt was not verified |
| GitHub / Pages | Source hosting and static Pages | Currently public | Visibility and Pages need owner review |

No inbound application webhooks and no direct Graph/customer-email composer were found. Do not add Slack, SMS, Sentry, webhooks, or an incident platform without a demonstrated owner need.

## 7. Notification and event map

The application does not send business emails. Alerts flow through one Azure Monitor action group to two configured recipients (currently documented as Asad and Laila) using the Azure common alert schema.

Alert families:

- Web: 5xx rate and p95 latency.
- Jobs: failure alert for each defined Container Apps job.
- PostgreSQL: CPU, memory, storage warning/critical, connections, failed connections, deadlocks, liveness, long query, and backup capacity.
- Storage: failed transactions.
- Pipeline: operational warning/critical, three consecutive ingestion failures, immediate dead-letter.

Application-level operational telemetry uses a stable unique `event_key`, pending lease/attempt state, stdout emission, and delivered acknowledgement. Azure Monitor can still repeat an alert while a condition remains active. A synthetic action-group test proves Azure accepted a test notification; it does not prove inbox delivery, reading, or response ownership. Those remain unknown.

## 8. Credential and configuration register (names only)

Values were not read or recorded. Canonical local names are in `.env.example`; ignored `.env.local` exists in two preserved checkouts; production references are in Bicep/parameter examples and Key Vault documentation.

| Group | Names | Intended owner/source |
|---|---|---|
| PostgreSQL | `AZURE_POSTGRES_CONNECTION_STRING`, `AZURE_POSTGRES_MIGRATION_CONNECTION_STRING`, TLS CA/path/base64 variables, pool/timeouts | Key Vault/runtime; migration value only for guarded deployment |
| Simpro | `SIMPRO_BASE_URL`, `SIMPRO_COMPANY_ID`, `SIMPRO_BEARER_TOKEN`, rate/timeout/page-size settings | Secret owner + Key Vault for token; nonsecret settings in deployment config |
| Azure identity/storage | `AZURE_CLIENT_ID`, `AZURE_STORAGE_ACCOUNT_NAME`, `COMMISSION_EXPORT_CONTAINER` | Managed identity and deployment outputs |
| Authorization | `METRICS_AUTH_MODE`, `METRICS_ADMIN_EMAILS`, `METRICS_FINANCE_EMAILS`, `METRICS_OPERATOR_EMAILS`, `METRICS_VIEWER_EMAILS` | Owner-approved allowlists; deployment config |
| Local-only | `METRICS_DEV_AUTH_BYPASS` | Developer environment only; prohibited in production |
| Release workstation | `AZURE_CONFIG_DIR`, migration compatibility timeouts/platform | Trusted release session/config; never a copied credential bundle |
| Worker controls | `INGEST_*`, `RECONCILE_*`, `ROLLUP_*`, `BACKFILL_*`, `MATERIALS_*`, queue/replay/audit controls | Job definitions/manual guarded commands; mostly nonsecret bounded controls |
| Release evidence | `RELEASE_*`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP` | Evidence runner/deploy environment; protected artifact storage |

The old instruction to copy `.env.local` should be labeled hazardous historical guidance. Before any removal or rotation, inventory the files without printing values, verify each needed value exists in its canonical store, and run a history/worktree secret scan.

## 9. Findings register

### 9.1 Observed production conditions — urgent diagnosis

| ID | Severity | Finding |
|---|---:|---|
| LIVE-01 | P0 | Seven active health alerts; 114 unresolved failures; 113 dead letters; 50-day-old rollup work |
| LIVE-02 | P0 | Commission freshness failed and August publication was correctly refused because source completeness was false |
| LIVE-03 | P0 | Jobs and Technicians freshness failed; Quotes source coverage suspect |
| LIVE-04 | P1 | Page-level “Updated 36 days ago” coexists with data-through Aug 28, which is confusing even if the fields describe different timestamps |
| LIVE-05 | P1 | Materials says data is current while selected-period coverage is missing and KPIs are unavailable; transparent but easy to misread |
| LIVE-06 | P1 | Backfill remains 98.8% complete (340/344 units; 42/43 months) |

### 9.2 Verified source, security, UX, and process defects

| ID | Severity | Finding |
|---|---:|---|
| SEC-01 | P0 | Public repository and Pages expose internal names/topology/operational evidence; no proof of secret leak |
| SEC-02 | P0 | Dynamic tooltip/heatmap/bullet HTML uses `innerHTML`/`dangerouslySetInnerHTML` with database/Simpro-derived labels, enabling stored/client-side XSS in an authenticated browser |
| REL-01 | P0 | Empty requested repo, stale default branch, multiple dirty copies, fragile ignored deployment receipt, and conflicting live-release docs make source/release authority unsafe |
| REL-02 | P1 | No hosted CI or branch protection; routine deploy may accept new source without full tests/lint/typecheck |
| DOC-01 | P1 | Two large documents claim incompatible authority; stale handoff recommends `.env.local` copying and a forbidden one-off infra path |
| A11Y-01 | P1 | Technician sortable `<th>` elements are mouse-only |
| A11Y-02 | P1 | Commission expandable rows are clickable `<div>` elements without keyboard/disclosure semantics |
| A11Y-03 | P1 | Data Health modal lacks a focus trap despite a separate shared Drawer implementing one |
| A11Y-04 | P1 | Definition tooltips are pointer-only and lack keyboard/screen-reader behavior |
| UI-01 | P1 | Commission allocation fetch state is global across rows; a late response/error for row A can appear on row B |
| UI-02 | P2 | Mobile technician layout can collapse at ~320px; Data Health trigger can collide with horizontally scrolling nav |
| UI-03 | P2 | Materials row and nested button can invoke the same open action twice |
| UI-04 | P2 | Important async saved/loading/error messages lack consistent live-region semantics |

### 9.3 Concrete risks and unknowns

- **Recovery:** 35-day PostgreSQL retention and a bounded PITR script exist, but no durable successful restore receipt was found. RTO/RPO claims remain unproven. Database is single-zone, HA off, geo-backup off, public networking on. That may be proportional if explicitly accepted.
- **Export durability:** commission blob storage is LRS; 30-day soft delete and seven-year lifecycle retention do not protect against every account/region failure. Whether exports are reproducible is an owner/business question.
- **Supply chain:** no secret/dependency workflow; Docker base `node:24-alpine` is mutable; package manager/runtime versions are not pinned in `package.json` or a version file.
- **Testing:** 95/97 focused built-in checks passed; two could not import absent `pg`/`tsx`. Another infra run showed 150/155 assertions, with five environment-caused failures. No clean `npm ci` was performed because it would mutate preservation candidates. Current full green state is unknown.
- **Cloud state:** current revision 152 and 100% traffic were verified read-only in Azure Portal. Job images, migration ledger, rollback digest, actual RBAC, Key Vault references, backup availability, storage settings, and alert delivery remain unverified.
- **Dependency vulnerabilities:** not assessed because locked dependencies were not installed and `npm audit` was not run.

## 10. Monolith and simplification assessment

Keep the application, workers, and PostgreSQL serving store together. The current boundaries are understandable and appropriate for a small internal financial/operational dashboard. Twenty-four scheduled job definitions do not by themselves justify services. Reconciliation, immutable commission calculations, migration controls, rollback, and recovery guardrails can be proportionate because decisions affect finance and payroll.

The repository is nevertheless large and somewhat over-engineered. The best simplification candidate is the separate release-evidence subsystem (three evidence jobs, queues/containers, many role assignments), but only after measuring its operating cost, failure rate, maintenance time, and actual assurance value. Do not remove it on aesthetics alone.

Behavior-preserving split candidates, only as touched:

| Module | Mixed responsibilities | Smallest useful boundary | Required parity proof |
|---|---|---|---|
| `jobs-dashboard.tsx` | Data load state, charts, economics, labor, profitability, filtering/table/detail | Sections plus one `useFullCohort` hook | One request/month dedupe; sort/filter/page/drill parity; visual snapshots |
| `commissions-dashboard.tsx` | Session engine, summary math, worksheet, rows, allocation fetch | Pure commission engine/view models; worksheet/summary/row; per-employee fetch hook | Cent conservation, fail-closed publication, session-only behavior, race regression |
| `technicians-dashboard.tsx` | Derivations, charts, sort, drilldown | Pure view model plus presentation sections | Keyboard sorting/disclosure and calculation parity |
| Quote dashboard | Overrides, KPI/trend, tiers, heatmap, history/CSV | Override controller and independent visual sections | Revision/idempotency and 6/12-column heatmap parity |
| Data Health drawer | Modal, polling, refresh form, many sections | Shared modal shell, polling hook, bounded-work form, sections | Poll only every 5s while open; focus restore/trap; queue action behavior |
| `simpro/normalize.ts` | Multiple entity normalization families | Entity-family pure modules | Fixture parity and unchanged persistence payloads |
| Reconciliation store | Discovery, comparison, persistence, cadence | Phase modules with explicit transaction boundary | SQL/effect order, leases, idempotency, mismatch semantics |
| Commission backend | Config, input, calculation, allocation, export | Domain phases, not services | Immutable-run integrity, cents, audit trail, transaction order |
| Deploy orchestrator | Preflight, build, migrate, deploy, verify, rollback | Internal phase modules with one orchestrator | No external action before gate; exact rollback contract |
| CSS | Tokens/base, shell, shared primitives, page-specific rules | Explicit cascade layers/files | 320/480/768/1024/1440 screenshots before moving order-sensitive selectors |

Do not add a state library or third design system. Confirm via clean build/coverage, then remove the production-orphaned legacy UI cluster (`phase-checklist`, `chart-bits`, `empty-state`, `table-bits`, `dashboard-summary` chain) as one reversible change.

## 11. Phased roadmap

### Phase 0 — Preserve, identify, and restore trust

- Preserve dirty overlays, untracked files, unreachable Git objects, ignored release/monitoring evidence, and an inventory of local credential files.
- Bind Git commit, context hash, image digest, Azure revision, current traffic, migration state, smoke result, and rollback digest.
- Investigate live queue/freshness failures. Prioritize Commission, Jobs, and Quotes according to financial/payroll impact.
- Scan full reachable history, worktrees, and preserved overlays for secrets and inappropriate public operational data; then obtain the visibility/Pages decision.

### Phase 1 — Close direct defects and prove a clean baseline

- Fix HTML injection paths and add malicious-label regression tests.
- Reproduce `npm ci`, focused/full tests, lint, typecheck, build, migration/reference/no-mirror guards in a fresh clone under pinned Node/npm.
- Add read-only CI and branch protection; require a SHA/dependency-bound gate for routine deploy.
- Fix keyboard controls, modal focus, allocation race, and highest-risk mobile layouts with real browser/component tests.

### Phase 2 — Reduce operational ambiguity

- Add one short document authority index, concise `AGENTS.md`, current README/runbook, and generated route/API/job/config register.
- Label old takeover/execution/deploy-handoff/design evidence historical or superseded; preserve rather than rewrite history.
- Record sanitized immutable release receipts and an index/pointer to protected detailed evidence.
- Verify alert inbox delivery and ownership separately from Azure action-group acceptance.
- Perform an owner-authorized PITR/representative-data restore drill if no valid receipt exists; decide export recovery based on reproducibility.

### Phase 3 — Simplify only from measured pain

- Split large modules only when changed and after characterization tests.
- Measure evidence-runner and 24-job cost/failure/maintenance overlap before consolidation.
- Archive heavy historical screenshots/design handoffs with checksums; retain only approved/current mockups and compact regression images in the maintained tree.
- Delete old clones, generated trees, or local credential files only after preservation and explicit owner authorization.

## 12. Stable work queue

Status values are `queued`, `blocked-owner`, or `deferred`. Nothing is implemented.

### P0

**MET-P0-001 — Preserve all source/evidence candidates** (`queued`)
Scope: export patches/untracked manifests and unreachable object bundles for all four candidates; hash and store deployment receipts; inventory `.env.local` paths without values. Reason: every later cleanup/branch action could destroy unique evidence. Dependencies: none. Acceptance: manifest lists path, commit, dirty files, object bundle, evidence hashes, and recovery location. Rollback: preservation is additive; remove only duplicate archives after two verified copies.

**MET-P0-002 — Establish release authority** (`in-progress`)
Scope: current app revision/traffic and the source/context/digest binding are verified; finish the 24 job digests, migration ledger, smoke result, and rollback digest. Reason: docs disagree and default branch is stale. Dependencies: MET-P0-001; authorized read-only Azure/API session. Acceptance: one sanitized signed receipt with all identifiers and any mismatch called out. Rollback: none; read-only.

**MET-P0-003 — Triage live Data Health failures** (`queued`)
Scope: trace 114 failures/113 dead letters, 50-day rollup age, September technician-rollup queue errors, and source coverage to queue rows, worker logs, schedules, and period-boundary logic; do not replay until a bounded repair is approved. Reason: owner-visible metrics are decision-critical. Dependencies: MET-P0-002 and read-only production access. Acceptance: each active alert has root cause, affected periods/pages, data impact, and a bounded repair/verification/rollback plan. Rollback: diagnostic only.

**MET-P0-004 — Validate commission/financial decision safety** (`queued`)
Scope: confirm August commission is not used while incomplete; reconcile representative Jobs/Quotes/Commission totals and freshness contracts through bounded approved readers. Reason: highest business impact. Dependencies: MET-P0-003; owner identifies payroll/financial cutoff. Acceptance: signed period-specific decision of safe/unsafe with source coverage and no published false zero. Rollback: diagnostic only.

**MET-P0-005 — Public-history security review and visibility decision** (`blocked-owner`)
Scope: pinned secret scan over history/worktrees/overlays; inventory tracked names/topology/IPs; check Pages dependency; recommend private/Pages state. Reason: verified public exposure. Dependencies: MET-P0-001. Acceptance: redacted scan receipt, classified exposure list, owner decision; rotate only proven exposed secrets with authorization. Rollback: preserve prior visibility/settings and dependency list before any external change.

**MET-P0-006 — Eliminate dynamic-HTML injection** (`queued`)
Scope: replace raw tooltip/heatmap/bullet dynamic HTML with React/text nodes or a shared escaping boundary; prohibit untrusted `innerHTML`. Reason: authenticated stored/client XSS path. Dependencies: clean baseline branch. Acceptance: markup/event payloads render literally; no created nodes/events; visuals unchanged. Rollback: component-only revert.

### P1

**MET-P1-001 — Reproduce a clean-clone gate** (`queued`)
Scope: pin Node/npm; fresh clone at authority commit; `npm ci`; unit/script/infra tests; lint; typecheck; build; migration/reference/no-mirror guards. Reason: current candidates are preservation copies without installed dependencies. Dependencies: MET-P0-001/002. Acceptance: SHA-bound redacted receipt and categorized failures. Rollback: disposable clone.

**MET-P1-002 — Add hosted read-only CI and protect maintained branch** (`blocked-owner`)
Scope: CI with no production secrets; require install-from-lock, tests, lint/typecheck/build, guards, dependency/secret scans; prohibit force-push/delete. Fast-forward/PR `main` only after green baseline. Reason: default clone is stale and deploy safety is convention-only. Dependencies: MET-P1-001; owner authorizes branch/settings change. Acceptance: required check blocks a failing PR and green exact SHA is mergeable. Rollback: documented temporary rule relaxation; never rewrite preserved history.

**MET-P1-003 — Bind routine deploy to a verified gate** (`queued`)
Scope: routine deploy must require a reusable full certificate for exact source/dependency hashes or run a compact mandatory gate before any Azure/DB action. Reason: sanctioned default can release untested source. Dependencies: MET-P1-001. Acceptance: new/drifted source without certificate fails before external commands; exact certificate passes; emergency bypass explicit/audited. Rollback: retain current path only as time-bounded emergency flag until one successful new flow.

**MET-P1-004 — Accessibility interaction fixes** (`queued`)
Scope: button-based technician sorting and commission disclosure; shared focus-trapped modal; accessible definition tooltips; async status live regions; correct tabs/pressed semantics. Reason: verified keyboard/screen-reader gaps. Dependencies: MET-P1-001. Acceptance: keyboard-only scripted flows, focus restore/trap, Axe, screen-reader name/state assertions. Rollback: isolated component reverts.

**MET-P1-005 — Fix commission allocation request race** (`queued`)
Scope: per-employee status/error or abort/request identity guard. Reason: late A response can contaminate B. Dependencies: focused interaction fixture. Acceptance: deterministic delayed-response test proves no cross-row state. Rollback: component/hook revert.

**MET-P1-006 — Clarify freshness and coverage language** (`queued`)
Scope: define `updated`, data-through, source coverage, reconciliation, and selected-period completeness; display them without apparently conflicting “current” state. Reason: observed owner-facing ambiguity. Dependencies: MET-P0-003 definitions. Acceptance: owner can distinguish pipeline check time from data completeness on every page; incomplete data never looks current without qualification. Rollback: copy/presentation revert.

**MET-P1-007 — Mobile workflow verification and fixes** (`queued`)
Scope: technician recorded-time rows, nav/Data Health collision, modal/table/drill flows at 320/480/768 widths. Reason: source shows concrete narrow-layout risks. Dependencies: MET-P1-001. Acceptance: screenshots plus keyboard/touch workflows; no overlap or collapsed chart track. Rollback: responsive CSS/component revert.

### P2

**MET-P2-001 — Create a concise authority and agent guide** (`queued`)
Scope: one authority index; short `AGENTS.md`; README repo map, exact runtimes, local fixture commands, fast/full gates, source/generated boundaries, and links to deploy/recovery. Mark conflicting documents current/historical/superseded. Reason: current contradiction can cause faithful but dangerous work. Dependencies: MET-P0-002/P1-001. Acceptance: a fresh agent can locate canonical source, run the fast check, and identify forbidden operations in under ten minutes. Rollback: docs-only revert.

**MET-P2-002 — Source-derived route/API/job/config register** (`queued`)
Scope: lightweight script/check that enumerates routes, API methods/auth roles, 24 job names/cadences, and configuration names; check committed snapshot drift. Reason: README/page/job counts already drifted. Dependencies: authoritative branch. Acceptance: removing/adding a route or job fails the drift check until snapshot is updated. Rollback: remove check/snapshot; no runtime effect.

**MET-P2-003 — Durable release and recovery receipts** (`queued`)
Scope: sanitized receipt per release with commit, context hash, digest, revision, target, migration state, smoke, prior digest/rollback; protected detailed artifact pointer/hash. Reason: definitive manifest exists only ignored in one dirty copy. Dependencies: MET-P0-002. Acceptance: source-to-live identity can be reconstructed without a workstation. Rollback: additive.

**MET-P2-004 — Verify restore and export recovery** (`blocked-owner`)
Scope: locate prior PITR receipt; if absent, authorized temporary restore with TLS/schema/migration checks plus representative invariants/hash and elapsed RTO; determine whether commission exports are reproducible. Reason: retention is configured but recovery is unproven. Dependencies: owner approves cost/timing; MET-P0-004. Acceptance: sanitized receipt and explicit accepted RPO/RTO/HA/LRS risk or scoped change. Rollback: guaranteed temporary-resource cleanup; source database untouched.

**MET-P2-005 — Prune confirmed orphaned UI as one cluster** (`deferred`)
Scope: after clean build/coverage, remove the production-orphaned legacy component chain and prevent a third primitive family. Reason: small maintainability win. Dependencies: MET-P1-001. Acceptance: zero imports, build/tests/visual parity. Rollback: one commit revert.

### P3

**MET-P3-001 — Split large UI modules only as touched** (`deferred`)
Scope: use boundaries in section 10; no redesign/state-library rewrite. Reason: maintainability, not incident response. Dependencies: characterization tests and an actual feature/fix touching the module. Acceptance: behavior/visual parity and smaller responsibility-focused files. Rollback: per-module revert.

**MET-P3-002 — Measure infrastructure complexity before simplification** (`deferred`)
Scope: collect job/evidence-runner cost, failure, duration, ownership, overlap, and release-blocking frequency; then propose consolidation. Reason: evidence machinery may be the best simplification target, but integrity controls may justify it. Dependencies: 60–90 days of data. Acceptance: decision based on measured cost/risk reduction. Rollback: retain current system.

**MET-P3-003 — Archive heavy historical design evidence and old copies** (`blocked-owner`)
Scope: checksum/archive superseded screenshots/design handoffs; retain approved mockups and compact visual set; later remove old clones/generated trees/local credential files. Reason: maintained repository is dominated by historical assets. Dependencies: MET-P0-001 and owner cleanup authorization. Acceptance: recovery index proves every removed item is recoverable; maintained clone materially smaller. Rollback: restore archive by checksum.

## 13. Recommended documentation shape

Keep it small:

```text
README.md                         # what it is, quick start, fast/full checks
AGENTS.md                         # authority, safety boundaries, source/generated rules
docs/index.md                     # current/historical/superseded authority table
docs/architecture.md              # one diagram, data authority, request/worker boundaries
docs/inventory.md                 # generated routes/APIs/jobs/config names
docs/runbook.md                   # health triage, bounded repair, alerts, escalation
docs/deploy.md                    # one orchestrator, gate, verify, rollback
docs/recovery.md                  # backup/restore/export recovery and receipts
docs/roadmap.md                   # stable queue IDs and status
docs/releases/                    # sanitized receipt index
docs/archive/index.md             # preserved historical material and checksums
```

Do not create another giant master plan. The current `execution-plan` and takeover brief should be labeled, not silently rewritten. Generated inventory should be a checked text/JSON snapshot from source, not an elaborate diagram platform.

## 14. Owner decisions versus technical determinations

### Owner decisions

1. After the scan, should the repository be private and GitHub Pages disabled?
2. May `main` be promoted/protected after preservation and green gates?
3. Which pages/periods directly drive payroll or financial decisions, and what freshness/coverage is acceptable?
4. Is hidden `/today` still wanted?
5. Are the two current users/alert recipients still complete, and who owns responding?
6. Is full historical backfill worth completing/maintaining?
7. Is normal CI plus rollback sufficient, or is separate-agent release evidence required?
8. Are commission exports reproducible, and what RPO/RTO/HA/storage risk is acceptable?
9. May obsolete copies, screenshots, and local credential files eventually be removed after preservation?

### Technical determinations

- Identify current Azure revision/digest and source binding.
- Diagnose freshness/queue failures and whether the old Materials deploy-order issue still exists.
- Produce route/API/job/config inventory.
- Run secret/history and dependency scans with redacted output.
- Establish clean-clone test/build results.
- Verify backup/restore evidence and alert configuration versus inbox delivery.
- Trace each health state to source records and propose bounded repairs.

## 15. Independent adverse-review conclusion

The reviewer challenged an early tendency to give every concern P0 priority and to overbuild documentation, decomposition, alerting, and recovery. This roadmap incorporates those corrections:

- P0 is limited to preservation/release authority, live data trust, public exposure review, and the direct injection flaw.
- Clean-clone CI and interaction defects are P1; documentation is P2; refactoring and consolidation are P3/as-touched.
- No frontend redesign, microservices, network redesign, new backup platform, alert destination, role system, state library, or broad schema cleanup is proposed.
- Large files and 24 jobs are maintainability signals, not incidents.
- Fail-closed commission and reconciliation machinery is treated as valuable unless measurement proves it costs more than it protects.

## 16. End-state summary

### Must be preserved

- All four candidate checkouts, dirty/untracked overlays, unreachable Git objects, and ignored deployment/monitoring receipts until hashed archives exist.
- Commit `7571b13` and its exact context-hash evidence.
- Current production digest/revision and prior rollback digest.
- Database migration ledger and integrity/reconciliation semantics.
- Commission immutable-run, fail-closed, audit, and cents-conservation controls.
- Bounded Simpro reader/rate-limit/idempotency behavior.
- Approved redesign mockups and a compact visual regression set.

### Must be fixed first

- Source/release/default-branch authority.
- Live Data Health failures and commission/financial decision safety.
- Public history/exposure review and owner visibility decision.
- Dynamic HTML injection.
- Clean-clone quality gate, CI, and routine-deploy gate binding.

### Should be simplified carefully

- Competing/stale documentation.
- Historical screenshots/design handoffs in the maintained tree.
- Duplicate modal/UI primitive implementations and confirmed orphaned UI.
- Large page/store/deploy modules only as touched.
- Evidence-runner and scheduled-job complexity only after cost/risk measurement.

### Must not be changed without approval

- Repository visibility, Pages, default/protected branches.
- Production deployment, job replay, database mutation, migrations, or Simpro writes.
- Credentials, allowlists, alert recipients, secret rotation, or local credential-file deletion.
- Backup/HA/storage posture or paid restore drill.
- Historical source/archive deletion.
- Payroll/commission policy, acceptable freshness, backfill scope, or release-assurance level.

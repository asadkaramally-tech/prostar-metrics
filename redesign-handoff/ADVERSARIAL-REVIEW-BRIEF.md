# Pro Star Metrics — System Reference & Adversarial Review Brief

**Date:** 2026-07-16. **Mission:** independently diagnose what is structurally wrong with this system's performance, data placement, caching, and data trustworthiness — then design the fixes. Form your **own** observations by instrumenting the real system; the symptom list at the end records what the owner saw, without interpretation. The owner's questions, verbatim: *"Is the data hosted in the right place? Is the right data cached? What's slowing things down? What data is suspect?"*

---

## 1. System design

### 1.1 Data flow (end to end)

```
Simpro (field-service SaaS, source of truth)
  → 24 scheduled Container App jobs (ingestion/reconciliation, §1.5)
  → raw_simpro_snapshots (raw payloads) + normalized metrics_* mirror tables
  → rollup_rebuild_queue (work items per metric_family × month)
  → rebuild workers (drain job) → dashboard_read_models (persisted JSONB payload per family × month)
  → Next.js SSR pages + /api/* routes → client dashboard components
```

- **Simpro is truth; Postgres is a mirror.** Never treat absence in the mirror as absence in Simpro.
- Reconciliation workers independently re-derive totals from the mirror and compare against served payloads (`*_reconciliation` tables, manifests with generations; fail-closed publication gates).
- Freshness metadata per page family comes from `getPageFreshness` (rollup run bookkeeping), rendered as the header pill.

### 1.2 Frontend

- Next.js 16 App Router, React 19, TypeScript, Tailwind 4; standalone output in Docker.
- Five SSR pages, each: server component loads a read model, passes typed payload to a `"use client"` dashboard component:
  - `/today` → `src/app/today/page.tsx` → `getTodayReadModel()` (`src/lib/store/today-read-model.ts`; performs live Simpro pulls) + a prior-month quote follow-up queue → `src/components/today-dashboard.tsx`
  - `/quotes` → `src/app/quotes/page.tsx` → `getQuoteMetricsReadModel()` (`src/lib/store/quote-dashboard-read-model.ts`) → `src/components/quotes/quote-metrics-dashboard.tsx`
  - `/jobs` → `src/app/jobs/page.tsx` → `getJobDashboardReadModel()` (`src/lib/store/job-dashboard-read-model.ts`) → `src/components/jobs-dashboard.tsx`
  - `/technicians` → `src/app/technicians/page.tsx` → `getDashboardReadModel("technicians", …)` (`src/lib/store/dashboard-read-models.ts`) → `src/components/technicians-dashboard.tsx`
  - `/commissions` → `src/app/commissions/page.tsx` → `getCommissionDashboardReadModel()` (`src/lib/store/commissions-read-model.ts`) → `src/components/commissions-dashboard.tsx` (role-gated admin/finance)
- Shared shell: `src/components/app-shell.tsx` (rail nav, owner block, `DataHealthDrawer` mounted in Suspense), `dashboard-page.tsx` (header, month stepper `period-selector.tsx`, freshness pill `freshness-banner.tsx`).
- Design system: `src/components/charts/*` (typed SVG chart kit) and `src/components/reset/*` (primitives); tokens in `src/app/globals.css`; static assets in `public/` (logo, Inter woff2 fonts).
- A small in-memory TTL cache (`src/lib/store/page-cache.ts`, added 2026-07-16) wraps the five page loaders (60–120 s TTL, in-flight dedupe). Evaluate on its merits; remove if wrong.
- `/api/*` routes mirror the page loads for client fetches (`/api/jobs|quotes|technicians|commissions|today`, plus `/api/quotes/overrides` mutation endpoints and `/api/health`).
- Auth: Azure Easy Auth (Entra) at ingress; `src/proxy.ts` middleware + `src/lib/auth/roles.ts` map the injected principal to roles (`admin`, `finance`). Authorized owners: `asad@prostarmechanical.com`, `laila@prostarmechanical.com`. Local dev bypass: `METRICS_DEV_AUTH_BYPASS=true` (non-production only).

### 1.3 Backend code layout

- `src/lib/metrics/*` — pure calculation builders per family (`jobs.ts`, `quotes.ts`, `technicians.ts`, `commissions.ts`, `today.ts`). Locked business rules live here (completed-jobs cohort = CompletedDate month + stage exactly Complete/Archived; net profit = Simpro NetProfit Actual; acceptance requires verified online acceptance or exact converted job; commission pool = completed work value × pool %, largest-remainder cents; technician roster = **whoever recorded work in the month** — owner decision 2026-07-16, migration 042).
- `src/lib/store/*` — SQL + serving: read-model input loaders, `read-model-rebuilds.ts` (queue mechanics: `enqueueRollupRebuild`, claim/lease with generations, `rebuildReadModelForJob`), `reconciliation.ts` + per-family reconciliation, `source-period-manifests.ts`, `ingestion-jobs.ts` (leases/generation fencing), `postgres.ts` (client; verified-TLS helper in `scripts/postgres-tls.mjs`).
- `src/lib/simpro/*` — API client (rate limit 5 rps, page size 250), `ingest.ts`, `normalize.ts` (entity → mirror rows; returns `affectedPeriods` that enqueue rebuilds).
- `workers/*.ts` — job entrypoints (same image as web): `rebuild-rollups.ts`, `ingest-simpro.ts`, `reconcile-simpro.ts`, `backfill-simpro.ts`, etc.
- Tests: `tests/**` (node:test + tsx; PGlite runs all migrations for store tests). 881 pass as of today. Run targeted: `node --import tsx --test <files>`; full: `npm test`; types: `npm exec -- tsc --noEmit`; lint: `npm run lint -- --max-warnings=0`.

### 1.4 Database

- Azure PostgreSQL Flexible Server **`pg-prostar-metrics-prod`** (PostgreSQL **17**), resource group `prostar-payroll`. 35-day PITR, storage autogrow. Public network access; firewall rules gate clients.
- Size today: **2,374 MB total**. Largest relations: `commission_run_inputs` 1,065 MB; `raw_simpro_snapshots` 611 MB; `commission_calculation_runs` 106 MB; `quote_snapshots` 82 MB; `metrics_schedule_blocks` 42 MB.
- Schema: everything in schema `metrics`. Migrations: `infra/db/migrations/001…042` (ordered .sql; ledger table `metrics.schema_migrations`; runner `scripts/apply-migrations.mjs` needs `AZURE_POSTGRES_CONNECTION_STRING`). All 42 applied in production.
- Key tables: mirror (`metrics_jobs`, `metrics_quotes`, `metrics_employee_timesheets`, `metrics_schedule_blocks`, `dim_people`, `job_source_quotes`…), serving (`dashboard_read_models` (family, period_start → values_json), `rollup_rebuild_queue`), commissions (`commission_calculation_runs`, `commission_run_inputs`, `commission_period_configs`), reconciliation (`*_reconciliation_results`, `source_period_manifests`), view `metrics.effective_technician_roster` (person dimension; membership decided by recorded work in the read-model queries).

### 1.5 Azure infrastructure

- Subscription `d7a98155-9693-4c6b-ad27-39e945c0f751`, resource group `prostar-payroll`, environment `cae-prostar-dispatch-prod`.
- Web app: Container App `aca-prostar-metrics-prod`. Ingress 3000, single-revision mode. Hostnames: default `aca-prostar-metrics-prod.thankfulmushroom-31ebfcb1.westus2.azurecontainerapps.io` + custom **`https://metrics.psm.photos`** (managed cert `mc-cae-prostar-di-metrics-psm-phot-4893`; DNS at Spaceship: CNAME `metrics` → default host, TXT `asuid.metrics`). Container CPU/memory/replica settings: **not yet catalogued — inspect them.**
- 24 scheduled jobs (`az containerapp job list -g prostar-payroll`), same image as web, each running a worker entrypoint. Cadence: `job-psm-{quote,job,schedule,mobile}-logs` */15min; `job-psm-timesheets-hourly`, `job-psm-employees-daily` (hourly), `job-psm-commissions-nightly` (hourly), `job-psm-ts-jobs-hourly`; `job-prostar-metrics-{ingest,jobs}` */6h; `job-psm-rollup-drain` 7,22,37,52 * * * *; `job-psm-candidate-drain` 2,17,32,47; `job-psm-operational-health` 10,25,40,55; `job-psm-backfill-hourly` 20,50; `job-prostar-metrics-reconcile` daily 05:30; `job-psm-reconcile-trailing-24m` daily 08:00; `job-psm-reconcile-stable-history` monthly; plus manual-trigger variants and `aca-job-verizon-gps-sync-prod` (*/15, separate system).
- Registry: ACR `acrprostardispatchprod` (`repository prostar-metrics`).
- IaC: `infra/azure/metrics.bicep` (+ `main.parameters.prod.example.json` — the file the deploy actually uses; now declares `customDomains`), `monitoring` Bicep with a 70-resource contract; deploys are what-if-gated against drift, so **all infra changes must go through Bicep**.
- Monitoring/logs: Log Analytics workspace customerId **`154bf9e9-1d9d-488e-b38a-7dabfb2b7497`**; tables `ContainerAppConsoleLogs_CL`, `ContainerAppSystemLogs_CL` (query: `az monitor log-analytics query -w <id> --analytics-query "…"`). Alert action group with Asad + Laila receivers.
- Key Vault **`kv-prostar-metrics-prod`**: secrets `azure-postgres-connection-string`, `simpro-bearer-token`, `microsoft-provider-authentication-secret`. App + jobs consume via versionless Key Vault references with managed identity.
- Entra app registration clientId `369bef95-48a6-45db-bad6-1e16278fa229`; web redirect URIs: both hosts' `/.auth/login/aad/callback`.

## 2. Credentials & access (everything you may need)

- **Azure CLI:** already signed in as `asad@prostarmechanical.com` (subscription **Owner**). All `az` reads work. Container App secrets are readable via `az containerapp secret show` if Key Vault paths fail.
- **Database:** `export AZURE_POSTGRES_CONNECTION_STRING="$(az keyvault secret show --vault-name kv-prostar-metrics-prod --name azure-postgres-connection-string --query value -o tsv)"` — load into env only, never echo. Node `pg` connects with `ssl:{rejectUnauthorized:false}` for ad-hoc analysis; app code uses the verified-TLS helper. A firewall rule **`psm-claude-migrate`** currently allows this machine's IP (76.170.194.168) on `pg-prostar-metrics-prod`; manage rules via `az postgres flexible-server firewall-rule {create,delete}`.
- **Simpro API:** base `https://prostarmechanical.simprosuite.com/api/v1.0`, bearer token in Key Vault secret `simpro-bearer-token`, 5 req/s, page size 250. Read-only against Simpro always. A Simpro MCP toolset may also be available in-session.
- **Production app:** `https://metrics.psm.photos` (or default host). Authenticated via the owner's existing Entra browser session (works in the in-session Chrome). `curl` unauthenticated gets 401/redirect at ingress; `/api/health` is anonymous-reachable and returns JSON.
- **Logs:** Log Analytics workspace above; live tails via `az containerapp logs show` (only while replicas exist).
- **Build & deploy:**
  - Image build (remote, no local Docker needed): `az acr build --registry acrprostardispatchprod --image prostar-metrics:<tag> --file Dockerfile .`
  - Direct deploy: `az containerapp update -n aca-prostar-metrics-prod -g prostar-payroll --image <ref>`; jobs: `az containerapp job update -n <job> -g prostar-payroll --image <ref>`. **Invariant: web + all 23 metrics jobs must run the same image.**
  - Guarded orchestrator: `npm run deploy:prod` (`scripts/deploy-prod.mjs`) — full gate suite, ARM deploy of app+jobs together, DB-aware health gate, auto-rollback, provenance manifest. Local prerequisites: `pg_dump`/`pg_restore` 17 on PATH (`/Applications/Postgres.app/Contents/Versions/17/bin`), Docker running, `az acr login --name acrprostardispatchprod`, `AZURE_POSTGRES_MIGRATION_CONNECTION_STRING` in env, ~3 GB free disk.
  - Rollback reference: pre-redesign production image digest `sha256:72e523e32c790d6cc326af2e74c974cc06dddb30c1ca3fa2434f96270740ae12`.
  - Trigger a job manually: `az containerapp job start -n <job> -g prostar-payroll`.
- **Local dev:** `npm run dev` + `METRICS_DEV_AUTH_BYPASS=true`; with the DB env var set you get real data locally; without it, pages render degraded states.
- **Repo:** `/Users/asadkaramally/Documents/New project/prostar-metrics-dashboard` (git, branch main). Authority docs: `CLAUDE-PROJECT-TAKEOVER-BRIEF.md` (owner's standard; §6 locked business rules), `redesign-handoff/product-reset/` (approved design + contract map + defect ledger).

## 3. Recent changes (2026-07-16, facts only)

- Redesign shipped: five pages rebuilt, design system added, rejected admin surfaces removed.
- Migrations applied: 039 (`effective_technician_roster` view), 041 (quote customer/site identity columns + trigger + replay backfill), 042 (view widened to all mapped people; roster membership decided by recorded work in queries).
- Owner decisions now in code: work-based monthly roster; commissions per-person include/exclude checkbox with session-only pool redistribution.
- Dockerfile fix: `public/` was never copied into the runtime image (all static assets 404'd in production until today).
- `page-cache.ts` TTL cache added around page loaders.
- Custom domain + managed cert added and declared in Bicep; Entra redirect URI added.
- Deployed manually after the orchestrator's health gate rolled back once; **current known drift: web image tag `assets-cache-91da523` vs jobs on `8bfe67c8…`** (same source except Dockerfile/public + page cache).
- Temporary access created today (cleanup ledger): KV role assignments `132f3c26-d55a-440e-8291-0b487f25690a` (Secrets User, DB secret) and `d2ac3e43-544a-4d2a-9d8b-49b2b1467966` (KV Reader, vault), firewall rule `psm-claude-migrate`.

## 4. Symptoms observed (secondary; observations only — diagnose independently)

- Authenticated SSR timings measured today: `/jobs` ~1.0 s; `/technicians` ~2.0 s; `/quotes` 10–14.5 s first hit and ~9.4 s on immediate repeat (after the TTL cache was added); `/today` 10–12.2 s. `/api/health` 0.2 s. `/api/technicians` measured 43 s once during a deployment, 2.3 s later.
- Header freshness pill shows "Updated 2 days ago" (amber) while pages display data through July 16.
- `job-psm-rollup-drain` scheduled executions report status `Failed` every 15 minutes. Worker log line: `"Commission integrity verification failed for 2026-07-01; refusing immutable-run and ready read-model publication: source_complete is false"`.
- `rollup_rebuild_queue` contains terminally `failed` items (5 attempts) for commissions 2025-08 through 2026-02 and quotes 2025-12.
- Commissions drill rows render "Customer unavailable — Job NNNNN" for all jobs.
- Today page ROSTER section lists office staff (e.g., Laila Karamally) with "0h recorded" alongside technicians.
- Jobs-page loss insight copy renders "39 of 189 direct-service calls"; the corrected read model documented the cohort as 187 (see `redesign-handoff/product-reset/DEFECT-LEDGER.md`, post-approval correction).
- Technicians scorecard footnote reads "verified from Simpro positions".
- During the orchestrated deploy, the health gate rolled back a revision whose own logs showed a Ready server; a worker logged `"timeout exceeded when trying to connect"` in the same window.
- Technicians read model for June was rebuilt today (12 people, `rosterApplied: true`); other months' served payload shapes not re-checked since.

## 5. Deliverables

Write `redesign-handoff/ADVERSARIAL-REVIEW-FINDINGS.md` containing:
1. **Your own root-cause analysis** of the performance and data-trust problems — evidence first (server-side timings, EXPLAIN plans, log excerpts, code paths). Where a §4 symptom turns out to be by-design, say so.
2. **Answers to the owner's four questions** with evidence.
3. **Target architecture** — data placement, caching layers, serving contract, connection budget, container sizing, freshness semantics, release path.
4. **Ranked fix plan** — owner-visible impact order; each item with effort, risk, and a verification step the owner can see on the live site.

Rules: production analysis is unrestricted but non-destructive (SELECT-only SQL; no deletes/IAM/network changes; never echo secrets). You may stage code fixes in the repo as uncommitted changes and may trigger read-model drain jobs; do not deploy images or change live configuration without recording exactly what and why in the findings file.

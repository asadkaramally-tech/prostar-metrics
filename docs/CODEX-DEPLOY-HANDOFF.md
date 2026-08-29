# HISTORICAL / SUPERSEDED — Deploy handoff, 2026-07-20

This file is retained as historical evidence only. Do not follow its direct-Bicep, manual job-creation, firewall, or `.env.local` copying instructions. The current and only deployment authority is [`../DEPLOY.md`](../DEPLOY.md).

Everything is built, tested, and preflight-green. This document is the complete
brief for finishing the production deploy of the metrics.psm.photos redesign.

## What is already done (do not redo)

- All five pages (quotes, jobs, technicians, commissions, + new materials)
  rebuilt to the approved design. Acceptance gate (`node scripts/design-gate.mjs`)
  passes on all five; interaction checks 7/7.
- Full preflight passes end to end: `npm test` (935), `test:scripts`,
  `test:infra` (160), ESLint, tsc, no-mirror guard, production build
  (the build includes the new `/materials` route).
- Commission engine fix (hours-only membership, no roster gating) verified
  against live data; pool conserved to the cent.
- Materials backend validated against live Simpro (June within $1, July
  cent-exact).
- Ingestion cadence fix committed: `*/20 * * * *` (was 6-hourly, which could
  never drain the queue).
- Migration 045 (materials tables) is expand-only and hash-tracked; the deploy
  script applies it automatically.

## The one real deploy blocker (root-caused, needs one fix)

`npm run deploy:prod` deploys **monitoring first, fail-closed by design**
(scripts/deploy-prod.mjs). Monitoring auto-derives one metric alert per
Container Apps job declared in `infra/azure/metrics.bicep`. This branch adds a
new job (`job-psm-materials`), so monitoring now includes
`alert-job-psm-materials-failed` — but the job itself is only created by the
metrics.bicep stage which runs **later** in the same deploy. ARM rejects a
metric alert whose target resource does not exist:

```
BadRequest → ResourceNotFound: Microsoft.App/jobs/job-psm-materials
```

Fix options (pick one):
1. **Pre-create the job once** so monitoring finds it: run the metrics.bicep
   deployment (same command `deployMetrics()` uses in scripts/deploy-prod.mjs,
   ~line 1322: `az deployment group create -g prostar-payroll
   --template-file infra/azure/metrics.bicep --parameters <PRODUCTION_PARAMETERS_PATH>
   --parameters containerImage=<CURRENT LIVE IMAGE BY DIGEST>`), passing the
   image currently live on `aca-prostar-metrics-prod` (read it with
   `az containerapp show`). Then rerun `npm run deploy:prod` unchanged.
2. Make the materials alert conditional on a `materialsJobExists` parameter
   (default false) in monitoring.bicep, deploy once, flip it after. Note
   tests/infra/monitoring.test.mjs asserts monitoring covers every metrics.bicep
   job, so the test must understand the condition. Option 1 is less invasive.

After the job exists once, this ordering issue never recurs.

## Environment the deploy machine needs

1. **Azure CLI signed in** to subscription `Azure subscription 1`
   (d7a98155-9693-4c6b-ad27-39e945c0f751) with rights on resource group
   `prostar-payroll`. IMPORTANT: deploy-prod.mjs uses an isolated
   `AZURE_CONFIG_DIR` at `<repo-parent>/.work/azure` by default — that
   directory must have both a login and the bicep CLI, or export
   `AZURE_CONFIG_DIR="$HOME/.azure"` (any signed-in config dir with
   `az bicep install` done) before running.
2. **Secrets** (never commit): copy `.env.local` from this checkout on Asad's
   Mac (`~/Documents/Codex/2026-07-20/prostar-metrics-restyle/.env.local`), or
   rebuild it from the Container App:
   - `AZURE_POSTGRES_CONNECTION_STRING` = container app secret
     `azure-postgres-connection-string`
   - `SIMPRO_BEARER_TOKEN` = secret `simpro-bearer-token`
   - `AZURE_POSTGRES_MIGRATION_CONNECTION_STRING` = same value as
     `AZURE_POSTGRES_CONNECTION_STRING` (the app user IS the admin)
3. **PostgreSQL network access from the deploy machine** (for the migration
   step): the machine's public IP must be in the firewall rules of
   `pg-prostar-metrics-prod` (rg `prostar-payroll`):
   `az postgres flexible-server firewall-rule create -g prostar-payroll
   -s pg-prostar-metrics-prod -r <rule-name> --start-ip-address <IP>
   --end-ip-address <IP>`.
   NOTE: Asad's Mac's IP changed on 2026-07-20 (now 76.50.217.167; rules still
   allow only the old 76.170.194.168), which is why local DB work stalled. If
   deploying from Azure-hosted compute, the existing `allow-azure-services`
   rule already covers it.
4. **PostgreSQL 17 pg_dump and pg_restore on PATH** (`brew install postgresql@17`
   on macOS, then prepend `/opt/homebrew/opt/postgresql@17/bin` to PATH; on
   Linux install the PostgreSQL 17 client). The compatibility gate intentionally
   rejects other major versions.
5. **A running Docker engine with `linux/amd64` support and ACR authentication**
   for the prior-production-image compatibility gate. On an Apple Silicon Mac,
   one lightweight option is `brew install docker colima`, then
   `colima start --vm-type vz --vz-rosetta`. Before deploying, run
   `az acr login --name acrprostardispatchprod` and verify `docker version`
   reports both a client and server.

## The deploy command

```sh
set -a; source .env.local; set +a
export AZURE_POSTGRES_MIGRATION_CONNECTION_STRING="$AZURE_POSTGRES_CONNECTION_STRING"
npm run deploy:prod
```

It is the only sanctioned deploy path: preflight gates → ACR image build by
digest → monitoring what-if + deploy → expand-only migrations under advisory
locks → metrics.bicep what-if + deploy → single-revision cutover → health
verification → auto-rollback on failure. Roughly 30–40 minutes.

## After the deploy is live

1. Verify `metrics.psm.photos` serves the new revision (revision number
   > 0000124) and all five pages render; `/materials` has data.
2. The `*/20` ingest cadence plus the new `job-psm-materials` job start
   draining the incremental queue in production automatically. The July
   backfill ledger (4 of 8 source families still queued: employees, quotes,
   quote_nested, schedules) completes on its own once the queue drains; then
   rollups rebuild and the next commission run publishes.
3. To force the catch-up immediately instead of waiting (optional, from any
   machine with DB + Simpro access): run 6–8 parallel
   `npm run ingest:worker -- --drain-limit 1000` until
   `metrics.ingestion_jobs` (non-backfill) is empty, then
   `npm run backfill:worker -- --execute --drain-limit 100` until the July
   ledger families are all completed, then `npm run rollups:worker`.
   (Default drain-limit is 1 — that is why naive runs look glacial.)

## Deploy-attempt history (context)

- Run 1: failed preflight — cadence-lock test still pinned the old 6-hourly
  cron. Fixed (commit 2909535).
- Run 2/3: failed preflight — the isolated `.work/azure` config dir had no
  bicep CLI and no az login, so the two bicep-compiling infra tests failed
  there while passing in any normal shell. Fixed by pointing
  `AZURE_CONFIG_DIR` at a signed-in config (see above).
- Run 4: cleared every preflight gate, failed at monitoring deploy on the
  `job-psm-materials` ResourceNotFound ordering issue described above — the
  single remaining blocker.

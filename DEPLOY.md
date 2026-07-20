# Production Deployment

## Production Target

- Azure subscription: `d7a98155-9693-4c6b-ad27-39e945c0f751`
- Resource group: `prostar-payroll`
- Container App: `aca-prostar-metrics-prod`
- Custom domain: `https://metrics.psm.photos`
- Azure Container Registry: `acrprostardispatchprod`
- Image repository: `prostar-metrics`
- PostgreSQL server/database: `pg-prostar-metrics-prod` / `prostar_metrics`

`npm run deploy:prod` is the only routine production deployment command. Do not run `az containerapp up`, deploy `metrics.bicep` directly, update an individual Container App job, or push a separately built production image.

## Build Prerequisites

The release that produced revision `aca-prostar-metrics-prod--0000124` used:

- Node.js `24.17.0` and npm `11.13.0` for workstation gates.
- The repository Dockerfile, based on `node:24-alpine`, for the ACR source build.
- Azure CLI `2.79.0`.
- Azure CLI extensions: `containerapp 1.3.0b4`, `log-analytics 1.0.0b1`, `resource-graph 2.1.1`, and `scheduled-query 1.0.0b2`.
- PostgreSQL 17 client programs on `PATH`, including `pg_dump`, `pg_restore`, and `psql`.
- A Docker client and running Docker engine for the prior-image migration compatibility probe.
- Network access to Azure management endpoints, ACR, the production PostgreSQL server, npm, and `api.ipify.org`.

The Azure CLI session must be authenticated to the production tenant and have the permissions required for the resource group, ACR builds, PostgreSQL firewall rules, Key Vault validation, monitoring resources, managed identities, Container Apps, and Container Apps jobs.

Install dependencies from the repository lockfile before releasing:

```bash
npm ci
```

## Exact Invocation

Revision `0000124` was released from:

```text
/Users/asadkaramally/Documents/New project/prostar-metrics-dashboard
```

The invocation pattern was:

```bash
cd "/Users/asadkaramally/Documents/New project/prostar-metrics-dashboard"

export AZURE_CONFIG_DIR="/Users/asadkaramally/Documents/New project/.work/azure"
az account set --subscription "d7a98155-9693-4c6b-ad27-39e945c0f751"

npm ci

# Load this value from the trusted release secret source. Never put it in Git.
export AZURE_POSTGRES_MIGRATION_CONNECTION_STRING="<privileged migration connection string>"

npm run deploy:prod

unset AZURE_POSTGRES_MIGRATION_CONNECTION_STRING
```

For a fresh clone, run the same commands from the clone root and point `AZURE_CONFIG_DIR` at a writable, authenticated Azure CLI profile. The production migration connection string is the only secret the release script requires directly from the workstation environment. Runtime database, Simpro, and Microsoft provider secrets remain in `kv-prostar-metrics-prod` and are referenced by managed identity; they are not copied into the repository or image.

## What The Command Does

`npm run deploy:prod` performs the complete release transaction:

1. Creates an immutable Docker build-context snapshot and records its SHA-256.
2. Runs unit, script, and infrastructure tests; ESLint; TypeScript; the no-mirror guard; and the production Next.js build.
3. Validates production Key Vault, managed-identity, monitoring, app, and exact 23-job target contracts.
4. Builds the source in ACR under an immutable tag, verifies the ACR run, and pins the resulting image digest.
5. Runs semantic Azure what-if checks for monitoring and the app-plus-jobs deployment.
6. Opens a temporary PostgreSQL firewall rule for the caller's exact public IP.
7. Runs the prior-image compatibility probe, migration-twice and concurrency checks, then applies ordered hash-tracked migrations under an advisory lock.
8. Removes the temporary firewall rule and proves it remains absent.
9. Deploys the web app and all scheduled jobs together in single-revision mode.
10. Verifies database-aware health, Easy Auth behavior, target state, traffic, ARM/ACR provenance, and the digest-pinned image. A failed candidate is rolled back to the previous pinned image contract.
11. Writes the generated deployment manifest under `docs/prostar-metrics/verification/`.

## Migrations, Cache, And Manual Steps

- Do not apply production migrations manually for a routine release. They are part of `npm run deploy:prod`.
- There is no manual cache-warm step. Dashboard requests use the PostgreSQL serving models; the scheduled ingestion, reconciliation, and rollup jobs maintain those models.
- There is no separate production image build or push command.
- The production Key Vault secrets, managed-identity grants, Entra/Easy Auth registration, owner access for Asad and Laila, custom-domain certificate, database, storage account, Container Apps environment, and ACR must already exist. Their contracts are validated by the release script and Bicep parameter files.
- Generated release/browser evidence is not source and is intentionally ignored by Git.

## Live Revision Provenance

The complete application, worker, migration, infrastructure, and release source for the currently live release is Git commit `64574fd0e5074bea309219fcfe5a73c630048911` in this repository:

- Deployment-recorded Docker upload-context SHA-256: `f57930dbfbb37c8fe8b4d0e548ce6ba55408f94368170f69341af1515667fd71`
- ACR build run: `cc5x`
- ACR build created: `2026-07-19T02:43:00.125Z`
- Image digest: `sha256:453b886332fb6c42f9d33d6b5ce896a45dd51b567411e47757768eadc558b73b`
- Deployed revision: `aca-prostar-metrics-prod--0000124`
- Revision created: `2026-07-19T02:52:50Z`

The historical upload context also contained local QA screenshots, browser snapshots, export fixtures, and macOS metadata that were neither application source nor copied into the final Docker runtime stage. Some snapshots contained operational names, so those generated artifacts are deliberately excluded from GitHub. Commit `64574fd0e5074bea309219fcfe5a73c630048911` preserves every input that builds or runs the deployed application; use the pinned image digest above when byte-for-byte retrieval of the historical runtime artifact is required.

Commits after `64574fd0e5074bea309219fcfe5a73c630048911` in the initial GitHub handoff add repository documentation and secret-safe ignore/template files only. They were intentionally not deployed during the handoff.

# Production deployment

This is the canonical production release guide. The release target is Azure subscription `d7a98155-9693-4c6b-ad27-39e945c0f751`, resource group `prostar-payroll`, Container App `aca-prostar-metrics-prod`, ACR `acrprostardispatchprod/prostar-metrics`, PostgreSQL `pg-prostar-metrics-prod/prostar_metrics`, and the exact 24-job set generated in `docs/inventory.generated.json`.

The only release entry point for changed code is:

```bash
npm run deploy:prod -- --full
```

Use full mode for every changed source or dependency tree, monitoring/infrastructure change, fresh clone, or new release train. It installs no secrets and requires the privileged migration connection string to be supplied from a trusted secret source as `AZURE_POSTGRES_MIGRATION_CONNECTION_STRING`.

After a full run has passed preflight and produced an immutable ACR checkpoint, an exact retry may use:

```bash
npm run deploy:prod
```

Routine mode is not a shortcut for changed code. It fails closed unless `.work/deploy-prod-resume/` contains a valid certificate for the exact immutable source snapshot and materialized dependency tree. The script re-queries ACR and rejects tag, run, or digest drift. `--resume` is only a legacy spelling for routine mode. There is no emergency bypass.

## Preconditions

- Clean authoritative checkout and lockfile install using Node 24.x/npm 11.x.
- Azure CLI authenticated to the exact subscription with required resource, ACR, Key Vault, identity, monitoring, Container Apps, jobs, and PostgreSQL permissions.
- Writable isolated `AZURE_CONFIG_DIR`; PostgreSQL 17 client tools; Docker engine with the prior-image platform available; required network access.
- Privileged migration connection string loaded into the one named environment variable. Never copy `.env.local`, extract runtime secrets into the repository, or place values on a command line.
- Approved release window, previous immutable digest identified, and owner aware of any pending migration or repair follow-up.

Recommended invocation:

```bash
npm ci
az account set --subscription d7a98155-9693-4c6b-ad27-39e945c0f751
npm run deploy:prod -- --full
unset AZURE_POSTGRES_MIGRATION_CONNECTION_STRING
```

## Enforced transaction

Full mode snapshots and hashes the build context; runs application, script, infrastructure, lint, type, no-mirror, and production-build gates; verifies production targets and Key Vault; checks monitoring what-if and notification/metric evidence; builds in ACR and pins the digest; reviews app-plus-jobs what-if; gates and applies hash-tracked migrations through a reconciled temporary firewall rule; deploys the app and all 24 jobs together; then verifies database-aware health, authentication, pages/APIs, target state, 100% candidate traffic, and ARM/ACR provenance. Candidate failure triggers restoration of the previous immutable image contract.

Do not run `az containerapp up`, deploy Bicep directly, update an individual job, apply production migrations manually, or push a separately built image. Do not replay failed ingestion before the fixed image is verified live.

## Release receipt

Retain a sanitized receipt containing source commit and build-context hash, ACR run/tag/digest, ARM operation, app revision and traffic, all 24 job digests, migration ledger and hashes, monitoring evidence hashes, smoke results, previous rollback digest, and timestamp. Generated raw evidence remains ignored and protected outside Git.

The last independently verified live state is revision `aca-prostar-metrics-prod--0000152`, healthy and receiving 100% traffic on 2026-08-28. Its strongly matched source commit is `7571b13bdfa155693cddf2f284c2275a9c11df01`; see [`docs/releases/2026-07-23-revision-152-sanitized.md`](docs/releases/2026-07-23-revision-152-sanitized.md). Job digests, migration ledger, smoke result, and rollback digest still require an owner-authorized read before that receipt is complete.

No changes in the 2026-08-28 stabilization branch have been deployed.

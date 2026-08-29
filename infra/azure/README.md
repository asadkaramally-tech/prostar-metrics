# Pro Star Metrics Azure Container Apps

This directory defines the production infrastructure for the Pro Star Metrics dashboard. The workload is isolated from the dispatch application while reusing the existing Container Apps environment, registry, managed identity, and Log Analytics workspace.

## Production Targets

- Subscription: `d7a98155-9693-4c6b-ad27-39e945c0f751`
- Resource group: `prostar-payroll`
- Container Apps environment: `cae-prostar-dispatch-prod`
- Registry: `acrprostardispatchprod`
- Managed identity: `id-prostar-dispatch-prod`
- Log Analytics workspace: `log-prostar-dispatch-prod`
- PostgreSQL server/database: `pg-prostar-metrics-prod` / `prostar_metrics`
- Web app: `aca-prostar-metrics-prod`
- Production image: an immutable `acrprostardispatchprod.azurecr.io/prostar-metrics@sha256:<digest>` reference
- Dedicated Key Vault: `kv-prostar-metrics-prod`

## Production Authority

`npm run deploy:prod` is the only routine production deployment command. Run it from the repository root after the privileged migration connection is loaded into the trusted release process environment:

```bash
npm run deploy:prod
```

Do not build or publish a production image separately, deploy `metrics.bicep` directly, or update an individual Container App or job. The guarded orchestrator owns the complete release transaction:

- immutable source hashing, ACR build, run lookup, tag binding, and digest pinning;
- local, integration, infrastructure, migration, and prior-image compatibility gates;
- monitoring validation and deployment;
- exact semantic what-if validation for the web app and all 24 jobs;
- database migration and rollback-protected app-plus-job deployment;
- database-aware health, Easy Auth, target-contract, ACR, and ARM provenance checks; and
- atomic deployment-manifest publication only after final verification.

Unknown arguments and legacy deployment environment variables fail closed. A failed candidate release restores the prior pinned app and job image contracts and verifies the restored revision.

One-time security, Key Vault migration, and restore-drill prerequisites are documented in [SECURITY.md](./SECURITY.md). They are not substitutes for the routine production orchestrator.

## Database Migrations

Production migrations are part of `npm run deploy:prod`. Do not apply migration files manually as part of a routine release. The orchestrator runs static prior-image SQL compatibility, the disposable empty-database migration/concurrency suite, and ordered migration application before changing the application image. The expensive production-data clone/probe is not part of deployment; it is an explicit diagnostic command, `npm run migration:compatibility:clone`.

## Monitoring

Monitoring resources are defined in `monitoring.bicep` and are deployed through the guarded orchestrator. Review [MONITORING.md](./MONITORING.md) for signal definitions, owner recipients, privacy constraints, and evidence requirements. Do not use the template's direct deployment examples as a substitute for `npm run deploy:prod` when releasing this application.

## Scheduled Work

The nightly trailing-24-month reconciliation, monthly stable-history reconciliation, DST-safe commission rebuild, ingestion, materials month-walk, rollup, backfill, and operational-health modes are declared as the exact 24-job production target set in `metrics.bicep`.

Review [CADENCE.md](./CADENCE.md) for schedule and idempotency contracts. A release must update and verify the web app and every managed job together.

## Release Behavior

Routine releases remain in `Single` revision mode with 100 percent traffic on the one healthy, ready, digest-pinned revision. `/api/health` is the only Easy Auth exclusion and is used by startup, readiness, liveness, and release checks.

Review [RELEASES.md](./RELEASES.md) for the guarded release contract and the policy for emergency or canary changes.

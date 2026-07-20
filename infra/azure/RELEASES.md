# Container Apps Release Contract

## Routine Release

`npm run deploy:prod` is the only routine production release authority:

```bash
npm run deploy:prod
```

The command must run from a trusted release environment with the privileged migration connection already loaded. The orchestrator creates an immutable source-derived image tag, verifies its exact ACR build run and digest, deploys a digest reference, validates the complete app-plus-24-job what-if, applies expand-compatible migrations, and verifies the resulting live state before publishing the deployment manifest.

Routine releases use `activeRevisionsMode=Single`. Container Apps keeps the previous healthy revision serving until the candidate passes startup and readiness probes, then moves 100 percent of traffic to the candidate. The orchestrator rejects revision-mode, traffic, configuration, identity, secret-reference, schedule, command, or resource drift outside the one expected image change per target.

Do not run a separate registry build, invoke a production Bicep template directly, update the web app independently, or update jobs independently. Those paths bypass the immutable build, migration, rollback, exact-target, and provenance gates.

## Health And Authentication

The web container defines startup, readiness, and liveness HTTP probes on `/api/health`. The endpoint performs a bounded database readiness query and no Simpro request.

Container Apps Easy Auth excludes exactly `/api/health`. The guarded release verifies the preserved Microsoft provider, tenant issuer, client ID, audiences, HTTPS setting, callback, browser redirect, API denial behavior, and authenticated Asad/Laila owner identity.

| Probe | Initial delay | Period | Timeout | Failures | Effective failure window |
| --- | ---: | ---: | ---: | ---: | ---: |
| Startup | 5 seconds | 10 seconds | 5 seconds | 30 | 5 minutes after initial delay |
| Readiness | 10 seconds | 10 seconds | 5 seconds | 12 | 2 minutes |
| Liveness | 60 seconds | 30 seconds | 5 seconds | 10 | 5 minutes |

These thresholds prevent a short database stall from immediately removing or restarting a replica. Probe changes create a new revision and therefore must go through the guarded orchestrator.

## Failure And Rollback

The release captures the exact prior app, job, and revision contracts before any candidate write. Any candidate deployment or post-deployment verification failure triggers restoration of the prior digest-pinned image across the web app and all 24 jobs, followed by health, traffic, and target-contract verification. Database migrations are expand-compatible and are not reversed.

Do not attempt an ad hoc production rollback. Re-run or extend the guarded orchestrator so rollback retains the same preflight, exact-target, authentication, monitoring, provenance, and evidence controls.

## Canary And Emergency Changes

No manual canary deployment is authorized. The current release orchestrator supports only the routine `Single`-revision transaction.

A canary or emergency release requires a source-controlled orchestrator mode that provides controls equivalent to the routine release before it can be used. At minimum it must pin an immutable digest, validate the full app-plus-24-job semantic what-if, preserve migrations and prior-image compatibility, capture and restore exact traffic and target state, verify the candidate directly, enforce owner authentication, and publish independently reviewed provenance evidence. Until that mode exists and passes review, use `npm run deploy:prod` or stop the release.

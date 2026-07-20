# Isolated Release Evidence Runners

The release evidence boundary uses three fixed, event-triggered Azure Container Apps Jobs:

| Kind | Job | Identity | Handoff container and queue |
| --- | --- | --- | --- |
| Gate | `job-psm-evidence-gate` | `id-prostar-release-gate-prod` | `release-evidence-gate` |
| Browser artifact validation | `job-psm-evidence-browser` | `id-prostar-release-browser-prod` | `release-evidence-browser` |
| External review report validation | `job-psm-evidence-reviewer` | `id-prostar-release-reviewer-prod` | `release-evidence-reviewer` |

These jobs remain outside the routine application plus 23-job deployment target. They are deployed only after the candidate image and source hash are pinned.

## Provisioning Contract

The guarded deployment requires exactly:

- three jobs, three handoff containers, and three handoff queues;
- the fixed `ProStar Evidence Public Key Reader` custom role with no management actions, no exclusions, exactly `Microsoft.KeyVault/vaults/keys/read`, and no excluded data actions;
- all 19 direct role assignments with their deterministic Bicep `guid()` IDs, exact scope, principal, principal type, and built-in or custom role definition ID; and
- one merged storage lifecycle singleton containing exactly the seven-year commission-export retention rule, one-day orphaned `runs/` cleanup rule, and seven-day replay-ledger cleanup rule.

Both `metrics.bicep` and `evidence-runners.bicep` own `managementPolicies/default`; both compile to the identical complete three-rule policy, so deploying either template cannot remove the other workload's retention rules.

Before deployment, the command independently queries all three managed identities and validates the complete ARM what-if resource set. Every change requires the exact case-sensitive `resourceId`, `after.id`, `after.type`, name, resource type, API version, full payload, and deterministic role-assignment ID. Missing, extra, duplicate, mistyped, reordered-policy, wrong-scope, wrong-principal, wrong-role, permission-expanded, or arbitrary-UUID variants fail.

After deployment, the validator ignores deployment outputs and independently enumerates the tagged jobs, storage containers, queues, custom role, lifecycle policy, and RBAC assignments from live Azure state. Assignment reads include inherited roles. Any direct or inherited Blob/Queue data-plane role at an evidence container or queue that is not one of the exact least-privilege assignments fails validation, including roles inherited from the storage account, resource group, or subscription. The commission application identity is scoped only to `commission-exports`, not the storage account.

The operator can create blobs in one handoff container and send messages to one queue. The operator receives no job-start or Key Vault permission. Each job has one fixed UAMI, image, command, per-kind queue/container, and version-pinned signing key boundary. Azure subscription and resource-group administrators remain the provisioning trust root.

Inspect source and deployment prerequisites without Azure writes:

```bash
npm run release:runners:deploy
```

The write path requires explicit confirmation:

```bash
npm run release:runners:deploy -- --execute --confirm DEPLOY_EVIDENCE_RUNNERS
```

## Gate Producer Contract

The controlled gate runs exactly these production commands:

```text
npm run test:unit
npm run test:integration
npm run test:scripts
npm run test:infra
npm run build
```

The Node test suites use the checked-in evidence reporter to emit one assertion for each observed test result. The build wrapper emits assertions only after validating freshly generated Next.js build manifests. Every event carries observed counts and an ID derived from its category and provenance:

```text
PROSTAR_EVIDENCE_ASSERTION {"schemaVersion":2,"category":"unit","id":"OBS-UNIT-<sha256-prefix>","outcome":"PASS","provenance":{"runner":"node-test","source":"tests/example.test.ts:12:1","assertion":"renders all four v1 routes"},"counts":{"total":1,"passed":1,"failed":0,"skipped":0,"cancelled":0,"todo":0}}
```

The producer preserves only emitted IDs, outcomes, provenance, and counts. IDs are recomputed from provenance; they are not a feature inventory. It never maps process exit zero to an outcome, and a zero-exit process with no assertion events produces no result artifact. Raw logs, structured results, report claims, and aggregate counts must match exactly. Feature publication stores those real claims and leaves synthesized accepting-gate outcomes empty; `acceptingGate` remains plan metadata.

Run the actual-command end-to-end test locally with:

```bash
npm run test:evidence-gates
```

## Browser Artifact Validation

The browser job does not launch a browser, record a session, take screenshots, or establish capture provenance. It validates supplied sanitized E2E/accessibility reports and every referenced artifact hash, then signs a `validated-browser-artifacts` receipt for that exact validation result.

Validate the supplied artifact set locally before submission:

```bash
npm run release:browser:validate -- \
  --deployment-manifest docs/prostar-metrics/verification/deployment-manifest.json \
  --e2e-report docs/prostar-metrics/verification/browser/e2e-report.json \
  --a11y-report docs/prostar-metrics/verification/accessibility/a11y-report.json \
  --output docs/prostar-metrics/verification/browser/validated-artifacts.json
```

Submit it to the isolated validator:

```bash
npm run release:evidence:submit -- \
  --kind browser \
  --deployment-manifest docs/prostar-metrics/verification/deployment-manifest.json \
  --e2e-report docs/prostar-metrics/verification/browser/e2e-report.json \
  --a11y-report docs/prostar-metrics/verification/accessibility/a11y-report.json \
  --producer-result docs/prostar-metrics/verification/browser/validated-artifacts.json
```

The E2E and accessibility reports must name `docs/prostar-metrics/verification/browser/validated-artifacts-receipt.json` as their browser attestation path.

## Gate Receipt

Use the validated-artifacts receipt returned by the browser submission:

```bash
npm run release:evidence:submit -- \
  --kind gate \
  --deployment-manifest docs/prostar-metrics/verification/deployment-manifest.json \
  --e2e-report docs/prostar-metrics/verification/browser/e2e-report.json \
  --a11y-report docs/prostar-metrics/verification/accessibility/a11y-report.json \
  --browser-attestation docs/prostar-metrics/verification/browser/validated-artifacts-receipt.json
```

## External Review Report Validation

A real separate-agent review remains a release process requirement. The resulting report is supplied externally and must declare `reviewProcess: "SEPARATE_AGENT_REQUIRED"` and `authorship: "NOT_AUTHENTICATED"`, along with declared task/thread IDs, complete scope, findings, decision, timestamp, and reviewed artifact hashes.

The Azure job verifies the browser and gate receipts, all referenced artifacts, structured gate outcomes, report shape, artifact hashes, freshness, and `SHIP` decision. Its `external-review-report-validation` receipt authenticates only that the Azure validation service processed those exact bytes. It does not authenticate who authored the report and is not an authorship or reviewer-independence attestation.

```bash
npm run release:evidence:submit -- \
  --kind reviewer \
  --deployment-manifest docs/prostar-metrics/verification/deployment-manifest.json \
  --e2e-report docs/prostar-metrics/verification/browser/e2e-report.json \
  --a11y-report docs/prostar-metrics/verification/accessibility/a11y-report.json \
  --browser-attestation docs/prostar-metrics/verification/browser/validated-artifacts-receipt.json \
  --gate-report <gateReportPath> \
  --gate-runner-receipt <runnerReceiptPath> \
  --reviewer-report docs/prostar-metrics/verification/reviewer/external-review-report.json
```

## Freshness And Replay

Every request has a random 256-bit nonce, UUID message ID, `issuedAt`, and `expiresAt`. The queue payload, input bundle, create-only replay record, output envelope, and signed subject bind the same values and input hash. Workers reject future, expired, changed, or already claimed messages. Replay claims are durable Azure blobs created with `If-None-Match: *` and store only hashes and non-secret identifiers.

The client always attempts deletion of both input and output blobs in `finally`, including timeout and partial-upload paths. The merged Azure lifecycle singleton removes orphan blobs if client cleanup cannot complete while preserving commission exports for seven years. Postdeploy validation requires all three lifecycle rules live. Queue messages retain a one-hour service TTL. Bundles and logs are credential-scanned; bearer tokens, cookies, database URLs, passwords, private keys, and secret values are rejected before upload or signing.

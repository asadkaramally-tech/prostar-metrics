# Pro Star Metrics Key Vault And Restore Operations

## Security Contract

`security.bicep` owns only the dedicated `kv-prostar-metrics-prod` security boundary:

- create the dedicated vault when `deployNewKeyVault=true`, or bind it as existing when false;
- Azure RBAC authorization, 90-day soft delete, purge protection, and unchanged public networking with default action `Allow`;
- the existing `id-prostar-dispatch-prod` identity assigned only Key Vault Secrets User at the vault scope;
- three RSA 2048 keys restricted to `sign`/`verify`: `prostar-release-gate-evidence`, `prostar-release-browser-evidence`, and `prostar-release-reviewer-evidence`;
- three dedicated user-assigned identities, one for each evidence kind, with Key Vault Crypto User scoped only to that identity's corresponding key;
- control-plane Reader for each signer identity at the resource-group scope so the signer can resolve all three identities and fail closed on inherited, custom, or cross-key signing assignments; Reader grants no Key Vault data-plane operation;
- no owner/user principal and no identity receives a vault-wide cryptographic role from this module;
- optional control-plane secret definitions for PostgreSQL, Simpro, Easy Auth, and the PostgreSQL CA only;
- no PostgreSQL or Container Apps network, private endpoint, schedule, or unrelated secret resource.

`metrics.bicep` uses versionless Key Vault references with that user-assigned identity. The web app references DB, Simpro, and Easy Auth. The immutable app plus exact 23-job allowlist in `scripts/lib/production-targets.mjs` is shared by routine deployment and migration. Jobs reference DB and Simpro. The CA reference is included everywhere only when the production parameter file enables it.

## Vault Prerequisite

Vault provisioning is a separate, approved prerequisite. The migration never creates, deploys, deletes, or claims to roll back a purge-protected vault.

Compile and review the intended new-vault deployment:

```bash
az bicep build --file infra/azure/security.bicep --stdout >/dev/null

az deployment group what-if \
  --resource-group prostar-payroll \
  --name prostar-metrics-security-prerequisite-review \
  --template-file infra/azure/security.bicep \
  --parameters infra/azure/security.parameters.prod.example.json \
  --parameters deployNewKeyVault=true writeSecretValues=false \
  --result-format ResourceIdOnly \
  --no-pretty-print
```

After change approval, the infrastructure owner may replace `what-if` with `create`. If the dedicated vault already exists, use `deployNewKeyVault=false`; this binds the existing vault and provisions the three identities and deterministic key-scoped assignments without changing vault settings. Keep `writeSecretValues=false` for prerequisite and routine deployments.

Before migration or release-evidence publication, verify the concrete vault, app identity assignment, exact key-scoped signer assignments, and versioned signing keys:

```bash
az keyvault show \
  --resource-group prostar-payroll \
  --name kv-prostar-metrics-prod \
  --query "{id:id,rbac:properties.enableRbacAuthorization,softDelete:properties.enableSoftDelete,purgeProtection:properties.enablePurgeProtection,publicNetworkAccess:properties.publicNetworkAccess,defaultAction:properties.networkAcls.defaultAction}"

VAULT_ID="$(az keyvault show -g prostar-payroll -n kv-prostar-metrics-prod --query id -o tsv)"
PRINCIPAL_ID="$(az identity show -g prostar-payroll -n id-prostar-dispatch-prod --query principalId -o tsv)"
az role assignment list \
  --assignee-object-id "$PRINCIPAL_ID" \
  --scope "$VAULT_ID" \
  --include-inherited \
  --include-groups \
  --query "[].{scope:scope,principalId:principalId,role:roleDefinitionName,roleDefinitionId:roleDefinitionId}"

az role assignment list \
  --assignee-object-id "$PRINCIPAL_ID" \
  --all \
  --include-groups \
  --query "[].{scope:scope,principalId:principalId,role:roleDefinitionName,roleDefinitionId:roleDefinitionId}"

for binding in \
  'gate:id-prostar-release-gate-prod:prostar-release-gate-evidence' \
  'browser:id-prostar-release-browser-prod:prostar-release-browser-evidence' \
  'reviewer:id-prostar-release-reviewer-prod:prostar-release-reviewer-evidence'
do
  IFS=: read -r kind identity_name key <<<"$binding"
  signer_principal="$(az identity show -g prostar-payroll -n "$identity_name" --query principalId -o tsv)"
  key_scope="$VAULT_ID/keys/$key"
  az role assignment list \
    --scope "$key_scope" \
    --include-inherited \
    --query "[?roleDefinitionName=='Key Vault Crypto User'].{scope:scope,principalId:principalId,role:roleDefinitionName}"
  az keyvault key show \
    --vault-name kv-prostar-metrics-prod \
    --name "$key" \
    --query "{keyId:key.kid,keyType:key.kty,keyOps:key.keyOps,enabled:attributes.enabled}"
done
```

Each key query must show exactly one Crypto User assignment: the matching dedicated identity at the exact key scope. Any inherited vault-level Crypto User, Crypto Officer, Administrator, custom signing role, owner/user signing assignment, or cross-key signer assignment blocks release evidence. Because Azure incremental deployments do not delete role assignments removed from a template, the infrastructure owner must explicitly remove the legacy vault-wide `evidenceSignerPrincipalId` assignment before any receipt is trusted. Release receipts pin the concrete key version returned by `key.kid`; a key name without a version is not accepted.

The app identity remains Secrets User only and receives no key-signing role. A compromise of one evidence identity cannot authorize a signature with either of the other two keys.

The migration fails before baseline capture unless the dedicated vault has RBAC, soft delete, purge protection, public access/default allow, and exactly one direct Key Vault Secrets User assignment for the existing application identity at the exact vault scope. It resolves the role definitions for effective inherited assignments and direct vault/key/secret child-scope assignments. Any other effective Key Vault data-plane role, including one inherited through a group or parent scope, blocks migration and metadata-only verification.

## Key Vault Migration

The script has no resource, app, job, vault, identity, secret-name, or CA override. It derives those values from immutable repository contracts and rejects unknown target arguments. The optional CA setting comes only from `main.parameters.prod.example.json`.

One workflow owns preflight, branch selection, verification, and schema-v3 evidence. It first reads only ARM secret definitions and Key Vault version metadata. If all exact app plus 23 job definitions are already valid versionless references, both dry-run and `--execute` take a metadata-only no-op path. That path does not call Container Apps `listSecrets`, does not fetch a Key Vault secret version value, does not require Key Vault Secrets Officer, and performs no vault or Microsoft.App mutation. It still verifies:

- the exact 24-resource allowlist and exact owned definition set on every resource;
- every versionless vault URL and the application user-assigned identity;
- vault security metadata and the exact effective application-identity role invariant;
- one active enabled version in the metadata for every referenced allowlisted vault secret;
- database-aware health, the Easy Auth ARM contract, and browser/API unauthenticated behavior.

The workflow repeats all 24 target metadata reads and all allowlisted active-version metadata checks before completing the no-op. Its schema-v3 report truthfully records `metadata-only`, zero value access/writes, zero references changed, all 24 references verified, and no migration run ID.

If all targets are still inline, dry run performs the value-dependent consistency and rollback-baseline reads in process memory, captures only redacted target and Key Vault version metadata in evidence, and runs a real `security.bicep` what-if with `deployNewKeyVault=false writeSecretValues=false`:

```bash
node scripts/migrate-key-vault-secrets.mjs
```

Review `.work/infra-evidence/key-vault-migration-*.json`. Before an inline migration, establish an exclusive operational writer freeze: pause deployment and migration automation, confirm that no deployment or migration writer is active, generate a fresh UUIDv4 for this change window, and keep the freeze in place through success or fully verified compensation. Then execute with the fixed confirmations:

```bash
MIGRATION_RUN_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

node scripts/migrate-key-vault-secrets.mjs \
  --execute \
  --confirm=MIGRATE-PROSTAR-METRICS-KEY-VAULT \
  --writer-freeze-id="$MIGRATION_RUN_ID" \
  --confirm-writer-freeze=NO-CONCURRENT-PROSTAR-METRICS-SECRET-WRITERS
```

`--confirm-writer-freeze` is an operator attestation, not a cloud mutex. There is no existing Azure-native bounded lease in this migration's resource contract. The UUID is rejected if it is not UUIDv4 or is already present on owned secret-version metadata. Every accepted UUID is canonicalized to lowercase before confirmation binding, reporting, tagging, reuse checks, ownership checks, or compensation. Existing ownership-tag UUIDs are validated and canonicalized before case-insensitive equality; a malformed ownership tag fails closed wherever reuse or ownership safety depends on it. Every migration-created version is tagged at creation with the lowercase run ID and a source-write or rollback-restore phase. The script rechecks that exactly one same-run source-write version is active for each owned secret before each target patch and before activation. The operational freeze closes the remaining interval between a fresh state read and the following Microsoft.App property update.

Raw values remain in process memory only. Equality checks return the result of exactly one `timingSafeEqual` invocation on two fixed-length SHA-256 digests; there is no raw-length or raw-buffer comparison afterward. Digests are transient comparison inputs and are never logged or persisted. Container App/job value reads, reference writes, and rollback writes use bearer-authenticated ARM requests; raw values are never placed in process arguments. Evidence and logs contain no values or hashes.

The migration:

1. Classifies the complete exact target definition state from metadata and rejects mixed inline/reference mode or unrelated target secret definitions.
2. For inline migration, requires consistent values on the exact existing target set and captures each prior active version plus the pre-migration version metadata.
3. Requires the exclusive writer-freeze UUID and writes only allowlisted Key Vault names, with exact run ownership persisted in version tags at creation.
4. Immediately before each property-only ARM patch, re-reads the complete owned secret set and requires it to match the captured baseline or the exact intended Key Vault-reference state. It then verifies every exact versionless URL and identity after the patch.
5. Before activation, freshly verifies the complete target reference state and same-run active vault-version ownership, then restarts the latest web revision and verifies database-aware health, Easy Auth configuration, and the unauthenticated login redirect.
6. On failure, disables only source-write versions whose metadata proves the exact current run ID, then re-lists complete version metadata. A version merely absent from the baseline is never considered owned and is never patched by compensation.
7. Establishes versionless ordering only from unique version IDs and a unique, complete `created` order. Missing timestamps, duplicate IDs, or a tie for newest fail closed for manual reconciliation before any rollback PUT.
8. If an enabled unrelated post-baseline rotation is the proven versionless active version, leaves it enabled and active and does not publish older baseline material over it. If an enabled unrelated rotation exists but cannot be proven active, compensation also fails closed without a PUT.
9. Publishes a run-tagged baseline rollback-restore version only when there is no enabled unrelated post-baseline rotation and baseline restoration is still appropriate. Disabled unrelated versions are left untouched. With no prior active baseline, compensation publishes nothing unless an unrelated active rotation is being preserved.
10. Creates one stable per-secret compensation journal summary before its first mutation and updates it immediately after ownership resolution, every completed disable, the post-disable verification, each preserve/restore decision, restore publication, and restore verification. A later ordering, planning, publication, or verification failure leaves that summary `incomplete`, with the exact last completed phase, failure phase, and already-disabled version IDs; no values or hashes enter the journal. Evidence upserts by secret name, so it contains one final consistent summary rather than duplicate phase snapshots. It then restores attempted app/job definitions in reverse order, restarts the web revision, and verifies exact target rollback plus health/auth.

Azure has no transaction spanning 24 Container Apps resources and Key Vault. The script does not claim atomicity. The externally enforced writer freeze, full pre-capture, immediate exact-state pre-read before every property-only patch, whole-set post-write verification, verification before activation, and ordered run-owned compensation form the required execution invariant. The script never enumerates, writes, disables, or deletes any non-allowlisted Key Vault secret and never touches unrelated app/job secret names.

Key Vault Secrets Officer is needed only for operator value writes and version disabling/restoration, not for the metadata-only no-op. Remove the operator's temporary Secrets Officer assignment immediately after all value-dependent migration, restore, or deployment operations and their compensation checks finish. Do not remove the application identity's permanent, exact-scope Key Vault Secrets User assignment. Release the operational writer freeze only after the redacted report records success or fully verified compensation.

## Routine Release Contract

The release-owned `scripts/deploy-prod.mjs` currently imports the canonical 23-job allowlist and implements the versionless-reference preflight. That worker must retain these requirements:

1. Production parameters with `useKeyVaultSecretReferences=true` remain authoritative.
2. Container Apps what-if, candidate, and rollback calls never submit DB, Simpro, Easy Auth, or CA values.
3. All 24 resources must match exact name, versionless `keyVaultUrl`, and identity definitions with no `value` field.
4. The direct Key Vault Secrets User assignment must be verified before image build or database migration.
5. All three purpose-specific evidence keys must be enabled and version-pinned in deployment provenance before evidence validation.
6. Optional CA, semantic what-if, health, Easy Auth, traffic, digest, and image rollback gates remain intact.

The separately named `AZURE_POSTGRES_MIGRATION_CONNECTION_STRING` remains limited to privileged database migration/firewall gates; it is not a Container Apps deployment input.

## Release Evidence Signing

There is no general-purpose receipt issuer and no `RELEASE_*_RECEIPT_ISSUER_URL` setting. The signing adapter sends only a SHA-256 digest to a version-pinned Azure Key Vault key. Before signing, it resolves the dedicated identity for the requested evidence kind, decodes the active Key Vault access token, and requires both token `oid` and `azp`/`appid` to match that identity. It also rejects a key whose name belongs to another evidence kind. The publisher neither creates nor signs receipts.

The owner workstation is intentionally not a signer. `evidence-runners.bicep` defines three controlled event-triggered Container Apps Jobs, each carrying only its corresponding user-assigned identity. The jobs process bounded storage/queue handoffs and sign only their fixed evidence kind. The gate job runs the immutable production command set, the browser job validates supplied artifacts, and the reviewer job validates externally supplied review-report content.

Prerequisites for evidence production:

- the legacy owner/user vault-wide cryptographic role has been removed and the exact role audit above passes;
- that identity has Key Vault Crypto User only on its corresponding key;
- the live runner/RBAC check finds the exact 19 deterministic direct assignments and no extra effective Blob/Queue data-plane role at the evidence scopes, including assignments inherited from the storage account, resource group, or subscription;
- commission-export Blob Contributor remains scoped to the `commission-exports` container so it cannot inherit onto evidence containers;
- deploy-prod has written a fresh schema-v3 deployment manifest containing the three live versioned key IDs;
- supplied E2E/accessibility reports and their referenced artifacts are sanitized, hash-bound, and locally validated before browser-job submission; and
- the external review report declares `authorship: "NOT_AUTHENTICATED"` and `reviewProcess: "SEPARATE_AGENT_REQUIRED"`.

A zero exit code is not evidence. The exact production gate commands are `npm run test:unit`, `npm run test:integration`, `npm run test:scripts`, `npm run test:infra`, and `npm run build`. The test reporter emits one schema-v2 `PROSTAR_EVIDENCE_ASSERTION` event per observed test result. The build wrapper emits only after validating freshly generated build manifests. Claim IDs are derived from category plus provenance and every claim carries exact observed counts. Raw emitted events, structured results, aggregate counts, and gate report claims must agree exactly. A zero-exit command with no events fails and writes no result.

The browser job does not launch a browser or claim capture provenance. It validates the exact supplied report paths and hashes, every referenced artifact path/hash, deployment nonce, revision, image digest, actor, coverage, and timestamps. Its `validated-browser-artifacts` receipt authenticates only that validation result.

Separate-agent review remains a release process gate. The reviewer job verifies report shape, complete feature scope, reviewed artifact hashes, freshness, and the `SHIP:`/`DO NOT SHIP:` decision. Its `external-review-report-validation` receipt authenticates the validated bytes, not the report author. Authorship is explicitly unauthenticated and the receipt is not an independence attestation.

The storage account has one ARM lifecycle singleton. Both `metrics.bicep` and `evidence-runners.bicep` compile to the identical policy containing exactly: seven-year commission-export retention, one-day evidence `runs/` cleanup, and seven-day replay-ledger cleanup. Postdeploy validation requires all three rules live and rejects additions, omissions, or drift.

Use the current package commands. First validate supplied browser artifacts locally:

```bash
npm run release:browser:validate -- \
  --deployment-manifest docs/prostar-metrics/verification/deployment-manifest.json \
  --e2e-report docs/prostar-metrics/verification/browser/e2e-report.json \
  --a11y-report docs/prostar-metrics/verification/accessibility/a11y-report.json \
  --output docs/prostar-metrics/verification/browser/validated-artifacts.json

npm run release:evidence:submit -- \
  --kind browser \
  --deployment-manifest docs/prostar-metrics/verification/deployment-manifest.json \
  --e2e-report docs/prostar-metrics/verification/browser/e2e-report.json \
  --a11y-report docs/prostar-metrics/verification/accessibility/a11y-report.json \
  --producer-result docs/prostar-metrics/verification/browser/validated-artifacts.json

npm run release:evidence:submit -- \
  --kind gate \
  --deployment-manifest docs/prostar-metrics/verification/deployment-manifest.json \
  --e2e-report docs/prostar-metrics/verification/browser/e2e-report.json \
  --a11y-report docs/prostar-metrics/verification/accessibility/a11y-report.json \
  --browser-attestation docs/prostar-metrics/verification/browser/validated-artifacts-receipt.json

npm run release:evidence:submit -- \
  --kind reviewer \
  --deployment-manifest docs/prostar-metrics/verification/deployment-manifest.json \
  --e2e-report docs/prostar-metrics/verification/browser/e2e-report.json \
  --a11y-report docs/prostar-metrics/verification/accessibility/a11y-report.json \
  --browser-attestation docs/prostar-metrics/verification/browser/validated-artifacts-receipt.json \
  --gate-report '<gate command gateReportPath>' \
  --gate-runner-receipt '<gate command runnerReceiptPath>' \
  --reviewer-report docs/prostar-metrics/verification/reviewer/external-review-report.json

npm run release:evidence:publish -- \
  --deployment-manifest docs/prostar-metrics/verification/deployment-manifest.json \
  --e2e-report docs/prostar-metrics/verification/browser/e2e-report.json \
  --a11y-report docs/prostar-metrics/verification/accessibility/a11y-report.json \
  --reviewer-attestation docs/prostar-metrics/verification/reviewer/external-review-report-validation-receipt.json \
  --reviewer-report docs/prostar-metrics/verification/reviewer/external-review-report.json \
  --gate-report '<gate command gateReportPath>'
```

Every handoff has a random 256-bit nonce, UUID message ID, `issuedAt`, and `expiresAt`; queue, bundle, replay record, output, and receipt bind the same request. Replay records are create-only. Client cleanup always attempts both blobs, while the merged lifecycle handles orphans. The deployment must be less than 24 hours old. Browser and gate validation evidence must be less than two hours old; the external report and validation receipt must follow them and be less than one hour old. Bundles and logs reject credential material.

## Point-In-Time Restore Drill

The drill targets only `prostar-payroll/pg-prostar-metrics-prod` and generates a unique temporary server name. Target overrides are rejected. The source network/configuration is captured and compared after cleanup; no source firewall, VNet, subnet, private DNS, configuration, or schedule is changed.

`--caller-ip` is required for both dry-run and execution and must be one globally routable IPv4 address. The script rejects unspecified/broadcast, loopback, RFC1918, link-local, CGNAT, protocol-assignment, documentation, benchmarking, deprecated relay, multicast, and reserved ranges.

Dry run performs repository-manifest generation plus source/vault metadata checks and writes a secret-free plan:

```bash
node scripts/restore-postgres-drill.mjs \
  --caller-ip "<globally-routable-public-ip>" \
  --restore-time "<UTC-ISO8601>"
```

Execute after review:

```bash
node scripts/restore-postgres-drill.mjs \
  --execute \
  --confirm=RESTORE-PG-PROSTAR-METRICS-PROD \
  --caller-ip "<globally-routable-public-ip>" \
  --restore-time "<UTC-ISO8601>"
```

Add `--use-ca-secret` only when the CA secret is populated. The drill validates:

- the temporary connection uses TLS according to `pg_stat_ssl`;
- an exact manifest generated by applying every repository migration in filename order;
- exact metrics schema/table/column ordinal/name/type/nullability/default definitions;
- exact constraints and indexes;
- exact migration filenames and SHA-256 hashes;
- row counts as evidence only, explicitly not compared with a source baseline.

In `finally`, the script independently attempts temporary firewall removal, temporary server deletion, CLI absence, direct ARM absence, and source-contract comparison. CLI absence is accepted only for an explicit `ResourceNotFound` code. ARM absence is accepted only for HTTP 404. Authorization, permission, timeout, network, throttling, and service errors propagate as cleanup failures. Both absence checks must pass.

Emergency cleanup may use only the temporary name recorded by the dry-run/execution report:

```bash
az postgres flexible-server firewall-rule delete \
  --resource-group prostar-payroll \
  --name "<pg-psm-drill-...>" \
  --rule-name restore-drill-caller \
  --yes

az postgres flexible-server delete \
  --resource-group prostar-payroll \
  --name "<pg-psm-drill-...>" \
  --yes
```

Never substitute `pg-prostar-metrics-prod` into a firewall or delete command.

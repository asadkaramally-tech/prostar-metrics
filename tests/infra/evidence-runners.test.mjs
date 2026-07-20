import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PRODUCTION_JOB_NAMES } from "../../scripts/lib/production-targets.mjs";

const [bicep, metricsBicep, parameters, dockerfile] = await Promise.all([
  readFile(new URL("../../infra/azure/evidence-runners.bicep", import.meta.url), "utf8"),
  readFile(new URL("../../infra/azure/metrics.bicep", import.meta.url), "utf8"),
  readFile(new URL("../../infra/azure/evidence-runners.parameters.prod.example.json", import.meta.url), "utf8"),
  readFile(new URL("../../Dockerfile.evidence-runner", import.meta.url), "utf8"),
]);
const parameterDocument = JSON.parse(parameters);

test("three isolated event jobs remain outside the app plus 24 routine deployment contract", () => {
  const jobs = ["job-psm-evidence-gate", "job-psm-evidence-browser", "job-psm-evidence-reviewer"];
  for (const name of jobs) {
    assert.match(bicep, new RegExp(`jobName: '${name}'`));
    assert.equal(PRODUCTION_JOB_NAMES.includes(name), false);
  }
  assert.match(bicep, /triggerType: 'Event'/);
  assert.match(bicep, /minExecutions: 0/);
  assert.match(bicep, /maxExecutions: 1/);
  assert.doesNotMatch(bicep, /triggerType: 'Manual'|jobs\/start\/action/);
});

test("each runner has one fixed signer identity, queue, container, image, and command", () => {
  for (const kind of ["gate", "browser", "reviewer"]) {
    assert.match(bicep, new RegExp(`kind: '${kind}'[\\s\\S]*?containerName: 'release-evidence-${kind}'[\\s\\S]*?queueName: 'release-evidence-${kind}'`));
  }
  assert.match(bicep, /type: 'UserAssigned'/);
  assert.match(bicep, /'\$\{signerIdentities\[index\]\.id\}': \{\}/);
  assert.match(bicep, /image: evidenceRunnerImage/);
  assert.match(bicep, /'scripts\/run-release-evidence-job\.mjs'/);
  assert.match(bicep, /'--kind'\s*runner\.kind/);
  assert.doesNotMatch(bicep, /containerImage.*latest|param evidenceRunnerImage string\s*=/);
});

test("operator can upload and enqueue but receives no job or Key Vault role", () => {
  assert.match(bicep, /ba92f5b4-2d11-453d-a403-e96b0029c9fe/);
  assert.match(bicep, /c6a89b2d-59bc-44d0-9896-0f6e12d7b80a/);
  assert.equal((bicep.match(/principalId: operatorPrincipalId/g) ?? []).length, 2);
  assert.doesNotMatch(bicep, /scope: evidenceJobs|principalId: operatorPrincipalId[\s\S]{0,200}KeyVault/);
  assert.equal(parameterDocument.parameters.operatorPrincipalId.value, "f7293194-18c0-4957-b259-9cd6ef8d492b");
});

test("signers receive only per-kind handoff roles, ACR pull, read-only cross-key verification, and one gate secret", () => {
  assert.match(bicep, /8a0f0c08-91a1-4084-bc3d-661d67233fed/);
  assert.match(bicep, /7f951dda-4ed3-4680-a7ca-43fe172d538d/);
  assert.match(bicep, /Microsoft\.KeyVault\/vaults\/keys\/read/);
  assert.doesNotMatch(bicep, /dataActions:[\s\S]{0,120}keys\/sign/);
  assert.match(bicep, /scope: postgresConnectionSecret/);
  assert.match(bicep, /runner\.kind == 'gate'/);
  const parameterValues = JSON.stringify(Object.values(parameterDocument.parameters).map(({ value }) => value));
  assert.doesNotMatch(parameterValues, /postgres(?:ql)?:\/\/|password=|bearer\s|client_secret/i);
});

test("template materializes the exact 19-assignment policy and fixed custom-role permission arrays", () => {
  for (const resource of [
    "signerBlobRoles", "signerQueueRoles", "operatorBlobRoles", "operatorQueueRoles",
    "signerAcrPullRoles", "signerPublicKeyReaderRoles",
  ]) {
    assert.match(bicep, new RegExp(`resource ${resource}[^=]+= \\[for`));
  }
  assert.match(bicep, /resource gatePostgresSecretReader[^=]+= \{/);
  assert.match(bicep, /var evidencePublicKeyReaderRoleId = 'f8e7848d-52cd-4c6e-a6e6-efbcb59fc819'/);
  assert.match(bicep, /actions: \[\]\s*notActions: \[\]\s*dataActions: \[\s*'Microsoft\.KeyVault\/vaults\/keys\/read'\s*\]\s*notDataActions: \[\]/);
  for (const expression of [
    "guid(handoffContainers[index].id, signerIdentities[index].id, blobDataContributorRoleDefinitionId)",
    "guid(handoffQueues[index].id, signerIdentities[index].id, queueMessageProcessorRoleDefinitionId)",
    "guid(handoffContainers[index].id, operatorPrincipalId, blobDataContributorRoleDefinitionId)",
    "guid(handoffQueues[index].id, operatorPrincipalId, queueMessageSenderRoleDefinitionId)",
    "guid(acr.id, signerIdentities[index].id, acrPullRoleDefinitionId)",
    "guid(keyVault.id, signerIdentities[index].id, evidencePublicKeyReaderRole.id)",
    "guid(postgresConnectionSecret.id, signerIdentities[0].id, keyVaultSecretsUserRoleDefinitionId)",
  ]) assert.equal(bicep.includes(expression), true, `missing deterministic assignment expression ${expression}`);
});

test("both lifecycle owners compile to the identical complete three-rule policy", (t) => {
  assert.match(bicep, /resource evidenceHandoffLifecycle 'Microsoft\.Storage\/storageAccounts\/managementPolicies@2023-05-01'/);
  assert.match(metricsBicep, /resource commissionExportLifecycle 'Microsoft\.Storage\/storageAccounts\/managementPolicies@2023-05-01'/);
  const probe = spawnSync("az", ["bicep", "version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    t.skip("Azure CLI is not installed");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);
  const policies = ["metrics.bicep", "evidence-runners.bicep"].map((name) => {
    const path = fileURLToPath(new URL(`../../infra/azure/${name}`, import.meta.url));
    const result = spawnSync("az", ["bicep", "build", "--file", path, "--stdout"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const template = JSON.parse(result.stdout);
    const resources = template.resources.filter(({ type }) => type === "Microsoft.Storage/storageAccounts/managementPolicies");
    assert.equal(resources.length, 1, `${name} must own exactly one managementPolicies/default singleton`);
    assert.equal(resources[0].apiVersion, "2023-05-01");
    return resources[0].properties.policy;
  });
  assert.deepEqual(policies[0], policies[1]);
  assert.deepEqual(policies[0].rules.map(({ name }) => name), [
    "retain-commission-exports-seven-years",
    "delete-orphaned-release-evidence-handoffs",
    "expire-release-evidence-replay-ledger",
  ]);
});

test("runner image contains Node and Azure CLI but no credential material", () => {
  assert.match(dockerfile, /mcr\.microsoft\.com\/azure-cli:2\.76\.0-azurelinux3\.0/);
  assert.match(dockerfile, /node:24-bookworm-slim/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.doesNotMatch(dockerfile, /ARG .*SECRET|ENV .*TOKEN|az login/);
});

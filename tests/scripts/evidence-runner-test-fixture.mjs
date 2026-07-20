import {
  EVIDENCE_PUBLIC_KEY_READER_ROLE_ID,
  EVIDENCE_RUNNER_SUBSCRIPTION_ID,
  buildEvidenceRunnerPolicy,
} from "../../scripts/deploy-evidence-runners.mjs";

export const evidenceSourceSha256 = "a".repeat(64);
export const evidencePinnedImage = `acrprostardispatchprod.azurecr.io/prostar-metrics-evidence@sha256:${"b".repeat(64)}`;
export const evidenceOperatorPrincipalId = "f7293194-18c0-4957-b259-9cd6ef8d492b";

export function evidenceRunnerOptions() {
  const base = `/subscriptions/${EVIDENCE_RUNNER_SUBSCRIPTION_ID}/resourceGroups/prostar-payroll/providers/Microsoft.ManagedIdentity/userAssignedIdentities`;
  return {
    operatorPrincipalId: evidenceOperatorPrincipalId,
    identities: {
      gate: identity(`${base}/id-prostar-release-gate-prod`, "123e4567-e89b-42d3-a456-426614174001", "123e4567-e89b-42d3-a456-426614174011"),
      browser: identity(`${base}/id-prostar-release-browser-prod`, "223e4567-e89b-42d3-a456-426614174002", "223e4567-e89b-42d3-a456-426614174012"),
      reviewer: identity(`${base}/id-prostar-release-reviewer-prod`, "323e4567-e89b-42d3-a456-426614174003", "323e4567-e89b-42d3-a456-426614174013"),
    },
    pinnedImage: evidencePinnedImage,
    sourceSha256: evidenceSourceSha256,
  };
}

export function evidenceRunnerWhatIfFixture() {
  const options = evidenceRunnerOptions();
  const policy = buildEvidenceRunnerPolicy(options);
  const changes = [];
  for (const [kind, runner] of Object.entries(policy.runners)) {
    const output = {
      kind,
      name: runner.jobName,
      jobId: runner.jobId,
      identityId: runner.identityId,
      clientId: runner.clientId,
      containerName: runner.containerName,
      queueName: runner.queueName,
    };
    changes.push(change(runner.jobId, "Microsoft.App/jobs", "2025-07-01", runnerJob({
      output,
      pinnedImage: options.pinnedImage,
      sourceSha256: options.sourceSha256,
      environmentId: policy.environmentId,
    })));
    changes.push(change(runner.containerId, "Microsoft.Storage/storageAccounts/blobServices/containers", "2023-05-01", {
      id: runner.containerId,
      name: `stprostarmetricsexports/default/${runner.containerName}`,
      type: "Microsoft.Storage/storageAccounts/blobServices/containers",
      properties: { publicAccess: "None", immutableStorageWithVersioning: { enabled: false } },
    }));
    changes.push(change(runner.queueId, "Microsoft.Storage/storageAccounts/queueServices/queues", "2023-05-01", {
      id: runner.queueId,
      name: `stprostarmetricsexports/default/${runner.queueName}`,
      type: "Microsoft.Storage/storageAccounts/queueServices/queues",
    }));
  }
  changes.push(change(policy.customRoleDefinitionId, "Microsoft.Authorization/roleDefinitions", "2022-04-01", {
    id: policy.customRoleDefinitionId,
    name: EVIDENCE_PUBLIC_KEY_READER_ROLE_ID,
    type: "Microsoft.Authorization/roleDefinitions",
    properties: {
      roleName: "ProStar Evidence Public Key Reader",
      description: "Reads evidence public keys for receipt verification without any signing action.",
      type: "CustomRole",
      permissions: [{
        actions: [],
        notActions: [],
        dataActions: ["Microsoft.KeyVault/vaults/keys/read"],
        notDataActions: [],
      }],
      assignableScopes: [policy.resourceGroupScope],
    },
  }));
  changes.push(change(policy.lifecyclePolicyId, "Microsoft.Storage/storageAccounts/managementPolicies", "2023-05-01", {
    id: policy.lifecyclePolicyId,
    name: "stprostarmetricsexports/default",
    type: "Microsoft.Storage/storageAccounts/managementPolicies",
    properties: { policy: { rules: lifecycleRules() } },
  }));
  policy.assignments.forEach((assignment) => {
    changes.push(change(assignment.id, "Microsoft.Authorization/roleAssignments", "2022-04-01", {
      id: assignment.id,
      name: assignment.name,
      type: "Microsoft.Authorization/roleAssignments",
      properties: {
        principalId: assignment.principalId,
        principalType: assignment.principalType,
        roleDefinitionId: assignment.roleDefinitionId,
      },
    }));
  });
  return { document: { status: "Succeeded", error: null, changes }, options, policy };
}

export function runnerJob({ output, pinnedImage, sourceSha256, environmentId = null }) {
  const env = [
    { name: "NODE_ENV", value: "test" },
    { name: "AZURE_CLIENT_ID", value: output.clientId },
    { name: "AZURE_SUBSCRIPTION_ID", value: EVIDENCE_RUNNER_SUBSCRIPTION_ID },
    { name: "AZURE_RESOURCE_GROUP", value: "prostar-payroll" },
    { name: "RELEASE_EVIDENCE_KIND", value: output.kind },
    { name: "RELEASE_EVIDENCE_STORAGE_ACCOUNT", value: "stprostarmetricsexports" },
    { name: "RELEASE_EVIDENCE_CONTAINER", value: output.containerName },
    { name: "RELEASE_EVIDENCE_QUEUE", value: output.queueName },
    { name: "RELEASE_EVIDENCE_SOURCE_SHA256", value: sourceSha256 },
  ];
  const secrets = [];
  if (output.kind === "gate") {
    env.push({ name: "AZURE_POSTGRES_CONNECTION_STRING", secretRef: "postgres-connection" });
    secrets.push({
      name: "postgres-connection",
      keyVaultUrl: "https://kv-prostar-metrics-prod.vault.azure.net/secrets/azure-postgres-connection-string",
      identity: output.identityId,
    });
  }
  return {
    id: output.jobId,
    location: "westus2",
    name: output.name,
    type: "Microsoft.App/jobs",
    tags: {
      workload: "prostar-metrics",
      environment: "prod",
      managedBy: "bicep",
      component: "release-evidence-runner",
      evidenceKind: output.kind,
    },
    identity: { type: "UserAssigned", userAssignedIdentities: { [output.identityId]: {} } },
    properties: {
      ...(environmentId ? { environmentId } : {}),
      configuration: {
        triggerType: "Event",
        replicaTimeout: 7200,
        replicaRetryLimit: 1,
        eventTriggerConfig: {
          parallelism: 1,
          replicaCompletionCount: 1,
          scale: {
            minExecutions: 0,
            maxExecutions: 1,
            pollingInterval: 30,
            rules: [{
              name: `${output.kind}-queue`,
              type: "azure-queue",
              identity: output.identityId,
              metadata: {
                accountName: "stprostarmetricsexports",
                queueName: output.queueName,
                queueLength: "1",
              },
            }],
          },
        },
        secrets,
        registries: [{ server: "acrprostardispatchprod.azurecr.io", identity: output.identityId }],
      },
      template: { containers: [{
        name: `evidence-${output.kind}`,
        image: pinnedImage,
        command: ["node"],
        args: ["scripts/run-release-evidence-job.mjs", "--kind", output.kind],
        env,
        resources: { cpu: 1, memory: "2Gi" },
      }] },
    },
  };
}

function identity(id, principalId, clientId) {
  return { id, principalId, clientId };
}

function change(resourceId, resourceType, apiVersion, after) {
  return {
    after: { apiVersion, ...after },
    before: null,
    changeType: "Create",
    delta: null,
    resourceId,
  };
}

function lifecycleRules() {
  return [
    {
      name: "retain-commission-exports-seven-years",
      enabled: true,
      type: "Lifecycle",
      definition: {
        actions: {
          baseBlob: { delete: { daysAfterModificationGreaterThan: 2555 } },
          snapshot: { delete: { daysAfterCreationGreaterThan: 2555 } },
          version: { delete: { daysAfterCreationGreaterThan: 2555 } },
        },
        filters: { blobTypes: ["blockBlob"], prefixMatch: ["commission-exports/"] },
      },
    },
    lifecycleRule("delete-orphaned-release-evidence-handoffs", "runs", 1),
    lifecycleRule("expire-release-evidence-replay-ledger", "replay-ledger", 7),
  ];
}

function lifecycleRule(name, segment, days) {
  return {
    enabled: true,
    name,
    type: "Lifecycle",
    definition: {
      filters: {
        blobTypes: ["blockBlob"],
        prefixMatch: ["gate", "browser", "reviewer"].map((kind) => `release-evidence-${kind}/${segment}/`),
      },
      actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: days } } },
    },
  };
}

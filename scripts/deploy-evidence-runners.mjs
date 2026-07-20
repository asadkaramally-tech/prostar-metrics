import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  azureChildEnvironment,
  computeDockerBuildContext,
  DEPLOYMENT_MANIFEST_PATH,
  PRODUCTION_ACR,
  PRODUCTION_RESOURCE_GROUP,
  validateDeploymentManifestDocument,
} from "./lib/deployment-provenance.mjs";

export const EVIDENCE_RUNNER_SUBSCRIPTION_ID = "d7a98155-9693-4c6b-ad27-39e945c0f751";
export const EVIDENCE_RUNNER_STORAGE_ACCOUNT = "stprostarmetricsexports";
export const EVIDENCE_RUNNER_KEY_VAULT = "kv-prostar-metrics-prod";
export const EVIDENCE_PUBLIC_KEY_READER_ROLE_ID = "f8e7848d-52cd-4c6e-a6e6-efbcb59fc819";

const repository = "prostar-metrics-evidence";
const templatePath = "infra/azure/evidence-runners.bicep";
const parametersPath = "infra/azure/evidence-runners.parameters.prod.example.json";
const confirmation = "DEPLOY_EVIDENCE_RUNNERS";
const postgresSecretName = "azure-postgres-connection-string";
const commissionExportContainerName = "commission-exports";
const containerAppsEnvironmentName = "cae-prostar-dispatch-prod";
const runnerKinds = Object.freeze(["gate", "browser", "reviewer"]);
const roleIds = Object.freeze({
  acrPull: "7f951dda-4ed3-4680-a7ca-43fe172d538d",
  blobDataContributor: "ba92f5b4-2d11-453d-a403-e96b0029c9fe",
  queueMessageProcessor: "8a0f0c08-91a1-4084-bc3d-661d67233fed",
  queueMessageSender: "c6a89b2d-59bc-44d0-9896-0f6e12d7b80a",
  keyVaultSecretsUser: "4633458b-17de-408a-b874-0445c86b69e6",
});
const runnerDefinitions = Object.freeze({
  gate: Object.freeze({
    jobName: "job-psm-evidence-gate",
    identityName: "id-prostar-release-gate-prod",
    containerName: "release-evidence-gate",
    queueName: "release-evidence-gate",
  }),
  browser: Object.freeze({
    jobName: "job-psm-evidence-browser",
    identityName: "id-prostar-release-browser-prod",
    containerName: "release-evidence-browser",
    queueName: "release-evidence-browser",
  }),
  reviewer: Object.freeze({
    jobName: "job-psm-evidence-reviewer",
    identityName: "id-prostar-release-reviewer-prod",
    containerName: "release-evidence-reviewer",
    queueName: "release-evidence-reviewer",
  }),
});
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const armGuidNamespace = "11fb06fb-712d-4ddd-98c7-e71bbd588830";
const apiVersions = Object.freeze({
  job: "2025-07-01",
  container: "2023-05-01",
  queue: "2023-05-01",
  lifecycle: "2023-05-01",
  customRole: "2022-04-01",
  assignment: "2022-04-01",
});

export async function deployEvidenceRunners({
  root = process.cwd(),
  deploymentManifestPath = DEPLOYMENT_MANIFEST_PATH,
  execute = false,
  confirm = null,
  runAzJson = defaultRunAzJson,
}) {
  const projectRoot = await realpath(resolve(root));
  const manifest = JSON.parse(await readFile(resolve(projectRoot, deploymentManifestPath), "utf8"));
  await validateDeploymentManifestDocument(manifest);
  const source = await computeDockerBuildContext(projectRoot);
  if (source.sha256 !== manifest.buildSourceSha256) {
    throw new Error("evidence runners can be deployed only after the current source is the pinned candidate source");
  }
  const parameters = JSON.parse(await readFile(resolve(projectRoot, parametersPath), "utf8"));
  const operatorPrincipalId = parameters.parameters?.operatorPrincipalId?.value;
  if (!uuidPattern.test(operatorPrincipalId ?? "")) throw new Error("evidence runner operatorPrincipalId is invalid");
  if (!execute) {
    return {
      mode: "dry-run",
      sourceSha256: source.sha256,
      candidateImage: manifest.pinnedImage,
      nextCommand: `npm run release:runners:deploy -- --execute --confirm ${confirmation}`,
      azureWrites: false,
    };
  }
  if (confirm !== confirmation) throw new Error(`execution requires --confirm ${confirmation}`);
  const account = await runAzJson(["account", "show", "--output", "json", "--only-show-errors"], projectRoot);
  if (account?.id?.toLowerCase() !== EVIDENCE_RUNNER_SUBSCRIPTION_ID) {
    throw new Error("active Azure subscription is not the locked production subscription");
  }
  const operator = await runAzJson([
    "ad", "signed-in-user", "show", "--query", "{id:id}", "--output", "json", "--only-show-errors",
  ], projectRoot);
  if (operator?.id?.toLowerCase() !== operatorPrincipalId.toLowerCase()) {
    throw new Error("active Azure user is not the guarded evidence handoff operator");
  }
  const identities = await loadEvidenceRunnerIdentities({ runAzJson, projectRoot });

  const imageTag = `evidence-${source.sha256.slice(0, 16)}-${randomUUID().slice(0, 8)}`;
  const build = await runAzJson([
    "acr", "build", "--registry", PRODUCTION_ACR,
    "--image", `${repository}:${imageTag}`,
    "--file", "Dockerfile.evidence-runner",
    "--no-logs", "--output", "json", "--only-show-errors", ".",
  ], projectRoot);
  const runId = build?.runId ?? build?.id;
  if (build?.status !== "Succeeded" || typeof runId !== "string" || !runId) {
    throw new Error("evidence runner ACR build did not return a successful immutable run");
  }
  const image = await runAzJson([
    "acr", "repository", "show", "--name", PRODUCTION_ACR,
    "--image", `${repository}:${imageTag}`, "--output", "json", "--only-show-errors",
  ], projectRoot);
  if (!/^sha256:[a-f0-9]{64}$/.test(image?.digest ?? "")) {
    throw new Error("evidence runner ACR image has no immutable digest");
  }
  const pinnedImage = `${PRODUCTION_ACR}.azurecr.io/${repository}@${image.digest}`;
  const deploymentName = `prostar-evidence-runners-${randomUUID()}`;
  const deploymentArgs = [
    "--resource-group", PRODUCTION_RESOURCE_GROUP,
    "--name", deploymentName,
    "--template-file", templatePath,
    "--parameters", `@${parametersPath}`,
    "--parameters", `evidenceRunnerImage=${pinnedImage}`, `candidateSourceSha256=${source.sha256}`,
  ];
  const validationOptions = {
    operatorPrincipalId,
    identities,
    pinnedImage,
    sourceSha256: source.sha256,
  };
  await runEvidenceRunnerWhatIf({
    runAzJson,
    projectRoot,
    deploymentArgs,
    validationOptions,
  });
  const deployment = await runAzJson([
    "deployment", "group", "create", ...deploymentArgs, "--output", "json", "--only-show-errors",
  ], projectRoot);
  if (deployment?.properties?.provisioningState !== "Succeeded") {
    throw new Error("evidence runner ARM deployment did not succeed");
  }
  await validateEvidenceRunnerLiveResources({
    runAzJson,
    projectRoot,
    ...validationOptions,
  });
  return {
    mode: "executed",
    deploymentName,
    sourceSha256: source.sha256,
    runnerImage: pinnedImage,
    acrBuildRunId: runId,
    jobs: runnerKinds.map((kind) => ({ kind, name: runnerDefinitions[kind].jobName })),
  };
}

export async function runEvidenceRunnerWhatIf({ runAzJson, projectRoot, deploymentArgs, validationOptions }) {
  const document = await runAzJson([
    "deployment", "group", "what-if", ...deploymentArgs,
    "--result-format", "FullResourcePayloads", "--no-pretty-print",
    "--output", "json", "--only-show-errors",
  ], projectRoot);
  const normalized = normalizeEvidenceRunnerWhatIfEnvelope(document);
  validateEvidenceRunnerWhatIf(normalized, validationOptions);
  return normalized;
}

export function buildEvidenceRunnerPolicy({ operatorPrincipalId, identities }) {
  if (!uuidPattern.test(operatorPrincipalId ?? "")) throw new Error("evidence runner policy operator principal is invalid");
  const subscriptionScope = `/subscriptions/${EVIDENCE_RUNNER_SUBSCRIPTION_ID}`;
  const resourceGroupScope = `${subscriptionScope}/resourceGroups/${PRODUCTION_RESOURCE_GROUP}`;
  const storageScope = `${resourceGroupScope}/providers/Microsoft.Storage/storageAccounts/${EVIDENCE_RUNNER_STORAGE_ACCOUNT}`;
  const acrScope = `${resourceGroupScope}/providers/Microsoft.ContainerRegistry/registries/${PRODUCTION_ACR}`;
  const vaultScope = `${resourceGroupScope}/providers/Microsoft.KeyVault/vaults/${EVIDENCE_RUNNER_KEY_VAULT}`;
  const secretScope = `${vaultScope}/secrets/${postgresSecretName}`;
  const customRoleDefinitionId = `${resourceGroupScope}/providers/Microsoft.Authorization/roleDefinitions/${EVIDENCE_PUBLIC_KEY_READER_ROLE_ID}`;
  const builtInRole = (roleId) => `${subscriptionScope}/providers/Microsoft.Authorization/roleDefinitions/${roleId}`;
  const runners = {};
  for (const kind of runnerKinds) {
    const definition = runnerDefinitions[kind];
    const identity = identities?.[kind];
    const expectedIdentityId = `${resourceGroupScope}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${definition.identityName}`;
    if (
      !identity
      || normalizeId(identity.id) !== normalizeId(expectedIdentityId)
      || !uuidPattern.test(identity.principalId ?? "")
      || !uuidPattern.test(identity.clientId ?? "")
    ) throw new Error(`${kind} evidence runner identity lookup is invalid`);
    runners[kind] = {
      ...definition,
      identityId: expectedIdentityId,
      principalId: identity.principalId,
      clientId: identity.clientId,
      jobId: `${resourceGroupScope}/providers/Microsoft.App/jobs/${definition.jobName}`,
      containerId: `${storageScope}/blobServices/default/containers/${definition.containerName}`,
      queueId: `${storageScope}/queueServices/default/queues/${definition.queueName}`,
    };
  }
  const assignments = [];
  for (const kind of runnerKinds) {
    const runner = runners[kind];
    assignments.push(
      assignment(runner.containerId, runner.principalId, builtInRole(roleIds.blobDataContributor), "ServicePrincipal", `${kind}:signer-blob`, [runner.containerId, runner.identityId, builtInRole(roleIds.blobDataContributor)]),
      assignment(runner.queueId, runner.principalId, builtInRole(roleIds.queueMessageProcessor), "ServicePrincipal", `${kind}:signer-queue`, [runner.queueId, runner.identityId, builtInRole(roleIds.queueMessageProcessor)]),
      assignment(runner.containerId, operatorPrincipalId, builtInRole(roleIds.blobDataContributor), "User", `${kind}:operator-blob`, [runner.containerId, operatorPrincipalId, builtInRole(roleIds.blobDataContributor)]),
      assignment(runner.queueId, operatorPrincipalId, builtInRole(roleIds.queueMessageSender), "User", `${kind}:operator-queue`, [runner.queueId, operatorPrincipalId, builtInRole(roleIds.queueMessageSender)]),
      assignment(acrScope, runner.principalId, builtInRole(roleIds.acrPull), "ServicePrincipal", `${kind}:acr-pull`, [acrScope, runner.identityId, builtInRole(roleIds.acrPull)]),
      assignment(vaultScope, runner.principalId, customRoleDefinitionId, "ServicePrincipal", `${kind}:public-key-read`, [vaultScope, runner.identityId, customRoleDefinitionId]),
    );
  }
  assignments.push(assignment(
    secretScope,
    runners.gate.principalId,
    builtInRole(roleIds.keyVaultSecretsUser),
    "ServicePrincipal",
    "gate:postgres-secret-read",
    [secretScope, runners.gate.identityId, builtInRole(roleIds.keyVaultSecretsUser)],
  ));
  if (assignments.length !== 19) throw new Error("evidence runner policy must contain exactly 19 assignments");
  return {
    subscriptionScope,
    resourceGroupScope,
    storageScope,
    acrScope,
    vaultScope,
    secretScope,
    customRoleDefinitionId,
    lifecyclePolicyId: `${storageScope}/managementPolicies/default`,
    environmentId: `${resourceGroupScope}/providers/Microsoft.App/managedEnvironments/${containerAppsEnvironmentName}`,
    runners,
    assignments,
  };
}

export function validateEvidenceRunnerWhatIf(document, options) {
  const normalized = normalizeEvidenceRunnerWhatIfEnvelope(document);
  const policy = buildEvidenceRunnerPolicy(options);
  const expectedResources = new Map();
  for (const runner of Object.values(policy.runners)) {
    expectedResources.set(runner.jobId, {
      type: "Microsoft.App/jobs", apiVersion: apiVersions.job, name: runner.jobName, kind: "job", runner,
    });
    expectedResources.set(runner.containerId, {
      type: "Microsoft.Storage/storageAccounts/blobServices/containers",
      apiVersion: apiVersions.container,
      name: `${EVIDENCE_RUNNER_STORAGE_ACCOUNT}/default/${runner.containerName}`,
      kind: "container",
      runner,
    });
    expectedResources.set(runner.queueId, {
      type: "Microsoft.Storage/storageAccounts/queueServices/queues",
      apiVersion: apiVersions.queue,
      name: `${EVIDENCE_RUNNER_STORAGE_ACCOUNT}/default/${runner.queueName}`,
      kind: "queue",
      runner,
    });
  }
  expectedResources.set(policy.customRoleDefinitionId, {
    type: "Microsoft.Authorization/roleDefinitions",
    apiVersion: apiVersions.customRole,
    name: EVIDENCE_PUBLIC_KEY_READER_ROLE_ID,
    kind: "custom-role",
  });
  expectedResources.set(policy.lifecyclePolicyId, {
    type: "Microsoft.Storage/storageAccounts/managementPolicies",
    apiVersion: apiVersions.lifecycle,
    name: `${EVIDENCE_RUNNER_STORAGE_ACCOUNT}/default`,
    kind: "lifecycle",
  });
  for (const assignmentPolicy of policy.assignments) {
    expectedResources.set(assignmentPolicy.id, {
      type: "Microsoft.Authorization/roleAssignments",
      apiVersion: apiVersions.assignment,
      name: assignmentPolicy.name,
      kind: "assignment",
      assignment: assignmentPolicy,
    });
  }
  const expectedCount = expectedResources.size;
  if (normalized.changes.length !== expectedCount) {
    throw new Error(`evidence runner what-if must contain exactly ${expectedCount} concrete resources`);
  }

  const seenResourceIds = new Set();
  for (const change of normalized.changes) {
    if (!change || typeof change !== "object" || Array.isArray(change)) throw new Error("evidence runner what-if contains an invalid change");
    if (Object.hasOwn(change, "resourceType") || Object.hasOwn(change, "apiVersion")) {
      throw new Error("evidence runner what-if contains fabricated top-level resource type or API version fields");
    }
    exactObjectKeys(change, ["after", "before", "changeType", "delta", "resourceId"], "evidence runner what-if change");
    if (!["Create", "Modify", "NoChange"].includes(change.changeType)) {
      throw new Error(`evidence runner what-if contains destructive or unsupported change ${String(change.changeType)}`);
    }
    if (typeof change.resourceId !== "string" || !change.resourceId || seenResourceIds.has(change.resourceId.toLowerCase())) {
      throw new Error("evidence runner what-if resource IDs must be concrete and unique");
    }
    seenResourceIds.add(change.resourceId.toLowerCase());
    if (!change.after || typeof change.after !== "object" || Array.isArray(change.after)) {
      throw new Error(`evidence runner what-if omits the full after payload for ${String(change.resourceId)}`);
    }

    const expected = expectedResources.get(change.resourceId);
    if (!expected) {
      const caseInsensitiveMatch = [...expectedResources.keys()].find((id) => normalizeId(id) === normalizeId(change.resourceId));
      if (caseInsensitiveMatch) {
        throw new Error(`evidence runner what-if resourceId casing or spelling drifted: expected ${caseInsensitiveMatch}`);
      }
      throw new Error(`evidence runner what-if contains an unexpected resourceId: ${String(change.resourceId)}`);
    }
    validateWhatIfResourceIdentity(change, { id: change.resourceId, ...expected });

    if (expected.kind === "job") {
      const runner = expected.runner;
      validateEvidenceRunnerJob(change.after, {
        output: {
          kind: runnerKindFor(runner),
          name: runner.jobName,
          identityId: runner.identityId,
          clientId: runner.clientId,
          containerName: runner.containerName,
          queueName: runner.queueName,
        },
        pinnedImage: options.pinnedImage,
        sourceSha256: options.sourceSha256,
        expectedEnvironmentId: policy.environmentId,
      });
    } else if (expected.kind === "container") {
      validateHandoffContainer(change.after, expected.runner);
    } else if (expected.kind === "queue") {
      validateHandoffQueue(change.after, expected.runner);
    } else if (expected.kind === "custom-role") {
      validateEvidencePublicKeyReaderRole(change.after, policy);
    } else if (expected.kind === "lifecycle") {
      validateEvidenceLifecyclePolicy(change.after);
    } else {
      const parsedAssignment = parseRoleAssignmentChange(change);
      if (assignmentKey(parsedAssignment) !== assignmentKey(expected.assignment)) {
        throw new Error(`evidence runner what-if contains an unexpected role assignment: ${String(change.resourceId)}`);
      }
    }
    validateWhatIfAfterSchema(change.after, expected);
  }
  if (seenResourceIds.size !== expectedResources.size) {
    throw new Error("evidence runner what-if is missing one or more exact resources or role assignments");
  }
  return true;
}

export function normalizeEvidenceRunnerWhatIfEnvelope(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("evidence runner what-if response is not an Azure CLI SDK envelope");
  }
  if (document.status !== "Succeeded" || (Object.hasOwn(document, "error") && document.error !== null)) {
    throw new Error("evidence runner what-if operation did not return a successful SDK envelope");
  }
  if (!Array.isArray(document.changes)) throw new Error("evidence runner what-if response is missing changes");
  exactObjectKeys(
    document,
    Object.hasOwn(document, "error") ? ["changes", "error", "status"] : ["changes", "status"],
    "evidence runner what-if SDK envelope",
  );
  return { status: document.status, changes: document.changes };
}

export async function validateEvidenceRunnerLiveResources({
  runAzJson,
  projectRoot,
  operatorPrincipalId,
  identities,
  pinnedImage,
  sourceSha256,
}) {
  const policy = buildEvidenceRunnerPolicy({ operatorPrincipalId, identities });
  const tagged = await runAzJson([
    "resource", "list", "--resource-group", PRODUCTION_RESOURCE_GROUP,
    "--tag", "component=release-evidence-runner", "--output", "json", "--only-show-errors",
  ], projectRoot);
  if (!Array.isArray(tagged)) throw new Error("live evidence runner resource enumeration is invalid");
  const taggedJobs = tagged.filter((resource) => String(resource?.type).toLowerCase() === "microsoft.app/jobs");
  const expectedJobIds = Object.values(policy.runners).map(({ jobId }) => normalizeId(jobId)).sort();
  const actualJobIds = taggedJobs.map(({ id }) => normalizeId(id)).sort();
  if (JSON.stringify(actualJobIds) !== JSON.stringify(expectedJobIds)) {
    throw new Error("live evidence runner job enumeration does not exactly match the three fixed jobs");
  }
  for (const [kind, runner] of Object.entries(policy.runners)) {
    const live = await runAzJson([
      "containerapp", "job", "show", "--resource-group", PRODUCTION_RESOURCE_GROUP,
      "--name", runner.jobName, "--output", "json", "--only-show-errors",
    ], projectRoot);
    validateEvidenceRunnerJob(live, {
      output: {
        kind,
        name: runner.jobName,
        identityId: runner.identityId,
        clientId: runner.clientId,
        containerName: runner.containerName,
        queueName: runner.queueName,
      },
      pinnedImage,
      sourceSha256,
      expectedEnvironmentId: policy.environmentId,
    });
  }

  const [containers, queues, lifecycle, roleDefinitions] = await Promise.all([
    managementGet(runAzJson, projectRoot, `${policy.storageScope}/blobServices/default/containers?api-version=2023-05-01`),
    managementGet(runAzJson, projectRoot, `${policy.storageScope}/queueServices/default/queues?api-version=2023-05-01`),
    managementGet(runAzJson, projectRoot, `${policy.lifecyclePolicyId}?api-version=2023-05-01`),
    runAzJson([
      "role", "definition", "list", "--name", EVIDENCE_PUBLIC_KEY_READER_ROLE_ID,
      "--output", "json", "--only-show-errors",
    ], projectRoot),
  ]);
  validateLiveHandoffResources(containers?.value, policy, "container");
  validateLiveHandoffResources(queues?.value, policy, "queue");
  validateEvidenceLifecyclePolicy(lifecycle);
  if (!Array.isArray(roleDefinitions) || roleDefinitions.length !== 1) {
    throw new Error("live evidence public-key reader role is missing or ambiguous");
  }
  validateEvidencePublicKeyReaderRole(roleDefinitions[0], policy);

  const principals = new Set([
    operatorPrincipalId.toLowerCase(),
    ...Object.values(policy.runners).map(({ principalId }) => principalId.toLowerCase()),
  ]);
  const assignmentsById = new Map();
  const storageEffectiveAssignments = [];
  const storageScopes = new Set([
    ...Object.values(policy.runners).map(({ containerId }) => containerId),
    ...Object.values(policy.runners).map(({ queueId }) => queueId),
  ]);
  for (const scope of [...new Set(policy.assignments.map(({ scope }) => scope))]) {
    const assignments = await runAzJson([
      "role", "assignment", "list", "--scope", scope, "--include-inherited", "--all",
      "--output", "json", "--only-show-errors",
    ], projectRoot);
    if (!Array.isArray(assignments)) throw new Error(`live role assignment enumeration failed for ${scope}`);
    for (const value of assignments) {
      const id = normalizeId(value?.id);
      if (!id || !value?.scope || !value?.roleDefinitionId || !value?.principalId) {
        throw new Error(`live role assignment enumeration returned an incomplete assignment for ${scope}`);
      }
      const prior = assignmentsById.get(id);
      if (prior && (
        assignmentKey(prior) !== assignmentKey(value)
        || prior.id !== value.id
      )) throw new Error(`live role assignment ${String(value.id)} changed across effective-scope queries`);
      assignmentsById.set(id, value);
      if (storageScopes.has(scope)) storageEffectiveAssignments.push({ targetScope: scope, assignment: value });
    }
  }

  const storageRoleDefinitions = await loadRoleDefinitions({
    runAzJson,
    projectRoot,
    assignments: storageEffectiveAssignments.map(({ assignment: value }) => value),
  });
  for (const { targetScope, assignment: value } of storageEffectiveAssignments) {
    const definition = storageRoleDefinitions.get(roleDefinitionKey(value.roleDefinitionId));
    if (!definition) throw new Error(`cannot resolve effective storage role ${String(value.roleDefinitionId)}`);
    if (!hasStorageBlobOrQueueDataActions(definition, { targetScope })) continue;
    const expected = policy.assignments.find((candidate) => normalizeId(candidate.id) === normalizeId(value.id));
    if (
      !expected
      || value.id !== expected.id
      || value.scope !== targetScope
      || assignmentKey(value) !== assignmentKey(expected)
    ) {
      throw new Error(
        `live evidence storage scope has an unexpected direct or inherited Blob/Queue data-plane role: ${String(value.id)}`,
      );
    }
  }

  const observed = new Set();
  for (const value of assignmentsById.values()) {
    const relevant = principals.has(String(value?.principalId).toLowerCase())
      || normalizeId(value?.roleDefinitionId) === normalizeId(policy.customRoleDefinitionId);
    if (!relevant) continue;
    const expected = policy.assignments.find((candidate) => normalizeId(candidate.id) === normalizeId(value.id));
    if (!expected || value.id !== expected.id || assignmentKey(value) !== assignmentKey(expected)) {
      throw new Error(`live evidence runner RBAC contains an unexpected direct or inherited assignment: ${String(value.id)}`);
    }
    const key = assignmentKey(value);
    if (observed.has(key)) throw new Error("live evidence runner RBAC contains a duplicate policy tuple");
    observed.add(key);
  }
  const expected = new Set(policy.assignments.map(assignmentKey));
  if ([...observed].some((key) => !expected.has(key)) || [...expected].some((key) => !observed.has(key))) {
    throw new Error("live evidence runner RBAC does not exactly match the 19 deterministic direct assignments");
  }
  return true;
}

export function validateEvidenceRunnerJob(job, {
  output,
  pinnedImage,
  sourceSha256,
  expectedEnvironmentId = null,
}) {
  const kind = output?.kind;
  const definition = runnerDefinitions[kind];
  if (!definition || output.name !== definition.jobName || job?.name !== definition.jobName) {
    throw new Error("live evidence job identity does not match the fixed runner contract");
  }
  if (job.identity?.type !== "UserAssigned") throw new Error(`${kind} evidence job identity type drifted`);
  const identityIds = Object.keys(job.identity?.userAssignedIdentities ?? {});
  if (identityIds.length !== 1 || normalizeId(identityIds[0]) !== normalizeId(output.identityId)) {
    throw new Error(`${kind} evidence job must have exactly its one dedicated signer identity`);
  }
  if (expectedEnvironmentId && normalizeId(job.properties?.environmentId) !== normalizeId(expectedEnvironmentId)) {
    throw new Error(`${kind} evidence job Container Apps environment drifted`);
  }
  if (
    job.tags?.workload !== "prostar-metrics"
    || job.tags?.environment !== "prod"
    || job.tags?.managedBy !== "bicep"
    || job.tags?.component !== "release-evidence-runner"
    || job.tags?.evidenceKind !== kind
  ) throw new Error(`${kind} evidence job tags drifted`);
  const configuration = job.properties?.configuration;
  const containers = job.properties?.template?.containers ?? [];
  const container = containers[0];
  const event = configuration?.eventTriggerConfig;
  const scale = event?.scale;
  const rules = scale?.rules ?? [];
  const rule = rules[0];
  const registries = configuration?.registries ?? [];
  if (
    configuration?.triggerType !== "Event"
    || configuration?.replicaTimeout !== 7200
    || configuration?.replicaRetryLimit !== 1
    || event?.parallelism !== 1
    || event?.replicaCompletionCount !== 1
    || scale?.minExecutions !== 0
    || scale?.maxExecutions !== 1
    || scale?.pollingInterval !== 30
    || rules.length !== 1
    || rule?.name !== `${kind}-queue`
    || rule?.type !== "azure-queue"
    || normalizeId(rule?.identity) !== normalizeId(output.identityId)
    || rule?.metadata?.accountName !== EVIDENCE_RUNNER_STORAGE_ACCOUNT
    || rule?.metadata?.queueName !== output.queueName
    || rule?.metadata?.queueLength !== "1"
  ) throw new Error(`${kind} evidence job event trigger is not fixed to its isolated queue and identity`);
  if (
    registries.length !== 1
    || registries[0].server !== `${PRODUCTION_ACR}.azurecr.io`
    || normalizeId(registries[0].identity) !== normalizeId(output.identityId)
  ) throw new Error(`${kind} evidence job registry pull identity drifted`);
  if (
    containers.length !== 1
    || container?.name !== `evidence-${kind}`
    || container?.image !== pinnedImage
    || JSON.stringify(container?.command) !== JSON.stringify(["node"])
    || JSON.stringify(container?.args) !== JSON.stringify(["scripts/run-release-evidence-job.mjs", "--kind", kind])
    || container?.resources?.cpu !== 1
    || container?.resources?.memory !== "2Gi"
  ) throw new Error(`${kind} evidence job image or command is overrideable/drifted`);
  const environmentEntries = container.env ?? [];
  const environmentNames = environmentEntries.map(({ name }) => name);
  const expectedEnvironmentNames = [
    "NODE_ENV", "AZURE_CLIENT_ID", "AZURE_SUBSCRIPTION_ID", "AZURE_RESOURCE_GROUP",
    "RELEASE_EVIDENCE_KIND", "RELEASE_EVIDENCE_STORAGE_ACCOUNT", "RELEASE_EVIDENCE_CONTAINER",
    "RELEASE_EVIDENCE_QUEUE", "RELEASE_EVIDENCE_SOURCE_SHA256",
    ...(kind === "gate" ? ["AZURE_POSTGRES_CONNECTION_STRING"] : []),
  ].sort();
  if (
    new Set(environmentNames).size !== environmentNames.length
    || JSON.stringify([...environmentNames].sort()) !== JSON.stringify(expectedEnvironmentNames)
  ) throw new Error(`${kind} evidence job environment allowlist drifted`);
  const env = Object.fromEntries(environmentEntries.map((entry) => [entry.name, entry.value ?? { secretRef: entry.secretRef }]));
  if (
    env.NODE_ENV !== "test"
    || env.AZURE_CLIENT_ID?.toLowerCase() !== output.clientId?.toLowerCase()
    || env.AZURE_SUBSCRIPTION_ID !== EVIDENCE_RUNNER_SUBSCRIPTION_ID
    || env.AZURE_RESOURCE_GROUP !== PRODUCTION_RESOURCE_GROUP
    || env.RELEASE_EVIDENCE_KIND !== kind
    || env.RELEASE_EVIDENCE_STORAGE_ACCOUNT !== EVIDENCE_RUNNER_STORAGE_ACCOUNT
    || env.RELEASE_EVIDENCE_CONTAINER !== output.containerName
    || env.RELEASE_EVIDENCE_QUEUE !== output.queueName
    || env.RELEASE_EVIDENCE_SOURCE_SHA256 !== sourceSha256
  ) throw new Error(`${kind} evidence job handoff binding drifted`);
  if (kind === "gate") {
    if (env.AZURE_POSTGRES_CONNECTION_STRING?.secretRef !== "postgres-connection") {
      throw new Error("gate evidence job must use the Key Vault-backed database secret reference");
    }
    const secrets = configuration?.secrets ?? [];
    if (
      secrets.length !== 1
      || secrets[0].name !== "postgres-connection"
      || secrets[0].keyVaultUrl !== `https://${EVIDENCE_RUNNER_KEY_VAULT}.vault.azure.net/secrets/${postgresSecretName}`
      || Object.hasOwn(secrets[0], "value")
      || normalizeId(secrets[0].identity) !== normalizeId(output.identityId)
    ) throw new Error("gate evidence job database secret boundary drifted");
  } else if (env.AZURE_POSTGRES_CONNECTION_STRING !== undefined || (configuration?.secrets ?? []).length !== 0) {
    throw new Error(`${kind} evidence job must not receive the gate database secret`);
  }
  return true;
}

function assignment(scope, principalId, roleDefinitionId, principalType, key, guidInputs) {
  const name = armGuid(...guidInputs);
  return {
    id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${name}`,
    name,
    scope,
    principalId,
    roleDefinitionId,
    principalType,
    key,
  };
}

function assignmentKey(value) {
  return [
    normalizeId(value?.scope),
    String(value?.principalId ?? "").toLowerCase(),
    normalizeId(value?.roleDefinitionId),
    String(value?.principalType ?? ""),
  ].join("|");
}

function parseRoleAssignmentChange(change) {
  const id = change.resourceId;
  const marker = "/providers/Microsoft.Authorization/roleAssignments/";
  const index = id.lastIndexOf(marker);
  if (index <= 0 || !roleAssignmentIdPattern(id.slice(0, index)).test(id)) {
    throw new Error(`evidence runner what-if has a mistyped role assignment resource: ${String(change.resourceId)}`);
  }
  const properties = change.after.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("evidence runner role assignment properties are missing");
  }
  if (!uuidPattern.test(properties.principalId ?? "") || !["User", "ServicePrincipal"].includes(properties.principalType)) {
    throw new Error("evidence runner role assignment principal is invalid");
  }
  return {
    scope: id.slice(0, index),
    principalId: properties.principalId,
    roleDefinitionId: properties.roleDefinitionId,
    principalType: properties.principalType,
  };
}

function armGuid(...values) {
  const namespace = uuidBytes(armGuidNamespace);
  const digest = createHash("sha1")
    .update(namespace)
    .update(values.map(String).join("-"), "utf8")
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidBytes(value) {
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function roleAssignmentIdPattern(scope) {
  const prefix = `${normalizeId(scope)}/providers/microsoft.authorization/roleassignments/`;
  return new RegExp(`^${escapeRegExp(prefix)}[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "i");
}

function validateHandoffContainer(resource, runner) {
  if (String(resource.name).split("/").at(-1) !== runner.containerName) {
    throw new Error("evidence handoff container name drifted");
  }
  const properties = resource.properties;
  if (
    properties?.publicAccess !== "None"
    || properties?.immutableStorageWithVersioning?.enabled !== false
  ) throw new Error(`${runner.containerName} container policy drifted`);
}

function validateHandoffQueue(resource, runner) {
  if (String(resource.name).split("/").at(-1) !== runner.queueName) {
    throw new Error("evidence handoff queue name drifted");
  }
  if (resource.properties && Object.keys(resource.properties).length !== 0) {
    throw new Error(`${runner.queueName} queue contains unsupported policy properties`);
  }
}

function validateEvidencePublicKeyReaderRole(resource, policy) {
  const value = resource.properties ?? resource;
  if (
    normalizeId(resource.id ?? policy.customRoleDefinitionId) !== normalizeId(policy.customRoleDefinitionId)
    || value.roleName !== "ProStar Evidence Public Key Reader"
    || value.description !== "Reads evidence public keys for receipt verification without any signing action."
    || (value.type ?? value.roleType) !== "CustomRole"
    || JSON.stringify(value.assignableScopes) !== JSON.stringify([policy.resourceGroupScope])
    || !Array.isArray(value.permissions)
    || value.permissions.length !== 1
  ) throw new Error("evidence public-key reader custom role identity or scope drifted");
  const permission = value.permissions[0];
  if (
    JSON.stringify(permission.actions) !== JSON.stringify([])
    || JSON.stringify(permission.notActions) !== JSON.stringify([])
    || JSON.stringify(permission.dataActions) !== JSON.stringify(["Microsoft.KeyVault/vaults/keys/read"])
    || JSON.stringify(permission.notDataActions) !== JSON.stringify([])
  ) throw new Error("evidence public-key reader role actions/dataActions/notActions/notDataActions drifted");
}

async function loadRoleDefinitions({ runAzJson, projectRoot, assignments }) {
  const definitions = new Map();
  for (const key of new Set(assignments.map(({ roleDefinitionId }) => roleDefinitionKey(roleDefinitionId)))) {
    if (!key) throw new Error("effective evidence role assignment is missing its role definition ID");
    const matches = await runAzJson([
      "role", "definition", "list", "--name", key,
      "--output", "json", "--only-show-errors",
    ], projectRoot);
    if (!Array.isArray(matches) || matches.length !== 1) {
      throw new Error(`cannot resolve effective evidence role definition ${key}`);
    }
    definitions.set(key, matches[0]);
  }
  return definitions;
}

function roleDefinitionKey(value) {
  return String(value ?? "").split("/").filter(Boolean).at(-1)?.toLowerCase() ?? "";
}

const storageDataActionDomains = Object.freeze({
  blob: "microsoft.storage/storageaccounts/blobservices/*/*",
  queue: "microsoft.storage/storageaccounts/queueservices/*/*",
});
const dataActionAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789./_-";

export function hasStorageBlobOrQueueDataActions(roleDefinition, { targetScope } = {}) {
  const permissions = roleDefinition?.permissions;
  if (!Array.isArray(permissions)) return false;
  const domains = storageDataActionDomainsForScope(targetScope);
  return permissions.some((permission) => {
    const dataActions = permission?.dataActions;
    const notDataActions = permission?.notDataActions ?? [];
    if (dataActions == null) return false;
    if (!Array.isArray(dataActions) || !Array.isArray(notDataActions)) return true;
    const exclusions = notDataActions.filter(isValidDataActionPattern).map(normalizeDataActionPattern);
    return dataActions.some((action) => {
      if (!isValidDataActionPattern(action)) return true;
      const allowed = normalizeDataActionPattern(action);
      return domains.some((domain) => globIntersectionHasUnexcludedMatch({
        allowed,
        domain,
        exclusions,
      }));
    });
  });
}

function storageDataActionDomainsForScope(targetScope) {
  if (targetScope === undefined) return Object.values(storageDataActionDomains);
  const normalized = normalizeId(targetScope);
  if (normalized.includes("/blobservices/")) return [storageDataActionDomains.blob];
  if (normalized.includes("/queueservices/")) return [storageDataActionDomains.queue];
  throw new Error(`cannot determine Blob/Queue data-plane domain for ${String(targetScope)}`);
}

function globIntersectionHasUnexcludedMatch({ allowed, domain, exclusions }) {
  const patterns = [allowed, domain, ...exclusions];
  const initial = patterns.map((pattern) => globClosure(pattern, new Set([0])));
  const queue = [initial];
  const visited = new Set([globStateKey(initial)]);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const states = queue[cursor];
    if (
      globAccepts(allowed, states[0])
      && globAccepts(domain, states[1])
      && exclusions.every((pattern, index) => !globAccepts(pattern, states[index + 2]))
    ) return true;
    for (const character of dataActionAlphabet) {
      const next = patterns.map((pattern, index) => globAdvance(pattern, states[index], character));
      if (next[0].size === 0 || next[1].size === 0) continue;
      const key = globStateKey(next);
      if (!visited.has(key)) {
        visited.add(key);
        queue.push(next);
      }
    }
    if (visited.size > 100_000) return true;
  }
  return false;
}

function globAdvance(pattern, state, character) {
  const next = new Set();
  for (const position of state) {
    if (position >= pattern.length) continue;
    if (pattern[position] === "*") next.add(position);
    else if (pattern[position] === character) next.add(position + 1);
  }
  return globClosure(pattern, next);
}

function globClosure(pattern, state) {
  const result = new Set(state);
  const pending = [...state];
  while (pending.length > 0) {
    const position = pending.pop();
    if (pattern[position] === "*" && !result.has(position + 1)) {
      result.add(position + 1);
      pending.push(position + 1);
    }
  }
  return result;
}

function globAccepts(pattern, state) {
  return state.has(pattern.length);
}

function globStateKey(states) {
  return states.map((state) => [...state].sort((left, right) => left - right).join(",")).join("|");
}

function isValidDataActionPattern(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && /^[A-Za-z0-9._/*-]+$/.test(value);
}

function normalizeDataActionPattern(value) {
  return value.toLowerCase();
}

function expectedLifecycleRules() {
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
        filters: {
          blobTypes: ["blockBlob"],
          prefixMatch: [`${commissionExportContainerName}/`],
        },
      },
    },
    {
      enabled: true,
      name: "delete-orphaned-release-evidence-handoffs",
      type: "Lifecycle",
      definition: {
        filters: {
          blobTypes: ["blockBlob"],
          prefixMatch: runnerKinds.map((kind) => `release-evidence-${kind}/runs/`),
        },
        actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 1 } } },
      },
    },
    {
      enabled: true,
      name: "expire-release-evidence-replay-ledger",
      type: "Lifecycle",
      definition: {
        filters: {
          blobTypes: ["blockBlob"],
          prefixMatch: runnerKinds.map((kind) => `release-evidence-${kind}/replay-ledger/`),
        },
        actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 7 } } },
      },
    },
  ];
}

function validateEvidenceLifecyclePolicy(resource) {
  if (String(resource?.name).split("/").at(-1) !== "default") throw new Error("evidence storage lifecycle policy name drifted");
  const rules = resource?.properties?.policy?.rules;
  if (JSON.stringify(rules) !== JSON.stringify(expectedLifecycleRules())) {
    throw new Error("evidence storage lifecycle policy must contain exactly the merged commission/orphan/replay rules");
  }
}

function validateLiveHandoffResources(values, policy, kind) {
  if (!Array.isArray(values)) throw new Error(`live evidence ${kind} enumeration is invalid`);
  const expectedNames = runnerKinds.map((runnerKind) => policy.runners[runnerKind][`${kind}Name`]).sort();
  const evidenceValues = values.filter((value) => {
    const name = String(value?.name).split("/").at(-1);
    return name.startsWith("release-evidence-");
  });
  const actualNames = evidenceValues.map((value) => String(value.name).split("/").at(-1)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`live evidence ${kind} enumeration does not exactly match the three fixed resources`);
  }
  for (const value of evidenceValues) {
    const name = String(value.name).split("/").at(-1);
    const runner = Object.values(policy.runners).find((candidate) => candidate[`${kind}Name`] === name);
    const normalized = { ...value, name };
    if (kind === "container") validateHandoffContainer(normalized, runner);
    else validateHandoffQueue(normalized, runner);
  }
}

function validateWhatIfResourceIdentity(change, expected) {
  if (change.resourceId !== expected.id || change.after.id !== expected.id) {
    throw new Error(`evidence runner ARM resource identity mismatch for ${String(change.resourceId)}`);
  }
  if (change.after.type !== expected.type) {
    throw new Error(`evidence runner resource type mismatch for ${String(change.resourceId)}: expected ${expected.type}`);
  }
  if (change.after.apiVersion !== expected.apiVersion) {
    throw new Error(`evidence runner API version mismatch for ${String(change.resourceId)}: expected ${expected.apiVersion}`);
  }
  if (change.after.name !== expected.name) {
    throw new Error(`evidence runner resource name mismatch for ${String(change.resourceId)}: expected ${expected.name}`);
  }
}

function validateWhatIfAfterSchema(resource, expected) {
  if (expected.kind === "job") {
    validateWhatIfJobSchema(resource, expected.runner);
  } else if (expected.kind === "container") {
    exactObjectKeys(resource, ["apiVersion", "id", "name", "properties", "type"], "evidence handoff container after payload");
    exactObjectKeys(resource.properties, ["immutableStorageWithVersioning", "publicAccess"], "evidence handoff container properties");
    exactObjectKeys(
      resource.properties.immutableStorageWithVersioning,
      ["enabled"],
      "evidence handoff container immutable-storage properties",
    );
  } else if (expected.kind === "queue") {
    exactObjectKeys(resource, ["apiVersion", "id", "name", "type"], "evidence handoff queue after payload");
  } else if (expected.kind === "custom-role") {
    exactObjectKeys(resource, ["apiVersion", "id", "name", "properties", "type"], "evidence custom-role after payload");
    exactObjectKeys(
      resource.properties,
      ["assignableScopes", "description", "permissions", "roleName", "type"],
      "evidence custom-role properties",
    );
    exactArray(resource.properties.permissions, "evidence custom-role permissions").forEach((permission) => {
      exactObjectKeys(
        permission,
        ["actions", "dataActions", "notActions", "notDataActions"],
        "evidence custom-role permission",
      );
    });
  } else if (expected.kind === "lifecycle") {
    exactObjectShape(resource, {
      apiVersion: null,
      id: null,
      name: null,
      properties: { policy: { rules: expectedLifecycleRules() } },
      type: null,
    }, "evidence lifecycle after payload");
  } else {
    exactObjectKeys(resource, ["apiVersion", "id", "name", "properties", "type"], "evidence role-assignment after payload");
    exactObjectKeys(
      resource.properties,
      ["principalId", "principalType", "roleDefinitionId"],
      "evidence role-assignment properties",
    );
  }
}

function validateWhatIfJobSchema(resource, runner) {
  exactObjectKeys(
    resource,
    ["apiVersion", "id", "identity", "location", "name", "properties", "tags", "type"],
    "evidence job after payload",
  );
  exactObjectKeys(
    resource.tags,
    ["component", "environment", "evidenceKind", "managedBy", "workload"],
    "evidence job tags",
  );
  exactObjectKeys(resource.identity, ["type", "userAssignedIdentities"], "evidence job identity");
  exactObjectKeys(
    resource.identity.userAssignedIdentities,
    [runner.identityId],
    "evidence job user-assigned identities",
  );
  exactObjectKeys(
    resource.identity.userAssignedIdentities[runner.identityId],
    [],
    "evidence job user-assigned identity representation",
  );

  const properties = resource.properties;
  exactObjectKeys(properties, ["configuration", "environmentId", "template"], "evidence job properties");
  const configuration = properties.configuration;
  exactObjectKeys(
    configuration,
    ["eventTriggerConfig", "registries", "replicaRetryLimit", "replicaTimeout", "secrets", "triggerType"],
    "evidence job configuration",
  );
  const event = configuration.eventTriggerConfig;
  exactObjectKeys(event, ["parallelism", "replicaCompletionCount", "scale"], "evidence job event trigger");
  const scale = event.scale;
  exactObjectKeys(scale, ["maxExecutions", "minExecutions", "pollingInterval", "rules"], "evidence job scale");
  exactArray(scale.rules, "evidence job scale rules").forEach((rule) => {
    exactObjectKeys(rule, ["identity", "metadata", "name", "type"], "evidence job scale rule");
    exactObjectKeys(rule.metadata, ["accountName", "queueLength", "queueName"], "evidence job scale-rule metadata");
  });
  exactArray(configuration.registries, "evidence job registries").forEach((registry) => {
    exactObjectKeys(registry, ["identity", "server"], "evidence job registry");
  });
  exactArray(configuration.secrets, "evidence job secrets").forEach((secret) => {
    exactObjectKeys(secret, ["identity", "keyVaultUrl", "name"], "evidence job secret");
  });

  exactObjectKeys(properties.template, ["containers"], "evidence job template");
  exactArray(properties.template.containers, "evidence job containers").forEach((container) => {
    exactObjectKeys(
      container,
      ["args", "command", "env", "image", "name", "resources"],
      "evidence job container",
    );
    exactArray(container.env, "evidence job container environment").forEach((entry) => {
      exactObjectKeys(
        entry,
        entry.name === "AZURE_POSTGRES_CONNECTION_STRING" ? ["name", "secretRef"] : ["name", "value"],
        `evidence job environment entry ${String(entry.name)}`,
      );
    });
    exactObjectKeys(container.resources, ["cpu", "memory"], "evidence job container resources");
  });
}

function exactObjectKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  const expected = new Set(expectedKeys);
  const actual = Object.keys(value);
  const unsupported = actual.filter((key) => !expected.has(key));
  if (unsupported.length > 0) throw new Error(`${label} contains unsupported fields: ${unsupported.join(", ")}`);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new Error(`${label} is missing required fields: ${missing.join(", ")}`);
}

function exactArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

function exactObjectShape(value, shape, label) {
  if (Array.isArray(shape)) {
    const values = exactArray(value, label);
    if (values.length !== shape.length) throw new Error(`${label} has an unexpected item count`);
    shape.forEach((item, index) => exactObjectShape(values[index], item, `${label}[${index}]`));
    return;
  }
  if (!shape || typeof shape !== "object") return;
  exactObjectKeys(value, Object.keys(shape), label);
  for (const [key, childShape] of Object.entries(shape)) {
    exactObjectShape(value[key], childShape, `${label}.${key}`);
  }
}

function runnerKindFor(runner) {
  return runnerKinds.find((kind) => runnerDefinitions[kind].jobName === runner.jobName);
}

async function loadEvidenceRunnerIdentities({ runAzJson, projectRoot }) {
  const identities = {};
  for (const kind of runnerKinds) {
    identities[kind] = await runAzJson([
      "identity", "show", "--resource-group", PRODUCTION_RESOURCE_GROUP,
      "--name", runnerDefinitions[kind].identityName,
      "--query", "{id:id,principalId:principalId,clientId:clientId}",
      "--output", "json", "--only-show-errors",
    ], projectRoot);
  }
  return identities;
}

function managementGet(runAzJson, projectRoot, resourcePath) {
  return runAzJson([
    "rest", "--method", "get", "--url", `https://management.azure.com${resourcePath}`,
    "--output", "json", "--only-show-errors",
  ], projectRoot);
}

function normalizeId(value) {
  return typeof value === "string" ? value.replace(/\/$/, "").toLowerCase() : "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultRunAzJson(args, root) {
  const result = spawnSync("az", args, {
    cwd: root,
    env: azureChildEnvironment(process.env, {
      AZURE_CONFIG_DIR: process.env.AZURE_CONFIG_DIR ?? resolve(root, "..", ".work", "azure"),
    }),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`guarded Azure command failed: az ${args.slice(0, 3).join(" ")}`);
  return parseAzureCliJsonOutput(result.stdout, args);
}

export function parseAzureCliJsonOutput(stdout, args) {
  const command = `az ${args.slice(0, 3).join(" ")}`;
  const isGroupWhatIf = (
    args[0] === "deployment"
    && args[1] === "group"
    && args[2] === "what-if"
  );
  if (isGroupWhatIf && !args.includes("--no-pretty-print")) {
    throw new Error("guarded Azure what-if command must disable human pretty printing");
  }
  let document;
  try {
    document = JSON.parse(stdout);
  } catch {
    throw new Error(`guarded Azure command returned invalid JSON: ${command}`);
  }
  return isGroupWhatIf ? normalizeEvidenceRunnerWhatIfEnvelope(document) : document;
}

function parseArguments(argv) {
  const result = { deploymentManifestPath: DEPLOYMENT_MANIFEST_PATH, execute: false, confirm: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") result.execute = true;
    else if (["--deployment-manifest", "--confirm"].includes(arg) && argv[index + 1]) {
      result[arg === "--deployment-manifest" ? "deploymentManifestPath" : "confirm"] = argv[index + 1];
      index += 1;
    } else throw new Error(`unknown or incomplete argument: ${String(arg)}`);
  }
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  deployEvidenceRunners(parseArguments(process.argv.slice(2))).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

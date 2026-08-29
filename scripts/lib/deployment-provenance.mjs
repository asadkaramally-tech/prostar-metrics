import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";

export const PRODUCTION_RESOURCE_GROUP = "prostar-payroll";
export const PRODUCTION_CONTAINER_APP = "aca-prostar-metrics-prod";
export const PRODUCTION_ACR = "acrprostardispatchprod";
export const PRODUCTION_REPOSITORY = "prostar-metrics";
export const DEPLOYMENT_MANIFEST_PATH = "docs/prostar-metrics/verification/deployment-manifest.json";
export const DEPLOYMENT_PROVENANCE_SCHEMA_VERSION = 3;
export const DEPLOYMENT_MANIFEST_KEYS = Object.freeze([
  "schemaVersion", "environment", "planRevision", "planSha256", "buildSourceSha256",
  "resourceGroup", "containerAppName", "registry", "repository", "acrBuild", "armDeployment",
  "deploymentOperationId", "deploymentRunId", "deploymentNonce", "evidenceSigningKeyIds",
  "deployedRevision", "latestReadyRevisionName", "revisionCreatedAt", "imageDigest", "pinnedImage",
  "productionUrl", "revisionMode", "active", "healthState", "provisioningState", "trafficWeight",
  "trafficRevisionNames", "targets", "liveVerification", "monitoringEvidence", "deployedAt",
]);

const sha256Pattern = /^[a-f0-9]{64}$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;
const versionedKeyIdPattern = /^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/keys\/[A-Za-z0-9-]+\/[a-f0-9]{32}$/;
const deploymentRunPattern = /^prostar-metrics-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const allowedOwnerEmails = new Set([
  "asad@prostarmechanical.com",
  "laila@prostarmechanical.com",
]);
const productionAadTenantId = "515fbfd7-12b1-4238-bb6c-f827588dd488";
const productionAadClientId = "369bef95-48a6-45db-bad6-1e16278fa229";
const productionAadIssuer = `https://login.microsoftonline.com/${productionAadTenantId}/v2.0`;
const productionAadSecretSetting = "microsoft-provider-authentication-secret";
const productionAadAudiences = Object.freeze([
  productionAadClientId,
  `api://${productionAadClientId}`,
].sort());
const browserVerificationUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const apiVerificationUserAgent = "ProStar-Release-Verifier/1.0 (Node.js API client)";
const safeChildEnvironmentNames = new Set([
  "AZURE_CONFIG_DIR", "CI", "FORCE_COLOR", "HOME", "HTTPS_PROXY", "HTTP_PROXY",
  "LANG", "LC_ALL", "LOGNAME", "NO_COLOR", "NO_PROXY", "PATH", "SHELL",
  "SSL_CERT_FILE", "TERM", "TMPDIR", "USER",
]);

const contextDomain = Buffer.from("prostar-docker-build-context-v2\0", "utf8");

export async function validateDeploymentManifestDocument(manifest, {
  expectedPlanRevision,
  expectedPlanSha256,
} = {}) {
  assertOnlyKeys(manifest, DEPLOYMENT_MANIFEST_KEYS, "deployment manifest");
  if (manifest.schemaVersion !== DEPLOYMENT_PROVENANCE_SCHEMA_VERSION) {
    throw new Error(`Deployment manifest schemaVersion must be ${DEPLOYMENT_PROVENANCE_SCHEMA_VERSION}`);
  }
  if (manifest.environment !== "production") throw new Error("Deployment manifest environment must be production");
  if (expectedPlanRevision !== undefined && manifest.planRevision !== expectedPlanRevision) throw new Error("Deployment manifest planRevision mismatch");
  if (expectedPlanSha256 !== undefined && manifest.planSha256 !== expectedPlanSha256) throw new Error("Deployment manifest planSha256 mismatch");
  if (!sha256Pattern.test(manifest.planSha256 ?? "") || !sha256Pattern.test(manifest.buildSourceSha256 ?? "")) {
    throw new Error("Deployment manifest source/plan hashes must be concrete SHA-256 values");
  }
  if (manifest.resourceGroup !== PRODUCTION_RESOURCE_GROUP || manifest.containerAppName !== PRODUCTION_CONTAINER_APP
    || manifest.registry !== PRODUCTION_ACR || manifest.repository !== PRODUCTION_REPOSITORY) {
    throw new Error("Deployment manifest production resource identity mismatch");
  }
  assertOnlyKeys(manifest.acrBuild, ["runId", "createdAt", "digest", "imageTag"], "deployment manifest acrBuild");
  if (typeof manifest.acrBuild.runId !== "string" || !manifest.acrBuild.runId || !isTimestamp(manifest.acrBuild.createdAt)
    || !imageDigestPattern.test(manifest.acrBuild.digest ?? "") || typeof manifest.acrBuild.imageTag !== "string"
    || !manifest.acrBuild.imageTag) throw new Error("Deployment manifest ACR build provenance is incomplete");
  assertOnlyKeys(
    manifest.armDeployment,
    ["deploymentName", "operationId", "correlationId", "completedAt"],
    "deployment manifest armDeployment",
  );
  const runMatch = deploymentRunPattern.exec(manifest.armDeployment.deploymentName ?? "");
  if (!runMatch || typeof manifest.armDeployment.operationId !== "string" || !manifest.armDeployment.operationId
    || typeof manifest.armDeployment.correlationId !== "string" || !manifest.armDeployment.correlationId
    || !isTimestamp(manifest.armDeployment.completedAt)) throw new Error("Deployment manifest ARM operation provenance is incomplete");
  if (manifest.deploymentOperationId !== manifest.armDeployment.operationId) {
    throw new Error("deploymentOperationId must exactly equal armDeployment.operationId");
  }
  if (manifest.deploymentRunId !== manifest.armDeployment.deploymentName) {
    throw new Error("deploymentRunId must exactly equal armDeployment.deploymentName");
  }
  if (manifest.deploymentNonce !== runMatch[1]) {
    throw new Error("deploymentNonce must exactly equal the UUID suffix of deploymentRunId");
  }
  assertOnlyKeys(manifest.evidenceSigningKeyIds, ["gate", "browser", "reviewer"], "deployment manifest evidenceSigningKeyIds");
  const signingKeys = Object.values(manifest.evidenceSigningKeyIds);
  if (signingKeys.some((keyId) => !versionedKeyIdPattern.test(keyId ?? "")) || new Set(signingKeys).size !== 3) {
    throw new Error("Deployment manifest must pin three distinct versioned Azure Key Vault evidence-signing keys");
  }
  if (!imageDigestPattern.test(manifest.imageDigest ?? "") || manifest.imageDigest !== manifest.acrBuild.digest) {
    throw new Error("Deployment manifest image digest must exactly match the ACR build output");
  }
  if (manifest.pinnedImage !== `${PRODUCTION_ACR}.azurecr.io/${PRODUCTION_REPOSITORY}@${manifest.imageDigest}`) {
    throw new Error("Deployment manifest pinned image mismatch");
  }
  if (!isTimestamp(manifest.revisionCreatedAt) || !isTimestamp(manifest.deployedAt)) {
    throw new Error("Deployment manifest revision/deployment timestamps are incomplete");
  }
  if (manifest.deployedRevision !== manifest.latestReadyRevisionName || manifest.revisionMode !== "Single"
    || manifest.active !== true || manifest.healthState !== "Healthy" || manifest.provisioningState !== "Provisioned"
    || manifest.trafficWeight !== 100 || JSON.stringify(manifest.trafficRevisionNames) !== JSON.stringify([manifest.deployedRevision])) {
    throw new Error("Deployment manifest final revision/traffic state is not exact and healthy");
  }
  const { assertExactProductionTargets } = await import("./production-targets.mjs");
  assertExactProductionTargets(manifest.targets?.map(({ kind, name, resourceGroup }) => ({ kind, name, resourceGroup })));
  for (const target of manifest.targets) validateManifestTarget(target, manifest.pinnedImage);
  validateManifestLiveVerification(manifest.liveVerification, manifest.productionUrl);
  validateVerificationTimestamp(
    manifest.liveVerification.authenticatedIdentity.verifiedAt,
    manifest.armDeployment.completedAt,
    manifest.deployedAt,
    "Deployment manifest authenticated identity verification",
  );
  validateMonitoringEvidence(manifest.monitoringEvidence);
  if (Date.parse(manifest.acrBuild.createdAt) > Date.parse(manifest.deployedAt)
    || Date.parse(manifest.armDeployment.completedAt) > Date.parse(manifest.deployedAt)
    || Date.parse(manifest.revisionCreatedAt) > Date.parse(manifest.deployedAt)) {
    throw new Error("Deployment manifest provenance timestamps are not chronologically bounded");
  }
  return manifest;
}

export async function computeDockerBuildContext(root) {
  const projectRoot = resolve(root);
  const ignoreText = await readFile(resolve(projectRoot, ".dockerignore"), "utf8");
  const rules = parseDockerignore(ignoreText);
  const entries = [];
  await collectEntries(projectRoot, "", rules, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type));

  const sha256 = hashContextEntries(entries);
  return {
    sha256,
    entries: entries.map(({ path, type, mode, bytes }) => ({ path, type, mode, size: bytes.length })),
  };
}

export async function withImmutableDockerBuildContext({
  root,
  build,
  prepareSnapshot,
  temporaryDirectory = tmpdir(),
}) {
  if (typeof build !== "function") throw new TypeError("build callback is required");
  const projectRoot = resolve(root);
  const ignoreText = await readFile(resolve(projectRoot, ".dockerignore"), "utf8");
  const rules = parseDockerignore(ignoreText);
  const sourceEntries = [];
  await collectEntries(projectRoot, "", rules, sourceEntries);
  sourceEntries.sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type));
  const sourceSha256 = hashContextEntries(sourceEntries);
  const temporaryRoot = await mkdtemp(resolve(temporaryDirectory, "prostar-build-context-"));
  const snapshotRoot = resolve(temporaryRoot, "context");
  let snapshotLock = null;

  try {
    await mkdir(snapshotRoot, { recursive: true });
    for (const entry of sourceEntries) {
      const sourcePath = resolve(projectRoot, entry.path);
      const snapshotPath = resolve(snapshotRoot, entry.path);
      if (entry.type === "D") {
        await mkdir(snapshotPath, { recursive: true, mode: entry.mode });
        await chmod(snapshotPath, entry.mode);
      } else if (entry.type === "L") {
        await mkdir(dirname(snapshotPath), { recursive: true });
        await symlink(entry.bytes.toString("utf8"), snapshotPath);
      } else {
        await mkdir(dirname(snapshotPath), { recursive: true });
        await copyFile(sourcePath, snapshotPath);
        await chmod(snapshotPath, entry.mode);
      }
    }

    if (prepareSnapshot !== undefined) {
      if (typeof prepareSnapshot !== "function") throw new TypeError("prepareSnapshot must be a function");
      await prepareSnapshot({ path: snapshotRoot, sha256: sourceSha256 });
    }
    assertSameContext(
      sourceSha256,
      (await computeDockerBuildContext(snapshotRoot)).sha256,
      "materialized build-context snapshot",
    );
    snapshotLock = await lockSnapshotReadOnly(snapshotRoot, sourceEntries);
    const result = await build({ path: snapshotRoot, sha256: sourceSha256, entries: sourceEntries.length });
    assertSameContext(
      sourceSha256,
      await hashLockedSnapshot(snapshotRoot, sourceEntries),
      "build-context snapshot during build",
    );
    const sourceAfter = await computeDockerBuildContext(projectRoot);
    assertSameContext(sourceSha256, sourceAfter.sha256, "source tree during build");
    return { result, sha256: sourceSha256, entries: sourceEntries.length };
  } finally {
    if (snapshotLock) await unlockSnapshot(snapshotLock);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function hashLockedSnapshot(snapshotRoot, sourceEntries) {
  const ignoreText = await readFile(resolve(snapshotRoot, ".dockerignore"), "utf8");
  const snapshotEntries = [];
  await collectEntries(resolve(snapshotRoot), "", parseDockerignore(ignoreText), snapshotEntries);
  snapshotEntries.sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type));
  const expectedByPath = new Map(sourceEntries.map((entry) => [entry.path, entry]));
  if (snapshotEntries.length !== sourceEntries.length) {
    throw new Error("Locked Docker build-context snapshot entry set changed during build");
  }
  for (const entry of snapshotEntries) {
    const expected = expectedByPath.get(entry.path);
    if (!expected || expected.type !== entry.type) {
      throw new Error(`Locked Docker build-context snapshot entry changed during build: ${entry.path}`);
    }
    const expectedLockedMode = entry.type === "F" ? expected.mode & ~0o222 : expected.mode;
    if (entry.mode !== expectedLockedMode) {
      throw new Error(`Locked Docker build-context snapshot mode changed during build: ${entry.path}`);
    }
    entry.mode = expected.mode;
  }
  return hashContextEntries(snapshotEntries);
}

async function lockSnapshotReadOnly(snapshotRoot, entries) {
  const files = entries.filter(({ type }) => type === "F").map(({ path, mode }) => ({
    path: resolve(snapshotRoot, path),
    mode,
  }));
  for (const file of files) await chmod(file.path, file.mode & ~0o222);
  if (process.platform === "darwin" && files.length > 0) {
    const result = spawnSync("/usr/bin/chflags", ["uchg", ...files.map(({ path }) => path)], {
      env: azureChildEnvironment(), stdio: "ignore",
    });
    if (result.status !== 0) throw new Error("Unable to mark the Docker build-context snapshot read-only");
  }
  return { files, immutable: process.platform === "darwin" };
}

async function unlockSnapshot(lock) {
  if (lock.immutable && lock.files.length > 0) {
    spawnSync("/usr/bin/chflags", ["nouchg", ...lock.files.map(({ path }) => path)], {
      env: azureChildEnvironment(), stdio: "ignore",
    });
  }
  for (const file of lock.files) await chmod(file.path, file.mode).catch(() => undefined);
}

export async function writeDeploymentManifestAtomic({
  root,
  manifest,
  manifestPath = DEPLOYMENT_MANIFEST_PATH,
}) {
  const target = resolve(root, manifestPath);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const temporary = `${target}.partial-${process.pid}-${Date.now()}`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    path: manifestPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function azureChildEnvironment(source = process.env, overrides = {}) {
  const environment = {};
  for (const name of safeChildEnvironmentNames) {
    if (typeof source[name] === "string") environment[name] = source[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!safeChildEnvironmentNames.has(name)) {
      throw new Error(`Azure child environment variable is not allowlisted: ${name}`);
    }
    if (typeof value === "string") environment[name] = value;
  }
  return environment;
}

export function canonicalTargetContract(resource, kind, { strict = false } = {}) {
  if (kind !== "app" && kind !== "job") throw new Error(`Unsupported production target kind: ${String(kind)}`);
  if (!resource || typeof resource !== "object") throw new Error("Production target read returned no resource object");
  const properties = resource.properties;
  const configuration = properties?.configuration;
  const template = properties?.template;
  if (strict) assertSupportedTargetShape(resource, properties, configuration, template);
  if (!resource.id || !resource.name || !resource.type || !resource.location || !properties || !configuration || !template) {
    throw new Error(`${kind} production target is missing required Azure contract fields`);
  }
  if (!Array.isArray(template.containers) || template.containers.length < 1) {
    throw new Error(`${resource.name} must contain a managed primary container`);
  }
  const secrets = configuration.secrets;
  if (!Array.isArray(secrets) || secrets.some((secret) => Object.hasOwn(secret ?? {}, "value"))) {
    throw new Error(`${resource.name} must expose only Key Vault secret references`);
  }
  const containers = template.containers.map((container) => canonicalContainerContract(container));
  const environmentId = properties.environmentId ?? properties.managedEnvironmentId;
  if (typeof environmentId !== "string" || !environmentId) {
    throw new Error(`${resource.name} has no concrete Container Apps environment ID`);
  }
  return {
    kind,
    name: resource.name,
    resourceGroup: resourceGroupFromId(resource.id),
    resourceId: String(resource.id).toLowerCase(),
    resourceType: resource.type,
    location: String(resource.location).toLowerCase(),
    tags: canonicalStringMap(resource.tags),
    identity: {
      type: resource.identity?.type ?? null,
      userAssignedIdentityIds: Object.keys(resource.identity?.userAssignedIdentities ?? {}).map((id) => id.toLowerCase()).sort(),
    },
    environmentId: environmentId.toLowerCase(),
    configuration: {
      activeRevisionsMode: configuration.activeRevisionsMode ?? null,
      ingress: canonicalJson(configuration.ingress ?? null),
      triggerType: configuration.triggerType ?? null,
      replicaTimeout: configuration.replicaTimeout ?? null,
      replicaRetryLimit: configuration.replicaRetryLimit ?? null,
      scheduleTriggerConfig: canonicalJson(configuration.scheduleTriggerConfig ?? null),
      manualTriggerConfig: canonicalJson(configuration.manualTriggerConfig ?? null),
      eventTriggerConfig: canonicalJson(configuration.eventTriggerConfig ?? null),
      registries: [...(configuration.registries ?? [])].map((registry) => ({
        server: String(registry.server ?? "").toLowerCase(),
        identity: String(registry.identity ?? "").toLowerCase(),
      })).sort(compareCanonical),
      secretReferences: secrets.map((secret) => ({
        name: secret.name ?? null,
        keyVaultUrl: secret.keyVaultUrl ?? null,
        identity: String(secret.identity ?? "").toLowerCase(),
      })).sort(compareCanonical),
    },
    template: {
      containers,
      initContainers: [...(template.initContainers ?? [])].map(canonicalContainerContract).sort(compareCanonical),
      scale: canonicalJson(template.scale ?? null),
      volumes: canonicalJson(template.volumes ?? []),
      serviceBinds: canonicalJson(template.serviceBinds ?? []),
      terminationGracePeriodSeconds: template.terminationGracePeriodSeconds ?? null,
    },
    image: containers[0].image,
  };
}

export function targetContractWithoutImage(contract) {
  const copy = structuredClone(contract);
  copy.image = null;
  if (copy.template?.containers?.[0]) copy.template.containers[0].image = null;
  return copy;
}

export function validateAcrBuildProvenance(buildResult, {
  registry = PRODUCTION_ACR,
  repository = PRODUCTION_REPOSITORY,
  imageTag,
}) {
  const runId = buildResult?.runId ?? buildResult?.id;
  const createdAt = buildResult?.createTime ?? buildResult?.createdAt;
  const outputs = buildResult?.outputImages;
  if (buildResult?.status !== "Succeeded") throw new Error(`ACR build did not succeed: ${String(buildResult?.status)}`);
  if (typeof runId !== "string" || !runId.trim()) throw new Error("ACR build result has no concrete run ID");
  if (!isTimestamp(createdAt)) throw new Error("ACR build result has no valid creation time");
  if (!Array.isArray(outputs) || outputs.length !== 1) throw new Error("ACR build must produce exactly one output image");
  const output = outputs[0];
  const outputRegistry = String(output.registry ?? "").replace(/\.azurecr\.io$/i, "").toLowerCase();
  const outputRepository = output.repository ?? output.image?.split(":")[0];
  const outputTag = output.tag ?? output.image?.slice(String(outputRepository).length + 1);
  const digest = output.digest;
  if (outputRegistry !== registry.toLowerCase() || outputRepository !== repository || outputTag !== imageTag) {
    throw new Error("ACR build output does not match the requested immutable tag");
  }
  if (!imageDigestPattern.test(digest ?? "")) throw new Error("ACR build output has no immutable SHA-256 digest");
  return { runId, createdAt: new Date(createdAt).toISOString(), digest, imageTag };
}

export function validateLiveAcrRepositoryBinding({
  registry,
  repository,
  imageTag,
  digest,
  tagManifest,
  digestManifest,
}) {
  if (registry !== PRODUCTION_ACR || repository !== PRODUCTION_REPOSITORY) {
    throw new Error("Live ACR repository verification is not bound to the production registry and repository");
  }
  if (typeof imageTag !== "string" || !imageTag || !imageDigestPattern.test(digest ?? "")) {
    throw new Error("Live ACR repository verification requires an exact tag and SHA-256 digest");
  }
  if (tagManifest?.digest !== digest) {
    throw new Error("Live ACR immutable tag moved from the deployment manifest digest");
  }
  const tagLookupContainsTag = tagManifest?.name === imageTag
    || (Array.isArray(tagManifest?.tags) && tagManifest.tags.includes(imageTag));
  if (!tagLookupContainsTag) {
    throw new Error("Live ACR tag lookup does not include the exact deployment manifest tag");
  }
  if (digestManifest?.digest !== digest) {
    throw new Error("Live ACR digest lookup does not contain the deployment manifest digest");
  }
}

export function validateArmDeploymentProvenance(deployment, expectedName, {
  deploymentRunId,
  deploymentNonce,
} = {}) {
  const properties = deployment?.properties;
  if (!deployment?.id || deployment?.name !== expectedName || !properties) {
    throw new Error("ARM deployment result is missing its exact operation identity");
  }
  if (properties.provisioningState !== "Succeeded") {
    throw new Error(`ARM deployment did not succeed: ${String(properties.provisioningState)}`);
  }
  if (typeof properties.correlationId !== "string" || !properties.correlationId) {
    throw new Error("ARM deployment result has no correlation ID");
  }
  if (!isTimestamp(properties.timestamp)) throw new Error("ARM deployment result has no valid completion timestamp");
  if (deploymentRunId !== undefined || deploymentNonce !== undefined) {
    const runMatch = deploymentRunPattern.exec(expectedName);
    if (deploymentRunId !== expectedName || !runMatch || deploymentNonce !== runMatch[1]) {
      throw new Error("ARM deployment name does not bind the release run ID and nonce");
    }
  }
  return {
    deploymentName: expectedName,
    operationId: String(deployment.id).toLowerCase(),
    correlationId: properties.correlationId,
    completedAt: new Date(properties.timestamp).toISOString(),
    outputs: properties.outputs ?? null,
  };
}

export async function verifyAzureDeploymentLive({
  projectRoot,
  manifest,
  runAzJson = defaultRunAzJson,
  fetchImpl = fetch,
  authenticatedIdentityVerifier = defaultAuthenticatedIdentityVerifier,
  now = () => new Date(),
}) {
  await validateDeploymentManifestDocument(manifest);
  const { PRODUCTION_TARGETS, assertExactProductionTargets } = await import("./production-targets.mjs");
  assertExactProductionTargets(manifest.targets?.map(({ kind, name, resourceGroup }) => ({ kind, name, resourceGroup })));
  const source = await computeDockerBuildContext(projectRoot);
  const jobTargets = PRODUCTION_TARGETS.filter(({ kind }) => kind === "job");
  const [app, revisions, tagManifest, digestManifest, buildRuns, deployment, auth, ...jobs] = await Promise.all([
    runAzJson({
      projectRoot,
      args: [
        "containerapp", "show",
        "--resource-group", manifest.resourceGroup,
        "--name", manifest.containerAppName,
        "--output", "json",
      ],
    }),
    runAzJson({
      projectRoot,
      args: [
        "containerapp", "revision", "list",
        "--resource-group", manifest.resourceGroup,
        "--name", manifest.containerAppName,
        "--output", "json",
      ],
    }),
    runAzJson({
      projectRoot,
      args: [
        "acr", "repository", "show",
        "--name", manifest.registry,
        "--image", `${manifest.repository}:${manifest.acrBuild.imageTag}`,
        "--output", "json",
      ],
    }),
    runAzJson({
      projectRoot,
      args: [
        "acr", "repository", "show",
        "--name", manifest.registry,
        "--image", `${manifest.repository}@${manifest.imageDigest}`,
        "--output", "json",
      ],
    }),
    runAzJson({
      projectRoot,
      args: [
        "acr", "task", "show-run", "--registry", manifest.registry,
        "--run-id", manifest.acrBuild.runId, "--output", "json",
      ],
    }),
    runAzJson({
      projectRoot,
      args: [
        "deployment", "group", "show", "--resource-group", manifest.resourceGroup,
        "--name", manifest.armDeployment.deploymentName, "--output", "json",
      ],
    }),
    runAzJson({
      projectRoot,
      args: [
        "containerapp", "auth", "show", "--resource-group", manifest.resourceGroup,
        "--name", manifest.containerAppName, "--output", "json",
      ],
    }),
    ...jobTargets.map((target) => runAzJson({
      projectRoot,
      args: [
        "containerapp", "job", "show", "--resource-group", target.resourceGroup,
        "--name", target.name, "--output", "json",
      ],
    })),
  ]);

  const latestRevisionName = app.properties?.latestRevisionName ?? null;
  const latestReadyRevisionName = app.properties?.latestReadyRevisionName ?? null;
  const latest = Array.isArray(revisions)
    ? revisions.find((revision) => revision.name === latestRevisionName) ?? null
    : null;
  const trafficRevisions = Array.isArray(revisions)
    ? revisions.filter((revision) => Number(revision.properties?.trafficWeight ?? 0) > 0)
    : [];
  const fqdn = app.properties?.configuration?.ingress?.fqdn ?? null;
  const productionUrl = fqdn ? `https://${fqdn}` : null;
  if (productionUrl !== manifest.productionUrl) throw new Error("Live production URL does not match deployment manifest");

  const actualTargets = [canonicalTargetContract(app, "app"), ...jobs.map((job) => canonicalTargetContract(job, "job"))]
    .sort((left, right) => left.name.localeCompare(right.name));
  const manifestTargets = [...manifest.targets].sort((left, right) => left.name.localeCompare(right.name));
  if (actualTargets.length !== manifestTargets.length) {
    throw new Error("Live app plus exact 24-job target count does not match deployment manifest");
  }
  for (const [index, actual] of actualTargets.entries()) {
    if (!sameCanonicalValue(actual, manifestTargets[index])) {
      throw new Error(`Live app plus exact 24-job target contracts do not match deployment manifest: ${actual.name}`);
    }
  }

  const buildRun = Array.isArray(buildRuns) && buildRuns.length === 1 ? buildRuns[0] : buildRuns;
  const liveBuild = validateAcrBuildProvenance(buildRun, {
    registry: manifest.registry,
    repository: manifest.repository,
    imageTag: manifest.acrBuild.imageTag,
  });
  if (!sameCanonicalValue(liveBuild, manifest.acrBuild)) {
    throw new Error("Live ACR run provenance does not match deployment manifest");
  }
  validateLiveAcrRepositoryBinding({
    registry: manifest.registry,
    repository: manifest.repository,
    imageTag: manifest.acrBuild.imageTag,
    digest: manifest.imageDigest,
    tagManifest,
    digestManifest,
  });

  const liveArm = validateArmDeploymentProvenance(deployment, manifest.armDeployment.deploymentName, {
    deploymentRunId: manifest.deploymentRunId,
    deploymentNonce: manifest.deploymentNonce,
  });
  const liveRunMatch = deploymentRunPattern.exec(liveArm.deploymentName);
  if (!liveRunMatch) throw new Error("Live ARM deployment name does not contain its release nonce");
  if (!sameCanonicalValue({
    deploymentName: liveArm.deploymentName,
    operationId: liveArm.operationId,
    correlationId: liveArm.correlationId,
    completedAt: liveArm.completedAt,
  }, manifest.armDeployment)) {
    throw new Error("Live ARM deployment operation provenance does not match deployment manifest");
  }
  if (manifest.deploymentOperationId !== liveArm.operationId) {
    throw new Error("Root deployment operation ID does not match the live ARM operation");
  }
  const signingKeyEntries = Object.entries(manifest.evidenceSigningKeyIds ?? {});
  if (signingKeyEntries.length !== 3) throw new Error("Deployment manifest does not bind all evidence signing keys");
  const signingKeys = await Promise.all(signingKeyEntries.map(async ([kind, keyId]) => {
    const key = await runAzJson({
      projectRoot,
      args: ["keyvault", "key", "show", "--id", keyId, "--output", "json"],
    });
    const liveKeyId = key?.key?.kid ?? key?.kid ?? key?.id ?? null;
    const keyType = key?.key?.kty ?? key?.kty ?? null;
    if (liveKeyId !== keyId || !["RSA", "RSA-HSM"].includes(keyType) || key?.attributes?.enabled !== true) {
      throw new Error(`Live ${kind} evidence signing key version is missing or disabled`);
    }
    return [kind, keyId];
  }));
  const liveSigningKeyIds = Object.fromEntries(signingKeys);
  if (!sameCanonicalValue(liveSigningKeyIds, manifest.evidenceSigningKeyIds)) {
    throw new Error("Live evidence signing key IDs do not match deployment manifest");
  }

  const liveVerification = await collectLiveHttpVerification({
    productionUrl, auth, fetchImpl, authenticatedIdentityVerifier, projectRoot,
  });
  validateLiveVerificationMatch(liveVerification, manifest.liveVerification, {
    productionUrl,
    notBefore: manifest.armDeployment.completedAt,
    now: now(),
  });

  const revisionCreatedAt = latest?.properties?.createdTime ?? latest?.createdTime ?? null;
  if (!isTimestamp(revisionCreatedAt) || new Date(revisionCreatedAt).toISOString() !== manifest.revisionCreatedAt) {
    throw new Error("Live revision creation time does not match deployment manifest");
  }
  return {
    schemaVersion: manifest.schemaVersion,
    environment: manifest.environment,
    planRevision: manifest.planRevision,
    planSha256: manifest.planSha256,
    buildSourceSha256: source.sha256,
    resourceGroup: manifest.resourceGroup,
    containerAppName: manifest.containerAppName,
    registry: manifest.registry,
    repository: manifest.repository,
    acrBuild: liveBuild,
    armDeployment: {
      deploymentName: liveArm.deploymentName,
      operationId: liveArm.operationId,
      correlationId: liveArm.correlationId,
      completedAt: liveArm.completedAt,
    },
    deploymentOperationId: liveArm.operationId,
    deploymentRunId: liveArm.deploymentName,
    deploymentNonce: liveRunMatch[1],
    evidenceSigningKeyIds: liveSigningKeyIds,
    deployedRevision: latestRevisionName,
    latestRevisionName,
    latestReadyRevisionName,
    revisionCreatedAt: new Date(revisionCreatedAt).toISOString(),
    revisionMode: app.properties?.configuration?.activeRevisionsMode ?? null,
    active: latest?.properties?.active === true,
    healthState: latest?.properties?.healthState ?? null,
    provisioningState: latest?.properties?.provisioningState ?? null,
    trafficWeight: Number(latest?.properties?.trafficWeight ?? 0),
    trafficRevisionNames: trafficRevisions.map((revision) => revision.name).sort(),
    pinnedImage: latest?.properties?.template?.containers?.[0]?.image ?? null,
    imageDigest: digestManifest.digest,
    productionUrl,
    targets: actualTargets,
    liveVerification: manifest.liveVerification,
    monitoringEvidence: manifest.monitoringEvidence,
    deployedAt: manifest.deployedAt,
  };
}

async function defaultRunAzJson({ projectRoot, args }) {
  const azureConfigDirectory = process.env.AZURE_CONFIG_DIR
    || resolve(projectRoot, "..", ".work", "azure");
  const child = spawn("az", args, {
    cwd: projectRoot,
    env: azureChildEnvironment(process.env, { AZURE_CONFIG_DIR: azureConfigDirectory }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(
      `read-only Azure verification failed (${args.slice(0, 3).join(" ")}): ${stderr.trim() || `exit ${String(result.code ?? result.signal)}`}`,
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`read-only Azure verification returned invalid JSON for ${args.slice(0, 3).join(" ")}`);
  }
}

export async function verifyHealthEndpoint(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, redirect: "manual" });
  const payload = await response.json().catch(() => null);
  if (response.status !== 200 || payload?.ok !== true || payload?.database?.connected !== true) {
    throw new Error(`Production health contract failed: HTTP ${response.status}`);
  }
  return { url, status: response.status, ok: true, databaseConnected: true };
}

export async function verifyUnauthenticatedProtection(fetchImpl, url) {
  const productionOrigin = new URL(url).origin;
  const browserResponse = await fetchImpl(url, {
    headers: { accept: "text/html", "user-agent": browserVerificationUserAgent },
    redirect: "manual",
  });
  const browserLocation = browserResponse.headers?.get?.("location") ?? null;
  if (browserResponse.status !== 302 || typeof browserLocation !== "string") {
    throw new Error(`Browser unauthenticated route did not return the exact Easy Auth redirect: HTTP ${browserResponse.status}`);
  }
  const parsedRedirect = parseBrowserAuthorizeLocation(browserLocation, productionOrigin);

  const apiResponse = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": apiVerificationUserAgent },
    redirect: "manual",
  });
  const apiLocation = apiResponse.headers?.get?.("location") ?? null;
  if (apiResponse.status !== 401 || apiLocation !== null) {
    throw new Error(`API unauthenticated route did not return an exact 401 without Location: HTTP ${apiResponse.status}`);
  }
  return {
    browser: {
      url,
      status: browserResponse.status,
      location: browserLocation,
      ...parsedRedirect,
    },
    api: { url, status: apiResponse.status, location: null },
  };
}

function parseBrowserAuthorizeLocation(location, productionOrigin) {
  let authorizeUrl;
  try {
    authorizeUrl = new URL(location);
  } catch {
    throw new Error("Browser unauthenticated route returned an invalid Easy Auth Location URL");
  }
  const expectedAuthorizePath = `/${productionAadTenantId}/oauth2/v2.0/authorize`;
  const clientId = authorizeUrl.searchParams.get("client_id");
  const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
  const state = authorizeUrl.searchParams.get("state");
  const stateRedirect = typeof state === "string" ? new URLSearchParams(state).get("redir") : null;
  if (
    authorizeUrl.protocol !== "https:"
    || authorizeUrl.hostname !== "login.microsoftonline.com"
    || authorizeUrl.port !== ""
    || authorizeUrl.pathname !== expectedAuthorizePath
    || clientId !== productionAadClientId
    || redirectUri !== `${productionOrigin}/.auth/login/aad/callback`
    || stateRedirect !== "/quotes"
  ) {
    throw new Error("Browser unauthenticated redirect does not match the exact production AAD authorization contract");
  }
  return {
    authorizeEndpoint: `${authorizeUrl.origin}${authorizeUrl.pathname}`,
    clientId,
    redirectUri,
    stateRedirect,
  };
}

export function canonicalAuthContract(auth) {
  const registration = auth?.identityProviders?.azureActiveDirectory?.registration;
  const validation = auth?.identityProviders?.azureActiveDirectory?.validation;
  const contract = {
    platformEnabled: auth?.platform?.enabled === true,
    unauthenticatedClientAction: auth?.globalValidation?.unauthenticatedClientAction ?? null,
    excludedPaths: [...(auth?.globalValidation?.excludedPaths ?? [])].sort(),
    redirectToProvider: auth?.globalValidation?.redirectToProvider ?? null,
    requireHttps: auth?.httpSettings?.requireHttps === true,
    clientId: registration?.clientId ?? null,
    openIdIssuer: registration?.openIdIssuer ?? null,
    clientSecretSettingName: registration?.clientSecretSettingName ?? null,
    allowedAudiences: [...(validation?.allowedAudiences ?? [])].sort(),
  };
  if (
    !contract.platformEnabled
    || contract.unauthenticatedClientAction !== "RedirectToLoginPage"
    || JSON.stringify(contract.excludedPaths) !== JSON.stringify(["/api/health"])
    || contract.redirectToProvider !== "AzureActiveDirectory"
    || !contract.requireHttps
    || contract.clientId !== productionAadClientId
    || contract.openIdIssuer !== productionAadIssuer
    || contract.clientSecretSettingName !== productionAadSecretSetting
    || JSON.stringify(contract.allowedAudiences) !== JSON.stringify(productionAadAudiences)
  ) throw new Error("Live Easy Auth contract is incomplete or drifted");
  return contract;
}

export function validateAuthenticatedIdentityReceipt(receipt) {
  const principalEmail = String(receipt?.principalEmail ?? "").toLowerCase();
  if (!allowedOwnerEmails.has(principalEmail)) throw new Error("Authenticated identity hook did not verify Asad or Laila");
  if (receipt?.authenticated !== true || typeof receipt?.principalId !== "string" || !receipt.principalId) {
    throw new Error("Authenticated identity hook returned no concrete principal/session evidence");
  }
  if (!sha256Pattern.test(receipt?.sessionReceiptSha256 ?? "") || !isTimestamp(receipt?.verifiedAt)) {
    throw new Error("Authenticated identity hook returned invalid receipt provenance");
  }
  return {
    authenticated: true,
    principalEmail,
    principalId: receipt.principalId,
    provider: receipt.provider ?? "aad",
    verifiedAt: new Date(receipt.verifiedAt).toISOString(),
    sessionReceiptSha256: receipt.sessionReceiptSha256,
  };
}

export async function collectLiveHttpVerification({
  productionUrl,
  auth,
  fetchImpl = fetch,
  authenticatedIdentityVerifier = defaultAuthenticatedIdentityVerifier,
  projectRoot = process.cwd(),
}) {
  return {
    health: await verifyHealthEndpoint(fetchImpl, `${productionUrl}/api/health`),
    unauthenticated: await verifyUnauthenticatedProtection(fetchImpl, `${productionUrl}/quotes`),
    authContract: canonicalAuthContract(auth),
    authenticatedIdentity: validateAuthenticatedIdentityReceipt(
      await authenticatedIdentityVerifier({ productionUrl, fetchImpl, projectRoot }),
    ),
  };
}

export function acquireProductionAccessToken({
  projectRoot = process.cwd(),
  sourceEnvironment = process.env,
  spawnImpl = spawnSync,
} = {}) {
  const result = spawnImpl("az", [
    "account", "get-access-token",
    "--resource", `api://${productionAadClientId}`,
    "--output", "json",
  ], {
    cwd: projectRoot,
    env: azureChildEnvironment(sourceEnvironment, {
      AZURE_CONFIG_DIR: sourceEnvironment.AZURE_CONFIG_DIR
        || resolve(projectRoot, "..", ".work", "azure"),
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result?.status !== 0) throw new Error("AAD production access-token acquisition failed");
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    throw new Error("AAD production access-token acquisition returned invalid JSON");
  }
  if (typeof document?.accessToken !== "string" || !document.accessToken
    || (document.tokenType !== undefined && String(document.tokenType).toLowerCase() !== "bearer")) {
    throw new Error("AAD production access-token response is incomplete");
  }
  return document.accessToken;
}

export async function defaultAuthenticatedIdentityVerifier({
  productionUrl,
  fetchImpl = fetch,
  projectRoot = process.cwd(),
  accessTokenProvider = acquireProductionAccessToken,
  now = () => new Date(),
}) {
  let accessToken = accessTokenProvider({ projectRoot });
  try {
    const response = await fetchImpl(`${productionUrl}/api/auth/session`, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      redirect: "manual",
    });
    const payload = await response.json().catch(() => null);
    if (response.status !== 200) {
      throw new Error(`Authenticated session verification failed: HTTP ${response.status}`);
    }
    assertOnlyKeys(payload, ["authenticated", "principalEmail", "principalId", "provider"], "authenticated session response");
    const sanitized = {
      authenticated: payload.authenticated,
      principalEmail: String(payload.principalEmail ?? "").toLowerCase(),
      principalId: payload.principalId,
      provider: payload.provider,
    };
    if (sanitized.authenticated !== true || !allowedOwnerEmails.has(sanitized.principalEmail)
      || typeof sanitized.principalId !== "string" || !sanitized.principalId
      || sanitized.provider !== "aad") {
      throw new Error("Authenticated session endpoint returned no exact Asad/Laila AAD identity");
    }
    return validateAuthenticatedIdentityReceipt({
      ...sanitized,
      verifiedAt: now().toISOString(),
      sessionReceiptSha256: createHash("sha256")
        .update(JSON.stringify(canonicalJson(sanitized)))
        .digest("hex"),
    });
  } finally {
    accessToken = null;
  }
}

function canonicalContainerContract(container) {
  if (!container || typeof container !== "object" || typeof container.name !== "string" || typeof container.image !== "string") {
    throw new Error("Container contract is missing a concrete name or image");
  }
  return {
    name: container.name,
    image: container.image,
    command: canonicalJson(container.command ?? []),
    args: canonicalJson(container.args ?? []),
    env: [...(container.env ?? [])].map((entry) => ({
      name: entry.name ?? null,
      secretRef: entry.secretRef ?? null,
      value: entry.value ?? null,
    })).sort(compareCanonical),
    resources: canonicalJson(container.resources ?? null),
    probes: canonicalJson(container.probes ?? []),
    volumeMounts: canonicalJson(container.volumeMounts ?? []),
  };
}

function assertSupportedTargetShape(resource, properties, configuration, template) {
  assertOnlyKeys(resource, ["apiVersion", "id", "identity", "location", "name", "properties", "tags", "type"], "resource");
  assertOnlyKeys(resource.identity, ["type", "userAssignedIdentities"], "identity");
  assertOnlyKeys(properties, [
    "configuration", "environmentId", "managedEnvironmentId", "template", "workloadProfileName",
  ], "properties");
  assertOnlyKeys(configuration, [
    "activeRevisionsMode", "dapr", "eventTriggerConfig", "identitySettings", "ingress",
    "manualTriggerConfig", "maxInactiveRevisions", "registries", "replicaRetryLimit",
    "replicaTimeout", "runtime", "scheduleTriggerConfig", "secrets", "service",
    "stickySessions", "triggerType",
  ], "properties.configuration");
  assertOnlyKeys(template, [
    "containers", "initContainers", "revisionSuffix", "scale", "serviceBinds",
    "terminationGracePeriodSeconds", "volumes",
  ], "properties.template");
  for (const [index, container] of [...(template.containers ?? []), ...(template.initContainers ?? [])].entries()) {
    assertOnlyKeys(container, ["args", "command", "env", "image", "name", "probes", "resources", "volumeMounts"], `container ${index + 1}`);
    for (const entry of container.env ?? []) assertOnlyKeys(entry, ["name", "secretRef", "value"], `container ${index + 1} environment entry`);
  }
  for (const registry of configuration.registries ?? []) assertOnlyKeys(registry, ["identity", "passwordSecretRef", "server", "username"], "registry");
  for (const secret of configuration.secrets ?? []) assertOnlyKeys(secret, ["identity", "keyVaultUrl", "name", "value"], "secret reference");
}

function validateManifestTarget(target, pinnedImage) {
  assertOnlyKeys(target, [
    "kind", "name", "resourceGroup", "resourceId", "resourceType", "location", "tags",
    "identity", "environmentId", "configuration", "template", "image",
  ], `deployment manifest target ${String(target?.name)}`);
  if (target.kind !== "app" && target.kind !== "job") throw new Error("Deployment target kind must be app or job");
  for (const field of ["name", "resourceGroup", "resourceId", "resourceType", "location", "environmentId"]) {
    if (typeof target[field] !== "string" || !target[field]) throw new Error(`Deployment target ${String(target.name)} has no ${field}`);
  }
  if (target.image !== pinnedImage) throw new Error(`Deployment target ${target.name} is not pinned to the release image`);
  if (!target.tags || typeof target.tags !== "object" || Array.isArray(target.tags)) throw new Error(`Deployment target ${target.name} tags are invalid`);
  assertOnlyKeys(target.identity, ["type", "userAssignedIdentityIds"], `deployment target ${target.name} identity`);
  if (!Array.isArray(target.identity.userAssignedIdentityIds) || target.identity.userAssignedIdentityIds.length !== 1) {
    throw new Error(`Deployment target ${target.name} must use exactly one user-assigned identity`);
  }
  assertOnlyKeys(target.configuration, [
    "activeRevisionsMode", "ingress", "triggerType", "replicaTimeout", "replicaRetryLimit",
    "scheduleTriggerConfig", "manualTriggerConfig", "eventTriggerConfig", "registries", "secretReferences",
  ], `deployment target ${target.name} configuration`);
  if (!Array.isArray(target.configuration.registries) || !Array.isArray(target.configuration.secretReferences)) {
    throw new Error(`Deployment target ${target.name} registry/secret contracts are invalid`);
  }
  for (const registry of target.configuration.registries) {
    assertOnlyKeys(registry, ["server", "identity"], `deployment target ${target.name} registry`);
  }
  for (const secret of target.configuration.secretReferences) {
    assertOnlyKeys(secret, ["name", "keyVaultUrl", "identity"], `deployment target ${target.name} secret reference`);
    if (!secret.name || !/^https:\/\/.+\/secrets\/[A-Za-z0-9-]+$/.test(secret.keyVaultUrl ?? "") || !secret.identity) {
      throw new Error(`Deployment target ${target.name} contains a non-versionless or incomplete Key Vault reference`);
    }
  }
  assertOnlyKeys(target.template, [
    "containers", "initContainers", "scale", "volumes", "serviceBinds", "terminationGracePeriodSeconds",
  ], `deployment target ${target.name} template`);
  if (!Array.isArray(target.template.containers) || target.template.containers.length !== 1
    || !Array.isArray(target.template.initContainers)) throw new Error(`Deployment target ${target.name} container contract is invalid`);
  for (const container of [...target.template.containers, ...target.template.initContainers]) {
    assertOnlyKeys(container, [
      "name", "image", "command", "args", "env", "resources", "probes", "volumeMounts",
    ], `deployment target ${target.name} container`);
  }
  if (target.template.containers[0].image !== pinnedImage) {
    throw new Error(`Deployment target ${target.name} primary container image mismatch`);
  }
}

function validateManifestLiveVerification(live, productionUrl) {
  assertOnlyKeys(live, ["health", "unauthenticated", "authContract", "authenticatedIdentity"], "deployment manifest liveVerification");
  assertOnlyKeys(live.health, ["url", "status", "ok", "databaseConnected"], "deployment live health");
  if (live.health.url !== `${productionUrl}/api/health` || live.health.status !== 200
    || live.health.ok !== true || live.health.databaseConnected !== true) throw new Error("Deployment live health evidence is invalid");
  assertOnlyKeys(live.unauthenticated, ["browser", "api"], "deployment live unauthenticated checks");
  assertOnlyKeys(
    live.unauthenticated.browser,
    ["url", "status", "location", "authorizeEndpoint", "clientId", "redirectUri", "stateRedirect"],
    "deployment live browser unauthenticated check",
  );
  assertOnlyKeys(live.unauthenticated.api, ["url", "status", "location"], "deployment live API unauthenticated check");
  const origin = new URL(productionUrl).origin;
  let parsedRedirect = null;
  try {
    parsedRedirect = parseBrowserAuthorizeLocation(live.unauthenticated.browser.location, origin);
  } catch {
    throw new Error("Deployment live browser redirect evidence is invalid");
  }
  if (live.unauthenticated.browser.url !== `${productionUrl}/quotes`
    || live.unauthenticated.browser.status !== 302
    || live.unauthenticated.browser.authorizeEndpoint !== parsedRedirect.authorizeEndpoint
    || live.unauthenticated.browser.clientId !== parsedRedirect.clientId
    || live.unauthenticated.browser.redirectUri !== parsedRedirect.redirectUri
    || live.unauthenticated.browser.stateRedirect !== parsedRedirect.stateRedirect
    || live.unauthenticated.api.url !== `${productionUrl}/quotes`
    || live.unauthenticated.api.status !== 401
    || live.unauthenticated.api.location !== null) {
    throw new Error("Deployment live unauthenticated protection evidence is invalid");
  }
  assertOnlyKeys(
    live.authContract,
    [
      "platformEnabled", "unauthenticatedClientAction", "excludedPaths", "redirectToProvider", "requireHttps",
      "clientId", "openIdIssuer", "clientSecretSettingName", "allowedAudiences",
    ],
    "deployment live auth contract",
  );
  if (live.authContract.platformEnabled !== true || live.authContract.unauthenticatedClientAction !== "RedirectToLoginPage"
    || JSON.stringify(live.authContract.excludedPaths) !== JSON.stringify(["/api/health"])
    || live.authContract.redirectToProvider !== "AzureActiveDirectory" || live.authContract.requireHttps !== true
    || live.authContract.clientId !== productionAadClientId || live.authContract.openIdIssuer !== productionAadIssuer
    || live.authContract.clientSecretSettingName !== productionAadSecretSetting
    || JSON.stringify(live.authContract.allowedAudiences) !== JSON.stringify(productionAadAudiences)) {
    throw new Error("Deployment live Easy Auth contract is invalid");
  }
  validateAuthenticatedIdentityReceipt(live.authenticatedIdentity);
}

export function validateLiveVerificationMatch(actual, recorded, {
  productionUrl,
  notBefore,
  now = new Date(),
} = {}) {
  validateManifestLiveVerification(actual, productionUrl);
  validateManifestLiveVerification(recorded, productionUrl);
  const upperBound = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  validateVerificationTimestamp(actual.authenticatedIdentity.verifiedAt, notBefore, upperBound, "Live authenticated identity verification");
  validateVerificationTimestamp(recorded.authenticatedIdentity.verifiedAt, notBefore, upperBound, "Recorded authenticated identity verification");
  const stable = (live) => ({
    health: live.health,
    unauthenticated: {
      browser: {
        url: live.unauthenticated.browser.url,
        status: live.unauthenticated.browser.status,
        authorizeEndpoint: live.unauthenticated.browser.authorizeEndpoint,
        clientId: live.unauthenticated.browser.clientId,
        redirectUri: live.unauthenticated.browser.redirectUri,
        stateRedirect: live.unauthenticated.browser.stateRedirect,
      },
      api: live.unauthenticated.api,
    },
    authContract: live.authContract,
    authenticatedIdentity: {
      authenticated: live.authenticatedIdentity.authenticated,
      principalEmail: live.authenticatedIdentity.principalEmail,
      principalId: live.authenticatedIdentity.principalId,
      provider: live.authenticatedIdentity.provider,
      sessionReceiptSha256: live.authenticatedIdentity.sessionReceiptSha256,
    },
  });
  if (!sameCanonicalValue(stable(actual), stable(recorded))) {
    throw new Error("Live health/authentication stable fields do not match deployment manifest");
  }
  return true;
}

function validateMonitoringEvidence(evidence) {
  assertOnlyKeys(evidence, ["longestQueryMetric", "actionGroupNotification"], "deployment manifest monitoringEvidence");
  for (const [name, artifact] of Object.entries(evidence)) {
    assertOnlyKeys(artifact, ["path", "sha256"], `deployment monitoring evidence ${name}`);
    if (typeof artifact.path !== "string" || !artifact.path || !sha256Pattern.test(artifact.sha256 ?? "")) {
      throw new Error(`Deployment monitoring evidence ${name} is incomplete`);
    }
  }
}

function assertOnlyKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) throw new Error(`${label} contains unsupported fields: ${unsupported.join(", ")}`);
}

function canonicalStringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Production target tags must be an object");
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function resourceGroupFromId(resourceId) {
  const match = String(resourceId).match(/\/resourceGroups\/([^/]+)/i);
  if (!match) throw new Error("Production target resource ID has no resource group");
  return match[1];
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonicalJson(nested)]));
}

function sameCanonicalValue(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function compareCanonical(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateVerificationTimestamp(value, notBefore, notAfter, label) {
  if (!isTimestamp(value) || !isTimestamp(notBefore) || !isTimestamp(notAfter)) {
    throw new Error(`${label} timestamp bounds are incomplete`);
  }
  const time = Date.parse(value);
  if (time < Date.parse(notBefore) || time > Date.parse(notAfter)) {
    throw new Error(`${label} timestamp is outside its deployment verification bounds`);
  }
}

async function collectEntries(projectRoot, directory, rules, entries) {
  const absoluteDirectory = resolve(projectRoot, directory || ".");
  const children = await readdir(absoluteDirectory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const path = directory ? `${directory}/${child.name}` : child.name;
    const absolutePath = resolve(projectRoot, path);
    const forceContextMetadata = path === "Dockerfile" || path === ".dockerignore";
    const ignored = !forceContextMetadata && isIgnored(path, child.isDirectory(), rules);
    if (child.isDirectory()) {
      if (!ignored) {
        const directoryStat = await lstat(absolutePath);
        entries.push({ path, type: "D", mode: normalizedMode(directoryStat.mode), bytes: Buffer.alloc(0) });
      }
      if (!ignored || rules.some((rule) => rule.negated)) {
        await collectEntries(projectRoot, path, rules, entries);
      }
      continue;
    }
    if (ignored) continue;
    const before = await lstat(absolutePath);
    if (before.isSymbolicLink()) {
      entries.push({
        path,
        type: "L",
        mode: normalizedMode(before.mode),
        bytes: Buffer.from(await readlink(absolutePath), "utf8"),
      });
      continue;
    }
    if (!before.isFile()) {
      throw new Error(`Unsupported Docker build-context entry type: ${path}`);
    }
    const bytes = await readFile(absolutePath);
    const after = await lstat(absolutePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode) {
      throw new Error(`Docker build-context entry changed while hashing: ${path}`);
    }
    entries.push({ path, type: "F", mode: normalizedMode(before.mode), bytes });
  }
}

function normalizedMode(mode) {
  return mode & 0o7777;
}

function hashContextEntries(entries) {
  const hash = createHash("sha256");
  hash.update(contextDomain);
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, "utf8");
    hash.update(entry.type);
    hash.update("\0");
    hash.update(entry.mode.toString(8).padStart(4, "0"));
    hash.update("\0");
    hash.update(String(pathBytes.length));
    hash.update("\0");
    hash.update(pathBytes);
    hash.update("\0");
    hash.update(String(entry.bytes.length));
    hash.update("\0");
    hash.update(entry.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function assertSameContext(expected, actual, stage) {
  if (expected !== actual) {
    throw new Error(`Docker build context changed in ${stage}: expected ${expected}, got ${actual}`);
  }
}

function parseDockerignore(text) {
  return text.split(/\r?\n/).flatMap((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line === ".") return [];
    const negated = line.startsWith("!");
    let pattern = negated ? line.slice(1) : line;
    pattern = pattern.replace(/^\.\//, "").replace(/^\/+/, "");
    const directoryOnly = pattern.endsWith("/");
    pattern = pattern.replace(/\/+$/, "");
    if (!pattern) return [];
    return [{
      negated,
      directoryOnly,
      hasSlash: pattern.includes("/"),
      regex: globRegex(pattern),
    }];
  });
}

function isIgnored(path, isDirectory, rules) {
  const segments = path.split("/");
  let ignored = false;
  for (const rule of rules) {
    const candidates = rule.hasSlash
      ? [path, ...parentPaths(path)]
      : segments;
    const matches = candidates.some((candidate) => rule.regex.test(candidate));
    if (matches && (!rule.directoryOnly || isDirectory || candidates.some((candidate) => candidate !== path))) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function parentPaths(path) {
  const parts = path.split("/");
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function globRegex(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function isProjectRelativePath(root, candidate) {
  const pathFromRoot = relative(resolve(root), resolve(root, candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

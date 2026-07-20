import { ManagedIdentityCredential } from "@azure/identity";

import {
  EVIDENCE_SIGNER_IDENTITIES,
  ReleaseEvidenceTrustError,
  verifyEvidenceSignerRbacPolicy,
} from "./release-evidence-trust.mjs";

const ARM_ORIGIN = "https://management.azure.com";
const ARM_SCOPE = "https://management.azure.com/.default";
const VAULT_SCOPE = "https://vault.azure.net/.default";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const versionedKeyIdPattern = /^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/keys\/([A-Za-z0-9-]+)\/[a-f0-9]{32}$/;

export function createManagedIdentityReceiptDependencies({
  kind,
  clientId,
  subscriptionId,
  resourceGroup,
  credential = new ManagedIdentityCredential(clientId),
  fetchImpl = fetch,
}) {
  if (!EVIDENCE_SIGNER_IDENTITIES[kind]) throw new ReleaseEvidenceTrustError(`unknown receipt kind ${String(kind)}`);
  if (!uuidPattern.test(clientId ?? "") || !uuidPattern.test(subscriptionId ?? "")) {
    throw new ReleaseEvidenceTrustError("managed-identity receipt runtime requires concrete client and subscription IDs");
  }
  if (typeof resourceGroup !== "string" || !/^[A-Za-z0-9._()-]{1,90}$/.test(resourceGroup)) {
    throw new ReleaseEvidenceTrustError("managed-identity receipt runtime requires a concrete resource group");
  }
  let policyVerification;
  const verifyPolicy = () => {
    policyVerification ??= verifyManagedIdentityEvidencePolicy({
      kind, clientId, subscriptionId, resourceGroup, credential, fetchImpl,
    });
    return policyVerification;
  };
  return {
    signerIdentityVerifier: verifyPolicy,
    keyResolver: async ({ keyId }) => {
      assertEvidenceKeyId(keyId, { kind });
      await verifyPolicy();
      const token = await requiredToken(credential, VAULT_SCOPE, "Key Vault");
      const response = await requestJson(`${keyId}?api-version=7.4`, {
        token: token.token,
        fetchImpl,
        label: "Key Vault public-key lookup",
      });
      return response.key;
    },
    publicKeyResolver: async ({ keyId }) => {
      assertEvidenceKeyId(keyId);
      await verifyPolicy();
      const token = await requiredToken(credential, VAULT_SCOPE, "Key Vault");
      const response = await requestJson(`${keyId}?api-version=7.4`, {
        token: token.token,
        fetchImpl,
        label: "Key Vault public-key lookup",
      });
      return response.key;
    },
    digestSigner: async ({ keyId, digest }) => {
      assertEvidenceKeyId(keyId, { kind });
      await verifyPolicy();
      if (!/^[A-Za-z0-9_-]{43}$/.test(digest ?? "")) {
        throw new ReleaseEvidenceTrustError("managed-identity signer received an invalid SHA-256 digest");
      }
      const token = await requiredToken(credential, VAULT_SCOPE, "Key Vault");
      const response = await requestJson(`${keyId}/sign?api-version=7.4`, {
        token: token.token,
        fetchImpl,
        method: "POST",
        body: { alg: "RS256", value: digest },
        label: "Key Vault digest signing",
      });
      if (typeof response.value !== "string") throw new ReleaseEvidenceTrustError("Key Vault signing response omitted its signature");
      return response.value;
    },
  };
}

function assertEvidenceKeyId(keyId, { kind = null } = {}) {
  const match = versionedKeyIdPattern.exec(keyId ?? "");
  if (!match) throw new ReleaseEvidenceTrustError("managed-identity signer requires a version-pinned evidence key");
  const allowedKinds = Object.entries(EVIDENCE_SIGNER_IDENTITIES)
    .filter(([, policy]) => policy.keyName === match[1])
    .map(([evidenceKind]) => evidenceKind);
  if (allowedKinds.length !== 1 || (kind && allowedKinds[0] !== kind)) {
    throw new ReleaseEvidenceTrustError(`${kind ?? "receipt"} managed identity cannot use the ${match[1]} key`);
  }
}

export async function verifyManagedIdentityEvidencePolicy({
  kind,
  clientId,
  subscriptionId,
  resourceGroup,
  credential,
  fetchImpl = fetch,
}) {
  const armToken = await requiredToken(credential, ARM_SCOPE, "ARM");
  const vaultToken = await requiredToken(credential, VAULT_SCOPE, "Key Vault");
  const vaultClaims = decodeClaims(vaultToken.token, "managed-identity Key Vault token");
  const identities = {};
  for (const [evidenceKind, policy] of Object.entries(EVIDENCE_SIGNER_IDENTITIES)) {
    const id = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`
      + `/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${policy.name}`;
    const document = await armJson(`${id}?api-version=2023-01-31`, armToken.token, fetchImpl, `${evidenceKind} signer identity`);
    identities[evidenceKind] = {
      id: document.id,
      principalId: document.properties?.principalId,
      clientId: document.properties?.clientId,
    };
  }
  const current = identities[kind];
  if (
    vaultClaims.oid?.toLowerCase() !== current.principalId?.toLowerCase()
    || (vaultClaims.azp ?? vaultClaims.appid)?.toLowerCase() !== current.clientId?.toLowerCase()
    || current.clientId?.toLowerCase() !== clientId.toLowerCase()
  ) {
    throw new ReleaseEvidenceTrustError(`active managed identity does not match the isolated ${kind} signer`);
  }

  const vaultResourceId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`
    + "/providers/Microsoft.KeyVault/vaults/kv-prostar-metrics-prod";
  await armJson(`${vaultResourceId}?api-version=2023-07-01`, armToken.token, fetchImpl, "evidence Key Vault");
  const assignmentsByKind = {};
  const roleDefinitionIds = new Set();
  for (const [evidenceKind, policy] of Object.entries(EVIDENCE_SIGNER_IDENTITIES)) {
    const keyScope = `${vaultResourceId}/keys/${policy.keyName}`;
    const assignments = await armList(
      `${keyScope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=atScope()`,
      armToken.token,
      fetchImpl,
      `${evidenceKind} evidence-key role assignments`,
    );
    assignmentsByKind[evidenceKind] = assignments.map((assignment) => ({
      principalId: assignment.properties?.principalId,
      roleDefinitionId: assignment.properties?.roleDefinitionId,
      scope: assignment.properties?.scope ?? assignment.id?.split("/providers/Microsoft.Authorization/roleAssignments/")[0],
    }));
    for (const assignment of assignmentsByKind[evidenceKind]) roleDefinitionIds.add(assignment.roleDefinitionId);
  }
  const roleDefinitions = {};
  for (const roleDefinitionId of roleDefinitionIds) {
    if (typeof roleDefinitionId !== "string") throw new ReleaseEvidenceTrustError("evidence-key assignment omitted its role definition");
    const definition = await armJson(
      `${roleDefinitionId}?api-version=2022-04-01`,
      armToken.token,
      fetchImpl,
      `role definition ${roleDefinitionId}`,
    );
    roleDefinitions[roleDefinitionId.toLowerCase()] = { permissions: definition.properties?.permissions };
  }
  verifyEvidenceSignerRbacPolicy({ vaultResourceId, identities, assignmentsByKind, roleDefinitions });
  return { identity: current, keyPolicyVerified: true };
}

async function armList(path, token, fetchImpl, label) {
  const values = [];
  let url = `${ARM_ORIGIN}${path}`;
  for (let page = 0; page < 20 && url; page += 1) {
    const document = await requestJson(url, { token, fetchImpl, label });
    if (!Array.isArray(document.value)) throw new ReleaseEvidenceTrustError(`${label} response is not a list`);
    values.push(...document.value);
    url = document.nextLink ?? null;
    if (url && !url.startsWith(`${ARM_ORIGIN}/`)) throw new ReleaseEvidenceTrustError(`${label} returned an unsafe nextLink`);
  }
  if (url) throw new ReleaseEvidenceTrustError(`${label} exceeded the bounded page limit`);
  return values;
}

function armJson(path, token, fetchImpl, label) {
  return requestJson(`${ARM_ORIGIN}${path}`, { token, fetchImpl, label });
}

async function requestJson(url, { token, fetchImpl, label, method = "GET", body = null }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ReleaseEvidenceTrustError(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new ReleaseEvidenceTrustError(`${label} failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new ReleaseEvidenceTrustError(`${label} returned invalid JSON`);
  }
}

async function requiredToken(credential, scope, label) {
  const token = await credential.getToken(scope);
  if (!token?.token || token.expiresOnTimestamp <= Date.now() + 60_000) {
    throw new ReleaseEvidenceTrustError(`${label} managed-identity token is missing or expiring`);
  }
  return token;
}

function decodeClaims(token, label) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new ReleaseEvidenceTrustError(`${label} is not a JWT`);
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new ReleaseEvidenceTrustError(`${label} contains invalid claims`);
  }
}

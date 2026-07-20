import { createHash } from "node:crypto";

import { ReleaseEvidenceTrustError } from "./release-evidence-trust.mjs";

const STORAGE_SCOPE = "https://storage.azure.com/.default";
const STORAGE_API_VERSION = "2023-11-03";
const accountPattern = /^[a-z0-9]{3,24}$/;
const containerPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const blobPattern = /^runs\/[0-9a-f-]{36}\/(?:input|output)\.json$/;
const replayBlobPattern = /^replay-ledger\/[0-9a-f-]{36}\.json$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export function createEvidenceStorageClient({ accountName, credential, fetchImpl = fetch }) {
  if (!accountPattern.test(accountName ?? "")) throw new ReleaseEvidenceTrustError("invalid evidence storage account name");
  const token = async () => {
    const value = await credential.getToken(STORAGE_SCOPE);
    if (!value?.token || value.expiresOnTimestamp <= Date.now() + 60_000) {
      throw new ReleaseEvidenceTrustError("evidence storage token is missing or expiring");
    }
    return value.token;
  };
  return {
    async putBlob({ container, name, bytes, sha256 }) {
      validateNames(container, name);
      if (!Buffer.isBuffer(bytes) || !sha256Pattern.test(sha256 ?? "") || hashBytes(bytes) !== sha256) {
        throw new ReleaseEvidenceTrustError("evidence blob upload hash does not match its bytes");
      }
      const response = await storageFetch(blobUrl(accountName, container, name), {
        token: await token(),
        fetchImpl,
        method: "PUT",
        body: bytes,
        headers: {
          "content-type": "application/json",
          "x-ms-blob-type": "BlockBlob",
          "x-ms-meta-sha256": sha256,
          "x-ms-meta-source": "prostar-release-evidence",
          "if-none-match": "*",
        },
        expected: [201],
        label: "evidence blob upload",
      });
      return { etag: requiredHeader(response, "etag", "evidence blob upload") };
    },
    async createReplayClaim({ container, messageId, record }) {
      const name = `replay-ledger/${messageId}.json`;
      validateNames(container, name);
      const expectedKeys = [
        "schemaVersion", "kind", "runId", "messageId", "inputSha256", "nonceSha256",
        "issuedAt", "expiresAt", "claimedAt",
      ];
      if (
        !record
        || typeof record !== "object"
        || Array.isArray(record)
        || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys.sort())
        || record.schemaVersion !== 1
        || record.messageId !== messageId
        || !["gate", "browser", "reviewer"].includes(record.kind)
        || !/^[0-9a-f-]{36}$/i.test(record.runId ?? "")
        || !sha256Pattern.test(record.inputSha256 ?? "")
        || !sha256Pattern.test(record.nonceSha256 ?? "")
        || ![record.issuedAt, record.expiresAt, record.claimedAt].every((value) => Number.isFinite(Date.parse(value)))
      ) throw new ReleaseEvidenceTrustError("evidence replay claim record is invalid");
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      const sha256 = hashBytes(bytes);
      const response = await storageFetch(blobUrl(accountName, container, name), {
        token: await token(),
        fetchImpl,
        method: "PUT",
        body: bytes,
        headers: {
          "content-type": "application/json",
          "x-ms-blob-type": "BlockBlob",
          "x-ms-meta-sha256": sha256,
          "x-ms-meta-source": "prostar-release-evidence-replay-ledger",
          "if-none-match": "*",
        },
        expected: [201, 412],
        label: "evidence replay claim",
      });
      if (response.status === 412) throw new ReleaseEvidenceTrustError("evidence handoff message was already claimed");
      return { etag: requiredHeader(response, "etag", "evidence replay claim"), sha256 };
    },
    async getBlob({ container, name, expectedSha256 = null }) {
      validateNames(container, name);
      const response = await storageFetch(blobUrl(accountName, container, name), {
        token: await token(), fetchImpl, expected: [200, 404], label: "evidence blob download",
      });
      if (response.status === 404) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 96 * 1024 * 1024) throw new ReleaseEvidenceTrustError("evidence blob exceeds the 96 MiB limit");
      const metadataSha256 = response.headers.get("x-ms-meta-sha256");
      if (!sha256Pattern.test(metadataSha256 ?? "") || hashBytes(bytes) !== metadataSha256) {
        throw new ReleaseEvidenceTrustError("evidence blob content does not match its immutable metadata hash");
      }
      if (expectedSha256 && metadataSha256 !== expectedSha256) {
        throw new ReleaseEvidenceTrustError("evidence blob metadata hash does not match the requested handoff");
      }
      return { bytes, etag: requiredHeader(response, "etag", "evidence blob download"), metadataSha256 };
    },
    async deleteBlob({ container, name, etag = null }) {
      validateNames(container, name);
      await storageFetch(blobUrl(accountName, container, name), {
        token: await token(),
        fetchImpl,
        method: "DELETE",
        headers: etag ? { "if-match": etag } : {},
        expected: [202, 404],
        label: "evidence blob cleanup",
      });
    },
    async enqueue({ queue, message }) {
      validateQueue(queue);
      const messageText = Buffer.from(JSON.stringify(message), "utf8").toString("base64");
      const body = `<QueueMessage><MessageText>${messageText}</MessageText></QueueMessage>`;
      await storageFetch(`${queueUrl(accountName, queue)}/messages?messagettl=3600`, {
        token: await token(), fetchImpl, method: "POST", body,
        headers: { "content-type": "application/xml; charset=utf-8" },
        expected: [201], label: "evidence queue enqueue",
      });
    },
    async receive({ queue, visibilityTimeoutSeconds = 1800 }) {
      validateQueue(queue);
      const url = `${queueUrl(accountName, queue)}/messages?numofmessages=1&visibilitytimeout=${visibilityTimeoutSeconds}`;
      const response = await storageFetch(url, {
        token: await token(), fetchImpl, expected: [200], label: "evidence queue receive",
      });
      const xml = await response.text();
      if (!xml.includes("<QueueMessage>")) return null;
      const id = xmlValue(xml, "MessageId");
      const popReceipt = xmlValue(xml, "PopReceipt");
      const messageText = xmlValue(xml, "MessageText");
      try {
        return {
          id,
          popReceipt,
          value: JSON.parse(Buffer.from(messageText, "base64").toString("utf8")),
        };
      } catch {
        throw new ReleaseEvidenceTrustError("evidence queue message is not valid base64 JSON");
      }
    },
    async deleteMessage({ queue, id, popReceipt }) {
      validateQueue(queue);
      if (!/^[A-Za-z0-9+/=_-]{8,512}$/.test(popReceipt ?? "")) throw new ReleaseEvidenceTrustError("invalid queue pop receipt");
      const url = `${queueUrl(accountName, queue)}/messages/${encodeURIComponent(id)}?popreceipt=${encodeURIComponent(popReceipt)}`;
      await storageFetch(url, {
        token: await token(), fetchImpl, method: "DELETE", expected: [204], label: "evidence queue cleanup",
      });
    },
  };
}

async function storageFetch(url, {
  token,
  fetchImpl,
  method = "GET",
  body = null,
  headers = {},
  expected,
  label,
}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        "x-ms-date": new Date().toUTCString(),
        "x-ms-version": STORAGE_API_VERSION,
        ...headers,
      },
      ...(body !== null ? { body } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ReleaseEvidenceTrustError(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!expected.includes(response.status)) throw new ReleaseEvidenceTrustError(`${label} failed with HTTP ${response.status}`);
  return response;
}

function validateNames(container, name) {
  if (!containerPattern.test(container ?? "")) throw new ReleaseEvidenceTrustError("invalid evidence container name");
  if (!blobPattern.test(name ?? "") && !replayBlobPattern.test(name ?? "")) {
    throw new ReleaseEvidenceTrustError("invalid evidence blob name");
  }
}

function validateQueue(queue) {
  if (!containerPattern.test(queue ?? "")) throw new ReleaseEvidenceTrustError("invalid evidence queue name");
}

function blobUrl(account, container, name) {
  return `https://${account}.blob.core.windows.net/${container}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

function queueUrl(account, queue) {
  return `https://${account}.queue.core.windows.net/${queue}`;
}

function xmlValue(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([^<]+)</${name}>`));
  if (!match) throw new ReleaseEvidenceTrustError(`evidence queue response omitted ${name}`);
  return match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function requiredHeader(response, name, label) {
  const value = response.headers.get(name);
  if (!value) throw new ReleaseEvidenceTrustError(`${label} omitted ${name}`);
  return value;
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

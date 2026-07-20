import { createHash } from "node:crypto";

export const PLAN_REVISION = "2026-07-13";
export const PLAN_SHA256 = "7392ad68fb810b840175604291a9b43cb57a3a4dce23de546f3e1c057abca3e5";
export const FEATURE_LEDGER_SCHEMA_VERSION = 4;
export const FEATURE_EVIDENCE_SCHEMA_VERSION = 2;
export const DEPLOYMENT_MANIFEST_SCHEMA_VERSION = 2;

export const AUTHORITATIVE_FEATURE_IDS = Object.freeze([
  ...ids("F", 18),
  ...ids("Q", 24),
  ...ids("J", 16),
  ...ids("T", 14),
  ...ids("C", 26),
]);

const removedStatus = "REMOVED BY OWNER DECISION";
const verifiedStatus = "VERIFIED DONE";

export function parseAuthoritativePlan(plan) {
  const actualPlanSha256 = createHash("sha256").update(plan).digest("hex");
  if (actualPlanSha256 !== PLAN_SHA256) {
    throw new Error(
      `Vendored execution plan hash mismatch: expected ${PLAN_SHA256}, received ${actualPlanSha256}`,
    );
  }

  const rowPattern = /^\| ([FQJTC]-\d{2}) \| ([^|]+) \| (.+) \|$/gm;
  const rows = [...plan.matchAll(rowPattern)].map((match) => ({
    id: match[1],
    baselineStatus: match[2].trim(),
    requirement: match[3].trim(),
  }));
  const foundIds = rows.map((row) => row.id);
  const missing = AUTHORITATIVE_FEATURE_IDS.filter((id) => !foundIds.includes(id));
  const extra = foundIds.filter((id) => !AUTHORITATIVE_FEATURE_IDS.includes(id));
  const duplicate = foundIds.filter((id, index) => foundIds.indexOf(id) !== index);
  const reordered = foundIds.length === AUTHORITATIVE_FEATURE_IDS.length
    && foundIds.some((id, index) => id !== AUTHORITATIVE_FEATURE_IDS[index]);

  if (missing.length || extra.length || duplicate.length || reordered) {
    throw new Error(
      `Execution plan feature inventory mismatch: ${JSON.stringify({ missing, extra, duplicate, reordered })}`,
    );
  }
  return rows;
}

export function resolveExecutionStatus({ baselineStatus, existingStatus, releaseEvidenceValidated = false }) {
  if (baselineStatus === removedStatus) return removedStatus;

  const candidate = existingStatus ?? baselineStatus;
  if (candidate !== verifiedStatus) return candidate;

  return releaseEvidenceValidated ? verifiedStatus : "PARTIAL";
}

export function expectedTestIdsForFeature() {
  return {
    unit: [],
    integration: [],
    scripts: [],
    infra: [],
    build: [],
  };
}

export function expectedAcceptingGate(id) {
  if (id.startsWith("Q-")) return "G-5";
  if (id.startsWith("J-")) return "G-6";
  if (id.startsWith("T-")) return "G-7";
  if (id.startsWith("C-")) return "G-8";
  const gateByFoundationNumber = {
    1: "G-0", 2: "G-2", 3: "G-1", 4: "G-2", 5: "G-3", 6: "G-3",
    7: "G-3", 8: "G-0", 9: "G-10", 10: "G-3", 11: "G-3", 12: "G-4",
    13: "G-3", 14: "G-9", 15: "G-9", 16: "G-10", 17: "G-3", 18: "G-10",
  };
  const gate = gateByFoundationNumber[Number(id.slice(2))];
  if (!gate) throw new Error(`Unknown feature ${id}`);
  return gate;
}

export function preserveMutableField(existingFeature, field, fallback) {
  return existingFeature?.[field] ?? fallback;
}

function ids(prefix, count) {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`,
  );
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertCredentialSafeEvidence } from "../check-release-evidence.mjs";
import { validateDeploymentManifestDocument } from "./deployment-provenance.mjs";
import {
  AUTHORITATIVE_FEATURE_IDS,
  parseAuthoritativePlan,
} from "./feature-status-sync.mjs";
import {
  browserArtifactReferences,
  browserArtifactValidationSubject,
  hashBytes,
  MAX_BROWSER_EVIDENCE_AGE_MS,
  validateHandoffReceiptBinding,
  validateEvidenceAge,
  validateReceiptFreshness,
  validateServiceReceiptShape,
  validateTrustedGateReport,
  verifyServiceReceipt,
} from "./release-evidence-trust.mjs";

export async function validateReviewerRunnerInputs({
  root,
  request,
  keyResolver,
  nowMs = Date.now(),
}) {
  if (typeof keyResolver !== "function") throw new Error("reviewer runner requires a managed-identity public-key resolver");
  const load = (path, label, expectedSha256 = null, requireJson = true, allowEmpty = false) => (
    loadArtifact(root, path, label, expectedSha256, requireJson, allowEmpty)
  );
  const [deployment, e2e, a11y, browserReceipt, gateReport, gateReceipt] = await Promise.all([
    load(request.deploymentManifestPath, "deployment manifest"),
    load(request.e2eReportPath, "E2E report"),
    load(request.a11yReportPath, "accessibility report"),
    load(request.browserAttestationPath, "validated browser artifacts receipt"),
    load(request.gateReportPath, "gate report"),
    load(request.gateRunnerReceiptPath, "gate runner receipt"),
  ]);
  await validateDeploymentManifestDocument(deployment.document);
  if (gateReport.document.runnerReceiptPath !== request.gateRunnerReceiptPath) {
    throw new Error("reviewer runner gate receipt path does not match the signed gate report");
  }
  const artifactReferences = browserArtifactReferences(e2e.document, a11y.document);
  await Promise.all(artifactReferences.map((reference) => (
    load(reference.path, `browser artifact ${reference.path}`, reference.sha256, false, false)
  )));
  const browserSubject = browserArtifactValidationSubject({
    deployment: deployment.document,
    e2e: e2e.document,
    e2eSha256: e2e.sha256,
    a11ySha256: a11y.sha256,
    artifactHashes: artifactReferences.map(({ sha256 }) => sha256),
    handoffBinding: validateHandoffReceiptBinding(browserReceipt.document?.subject?.handoff, { nowMs }),
  });
  const browserCompletedAt = Math.max(
    Date.parse(e2e.document.completedAt),
    Date.parse(a11y.document.completedAt),
  );
  const browserIssuedAt = validateServiceReceiptShape(browserReceipt.document, {
    kind: "browser",
    expectedSubject: browserSubject,
    expectedKeyId: deployment.document.evidenceSigningKeyIds.browser,
  });
  if (browserIssuedAt <= browserCompletedAt) throw new Error("browser artifact validation receipt predates the supplied artifacts");
  validateEvidenceAge(browserReceipt.document.issuedAt, {
    label: "browser artifact validation receipt issuedAt",
    nowMs,
    maxAgeMs: MAX_BROWSER_EVIDENCE_AGE_MS,
    after: browserCompletedAt,
  });
  validateReceiptFreshness(browserReceipt.document, { kind: "browser", nowMs });
  await verifyServiceReceipt({
    kind: "browser",
    receipt: browserReceipt.document,
    expectedSubject: browserSubject,
    expectedKeyId: deployment.document.evidenceSigningKeyIds.browser,
    keyResolver,
  });

  const plan = await readFile(resolve(root, "docs/prostar-metrics/execution-plan.md"), "utf8");
  const removed = new Set(parseAuthoritativePlan(plan)
    .filter((row) => row.baselineStatus === "REMOVED BY OWNER DECISION")
    .map((row) => row.id));
  const mandatoryIds = AUTHORITATIVE_FEATURE_IDS.filter((id) => !removed.has(id));
  await validateTrustedGateReport({
    report: gateReport.document,
    reportSha256: gateReport.sha256,
    runnerReceipt: gateReceipt.document,
    deployment: deployment.document,
    deploymentManifestPath: request.deploymentManifestPath,
    deploymentManifestSha256: deployment.sha256,
    mandatoryIds,
    readArtifact: load,
    receiptVerifier: (params) => verifyServiceReceipt({ ...params, keyResolver }),
    nowMs,
  });
  return { browserReceiptId: browserReceipt.document.receiptId, gateReceiptId: gateReceipt.document.receiptId };
}

async function loadArtifact(root, path, label, expectedSha256, requireJson, allowEmpty) {
  if (
    typeof path !== "string"
    || !path.startsWith("docs/prostar-metrics/")
    || path.includes("../")
    || path.includes("\\")
  ) throw new Error(`${label} has an unsafe path`);
  const bytes = await readFile(resolve(root, path));
  if (!allowEmpty && bytes.length === 0) throw new Error(`${label} is empty`);
  assertCredentialSafeEvidence(bytes, label);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 && sha256 !== expectedSha256) throw new Error(`${label} SHA-256 mismatch`);
  let document;
  if (requireJson) {
    try {
      document = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`${label} is invalid JSON`);
    }
  }
  return { bytes, sha256: hashBytes(bytes), document };
}

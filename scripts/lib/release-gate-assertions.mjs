import { createHash } from "node:crypto";

import {
  PRODUCTION_GATE_COMMANDS,
  ReleaseEvidenceTrustError,
} from "./release-evidence-trust.mjs";

export const RELEASE_GATE_ASSERTION_EVENT_PREFIX = "PROSTAR_EVIDENCE_ASSERTION ";

export const UNDERLYING_GATE_COMMANDS = PRODUCTION_GATE_COMMANDS;

const countKeys = Object.freeze(["total", "passed", "failed", "skipped", "cancelled", "todo"]);

export function observedAssertionId({ category, provenance }) {
  const digest = createHash("sha256").update(JSON.stringify([
    category,
    provenance?.runner,
    provenance?.source,
    provenance?.assertion,
  ])).digest("hex");
  return `OBS-${String(category).toUpperCase()}-${digest.slice(0, 32)}`;
}

export function releaseGateAssertionEvent({ category, outcome, provenance, counts }) {
  const id = observedAssertionId({ category, provenance });
  return `${RELEASE_GATE_ASSERTION_EVENT_PREFIX}${JSON.stringify({
    schemaVersion: 2,
    category,
    id,
    outcome,
    provenance,
    counts,
  })}\n`;
}

export function extractReleaseGateAssertionEvents({ category, suiteExecution }) {
  if (!UNDERLYING_GATE_COMMANDS[category]) {
    throw new ReleaseEvidenceTrustError(`unknown structured gate category ${String(category)}`);
  }
  if (
    !suiteExecution
    || JSON.stringify(suiteExecution.command) !== JSON.stringify(UNDERLYING_GATE_COMMANDS[category])
    || !Number.isInteger(suiteExecution.exitCode)
    || !(suiteExecution.signal === null || typeof suiteExecution.signal === "string")
  ) throw new ReleaseEvidenceTrustError(`${category} gate producer received no concrete suite execution`);
  const output = `${Buffer.from(suiteExecution.stdout ?? Buffer.alloc(0)).toString("utf8")}\n${Buffer.from(
    suiteExecution.stderr ?? Buffer.alloc(0),
  ).toString("utf8")}`;
  const results = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(RELEASE_GATE_ASSERTION_EVENT_PREFIX)) continue;
    let event;
    try {
      event = JSON.parse(line.slice(RELEASE_GATE_ASSERTION_EVENT_PREFIX.length));
    } catch {
      throw new ReleaseEvidenceTrustError(`${category} gate emitted malformed assertion-event JSON`);
    }
    validateAssertionEvent(event, category, results.length + 1);
    results.push({
      id: event.id,
      outcome: event.outcome,
      provenance: event.provenance,
      counts: event.counts,
    });
  }
  if (results.length === 0) {
    throw new ReleaseEvidenceTrustError(
      `${category} gate emitted zero concrete assertion claims; process success cannot synthesize evidence`,
    );
  }
  const ids = results.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new ReleaseEvidenceTrustError(`${category} gate emitted duplicate assertion IDs`);
  const mappings = results.map(({ id, provenance }) => `${id}|${provenance.runner}|${provenance.source}|${provenance.assertion}`);
  if (new Set(mappings).size !== mappings.length) {
    throw new ReleaseEvidenceTrustError(`${category} gate emitted duplicate assertion provenance`);
  }
  return results;
}

export function summarizeReleaseGateAssertions(results) {
  const summary = {
    claims: results.length,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
  };
  for (const result of results) {
    for (const key of countKeys) summary[key] += result.counts[key];
  }
  return summary;
}

function validateAssertionEvent(event, category, index) {
  exactKeys(
    event,
    ["schemaVersion", "category", "id", "outcome", "provenance", "counts"],
    `${category} assertion event ${index}`,
  );
  if (event.schemaVersion !== 2 || event.category !== category) {
    throw new ReleaseEvidenceTrustError(`${category} assertion event ${index} binding mismatch`);
  }
  if (event.id !== observedAssertionId({ category, provenance: event.provenance })) {
    throw new ReleaseEvidenceTrustError(`${category} assertion event ${index} ID is not derived from its observed provenance`);
  }
  if (!["PASS", "FAIL", "SKIP"].includes(event.outcome)) {
    throw new ReleaseEvidenceTrustError(`${category} assertion event ${index} outcome is invalid`);
  }
  exactKeys(event.provenance, ["runner", "source", "assertion"], `${category} assertion event ${index} provenance`);
  if (![/^(?:node-test|integration-test|build-check)$/, /^[A-Za-z0-9_.@/: -]{3,240}$/, /^.{3,240}$/]
    .every((pattern, patternIndex) => pattern.test([
      event.provenance.runner,
      event.provenance.source,
      event.provenance.assertion,
    ][patternIndex] ?? ""))) {
    throw new ReleaseEvidenceTrustError(`${category} assertion event ${index} provenance is invalid`);
  }
  if (
    event.provenance.source.startsWith("/")
    || event.provenance.source.includes("..")
    || /[\r\n]/.test(event.provenance.assertion)
  ) throw new ReleaseEvidenceTrustError(`${category} assertion event ${index} provenance is unsafe`);
  exactKeys(event.counts, countKeys, `${category} assertion event ${index} counts`);
  for (const key of countKeys) {
    if (!Number.isSafeInteger(event.counts[key]) || event.counts[key] < 0) {
      throw new ReleaseEvidenceTrustError(`${category} assertion event ${index} count ${key} is invalid`);
    }
  }
  const bucketTotal = countKeys.slice(1).reduce((sum, key) => sum + event.counts[key], 0);
  if (event.counts.total <= 0 || event.counts.total !== bucketTotal) {
    throw new ReleaseEvidenceTrustError(`${category} assertion event ${index} counts are inconsistent`);
  }
  if (
    (event.outcome === "PASS" && (event.counts.passed <= 0 || event.counts.failed > 0))
    || (event.outcome === "FAIL" && event.counts.failed <= 0)
    || (event.outcome === "SKIP" && event.counts.skipped + event.counts.cancelled + event.counts.todo <= 0)
  ) throw new ReleaseEvidenceTrustError(`${category} assertion event ${index} outcome disagrees with its counts`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseEvidenceTrustError(`${label} must be an object`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new ReleaseEvidenceTrustError(`${label} has unexpected fields`);
  }
}

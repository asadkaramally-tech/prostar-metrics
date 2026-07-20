import {
  PRODUCTION_CONTAINER_APP,
  PRODUCTION_RESOURCE_GROUP,
} from "./deployment-provenance.mjs";

export const PRODUCTION_JOB_NAMES = Object.freeze([
  "job-prostar-metrics-ingest",
  "job-prostar-metrics-jobs",
  "job-psm-quote-logs",
  "job-psm-job-logs",
  "job-psm-schedule-logs",
  "job-psm-mobile-logs",
  "job-psm-candidate-drain",
  "job-psm-timesheets-hourly",
  "job-psm-ts-jobs-hourly",
  "job-psm-employees-daily",
  "job-psm-rollup-drain",
  "job-psm-backfill-hourly",
  "job-psm-operational-health",
  "job-psm-reconcile-trailing-24m",
  "job-psm-reconcile-stable-history",
  "job-psm-commissions-nightly",
  "job-psm-materials",
  "job-prostar-metrics-reconcile",
  "job-prostar-metrics-employees",
  "job-prostar-metrics-timesheets",
  "job-prostar-timesheet-jobs",
  "job-prostar-metrics-schedules",
  "job-prostar-metrics-mobile",
  "job-prostar-metrics-rollups",
]);

export const PRODUCTION_TARGETS = Object.freeze([
  Object.freeze({ kind: "app", name: PRODUCTION_CONTAINER_APP, resourceGroup: PRODUCTION_RESOURCE_GROUP }),
  ...PRODUCTION_JOB_NAMES.map((name) => Object.freeze({ kind: "job", name, resourceGroup: PRODUCTION_RESOURCE_GROUP })),
]);

export function assertExactProductionJobNames(actualNames, label = "production job allowlist") {
  if (!Array.isArray(actualNames) || actualNames.some((name) => typeof name !== "string" || !name)) {
    throw new Error(`${label} must be an array of concrete names.`);
  }
  const actual = [...actualNames].sort();
  const expected = [...PRODUCTION_JOB_NAMES].sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must match the immutable exact 24-job production target set.`);
  }
  return actual;
}

export function productionTargetsForApp(appName) {
  if (appName !== PRODUCTION_CONTAINER_APP) {
    throw new Error(`Production target app must be exactly ${PRODUCTION_CONTAINER_APP}.`);
  }
  return PRODUCTION_TARGETS;
}

export function assertExactProductionTargets(actualTargets) {
  if (!Array.isArray(actualTargets)) throw new Error("Production targets must be an array.");
  const canonical = (target) => `${target?.resourceGroup}:${target?.kind}:${target?.name}`;
  const actual = actualTargets.map(canonical).sort();
  const expected = PRODUCTION_TARGETS.map(canonical).sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Production targets must match the immutable app plus exact 24-job allowlist.");
  }
  return PRODUCTION_TARGETS;
}

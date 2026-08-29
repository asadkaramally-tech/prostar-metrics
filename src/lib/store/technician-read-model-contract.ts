import {
  TECHNICIAN_READ_MODEL_SCHEMA_VERSION,
  type TechnicianPerformanceReadModel,
} from "@/lib/metrics/technicians";

export type TechnicianReadModelContractStatus =
  | { current: true; serveable: true }
  | { current: false; serveable: true; reason: string }
  | { current: false; serveable: false; reason: string };

/**
 * Saved technician models outlive individual deployments. Keep the persisted
 * contract explicit so a UI release cannot silently interpret an older model
 * as if it had current roster semantics.
 */
export function technicianReadModelContractStatus(value: unknown): TechnicianReadModelContractStatus {
  if (!isRecord(value)) return { current: false, serveable: false, reason: "payload is not an object" };
  if (value.netProfitBasis !== "simpro_job_net_profit_actual") {
    return { current: false, serveable: false, reason: "netProfitBasis is not the verified Simpro job basis" };
  }
  if (typeof value.rosterApplied !== "boolean") {
    return { current: false, serveable: false, reason: "rosterApplied is missing or invalid" };
  }
  if (!Array.isArray(value.outsideRoster)) {
    return { current: false, serveable: false, reason: "outsideRoster is missing or invalid" };
  }
  if (!Array.isArray(value.technicians)) {
    return { current: false, serveable: false, reason: "technicians is missing or invalid" };
  }
  if (!isRecord(value.coverage)) {
    return { current: false, serveable: false, reason: "coverage is missing or invalid" };
  }
  if (value.schemaVersion !== TECHNICIAN_READ_MODEL_SCHEMA_VERSION) {
    return {
      current: false,
      serveable: true,
      reason: `schemaVersion ${String(value.schemaVersion ?? "missing")} is not ${TECHNICIAN_READ_MODEL_SCHEMA_VERSION}`,
    };
  }
  return { current: true, serveable: true };
}

export function assertCurrentTechnicianReadModel(value: unknown, context: string): TechnicianPerformanceReadModel {
  const status = technicianReadModelContractStatus(value);
  if (!status.current) {
    throw new Error(`Stale technician read model (${context}): ${status.reason}. Rebuild this month before serving it.`);
  }
  return value as TechnicianPerformanceReadModel;
}

/** Versionless models with every verified roster field remain readable during
 * a rolling deploy, but they are still stale and the migration queues them for
 * replacement. Models missing roster evidence are never synthesized. */
export function assertServeableTechnicianReadModel(value: unknown, context: string): void {
  const status = technicianReadModelContractStatus(value);
  if (!status.serveable) {
    throw new Error(`Stale technician read model (${context}): ${status.reason}. Rebuild this month before serving it.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

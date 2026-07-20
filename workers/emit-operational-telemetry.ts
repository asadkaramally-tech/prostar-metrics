import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import { getOperationalDataHealth } from "@/lib/store/data-health";
import {
  acknowledgeOperationalTelemetrySignal,
  claimOperationalTelemetrySignals,
  type OperationalTelemetrySignal,
} from "@/lib/store/operational-telemetry";

async function main() {
  const model = await getOperationalDataHealth();
  const common = {
    event: "prostar_metrics_operational_health",
    generatedAt: model.generatedAt,
    status: model.summary.status,
    queueDepth: model.summary.queueDepth,
    failedWorkCount: model.summary.failedWorkCount,
    deadLetterCount: model.summary.deadLetterCount,
    backfillPercentComplete: model.backfill.percentComplete,
  };

  await writeOperationalTelemetryLine({
    ...common,
    severity: model.summary.status === "critical" ? "critical" : model.summary.status === "attention" ? "warning" : "info",
    alertId: "operational-summary",
    eventKey: stableEventKey("operational-summary", [
      model.summary.status,
      model.summary.queueDepth,
      model.summary.failedWorkCount,
      model.summary.deadLetterCount,
      model.backfill.percentComplete,
    ]),
  });

  for (const alert of model.alerts) {
    const evidenceAt = alert.occurredAt === model.generatedAt ? null : alert.occurredAt;
    await writeOperationalTelemetryLine({
      ...common,
      severity: alert.severity,
      alertId: alert.id,
      eventKey: stableEventKey("data-health-alert", [
        alert.id,
        alert.severity,
        alert.title,
        alert.detail,
        evidenceAt,
      ]),
      title: alert.title,
      detail: alert.detail,
      occurredAt: alert.occurredAt,
    });
  }

  const leaseOwner = `operational-telemetry-worker-${process.pid}-${randomUUID()}`;
  const signals = await claimOperationalTelemetrySignals(undefined, { leaseOwner });
  for (const signal of signals) {
    await emitClaimedOperationalTelemetrySignal(signal, leaseOwner);
  }
}

export async function emitClaimedOperationalTelemetrySignal(
  signal: OperationalTelemetrySignal,
  leaseOwner: string,
  options: {
    output?: Writable;
    acknowledge?: (eventKey: string, leaseOwner: string) => Promise<boolean>;
  } = {},
) {
  await writeOperationalTelemetryLine(signal, options.output);
  const acknowledge = options.acknowledge ?? acknowledgeOperationalTelemetrySignal;
  if (!await acknowledge(signal.eventKey, leaseOwner)) {
    throw new Error(`Operational telemetry delivery lease was lost for ${signal.eventKey}.`);
  }
}

export function writeOperationalTelemetryLine(
  payload: unknown,
  output: Writable = process.stdout,
): Promise<void> {
  if (output.destroyed || output.writableEnded) {
    return Promise.reject(new Error("Operational telemetry output is not writable."));
  }

  const line = `${JSON.stringify(payload)}\n`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let writeReturned = false;
    let writeConfirmed = false;
    let requiresDrain = false;
    let drainObserved = false;

    const cleanup = (retainErrorListener = false) => {
      if (!retainErrorListener) output.off("error", onError);
      output.off("close", onClose);
      output.off("drain", onDrain);
    };
    const fail = (error: unknown, retainErrorListener = false) => {
      if (settled) return;
      settled = true;
      cleanup(retainErrorListener);
      if (retainErrorListener) {
        setImmediate(() => output.off("error", onError));
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const completeIfConfirmed = () => {
      if (settled || !writeReturned || !writeConfirmed || (requiresDrain && !drainObserved)) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error("Operational telemetry output closed before handoff was confirmed."));
    const onDrain = () => {
      drainObserved = true;
      completeIfConfirmed();
    };

    output.once("error", onError);
    output.once("close", onClose);
    output.once("drain", onDrain);

    try {
      requiresDrain = !output.write(line, (error) => {
        if (error) {
          // Node emits the same failure on the stream after invoking this callback.
          fail(error, true);
          return;
        }
        writeConfirmed = true;
        completeIfConfirmed();
      });
      writeReturned = true;
      if (!requiresDrain) {
        drainObserved = true;
        output.off("drain", onDrain);
      }
      completeIfConfirmed();
    } catch (error) {
      fail(error);
    }
  });
}

function reportFailure(error: unknown) {
  const generatedAt = new Date().toISOString();
  const detail = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    event: "prostar_metrics_operational_health",
    severity: "critical",
    alertId: "telemetry-worker-failed",
    eventKey: stableEventKey("telemetry-worker-failed", [detail]),
    title: "Operational telemetry worker failed",
    detail,
    generatedAt,
  }));
  process.exitCode = 1;
}

function stableEventKey(prefix: string, evidence: unknown[]) {
  const digest = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  return `${prefix}:${digest}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(reportFailure);
}

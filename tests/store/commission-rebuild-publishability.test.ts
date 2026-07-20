import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCommissionRebuildPublishable,
} from "../../src/lib/store/commission-rebuild";
import { publishCommissionReadModelForJob } from "../../src/lib/store/read-model-rebuilds";
import {
  commissionArtifactFromServingRow,
  commissionPayoutServingRow,
  rehashCommissionServingRow,
} from "../helpers/commission-serving";

test("commission rebuild publication fails closed when source evidence is incomplete", () => {
  const artifact = commissionArtifactFromServingRow(commissionPayoutServingRow());
  artifact.sourceComplete = false;
  artifact.sourceEvidence = { ...artifact.sourceEvidence, status: "missing", complete: false };
  assert.throws(
    () => assertCommissionRebuildPublishable(artifact),
    /refusing immutable-run and ready read-model publication/,
  );
});

test("commission rebuild publication accepts complete period evidence", () => {
  assert.doesNotThrow(() => assertCommissionRebuildPublishable(
    commissionArtifactFromServingRow(commissionPayoutServingRow()),
  ));
});

test("publication rejects semantic payout corruption before persistence or current-run assignment", async () => {
  const row = structuredClone(commissionPayoutServingRow());
  const employees = row.employee_results as Array<Record<string, unknown>>;
  const technicians = (row.read_model as { technicians: Array<Record<string, unknown>> }).technicians;
  for (const [index, value] of [[0, 40], [1, 10]] as const) {
    employees[index].finalBonus = value;
    employees[index].payrollBonus = value;
    technicians[index].finalBonus = value;
    technicians[index].payrollBonus = value;
  }
  const artifact = commissionArtifactFromServingRow(rehashCommissionServingRow(row));
  let persistenceAttempted = false;
  await assert.rejects(
    publishCommissionReadModelForJob({
      artifact,
      actorEmail: "worker@example.test",
      job: {
        id: 1,
        metric_family: "commissions",
        period_grain: "month",
        period_start: artifact.periodStart,
        dimensions_json: {},
        locked_by: "worker-1",
      },
    }, async () => {
      persistenceAttempted = true;
      throw new Error("transaction should not open");
    }),
    /integrity verification failed/,
  );
  assert.equal(persistenceAttempted, false);
});

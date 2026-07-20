import { relative } from "node:path";

import { releaseGateAssertionEvent } from "./lib/release-gate-assertions.mjs";

export default async function* evidenceNodeTestReporter(source) {
  const category = process.env.PROSTAR_EVIDENCE_GATE_CATEGORY;
  if (!category) throw new Error("PROSTAR_EVIDENCE_GATE_CATEGORY is required by the evidence test reporter");
  const runner = category === "integration" ? "integration-test" : "node-test";
  let emitted = 0;
  for await (const event of source) {
    if (!event || !["test:pass", "test:fail"].includes(event.type)) continue;
    const data = event.data ?? {};
    if (!data.file || !data.name) throw new Error(`${category} test event lacks concrete file/name provenance`);
    const skipped = Boolean(data.skip);
    const todo = Boolean(data.todo);
    const cancelled = event.type === "test:fail" && data.details?.error?.failureType === "cancelledByParent";
    const outcome = event.type === "test:fail" ? "FAIL" : skipped || todo ? "SKIP" : "PASS";
    const location = `${relative(process.cwd(), data.file).replaceAll("\\", "/")}:${Number(data.line ?? 0)}:${Number(data.column ?? 0)}`;
    const assertion = String(data.name).replace(/[\r\n]+/g, " ").slice(0, 240);
    const counts = {
      total: 1,
      passed: outcome === "PASS" ? 1 : 0,
      failed: outcome === "FAIL" && !cancelled ? 1 : 0,
      skipped: skipped ? 1 : 0,
      cancelled: cancelled ? 1 : 0,
      todo: todo ? 1 : 0,
    };
    yield releaseGateAssertionEvent({
      category,
      outcome,
      provenance: { runner, source: location, assertion },
      counts,
    });
    emitted += 1;
  }
  yield `Observed ${emitted} concrete ${category} test assertions.\n`;
}

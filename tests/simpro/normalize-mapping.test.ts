import assert from "node:assert/strict";
import test from "node:test";
import {
  extractJobSourceQuoteId,
  extractJobStageName,
  extractQuoteLinkedJobId,
  extractQuoteStageNames,
  jobTransitionPeriodStarts,
  projectTotalExTax,
  quoteTransitionPeriodStarts,
} from "../../src/lib/simpro/normalize";

test("quote mapping uses Swagger scalar LinkedJobID and string stages", () => {
  const payload = {
    ID: 1201,
    Stage: "Approved",
    CustomerStage: "Accepted",
    LinkedJobID: 4507,
  };

  assert.equal(extractQuoteLinkedJobId(payload), 4507);
  assert.deepEqual(extractQuoteStageNames(payload), {
    stageName: "Approved",
    customerStageName: "Accepted",
  });
});

test("quote mapping supports scalar compatibility aliases but ignores invented relationship objects", () => {
  assert.equal(extractQuoteLinkedJobId({ linkedJobId: "4508" }), 4508);
  assert.equal(extractQuoteLinkedJobId({ linked_job_id: 4509 }), 4509);
  assert.equal(extractQuoteLinkedJobId({
    LinkedJobID: null,
    linkedJobId: "4510",
    linked_job_id: 4510,
  }), 4510);
  assert.throws(
    () => extractQuoteLinkedJobId({ LinkedJobID: 4510, linked_job_id: 4511 }),
    /direct-link scalar fields conflict/,
  );
  assert.throws(
    () => extractQuoteLinkedJobId({ LinkedJobID: "" }),
    /positive safe-integer scalar ID/,
  );
  assert.throws(
    () => extractQuoteLinkedJobId({ LinkedJobID: { ID: 4510 } }),
    /not a numeric or string scalar ID/,
  );
  assert.equal(
    extractQuoteLinkedJobId({
      LinkedJob: { ID: 9991 },
      Job: { ID: 9992 },
      ConvertedToJob: { ID: 9993 },
    }),
    null,
  );
});

test("quote mapping never promotes descriptive JobNo values to linked job IDs", () => {
  assert.equal(extractQuoteLinkedJobId({ JobNo: 3754, LinkedJobID: null }), null);
  assert.equal(extractQuoteLinkedJobId({ JobNo: "17289" }), null);
  assert.equal(extractQuoteLinkedJobId({ JobNo: "not-a-job-id" }), null);
  assert.equal(extractQuoteLinkedJobId({ JobNo: 3754, LinkedJobID: 16444 }), 16444);
});

test("job mapping rejects ConvertedFromQuote without exact ConvertedFrom Type Quote provenance", () => {
  assert.equal(extractJobSourceQuoteId({ ConvertedFromQuote: { ID: 7001, Name: "Quote 7001" } }), null);
});

test("job mapping accepts ConvertedFrom only when its type is Quote", () => {
  assert.equal(extractJobSourceQuoteId({ ConvertedFrom: { ID: 7002, Type: "Quote" } }), 7002);
  assert.equal(extractJobSourceQuoteId({ ConvertedFrom: { ID: 7003, Type: "Lead" } }), null);
  assert.equal(extractJobSourceQuoteId({ ConvertedFrom: { ID: 7004 } }), null);
  assert.equal(extractJobSourceQuoteId({ ConvertedFrom: { ID: 7005, Type: "quote" } }), null);
  assert.throws(
    () => extractJobSourceQuoteId({
      ConvertedFrom: { ID: 7006, Type: "Quote" },
      convertedFrom: { ID: 7007, Type: "Quote" },
    }),
    /ConvertedFrom ID aliases conflict/,
  );
  assert.throws(
    () => extractJobSourceQuoteId({
      ConvertedFrom: { ID: 7006, Type: "Quote", type: "quote" },
    }),
    /type aliases conflict/,
  );
});

test("job stage mapping uses Swagger Stage and never substitutes Status", () => {
  assert.equal(extractJobStageName({ Stage: "Complete", Status: { ID: 88, Name: "Ready to Bill" } }), "Complete");
  assert.equal(extractJobStageName({ Status: { ID: 88, Name: "Ready to Bill" } }), null);
});

test("project totals require explicit finite ExTax while preserving a legitimate zero", () => {
  assert.equal(projectTotalExTax({ Total: { ExTax: 0, IncTax: 10 } }, "quote", 1), 0);
  assert.equal(projectTotalExTax({ Total: { ExTax: "1,250.50", IncTax: 1400 } }, "job", 2), 1250.5);
  assert.throws(
    () => projectTotalExTax({ Total: { IncTax: 100 } }, "quote", 3),
    /Invalid quote 3 Total\.ExTax/,
  );
  assert.throws(
    () => projectTotalExTax({ Total: { ExTax: "not-money", IncTax: 100 } }, "job", 4),
    /Invalid job 4 Total\.ExTax/,
  );
  assert.throws(
    () => projectTotalExTax({ total: { ExTax: 100 } }, "job", 5),
    /Invalid job 5 Total\.ExTax/,
  );
  for (const malformed of ["$", ",", ".", "1,2", "1,,000", "12.3.4", "1e3", "$$1", "1$"]) {
    assert.throws(
      () => projectTotalExTax({ Total: { ExTax: malformed } }, "quote", 6),
      /Invalid quote 6 Total\.ExTax/,
      `malformed currency ${JSON.stringify(malformed)} must be rejected`,
    );
  }
  assert.equal(projectTotalExTax({ Total: { ExTax: "$0" } }, "quote", 7), 0);
  assert.equal(projectTotalExTax({ Total: { ExTax: "-$1,250.50" } }, "job", 8), -1250.5);
});

test("quote normalization invalidates both old and new decision months", () => {
  assert.deepEqual(quoteTransitionPeriodStarts("2026-05-19", "2026-06-02"), ["2026-05-01", "2026-06-01"]);
  assert.deepEqual(quoteTransitionPeriodStarts("2026-06-01", "2026-06-28"), ["2026-06-01"]);
});

test("job normalization invalidates periods entered or exited using Stage only", () => {
  assert.deepEqual(
    jobTransitionPeriodStarts(
      { completedDate: "2026-05-31", stageName: "Complete" },
      { completedDate: "2026-06-01", stageName: "Archived" },
    ),
    ["2026-05-01", "2026-06-01"],
  );
  assert.deepEqual(
    jobTransitionPeriodStarts(
      { completedDate: "2026-06-01", stageName: "Complete" },
      { completedDate: "2026-06-01", stageName: "In Progress" },
    ),
    ["2026-06-01"],
  );
  assert.deepEqual(
    jobTransitionPeriodStarts(
      { completedDate: "2026-06-01", stageName: "In Progress" },
      { completedDate: "2026-06-01", stageName: "Ready to Bill" },
    ),
    [],
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../../src/app/api/auth/session/route";

test("session route returns only sanitized authenticated owner evidence", async () => {
  const header = encodePrincipal({
    auth_typ: "aad",
    userDetails: "ASAD@PROSTARMECHANICAL.COM",
    access_token: "raw-secret-token",
    claims: [
      { typ: "oid", val: "owner-object-id" },
      { typ: "roles", val: "private-admin-role" },
      { typ: "name", val: "private-display-name" },
    ],
  });
  const response = await GET(sessionRequest(header));
  const responseText = await response.text();
  const payload = JSON.parse(responseText);

  assert.equal(response.status, 200);
  assertJsonNoStore(response);
  assert.deepEqual(payload, {
    authenticated: true,
    principalEmail: "asad@prostarmechanical.com",
    principalId: "owner-object-id",
    provider: "aad",
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    "authenticated",
    "principalEmail",
    "principalId",
    "provider",
  ].sort());
  assert.doesNotMatch(responseText, /raw-secret-token|private-admin-role|private-display-name|claims|roles/);
  assert.doesNotMatch(responseText, new RegExp(header));
});

test("session route has no unauthenticated or development-bypass fallback", async () => {
  const previousBypass = process.env.METRICS_DEV_AUTH_BYPASS;
  process.env.METRICS_DEV_AUTH_BYPASS = "true";
  try {
    const missingHeaderResponse = await GET(sessionRequest());
    assert.equal(missingHeaderResponse.status, 401);
    assertJsonNoStore(missingHeaderResponse);
    assert.deepEqual(await missingHeaderResponse.json(), { error: "Authentication required" });

    const malformedHeaderResponse = await GET(sessionRequest("%%%not-base64%%%"));
    assert.equal(malformedHeaderResponse.status, 401);
    assertJsonNoStore(malformedHeaderResponse);

    const missingIdentityResponse = await GET(sessionRequest(encodePrincipal({
      userDetails: "asad@prostarmechanical.com",
      claims: [{ typ: "roles", val: "admin" }],
    })));
    assert.equal(missingIdentityResponse.status, 401);
    assertJsonNoStore(missingIdentityResponse);
  } finally {
    if (previousBypass === undefined) delete process.env.METRICS_DEV_AUTH_BYPASS;
    else process.env.METRICS_DEV_AUTH_BYPASS = previousBypass;
  }
});

test("session route forbids authenticated principals outside the exact owner allowlist", async () => {
  const response = await GET(sessionRequest(encodePrincipal({
    userDetails: "intruder@prostarmechanical.com",
    claims: [{ typ: "oid", val: "intruder-object-id" }],
  })));

  assert.equal(response.status, 403);
  assertJsonNoStore(response);
  assert.deepEqual(await response.json(), { error: "Forbidden" });
});

function sessionRequest(header?: string): Request {
  return new Request("https://metrics.example.test/api/auth/session", {
    headers: header ? { "x-ms-client-principal": header } : undefined,
  });
}

function assertJsonNoStore(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
}

function encodePrincipal(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredAuthorizedEmails,
  isConfiguredEmailAuthorized,
  principalIdentityFromHeader,
} from "../../src/lib/auth/access-policy";

test("configured access is fail-closed and case-insensitive", () => {
  const env = {
    METRICS_ADMIN_EMAILS: "Asad@ProStarMechanical.com",
    METRICS_FINANCE_EMAILS: "laila@prostarmechanical.com",
  };
  assert.deepEqual([...configuredAuthorizedEmails(env)].sort(), [
    "asad@prostarmechanical.com",
    "laila@prostarmechanical.com",
  ]);
  assert.equal(isConfiguredEmailAuthorized("asad@prostarmechanical.com", env), true);
  assert.equal(isConfiguredEmailAuthorized("unknown@prostarmechanical.com", env), false);
  assert.equal(isConfiguredEmailAuthorized(null, env), false);
});

test("EasyAuth principal parsing uses userDetails and rejects malformed headers", () => {
  const header = Buffer.from(JSON.stringify({ userDetails: "ASAD@PROSTARMECHANICAL.COM" })).toString("base64");
  assert.equal(principalIdentityFromHeader(header).email, "asad@prostarmechanical.com");
  assert.equal(principalIdentityFromHeader("not-base64").email, null);
});

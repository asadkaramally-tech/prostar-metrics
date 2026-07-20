import assert from "node:assert/strict";
import test from "node:test";
import {
  isAllowedSessionOwner,
  parseClientPrincipalHeader,
} from "../../src/lib/auth/session-principal";

const objectIdentifierClaim = "http://schemas.microsoft.com/identity/claims/objectidentifier";

test("session principal parser rejects malformed base64 and JSON", () => {
  const validIdentity = encodePrincipal({
    userDetails: "asad@prostarmechanical.com",
    claims: [{ typ: "oid", val: "owner-id" }],
  });

  assert.equal(parseClientPrincipalHeader(null), null);
  assert.equal(parseClientPrincipalHeader("%%%"), null);
  assert.equal(parseClientPrincipalHeader(`${validIdentity}!`), null);
  assert.equal(parseClientPrincipalHeader(Buffer.from("not-json").toString("base64")), null);
  assert.equal(parseClientPrincipalHeader(Buffer.from("{").toString("base64")), null);
  assert.equal(parseClientPrincipalHeader(encodePrincipal([])), null);
});

test("session principal parser requires both email and object ID", () => {
  assert.equal(parseClientPrincipalHeader(encodePrincipal({
    userDetails: "asad@prostarmechanical.com",
    claims: [],
  })), null);
  assert.equal(parseClientPrincipalHeader(encodePrincipal({
    claims: [{ typ: "oid", val: "owner-id" }],
  })), null);
  assert.equal(parseClientPrincipalHeader(encodePrincipal({
    userDetails: "asad@prostarmechanical.com",
    claims: [{ typ: "oid", val: "  " }],
  })), null);
});

test("session principal parser supports Easy Auth email, object ID, and provider variants", () => {
  assert.deepEqual(parseClientPrincipalHeader(encodePrincipal({
    userDetails: " ASAD@PROSTARMECHANICAL.COM ",
    auth_typ: "AAD",
    claims: [{ typ: "oid", val: " owner-oid " }],
  })), {
    principalEmail: "asad@prostarmechanical.com",
    principalId: "owner-oid",
    provider: "aad",
  });

  assert.deepEqual(parseClientPrincipalHeader(encodePrincipal({
    provider: "aad",
    claims: [
      { typ: "preferred_username", val: "LAILA@PROSTARMECHANICAL.COM" },
      { typ: objectIdentifierClaim, val: "laila-object-id" },
    ],
  })), {
    principalEmail: "laila@prostarmechanical.com",
    principalId: "laila-object-id",
    provider: "aad",
  });

  assert.deepEqual(parseClientPrincipalHeader(encodePrincipal({
    claims: [
      { typ: "email", val: "asad@prostarmechanical.com" },
      { typ: "objectidentifier", val: "fallback-object-id" },
    ],
  })), {
    principalEmail: "asad@prostarmechanical.com",
    principalId: "fallback-object-id",
    provider: "aad",
  });
});

test("session owner allowlist is exact after email normalization", () => {
  assert.equal(isAllowedSessionOwner("ASAD@PROSTARMECHANICAL.COM"), true);
  assert.equal(isAllowedSessionOwner("laila@prostarmechanical.com"), true);
  assert.equal(isAllowedSessionOwner("asad+probe@prostarmechanical.com"), false);
  assert.equal(isAllowedSessionOwner("asad@prostarmechanical.com.example.test"), false);
  assert.equal(isAllowedSessionOwner("unknown@prostarmechanical.com"), false);
});

function encodePrincipal(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

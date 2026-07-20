export type AuthenticatedSessionIdentity = {
  principalEmail: string;
  principalId: string;
  provider: string;
};

const allowedOwnerEmails = new Set([
  "asad@prostarmechanical.com",
  "laila@prostarmechanical.com",
]);

const objectIdentifierClaimTypes = new Set([
  "objectidentifier",
  "http://schemas.microsoft.com/identity/claims/objectidentifier",
]);

export function parseClientPrincipalHeader(value: string | null): AuthenticatedSessionIdentity | null {
  const decoded = decodeBase64(value);
  if (decoded === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const claims = Array.isArray(parsed.claims) ? parsed.claims.filter(isRecord) : [];
  const principalEmail = firstNonEmptyString(
    parsed.userDetails,
    claimValue(claims, new Set(["preferred_username"])),
    claimValue(claims, new Set(["email"])),
  )?.toLowerCase();
  const principalId = firstNonEmptyString(
    claimValue(claims, new Set(["oid"])),
    claimValue(claims, objectIdentifierClaimTypes),
  );

  if (!principalEmail || !principalId) return null;

  return {
    principalEmail,
    principalId,
    provider: firstNonEmptyString(
      parsed.auth_typ,
      parsed.provider,
      parsed.provider_name,
      parsed.identityProvider,
    )?.toLowerCase() ?? "aad",
  };
}

export function isAllowedSessionOwner(email: string): boolean {
  return allowedOwnerEmails.has(email.trim().toLowerCase());
}

function claimValue(claims: Record<string, unknown>[], types: Set<string>): string | undefined {
  for (const claim of claims) {
    const type = firstNonEmptyString(claim.typ)?.toLowerCase();
    if (type && types.has(type)) {
      const value = firstNonEmptyString(claim.val);
      if (value) return value;
    }
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function decodeBase64(value: string | null): string | null {
  const encoded = value?.trim();
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    return null;
  }
  if (encoded.includes("=") && encoded.length % 4 !== 0) return null;

  try {
    const decoded = Buffer.from(encoded, "base64");
    const unpaddedInput = encoded.replace(/=+$/, "");
    const canonical = decoded.toString("base64").replace(/=+$/, "");
    return canonical === unpaddedInput ? decoded.toString("utf8") : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

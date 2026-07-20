export type PrincipalIdentity = {
  email: string | null;
};

type Environment = Readonly<Record<string, string | undefined>>;

type PrincipalPayload = {
  userDetails?: string;
  claims?: Array<{ typ: string; val: string }>;
};

export function principalIdentityFromHeader(value: string | null): PrincipalIdentity {
  if (!value) return { email: null };
  try {
    const principal = JSON.parse(decodeBase64(value)) as PrincipalPayload;
    const email = principal.userDetails
      ?? principal.claims?.find((claim) => claim.typ === "preferred_username")?.val
      ?? principal.claims?.find((claim) => claim.typ === "email")?.val
      ?? null;
    return { email: email?.trim().toLowerCase() || null };
  } catch {
    return { email: null };
  }
}

export function configuredAuthorizedEmails(env: Environment = process.env): Set<string> {
  return new Set(
    [env.METRICS_ADMIN_EMAILS, env.METRICS_FINANCE_EMAILS, env.METRICS_OPERATOR_EMAILS, env.METRICS_VIEWER_EMAILS]
      .flatMap(csvList),
  );
}

export function isConfiguredEmailAuthorized(email: string | null, env: Environment = process.env) {
  return Boolean(email) && configuredAuthorizedEmails(env).has(email as string);
}

function csvList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function decodeBase64(value: string) {
  if (typeof Buffer !== "undefined") return Buffer.from(value, "base64").toString("utf8");
  return globalThis.atob(value);
}

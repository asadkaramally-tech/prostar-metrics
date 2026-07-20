import { headers } from "next/headers";
import { queryPostgres } from "@/lib/store/postgres";

export type AppRole = "admin" | "finance" | "operator" | "viewer";

export type CurrentUser = {
  email: string;
  displayName: string;
  roles: AppRole[];
};

type EasyAuthPrincipal = {
  userDetails?: string;
  userRoles?: string[];
  claims?: Array<{ typ: string; val: string }>;
};

const defaultUser: CurrentUser = {
  email: "unauthenticated",
  displayName: "Authentication Required",
  roles: [],
};

export async function getCurrentUser(): Promise<CurrentUser> {
  if (process.env.METRICS_DEV_AUTH_BYPASS === "true" && process.env.NODE_ENV !== "production") {
    return {
      email: "local.operator@prostarmechanical.com",
      displayName: "Local Operator",
      roles: ["admin", "finance", "operator", "viewer"],
    };
  }

  const headerStore = await headers();
  const principalHeader = headerStore.get("x-ms-client-principal");
  if (process.env.NODE_ENV === "production" && process.env.METRICS_AUTH_MODE !== "easy-auth") {
    return defaultUser;
  }

  if (!principalHeader) {
    return defaultUser;
  }

  const principal = parseEasyAuthPrincipal(principalHeader);
  const email = principal?.userDetails || claimValue(principal, "preferred_username") || claimValue(principal, "email");
  if (!email) {
    return defaultUser;
  }

  return {
    email,
    displayName: email.split("@")[0] || email,
    roles: await rolesForEmail(email),
  };
}

export function assertRole(user: CurrentUser, allowed: AppRole[]): void {
  if (user.roles.some((role) => allowed.includes(role))) {
    return;
  }

  throw new Error(`User ${user.email} does not have one of the required roles: ${allowed.join(", ")}`);
}

function parseEasyAuthPrincipal(value: string): EasyAuthPrincipal | null {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as EasyAuthPrincipal;
  } catch {
    return null;
  }
}

function claimValue(principal: EasyAuthPrincipal | null, type: string): string | undefined {
  return principal?.claims?.find((claim) => claim.typ === type)?.val;
}

async function rolesForEmail(email: string): Promise<AppRole[]> {
  const normalized = email.trim().toLowerCase();
  const dbRoles = await rolesForEmailFromStore(normalized);
  if (dbRoles.length > 0) {
    return dbRoles;
  }

  const roleSets: Array<[AppRole, string | undefined]> = [
    ["admin", process.env.METRICS_ADMIN_EMAILS],
    ["finance", process.env.METRICS_FINANCE_EMAILS],
    ["operator", process.env.METRICS_OPERATOR_EMAILS],
    ["viewer", process.env.METRICS_VIEWER_EMAILS],
  ];

  const roles = roleSets
    .filter(([, csv]) => csvList(csv).includes(normalized))
    .map(([role]) => role);

  return roles;
}

async function rolesForEmailFromStore(email: string): Promise<AppRole[]> {
  if (!process.env.AZURE_POSTGRES_CONNECTION_STRING) {
    return [];
  }

  try {
    const result = await queryPostgres<{ role: AppRole }>(
      `select role::text as role
         from metrics.app_roles
        where lower(email) = $1
          and active = true
        order by role`,
      [email],
    );
    return result.rows.map((row) => row.role).filter(isAppRole);
  } catch {
    return [];
  }
}

function isAppRole(value: string): value is AppRole {
  return value === "admin" || value === "finance" || value === "operator" || value === "viewer";
}

function csvList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

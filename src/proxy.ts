import { NextResponse, type NextRequest } from "next/server";
import { isConfiguredEmailAuthorized, principalIdentityFromHeader } from "@/lib/auth/access-policy";

const publicPathPrefixes = [
  "/.auth/",
  "/_next/",
];

const publicPaths = new Set([
  "/api/health",
  "/icon.svg",
  "/favicon.ico",
  "/robots.txt",
]);

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Local development only — same guard as getCurrentUser (lib/auth/roles.ts),
  // so the documented METRICS_DEV_AUTH_BYPASS flow also clears the Easy Auth
  // proxy. Never active in production builds.
  if (process.env.METRICS_DEV_AUTH_BYPASS === "true" && process.env.NODE_ENV !== "production") {
    return NextResponse.next();
  }

  if (publicPaths.has(pathname) || publicPathPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const principal = request.headers.get("x-ms-client-principal");
  if (principal) {
    const { email } = principalIdentityFromHeader(principal);
    if (isConfiguredEmailAuthorized(email)) {
      return NextResponse.next();
    }
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const loginUrl = new URL("/.auth/login/aad", request.url);
  loginUrl.searchParams.set("post_login_redirect_uri", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!.*\\..*).*)", "/icon.svg", "/favicon.ico"],
};

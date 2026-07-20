import { NextResponse } from "next/server";
import {
  isAllowedSessionOwner,
  parseClientPrincipalHeader,
} from "@/lib/auth/session-principal";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

export async function GET(request: Request) {
  const identity = parseClientPrincipalHeader(request.headers.get("x-ms-client-principal"));
  if (!identity) {
    return jsonResponse({ error: "Authentication required" }, 401);
  }
  if (!isAllowedSessionOwner(identity.principalEmail)) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  return jsonResponse({ authenticated: true, ...identity }, 200);
}

function jsonResponse(body: object, status: number) {
  return NextResponse.json(body, { status, headers: responseHeaders });
}

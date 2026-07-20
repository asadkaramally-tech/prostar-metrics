import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import {
  BoundedSourceWorkConflictError,
  BoundedSourceWorkValidationError,
  enqueueBoundedSourceWork,
  listBoundedSourceWorkRequests,
  parseBoundedSourceWork,
} from "@/lib/store/bounded-source-work";
import { clearPageLoadCache } from "@/lib/store/page-cache";

export async function GET() {
  const user = await getCurrentUser();
  if (!isOwner(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    return NextResponse.json({ requests: await listBoundedSourceWorkRequests() });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error, "Unable to load refresh queue status.") }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!isOwner(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => null);
  try {
    const work = parseBoundedSourceWork(body);
    const reason = typeof body?.reason === "string" ? body.reason : "";
    const queued = await enqueueBoundedSourceWork({
      work,
      reason,
      requestedBy: user.email,
      origin: "manual",
    });
    clearPageLoadCache();
    return NextResponse.json({ request: queued }, { status: queued.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof BoundedSourceWorkValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof BoundedSourceWorkConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: errorMessage(error, "Unable to enqueue bounded source work.") }, { status: 500 });
  }
}

function isOwner(user: Awaited<ReturnType<typeof getCurrentUser>>) {
  try {
    assertRole(user, ["admin"]);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

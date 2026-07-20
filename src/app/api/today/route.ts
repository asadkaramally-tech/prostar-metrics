import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import { getTodayReadModel } from "@/lib/store/today-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

export async function GET() {
  try {
    assertRole(await getCurrentUser(), ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const model = await cachedPageLoad("api:today", 60_000, () => getTodayReadModel());
  return NextResponse.json(model, { status: model.loadError ? 503 : 200 });
}

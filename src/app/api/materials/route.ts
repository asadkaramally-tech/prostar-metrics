import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import { monthParamToPeriodStart } from "@/lib/metrics/periods";
import { getMaterialsReadModel } from "@/lib/store/materials-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

export async function GET(request: Request) {
  try {
    assertRole(await getCurrentUser(), ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const periodStart = monthParamToPeriodStart(url.searchParams.get("month"));
  return NextResponse.json(await cachedPageLoad(`api:materials:${periodStart ?? "current"}`, 120_000, () =>
    getMaterialsReadModel(periodStart),
  ));
}

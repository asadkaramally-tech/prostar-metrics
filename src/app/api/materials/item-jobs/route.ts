import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import { boundedDashboardPeriodStart } from "@/lib/metrics/periods";
import { getMaterialsReadModel } from "@/lib/store/materials-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

export async function GET(request: Request) {
  try {
    assertRole(await getCurrentUser(), ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const searchParams = new URL(request.url).searchParams;
  const key = searchParams.get("key");
  if (!key || key.length > 300) {
    return NextResponse.json({ error: "A material item key is required." }, { status: 400 });
  }

  const periodStart = boundedDashboardPeriodStart(searchParams.get("month"));
  if (!periodStart) return NextResponse.json({ error: "month is outside the supported reporting range." }, { status: 400 });
  const model = await cachedPageLoad(`api:materials:item-jobs:${periodStart}`, 120_000, () =>
    getMaterialsReadModel(periodStart),
  );
  const item = model.items.find((candidate) => candidate.key === key);
  if (!item) return NextResponse.json({ error: "Material item not found." }, { status: 404 });
  return NextResponse.json({ jobIds: item.jobIds, jobCount: item.jobCount });
}

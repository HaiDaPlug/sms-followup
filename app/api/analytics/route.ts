import { NextResponse } from "next/server";
import { getAnalyticsData, type AnalyticsDays } from "@/lib/analytics/getAnalyticsData";
import { parseAttributionDays } from "@/lib/analytics/attributionWindow";

const ALLOWED_DAYS: readonly AnalyticsDays[] = [30, 90, 180, 365];

function parseDays(value: string | null): AnalyticsDays {
  const parsed = Number(value);
  return ALLOWED_DAYS.includes(parsed as AnalyticsDays) ? (parsed as AnalyticsDays) : 90;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const days = parseDays(searchParams.get("days"));
  const attributionDays = parseAttributionDays(searchParams.get("attributionDays"));
  return NextResponse.json(await getAnalyticsData(days, attributionDays));
}

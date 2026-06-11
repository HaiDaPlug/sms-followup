import { NextResponse } from "next/server";
import { processDailyReminders } from "@/lib/reminders/process";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await processDailyReminders();
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  return GET(request);
}

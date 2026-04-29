import { NextResponse } from "next/server";
import { calculateDashboardStats } from "@/lib/reminders/eligibility";

export async function GET() {
  return NextResponse.json(await calculateDashboardStats());
}

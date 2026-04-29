import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/data/repository";

export async function GET() {
  return NextResponse.json(await getSettings());
}

export async function POST(request: Request) {
  const body = await request.json();
  return NextResponse.json(await updateSettings(body));
}

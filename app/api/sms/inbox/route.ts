import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

// GET /api/sms/inbox?limit=50
// Returns incoming SMS joined with patient name for the inbox page.

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? 100), 500);

  const { data, error } = await supabase
    .from("incoming_sms")
    .select("*, patients(id, full_name, normalized_phone)")
    .order("received_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ messages: data ?? [] });
}

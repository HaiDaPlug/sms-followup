import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

// DELETE /api/logs?patientId=xxx  — clear all logs for one patient
// DELETE /api/logs                — clear ALL logs (requires confirm=true in body)
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const patientId = searchParams.get("patientId");

  if (patientId) {
    const { error } = await supabase
      .from("reminder_logs")
      .delete()
      .eq("patient_id", patientId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  // Clear all — require explicit confirmation in body
  const body = await request.json().catch(() => ({})) as { confirm?: boolean };
  if (!body.confirm) {
    return NextResponse.json({ error: "confirm: true krävs för att rensa all historik" }, { status: 400 });
  }

  const { error } = await supabase
    .from("reminder_logs")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000"); // delete all rows
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

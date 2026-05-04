import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

// DELETE /api/logs/:id — delete a single log entry
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { error } = await supabase
    .from("reminder_logs")
    .delete()
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

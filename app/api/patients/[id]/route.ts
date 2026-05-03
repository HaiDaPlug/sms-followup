import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { error } = await supabase.from("patients").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ status: "deleted" });
}

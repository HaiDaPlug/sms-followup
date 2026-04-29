import { NextResponse } from "next/server";
import { updatePatient } from "@/lib/data/repository";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const patient = await updatePatient(id, { do_not_contact: true });

  if (!patient) {
    return NextResponse.json({ error: "Patient not found" }, { status: 404 });
  }

  return NextResponse.json({ status: "updated", patient });
}

import { NextResponse } from "next/server";
import { createId, nowIso, upsertPatient } from "@/lib/data/repository";
import { normalizePhone } from "@/lib/import/normalizers";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const full_name = String(body.full_name ?? "").trim();
  const phone = String(body.phone ?? "").trim() || null;
  const email = String(body.email ?? "").trim().toLowerCase() || null;

  if (!full_name) {
    return NextResponse.json({ error: "Namn krävs" }, { status: 400 });
  }

  const normalized_phone = normalizePhone(phone);
  if (phone && !normalized_phone) {
    return NextResponse.json({ error: "Ogiltigt telefonnummer" }, { status: 400 });
  }

  const parts = full_name.trim().split(/\s+/);
  const now = nowIso();

  const patient = await upsertPatient({
    id: createId("patient"),
    full_name,
    first_name: parts[0] ?? null,
    last_name: parts.length > 1 ? parts.slice(1).join(" ") : null,
    phone,
    normalized_phone,
    email: email && email.includes("@") ? email : null,
    last_booking_at: null,
    latest_treatment: null,
    has_future_booking: false,
    do_not_contact: false,
    source: "manual",
    created_at: now,
    updated_at: now,
  });

  return NextResponse.json({ status: "created", patient }, { status: 201 });
}

import { importBokaDirektCsv } from "@/lib/import/bokadirekt";
import { addReviewItem, readStore, resetPatientCycle } from "@/lib/data/repository";
import { normalizePhone } from "@/lib/import/normalizers";

export async function handleBokaDirektWebhook(payload: Record<string, unknown>) {
  const row = payload.booking ?? payload;

  if (typeof row === "object" && row !== null) {
    const values = row as Record<string, unknown>;
    const headers = Object.keys(values);
    const csv = `${headers.join(";")}\n${headers
      .map((header) => String(values[header] ?? "").replaceAll(";", ","))
      .join(";")}`;

    const summary = await importBokaDirektCsv(csv);

    // Find the patient this booking belongs to and reset their SMS cycle
    const phone = String(values.phone ?? values.Phone ?? values.mobilnummer ?? "");
    const email = String(values.email ?? values.Email ?? values.epost ?? "");
    if (phone || email) {
      const store = await readStore();
      const normalizedPhone = phone ? normalizePhone(phone) : null;
      const patient = store.patients.find(
        (p) =>
          (normalizedPhone && p.normalized_phone === normalizedPhone) ||
          (email && p.email?.toLowerCase() === email.toLowerCase())
      );
      if (patient) {
        // Find the newest booking for this patient to attach the reset to
        const latestBooking = store.bookings
          .filter((b) => b.patient_id === patient.id)
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
        await resetPatientCycle(patient.id, latestBooking?.id ?? null);
      }
    }

    await addReviewItem({
      type: "webhook_received",
      severity: "low",
      title: "BokaDirekt webhook mottagen",
      description: "Rådata sparad och bokning importerad/matchad.",
      suggested_action: "Verifiera händelsemappningen när riktiga webhook-prover anländer.",
      status: "open",
      raw_data: payload
    });

    return { ok: true, summary };
  }

  await addReviewItem({
    type: "webhook_invalid_payload",
    severity: "high",
    title: "Ogiltigt BokaDirekt webhook-payload",
    description: "Webhook-payload var inte ett objekt.",
    suggested_action: "Kontrollera BokaDirekt webhook-konfigurationen.",
    status: "open",
    raw_data: { payload }
  });

  return { ok: false };
}

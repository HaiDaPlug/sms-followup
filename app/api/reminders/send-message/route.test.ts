import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReminderLog } from "@/types/clinic";

const repoMock = vi.hoisted(() => ({
  addReviewItem: vi.fn(),
  readStore: vi.fn(),
  updateReminderLog: vi.fn(),
  updateReviewItem: vi.fn(),
}));
const eligibilityMock = vi.hoisted(() => ({
  calculatePatientReminderStatus: vi.fn(),
  latestValidBooking: vi.fn(),
}));
const providerMock = vi.hoisted(() => ({ sendSms: vi.fn() }));
const deliveryMock = vi.hoisted(() => ({ resolveDelivery: vi.fn() }));
const supabaseMock = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/lib/data/repository", () => repoMock);
vi.mock("@/lib/reminders/eligibility", () => eligibilityMock);
vi.mock("@/lib/sms/provider", () => providerMock);
vi.mock("@/lib/sms/resolveDelivery", () => deliveryMock);
vi.mock("@/lib/supabase/client", () => ({ supabase: supabaseMock }));

import { POST } from "./route";

function resolvedQuery<T>(data: T) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.insert = vi.fn(() => chain);
  chain.single = vi.fn().mockResolvedValue({ data, error: null });
  return chain;
}

const reservation: ReminderLog = {
  id: "log-retry",
  patient_id: "patient-1",
  booking_id: "booking-1",
  phone: "+46701234567",
  message: "Ny text",
  status: "pending",
  sequence_number: 2,
  step_id: null,
  step_day: null,
  is_cycle_reset: false,
  provider_message_id: null,
  skip_reason: null,
  error: null,
  sent_at: null,
  created_at: "2026-08-12T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();

  const reviewQuery = resolvedQuery({
    id: "review-1",
    type: "failed_sms",
    status: "open",
    raw_data: {
      patient_id: "patient-1",
      sequence_number: 2,
      booking_id: "booking-1",
    },
  });
  const reservationQuery = resolvedQuery(reservation);
  supabaseMock.from.mockImplementation((table: string) =>
    table === "review_items" ? reviewQuery : reservationQuery
  );

  repoMock.readStore.mockResolvedValue({
    patients: [{ id: "patient-1", normalized_phone: "+46701234567" }],
    bookings: [],
    reminder_settings: [{ dry_run_mode: false }],
    reminder_logs: [],
    review_items: [],
  });
  eligibilityMock.latestValidBooking.mockReturnValue({ id: "booking-1" });
  eligibilityMock.calculatePatientReminderStatus.mockReturnValue("Ready");
  providerMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "elks-1" });
  deliveryMock.resolveDelivery.mockResolvedValue({
    status: "failed",
    error: "46elks rapporterar att meddelandet inte kunde levereras",
    succeeded: false,
  });
  repoMock.updateReminderLog.mockResolvedValue({
    ...reservation,
    status: "failed",
    error: "46elks rapporterar att meddelandet inte kunde levereras",
  });
  repoMock.updateReviewItem.mockResolvedValue({ id: "review-1", status: "open" });
});

function retryRequest() {
  return new Request("http://localhost/api/reminders/send-message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ review_id: "review-1", message: "Ny text" }),
  });
}

describe("failed SMS retry", () => {
  it("refreshes the existing review item instead of creating another open failure", async () => {
    const first = await POST(retryRequest());
    const second = await POST(retryRequest());

    expect(first.status).toBe(502);
    expect(second.status).toBe(502);
    expect(repoMock.addReviewItem).not.toHaveBeenCalled();
    expect(repoMock.updateReviewItem).toHaveBeenCalledTimes(2);
    expect(repoMock.updateReviewItem).toHaveBeenLastCalledWith(
      "review-1",
      expect.objectContaining({
        status: "open",
        description: "46elks rapporterar att meddelandet inte kunde levereras",
        raw_data: expect.objectContaining({
          patient_id: "patient-1",
          booking_id: "booking-1",
          sequence_number: 2,
          rendered_message: "Ny text",
        }),
      })
    );

    const payload = await second.json();
    expect(payload.error).toBe("46elks rapporterar att meddelandet inte kunde levereras");
    expect(payload.outcome.detail).toBe("46elks rapporterar att meddelandet inte kunde levereras");
  });
});

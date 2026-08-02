import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseChain, pgrst116NotFound } from "@/test/mockSupabase";

const { supabaseMock } = vi.hoisted(() => ({
  supabaseMock: { from: vi.fn(), rpc: vi.fn() }
}));

vi.mock("@/lib/supabase/client", () => ({ supabase: supabaseMock }));

import { cancelScheduledSms, claimDueScheduledSms, completeScheduledSms } from "./store";

beforeEach(() => {
  supabaseMock.from.mockReset();
  supabaseMock.rpc.mockReset();
});

describe("cancelScheduledSms", () => {
  it("cancels a pending row and scopes the update to status = pending", async () => {
    const row = { id: "sched-1", status: "cancelled" };
    const chain = makeSupabaseChain({ data: row, error: null });
    supabaseMock.from.mockReturnValue(chain);

    const result = await cancelScheduledSms("sched-1");

    expect(result).toEqual(row);
    expect(supabaseMock.from).toHaveBeenCalledWith("scheduled_sms");
    expect(chain.eq).toHaveBeenCalledWith("status", "pending");
  });

  it("is a no-op (returns null) when the row is no longer pending", async () => {
    const chain = makeSupabaseChain(pgrst116NotFound());
    supabaseMock.from.mockReturnValue(chain);

    const result = await cancelScheduledSms("sched-1");

    expect(result).toBeNull();
  });
});

describe("completeScheduledSms", () => {
  it("completes a claimed row and scopes the update to status = processing", async () => {
    const row = { id: "sched-1", status: "sent" };
    const chain = makeSupabaseChain({ data: row, error: null });
    supabaseMock.from.mockReturnValue(chain);

    const result = await completeScheduledSms("sched-1", "sent", "log-1", null);

    expect(result).toEqual(row);
    expect(chain.eq).toHaveBeenCalledWith("status", "processing");
  });

  it("throws instead of silently overwriting a row that is no longer processing", async () => {
    const chain = makeSupabaseChain(pgrst116NotFound());
    supabaseMock.from.mockReturnValue(chain);

    await expect(
      completeScheduledSms("sched-1", "sent", "log-1", null)
    ).rejects.toThrow();
  });
});

describe("claimDueScheduledSms", () => {
  it("claims due rows via the atomic RPC with the requested limit", async () => {
    const claimed = [{ id: "sched-1", status: "processing" }];
    supabaseMock.rpc.mockResolvedValue({ data: claimed, error: null });

    const result = await claimDueScheduledSms(10);

    expect(result).toEqual(claimed);
    expect(supabaseMock.rpc).toHaveBeenCalledWith("claim_due_scheduled_sms", { p_limit: 10 });
  });
});

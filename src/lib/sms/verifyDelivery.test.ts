import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.SMS_PROVIDER = "46elks";
process.env.FORTYSIX_ELKS_USERNAME = "u";
process.env.FORTYSIX_ELKS_PASSWORD = "p";
// Poll interval is 1500ms, so this budget allows ~3 lookups. Kept just wide
// enough to exercise multi-poll behaviour without slowing the suite down.
process.env.SMS_VERIFY_BUDGET_MS = "3200";

import { verifyDelivery } from "./provider";

function elksResponse(status: string) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: "elks-1", status })
  } as Response;
}

const fetchMock = vi.fn();

const DEFAULT_BUDGET_MS = "3200";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.SMS_VERIFY_DELIVERY;
  // Restored here because individual tests narrow it.
  process.env.SMS_VERIFY_BUDGET_MS = DEFAULT_BUDGET_MS;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyDelivery", () => {
  it("polls past the initial 'created' instead of giving up on the first lookup", async () => {
    // 46elks answers "created" immediately and only progresses once the
    // operator responds. A single lookup would learn nothing.
    fetchMock
      .mockResolvedValueOnce(elksResponse("created"))
      .mockResolvedValueOnce(elksResponse("sent"))
      .mockResolvedValueOnce(elksResponse("delivered"));

    const result = await verifyDelivery("elks-1");

    expect(result.status).toBe("delivered");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns as soon as there is a verdict, without burning the budget", async () => {
    fetchMock.mockResolvedValue(elksResponse("failed"));

    const result = await verifyDelivery("elks-1");

    expect(result.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up as pending at the deadline so the caller keeps 'sent'", async () => {
    // Tight budget: one immediate lookup, then the deadline passes.
    process.env.SMS_VERIFY_BUDGET_MS = "50";
    fetchMock.mockResolvedValue(elksResponse("created"));

    const result = await verifyDelivery("elks-1");

    // Never "failed": no verdict is not evidence the SMS failed to arrive.
    expect(result.status).toBe("pending");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps a hanging lookup by the remaining overall budget", async () => {
    process.env.SMS_VERIFY_BUDGET_MS = "50";
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true }
        );
      })
    );

    const startedAt = Date.now();
    const result = await verifyDelivery("elks-1");
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe("unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("stops retrying a persistently unreachable status API", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    const result = await verifyDelivery("elks-1");

    expect(result.status).toBe("unreachable");
    // One retry for a transient blip, then stop rather than spend the budget.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips entirely when disabled, without contacting the provider", async () => {
    process.env.SMS_VERIFY_DELIVERY = "off";

    const result = await verifyDelivery("elks-1");

    expect(result.status).toBe("unsupported");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports unsupported when there is no provider message id", async () => {
    const result = await verifyDelivery("");
    expect(result.status).toBe("unsupported");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const repoMock = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("@/lib/data/repository", () => repoMock);

import { POST } from "./route";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function post(body: unknown) {
  return POST(new Request("http://localhost/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  repoMock.updateSettings.mockImplementation(async (input: Record<string, unknown>) => ({ id: "settings-1", ...input }));
});

describe("POST /api/settings", () => {
  it("mints ids for id-less steps while the stored steps have none", async () => {
    repoMock.getSettings.mockResolvedValue({ sms_steps: [{ day: 5, template: "a" }] });

    const res = await post({ sms_steps: [{ day: 5, template: "a" }, { day: 14, template: "b" }] });

    expect(res.status).toBe(200);
    const saved = repoMock.updateSettings.mock.calls[0][0] as { sms_steps: Array<{ id: string; active: boolean }> };
    expect(saved.sms_steps).toHaveLength(2);
    for (const step of saved.sms_steps) {
      expect(step.id).toMatch(UUID_RE);
      expect(step.active).toBe(true);
    }
  });

  it("rejects an id-less post once the stored steps carry ids, without writing", async () => {
    repoMock.getSettings.mockResolvedValue({ sms_steps: [{ id: ID_A, day: 5, template: "a" }] });

    const res = await post({ sms_steps: [{ day: 5, template: "a" }] });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Ladda om sidan och försök igen" });
    expect(repoMock.updateSettings).not.toHaveBeenCalled();
  });

  it("preserves posted ids and passes the rest of the body through", async () => {
    repoMock.getSettings.mockResolvedValue({ sms_steps: [{ id: ID_A, day: 5, template: "a" }] });

    const res = await post({
      is_active: false,
      sms_steps: [{ id: ID_B, day: 90, template: "b" }, { id: ID_A, day: 5, template: "a2" }],
    });

    expect(res.status).toBe(200);
    expect(repoMock.updateSettings).toHaveBeenCalledWith({
      is_active: false,
      sms_steps: [
        { id: ID_A, day: 5, template: "a2", active: true },
        { id: ID_B, day: 90, template: "b", active: true },
      ],
    });
  });

  it("does not consult the stored steps when sms_steps is absent", async () => {
    const res = await post({ dry_run_mode: true });

    expect(res.status).toBe(200);
    expect(repoMock.getSettings).not.toHaveBeenCalled();
    expect(repoMock.updateSettings).toHaveBeenCalledWith({ dry_run_mode: true });
  });

  it("rejects duplicate days with a 400", async () => {
    repoMock.getSettings.mockResolvedValue({ sms_steps: null });

    const res = await post({ sms_steps: [{ id: ID_A, day: 5, template: "a" }, { id: ID_B, day: 5, template: "b" }] });

    expect(res.status).toBe(400);
    expect(repoMock.updateSettings).not.toHaveBeenCalled();
  });
});

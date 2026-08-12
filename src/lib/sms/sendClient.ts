import { defaultMessage, type SendOutcome, type SendOutcomeKind } from "./outcome";

/**
 * Single client-side entry point for triggering a send.
 *
 * Every caller previously did its own `res.json()` plus a bespoke
 * `status === "sent" || status === "dry_run"` check. That pattern silently
 * reported `skipped` and `unknown` as success, which is how a send blocked by
 * the duplicate guard came back as "Skickat ✓". Parsing in one place means a new
 * outcome kind cannot be mishandled by a call site that forgot about it.
 */

export type SendRequest = {
  patientId: string;
  sequenceOverride?: number;
  forceNext?: boolean;
};

/** Never throws: transport problems come back as an `unknown` outcome. */
export async function requestSend(request: SendRequest): Promise<SendOutcome> {
  const body: SendRequest = { patientId: request.patientId, forceNext: request.forceNext ?? true };
  if (request.sequenceOverride !== undefined) body.sequenceOverride = request.sequenceOverride;

  let response: Response;
  try {
    response = await fetch("/api/reminders/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // The request may or may not have reached the server, so this is `unknown`
    // rather than `failed` — the same reasoning the server applies to an
    // uncertain provider response.
    return {
      kind: "unknown",
      message: "Nätverksfel — kunde inte bekräfta om SMS:et skickades",
      detail: "Kontrollera anslutningen och SMS-historiken innan du skickar igen.",
    };
  }

  const data = (await response.json().catch(() => ({}))) as {
    outcome?: SendOutcome;
    status?: string;
    error?: string;
  };

  if (data.outcome) return data.outcome;

  // Fallback for a response shape without an outcome (e.g. an early validation
  // error). Map conservatively: never infer success from a missing outcome.
  const kind: SendOutcomeKind = response.ok ? "unknown" : "failed";
  return {
    kind,
    message: data.error ?? defaultMessage(kind),
    detail: response.ok ? null : `HTTP ${response.status}`,
  };
}

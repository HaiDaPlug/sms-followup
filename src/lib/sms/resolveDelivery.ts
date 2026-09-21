import { verifyDelivery, type SendSmsResult } from "./provider";

/** The log status a send resolves to, plus why, once the provider is consulted. */
export type ResolvedDelivery = {
  status: "sent" | "delivered" | "unknown" | "failed";
  /** Error to persist: provider error first, else the verification reason. */
  error: string | null;
  succeeded: boolean;
};

/**
 * Turn a raw provider send result into the status to persist, polling for a
 * delivery verdict when the send was accepted.
 *
 * Shared by the cron/scheduled path (process.ts) and the failed-SMS retry route
 * (/api/reminders/send-message) so the two cannot classify identical provider
 * behaviour differently.
 *
 * Only a `failed` verdict is treated as new information: a status API that is
 * unreachable, or that has no verdict yet, is not evidence the SMS failed to
 * arrive, and downgrading on that basis would invite a duplicate re-send.
 *
 * Lives apart from outcome.ts so that module stays free of provider imports and
 * can be used from client components.
 */
export async function resolveDelivery(result: SendSmsResult): Promise<ResolvedDelivery> {
  let status: ResolvedDelivery["status"] =
    result.success ? "sent" : result.uncertain ? "unknown" : "failed";
  let verificationError: string | null = null;

  if (result.success && result.providerMessageId) {
    const verified = await verifyDelivery(result.providerMessageId);
    if (verified.status === "delivered") {
      status = "delivered";
    } else if (verified.status === "failed") {
      status = "failed";
      verificationError = verified.error ?? "Leverantören rapporterar misslyckad leverans";
    } else if (verified.status === "unreachable") {
      // Keep the send as-is, but record why it could not be confirmed.
      verificationError = verified.error ?? null;
    }
  }

  const succeeded = status === "sent" || status === "delivered";
  return { status, error: result.error ?? verificationError, succeeded };
}

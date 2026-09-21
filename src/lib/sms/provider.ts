export type SendSmsInput = {
  to: string;
  message: string;
};

export type SendSmsResult = {
  success: boolean;
  providerMessageId?: string;
  error?: string;
  /** The provider may have accepted the SMS, so an automatic retry is unsafe. */
  uncertain?: boolean;
};

/**
 * What the provider says about a message AFTER it was handed over.
 *
 * A successful send only means the provider accepted the HTTP request. This is
 * the separate question of what happened to the message itself.
 *
 *   delivered  -- provider confirms it reached the handset
 *   failed     -- provider confirms it did not, `error` says why
 *   pending    -- still in flight; no verdict yet
 *   unsupported -- this provider has no status API, or the message has no id
 *   unreachable -- the status API itself could not be queried
 *
 * `unsupported` and `unreachable` are deliberately distinct from `failed`:
 * neither is evidence the SMS did not arrive, and treating them as failure
 * would invite a duplicate re-send.
 */
export type DeliveryStatus = "delivered" | "failed" | "pending" | "unsupported" | "unreachable";

export type VerifyDeliveryResult = {
  status: DeliveryStatus;
  /** Raw provider status string, for logging and review items. */
  providerStatus?: string;
  error?: string;
};

/** Per-request timeout for a single status lookup. */
const VERIFY_REQUEST_TIMEOUT_MS = 4000;

/** Gap between polls while the provider still reports created/sent. */
const VERIFY_POLL_INTERVAL_MS = 1500;

/**
 * Total wall-clock budget per send. Deliberately small: the daily batch sends
 * sequentially inside a serverless function, so this is spent per patient. A
 * verdict that has not arrived within it is left to the delivery webhook.
 *
 * Read per call, not at module load, so the value is not frozen into the bundle.
 */
function verifyBudgetMs(): number {
  const configured = Number(process.env.SMS_VERIFY_BUDGET_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 6000;
}

/** Consecutive unreachable lookups before giving up on the status API. */
const VERIFY_MAX_UNREACHABLE = 2;

function elksCredentials() {
  const username = process.env.FORTYSIX_ELKS_USERNAME;
  const password = process.env.FORTYSIX_ELKS_PASSWORD;
  if (!username || !password) return null;
  return {
    authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
  };
}

function using46Elks(): boolean {
  return process.env.SMS_PROVIDER === "46elks" || Boolean(process.env.FORTYSIX_ELKS_USERNAME);
}

/** One status lookup. Exported for tests; callers should use verifyDelivery. */
export async function fetchDeliveryStatus(
  providerMessageId: string,
  timeoutMs = VERIFY_REQUEST_TIMEOUT_MS
): Promise<VerifyDeliveryResult> {
  const credentials = elksCredentials();
  if (!credentials) {
    return { status: "unsupported", error: "46elks-uppgifter saknas" };
  }

  try {
    const response = await fetch(
      `https://api.46elks.com/a1/SMS/${encodeURIComponent(providerMessageId)}`,
      {
        method: "GET",
        headers: { Authorization: credentials.authorization },
        // Never let a hung status call stall a batch: the send already
        // succeeded, and an unanswered check is only a missing confirmation.
        signal: AbortSignal.timeout(Math.max(1, Math.min(VERIFY_REQUEST_TIMEOUT_MS, Math.floor(timeoutMs))))
      }
    );
    const rawText = await response.text();

    if (!response.ok) {
      return {
        status: "unreachable",
        error: `46elks status ${response.status}: ${rawText.slice(0, 200)}`
      };
    }

    let payload: { status?: string; delivered?: string } = {};
    try {
      payload = JSON.parse(rawText);
    } catch {
      return { status: "unreachable", error: "Kunde inte tolka svaret från 46elks" };
    }

    // 46elks progresses asynchronously: created -> sent -> delivered | failed.
    switch (payload.status) {
      case "delivered":
        return { status: "delivered", providerStatus: payload.status };
      case "failed":
        return {
          status: "failed",
          providerStatus: payload.status,
          error: "46elks rapporterar att meddelandet inte kunde levereras"
        };
      case "created":
      case "sent":
        return { status: "pending", providerStatus: payload.status };
      default:
        return {
          status: "pending",
          providerStatus: payload.status,
          error: `Okänd leveransstatus från 46elks: ${payload.status ?? "(saknas)"}`
        };
    }
  } catch (error) {
    return {
      status: "unreachable",
      error: error instanceof Error ? error.message : "Kunde inte nå 46elks status-API"
    };
  }
}

/**
 * Ask the provider what actually happened to a message, instead of inferring
 * delivery from the fact that the send request was accepted.
 *
 * 46elks answers "created" immediately and only progresses to delivered/failed
 * once the operator responds, so a single lookup straight after sending nearly
 * always learns nothing. This polls until there is a verdict or the deadline
 * passes, whichever comes first.
 *
 * Bounded on purpose: the daily batch sends sequentially, so this budget is per
 * patient. A `pending` result at the deadline leaves the log as "sent" and hands
 * the question to the delivery webhook, which needs no deadline at all.
 *
 * This complements that webhook rather than replacing it — the webhook is only
 * registered when NEXT_PUBLIC_APP_URL is https AND SMS_DELIVERY_WEBHOOK_SECRET
 * is set (see sendWith46Elks below); when either is missing, polling is the only
 * delivery signal there is.
 */
export async function verifyDelivery(providerMessageId: string): Promise<VerifyDeliveryResult> {
  if (!providerMessageId) {
    return { status: "unsupported", error: "Inget meddelande-ID från leverantören" };
  }
  if (!using46Elks()) {
    return { status: "unsupported" };
  }
  // Escape hatch: set SMS_VERIFY_DELIVERY=off if the per-send budget ever costs
  // more than the confirmation is worth.
  if (process.env.SMS_VERIFY_DELIVERY === "off") {
    return { status: "unsupported" };
  }

  const deadline = Date.now() + verifyBudgetMs();
  let last: VerifyDeliveryResult = { status: "pending" };
  let unreachableCount = 0;

  for (let attempt = 0; ; attempt++) {
    // First lookup is immediate: a hard failure (bad number) is often already
    // final, and there is no reason to wait for it.
    if (attempt > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(VERIFY_POLL_INTERVAL_MS, remaining));
    }

    // Sleeping can consume the final slice of the budget. Re-check before
    // starting network work, then cap that request by the time actually left.
    const requestBudget = deadline - Date.now();
    if (requestBudget <= 0) break;
    last = await fetchDeliveryStatus(providerMessageId, requestBudget);

    // delivered/failed are final; unsupported means there is nothing to poll.
    if (last.status !== "pending" && last.status !== "unreachable") return last;

    // A transient network blip is worth another try, but repeated failures mean
    // the API is down — stop rather than burning the whole budget on it.
    if (last.status === "unreachable") {
      unreachableCount += 1;
      if (unreachableCount >= VERIFY_MAX_UNREACHABLE) return last;
    } else {
      unreachableCount = 0;
    }

    if (Date.now() >= deadline) break;
  }

  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendSms({ to, message }: SendSmsInput): Promise<SendSmsResult> {
  if (using46Elks()) {
    return sendWith46Elks({ to, message });
  }

  const url = process.env.SMS_PROVIDER_WEBHOOK_URL;
  const apiKey = process.env.SMS_PROVIDER_API_KEY;

  if (!url) {
    return {
      success: false,
      error: "SMS_PROVIDER_WEBHOOK_URL is not configured"
    };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({ to, message })
    });

    const payload = (await response.json().catch(() => ({}))) as {
      id?: string;
      messageId?: string;
      error?: string;
    };

    if (!response.ok) {
      return {
        success: false,
        error: payload.error ?? `SMS provider returned ${response.status}`
      };
    }

    return {
      success: true,
      providerMessageId: payload.messageId ?? payload.id
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown SMS provider error",
      uncertain: true,
    };
  }
}

async function sendWith46Elks({ to, message }: SendSmsInput): Promise<SendSmsResult> {
  const from = process.env.FORTYSIX_ELKS_FROM;
  const credentials = elksCredentials();

  if (!credentials) {
    return {
      success: false,
      error: "FORTYSIX_ELKS_USERNAME and FORTYSIX_ELKS_PASSWORD are not configured"
    };
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const deliverySecret = process.env.SMS_DELIVERY_WEBHOOK_SECRET;
  const deliveryUrl = appUrl.startsWith("https://") && deliverySecret
    ? `${appUrl}/api/webhooks/sms-delivery?token=${encodeURIComponent(deliverySecret)}`
    : undefined;

  const form = new URLSearchParams({
    to,
    message,
    ...(from ? { from } : {}),
    ...(deliveryUrl ? { whendelivered: deliveryUrl } : {})
  });

  try {
    const response = await fetch("https://api.46elks.com/a1/SMS", {
      method: "POST",
      headers: {
        Authorization: credentials.authorization,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
      },
      body: form.toString()
    });
    const rawText = await response.text();
    let payload: { id?: string; error?: string; message?: string } = {};
    try { payload = JSON.parse(rawText); } catch { /* not JSON */ }

    if (!response.ok) {
      return {
        success: false,
        error: `46elks ${response.status}: ${payload.error ?? payload.message ?? rawText}`
      };
    }

    return {
      success: true,
      providerMessageId: payload.id
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown 46elks error",
      uncertain: true,
    };
  }
}

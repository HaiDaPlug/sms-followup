export type SendSmsInput = {
  to: string;
  message: string;
};

export type SendSmsResult = {
  success: boolean;
  providerMessageId?: string;
  error?: string;
};

export async function sendSms({ to, message }: SendSmsInput): Promise<SendSmsResult> {
  if (process.env.SMS_PROVIDER === "46elks" || process.env.FORTYSIX_ELKS_USERNAME) {
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
      error: error instanceof Error ? error.message : "Unknown SMS provider error"
    };
  }
}

async function sendWith46Elks({ to, message }: SendSmsInput): Promise<SendSmsResult> {
  const username = process.env.FORTYSIX_ELKS_USERNAME;
  const password = process.env.FORTYSIX_ELKS_PASSWORD;
  const from = process.env.FORTYSIX_ELKS_FROM;

  if (!username || !password) {
    return {
      success: false,
      error: "FORTYSIX_ELKS_USERNAME and FORTYSIX_ELKS_PASSWORD are not configured"
    };
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const deliveryUrl = appUrl.startsWith("https://")
    ? `${appUrl}/api/webhooks/sms-delivery`
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
        Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
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
      error: error instanceof Error ? error.message : "Unknown 46elks error"
    };
  }
}

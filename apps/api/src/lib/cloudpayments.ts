import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config.js";

const CLOUDPAYMENTS_ORDERS_URL = "https://api.cloudpayments.ru/orders/create";

type CloudPaymentsOrderResponse = {
  Success?: boolean;
  Message?: string | null;
  Model?: {
    Id?: string;
    Url?: string;
  } | null;
};

export function isCloudPaymentsConfigured() {
  return Boolean(env.CLOUDPAYMENTS_PUBLIC_ID && env.CLOUDPAYMENTS_API_SECRET);
}

export function parseRublesToKopecks(value: unknown) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null;
  }

  const [rubles, kopecks = ""] = normalized.split(".");
  const result = Number(rubles) * 100 + Number(kopecks.padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : null;
}

function matchesHmac(value: string | undefined, message: Buffer, secret: string) {
  if (!value) return false;

  const expected = createHmac("sha256", secret).update(message).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(value, "base64");
  } catch {
    return false;
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyCloudPaymentsHmac(input: {
  rawBody: Buffer;
  contentHmac?: string;
  decodedContentHmac?: string;
}) {
  const secret = env.CLOUDPAYMENTS_API_SECRET;
  if (!secret) return false;

  if (matchesHmac(input.contentHmac, input.rawBody, secret)) {
    return true;
  }

  const decoded = Buffer.from(decodeURIComponent(input.rawBody.toString("utf8").replace(/\+/g, " ")), "utf8");
  return matchesHmac(input.decodedContentHmac, decoded, secret);
}

export async function createCloudPaymentsOrder(input: {
  orderId: string;
  userId: string;
  phone: string;
  amountKopecks: number;
}) {
  if (!env.CLOUDPAYMENTS_PUBLIC_ID || !env.CLOUDPAYMENTS_API_SECRET || !env.PUBLIC_WEB_URL) {
    throw new Error("PAYMENT_PROVIDER_NOT_CONFIGURED");
  }

  const body = new URLSearchParams({
    Amount: (input.amountKopecks / 100).toFixed(2),
    Currency: "RUB",
    Description: `Пополнение баланса Callsec, заказ ${input.orderId}`,
    InvoiceId: input.orderId,
    AccountId: input.userId,
    Phone: input.phone,
    SendEmail: "false",
    SendSms: "false",
    RequireConfirmation: "false",
    CultureName: "ru-RU",
    SuccessRedirectUrl: new URL("/dashboard?payment=success", env.PUBLIC_WEB_URL).toString(),
    FailRedirectUrl: new URL("/dashboard?payment=failed", env.PUBLIC_WEB_URL).toString()
  });

  if (env.CLOUDPAYMENTS_OFFER_URL) {
    body.set("OfferUri", env.CLOUDPAYMENTS_OFFER_URL);
  }

  const credentials = Buffer.from(`${env.CLOUDPAYMENTS_PUBLIC_ID}:${env.CLOUDPAYMENTS_API_SECRET}`).toString("base64");
  const response = await fetch(CLOUDPAYMENTS_ORDERS_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body,
    signal: AbortSignal.timeout(15_000)
  });
  const payload = (await response.json().catch(() => ({}))) as CloudPaymentsOrderResponse;
  const paymentUrl = payload.Model?.Url;

  if (!response.ok || !payload.Success || !paymentUrl) {
    throw new Error(payload.Message?.trim() || `CloudPayments order creation failed (${response.status})`);
  }

  return { paymentUrl };
}

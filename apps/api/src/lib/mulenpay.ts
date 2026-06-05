import { createHash } from "node:crypto";
import { env } from "../config.js";

type CreateMulenPaymentPayload = {
  uuid: string;
  amountRub: number;
  description: string;
};

type MulenPaymentResponse = {
  success?: boolean;
  paymentUrl?: string;
  id?: number | string;
};

export function isMulenPayConfigured() {
  return Boolean(env.MULENPAY_API_KEY && env.MULENPAY_SECRET_KEY && env.MULENPAY_SHOP_ID);
}

function formatAmountRub(amountRub: number) {
  return amountRub.toFixed(2);
}

function createSign(payload: { currency: string; amount: string; shopId: number; uuid: string }) {
  const signSource = env.MULENPAY_SIGN_WITH_UUID
    ? `${payload.currency}${payload.amount}${payload.shopId}${payload.uuid}${env.MULENPAY_SECRET_KEY}`
    : `${payload.currency}${payload.amount}${payload.shopId}${env.MULENPAY_SECRET_KEY}`;

  return createHash("sha1").update(signSource).digest("hex");
}

function parseMulenResponse(responseText: string) {
  if (!responseText) {
    return {};
  }

  try {
    return JSON.parse(responseText) as MulenPaymentResponse;
  } catch {
    return {};
  }
}

export async function createMulenPayment(payload: CreateMulenPaymentPayload) {
  if (!isMulenPayConfigured()) {
    throw new Error("MULENPAY_NOT_CONFIGURED");
  }

  const currency = "rub";
  const amount = formatAmountRub(payload.amountRub);
  const shopId = env.MULENPAY_SHOP_ID!;
  const body = {
    currency,
    amount,
    uuid: payload.uuid,
    shopId,
    description: payload.description,
    website_url: env.MULENPAY_WEBSITE_URL || env.CORS_ORIGIN,
    subscribe: null,
    holdTime: null,
    language: "ru",
    items: [
      {
        description: payload.description,
        quantity: 1,
        price: payload.amountRub,
        vat_code: 0,
        payment_subject: 10,
        payment_mode: 1,
        measurement_unit: 0
      }
    ],
    sign: createSign({ currency, amount, shopId, uuid: payload.uuid })
  };

  const response = await fetch(`${env.MULENPAY_BASE_URL.replace(/\/$/, "")}/v2/payments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MULENPAY_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const responseText = await response.text();
  const responsePayload = parseMulenResponse(responseText);

  if (!response.ok) {
    throw new Error(`MULENPAY_CREATE_FAILED:${response.status}:${responseText.slice(0, 300)}`);
  }

  if (!responsePayload.paymentUrl || responsePayload.id === undefined || responsePayload.id === null) {
    throw new Error(`MULENPAY_BAD_RESPONSE:${responseText.slice(0, 300)}`);
  }

  return {
    providerPaymentId: String(responsePayload.id),
    paymentUrl: responsePayload.paymentUrl
  };
}

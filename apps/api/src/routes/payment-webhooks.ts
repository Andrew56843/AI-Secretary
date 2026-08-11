import { BillingTransactionType, PaymentOrderStatus, Prisma } from "@prisma/client";
import { Router, raw, type Request, type Response } from "express";
import { createBalanceLedgerEntry } from "../lib/balance-ledger.js";
import { parseRublesToKopecks, verifyCloudPaymentsHmac } from "../lib/cloudpayments.js";
import { prisma } from "../lib/prisma.js";

const paymentWebhooksRouter = Router();
const rawBody = raw({ type: "*/*", limit: "64kb" });

type WebhookPayload = Record<string, unknown>;

function parsePayload(body: Buffer, contentType: string | undefined): WebhookPayload {
  const text = body.toString("utf8");
  if (contentType?.includes("application/json")) {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as WebhookPayload) : {};
  }

  return Object.fromEntries(new URLSearchParams(text));
}

function getField(payload: WebhookPayload, ...names: string[]) {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return null;
}

function isAuthenticWebhook(req: Request) {
  if (!Buffer.isBuffer(req.body)) return false;

  return verifyCloudPaymentsHmac({
    rawBody: req.body,
    contentHmac: req.header("content-hmac") ?? undefined,
    decodedContentHmac: req.header("x-content-hmac") ?? undefined
  });
}

function cloudPaymentsResponse(res: Response, code = 0) {
  res.json({ code });
}

async function validateOrder(payload: WebhookPayload) {
  const invoiceId = getField(payload, "InvoiceId", "invoiceId");
  const accountId = getField(payload, "AccountId", "accountId");
  const amountKopecks = parseRublesToKopecks(getField(payload, "Amount", "amount"));
  const currency = getField(payload, "Currency", "currency");

  if (!invoiceId) return { ok: false as const, code: 10 };
  const order = await prisma.paymentOrder.findUnique({ where: { id: invoiceId } });
  if (!order) return { ok: false as const, code: 10 };
  if (!accountId || accountId !== order.userId) return { ok: false as const, code: 11 };
  if (amountKopecks === null || amountKopecks !== order.amountKopecks || currency !== "RUB") {
    return { ok: false as const, code: 12 };
  }

  return { ok: true as const, order };
}

paymentWebhooksRouter.post("/check", rawBody, async (req, res) => {
  if (!isAuthenticWebhook(req)) {
    res.status(401).json({ code: 13 });
    return;
  }

  const validated = await validateOrder(parsePayload(req.body, req.header("content-type") ?? undefined));
  cloudPaymentsResponse(
    res,
    validated.ok && validated.order.status === PaymentOrderStatus.PENDING ? 0 : validated.ok ? 13 : validated.code
  );
});

paymentWebhooksRouter.post("/pay", rawBody, async (req, res) => {
  if (!isAuthenticWebhook(req)) {
    res.status(401).json({ code: 13 });
    return;
  }

  const payload = parsePayload(req.body, req.header("content-type") ?? undefined);
  const validated = await validateOrder(payload);
  if (!validated.ok) {
    cloudPaymentsResponse(res, validated.code);
    return;
  }

  const transactionId = getField(payload, "TransactionId", "transactionId");
  const status = getField(payload, "Status", "status");
  if (!transactionId || (status && status !== "Completed")) {
    cloudPaymentsResponse(res, 13);
    return;
  }

  if (validated.order.status === PaymentOrderStatus.SUCCEEDED) {
    cloudPaymentsResponse(res, validated.order.providerTransactionId === transactionId ? 0 : 10);
    return;
  }
  if (validated.order.status !== PaymentOrderStatus.PENDING) {
    cloudPaymentsResponse(res, 13);
    return;
  }

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.paymentOrder.updateMany({
      where: { id: validated.order.id, status: PaymentOrderStatus.PENDING },
      data: {
        status: PaymentOrderStatus.SUCCEEDED,
        providerTransactionId: transactionId,
        paidAt: new Date()
      }
    });

    if (claimed.count === 0) return;

    await createBalanceLedgerEntry(tx, {
      userId: validated.order.userId,
      type: BillingTransactionType.TOP_UP,
      amountKopecks: validated.order.amountKopecks,
      note: `CloudPayments order ${validated.order.id}, transaction ${transactionId}`
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  cloudPaymentsResponse(res);
});

paymentWebhooksRouter.post("/fail", rawBody, async (req, res) => {
  if (!isAuthenticWebhook(req)) {
    res.status(401).json({ code: 13 });
    return;
  }

  const validated = await validateOrder(parsePayload(req.body, req.header("content-type") ?? undefined));
  if (validated.ok) {
    await prisma.paymentOrder.updateMany({
      where: { id: validated.order.id, status: PaymentOrderStatus.PENDING },
      data: { status: PaymentOrderStatus.FAILED }
    });
  }
  cloudPaymentsResponse(res, validated.ok ? 0 : validated.code);
});

paymentWebhooksRouter.post("/refund", rawBody, async (req, res) => {
  if (!isAuthenticWebhook(req)) {
    res.status(401).json({ code: 13 });
    return;
  }

  const payload = parsePayload(req.body, req.header("content-type") ?? undefined);
  const validated = await validateOrder(payload);
  if (!validated.ok) {
    cloudPaymentsResponse(res, validated.code);
    return;
  }

  const paymentTransactionId = getField(payload, "PaymentTransactionId", "paymentTransactionId");
  if (!paymentTransactionId || paymentTransactionId !== validated.order.providerTransactionId) {
    cloudPaymentsResponse(res, 10);
    return;
  }

  if (validated.order.status === PaymentOrderStatus.REFUNDED) {
    cloudPaymentsResponse(res);
    return;
  }
  if (validated.order.status !== PaymentOrderStatus.SUCCEEDED) {
    cloudPaymentsResponse(res, 13);
    return;
  }

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.paymentOrder.updateMany({
      where: { id: validated.order.id, status: PaymentOrderStatus.SUCCEEDED },
      data: { status: PaymentOrderStatus.REFUNDED, refundedAt: new Date() }
    });

    if (claimed.count === 0) return;

    await createBalanceLedgerEntry(tx, {
      userId: validated.order.userId,
      type: BillingTransactionType.PAYMENT_REFUND,
      amountKopecks: -validated.order.amountKopecks,
      allowNegativeBalance: true,
      note: `CloudPayments refund for order ${validated.order.id}`
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  cloudPaymentsResponse(res);
});

export { paymentWebhooksRouter };

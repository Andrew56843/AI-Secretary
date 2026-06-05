import { randomUUID } from "node:crypto";
import { BillingTransactionType, CallDirection, PaymentOrderStatus, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { billingAmountRub, kopecksToRubles, rublesToKopecks } from "../lib/money.js";
import { createMulenPayment, isMulenPayConfigured } from "../lib/mulenpay.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/require-auth.js";

const billingRouter = Router();

const NUMBER_RENT_PRICE_RUB = 299;
const NUMBER_RENT_PRICE_KOPECKS = rublesToKopecks(NUMBER_RENT_PRICE_RUB);
const NUMBER_RENT_PERIOD_DAYS = 30;
const NUMBER_RENEWAL_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const BILLING_CHARGE_TYPES = [BillingTransactionType.CALL_CHARGE, BillingTransactionType.NUMBER_PURCHASE];

const topUpSchema = z.object({
  amountRub: z.number().int().min(100).max(500000)
});

const mulenCallbackSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  amount: z.union([z.number(), z.string()]).optional(),
  currency: z.string().optional(),
  uuid: z.string().min(1),
  payment_status: z.string().min(1)
});

const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(6)
});

function createPagination(page: number, pageSize: number, total: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const normalizedPage = Math.min(page, totalPages);

  return {
    page: normalizedPage,
    pageSize,
    total,
    totalPages,
    hasPreviousPage: normalizedPage > 1,
    hasNextPage: normalizedPage < totalPages
  };
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

function getNumberRentDaysLeft(expiresAt: Date | null) {
  if (!expiresAt) {
    return null;
  }

  return Math.ceil((expiresAt.getTime() - Date.now()) / DAY_MS);
}

function canRenewNumber(expiresAt: Date | null) {
  const daysLeft = getNumberRentDaysLeft(expiresAt);
  return daysLeft === null || daysLeft <= NUMBER_RENEWAL_WINDOW_DAYS;
}

function amountToKopecks(amount: number | string) {
  const normalizedAmount = Number(amount);
  if (!Number.isFinite(normalizedAmount)) {
    return null;
  }

  return Math.round(normalizedAmount * 100);
}

function paymentStatusFromMulen(status: string) {
  const normalizedStatus = status.trim().toLowerCase();
  if (normalizedStatus === "success") {
    return PaymentOrderStatus.PAID;
  }
  if (normalizedStatus === "cancel") {
    return PaymentOrderStatus.CANCELED;
  }

  return PaymentOrderStatus.PROCESSING;
}

function createPaymentUuid() {
  return `topup_${randomUUID()}`;
}

type BillingTransactionWithMoney = {
  amountRub: number | null;
  amountKopecks: number | null;
};

function serializeBillingTransaction<T extends BillingTransactionWithMoney>(transaction: T) {
  return {
    ...transaction,
    amountRub: billingAmountRub(transaction.amountRub, transaction.amountKopecks)
  };
}

async function rentOrRenewNumber(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      rubleBalance: true,
      rubleBalanceKopecks: true,
      numberPurchasedAt: true,
      numberRentExpiresAt: true
    }
  });

  if (user.rubleBalanceKopecks < NUMBER_RENT_PRICE_KOPECKS) {
    throw new Error("INSUFFICIENT_BALANCE");
  }

  const inboundProfile = await tx.assistantProfile.findUnique({
    where: { userId_mode: { userId, mode: CallDirection.INBOUND } },
    include: { reservedNumber: true }
  });

  if (!inboundProfile) {
    throw new Error("PROFILE_NOT_FOUND");
  }

  const isNewRent = !inboundProfile.reservedNumberId;
  let number = inboundProfile.reservedNumber;

  if (!isNewRent && !canRenewNumber(user.numberRentExpiresAt)) {
    throw new Error("RENEWAL_TOO_EARLY");
  }

  if (isNewRent) {
    const freeNumber = await tx.reservedPhoneNumber.findFirst({
      where: { assigned: false },
      orderBy: { number: "asc" }
    });

    if (!freeNumber) {
      throw new Error("NO_FREE_NUMBERS");
    }

    number = await tx.reservedPhoneNumber.update({
      where: { id: freeNumber.id },
      data: { assigned: true }
    });

    await tx.assistantProfile.update({
      where: { id: inboundProfile.id },
      data: { reservedNumberId: freeNumber.id }
    });
  }

  const now = new Date();
  const startsAt = user.numberRentExpiresAt && user.numberRentExpiresAt > now ? user.numberRentExpiresAt : now;
  const numberRentExpiresAt = addDays(startsAt, NUMBER_RENT_PERIOD_DAYS);

  await tx.user.update({
    where: { id: userId },
    data: {
      rubleBalance: { decrement: NUMBER_RENT_PRICE_RUB },
      rubleBalanceKopecks: { decrement: NUMBER_RENT_PRICE_KOPECKS },
      numberPurchasedAt: user.numberPurchasedAt ?? now,
      numberRentExpiresAt
    }
  });

  await tx.billingTransaction.create({
    data: {
      userId,
      type: "NUMBER_PURCHASE",
      amountSeconds: 0,
      amountRub: -NUMBER_RENT_PRICE_RUB,
      amountKopecks: -NUMBER_RENT_PRICE_KOPECKS,
      note: `${isNewRent ? "Reserved" : "Renewed"} phone number ${number?.number ?? ""}`.trim()
    }
  });

  return number;
}

async function getBillingState(userId: string) {
  const [user, inboundProfile, transactions] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        rubleBalance: true,
        rubleBalanceKopecks: true,
        minuteBalanceSeconds: true,
        totalPurchasedSeconds: true,
        numberPurchasedAt: true,
        numberRentExpiresAt: true
      }
    }),
    prisma.assistantProfile.findUnique({
      where: { userId_mode: { userId, mode: CallDirection.INBOUND } },
      include: { reservedNumber: true }
    }),
    prisma.billingTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 12
    })
  ]);

  return {
    rubleBalance: kopecksToRubles(user.rubleBalanceKopecks),
    minuteBalanceSeconds: user.minuteBalanceSeconds,
    totalPurchasedSeconds: user.totalPurchasedSeconds,
    numberPurchasedAt: user.numberPurchasedAt,
    numberRentExpiresAt: user.numberRentExpiresAt,
    numberRentalPriceRub: NUMBER_RENT_PRICE_RUB,
    numberRenewalAvailable: canRenewNumber(user.numberRentExpiresAt),
    numberRentDaysLeft: getNumberRentDaysLeft(user.numberRentExpiresAt),
    reservedNumber: inboundProfile?.reservedNumber ?? null,
    transactions: transactions.map(serializeBillingTransaction)
  };
}

billingRouter.post("/mulenpay/callback", async (req, res) => {
  const parsed = mulenCallbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const callback = parsed.data;
  const nextStatus = paymentStatusFromMulen(callback.payment_status);

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const order = await tx.paymentOrder.findUnique({
          where: { uuid: callback.uuid }
        });

        if (!order) {
          return { status: "NOT_FOUND" as const };
        }

        if (callback.currency && callback.currency.toLowerCase() !== "rub") {
          return { status: "CURRENCY_MISMATCH" as const };
        }

        if (nextStatus === PaymentOrderStatus.PAID && callback.amount !== undefined) {
          const callbackKopecks = amountToKopecks(callback.amount);
          if (callbackKopecks === null || callbackKopecks !== order.amountRub * 100) {
            return { status: "AMOUNT_MISMATCH" as const };
          }
        }

        const providerPaymentId = callback.id === undefined ? order.providerPaymentId : String(callback.id);

        if (nextStatus === PaymentOrderStatus.PAID) {
          if (order.status !== PaymentOrderStatus.PAID) {
            await tx.paymentOrder.update({
              where: { id: order.id },
              data: {
                status: PaymentOrderStatus.PAID,
                providerPaymentId,
                rawStatus: callback.payment_status,
                completedAt: new Date()
              }
            });

            await tx.user.update({
              where: { id: order.userId },
              data: {
                rubleBalance: { increment: order.amountRub },
                rubleBalanceKopecks: { increment: rublesToKopecks(order.amountRub) }
              }
            });

            await tx.billingTransaction.create({
              data: {
                userId: order.userId,
                type: "TOP_UP",
                amountSeconds: 0,
                amountRub: order.amountRub,
                amountKopecks: rublesToKopecks(order.amountRub),
                note: `Mulen Pay top-up ${order.uuid}`
              }
            });
          }

          return { status: "OK" as const };
        }

        if (order.status !== PaymentOrderStatus.PAID) {
          await tx.paymentOrder.update({
            where: { id: order.id },
            data: {
              status: nextStatus,
              providerPaymentId,
              rawStatus: callback.payment_status,
              completedAt: nextStatus === PaymentOrderStatus.CANCELED ? new Date() : null
            }
          });
        }

        return { status: "OK" as const };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    if (result.status === "NOT_FOUND") {
      res.status(404).json({ message: "Payment order not found" });
      return;
    }
    if (result.status === "CURRENCY_MISMATCH") {
      res.status(400).json({ message: "Payment currency mismatch" });
      return;
    }
    if (result.status === "AMOUNT_MISMATCH") {
      res.status(400).json({ message: "Payment amount mismatch" });
      return;
    }

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Payment callback failed" });
  }
});

billingRouter.get("/me", requireAuth, async (req, res) => {
  res.json({ billing: await getBillingState(req.user!.userId) });
});

billingRouter.get("/charges", requireAuth, async (req, res) => {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid pagination", errors: parsed.error.flatten() });
    return;
  }

  const { page, pageSize } = parsed.data;
  const where = {
    userId: req.user!.userId,
    type: {
      in: BILLING_CHARGE_TYPES
    }
  };
  const total = await prisma.billingTransaction.count({ where });
  const pagination = createPagination(page, pageSize, total);
  const transactions = await prisma.billingTransaction.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (pagination.page - 1) * pageSize,
    take: pageSize
  });

  res.json({ transactions: transactions.map(serializeBillingTransaction), pagination });
});

billingRouter.post("/top-up", requireAuth, async (req, res) => {
  const parsed = topUpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const amountRub = parsed.data.amountRub;

  try {
    if (isMulenPayConfigured()) {
      const paymentOrder = await prisma.paymentOrder.create({
        data: {
          userId: req.user!.userId,
          uuid: createPaymentUuid(),
          amountRub
        }
      });

      try {
        const payment = await createMulenPayment({
          uuid: paymentOrder.uuid,
          amountRub,
          description: "AI Secretary balance top-up"
        });

        const updatedPaymentOrder = await prisma.paymentOrder.update({
          where: { id: paymentOrder.id },
          data: {
            providerPaymentId: payment.providerPaymentId,
            paymentUrl: payment.paymentUrl
          }
        });

        res.status(201).json({
          billing: await getBillingState(req.user!.userId),
          payment: {
            id: updatedPaymentOrder.id,
            uuid: updatedPaymentOrder.uuid,
            status: updatedPaymentOrder.status,
            paymentUrl: updatedPaymentOrder.paymentUrl
          }
        });
      } catch (paymentError) {
        await prisma.paymentOrder.update({
          where: { id: paymentOrder.id },
          data: {
            status: PaymentOrderStatus.FAILED,
            rawStatus: paymentError instanceof Error ? paymentError.message.slice(0, 500) : "MULENPAY_CREATE_FAILED"
          }
        });

        throw paymentError;
      }

      return;
    }

    if (env.NODE_ENV === "production") {
      res.status(503).json({ message: "Payment provider is not configured" });
      return;
    }

    await prisma.$transaction(
      async (tx) => {
        await tx.user.update({
          where: { id: req.user!.userId },
          data: {
            rubleBalance: { increment: amountRub },
            rubleBalanceKopecks: { increment: rublesToKopecks(amountRub) }
          }
        });

        await tx.billingTransaction.create({
          data: {
            userId: req.user!.userId,
            type: "TOP_UP",
            amountSeconds: 0,
            amountRub,
            amountKopecks: rublesToKopecks(amountRub),
            note: "Development balance top-up"
          }
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    res.status(201).json({ billing: await getBillingState(req.user!.userId) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("MULENPAY_")) {
      res.status(502).json({ message: "Payment provider is temporarily unavailable" });
      return;
    }
    if (error instanceof Error && error.message === "NO_FREE_NUMBERS") {
      res.status(409).json({ message: "No free phone numbers available now" });
      return;
    }
    if (error instanceof Error && error.message === "PROFILE_NOT_FOUND") {
      res.status(404).json({ message: "Create inbound profile first" });
      return;
    }
    throw error;
  }
});

billingRouter.post("/number-rental", requireAuth, async (req, res) => {
  try {
    await prisma.$transaction((tx) => rentOrRenewNumber(tx, req.user!.userId), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });

    res.status(201).json({ billing: await getBillingState(req.user!.userId) });
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      res.status(402).json({ message: "Not enough balance to rent or renew the phone number." });
      return;
    }
    if (error instanceof Error && error.message === "NO_FREE_NUMBERS") {
      res.status(409).json({ message: "No free phone numbers available now" });
      return;
    }
    if (error instanceof Error && error.message === "PROFILE_NOT_FOUND") {
      res.status(404).json({ message: "Create inbound profile first" });
      return;
    }
    if (error instanceof Error && error.message === "RENEWAL_TOO_EARLY") {
      res.status(409).json({ message: "Number renewal is available when less than 14 days remain." });
      return;
    }
    throw error;
  }
});

export { billingRouter };

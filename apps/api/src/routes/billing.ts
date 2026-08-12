import { BillingTransactionType, CallDirection, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { kopecksToRubles } from "../lib/money.js";
import {
  canRenewNumber,
  getNumberRentDaysLeft,
  NUMBER_RENT_PRICE_RUB,
  rentOrRenewNumber
} from "../lib/number-rental.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/require-auth.js";

const billingRouter = Router();

const BILLING_HISTORY_TYPES = [
  BillingTransactionType.CALL_CHARGE,
  BillingTransactionType.NUMBER_PURCHASE,
  BillingTransactionType.ADMIN_ADJUSTMENT,
  BillingTransactionType.TOP_UP,
  BillingTransactionType.PAYMENT_REFUND
];

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

type BillingTransactionWithMoney = {
  amountKopecks: number;
};

function serializeBillingTransaction<T extends BillingTransactionWithMoney>(transaction: T) {
  return {
    ...transaction,
    amountRub: kopecksToRubles(transaction.amountKopecks)
  };
}

async function getBillingState(userId: string) {
  const [user, inboundProfile, transactions, ledgerBalance] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
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
    }),
    prisma.billingTransaction.aggregate({
      where: { userId },
      _sum: { amountKopecks: true }
    })
  ]);

  return {
    rubleBalance: kopecksToRubles(ledgerBalance._sum.amountKopecks ?? 0),
    numberPurchasedAt: user.numberPurchasedAt,
    numberRentExpiresAt: user.numberRentExpiresAt,
    numberRentalPriceRub: NUMBER_RENT_PRICE_RUB,
    numberRenewalAvailable: canRenewNumber(user.numberRentExpiresAt),
    numberRentDaysLeft: getNumberRentDaysLeft(user.numberRentExpiresAt),
    reservedNumber: inboundProfile?.reservedNumber ?? null,
    transactions: transactions.map(serializeBillingTransaction)
  };
}

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
      in: BILLING_HISTORY_TYPES
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

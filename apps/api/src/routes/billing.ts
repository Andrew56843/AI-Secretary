import { BillingTransactionType, CallDirection, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/require-auth.js";

const billingRouter = Router();

const NUMBER_RENT_PRICE_RUB = 299;
const NUMBER_RENT_PERIOD_DAYS = 30;
const NUMBER_RENEWAL_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const topUpSchema = z.object({
  amountRub: z.number().int().min(100).max(500000)
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

async function rentOrRenewNumber(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      rubleBalance: true,
      numberPurchasedAt: true,
      numberRentExpiresAt: true
    }
  });

  if (user.rubleBalance < NUMBER_RENT_PRICE_RUB) {
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
    rubleBalance: user.rubleBalance,
    minuteBalanceSeconds: user.minuteBalanceSeconds,
    totalPurchasedSeconds: user.totalPurchasedSeconds,
    numberPurchasedAt: user.numberPurchasedAt,
    numberRentExpiresAt: user.numberRentExpiresAt,
    numberRentalPriceRub: NUMBER_RENT_PRICE_RUB,
    numberRenewalAvailable: canRenewNumber(user.numberRentExpiresAt),
    numberRentDaysLeft: getNumberRentDaysLeft(user.numberRentExpiresAt),
    reservedNumber: inboundProfile?.reservedNumber ?? null,
    transactions
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
    type: BillingTransactionType.CALL_CHARGE
  };
  const total = await prisma.billingTransaction.count({ where });
  const pagination = createPagination(page, pageSize, total);
  const transactions = await prisma.billingTransaction.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (pagination.page - 1) * pageSize,
    take: pageSize
  });

  res.json({ transactions, pagination });
});

billingRouter.post("/top-up", requireAuth, async (req, res) => {
  const parsed = topUpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const amountRub = parsed.data.amountRub;

  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.user.update({
          where: { id: req.user!.userId },
          data: {
            rubleBalance: { increment: amountRub }
          }
        });

        await tx.billingTransaction.create({
          data: {
            userId: req.user!.userId,
            type: "TOP_UP",
            amountSeconds: 0,
            amountRub,
            note: "Balance top-up"
          }
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    res.status(201).json({ billing: await getBillingState(req.user!.userId) });
  } catch (error) {
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

import { CallDirection, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/require-auth.js";

const billingRouter = Router();

const topUpSchema = z.object({
  minutes: z.number().int().min(10).max(10000),
  amountRub: z.number().int().positive().optional()
});

async function reserveNumberIfNeeded(tx: Prisma.TransactionClient, userId: string) {
  const inboundProfile = await tx.assistantProfile.findUnique({
    where: { userId_mode: { userId, mode: CallDirection.INBOUND } },
    include: { reservedNumber: true }
  });

  if (!inboundProfile) {
    throw new Error("PROFILE_NOT_FOUND");
  }

  if (inboundProfile.reservedNumberId) {
    return inboundProfile.reservedNumber;
  }

  const freeNumber = await tx.reservedPhoneNumber.findFirst({
    where: { assigned: false },
    orderBy: { number: "asc" }
  });

  if (!freeNumber) {
    throw new Error("NO_FREE_NUMBERS");
  }

  await tx.reservedPhoneNumber.update({
    where: { id: freeNumber.id },
    data: { assigned: true }
  });

  await tx.assistantProfile.update({
    where: { id: inboundProfile.id },
    data: { reservedNumberId: freeNumber.id }
  });

  await tx.user.update({
    where: { id: userId },
    data: { numberPurchasedAt: new Date() }
  });

  await tx.billingTransaction.create({
    data: {
      userId,
      type: "NUMBER_PURCHASE",
      amountSeconds: 0,
      note: `Reserved phone number ${freeNumber.number}`
    }
  });

  return freeNumber;
}

async function getBillingState(userId: string) {
  const [user, inboundProfile, transactions] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        rubleBalance: true,
        minuteBalanceSeconds: true,
        totalPurchasedSeconds: true,
        numberPurchasedAt: true
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
    reservedNumber: inboundProfile?.reservedNumber ?? null,
    transactions
  };
}

billingRouter.get("/me", requireAuth, async (req, res) => {
  res.json({ billing: await getBillingState(req.user!.userId) });
});

billingRouter.post("/top-up", requireAuth, async (req, res) => {
  const parsed = topUpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const amountSeconds = parsed.data.minutes * 60;
  const amountRub = parsed.data.amountRub ?? parsed.data.minutes * 9;

  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.user.update({
          where: { id: req.user!.userId },
          data: {
            minuteBalanceSeconds: { increment: amountSeconds },
            rubleBalance: { increment: amountRub },
            totalPurchasedSeconds: { increment: amountSeconds }
          }
        });

        await tx.billingTransaction.create({
          data: {
            userId: req.user!.userId,
            type: "TOP_UP",
            amountSeconds,
            amountRub,
            note: "Manual test top-up"
          }
        });

        await reserveNumberIfNeeded(tx, req.user!.userId);
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

export { billingRouter };

import { BillingTransactionType, CallDirection, Prisma } from "@prisma/client";
import {
  assertLedgerBalanceAtLeast,
  createBalanceLedgerEntry,
  getLedgerBalanceKopecks,
  lockUserLedger
} from "./balance-ledger.js";
import { rublesToKopecks } from "./money.js";
import { prisma } from "./prisma.js";

export const NUMBER_RENT_PRICE_RUB = 299;
export const NUMBER_RENT_PRICE_KOPECKS = rublesToKopecks(NUMBER_RENT_PRICE_RUB);
export const NUMBER_RENT_PERIOD_DAYS = 30;
export const NUMBER_RENEWAL_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

type NumberRentalSettlement =
  | { status: "unchanged" }
  | { status: "renewed"; number: string; expiresAt: Date }
  | { status: "released"; number: string };

export function addNumberRentDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

export function getNumberRentDaysLeft(expiresAt: Date | null, now = new Date()) {
  if (!expiresAt) {
    return null;
  }

  return Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);
}

export function canRenewNumber(expiresAt: Date | null, now = new Date()) {
  const daysLeft = getNumberRentDaysLeft(expiresAt, now);
  return daysLeft === null || daysLeft <= NUMBER_RENEWAL_WINDOW_DAYS;
}

export async function rentOrRenewNumber(tx: Prisma.TransactionClient, userId: string) {
  await lockUserLedger(tx, userId);

  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      numberPurchasedAt: true,
      numberRentExpiresAt: true
    }
  });

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

  await assertLedgerBalanceAtLeast(tx, userId, NUMBER_RENT_PRICE_KOPECKS);

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
  const numberRentExpiresAt = addNumberRentDays(startsAt, NUMBER_RENT_PERIOD_DAYS);

  await tx.user.update({
    where: { id: userId },
    data: {
      numberPurchasedAt: user.numberPurchasedAt ?? now,
      numberRentExpiresAt
    }
  });

  await createBalanceLedgerEntry(tx, {
    userId,
    type: BillingTransactionType.NUMBER_PURCHASE,
    amountKopecks: -NUMBER_RENT_PRICE_KOPECKS,
    note: `${isNewRent ? "Аренда" : "Продление аренды"} номера ${number?.number ?? ""}`.trim()
  });

  return number;
}

export async function settleExpiredNumberRental(
  userId: string,
  now = new Date()
): Promise<NumberRentalSettlement> {
  return prisma.$transaction(async (tx) => {
    await lockUserLedger(tx, userId);

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        numberRentExpiresAt: true,
        profiles: {
          where: { mode: CallDirection.INBOUND },
          select: {
            id: true,
            reservedNumberId: true,
            reservedNumber: { select: { id: true, number: true } }
          },
          take: 1
        }
      }
    });
    const inboundProfile = user?.profiles[0];
    const reservedNumber = inboundProfile?.reservedNumber;

    if (
      !user?.numberRentExpiresAt ||
      user.numberRentExpiresAt > now ||
      !inboundProfile?.reservedNumberId ||
      !reservedNumber
    ) {
      return { status: "unchanged" };
    }

    const balanceKopecks = await getLedgerBalanceKopecks(tx, userId);

    if (balanceKopecks >= NUMBER_RENT_PRICE_KOPECKS) {
      const expiresAt = addNumberRentDays(now, NUMBER_RENT_PERIOD_DAYS);

      await createBalanceLedgerEntry(tx, {
        userId,
        type: BillingTransactionType.NUMBER_PURCHASE,
        amountKopecks: -NUMBER_RENT_PRICE_KOPECKS,
        note: `Автопродление аренды номера ${reservedNumber.number}`
      });
      await tx.user.update({
        where: { id: userId },
        data: { numberRentExpiresAt: expiresAt }
      });

      return { status: "renewed", number: reservedNumber.number, expiresAt };
    }

    await tx.assistantProfile.update({
      where: { id: inboundProfile.id },
      data: { reservedNumberId: null }
    });

    const remainingLinks = await tx.assistantProfile.count({
      where: { reservedNumberId: reservedNumber.id }
    });
    if (remainingLinks === 0) {
      await tx.reservedPhoneNumber.update({
        where: { id: reservedNumber.id },
        data: { assigned: false }
      });
    }

    await tx.user.update({
      where: { id: userId },
      data: { numberRentExpiresAt: null }
    });
    await createBalanceLedgerEntry(tx, {
      userId,
      type: BillingTransactionType.NUMBER_PURCHASE,
      amountKopecks: 0,
      note: `Номер ${reservedNumber.number} освобождён: недостаточно средств для продления`
    });

    return { status: "released", number: reservedNumber.number };
  });
}

export async function processExpiredNumberRentals(now = new Date(), batchSize = 50) {
  const users = await prisma.user.findMany({
    where: {
      numberRentExpiresAt: { lte: now },
      profiles: {
        some: {
          mode: CallDirection.INBOUND,
          reservedNumberId: { not: null }
        }
      }
    },
    select: { id: true },
    orderBy: { numberRentExpiresAt: "asc" },
    take: batchSize
  });
  const summary = { checked: users.length, renewed: 0, released: 0, failed: 0 };

  for (const user of users) {
    try {
      const result = await settleExpiredNumberRental(user.id, now);
      if (result.status === "renewed") summary.renewed += 1;
      if (result.status === "released") summary.released += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(`[NUMBER_RENTAL] Failed to settle user ${user.id}`, error);
    }
  }

  return summary;
}

export function startNumberRentalScheduler(intervalMs = 60_000) {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await processExpiredNumberRentals();
      if (summary.checked > 0 || summary.failed > 0) {
        console.log(
          `[NUMBER_RENTAL] checked=${summary.checked} renewed=${summary.renewed} released=${summary.released} failed=${summary.failed}`
        );
      }
    } catch (error) {
      console.error("[NUMBER_RENTAL] Scheduler failed", error);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}

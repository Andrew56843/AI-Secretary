import { type BillingTransactionType, type Prisma } from "@prisma/client";
import { legacyWholeRublesFromKopecks } from "./money.js";

type BalanceLedgerInput = {
  userId: string;
  type: BillingTransactionType;
  amountKopecks: number;
  amountSeconds?: number;
  note?: string | null;
  allowNegativeBalance?: boolean;
};

export function ledgerInsufficientBalanceError() {
  return new Error("INSUFFICIENT_BALANCE");
}

async function lockUserLedger(tx: Prisma.TransactionClient, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`;
}

export async function getLedgerBalanceKopecks(tx: Prisma.TransactionClient, userId: string) {
  const result = await tx.billingTransaction.aggregate({
    where: { userId },
    _sum: { amountKopecks: true }
  });

  return result._sum.amountKopecks ?? 0;
}

export async function syncCachedBalanceFromLedger(tx: Prisma.TransactionClient, userId: string) {
  const balanceKopecks = await getLedgerBalanceKopecks(tx, userId);

  await tx.user.update({
    where: { id: userId },
    data: {
      rubleBalanceKopecks: balanceKopecks,
      rubleBalance: legacyWholeRublesFromKopecks(balanceKopecks)
    }
  });

  return balanceKopecks;
}

export async function createBalanceLedgerEntry(tx: Prisma.TransactionClient, input: BalanceLedgerInput) {
  await lockUserLedger(tx, input.userId);

  const currentBalanceKopecks = await getLedgerBalanceKopecks(tx, input.userId);
  const nextBalanceKopecks = currentBalanceKopecks + input.amountKopecks;

  if (!input.allowNegativeBalance && nextBalanceKopecks < 0) {
    throw ledgerInsufficientBalanceError();
  }

  await tx.billingTransaction.create({
    data: {
      userId: input.userId,
      type: input.type,
      amountSeconds: input.amountSeconds ?? 0,
      amountRub: null,
      amountKopecks: input.amountKopecks,
      note: input.note ?? null
    }
  });

  await tx.user.update({
    where: { id: input.userId },
    data: {
      rubleBalanceKopecks: nextBalanceKopecks,
      rubleBalance: legacyWholeRublesFromKopecks(nextBalanceKopecks)
    }
  });

  return nextBalanceKopecks;
}

export async function assertLedgerBalanceAtLeast(
  tx: Prisma.TransactionClient,
  userId: string,
  requiredKopecks: number
) {
  await lockUserLedger(tx, userId);
  const balanceKopecks = await getLedgerBalanceKopecks(tx, userId);

  if (balanceKopecks < requiredKopecks) {
    throw ledgerInsufficientBalanceError();
  }

  return balanceKopecks;
}

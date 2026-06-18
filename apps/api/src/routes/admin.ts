import { BillingTransactionType, Prisma } from "@prisma/client";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { createBalanceLedgerEntry } from "../lib/balance-ledger.js";
import { createToken } from "../lib/auth.js";
import { kopecksToRubles, rublesToKopecks } from "../lib/money.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/require-auth.js";

const adminRouter = Router();
const ADMIN_PHONE = "+79054176285";

const usersQuerySchema = z.object({
  search: z.string().trim().max(80).optional()
});

const userParamsSchema = z.object({
  id: z.string().cuid()
});

const balanceAdjustmentSchema = z.object({
  operation: z.enum(["increase", "decrease"]),
  amountRub: z.number().positive().max(1_000_000),
  note: z.string().trim().max(300).optional()
});

function isAdminPhone(phone: string | null | undefined) {
  return phone === ADMIN_PHONE;
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isAdminPhone(req.user?.phone)) {
    res.status(403).json({ message: "Admin access denied" });
    return;
  }

  next();
}

function publicUser(user: { id: string; phone: string; fullName: string | null; timeZone?: string | null; createdAt?: Date }) {
  return {
    id: user.id,
    phone: user.phone,
    fullName: user.fullName,
    timeZone: user.timeZone ?? "Europe/Moscow",
    createdAt: user.createdAt
  };
}

function publicAdminUser(
  user: Prisma.UserGetPayload<{
    include: {
      telegramAccount: true;
      googleAccount: true;
      profiles: { include: { reservedNumber: true } };
      _count: { select: { outboundContacts: true; billingTransactions: true } };
    };
  }>,
  ledgerBalanceKopecks = user.rubleBalanceKopecks
) {
  const reservedNumber = user.profiles.find((profile) => profile.reservedNumber)?.reservedNumber ?? null;

  return {
    id: user.id,
    phone: user.phone,
    fullName: user.fullName,
    timeZone: user.timeZone,
    rubleBalance: kopecksToRubles(ledgerBalanceKopecks),
    rubleBalanceKopecks: ledgerBalanceKopecks,
    numberRentExpiresAt: user.numberRentExpiresAt,
    reservedNumber,
    telegramStatus: user.telegramAccount?.status ?? "DISCONNECTED",
    googleStatus: user.googleAccount?.status ?? "DISCONNECTED",
    profilesCount: user.profiles.length,
    outboundContactsCount: user._count.outboundContacts,
    billingTransactionsCount: user._count.billingTransactions,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

async function getLedgerBalanceMap(userIds: string[]) {
  if (userIds.length === 0) {
    return new Map<string, number>();
  }

  const balances = await prisma.billingTransaction.groupBy({
    by: ["userId"],
    where: { userId: { in: userIds } },
    _sum: { amountKopecks: true }
  });

  return new Map(balances.map((item) => [item.userId, item._sum.amountKopecks ?? 0]));
}

async function getAdminUserById(userId: string) {
  const [user, ledgerBalance] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      include: {
        telegramAccount: true,
        googleAccount: true,
        profiles: { include: { reservedNumber: true } },
        _count: { select: { outboundContacts: true, billingTransactions: true } }
      }
    }),
    prisma.billingTransaction.aggregate({
      where: { userId },
      _sum: { amountKopecks: true }
    })
  ]);

  return user ? publicAdminUser(user, ledgerBalance._sum.amountKopecks ?? 0) : null;
}

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/users", async (req, res) => {
  const parsed = usersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid query", errors: parsed.error.flatten() });
    return;
  }

  const search = parsed.data.search;
  const where: Prisma.UserWhereInput = search
    ? {
        OR: [
          { phone: { contains: search, mode: "insensitive" } },
          { fullName: { contains: search, mode: "insensitive" } }
        ]
      }
    : {};

  const users = await prisma.user.findMany({
    where,
    include: {
      telegramAccount: true,
      googleAccount: true,
      profiles: { include: { reservedNumber: true } },
      _count: { select: { outboundContacts: true, billingTransactions: true } }
    },
    orderBy: { createdAt: "desc" },
    take: 200
  });

  const ledgerBalances = await getLedgerBalanceMap(users.map((user) => user.id));

  res.json({ users: users.map((user) => publicAdminUser(user, ledgerBalances.get(user.id) ?? 0)) });
});

adminRouter.post("/users/:id/impersonate", async (req, res) => {
  const parsed = userParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid user id" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: parsed.data.id } });
  if (!user) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  res.json({
    token: createToken({ userId: user.id, phone: user.phone }),
    user: publicUser(user)
  });
});

adminRouter.post("/users/:id/balance", async (req, res) => {
  const parsedParams = userParamsSchema.safeParse(req.params);
  const parsedBody = balanceAdjustmentSchema.safeParse(req.body);

  if (!parsedParams.success) {
    res.status(400).json({ message: "Invalid user id" });
    return;
  }
  if (!parsedBody.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsedBody.error.flatten() });
    return;
  }

  const amountKopecks = rublesToKopecks(parsedBody.data.amountRub);
  const signedAmountKopecks = parsedBody.data.operation === "increase" ? amountKopecks : -amountKopecks;

  try {
    await prisma.$transaction(
      async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: parsedParams.data.id },
          select: { id: true, phone: true }
        });

        if (!user) {
          throw new Error("USER_NOT_FOUND");
        }

        await createBalanceLedgerEntry(tx, {
          userId: user.id,
          type: BillingTransactionType.ADMIN_ADJUSTMENT,
          amountKopecks: signedAmountKopecks,
          note: parsedBody.data.note || `Admin balance adjustment for ${user.phone}`
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    const user = await getAdminUserById(parsedParams.data.id);
    res.json({ user });
  } catch (error) {
    if (error instanceof Error && error.message === "USER_NOT_FOUND") {
      res.status(404).json({ message: "User not found" });
      return;
    }
    if (error instanceof Error && (error.message === "NEGATIVE_BALANCE" || error.message === "INSUFFICIENT_BALANCE")) {
      res.status(400).json({ message: "Balance cannot become negative" });
      return;
    }
    throw error;
  }
});

export { adminRouter };

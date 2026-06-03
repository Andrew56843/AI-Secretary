import { CallDirection, CallStatus, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { createBillableCallLog } from "../lib/billable-call.js";
import { prisma } from "../lib/prisma.js";
import { normalizePhone } from "../lib/phone.js";
import { requireAuth } from "../middleware/require-auth.js";

const callLogsRouter = Router();

const directionQuerySchema = z
  .enum(["inbound", "outbound"])
  .optional()
  .transform((value) => {
    if (!value) {
      return undefined;
    }
    return value === "inbound" ? CallDirection.INBOUND : CallDirection.OUTBOUND;
  });

const logsQuerySchema = z.object({
  direction: directionQuerySchema,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(6)
});

const createMockSchema = z.object({
  direction: z.enum(["inbound", "outbound"]).default("inbound"),
  customerPhone: z.string().trim().min(8).max(24).transform(normalizePhone),
  durationSeconds: z.number().int().nonnegative().max(3600),
  status: z.enum([CallStatus.SUCCESS, CallStatus.ESCALATED, CallStatus.MISSED]),
  summary: z.string().trim().min(8).max(800),
  transcript: z.string().trim().min(8).max(12000).optional(),
  recordingUrl: z.string().url().optional()
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

callLogsRouter.get("/me", requireAuth, async (req, res) => {
  const parsed = logsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid query", errors: parsed.error.flatten() });
    return;
  }

  const { direction, pageSize } = parsed.data;

  const profiles = await prisma.assistantProfile.findMany({
    where: {
      userId: req.user!.userId,
      ...(direction ? { mode: direction } : {})
    },
    select: { id: true }
  });

  if (profiles.length === 0) {
    res.json({ logs: [], pagination: createPagination(1, pageSize, 0) });
    return;
  }

  const where: Prisma.CallLogWhereInput = {
    assistantProfileId: { in: profiles.map((profile) => profile.id) }
  };
  const total = await prisma.callLog.count({ where });
  const pagination = createPagination(parsed.data.page, pageSize, total);
  const logs = await prisma.callLog.findMany({
    where,
    include: { transcriptDeliveries: true },
    orderBy: { createdAt: "desc" },
    skip: (pagination.page - 1) * pageSize,
    take: pageSize
  });

  res.json({ logs, pagination });
});

callLogsRouter.post("/mock", requireAuth, async (req, res) => {
  const parsed = createMockSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const direction = parsed.data.direction === "inbound" ? CallDirection.INBOUND : CallDirection.OUTBOUND;
  const profile = await prisma.assistantProfile.findUnique({
    where: { userId_mode: { userId: req.user!.userId, mode: direction } },
    select: { id: true }
  });

  if (!profile) {
    res.status(404).json({ message: "Create assistant profile first" });
    return;
  }

  const { direction: _direction, ...payload } = parsed.data;

  try {
    const log = await prisma.$transaction(
      (tx) =>
        createBillableCallLog(tx, {
          userId: req.user!.userId,
          direction,
          ...payload
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    res.status(201).json({ log });
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_MINUTES") {
      res.status(402).json({ message: "Not enough minutes. Top up balance to continue calls." });
      return;
    }
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      res.status(402).json({ message: "Not enough balance. Top up balance to continue calls." });
      return;
    }
    if (error instanceof Error && error.message === "PROFILE_NOT_FOUND") {
      res.status(404).json({ message: "Create assistant profile first" });
      return;
    }
    throw error;
  }
});

export { callLogsRouter };

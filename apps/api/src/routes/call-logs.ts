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

const createMockSchema = z.object({
  direction: z.enum(["inbound", "outbound"]).default("inbound"),
  customerPhone: z.string().trim().min(8).max(24).transform(normalizePhone),
  durationSeconds: z.number().int().nonnegative().max(3600),
  status: z.enum([CallStatus.SUCCESS, CallStatus.ESCALATED, CallStatus.MISSED]),
  summary: z.string().trim().min(8).max(800),
  transcript: z.string().trim().min(8).max(12000).optional(),
  recordingUrl: z.string().url().optional()
});

callLogsRouter.get("/me", requireAuth, async (req, res) => {
  const parsedDirection = directionQuerySchema.safeParse(req.query.direction);
  if (!parsedDirection.success) {
    res.status(400).json({ message: "Invalid direction" });
    return;
  }

  const profiles = await prisma.assistantProfile.findMany({
    where: {
      userId: req.user!.userId,
      ...(parsedDirection.data ? { mode: parsedDirection.data } : {})
    },
    select: { id: true }
  });

  if (profiles.length === 0) {
    res.json({ logs: [] });
    return;
  }

  const logs = await prisma.callLog.findMany({
    where: {
      assistantProfileId: { in: profiles.map((profile) => profile.id) }
    },
    include: { transcriptDeliveries: true },
    orderBy: { createdAt: "desc" },
    take: 50
  });

  res.json({ logs });
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
    if (error instanceof Error && error.message === "PROFILE_NOT_FOUND") {
      res.status(404).json({ message: "Create assistant profile first" });
      return;
    }
    throw error;
  }
});

export { callLogsRouter };

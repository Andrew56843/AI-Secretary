import { CallStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/require-auth.js";

const callLogsRouter = Router();

const createMockSchema = z.object({
  customerPhone: z.string().trim().min(8).max(24),
  durationSeconds: z.number().int().nonnegative().max(3600),
  status: z.enum([CallStatus.SUCCESS, CallStatus.ESCALATED, CallStatus.MISSED]),
  summary: z.string().trim().min(8).max(800),
  transcript: z.string().trim().min(8).max(12000).optional(),
  recordingUrl: z.string().url().optional()
});

callLogsRouter.get("/me", requireAuth, async (req, res) => {
  const profile = await prisma.assistantProfile.findFirst({
    where: { userId: req.user!.userId },
    select: { id: true }
  });

  if (!profile) {
    res.json({ logs: [] });
    return;
  }

  const logs = await prisma.callLog.findMany({
    where: { assistantProfileId: profile.id },
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

  const profile = await prisma.assistantProfile.findFirst({
    where: { userId: req.user!.userId },
    select: { id: true }
  });

  if (!profile) {
    res.status(404).json({ message: "Create assistant profile first" });
    return;
  }

  const log = await prisma.callLog.create({
    data: {
      assistantProfileId: profile.id,
      ...parsed.data
    }
  });

  res.status(201).json({ log });
});

export { callLogsRouter };

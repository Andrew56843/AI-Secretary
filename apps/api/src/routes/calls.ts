import { CallDirection, CallStatus, OutboundContactStatus, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { createBillableCallLog } from "../lib/billable-call.js";
import { normalizePhone } from "../lib/phone.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/require-auth.js";

const callsRouter = Router();

const siteCallSchema = z.object({
  direction: z.enum(["inbound", "outbound"]).default("outbound")
});

callsRouter.post("/site-call", requireAuth, async (req, res) => {
  const parsed = siteCallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const direction = parsed.data.direction === "inbound" ? CallDirection.INBOUND : CallDirection.OUTBOUND;
  const durationSeconds = 1;

  if (direction === CallDirection.OUTBOUND) {
    const profile = await prisma.assistantProfile.findUnique({
      where: { userId_mode: { userId: req.user!.userId, mode: CallDirection.OUTBOUND } },
      select: { id: true }
    });

    if (!profile) {
      res.status(404).json({ message: "Create outbound assistant profile first" });
      return;
    }

    const phone = normalizePhone(req.user!.phone);
    const contact = await prisma.outboundContact.upsert({
      where: {
        userId_phone: {
          userId: req.user!.userId,
          phone
        }
      },
      update: {
        status: OutboundContactStatus.PENDING,
        queuedForCall: false,
        attempts: 0,
        nextAttemptAt: null,
        lastCallLogId: null
      },
      create: {
        userId: req.user!.userId,
        phone
      }
    });

    res.status(202).json({ queued: true, contact });
    return;
  }

  try {
    const log = await prisma.$transaction(
      (tx) =>
        createBillableCallLog(tx, {
          userId: req.user!.userId,
          direction,
          customerPhone: req.user!.phone,
          status: CallStatus.SUCCESS,
          durationSeconds,
          summary: "Тестовый звонок с сайта: пользователь запустил разговор из личного кабинета.",
          transcript:
            "Assi: Звонок запущен с сайта, номер вводить не нужно.\nUser: Проверяю сценарий.\nAssi: Тест завершен, транскрипт сохранен.",
          recordingUrl: undefined
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

export { callsRouter };

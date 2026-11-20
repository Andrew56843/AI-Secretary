import { CallDirection, OutboundContactStatus, ProfileStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { resolveOutboundCallerId } from "../lib/outbound-caller-id.js";
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

  const profile = await prisma.assistantProfile.findUnique({
    where: { userId_mode: { userId: req.user!.userId, mode: direction } },
    select: {
      id: true,
      status: true,
      user: { select: { phone: true, rubleBalanceKopecks: true, numberRentExpiresAt: true } }
    }
  });

  if (!profile || profile.status !== ProfileStatus.ACTIVE) {
    res.status(404).json({
      message:
        direction === CallDirection.OUTBOUND ? "Create outbound assistant profile first" : "Create inbound assistant profile first"
    });
    return;
  }

  if (profile.user.rubleBalanceKopecks <= 0) {
    res.status(402).json({ message: "Top up your balance before starting a new call" });
    return;
  }

  const phone = normalizePhone(profile.user.phone);
  if (!phone) {
    res.status(400).json({ message: "User phone is not valid for a test call" });
    return;
  }

  const inboundProfile = await prisma.assistantProfile.findUnique({
    where: { userId_mode: { userId: req.user!.userId, mode: CallDirection.INBOUND } },
    select: { status: true, reservedNumber: { select: { number: true } } }
  });
  const callerId = resolveOutboundCallerId({
    ownerPhone: profile.user.phone,
    destinationPhone: phone,
    reservedNumber: inboundProfile?.status === ProfileStatus.ACTIVE ? inboundProfile.reservedNumber?.number : null,
    numberRentExpiresAt: profile.user.numberRentExpiresAt,
    testCallerId: env.TEST_CALLER_ID
  });
  if (!callerId) {
    res.status(409).json({
      message: "Для тестового звонка пока нет доступного номера. Обратитесь в поддержку или арендуйте номер в разделе пополнения баланса."
    });
    return;
  }

  const contact = await prisma.outboundContact.upsert({
    where: {
      userId_phone_callMode: {
        userId: req.user!.userId,
        phone,
        callMode: direction
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
      phone,
      callMode: direction
    }
  });

  res.status(202).json({ queued: true, contact });
});

export { callsRouter };

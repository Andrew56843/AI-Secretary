import { CallDirection, OutboundContactStatus, ProfileStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
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

  const [profile, inboundProfile] = await Promise.all([
    prisma.assistantProfile.findUnique({
      where: { userId_mode: { userId: req.user!.userId, mode: direction } },
      select: { id: true, status: true }
    }),
    prisma.assistantProfile.findUnique({
      where: { userId_mode: { userId: req.user!.userId, mode: CallDirection.INBOUND } },
      select: {
        reservedNumberId: true,
        user: {
          select: {
            numberRentExpiresAt: true
          }
        }
      }
    })
  ]);

  if (!profile || profile.status !== ProfileStatus.ACTIVE) {
    res.status(404).json({
      message:
        direction === CallDirection.OUTBOUND ? "Create outbound assistant profile first" : "Create inbound assistant profile first"
    });
    return;
  }

  if (!inboundProfile?.reservedNumberId) {
    res.status(409).json({ message: "Reserve a phone number before starting test calls" });
    return;
  }

  if (inboundProfile.user.numberRentExpiresAt && inboundProfile.user.numberRentExpiresAt < new Date()) {
    res.status(402).json({ message: "Reserved phone number rent has expired" });
    return;
  }

  const phone = normalizePhone(req.user!.phone);
  if (!phone) {
    res.status(400).json({ message: "User phone is not valid for a test call" });
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

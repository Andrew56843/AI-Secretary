import { CallDirection, ProfileStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { reservedNumberRouteSelect, resolveOutboundSipRoute } from "../lib/outbound-sip-route.js";
import { normalizePhone } from "../lib/phone.js";
import { prisma } from "../lib/prisma.js";
import { enqueueTestCall } from "../lib/test-call-queue.js";
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

  const [inboundProfile, testNumber] = await Promise.all([
    prisma.assistantProfile.findUnique({
      where: { userId_mode: { userId: req.user!.userId, mode: CallDirection.INBOUND } },
      select: { reservedNumber: { select: reservedNumberRouteSelect } }
    }),
    env.TEST_CALLER_ID
      ? prisma.reservedPhoneNumber.findUnique({
          where: { number: normalizePhone(env.TEST_CALLER_ID) },
          select: reservedNumberRouteSelect
        })
      : null
  ]);
  const route = resolveOutboundSipRoute({
    ownerPhone: profile.user.phone,
    destinationPhone: phone,
    reservedNumber: inboundProfile?.reservedNumber,
    numberRentExpiresAt: profile.user.numberRentExpiresAt,
    testCallerId: env.TEST_CALLER_ID,
    testNumber
  });
  if (!route) {
    res.status(409).json({
      message: "Для тестового звонка пока нет доступного номера. Обратитесь в поддержку или арендуйте номер в разделе пополнения баланса."
    });
    return;
  }

  const result = await enqueueTestCall(prisma, {
    userId: req.user!.userId,
    phone,
    direction
  });
  if (!result.queued) {
    res.status(409).json({ message: result.message });
    return;
  }

  res.status(202).json(result);
});

export { callsRouter };

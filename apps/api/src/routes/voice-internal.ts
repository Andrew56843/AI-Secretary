import { timingSafeEqual } from "crypto";
import { CallDirection, CallStatus, Prisma, ProfileStatus } from "@prisma/client";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { createBillableCallLog } from "../lib/billable-call.js";
import { normalizePhone } from "../lib/phone.js";
import { prisma } from "../lib/prisma.js";

const voiceInternalRouter = Router();

const resolveCallSchema = z.object({
  did: z.string().trim().min(1).max(64),
  callerId: z.string().trim().max(64).optional(),
  uuid: z.string().trim().max(80).optional()
});

const createCallLogSchema = z.object({
  assistantProfileId: z.string().trim().min(1).optional(),
  did: z.string().trim().min(1).max(64).optional(),
  direction: z.enum(["INBOUND", "OUTBOUND"]).default("INBOUND"),
  customerPhone: z.string().trim().min(1).max(64),
  status: z.enum([CallStatus.SUCCESS, CallStatus.ESCALATED, CallStatus.MISSED]).default(CallStatus.SUCCESS),
  durationSeconds: z.number().int().nonnegative().max(24 * 60 * 60),
  summary: z.string().trim().max(2000).optional(),
  transcript: z.string().trim().max(100_000).optional(),
  recordingUrl: z.string().trim().max(2048).optional()
});

const telegramLinkSchema = z.object({
  linkToken: z.string().trim().min(8).max(200),
  chatId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().trim().min(1).max(80)),
  username: z.string().trim().min(1).max(80).optional(),
  botUsername: z.string().trim().min(1).max(80).optional()
});

function getHeaderValue(req: Request, name: string) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function secureEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function requireVoiceService(req: Request, res: Response, next: NextFunction) {
  if (!env.VOICE_SERVICE_TOKEN) {
    res.status(503).json({ message: "Voice service token is not configured" });
    return;
  }

  const token = getHeaderValue(req, "x-voice-service-token");
  if (!token || !secureEquals(token, env.VOICE_SERVICE_TOKEN)) {
    res.status(401).json({ message: "Unauthorized voice service request" });
    return;
  }

  next();
}

function createNumberLookupValues(input: string | null | undefined) {
  const raw = String(input ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  const values = new Set<string>();

  if (raw) {
    values.add(raw);
  }
  if (digits) {
    values.add(digits);
    values.add(`+${digits}`);
  }

  const normalized = raw ? normalizePhone(raw) : "";
  if (normalized) {
    values.add(normalized);
  }

  return [...values].filter(Boolean);
}

function createExactGreetingInstruction(greetingText: string) {
  return [
    "Say exactly and completely only this phrase.",
    "Do not rephrase, shorten, add greetings, comments or extra words:",
    greetingText
  ].join(" ");
}

function mapProfileToVoiceConfig(
  profile: Prisma.AssistantProfileGetPayload<{
    include: {
      reservedNumber: true;
      user: {
        select: {
          id: true;
          phone: true;
          numberRentExpiresAt: true;
          rubleBalance: true;
          telegramAccount: {
            select: {
              status: true;
              chatId: true;
              username: true;
            };
          };
        };
      };
    };
  }>
) {
  const maxDialogSeconds = Math.max(15, profile.maxDialogSeconds);

  return {
    assistantProfileId: profile.id,
    userId: profile.userId,
    clientId: profile.id,
    clientName: profile.businessName ?? profile.title,
    businessName: profile.businessName,
    language: "ru",
    voice: profile.voice,
    realtimeModel: profile.realtimeModel,
    autoGreeting: true,
    greetingText: createExactGreetingInstruction(profile.greetingText),
    instructions: profile.prompt,
    forwardingEnabled: profile.forwardingEnabled,
    forwardingOnComplete: profile.forwardingOnComplete,
    forwardingOnStalemate: profile.forwardingOnStalemate,
    forwardPhone: profile.forwardingEnabled ? profile.forwardingPhone : "",
    maxDialogSeconds,
    forwardAfterMs: profile.forwardingEnabled ? maxDialogSeconds * 1000 : 0,
    transcriptionModel: "gpt-4o-transcribe",
    maxResponseOutputTokens: 400,
    turnDetection: {
      threshold: 0.6,
      silenceDurationMs: 400,
      prefixPaddingMs: 300
    },
    reservedNumber: profile.reservedNumber
      ? {
          id: profile.reservedNumber.id,
          number: profile.reservedNumber.number,
          providerDid: profile.reservedNumber.providerDid
        }
      : null,
    account: {
      id: profile.user.id,
      phone: profile.user.phone,
      rubleBalance: profile.user.rubleBalance,
      numberRentExpiresAt: profile.user.numberRentExpiresAt,
      telegram:
        profile.user.telegramAccount?.status === "CONNECTED"
          ? {
              chatId: profile.user.telegramAccount.chatId,
              username: profile.user.telegramAccount.username
            }
          : null
    }
  };
}

async function findInboundProfileByDid(did: string) {
  const values = createNumberLookupValues(did);
  if (values.length === 0) {
    return null;
  }

  return prisma.assistantProfile.findFirst({
    where: {
      mode: CallDirection.INBOUND,
      status: ProfileStatus.ACTIVE,
      reservedNumber: {
        is: {
          OR: [{ number: { in: values } }, { providerDid: { in: values } }]
        }
      }
    },
    include: {
      reservedNumber: true,
      user: {
        select: {
          id: true,
          phone: true,
          numberRentExpiresAt: true,
          rubleBalance: true,
          telegramAccount: {
            select: {
              status: true,
              chatId: true,
              username: true
            }
          }
        }
      }
    }
  });
}

function buildDefaultSummary(status: CallStatus, customerPhone: string) {
  if (status === CallStatus.ESCALATED) {
    return `Call from ${customerPhone} was escalated to the account owner.`;
  }
  if (status === CallStatus.MISSED) {
    return `Call from ${customerPhone} was missed or ended before completion.`;
  }
  return `Call from ${customerPhone} was handled by the AI secretary.`;
}

voiceInternalRouter.get("/healthz", requireVoiceService, (_req, res) => {
  res.json({ ok: true, service: "voice-internal" });
});

voiceInternalRouter.post("/call/resolve", requireVoiceService, async (req, res) => {
  const parsed = resolveCallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const profile = await findInboundProfileByDid(parsed.data.did);
  if (!profile) {
    res.status(404).json({ message: "No active assistant profile for this DID" });
    return;
  }

  const now = new Date();
  if (profile.user.numberRentExpiresAt && profile.user.numberRentExpiresAt < now) {
    res.status(402).json({ message: "Reserved number rent has expired" });
    return;
  }

  res.json({
    ok: true,
    call: {
      uuid: parsed.data.uuid ?? null,
      did: parsed.data.did,
      callerId: parsed.data.callerId ?? null
    },
    profile: mapProfileToVoiceConfig(profile)
  });
});

voiceInternalRouter.post("/call/logs", requireVoiceService, async (req, res) => {
  const parsed = createCallLogSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const payload = parsed.data;
  const direction = payload.direction === "OUTBOUND" ? CallDirection.OUTBOUND : CallDirection.INBOUND;

  const profile = payload.assistantProfileId
    ? await prisma.assistantProfile.findUnique({
        where: { id: payload.assistantProfileId },
        select: { id: true, userId: true, mode: true }
      })
    : payload.did
      ? await findInboundProfileByDid(payload.did)
      : null;

  if (!profile) {
    res.status(404).json({ message: "Assistant profile not found" });
    return;
  }

  const customerPhone = normalizePhone(payload.customerPhone) || payload.customerPhone;
  const summary = payload.summary || buildDefaultSummary(payload.status, customerPhone);

  try {
    const log = await prisma.$transaction(
      (tx) =>
        createBillableCallLog(tx, {
          userId: profile.userId,
          direction,
          customerPhone,
          status: payload.status,
          durationSeconds: payload.durationSeconds,
          summary,
          transcript: payload.transcript,
          recordingUrl: payload.recordingUrl
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    res.status(201).json({ ok: true, log });
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      res.status(402).json({ message: "Not enough balance to save a billable call log" });
      return;
    }
    if (error instanceof Error && error.message === "PROFILE_NOT_FOUND") {
      res.status(404).json({ message: "Create assistant profile first" });
      return;
    }
    throw error;
  }
});

voiceInternalRouter.post("/telegram/link", requireVoiceService, async (req, res) => {
  const parsed = telegramLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const account = await prisma.telegramAccount.findUnique({
    where: { linkToken: parsed.data.linkToken },
    select: { id: true, userId: true }
  });

  if (!account) {
    res.status(404).json({ message: "Telegram link token not found" });
    return;
  }

  const telegram = await prisma.telegramAccount.update({
    where: { id: account.id },
    data: {
      status: "CONNECTED",
      chatId: parsed.data.chatId,
      username: parsed.data.username,
      botUsername: parsed.data.botUsername,
      connectedAt: new Date()
    }
  });

  res.json({
    ok: true,
    telegram: {
      id: telegram.id,
      userId: telegram.userId,
      status: telegram.status,
      botUsername: telegram.botUsername,
      username: telegram.username,
      connectedAt: telegram.connectedAt
    }
  });
});

export { voiceInternalRouter };

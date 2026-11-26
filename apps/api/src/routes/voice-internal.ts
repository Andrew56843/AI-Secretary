import { randomUUID, timingSafeEqual } from "crypto";
import { CallDirection, CallStatus, OutboundContactStatus, Prisma, ProfileStatus } from "@prisma/client";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { captureCallBillingSnapshot } from "../lib/call-billing-snapshot.js";
import {
  calendarActionInputSchema,
  finalizeCalendarTranscriptForCall,
  maybeSyncCalendarFromCallLog,
  syncCalendarAction,
  warmCalendarSchedulePolicy,
  type CalendarAutomationResult
} from "../lib/google-calendar.js";
import { kopecksToRubles } from "../lib/money.js";
import { isOwnerTestDestination } from "../lib/outbound-caller-id.js";
import { claimNextOutboundContact } from "../lib/outbound-queue.js";
import {
  reservedNumberRouteSelect,
  resolveOutboundSipRoute,
  safeSipLineRoute,
  type OutboundSipLine
} from "../lib/outbound-sip-route.js";
import { normalizePhone } from "../lib/phone.js";
import {
  completeLatestPhoneVerificationForCall,
  isPhoneVerificationDid,
  publicPhoneVerificationRequest
} from "../lib/phone-verification.js";
import { prisma } from "../lib/prisma.js";
import { decryptSecret } from "../lib/secret-box.js";
import { parseSipLineProvisionInput } from "../lib/sip-line-provision-input.js";
import { deliverTelegramTranscript } from "../lib/telegram.js";
import { createProfileTranscriptionPrompt } from "../lib/transcription-context.js";
import { validateVoiceCallBinding } from "../lib/voice-call-binding.js";
import { persistVoiceCallCallback } from "../lib/voice-call-callback.js";

const voiceInternalRouter = Router();
const STALE_OUTBOUND_QUEUE_MS = 10 * 60 * 1000;
const callLogDeliveryTasks = new Set<Promise<unknown>>();

function scheduleCallLogTelegramDelivery(callLogId: string) {
  const task = Promise.resolve().then(() => deliverTelegramTranscript(callLogId)).catch(() => {
    console.error("Telegram delivery task failed for call log", callLogId);
  });
  callLogDeliveryTasks.add(task);
  void task.then(
    () => { callLogDeliveryTasks.delete(task); },
    () => { callLogDeliveryTasks.delete(task); }
  );
}

export async function drainVoiceCallDeliveries() {
  while (callLogDeliveryTasks.size > 0) {
    await Promise.allSettled([...callLogDeliveryTasks]);
  }
}

const resolveCallSchema = z
  .object({
    did: z.string().trim().min(1).max(64).optional(),
    callerId: z.string().trim().max(64).optional(),
    uuid: z.string().trim().max(80).optional(),
    direction: z.enum(["INBOUND", "OUTBOUND"]).optional(),
    assistantProfileId: z.string().trim().min(1).optional(),
    outboundContactId: z.string().trim().min(1).optional()
  })
  .refine((value) => value.did || value.assistantProfileId, {
    message: "Either did or assistantProfileId is required"
  });

const createCallLogSchema = z.object({
  assistantProfileId: z.string().trim().min(1).optional(),
  callUuid: z.string().trim().min(1).max(80),
  did: z.string().trim().min(1).max(64).optional(),
  outboundContactId: z.string().trim().min(1).optional(),
  direction: z.enum(["INBOUND", "OUTBOUND"]).default("INBOUND"),
  customerPhone: z.string().trim().min(1).max(64),
  status: z.enum([CallStatus.SUCCESS, CallStatus.ESCALATED, CallStatus.MISSED]).default(CallStatus.SUCCESS),
  durationSeconds: z.number().int().nonnegative().max(24 * 60 * 60),
  summary: z.string().trim().max(2000).optional(),
  transcript: z.string().trim().max(100_000).optional(),
  recordingUrl: z.string().trim().max(2048).optional()
});

const callEndedSchema = z.object({
  callUuid: z.string().trim().min(1).max(80),
  outboundContactId: z.string().trim().min(1).optional()
});

const outboundNextSchema = z.object({
  limit: z.number().int().min(1).max(5).default(1).optional()
});

const outboundReleaseSchema = z.object({
  outboundContactId: z.string().trim().min(1),
  reason: z.string().trim().max(400).optional(),
  countAttempt: z.boolean().default(true).optional()
});

const telegramLinkSchema = z.object({
  linkToken: z.string().trim().min(8).max(200),
  chatId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().trim().min(1).max(80)),
  username: z.string().trim().min(1).max(80).optional(),
  botUsername: z.string().trim().min(1).max(80).optional()
});

const calendarToolActionSchema = z.object({
  assistantProfileId: z.string().trim().min(1),
  callUuid: z.string().trim().max(100).optional(),
  customerPhone: z.string().trim().min(1).max(64),
  direction: z.enum(["INBOUND", "OUTBOUND"]).default("INBOUND"),
  transcript: z.string().trim().max(30_000).optional(),
  action: calendarActionInputSchema
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

function requireSipConfigService(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  if (!env.SIP_CONFIG_TOKEN || env.SIP_CONFIG_TOKEN === env.VOICE_SERVICE_TOKEN) {
    res.status(503).json({ message: "SIP configuration export is not configured" });
    return;
  }
  const token = getHeaderValue(req, "x-sip-config-token");
  if (!token || !secureEquals(token, env.SIP_CONFIG_TOKEN)) {
    res.status(401).json({ message: "Unauthorized SIP configuration request" });
    return;
  }
  next();
}

async function findConfiguredTestSipNumber(client: Pick<Prisma.TransactionClient, "reservedPhoneNumber"> = prisma) {
  return env.TEST_CALLER_ID
    ? client.reservedPhoneNumber.findUnique({
        where: { number: normalizePhone(env.TEST_CALLER_ID) },
        select: reservedNumberRouteSelect
      })
    : null;
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
      greetingAudioCache: true;
      user: {
        select: {
          id: true;
          phone: true;
          timeZone: true;
          numberRentExpiresAt: true;
          rubleBalanceKopecks: true;
          googleAccount: {
            select: {
              status: true;
              googleEmail: true;
              calendarId: true;
              connectedAt: true;
            };
          };
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
  }>,
  extra: {
    direction?: CallDirection;
    outboundContact?: {
      id: string;
      phone: string;
      name?: string | null;
      attempts: number;
    };
    outboundCallerId?: string | null;
    outboundSipLine?: OutboundSipLine | null;
  } = {}
) {
  const maxDialogSeconds = Math.max(1, profile.maxDialogSeconds);

  return {
    assistantProfileId: profile.id,
    userId: profile.userId,
    clientId: profile.id,
    direction: extra.direction ?? profile.mode,
    clientName: profile.businessName ?? profile.title,
    businessName: profile.businessName,
    language: "ru",
    voice: profile.voice,
    realtimeModel: profile.realtimeModel,
    autoGreeting: true,
    greetingText: profile.greetingText,
    greetingInstruction: createExactGreetingInstruction(profile.greetingText),
    greetingAudio: profile.greetingAudioCache
      ? {
          encoding: "pcm_s16le",
          sampleRate: 24_000,
          voice: profile.greetingAudioCache.voice,
          model: profile.greetingAudioCache.model,
          pcm24Base64: Buffer.from(profile.greetingAudioCache.pcm24).toString("base64")
        }
      : null,
    instructions: profile.prompt,
    transcriptionPrompt: createProfileTranscriptionPrompt(profile),
    forwardingEnabled: profile.forwardingEnabled,
    forwardingOnComplete: profile.forwardingOnComplete,
    forwardingOnStalemate: profile.forwardingOnStalemate,
    forwardPhone: profile.forwardingEnabled ? profile.forwardingPhone : "",
    maxDialogSeconds,
    forwardAfterMs: profile.forwardingEnabled ? maxDialogSeconds * 1000 : 0,
    transcriptionModel: "gpt-4o-transcribe",
    maxResponseOutputTokens: 800,
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
    outboundCallerId: extra.outboundCallerId ?? null,
    outboundSipLine: extra.outboundSipLine ?? null,
    outboundContact: extra.outboundContact ?? null,
    account: {
      id: profile.user.id,
      phone: profile.user.phone,
      timeZone: profile.user.timeZone,
      rubleBalance: kopecksToRubles(profile.user.rubleBalanceKopecks),
      numberRentExpiresAt: profile.user.numberRentExpiresAt,
      google:
        profile.user.googleAccount?.status === "CONNECTED"
          ? {
              status: profile.user.googleAccount.status,
              googleEmail: profile.user.googleAccount.googleEmail,
              calendarId: profile.user.googleAccount.calendarId,
              connectedAt: profile.user.googleAccount.connectedAt
            }
          : {
              status: "DISCONNECTED" as const
            },
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

async function releaseOutboundContactForRetry(
  tx: Prisma.TransactionClient,
  contact: { id: string; attempts: number },
  lastCallLogId?: string
) {
  const attempts = contact.attempts + 1;
  if (attempts >= 3) {
    await tx.outboundContact.delete({
      where: { id: contact.id }
    });
    return { removed: true, attempts };
  }

  await tx.outboundContact.update({
    where: { id: contact.id },
    data: {
      queuedForCall: false,
      activeCallUuid: null,
      activeCallStartedAt: null,
      status: OutboundContactStatus.PENDING,
      attempts,
      nextAttemptAt: new Date(Date.now() + 15 * 60 * 1000),
      ...(lastCallLogId ? { lastCallLogId } : {})
    }
  });

  return { removed: false, attempts };
}

async function releaseOutboundContactWithoutAttempt(tx: Prisma.TransactionClient, contactId: string) {
  const contact = await tx.outboundContact.findUnique({
    where: { id: contactId },
    select: { id: true, attempts: true }
  });

  if (!contact) {
    return null;
  }

  await tx.outboundContact.update({
    where: { id: contact.id },
    data: {
      queuedForCall: false,
      activeCallUuid: null,
      activeCallStartedAt: null,
      status: OutboundContactStatus.PENDING,
      nextAttemptAt: new Date(Date.now() + 60_000)
    }
  });

  return { removed: false, attempts: contact.attempts };
}

async function releaseStaleQueuedOutboundContacts(tx: Prisma.TransactionClient, now: Date) {
  const staleBefore = new Date(now.getTime() - STALE_OUTBOUND_QUEUE_MS);
  const staleContacts = await tx.outboundContact.findMany({
    where: {
      status: OutboundContactStatus.PENDING,
      queuedForCall: true,
      updatedAt: { lt: staleBefore }
    },
    select: { id: true, attempts: true },
    take: 20
  });

  for (const contact of staleContacts) {
    await releaseOutboundContactWithoutAttempt(tx, contact.id);
  }

  return staleContacts.length;
}

async function finishOutboundContact(
  tx: Prisma.TransactionClient,
  contactId: string,
  userId: string,
  status: CallStatus,
  lastCallLogId?: string
) {
  const contact = await tx.outboundContact.findFirst({
    where: { id: contactId, userId },
    select: { id: true, attempts: true, phone: true, user: { select: { phone: true } } }
  });

  if (!contact) {
    return null;
  }

  // A button-triggered owner test is one-shot; campaign contacts keep their retry policy.
  if (status === CallStatus.SUCCESS || status === CallStatus.ESCALATED || isOwnerTestDestination(contact.user.phone, contact.phone)) {
    await tx.outboundContact.delete({
      where: { id: contact.id }
    });
    return { removed: true, attempts: contact.attempts + 1 };
  }

  return releaseOutboundContactForRetry(tx, contact, lastCallLogId);
}

function scheduleCalendarAutomation(input: {
  userId: string;
  callLogId: string;
  callUuid?: string | null;
  customerPhone: string;
  direction: CallDirection;
  transcript?: string | null;
  createdAt: Date;
  assistantPrompt?: string | null;
}) {
  void (async () => {
    const finalizedEvents = input.callUuid
      ? await finalizeCalendarTranscriptForCall({
          userId: input.userId,
          callUuid: input.callUuid,
          callLogId: input.callLogId,
          customerPhone: input.customerPhone,
          transcript: input.transcript ?? ""
        })
      : 0;
    if (finalizedEvents > 0) {
      return { status: "finalized", updatedEvents: finalizedEvents };
    }
    return maybeSyncCalendarFromCallLog(input);
  })()
    .then((result) => {
      console.log("Google Calendar automation result", {
        callLogId: input.callLogId,
        ...result
      });
    })
    .catch((error: unknown) => {
      console.warn("Google Calendar automation failed", {
        callLogId: input.callLogId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
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
      greetingAudioCache: true,
      user: {
        select: {
          id: true,
          phone: true,
          timeZone: true,
          numberRentExpiresAt: true,
          rubleBalanceKopecks: true,
          googleAccount: {
            select: {
              status: true,
              googleEmail: true,
              calendarId: true,
              connectedAt: true
            }
          },
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

async function findActiveProfileById(assistantProfileId: string, direction?: CallDirection) {
  return prisma.assistantProfile.findFirst({
    where: {
      id: assistantProfileId,
      status: ProfileStatus.ACTIVE,
      ...(direction ? { mode: direction } : {})
    },
    include: {
      reservedNumber: true,
      greetingAudioCache: true,
      user: {
        select: {
          id: true,
          phone: true,
          timeZone: true,
          numberRentExpiresAt: true,
          rubleBalanceKopecks: true,
          googleAccount: {
            select: {
              status: true,
              googleEmail: true,
              calendarId: true,
              connectedAt: true
            }
          },
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

function buildCalendarToolAssistantInstruction(result: CalendarAutomationResult, action: z.infer<typeof calendarActionInputSchema>) {
  if (result.status === "availability") {
    if (result.requestedSlot?.available) {
      return [
        `The caller's exact requested slot ${result.requestedSlot.startDateTime} - ${result.requestedSlot.endDateTime} was checked live and is available.`,
        "Briefly confirm in Russian that this exact time is available, then collect any missing name or phone confirmation.",
        "Do not say that the requested time is unavailable merely because the separate suggestion list is limited.",
        "Do not claim that an event was created until CREATE succeeds."
      ].join(" ");
    }

    if (result.requestedSlot && !result.requestedSlot.available) {
      const alternatives = result.slots
        .slice(0, 3)
        .map((slot) => `${slot.startDateTime} - ${slot.endDateTime}`)
        .join("; ");
      return [
        `The caller's exact requested slot ${result.requestedSlot.startDateTime} - ${result.requestedSlot.endDateTime} was checked live and is unavailable.`,
        alternatives ? `Available alternatives: ${alternatives}.` : "No alternative slots were found in the requested range.",
        "Briefly explain this in Russian and let the caller choose another time.",
        "Do not invent a slot."
      ].join(" ");
    }

    if (!result.available) {
      return [
        "The connected Google Calendar was checked live and has no available slots in the requested range.",
        "Briefly tell the caller in Russian that this exclusive period is unavailable and ask for another day or time range.",
        "Do not invent a slot."
      ].join(" ");
    }

    const slots = result.slots.map((slot) => `${slot.startDateTime} - ${slot.endDateTime}`).join("; ");
    return [
      `The connected Google Calendar was checked live. Available slots in ${result.timeZone}: ${slots}.`,
      "Offer up to three of these slots in Russian and let the caller choose.",
      "This is a limited suggestion list, not proof that every unlisted time is unavailable. Check any exact time named by the caller with another FIND_SLOTS call.",
      "Do not claim that an event was created until CREATE or RESCHEDULE succeeds."
    ].join(" ");
  }

  if (result.status === "appointments") {
    if (!result.found) {
      return [
        "The connected Google Calendar was checked live and no future event matching this caller phone was found.",
        "Tell the caller this briefly in Russian and ask for the identifying details required by the account scenario.",
        "Do not claim that anything was cancelled or moved."
      ].join(" ");
    }

    const appointments = result.appointments
      .map((appointment) => `${appointment.title}: ${appointment.startDateTime} - ${appointment.endDateTime}`)
      .join("; ");
    return [
      `The connected Google Calendar was checked live. Events matching this caller phone in ${result.timeZone}: ${appointments}.`,
      "Briefly identify the matching calendar event in Russian and confirm which one the caller means before CANCEL or RESCHEDULE.",
      "Do not reveal events belonging to other phone numbers."
    ].join(" ");
  }

  const actionText =
    action.action === "CREATE"
      ? "создание события"
      : action.action === "CANCEL"
        ? "отмену события"
        : action.action === "RESCHEDULE"
          ? "перенос события"
          : action.action === "FIND_APPOINTMENTS"
            ? "поиск события"
            : "поиск свободного времени";

  if (result.status === "created" || result.status === "exists") {
    return [
      "Google Calendar подтвердил создание события по сценарию аккаунта.",
      "Коротко подтверди результат словами, подходящими сценарию: запись создана, заказ принят к указанному времени, доставка запланирована и так далее. Повтори только существенные данные разговора.",
      "Не говори, что передашь владельцу или что нужно ждать подтверждения."
    ].join(" ");
  }

  if (result.status === "cancelled") {
    return [
      "Google Calendar подтвердил отмену события.",
      "Коротко подтверди отмену словами, соответствующими сценарию аккаунта.",
      "Не говори, что передашь владельцу или что нужно ждать подтверждения."
    ].join(" ");
  }

  if (result.status === "rescheduled") {
    return [
      "Google Calendar подтвердил перенос события.",
      "Коротко подтверди перенос словами, соответствующими сценарию аккаунта, и повтори новое время.",
      "Не говори, что передашь владельцу или что нужно ждать подтверждения."
    ].join(" ");
  }

  if (result.status === "conflict") {
    if (result.reason === "OUTSIDE_WORKING_HOURS") {
      return "The requested time is outside the working hours declared in the scenario. Explain this briefly in Russian and use FIND_SLOTS for another period.";
    }
    if (result.reason === "SCHEDULE_BREAK") {
      return "The requested time overlaps lunch or another break declared in the scenario. Explain this briefly in Russian and use FIND_SLOTS for another period.";
    }
    return [
      "Запрошенное время занято в Google Calendar.",
      "Скажи клиенту, что это время занято, и попроси выбрать другое время.",
      "Не создавай запись и не обещай подтверждение."
    ].join(" ");
  }

  if (result.status === "not_found") {
    return [
      "Подходящее событие не найдено в Google Calendar.",
      "Скажи клиенту, что не нашёл его по указанным данным, и уточни сведения, подходящие сценарию: дату, время, имя или детали заказа.",
      "Не говори, что запись отменена или перенесена."
    ].join(" ");
  }

  return [
    `Не удалось выполнить ${actionText}.`,
    "Коротко объясни, что календарь сейчас недоступен или данных недостаточно, и уточни недостающие детали.",
    "Владельцу передавай только если клиент просит человека или ситуация вне сценария."
  ].join(" ");
}

voiceInternalRouter.get("/healthz", requireVoiceService, (_req, res) => {
  res.json({ ok: true, service: "voice-internal" });
});

voiceInternalRouter.get("/sip-lines/config", requireSipConfigService, async (_req, res) => {
  if (!env.DATA_ENCRYPTION_KEY || env.DATA_ENCRYPTION_KEY.length < 32) {
    res.status(503).json({ message: "SIP configuration export is unavailable" });
    return;
  }
  try {
    const lines = await prisma.sipLine.findMany({
      where: { enabled: true },
      select: {
        id: true,
        username: true,
        passwordEncrypted: true,
        enabled: true,
        asteriskEndpoint: true,
        server: true,
        port: true,
        transport: true,
        updatedAt: true,
        reservedNumber: { select: { number: true } }
      },
      orderBy: { asteriskEndpoint: "asc" }
    });
    const config = lines.map((line) => {
      const route = safeSipLineRoute(line.reservedNumber.number, line);
      if (!route || !line.passwordEncrypted.startsWith("enc:v2:")) {
        throw new Error("Invalid SIP configuration");
      }
      const password = decryptSecret(line.passwordEncrypted);
      if (!password) throw new Error("Invalid SIP credential");
      parseSipLineProvisionInput({ lines: [{
        number: route.number,
        username: line.username,
        password,
        asteriskEndpoint: route.endpoint,
        server: route.server,
        port: route.port,
        transport: route.transport
      }] });
      return { id: line.id, ...route, username: line.username, password };
    });
    res.json({ ok: true, lines: config });
  } catch {
    res.status(503).json({ message: "SIP configuration export is unavailable" });
  }
});

voiceInternalRouter.post("/calendar/action", requireVoiceService, async (req, res) => {
  const parsed = calendarToolActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const payload = parsed.data;
  const profile = await prisma.assistantProfile.findFirst({
    where: {
      id: payload.assistantProfileId,
      status: ProfileStatus.ACTIVE
    },
    select: {
      id: true,
      userId: true,
      prompt: true
    }
  });

  if (!profile) {
    res.status(404).json({ message: "Assistant profile not found" });
    return;
  }

  const customerPhone = normalizePhone(payload.customerPhone) || payload.customerPhone;
  const callLogId = `voice-${payload.callUuid || randomUUID()}`;
  const result = await syncCalendarAction({
    userId: profile.userId,
    callLogId,
    customerPhone,
    direction: payload.direction === "OUTBOUND" ? CallDirection.OUTBOUND : CallDirection.INBOUND,
    action: payload.action,
    transcript: payload.transcript,
    createdAt: new Date(),
    assistantPrompt: profile.prompt
  });

  res.json({
    ok: true,
    result,
    assistantInstruction: buildCalendarToolAssistantInstruction(result, payload.action)
  });
});

voiceInternalRouter.post("/call/resolve", requireVoiceService, async (req, res) => {
  const parsed = resolveCallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const direction =
    parsed.data.direction === "OUTBOUND"
      ? CallDirection.OUTBOUND
      : parsed.data.direction === "INBOUND"
        ? CallDirection.INBOUND
        : undefined;

  if (!parsed.data.outboundContactId && direction !== CallDirection.OUTBOUND && isPhoneVerificationDid(parsed.data.did)) {
    const verification = await completeLatestPhoneVerificationForCall(parsed.data.callerId);
    if (verification) {
      res.json({
        ok: true,
        call: {
          uuid: parsed.data.uuid ?? null,
          did: parsed.data.did ?? null,
          callerId: parsed.data.callerId ?? null,
          action: "HANGUP",
          reason: "PHONE_VERIFICATION"
        },
        verification: {
          completed: verification.completed,
          reason: verification.reason,
          request: publicPhoneVerificationRequest(verification.request)
        },
        profile: {
          action: "HANGUP",
          reason: "PHONE_VERIFICATION",
          clientId: "phone-verification",
          assistantProfileId: null,
          direction: CallDirection.INBOUND,
          autoGreeting: false,
          maxDialogSeconds: 1
        }
      });
      return;
    }
  }

  const profile = parsed.data.assistantProfileId
    ? await findActiveProfileById(parsed.data.assistantProfileId, direction)
    : await findInboundProfileByDid(parsed.data.did!);

  if (!profile) {
    res.status(404).json({ message: "No active assistant profile for this DID" });
    return;
  }

  const now = new Date();
  const [inboundProfile, outboundContact, testNumber] = await Promise.all([
    prisma.assistantProfile.findUnique({
      where: { userId_mode: { userId: profile.userId, mode: CallDirection.INBOUND } },
      select: { reservedNumber: { select: reservedNumberRouteSelect } }
    }),
    parsed.data.outboundContactId
      ? prisma.outboundContact.findFirst({
          where: { id: parsed.data.outboundContactId, userId: profile.userId },
          select: { id: true, userId: true, phone: true, attempts: true, queuedForCall: true, callMode: true, activeCallUuid: true }
        })
      : null,
    findConfiguredTestSipNumber()
  ]);
  const reservedNumber = inboundProfile?.reservedNumber;
  const isVerifiedOwnerTest = Boolean(
    outboundContact?.queuedForCall &&
      outboundContact.callMode === profile.mode &&
      isOwnerTestDestination(profile.user.phone, outboundContact.phone) &&
      isOwnerTestDestination(profile.user.phone, parsed.data.callerId ?? "")
  );
  const route = resolveOutboundSipRoute({
    ownerPhone: profile.user.phone,
    destinationPhone: outboundContact?.phone ?? parsed.data.callerId ?? "",
    reservedNumber,
    numberRentExpiresAt: profile.user.numberRentExpiresAt,
    testCallerId: isVerifiedOwnerTest ? env.TEST_CALLER_ID : undefined,
    testNumber: isVerifiedOwnerTest ? testNumber : null,
    now
  });
  const outboundCallerId = route?.callerId ?? null;

  if (
    profile.user.numberRentExpiresAt &&
    profile.user.numberRentExpiresAt <= now &&
    !(isVerifiedOwnerTest && outboundCallerId)
  ) {
    res.status(402).json({ message: "Reserved number rent has expired" });
    return;
  }

  if (outboundContact && !outboundCallerId) {
    res.status(409).json({ message: "Нет доступного номера для этого звонка" });
    return;
  }

  const binding = validateVoiceCallBinding({
    request: parsed.data,
    profile,
    ownedNumber: reservedNumber,
    numberRentExpiresAt: profile.user.numberRentExpiresAt,
    outboundContact,
    route,
    now
  });
  if (!binding.ok) {
    res.status(binding.status).json({ message: binding.message });
    return;
  }

  if (profile.user.rubleBalanceKopecks <= 0) {
    res.json({
      ok: true,
      call: {
        uuid: parsed.data.uuid ?? null,
        did: parsed.data.did ?? profile.reservedNumber?.number ?? null,
        callerId: parsed.data.callerId ?? null,
        action: "HANGUP",
        reason: "INSUFFICIENT_BALANCE"
      },
      profile: {
        action: "HANGUP",
        reason: "INSUFFICIENT_BALANCE",
        clientId: profile.id,
        assistantProfileId: profile.id,
        direction: direction ?? profile.mode,
        autoGreeting: false,
        maxDialogSeconds: 1
      }
    });
    return;
  }

  if (!parsed.data.uuid) {
    res.status(400).json({ message: "Call UUID is required" });
    return;
  }
  const callUuid = parsed.data.uuid;
  const customerPhone = normalizePhone(parsed.data.callerId ?? "") || parsed.data.callerId || "unknown";
  let billingSnapshot: Awaited<ReturnType<typeof captureCallBillingSnapshot>>;
  try {
    billingSnapshot = await prisma.$transaction(async (tx) => {
      const snapshot = await captureCallBillingSnapshot(tx, {
        callUuid,
        assistantProfileId: profile.id,
        direction: direction ?? profile.mode,
        customerPhone,
        realtimeModel: profile.realtimeModel
      });
      if (outboundContact) {
        const startedContact = await tx.outboundContact.updateMany({
          where: {
            id: outboundContact.id,
            userId: profile.userId,
            queuedForCall: true,
            callMode: profile.mode,
            phone: outboundContact.phone,
            OR: [{ activeCallUuid: null }, { activeCallUuid: callUuid }]
          },
          data: { activeCallUuid: callUuid, activeCallStartedAt: now }
        });
        if (startedContact.count !== 1) throw new Error("QUEUED_CALL_UNAVAILABLE");
      }
      const activeData = {
        userId: profile.userId,
        assistantProfileId: profile.id,
        outboundContactId: outboundContact?.id ?? null,
        direction: direction ?? profile.mode,
        customerPhone,
        startedAt: now
      };
      await tx.activeCall.upsert({
        where: { callUuid },
        create: { ...activeData, callUuid },
        update: activeData
      });
      return snapshot;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 });
  } catch (error) {
    if (error instanceof Error && [
      "CALL_UUID_COLLISION", "INVALID_CALL_BILLING_SNAPSHOT", "UNSUPPORTED_REALTIME_MODEL", "QUEUED_CALL_UNAVAILABLE"
    ].includes(error.message)) {
      res.status(409).json({ message: "Call billing authorization does not match the current call" });
      return;
    }
    throw error;
  }

  warmCalendarSchedulePolicy(profile.prompt);
  const contactName = outboundContact
    ? await prisma.phoneContactName.findUnique({
        where: { userId_phone: { userId: profile.userId, phone: outboundContact.phone } },
        select: { name: true }
      })
    : null;

  res.json({
    ok: true,
    call: {
      uuid: parsed.data.uuid ?? null,
      did: parsed.data.did ?? outboundCallerId ?? reservedNumber?.number ?? null,
      callerId: parsed.data.callerId ?? null
    },
    profile: mapProfileToVoiceConfig({ ...profile, realtimeModel: billingSnapshot.realtimeModel }, {
      direction,
      outboundCallerId,
      outboundSipLine: route?.sipLine ?? null,
      outboundContact: outboundContact
        ? {
            id: outboundContact.id,
            phone: outboundContact.phone,
            name: contactName?.name ?? null,
            attempts: outboundContact.attempts
          }
        : undefined
    })
  });
});

voiceInternalRouter.post("/outbound/next", requireVoiceService, async (req, res) => {
  const parsed = outboundNextSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const now = new Date();
  const claimed = await prisma.$transaction(
    async (tx) => {
      await releaseStaleQueuedOutboundContacts(tx, now);
      const testNumber = await findConfiguredTestSipNumber(tx);
      return claimNextOutboundContact(tx, { now, testCallerId: env.TEST_CALLER_ID, testNumber });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 15_000
    }
  );

  if (!claimed) {
    res.json({ ok: true, job: null });
    return;
  }

  const callMode = claimed.callMode ?? CallDirection.OUTBOUND;

  const [profile, inboundProfile, contactName, testNumber] = await Promise.all([
    prisma.assistantProfile.findUnique({
      where: { userId_mode: { userId: claimed.userId, mode: callMode } },
      include: {
        reservedNumber: true,
        greetingAudioCache: true,
        user: {
          select: {
            id: true,
            phone: true,
            timeZone: true,
            numberRentExpiresAt: true,
            rubleBalanceKopecks: true,
            googleAccount: {
              select: {
                status: true,
                googleEmail: true,
                calendarId: true,
                connectedAt: true
              }
            },
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
    }),
    prisma.assistantProfile.findUnique({
      where: { userId_mode: { userId: claimed.userId, mode: CallDirection.INBOUND } },
      select: { reservedNumber: { select: reservedNumberRouteSelect } }
    }),
    prisma.phoneContactName.findUnique({
      where: { userId_phone: { userId: claimed.userId, phone: claimed.phone } },
      select: { name: true }
    }),
    findConfiguredTestSipNumber()
  ]);

  if (!profile || profile.status !== ProfileStatus.ACTIVE) {
    await prisma.outboundContact.update({
      where: { id: claimed.id },
      data: { queuedForCall: false }
    });
    res.status(404).json({ message: "No active assistant profile for queued call mode" });
    return;
  }

  const route = resolveOutboundSipRoute({
    ownerPhone: profile.user.phone,
    destinationPhone: claimed.phone,
    reservedNumber: inboundProfile?.reservedNumber,
    numberRentExpiresAt: profile.user.numberRentExpiresAt,
    testCallerId: env.TEST_CALLER_ID,
    testNumber,
    now: new Date()
  });
  if (!route) {
    await releaseOutboundContactWithoutAttempt(prisma, claimed.id);
    res.json({ ok: true, job: null });
    return;
  }

  res.json({
    ok: true,
    job: {
      id: claimed.id,
      phone: claimed.phone,
      attempts: claimed.attempts,
      nextAttemptAt: claimed.nextAttemptAt
    },
    profile: mapProfileToVoiceConfig(profile, {
      direction: callMode,
      outboundCallerId: route.callerId,
      outboundSipLine: route.sipLine,
      outboundContact: {
        id: claimed.id,
        phone: claimed.phone,
        name: contactName?.name ?? null,
        attempts: claimed.attempts
      }
    })
  });
});

voiceInternalRouter.post("/outbound/release", requireVoiceService, async (req, res) => {
  const parsed = outboundReleaseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const result = await prisma.$transaction(
    async (tx) => {
      const contact = await tx.outboundContact.findUnique({
        where: { id: parsed.data.outboundContactId },
        select: { id: true, attempts: true }
      });

      if (!contact) {
        return null;
      }

      if (parsed.data.countAttempt === false) {
        return releaseOutboundContactWithoutAttempt(tx, contact.id);
      }

      return releaseOutboundContactForRetry(tx, contact);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  await prisma.activeCall.deleteMany({
    where: { outboundContactId: parsed.data.outboundContactId }
  });

  res.json({ ok: true, result, reason: parsed.data.reason ?? null });
});

voiceInternalRouter.post("/call/ended", requireVoiceService, async (req, res) => {
  const parsed = callEndedSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const removed = await tx.activeCall.deleteMany({
      where: { callUuid: parsed.data.callUuid }
    });

    const released = parsed.data.outboundContactId
      ? await tx.outboundContact.updateMany({
          where: {
            id: parsed.data.outboundContactId,
            activeCallUuid: parsed.data.callUuid
          },
          data: { activeCallStartedAt: null }
        })
      : { count: 0 };

    return { removedActiveCalls: removed.count, markedEndedContacts: released.count };
  });

  res.json({ ok: true, result });
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
        select: { id: true, userId: true, mode: true, prompt: true }
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
    const result = await persistVoiceCallCallback(
      prisma,
      {
        userId: profile.userId,
        callUuid: payload.callUuid,
        assistantProfileId: profile.id,
        direction,
        customerPhone,
        status: payload.status,
        durationSeconds: payload.durationSeconds,
        summary,
        transcript: payload.transcript,
        recordingUrl: payload.recordingUrl
      },
      async (tx, callLogId) => payload.outboundContactId
        ? finishOutboundContact(tx, payload.outboundContactId, profile.userId, payload.status, callLogId)
        : null
    );

    if (result.created && payload.status === CallStatus.SUCCESS) {
      scheduleCalendarAutomation({
        userId: profile.userId,
        callLogId: result.log.id,
        callUuid: payload.callUuid,
        customerPhone,
        direction,
        transcript: payload.transcript,
        createdAt: result.log.createdAt,
        assistantPrompt: profile.prompt
      });
    }

    scheduleCallLogTelegramDelivery(result.log.id);
    res.status(201).json({ ok: true, log: result.log, outbound: result.outbound });
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
      res.status(402).json({ message: "Not enough balance to save a billable call log" });
      return;
    }
    if (error instanceof Error && error.message === "PROFILE_NOT_FOUND") {
      res.status(404).json({ message: "Create assistant profile first" });
      return;
    }
    if (error instanceof Error && error.message === "PROFILE_DIRECTION_MISMATCH") {
      res.status(409).json({ message: "Call direction does not match the assistant profile" });
      return;
    }
    if (error instanceof Error && error.message === "CALL_UUID_COLLISION") {
      res.status(409).json({ message: "Call UUID belongs to another profile or direction" });
      return;
    }
    if (error instanceof Error && ["CALL_BILLING_SNAPSHOT_NOT_FOUND", "INVALID_CALL_BILLING_SNAPSHOT"].includes(error.message)) {
      res.status(409).json({ message: "The authorized billing snapshot for this call is unavailable" });
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

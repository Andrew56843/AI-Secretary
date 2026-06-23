import { randomUUID, timingSafeEqual } from "crypto";
import { CallDirection, CallStatus, OutboundContactStatus, Prisma, ProfileStatus } from "@prisma/client";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { createBillableCallLog } from "../lib/billable-call.js";
import {
  calendarActionInputSchema,
  maybeSyncCalendarFromCallLog,
  syncCalendarAction,
  type CalendarAutomationResult
} from "../lib/google-calendar.js";
import { kopecksToRubles } from "../lib/money.js";
import { normalizePhone } from "../lib/phone.js";
import {
  completeLatestPhoneVerificationForCall,
  isPhoneVerificationDid,
  publicPhoneVerificationRequest
} from "../lib/phone-verification.js";
import { prisma } from "../lib/prisma.js";
import { deliverTelegramTranscript } from "../lib/telegram.js";

const voiceInternalRouter = Router();
const REALTIME_TRANSCRIPTION_PROMPT_MAX_LENGTH = 1024;

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

const outboundNextSchema = z.object({
  limit: z.number().int().min(1).max(5).default(1).optional()
});

const outboundReleaseSchema = z.object({
  outboundContactId: z.string().trim().min(1),
  reason: z.string().trim().max(400).optional()
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

function compactPromptText(value: string | null | undefined, maxLength: number) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function clampTranscriptionPrompt(prompt: string) {
  if (prompt.length <= REALTIME_TRANSCRIPTION_PROMPT_MAX_LENGTH) {
    return prompt;
  }

  return `${prompt.slice(0, REALTIME_TRANSCRIPTION_PROMPT_MAX_LENGTH - 3).trimEnd()}...`;
}

function createProfileTranscriptionPrompt(profile: {
  mode: CallDirection;
  title: string;
  businessName: string | null;
  prompt: string;
}) {
  const scenario = compactPromptText(profile.prompt, 1600);
  const businessName = compactPromptText(profile.businessName, 160);
  const title = compactPromptText(profile.title, 160);

  const prompt = [
    "Русский телефонный разговор с AI-секретарём.",
    profile.mode === CallDirection.OUTBOUND
      ? "Тип звонка: исходящий звонок от AI-секретаря клиенту."
      : "Тип звонка: входящий звонок клиента AI-секретарю.",
    businessName ? `Компания или проект: ${businessName}.` : "",
    title ? `Название сценария: ${title}.` : "",
    "Ожидаемые темы, имена, услуги, адреса, товары и формулировки бери из сценария ниже.",
    "Сохраняй короткие русские ответы как короткие ответы: да, нет, ага, алло, повтори, тот же номер.",
    "Не заменяй слова из сценария случайными фамилиями или похожими по звучанию словами.",
    scenario ? `Сценарий профиля: ${scenario}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  return clampTranscriptionPrompt(prompt);
}

function mapProfileToVoiceConfig(
  profile: Prisma.AssistantProfileGetPayload<{
    include: {
      reservedNumber: true;
      user: {
        select: {
          id: true;
          phone: true;
          timeZone: true;
          numberRentExpiresAt: true;
          rubleBalance: true;
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
  } = {}
) {
  const maxDialogSeconds = Math.max(15, profile.maxDialogSeconds);

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
    greetingText: createExactGreetingInstruction(profile.greetingText),
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
      status: OutboundContactStatus.PENDING,
      attempts,
      nextAttemptAt: new Date(Date.now() + 15 * 60 * 1000),
      ...(lastCallLogId ? { lastCallLogId } : {})
    }
  });

  return { removed: false, attempts };
}

async function finishOutboundContact(
  tx: Prisma.TransactionClient,
  contactId: string,
  status: CallStatus,
  lastCallLogId?: string
) {
  const contact = await tx.outboundContact.findUnique({
    where: { id: contactId },
    select: { id: true, attempts: true }
  });

  if (!contact) {
    return null;
  }

  if (status === CallStatus.SUCCESS || status === CallStatus.ESCALATED) {
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
  customerPhone: string;
  direction: CallDirection;
  transcript?: string | null;
  createdAt: Date;
  assistantPrompt?: string | null;
}) {
  void maybeSyncCalendarFromCallLog(input)
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
      user: {
        select: {
          id: true,
          phone: true,
          timeZone: true,
          numberRentExpiresAt: true,
          rubleBalance: true,
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
      user: {
        select: {
          id: true,
          phone: true,
          timeZone: true,
          numberRentExpiresAt: true,
          rubleBalance: true,
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
  const actionText =
    action.action === "CREATE" ? "запись" : action.action === "CANCEL" ? "отмену записи" : "перенос записи";

  if (result.status === "created" || result.status === "exists") {
    return [
      "Google Calendar подтвердил создание записи.",
      "Коротко скажи клиенту, что запись сделана, повтори дату, время, услугу и имя, если они есть в разговоре.",
      "Не говори, что передашь владельцу или что нужно ждать подтверждения."
    ].join(" ");
  }

  if (result.status === "cancelled") {
    return [
      "Google Calendar подтвердил отмену записи.",
      "Коротко скажи клиенту, что запись отменена.",
      "Не говори, что передашь владельцу или что нужно ждать подтверждения."
    ].join(" ");
  }

  if (result.status === "rescheduled") {
    return [
      "Google Calendar подтвердил перенос записи.",
      "Коротко скажи клиенту, что запись перенесена, повтори новое время.",
      "Не говори, что передашь владельцу или что нужно ждать подтверждения."
    ].join(" ");
  }

  if (result.status === "conflict") {
    return [
      "Запрошенное время занято в Google Calendar.",
      "Скажи клиенту, что это время занято, и попроси выбрать другое время.",
      "Не создавай запись и не обещай подтверждение."
    ].join(" ");
  }

  if (result.status === "not_found") {
    return [
      "Активная запись не найдена в Google Calendar.",
      "Скажи клиенту, что не нашёл запись по указанным данным, и уточни дату, время или имя.",
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
      userId: true
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
    createdAt: new Date()
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

  if (isPhoneVerificationDid(parsed.data.did)) {
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
  if (profile.user.numberRentExpiresAt && profile.user.numberRentExpiresAt < now) {
    res.status(402).json({ message: "Reserved number rent has expired" });
    return;
  }

  const [inboundProfile, outboundContact] = await Promise.all([
    direction === CallDirection.OUTBOUND
      ? prisma.assistantProfile.findUnique({
          where: { userId_mode: { userId: profile.userId, mode: CallDirection.INBOUND } },
          include: { reservedNumber: true }
        })
      : null,
    parsed.data.outboundContactId
      ? prisma.outboundContact.findFirst({
          where: { id: parsed.data.outboundContactId, userId: profile.userId },
          select: { id: true, phone: true, attempts: true }
        })
      : null
  ]);

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
      did:
        parsed.data.did ??
        (direction === CallDirection.OUTBOUND
          ? inboundProfile?.reservedNumber?.number ?? profile.reservedNumber?.number ?? null
          : profile.reservedNumber?.number ?? inboundProfile?.reservedNumber?.number ?? null),
      callerId: parsed.data.callerId ?? null
    },
    profile: mapProfileToVoiceConfig(profile, {
      direction,
      outboundCallerId: inboundProfile?.reservedNumber?.number ?? null,
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
      const candidates = await tx.outboundContact.findMany({
        where: {
          status: OutboundContactStatus.PENDING,
          queuedForCall: false,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          user: {
            rubleBalanceKopecks: { gt: 0 }
          },
          AND: [
            {
              OR: [
                {
                  callMode: CallDirection.OUTBOUND,
                  user: { profiles: { some: { mode: CallDirection.OUTBOUND, status: ProfileStatus.ACTIVE } } }
                },
                {
                  callMode: CallDirection.INBOUND,
                  user: { profiles: { some: { mode: CallDirection.INBOUND, status: ProfileStatus.ACTIVE } } }
                }
              ]
            }
          ]
        },
        include: {
          user: {
            select: {
              phone: true,
              numberRentExpiresAt: true,
              profiles: {
                where: {
                  mode: CallDirection.INBOUND,
                  status: ProfileStatus.ACTIVE
                },
                select: {
                  reservedNumberId: true
                }
              }
            }
          }
        },
        orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
        take: 10
      });

      for (const candidate of candidates) {
        const candidatePhone = normalizePhone(candidate.phone);
        const ownerPhone = normalizePhone(candidate.user.phone);
        const isTestCall = Boolean(candidatePhone && ownerPhone && candidatePhone === ownerPhone);
        const hasActiveReservedNumber = Boolean(
          candidate.user.numberRentExpiresAt &&
            candidate.user.numberRentExpiresAt > now &&
            candidate.user.profiles.some((profile) => profile.reservedNumberId)
        );

        if (!isTestCall && !hasActiveReservedNumber) {
          continue;
        }

        const result = await tx.outboundContact.updateMany({
          where: {
            id: candidate.id,
            status: OutboundContactStatus.PENDING,
            queuedForCall: false
          },
          data: {
            queuedForCall: true
          }
        });

        if (result.count === 1) {
          return candidate;
        }
      }

      return null;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  if (!claimed) {
    res.json({ ok: true, job: null });
    return;
  }

  const callMode = claimed.callMode ?? CallDirection.OUTBOUND;

  const [profile, inboundProfile, contactName] = await Promise.all([
    prisma.assistantProfile.findUnique({
      where: { userId_mode: { userId: claimed.userId, mode: callMode } },
      include: {
        reservedNumber: true,
        user: {
          select: {
            id: true,
            phone: true,
            timeZone: true,
            numberRentExpiresAt: true,
            rubleBalance: true,
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
      include: { reservedNumber: true }
    }),
    prisma.phoneContactName.findUnique({
      where: { userId_phone: { userId: claimed.userId, phone: claimed.phone } },
      select: { name: true }
    })
  ]);

  if (!profile || profile.status !== ProfileStatus.ACTIVE) {
    await prisma.outboundContact.update({
      where: { id: claimed.id },
      data: { queuedForCall: false }
    });
    res.status(404).json({ message: "No active assistant profile for queued call mode" });
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
      outboundCallerId: inboundProfile?.reservedNumber?.number ?? profile.reservedNumber?.number ?? null,
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

      return releaseOutboundContactForRetry(tx, contact);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  res.json({ ok: true, result, reason: parsed.data.reason ?? null });
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
    const result = await prisma.$transaction(
      async (tx) => {
        const log = await createBillableCallLog(tx, {
          userId: profile.userId,
          direction,
          customerPhone,
          status: payload.status,
          durationSeconds: payload.durationSeconds,
          summary,
          transcript: payload.transcript,
          recordingUrl: payload.recordingUrl
        });

        const outbound =
          payload.outboundContactId
            ? await finishOutboundContact(tx, payload.outboundContactId, payload.status, log.id)
            : null;

        return { log, outbound };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    if (payload.status === CallStatus.SUCCESS) {
      scheduleCalendarAutomation({
        userId: profile.userId,
        callLogId: result.log.id,
        customerPhone,
        direction,
        transcript: payload.transcript,
        createdAt: result.log.createdAt,
        assistantPrompt: profile.prompt
      });
    }

    const deliveredLog = await deliverTelegramTranscript(result.log.id);

    res.status(201).json({ ok: true, log: deliveredLog ?? result.log, outbound: result.outbound });
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

import { TranscriptChannel, TranscriptDeliveryStatus } from "@prisma/client";
import { env } from "../config.js";
import { prisma } from "./prisma.js";

const TELEGRAM_API_URL = "https://api.telegram.org";
const MAX_TEXT_MESSAGE_LENGTH = 3900;
const MAX_CAPTION_LENGTH = 900;

type TelegramApiResponse = {
  ok?: boolean;
  description?: string;
};

type TelegramTargetInput = {
  chatId?: string | null;
  username?: string | null;
};

function buildTelegramTarget(account: TelegramTargetInput | null | undefined) {
  if (account?.chatId) {
    return account.chatId;
  }
  if (account?.username) {
    return account.username.startsWith("@") ? account.username : `@${account.username}`;
  }
  return null;
}

function normalizePhoneForTelegram(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/\D/g, "");

  if (!digits) {
    return raw || "unknown";
  }
  if (digits.length === 11 && digits.startsWith("8")) {
    return `+7${digits.slice(1)}`;
  }
  if (digits.length === 10 && digits.startsWith("9")) {
    return `+7${digits}`;
  }
  if (raw.startsWith("+")) {
    return `+${digits}`;
  }

  return `+${digits}`;
}

function buildTranscriptHeader(input: { direction?: string | null; customerPhone?: string | null }) {
  const direction = String(input.direction ?? "").toUpperCase() === "OUTBOUND" ? "out" : "in";
  return `call ${direction} ${normalizePhoneForTelegram(input.customerPhone)} end`;
}

function stripLegacyTranscriptHeaders(value: string) {
  let transcript = value.trim();

  while (true) {
    const next = transcript
      .replace(/^call\s+(?:in|out)\s+\+?[0-9][0-9\s().-]*\s+end\s*/i, "")
      .replace(/^call\s+end\s*/i, "")
      .trimStart();

    if (next === transcript) {
      return transcript.trim();
    }

    transcript = next;
  }
}

function buildTranscriptMessage(input: { direction?: string | null; customerPhone?: string | null; transcript?: string | null }) {
  const header = buildTranscriptHeader(input);
  const transcript = stripLegacyTranscriptHeaders(String(input.transcript ?? ""));
  return [header, transcript].filter(Boolean).join("\n\n");
}

async function postTelegramJson(method: string, body: Record<string, unknown>) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const response = await fetch(`${TELEGRAM_API_URL}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = (await response.json().catch(() => ({}))) as TelegramApiResponse;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description ?? `Telegram ${method} failed`);
  }
}

async function postTelegramDocument(chatId: string, message: string, fileName: string) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const form = new FormData();
  form.append("chat_id", chatId);
  const captionHeader = message.split(/\r?\n/, 1)[0] || "call end";
  form.append("caption", `${captionHeader}\nТранскрипт во вложении.`.slice(0, MAX_CAPTION_LENGTH));
  form.append("document", new Blob([message], { type: "text/plain;charset=utf-8" }), fileName);

  const response = await fetch(`${TELEGRAM_API_URL}/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form
  });

  const payload = (await response.json().catch(() => ({}))) as TelegramApiResponse;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description ?? "Telegram sendDocument failed");
  }
}

async function sendTelegramTranscript(chatId: string, callLogId: string, message: string) {
  if (message.length <= MAX_TEXT_MESSAGE_LENGTH) {
    await postTelegramJson("sendMessage", {
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true
    });
    return;
  }

  await postTelegramDocument(chatId, message, `call-${callLogId}.txt`);
}

export async function deliverTelegramTranscript(callLogId: string) {
  const log = await prisma.callLog.findUnique({
    where: { id: callLogId },
    include: {
      transcriptDeliveries: {
        where: { channel: TranscriptChannel.TELEGRAM },
        orderBy: { createdAt: "desc" },
        take: 1
      },
      assistantProfile: {
        select: {
          user: {
            select: {
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
      }
    }
  });

  if (!log) {
    return null;
  }

  const delivery = log.transcriptDeliveries[0];
  if (!delivery || delivery.status === TranscriptDeliveryStatus.SENT) {
    return prisma.callLog.findUnique({
      where: { id: callLogId },
      include: { transcriptDeliveries: true }
    });
  }

  const telegram = log.assistantProfile.user.telegramAccount;
  const target = buildTelegramTarget(telegram);
  const message = buildTranscriptMessage(log);

  try {
    if (telegram?.status !== "CONNECTED" || !target) {
      throw new Error("Telegram account is not connected");
    }
    if (!log.transcript?.trim()) {
      throw new Error("Call transcript is empty");
    }

    await sendTelegramTranscript(target, callLogId, message);
    await prisma.transcriptDelivery.update({
      where: { id: delivery.id },
      data: {
        status: TranscriptDeliveryStatus.SENT,
        target,
        payloadPreview: message.slice(0, 700)
      }
    });
  } catch (error) {
    await prisma.transcriptDelivery.update({
      where: { id: delivery.id },
      data: {
        status: TranscriptDeliveryStatus.FAILED,
        target,
        payloadPreview: String(error instanceof Error ? error.message : error).slice(0, 700)
      }
    });
  }

  return prisma.callLog.findUnique({
    where: { id: callLogId },
    include: { transcriptDeliveries: true }
  });
}

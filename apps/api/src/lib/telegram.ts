import { TranscriptChannel, TranscriptDeliveryStatus } from "@prisma/client";
import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { env } from "../config.js";
import { prisma } from "./prisma.js";

const TELEGRAM_API_URL = "https://api.telegram.org";
const MAX_TEXT_MESSAGE_LENGTH = 3900;
const MAX_CAPTION_LENGTH = 900;
const MAX_RESPONSE_BYTES = 256 * 1024;
export const TELEGRAM_DELIVERY_STALE_MS = 120_000;

export class TelegramDeliveryError extends Error {
  constructor(readonly outcome: "FAILED" | "UNKNOWN", message: string) {
    super(message);
  }
}

type TelegramApiResponse = {
  ok?: boolean;
  description?: string;
};

type TelegramHttpResponse = {
  statusCode: number;
  payload: TelegramApiResponse;
};

type TelegramTargetInput = {
  chatId?: string | null;
  username?: string | null;
};

function buildTelegramTarget(account: TelegramTargetInput | null | undefined) {
  const chatId = String(account?.chatId ?? "").trim();
  return /^-?[1-9]\d{0,19}$/.test(chatId) ? chatId : null;
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

function createTelegramProxyAgent(proxyUrl: string) {
  if (proxyUrl.startsWith("socks://") || proxyUrl.startsWith("socks4://") || proxyUrl.startsWith("socks5://")) {
    return new SocksProxyAgent(proxyUrl) as unknown as http.Agent;
  }

  return new HttpsProxyAgent(proxyUrl) as unknown as http.Agent;
}

const telegramProxyAgent = env.TELEGRAM_PROXY_URL ? createTelegramProxyAgent(env.TELEGRAM_PROXY_URL) : undefined;

function requestTelegram(method: string, body: Buffer, contentType: string): Promise<TelegramHttpResponse> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return Promise.reject(new TelegramDeliveryError("FAILED", "Telegram bot is not configured"));
  }

  const url = new URL(`${TELEGRAM_API_URL}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new TelegramDeliveryError("UNKNOWN", "Telegram delivery result is unknown; automatic resend is disabled"));
    };
    const request = https.request(
      url,
      {
        method: "POST",
        agent: telegramProxyAgent,
        headers: {
          "Content-Type": contentType,
          "Content-Length": body.length
        },
        timeout: 30_000
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            fail();
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on("aborted", fail);
        response.on("error", fail);
        response.on("end", () => {
          if (settled) return;
          const responseText = Buffer.concat(chunks).toString("utf8");
          let payload: TelegramApiResponse = {};
          try {
            payload = responseText ? (JSON.parse(responseText) as TelegramApiResponse) : {};
          } catch {
            fail();
            return;
          }
          settled = true;
          clearTimeout(deadline);
          resolve({ statusCode: response.statusCode ?? 0, payload });
        });
      }
    );

    deadline = setTimeout(() => { fail(); request.destroy(); }, 30_000);
    request.on("timeout", () => { fail(); request.destroy(); });
    request.on("error", fail);
    request.end(body);
  });
}

function requireTelegramSuccess({ statusCode, payload }: TelegramHttpResponse) {
  if (statusCode >= 200 && statusCode < 300 && payload?.ok === true) return;
  const rejected = payload?.ok === false && statusCode >= 200 && statusCode < 500;
  throw new TelegramDeliveryError(rejected ? "FAILED" : "UNKNOWN", rejected
    ? "Telegram rejected the delivery"
    : "Telegram delivery result is unknown; automatic resend is disabled");
}

function multipartTextField(boundary: string, name: string, value: string) {
  return Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`,
    "utf8"
  );
}

async function postTelegramJson(method: string, body: Record<string, unknown>) {
  const requestBody = Buffer.from(JSON.stringify(body), "utf8");
  requireTelegramSuccess(await requestTelegram(method, requestBody, "application/json"));
}

async function postTelegramDocument(chatId: string, message: string, fileName: string) {
  const captionHeader = message.split(/\r?\n/, 1)[0] || "call end";
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const boundary = `----callsec-${randomBytes(12).toString("hex")}`;
  const documentHeader = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="document"; filename="${safeFileName}"\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n\r\n",
    "utf8"
  );
  const requestBody = Buffer.concat([
    multipartTextField(boundary, "chat_id", chatId),
    multipartTextField(
      boundary,
      "caption",
      `${captionHeader}\nТранскрипт во вложении.`.slice(0, MAX_CAPTION_LENGTH)
    ),
    documentHeader,
    Buffer.from(message, "utf8"),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
  ]);
  requireTelegramSuccess(await requestTelegram(
    "sendDocument",
    requestBody,
    `multipart/form-data; boundary=${boundary}`
  ));
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

export async function deliverTelegramTranscript(callLogId: string, send = sendTelegramTranscript) {
  // Serialize every historical delivery row for this call; never keep the transaction open during HTTP.
  const claim = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('callsec:telegram-transcript'), hashtext(${callLogId}))`;
    const log = await tx.callLog.findUnique({
      where: { id: callLogId },
      include: {
        transcriptDeliveries: {
          where: { channel: TranscriptChannel.TELEGRAM },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }]
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
    if (!log) return null;
    const deliveries = log.transcriptDeliveries;
    const staleAt = new Date(Date.now() - TELEGRAM_DELIVERY_STALE_MS);
    const stale = deliveries.filter((delivery) => delivery.status === TranscriptDeliveryStatus.SENDING &&
      (!delivery.claimedAt || delivery.claimedAt <= staleAt));
    if (stale.length) {
      await tx.transcriptDelivery.updateMany({
        where: { id: { in: stale.map((delivery) => delivery.id) }, status: TranscriptDeliveryStatus.SENDING },
        data: {
          status: TranscriptDeliveryStatus.UNKNOWN,
          claimToken: null,
          payloadPreview: "Interrupted Telegram delivery has an unknown result; automatic resend is disabled"
        }
      });
    }
    if (deliveries.some((delivery) => delivery.status === TranscriptDeliveryStatus.SENT ||
        delivery.status === TranscriptDeliveryStatus.SENDING || delivery.status === TranscriptDeliveryStatus.UNKNOWN ||
        delivery.status === TranscriptDeliveryStatus.FAILED)) return null;
    const delivery = deliveries.find((row) => row.status === TranscriptDeliveryStatus.PENDING);
    if (!delivery) return null;
    const telegram = log.assistantProfile.user.telegramAccount;
    const target = buildTelegramTarget(telegram);
    const message = buildTranscriptMessage(log);
    let failure: string | null = null;
    if (telegram?.status !== "CONNECTED" || !target) {
      failure = "Telegram account is not connected to a valid chat";
    } else if (!log.transcript?.trim()) {
      failure = "Call transcript is empty";
    } else if (!env.TELEGRAM_BOT_TOKEN) {
      failure = "Telegram bot is not configured";
    }
    if (failure) {
      await tx.transcriptDelivery.updateMany({
        where: { id: delivery.id, status: TranscriptDeliveryStatus.PENDING },
        data: { status: TranscriptDeliveryStatus.FAILED, target, payloadPreview: failure }
      });
      return null;
    }
    const claimToken = randomBytes(24).toString("hex");
    const claimed = await tx.transcriptDelivery.updateMany({
      where: { id: delivery.id, status: TranscriptDeliveryStatus.PENDING },
      data: {
        status: TranscriptDeliveryStatus.SENDING,
        claimToken,
        claimedAt: new Date(),
        target,
        payloadPreview: message.slice(0, 700)
      }
    });
    return claimed.count === 1 ? { deliveryId: delivery.id, claimToken, target: target!, message } : null;
  });

  if (claim) {
    let status: TranscriptDeliveryStatus = TranscriptDeliveryStatus.SENT;
    let payloadPreview = claim.message.slice(0, 700);
    try {
      await send(claim.target, callLogId, claim.message);
    } catch (error) {
      status = error instanceof TelegramDeliveryError && error.outcome === "FAILED"
        ? TranscriptDeliveryStatus.FAILED : TranscriptDeliveryStatus.UNKNOWN;
      payloadPreview = status === TranscriptDeliveryStatus.FAILED ? "Telegram rejected the delivery"
        : "Telegram delivery result is unknown; automatic resend is disabled";
    }
    // A persistence error must leave SENDING intact: Telegram may already have accepted the message.
    await prisma.transcriptDelivery.updateMany({
      where: { id: claim.deliveryId, claimToken: claim.claimToken, status: TranscriptDeliveryStatus.SENDING },
      data: {
        status,
        claimToken: null,
        payloadPreview
      }
    });
  }

  return prisma.callLog.findUnique({
    where: { id: callLogId },
    include: { transcriptDeliveries: true }
  });
}

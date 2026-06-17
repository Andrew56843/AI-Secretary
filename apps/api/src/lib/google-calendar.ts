import type { CallDirection, GoogleAccount } from "@prisma/client";
import { z } from "zod";
import { env } from "../config.js";
import { OpenAiRequestError, postOpenAiJson } from "./openai.js";
import { prisma } from "./prisma.js";
import { decryptSecret, encryptSecret } from "./secret-box.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";
const CALENDAR_TIME_ZONE = "Europe/Moscow";
const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000;
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

const openAiChatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional()
        })
      })
    )
    .min(1)
});

const appointmentExtractionSchema = z.object({
  shouldCreateEvent: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
  title: z.string().trim().max(200).optional().nullable(),
  customerName: z.string().trim().max(120).optional().nullable(),
  reason: z.string().trim().max(240).optional().nullable(),
  startDateTime: z.string().trim().max(80).optional().nullable(),
  endDateTime: z.string().trim().max(80).optional().nullable()
});

type AppointmentExtraction = z.infer<typeof appointmentExtractionSchema>;

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

type GoogleCalendarEventResponse = {
  id?: string;
  htmlLink?: string;
  summary?: string;
};

type GoogleCalendarEventListResponse = {
  items?: GoogleCalendarEventResponse[];
};

export type CalendarAutomationResult =
  | { status: "skipped"; reason: string }
  | { status: "created" | "exists"; eventId: string | null; htmlLink: string | null };

export class GoogleCalendarError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly payload?: unknown
  ) {
    super(message);
  }
}

function hasCalendarScope(scope: string | null | undefined) {
  return String(scope ?? "").split(/\s+/).some((item) => item === "https://www.googleapis.com/auth/calendar");
}

function getGoogleOAuthConfig() {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new GoogleCalendarError("Google OAuth is not configured");
  }

  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET
  };
}

function getReferenceDateTime(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CALENDAR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}+03:00`;
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

function isValidDateTime(value: string | null | undefined) {
  if (!value || !value.includes("T")) {
    return false;
  }

  return Number.isFinite(Date.parse(value));
}

function addDefaultDuration(startDateTime: string) {
  return new Date(Date.parse(startDateTime) + DEFAULT_EVENT_DURATION_MS).toISOString();
}

function buildExtractionRequest(input: {
  transcript: string;
  customerPhone: string;
  direction: CallDirection;
  createdAt: Date;
}) {
  return {
    model: env.PROMPT_EDITOR_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You extract appointment events from Russian AI phone secretary transcripts.",
          "Return strict JSON only.",
          "Create an event only when the assistant clearly confirmed that an appointment was booked or recorded.",
          "Do not create an event for vague interest, questions, cancelled appointments, failed calls, or escalation.",
          `Use ${CALENDAR_TIME_ZONE} as the business time zone.`,
          `The reference local date-time for relative phrases is ${getReferenceDateTime(input.createdAt)}.`,
          "Resolve phrases like 'tomorrow' relative to the reference date.",
          "If the transcript confirms a start time but no duration, use 60 minutes.",
          "Return ISO 8601 date-times with an offset, for example 2026-06-18T13:00:00+03:00.",
          "JSON shape: {\"shouldCreateEvent\":boolean,\"confidence\":number,\"title\":string|null,\"customerName\":string|null,\"reason\":string|null,\"startDateTime\":string|null,\"endDateTime\":string|null}."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          direction: input.direction,
          customerPhone: input.customerPhone,
          transcript: input.transcript.slice(0, 20_000)
        })
      }
    ]
  };
}

function normalizeExtractedAppointment(extracted: AppointmentExtraction) {
  if (!extracted.shouldCreateEvent || (extracted.confidence ?? 1) < 0.65) {
    return null;
  }
  if (!isValidDateTime(extracted.startDateTime)) {
    return null;
  }

  const startDateTime = extracted.startDateTime!;
  const endDateTime = isValidDateTime(extracted.endDateTime)
    ? extracted.endDateTime!
    : addDefaultDuration(startDateTime);

  return {
    ...extracted,
    startDateTime,
    endDateTime
  };
}

function buildEventSummary(extracted: AppointmentExtraction) {
  const name = extracted.customerName?.trim();
  const reason = extracted.reason?.trim();
  const generated = [name, reason].filter(Boolean).join(" - ");

  return (extracted.title?.trim() || generated || "Callsec appointment").slice(0, 200);
}

function buildEventDescription(input: {
  callLogId: string;
  customerPhone: string;
  transcript: string;
  extracted: AppointmentExtraction;
}) {
  const lines = [
    "Created automatically by Callsec from a completed phone call.",
    `Call log ID: ${input.callLogId}`,
    `Customer phone: ${input.customerPhone}`
  ];

  if (input.extracted.customerName) {
    lines.push(`Customer name: ${input.extracted.customerName}`);
  }
  if (input.extracted.reason) {
    lines.push(`Reason: ${input.extracted.reason}`);
  }

  lines.push("", "Transcript:", input.transcript.slice(0, 6000));
  return lines.join("\n");
}

async function refreshGoogleAccessToken(account: GoogleAccount) {
  const refreshToken = decryptSecret(account.refreshToken);
  if (!refreshToken) {
    throw new GoogleCalendarError("Google refresh token is missing");
  }

  const config = getGoogleOAuthConfig();
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = (await response.json().catch(() => ({}))) as GoogleTokenResponse;

  if (!response.ok || !payload.access_token) {
    throw new GoogleCalendarError(
      payload.error_description ?? payload.error ?? "Google access token refresh failed",
      response.status,
      payload
    );
  }

  await prisma.googleAccount.update({
    where: { id: account.id },
    data: {
      accessToken: encryptSecret(payload.access_token),
      tokenExpiresAt: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000),
      scope: payload.scope ?? account.scope
    }
  });

  return payload.access_token;
}

async function getGoogleAccessToken(account: GoogleAccount) {
  if (!hasCalendarScope(account.scope)) {
    throw new GoogleCalendarError("Google Calendar scope is not granted");
  }

  const encryptedAccessToken = account.accessToken;
  const expiresAt = account.tokenExpiresAt?.getTime() ?? 0;
  if (encryptedAccessToken && expiresAt > Date.now() + ACCESS_TOKEN_REFRESH_MARGIN_MS) {
    return decryptSecret(encryptedAccessToken)!;
  }

  return refreshGoogleAccessToken(account);
}

async function fetchGoogleCalendarJson<T>(url: URL, init: RequestInit) {
  const response = await fetch(url, init);
  const payload = (await response.json().catch(() => ({}))) as T & { error?: unknown };

  if (!response.ok) {
    throw new GoogleCalendarError("Google Calendar request failed", response.status, payload);
  }

  return payload;
}

async function findExistingEvent(params: {
  accessToken: string;
  calendarId: string;
  callLogId: string;
}) {
  const url = new URL(`${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(params.calendarId)}/events`);
  url.searchParams.set("privateExtendedProperty", `callsecCallLogId=${params.callLogId}`);
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("maxResults", "1");

  const payload = await fetchGoogleCalendarJson<GoogleCalendarEventListResponse>(url, {
    headers: { Authorization: `Bearer ${params.accessToken}` }
  });

  return payload.items?.[0] ?? null;
}

async function createGoogleCalendarEvent(params: {
  account: GoogleAccount;
  accessToken: string;
  callLogId: string;
  customerPhone: string;
  transcript: string;
  extracted: AppointmentExtraction & { startDateTime: string; endDateTime: string };
}) {
  const calendarId = params.account.calendarId || "primary";
  const existing = await findExistingEvent({
    accessToken: params.accessToken,
    calendarId,
    callLogId: params.callLogId
  });

  if (existing) {
    return {
      status: "exists",
      eventId: existing.id ?? null,
      htmlLink: existing.htmlLink ?? null
    } satisfies CalendarAutomationResult;
  }

  const url = new URL(`${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`);
  const event = {
    summary: buildEventSummary(params.extracted),
    description: buildEventDescription(params),
    start: {
      dateTime: params.extracted.startDateTime,
      timeZone: CALENDAR_TIME_ZONE
    },
    end: {
      dateTime: params.extracted.endDateTime,
      timeZone: CALENDAR_TIME_ZONE
    },
    extendedProperties: {
      private: {
        callsecCallLogId: params.callLogId,
        callsecCustomerPhone: params.customerPhone
      }
    }
  };

  const payload = await fetchGoogleCalendarJson<GoogleCalendarEventResponse>(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(event)
  });

  return {
    status: "created",
    eventId: payload.id ?? null,
    htmlLink: payload.htmlLink ?? null
  } satisfies CalendarAutomationResult;
}

async function extractAppointmentFromTranscript(input: {
  transcript: string;
  customerPhone: string;
  direction: CallDirection;
  createdAt: Date;
}) {
  try {
    const completion = await postOpenAiJson("/chat/completions", buildExtractionRequest(input));
    const parsedCompletion = openAiChatCompletionSchema.safeParse(completion);
    const content = parsedCompletion.success ? parsedCompletion.data.choices[0]?.message.content : null;
    if (!content) {
      return null;
    }

    const parsed = appointmentExtractionSchema.safeParse(parseJsonObject(content));
    return parsed.success ? normalizeExtractedAppointment(parsed.data) : null;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof OpenAiRequestError) {
      throw new GoogleCalendarError("Appointment extraction failed", error instanceof OpenAiRequestError ? error.status : undefined, error);
    }

    throw error;
  }
}

export async function maybeCreateCalendarEventFromCallLog(input: {
  userId: string;
  callLogId: string;
  customerPhone: string;
  direction: CallDirection;
  transcript?: string | null;
  createdAt: Date;
}): Promise<CalendarAutomationResult> {
  const transcript = input.transcript?.trim();
  if (!transcript) {
    return { status: "skipped", reason: "NO_TRANSCRIPT" };
  }

  const account = await prisma.googleAccount.findUnique({ where: { userId: input.userId } });
  if (!account || account.status !== "CONNECTED") {
    return { status: "skipped", reason: "GOOGLE_NOT_CONNECTED" };
  }
  if (!hasCalendarScope(account.scope)) {
    return { status: "skipped", reason: "CALENDAR_SCOPE_MISSING" };
  }

  const extracted = await extractAppointmentFromTranscript({
    transcript,
    customerPhone: input.customerPhone,
    direction: input.direction,
    createdAt: input.createdAt
  });
  if (!extracted) {
    return { status: "skipped", reason: "NO_CONFIRMED_APPOINTMENT" };
  }

  const accessToken = await getGoogleAccessToken(account);
  return createGoogleCalendarEvent({
    account,
    accessToken,
    callLogId: input.callLogId,
    customerPhone: input.customerPhone,
    transcript,
    extracted
  });
}

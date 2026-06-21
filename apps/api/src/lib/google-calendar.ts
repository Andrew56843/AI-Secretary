import type { CallDirection, GoogleAccount } from "@prisma/client";
import { z } from "zod";
import { env } from "../config.js";
import { OpenAiRequestError, postOpenAiJson } from "./openai.js";
import { prisma } from "./prisma.js";
import { decryptSecret, encryptSecret } from "./secret-box.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";
const DEFAULT_CALENDAR_TIME_ZONE = "Europe/Moscow";
const DEFAULT_EVENT_DURATION_MS = 30 * 60 * 1000;
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
const EXACT_TIME_SEARCH_BEFORE_MS = 2 * 60 * 60 * 1000;
const EXACT_TIME_SEARCH_AFTER_MS = 4 * 60 * 60 * 1000;
const FUTURE_SEARCH_DAYS = 90;

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

const calendarActionValueSchema = z.preprocess(
  (value) => String(value ?? "NONE").toUpperCase(),
  z.enum(["CREATE", "CANCEL", "RESCHEDULE", "NONE"])
);

const calendarActionExtractionSchema = z.object({
  action: calendarActionValueSchema,
  confidence: z.number().min(0).max(1).optional(),
  title: z.string().trim().max(200).optional().nullable(),
  customerName: z.string().trim().max(120).optional().nullable(),
  reason: z.string().trim().max(240).optional().nullable(),
  targetStartDateTime: z.string().trim().max(80).optional().nullable(),
  targetEndDateTime: z.string().trim().max(80).optional().nullable(),
  targetDate: z.string().trim().max(10).optional().nullable(),
  startDateTime: z.string().trim().max(80).optional().nullable(),
  endDateTime: z.string().trim().max(80).optional().nullable()
});

export const calendarActionInputSchema = calendarActionExtractionSchema;

type CalendarActionExtraction = z.infer<typeof calendarActionExtractionSchema>;
export type CalendarActionInput = z.input<typeof calendarActionInputSchema>;

type NormalizedCalendarAction =
  | (CalendarActionExtraction & {
      action: "CREATE";
      startDateTime: string;
      endDateTime: string;
    })
  | (CalendarActionExtraction & {
      action: "CANCEL";
    })
  | (CalendarActionExtraction & {
      action: "RESCHEDULE";
      startDateTime: string;
      endDateTime: string;
    });

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

type GoogleCalendarEventDate = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

type GoogleCalendarEventResponse = {
  id?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  status?: string;
  transparency?: string;
  start?: GoogleCalendarEventDate;
  end?: GoogleCalendarEventDate;
  extendedProperties?: {
    private?: Record<string, string>;
  };
};

type GoogleCalendarEventListResponse = {
  items?: GoogleCalendarEventResponse[];
};

export type CalendarAutomationResult =
  | { status: "skipped"; reason: string; action?: string }
  | { status: "created" | "exists" | "cancelled" | "rescheduled"; eventId: string | null; htmlLink: string | null }
  | { status: "not_found"; action: "CANCEL" | "RESCHEDULE"; reason: string }
  | { status: "conflict"; action: "CREATE" | "RESCHEDULE"; eventId: string | null; htmlLink: string | null; reason: string };

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

function normalizeTimeZone(timeZone: string | null | undefined) {
  if (!timeZone) {
    return DEFAULT_CALENDAR_TIME_ZONE;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return DEFAULT_CALENDAR_TIME_ZONE;
  }
}

function getTimeZoneOffset(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "shortOffset",
    hour12: false
  }).formatToParts(date);
  const offsetText = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = offsetText.match(/^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?)?$/);

  if (!match?.groups?.sign) {
    return "+00:00";
  }

  const hours = (match.groups.hours ?? "0").padStart(2, "0");
  const minutes = match.groups.minutes ?? "00";
  return `${match.groups.sign}${hours}:${minutes}`;
}

function getReferenceDateTime(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const offset = getTimeZoneOffset(date, timeZone);

  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}${offset}`;
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

function isValidDateOnly(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  return Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function addDefaultDuration(startDateTime: string) {
  return new Date(Date.parse(startDateTime) + DEFAULT_EVENT_DURATION_MS).toISOString();
}

function getFallbackTargetStartDateTime(extracted: CalendarActionExtraction) {
  if (isValidDateTime(extracted.targetStartDateTime)) {
    return extracted.targetStartDateTime!;
  }

  if (extracted.action === "CANCEL" && isValidDateTime(extracted.startDateTime)) {
    return extracted.startDateTime!;
  }

  return null;
}

function getFallbackTargetDate(extracted: CalendarActionExtraction, targetStartDateTime: string | null) {
  if (isValidDateOnly(extracted.targetDate)) {
    return extracted.targetDate!;
  }

  return targetStartDateTime?.slice(0, 10) ?? null;
}

function localDateAt(value: string, timeZone: string, hour: number, minute = 0) {
  const reference = new Date(`${value}T12:00:00Z`);
  const offset = getTimeZoneOffset(reference, timeZone);
  const hourText = String(hour).padStart(2, "0");
  const minuteText = String(minute).padStart(2, "0");

  return `${value}T${hourText}:${minuteText}:00${offset}`;
}

function normalizePhoneDigits(value: string | null | undefined) {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizeSearchText(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s+]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasRescheduleIntent(transcript: string | null | undefined) {
  const text = normalizeSearchText(transcript);
  if (!text) {
    return false;
  }

  return (
    /(перенес[\p{L}\p{N}_]*|перенести|перенос[\p{L}\p{N}_]*|передвин[\p{L}\p{N}_]*|сдвин[\p{L}\p{N}_]*|поменя[\p{L}\p{N}_]*|измен[\p{L}\p{N}_]*)/u.test(text) &&
    /(запис[\p{L}\p{N}_]*|время|час[\p{L}\p{N}_]*|слот[\p{L}\p{N}_]*)/u.test(text)
  );
}

function hasCancelIntent(transcript: string | null | undefined) {
  const text = normalizeSearchText(transcript);
  if (!text) {
    return false;
  }

  return (
    /(отмен[\p{L}\p{N}_]*|убер[\p{L}\p{N}_]*|снять|удал[\p{L}\p{N}_]*)/u.test(text) &&
    /(запис[\p{L}\p{N}_]*|визит|слот)/u.test(text)
  );
}

function applyTranscriptIntentGuard(
  extracted: CalendarActionExtraction,
  transcript: string | null | undefined,
  source: "realtime" | "post_call"
) {
  if (extracted.action !== "CREATE") {
    return extracted;
  }

  if (hasRescheduleIntent(transcript)) {
    console.info("Google Calendar action corrected by transcript intent", {
      source,
      from: "CREATE",
      to: "RESCHEDULE"
    });
    return { ...extracted, action: "RESCHEDULE" as const };
  }

  if (hasCancelIntent(transcript)) {
    console.info("Google Calendar action corrected by transcript intent", {
      source,
      from: "CREATE",
      to: "CANCEL"
    });
    return { ...extracted, action: "CANCEL" as const };
  }

  return extracted;
}

function shouldPreserveExistingDurationOnReschedule(transcript: string | null | undefined) {
  const text = normalizeSearchText(transcript);
  return !/(добав[\p{L}\p{N}_]*|плюс|ещ[её]|окраш[\p{L}\p{N}_]*|смен[\p{L}\p{N}_]* услуг[\p{L}\p{N}_]*|замен[\p{L}\p{N}_]* услуг[\p{L}\p{N}_]*|измен[\p{L}\p{N}_]* услуг[\p{L}\p{N}_]*)/u.test(text);
}

function getRescheduleEndDateTime(
  event: GoogleCalendarEventResponse,
  action: Extract<NormalizedCalendarAction, { action: "RESCHEDULE" }>,
  transcript: string
) {
  if (!shouldPreserveExistingDurationOnReschedule(transcript)) {
    return action.endDateTime;
  }

  const eventStartMs = getEventStartMs(event);
  const eventEndMs = getEventEndMs(event);
  const newStartMs = Date.parse(action.startDateTime);
  const existingDurationMs = eventEndMs - eventStartMs;

  if (
    Number.isFinite(eventStartMs) &&
    Number.isFinite(eventEndMs) &&
    Number.isFinite(newStartMs) &&
    existingDurationMs > 0 &&
    existingDurationMs <= 24 * 60 * 60 * 1000
  ) {
    return new Date(newStartMs + existingDurationMs).toISOString();
  }

  return action.endDateTime;
}

function buildExtractionRequest(input: {
  transcript: string;
  customerPhone: string;
  direction: CallDirection;
  createdAt: Date;
  timeZone: string;
  assistantPrompt?: string | null;
}) {
  const assistantPrompt = input.assistantPrompt?.trim();

  return {
    model: env.PROMPT_EDITOR_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You extract calendar actions from Russian AI phone secretary transcripts.",
          "Return strict JSON only.",
          "Choose exactly one action: CREATE, CANCEL, RESCHEDULE, or NONE.",
          "CREATE means the assistant clearly confirmed that a new appointment was booked or recorded.",
          "CANCEL means the customer clearly asked to cancel an existing appointment and the assistant agreed to cancel it.",
          "RESCHEDULE means the customer clearly moved an existing appointment to a new date or time.",
          "Use NONE for vague interest, questions, failed calls, escalation, or conversations without a final calendar action.",
          "Never return CREATE for a cancellation conversation.",
          "Never return CREATE if the customer asked to reschedule, move, change, or shift an existing appointment; return RESCHEDULE.",
          "Russian RESCHEDULE clues include: перенести, перенос, передвинуть, сдвинуть, поменять время, изменить время.",
          "Example: 'записывалась завтра на три, хочу перенести на двенадцать' means targetStartDateTime is tomorrow at 15:00 and startDateTime is tomorrow at 12:00.",
          "If a reschedule target exact time is known, put it into targetStartDateTime. If only the target day is known, put it into targetDate.",
          `Use ${input.timeZone} as the business time zone.`,
          `The reference local date-time for relative phrases is ${getReferenceDateTime(input.createdAt, input.timeZone)}.`,
          "Resolve phrases like 'tomorrow' relative to the reference date.",
          "For CANCEL and RESCHEDULE, targetStartDateTime is the existing appointment date-time to find in Google Calendar. If only the date is known, set targetDate as YYYY-MM-DD.",
          "For CREATE, startDateTime/endDateTime describe the new appointment.",
          "For RESCHEDULE, startDateTime/endDateTime describe the new appointment time after moving.",
          "If the transcript confirms a start time but no duration, infer duration from the assistant profile/scenario and the selected service.",
          "Example: if the scenario says a men's haircut lasts 30 minutes and the customer booked a men's haircut, use 30 minutes.",
          "If no duration can be inferred from the transcript or scenario, use 30 minutes.",
          "Return ISO 8601 date-times with the correct UTC offset for the business time zone.",
          "JSON shape: {\"action\":\"CREATE|CANCEL|RESCHEDULE|NONE\",\"confidence\":number,\"title\":string|null,\"customerName\":string|null,\"reason\":string|null,\"targetStartDateTime\":string|null,\"targetEndDateTime\":string|null,\"targetDate\":\"YYYY-MM-DD|null\",\"startDateTime\":string|null,\"endDateTime\":string|null}."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          direction: input.direction,
          customerPhone: input.customerPhone,
          assistantProfileScenario: assistantPrompt ? assistantPrompt.slice(0, 6000) : null,
          transcript: input.transcript.slice(0, 20_000)
        })
      }
    ]
  };
}

function normalizeExtractedCalendarAction(extracted: CalendarActionExtraction): NormalizedCalendarAction | null {
  if (extracted.action === "NONE" || (extracted.confidence ?? 1) < 0.65) {
    return null;
  }

  if (extracted.action === "CREATE") {
    if (!isValidDateTime(extracted.startDateTime)) {
      return null;
    }

    const startDateTime = extracted.startDateTime!;
    const endDateTime = isValidDateTime(extracted.endDateTime)
      ? extracted.endDateTime!
      : addDefaultDuration(startDateTime);

    return {
      ...extracted,
      action: "CREATE",
      startDateTime,
      endDateTime
    };
  }

  if (extracted.action === "CANCEL") {
    const targetStartDateTime = getFallbackTargetStartDateTime(extracted);
    const targetDate = getFallbackTargetDate(extracted, targetStartDateTime);

    if (!targetStartDateTime && !targetDate) {
      return null;
    }

    return {
      ...extracted,
      action: "CANCEL",
      targetStartDateTime,
      targetDate
    };
  }

  if (!isValidDateTime(extracted.startDateTime)) {
    return null;
  }
  const targetStartDateTime = getFallbackTargetStartDateTime(extracted);
  const targetDate = getFallbackTargetDate(extracted, targetStartDateTime);
  if (!targetStartDateTime && !targetDate) {
    return null;
  }

  const startDateTime = extracted.startDateTime!;
  const endDateTime = isValidDateTime(extracted.endDateTime)
    ? extracted.endDateTime!
    : addDefaultDuration(startDateTime);

  return {
    ...extracted,
    action: "RESCHEDULE",
    targetStartDateTime,
    targetDate,
    startDateTime,
    endDateTime
  };
}

function buildEventSummary(extracted: CalendarActionExtraction) {
  const name = extracted.customerName?.trim();
  const reason = extracted.reason?.trim();
  const generated = [name, reason].filter(Boolean).join(" - ");

  return (extracted.title?.trim() || generated || "Callsec appointment").slice(0, 200);
}

function buildEventDescription(input: {
  callLogId: string;
  customerPhone: string;
  transcript: string;
  extracted: CalendarActionExtraction;
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

function buildCalendarSearchWindow(action: NormalizedCalendarAction, createdAt: Date, timeZone: string) {
  if (isValidDateTime(action.targetStartDateTime)) {
    const targetMs = Date.parse(action.targetStartDateTime!);
    return {
      hasExactTime: true,
      targetMs,
      timeMin: new Date(targetMs - EXACT_TIME_SEARCH_BEFORE_MS).toISOString(),
      timeMax: new Date(targetMs + EXACT_TIME_SEARCH_AFTER_MS).toISOString()
    };
  }

  if (isValidDateOnly(action.targetDate)) {
    const timeMin = localDateAt(action.targetDate!, timeZone, 0);
    return {
      hasExactTime: false,
      targetMs: null,
      timeMin,
      timeMax: new Date(Date.parse(timeMin) + 24 * 60 * 60 * 1000).toISOString()
    };
  }

  return {
    hasExactTime: false,
    targetMs: null,
    timeMin: createdAt.toISOString(),
    timeMax: new Date(createdAt.getTime() + FUTURE_SEARCH_DAYS * 24 * 60 * 60 * 1000).toISOString()
  };
}

async function listLiveCalendarEvents(params: {
  accessToken: string;
  calendarId: string;
  timeMin: string;
  timeMax: string;
  customerPhone?: string;
}) {
  async function fetchList(privatePhoneOnly: boolean) {
    const url = new URL(`${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(params.calendarId)}/events`);
    url.searchParams.set("timeMin", params.timeMin);
    url.searchParams.set("timeMax", params.timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("showDeleted", "false");
    url.searchParams.set("maxResults", "20");

    if (privatePhoneOnly && params.customerPhone) {
      url.searchParams.set("privateExtendedProperty", `callsecCustomerPhone=${params.customerPhone}`);
    }

    const payload = await fetchGoogleCalendarJson<GoogleCalendarEventListResponse>(url, {
      headers: { Authorization: `Bearer ${params.accessToken}` }
    });

    return payload.items ?? [];
  }

  const eventsById = new Map<string, GoogleCalendarEventResponse>();
  for (const event of await fetchList(true)) {
    if (event.id) {
      eventsById.set(event.id, event);
    }
  }
  for (const event of await fetchList(false)) {
    if (event.id) {
      eventsById.set(event.id, event);
    }
  }

  return [...eventsById.values()];
}

function getEventStartMs(event: GoogleCalendarEventResponse) {
  const value = event.start?.dateTime ?? event.start?.date;
  return value ? Date.parse(value) : Number.NaN;
}

function getEventEndMs(event: GoogleCalendarEventResponse) {
  const value = event.end?.dateTime ?? event.end?.date;
  return value ? Date.parse(value) : Number.NaN;
}

function getEventText(event: GoogleCalendarEventResponse) {
  return normalizeSearchText([event.summary, event.description].filter(Boolean).join("\n"));
}

async function findConflictingEvent(params: {
  accessToken: string;
  calendarId: string;
  startDateTime: string;
  endDateTime: string;
  excludeEventId?: string | null;
}) {
  const requestedStartMs = Date.parse(params.startDateTime);
  const requestedEndMs = Date.parse(params.endDateTime);

  if (!Number.isFinite(requestedStartMs) || !Number.isFinite(requestedEndMs) || requestedEndMs <= requestedStartMs) {
    return null;
  }

  const events = await listLiveCalendarEvents({
    accessToken: params.accessToken,
    calendarId: params.calendarId,
    timeMin: new Date(requestedStartMs).toISOString(),
    timeMax: new Date(requestedEndMs).toISOString()
  });

  return (
    events.find((event) => {
      if (!event.id || event.id === params.excludeEventId || event.transparency === "transparent") {
        return false;
      }

      const eventStartMs = getEventStartMs(event);
      const eventEndMs = getEventEndMs(event);

      if (!Number.isFinite(eventStartMs) || !Number.isFinite(eventEndMs)) {
        return false;
      }

      return eventStartMs < requestedEndMs && eventEndMs > requestedStartMs;
    }) ?? null
  );
}

function scoreCalendarEvent(params: {
  event: GoogleCalendarEventResponse;
  action: NormalizedCalendarAction;
  customerPhone: string;
  targetMs: number | null;
  hasExactTime: boolean;
}) {
  const privateProperties = params.event.extendedProperties?.private ?? {};
  const eventPhone = privateProperties.callsecCustomerPhone;
  const requestedPhoneDigits = normalizePhoneDigits(params.customerPhone);
  const eventPhoneDigits = normalizePhoneDigits(eventPhone);
  const eventText = getEventText(params.event);
  const eventTextDigits = normalizePhoneDigits(eventText);
  let score = 0;

  if (requestedPhoneDigits && eventPhoneDigits && eventPhoneDigits.endsWith(requestedPhoneDigits.slice(-10))) {
    score += 80;
  }
  if (requestedPhoneDigits && eventTextDigits.includes(requestedPhoneDigits.slice(-10))) {
    score += 30;
  }

  if (params.action.customerName) {
    const name = normalizeSearchText(params.action.customerName);
    if (name && eventText.includes(name)) {
      score += 12;
    }
  }

  if (params.action.reason) {
    const reasonWords = normalizeSearchText(params.action.reason)
      .split(" ")
      .filter((word) => word.length >= 4);
    const matchedWords = reasonWords.filter((word) => eventText.includes(word)).length;
    score += Math.min(matchedWords * 4, 16);
  }

  const startMs = getEventStartMs(params.event);
  if (params.hasExactTime && params.targetMs && Number.isFinite(startMs)) {
    const diffMs = Math.abs(startMs - params.targetMs);
    if (diffMs <= 10 * 60 * 1000) {
      score += 45;
    } else if (diffMs <= 30 * 60 * 1000) {
      score += 30;
    } else if (diffMs <= 2 * 60 * 60 * 1000) {
      score += 10;
    } else {
      score -= 20;
    }
  } else {
    score += 8;
  }

  return score;
}

async function findLiveAppointmentEvent(params: {
  account: GoogleAccount;
  accessToken: string;
  customerPhone: string;
  action: NormalizedCalendarAction;
  createdAt: Date;
  timeZone: string;
}) {
  const calendarId = params.account.calendarId || "primary";
  const window = buildCalendarSearchWindow(params.action, params.createdAt, params.timeZone);
  const events = await listLiveCalendarEvents({
    accessToken: params.accessToken,
    calendarId,
    timeMin: window.timeMin,
    timeMax: window.timeMax,
    customerPhone: params.customerPhone
  });

  const scored = events
    .map((event) => ({
      event,
      score: scoreCalendarEvent({
        event,
        action: params.action,
        customerPhone: params.customerPhone,
        targetMs: window.targetMs,
        hasExactTime: window.hasExactTime
      })
    }))
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  if (!best) {
    return null;
  }

  const minimumScore = window.hasExactTime ? 40 : 70;
  if (best.score < minimumScore) {
    return null;
  }
  if (!window.hasExactTime && scored[1] && best.score - scored[1].score < 10) {
    return null;
  }

  return best.event;
}

async function createGoogleCalendarEvent(params: {
  account: GoogleAccount;
  accessToken: string;
  callLogId: string;
  customerPhone: string;
  transcript: string;
  extracted: Extract<NormalizedCalendarAction, { action: "CREATE" }>;
  timeZone: string;
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

  const conflict = await findConflictingEvent({
    accessToken: params.accessToken,
    calendarId,
    startDateTime: params.extracted.startDateTime,
    endDateTime: params.extracted.endDateTime
  });

  if (conflict) {
    return {
      status: "conflict",
      action: "CREATE",
      eventId: conflict.id ?? null,
      htmlLink: conflict.htmlLink ?? null,
      reason: "TIME_SLOT_BUSY"
    } satisfies CalendarAutomationResult;
  }

  const url = new URL(`${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`);
  const event = {
    summary: buildEventSummary(params.extracted),
    description: buildEventDescription(params),
    start: {
      dateTime: params.extracted.startDateTime,
      timeZone: params.timeZone
    },
    end: {
      dateTime: params.extracted.endDateTime,
      timeZone: params.timeZone
    },
    extendedProperties: {
      private: {
        callsecCallLogId: params.callLogId,
        callsecCustomerPhone: params.customerPhone,
        callsecCreatedBy: "callsec"
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

async function cancelGoogleCalendarEvent(params: {
  account: GoogleAccount;
  accessToken: string;
  callLogId: string;
  customerPhone: string;
  action: Extract<NormalizedCalendarAction, { action: "CANCEL" }>;
  createdAt: Date;
  timeZone: string;
}) {
  const calendarId = params.account.calendarId || "primary";
  const event = await findLiveAppointmentEvent({
    account: params.account,
    accessToken: params.accessToken,
    customerPhone: params.customerPhone,
    action: params.action,
    createdAt: params.createdAt,
    timeZone: params.timeZone
  });

  if (!event?.id) {
    return { status: "not_found", action: "CANCEL", reason: "LIVE_EVENT_NOT_FOUND" } satisfies CalendarAutomationResult;
  }

  const url = new URL(
    `${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.id)}`
  );
  const response = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${params.accessToken}` }
  });

  if (response.status === 404 || response.status === 410) {
    return { status: "not_found", action: "CANCEL", reason: "LIVE_EVENT_ALREADY_GONE" } satisfies CalendarAutomationResult;
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new GoogleCalendarError("Google Calendar event cancel failed", response.status, payload);
  }

  console.log("Google Calendar event cancelled live", {
    callLogId: params.callLogId,
    eventId: event.id
  });

  return {
    status: "cancelled",
    eventId: event.id,
    htmlLink: event.htmlLink ?? null
  } satisfies CalendarAutomationResult;
}

async function rescheduleGoogleCalendarEvent(params: {
  account: GoogleAccount;
  accessToken: string;
  callLogId: string;
  customerPhone: string;
  transcript: string;
  action: Extract<NormalizedCalendarAction, { action: "RESCHEDULE" }>;
  createdAt: Date;
  timeZone: string;
}) {
  const calendarId = params.account.calendarId || "primary";
  const event = await findLiveAppointmentEvent({
    account: params.account,
    accessToken: params.accessToken,
    customerPhone: params.customerPhone,
    action: params.action,
    createdAt: params.createdAt,
    timeZone: params.timeZone
  });

  if (!event?.id) {
    return { status: "not_found", action: "RESCHEDULE", reason: "LIVE_EVENT_NOT_FOUND" } satisfies CalendarAutomationResult;
  }

  const endDateTime = getRescheduleEndDateTime(event, params.action, params.transcript);
  const conflict = await findConflictingEvent({
    accessToken: params.accessToken,
    calendarId,
    startDateTime: params.action.startDateTime,
    endDateTime,
    excludeEventId: event.id
  });

  if (conflict) {
    return {
      status: "conflict",
      action: "RESCHEDULE",
      eventId: conflict.id ?? null,
      htmlLink: conflict.htmlLink ?? null,
      reason: "TIME_SLOT_BUSY"
    } satisfies CalendarAutomationResult;
  }

  const url = new URL(
    `${GOOGLE_CALENDAR_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.id)}`
  );
  const privateProperties = event.extendedProperties?.private ?? {};
  const payload = await fetchGoogleCalendarJson<GoogleCalendarEventResponse>(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      summary: buildEventSummary(params.action) || event.summary,
      description: buildEventDescription({
        callLogId: params.callLogId,
        customerPhone: params.customerPhone,
        transcript: params.transcript,
        extracted: params.action
      }),
      start: {
        dateTime: params.action.startDateTime,
        timeZone: params.timeZone
      },
      end: {
        dateTime: endDateTime,
        timeZone: params.timeZone
      },
      extendedProperties: {
        private: {
          ...privateProperties,
          callsecLastCallLogId: params.callLogId,
          callsecCustomerPhone: params.customerPhone,
          callsecUpdatedBy: "callsec"
        }
      }
    })
  });

  return {
    status: "rescheduled",
    eventId: payload.id ?? event.id,
    htmlLink: payload.htmlLink ?? event.htmlLink ?? null
  } satisfies CalendarAutomationResult;
}

async function extractCalendarActionFromTranscript(input: {
  transcript: string;
  customerPhone: string;
  direction: CallDirection;
  createdAt: Date;
  timeZone: string;
  assistantPrompt?: string | null;
}) {
  try {
    const completion = await postOpenAiJson("/chat/completions", buildExtractionRequest(input));
    const parsedCompletion = openAiChatCompletionSchema.safeParse(completion);
    const content = parsedCompletion.success ? parsedCompletion.data.choices[0]?.message.content : null;
    if (!content) {
      return null;
    }

    const parsed = calendarActionExtractionSchema.safeParse(parseJsonObject(content));
    if (!parsed.success) {
      return null;
    }

    return normalizeExtractedCalendarAction(applyTranscriptIntentGuard(parsed.data, input.transcript, "post_call"));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof OpenAiRequestError) {
      throw new GoogleCalendarError("Calendar action extraction failed", error instanceof OpenAiRequestError ? error.status : undefined, error);
    }

    throw error;
  }
}

async function executeNormalizedCalendarAction(input: {
  account: GoogleAccount;
  action: NormalizedCalendarAction;
  accessToken: string;
  callLogId: string;
  customerPhone: string;
  transcript: string;
  createdAt: Date;
  timeZone: string;
}) {
  switch (input.action.action) {
    case "CREATE":
      return createGoogleCalendarEvent({
        account: input.account,
        accessToken: input.accessToken,
        callLogId: input.callLogId,
        customerPhone: input.customerPhone,
        transcript: input.transcript,
        extracted: input.action,
        timeZone: input.timeZone
      });
    case "CANCEL":
      return cancelGoogleCalendarEvent({
        account: input.account,
        accessToken: input.accessToken,
        callLogId: input.callLogId,
        customerPhone: input.customerPhone,
        action: input.action,
        createdAt: input.createdAt,
        timeZone: input.timeZone
      });
    case "RESCHEDULE":
      return rescheduleGoogleCalendarEvent({
        account: input.account,
        accessToken: input.accessToken,
        callLogId: input.callLogId,
        customerPhone: input.customerPhone,
        transcript: input.transcript,
        action: input.action,
        createdAt: input.createdAt,
        timeZone: input.timeZone
      });
  }
}

async function getConnectedCalendarContext(userId: string) {
  const account = await prisma.googleAccount.findUnique({ where: { userId } });
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timeZone: true }
  });
  const timeZone = normalizeTimeZone(user?.timeZone);

  if (!account || account.status !== "CONNECTED") {
    return { status: "skipped" as const, reason: "GOOGLE_NOT_CONNECTED" as const, timeZone };
  }
  if (!hasCalendarScope(account.scope)) {
    return { status: "skipped" as const, reason: "CALENDAR_SCOPE_MISSING" as const, timeZone };
  }

  const accessToken = await getGoogleAccessToken(account);
  return { status: "ready" as const, account, accessToken, timeZone };
}

export async function syncCalendarAction(input: {
  userId: string;
  callLogId: string;
  customerPhone: string;
  direction: CallDirection;
  action: CalendarActionInput;
  transcript?: string | null;
  createdAt: Date;
}): Promise<CalendarAutomationResult> {
  const parsed = calendarActionExtractionSchema.safeParse(input.action);
  if (!parsed.success) {
    return { status: "skipped", reason: "INVALID_CALENDAR_ACTION" };
  }

  const extracted = normalizeExtractedCalendarAction(
    applyTranscriptIntentGuard(parsed.data, input.transcript, "realtime")
  );
  if (!extracted) {
    return { status: "skipped", reason: "NO_CONFIRMED_CALENDAR_ACTION", action: parsed.data.action };
  }

  const context = await getConnectedCalendarContext(input.userId);
  if (context.status !== "ready") {
    return { status: "skipped", reason: context.reason, action: extracted.action };
  }

  return executeNormalizedCalendarAction({
    account: context.account,
    accessToken: context.accessToken,
    callLogId: input.callLogId,
    customerPhone: input.customerPhone,
    transcript: input.transcript?.trim() || "Realtime calendar action from phone call.",
    action: extracted,
    createdAt: input.createdAt,
    timeZone: context.timeZone
  });
}

export async function maybeSyncCalendarFromCallLog(input: {
  userId: string;
  callLogId: string;
  customerPhone: string;
  direction: CallDirection;
  transcript?: string | null;
  createdAt: Date;
  assistantPrompt?: string | null;
}): Promise<CalendarAutomationResult> {
  const transcript = input.transcript?.trim();
  if (!transcript) {
    return { status: "skipped", reason: "NO_TRANSCRIPT" };
  }

  const context = await getConnectedCalendarContext(input.userId);
  if (context.status !== "ready") {
    return { status: "skipped", reason: context.reason };
  }

  const extracted = await extractCalendarActionFromTranscript({
    transcript,
    customerPhone: input.customerPhone,
    direction: input.direction,
    createdAt: input.createdAt,
    timeZone: context.timeZone,
    assistantPrompt: input.assistantPrompt
  });
  if (!extracted) {
    return { status: "skipped", reason: "NO_CONFIRMED_CALENDAR_ACTION" };
  }

  return executeNormalizedCalendarAction({
    account: context.account,
    accessToken: context.accessToken,
    callLogId: input.callLogId,
    customerPhone: input.customerPhone,
    transcript,
    action: extracted,
    createdAt: input.createdAt,
    timeZone: context.timeZone
  });
}

export const maybeCreateCalendarEventFromCallLog = maybeSyncCalendarFromCallLog;

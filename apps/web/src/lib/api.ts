import type {
  AssistantProfile,
  BillingPagination,
  AuthResponse,
  BillingState,
  BillingTransaction,
  CallLog,
  CallLogsPagination,
  GoogleIntegration,
  IntegrationsState,
  OutboundContact,
  OutboundPagination,
  OutboundStats,
  PhoneContactName,
  ProfilesByMode,
  ReservedPhoneNumber,
  TelegramIntegration,
  UiMode
} from "../types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

type ApiRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  token?: string | null;
};

async function request<T>(path: string, options: ApiRequestOptions = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = typeof payload.message === "string" ? payload.message : "Request failed";
    throw new Error(message);
  }

  return payload as T;
}

export function register(payload: { phone: string; fullName?: string }) {
  return request<AuthResponse>("/api/auth/register", { method: "POST", body: payload });
}

export function login(payload: { phone: string; password: string }) {
  return request<AuthResponse>("/api/auth/login", { method: "POST", body: payload });
}

export function forgotPassword(payload: { phone: string }) {
  return request<Pick<AuthResponse, "issuedPassword" | "delivery">>("/api/auth/forgot-password", {
    method: "POST",
    body: payload
  });
}

export function changePassword(token: string, password: string) {
  return request<{ user: AuthResponse["user"] }>("/api/auth/password", {
    token,
    method: "PUT",
    body: { password }
  });
}

export function getMyProfiles(token: string) {
  return request<{ profiles: ProfilesByMode }>("/api/profiles/me", { token });
}

export function getFreeNumbers(token: string) {
  return request<{ numbers: ReservedPhoneNumber[] }>("/api/profiles/numbers/free", { token });
}

export function getBilling(token: string) {
  return request<{ billing: BillingState }>("/api/billing/me", { token });
}

export function getBillingCharges(token: string, params: { page?: number; pageSize?: number } = {}) {
  const query = new URLSearchParams();
  if (params.page) {
    query.set("page", String(params.page));
  }
  if (params.pageSize) {
    query.set("pageSize", String(params.pageSize));
  }

  const serializedQuery = query.toString();
  const suffix = serializedQuery ? `?${serializedQuery}` : "";
  return request<{ transactions: BillingTransaction[]; pagination: BillingPagination }>(`/api/billing/charges${suffix}`, {
    token
  });
}

export function topUpBalance(token: string, payload: { amountRub: number }) {
  return request<{ billing: BillingState }>("/api/billing/top-up", {
    token,
    method: "POST",
    body: payload
  });
}

export function rentPhoneNumber(token: string) {
  return request<{ billing: BillingState }>("/api/billing/number-rental", {
    token,
    method: "POST"
  });
}

export function getIntegrations(token: string) {
  return request<{ integrations: IntegrationsState }>("/api/integrations/me", { token });
}

export function connectGoogleCalendar(token: string, payload: { googleEmail?: string; calendarId?: string }) {
  return request<{ google: GoogleIntegration }>("/api/integrations/google/connect", {
    token,
    method: "POST",
    body: payload
  });
}

export function disconnectGoogleCalendar(token: string) {
  return request<{ google: GoogleIntegration }>("/api/integrations/google/disconnect", {
    token,
    method: "POST"
  });
}

export function connectTelegram(token: string, payload: { username?: string; chatId?: string }) {
  return request<{ telegram: TelegramIntegration }>("/api/integrations/telegram/connect", {
    token,
    method: "POST",
    body: payload
  });
}

export function getTelegramLink(token: string) {
  return request<{ telegram: TelegramIntegration }>("/api/integrations/telegram/link", {
    token,
    method: "POST"
  });
}

export function disconnectTelegram(token: string) {
  return request<{ telegram: TelegramIntegration }>("/api/integrations/telegram/disconnect", {
    token,
    method: "POST"
  });
}

export async function createVoicePreview(token: string, payload: { voice: AssistantProfile["voice"]; text?: string }) {
  const response = await fetch(`${API_URL}/api/voice-preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    const message = typeof errorPayload.message === "string" ? errorPayload.message : "Не удалось создать preview голоса";
    throw new Error(message);
  }

  return response.blob();
}

export function createSiteCall(token: string, direction: UiMode) {
  return request<{ log: CallLog }>("/api/calls/site-call", {
    token,
    method: "POST",
    body: { direction }
  });
}

export function saveProfile(
  token: string,
  mode: UiMode,
  payload: {
    title: string;
    businessName?: string;
    prompt: string;
    greetingText: string;
    forwardingEnabled: boolean;
    forwardingOnComplete: boolean;
    forwardingOnStalemate: boolean;
    realtimeModel: AssistantProfile["realtimeModel"];
    voice: AssistantProfile["voice"];
    maxDialogSeconds: number;
  }
) {
  return request<{ profile: AssistantProfile }>(`/api/profiles/${mode}`, {
    token,
    method: "PUT",
    body: payload
  });
}

export function updateProfileForwarding(token: string, mode: UiMode, forwardingEnabled: boolean) {
  return request<{ profile: AssistantProfile }>(`/api/profiles/${mode}/forwarding`, {
    token,
    method: "PUT",
    body: { forwardingEnabled }
  });
}

export function getCallLogs(token: string, direction?: UiMode, params: { page?: number; pageSize?: number } = {}) {
  const query = new URLSearchParams();
  if (direction) {
    query.set("direction", direction);
  }
  if (params.page) {
    query.set("page", String(params.page));
  }
  if (params.pageSize) {
    query.set("pageSize", String(params.pageSize));
  }

  const serializedQuery = query.toString();
  const suffix = serializedQuery ? `?${serializedQuery}` : "";
  return request<{ logs: CallLog[]; pagination: CallLogsPagination }>(`/api/call-logs/me${suffix}`, { token });
}

export function getContactNames(token: string) {
  return request<{ contacts: PhoneContactName[] }>("/api/contact-names/me", { token });
}

export function saveContactName(token: string, payload: { phone: string; name: string }) {
  return request<{ contact: PhoneContactName }>("/api/contact-names/me", {
    token,
    method: "PUT",
    body: payload
  });
}

export function getOutboundContacts(token: string, params: { page?: number; pageSize?: number } = {}) {
  const query = new URLSearchParams();
  if (params.page) {
    query.set("page", String(params.page));
  }
  if (params.pageSize) {
    query.set("pageSize", String(params.pageSize));
  }

  const serializedQuery = query.toString();
  const suffix = serializedQuery ? `?${serializedQuery}` : "";
  return request<{ contacts: OutboundContact[]; stats: OutboundStats; pagination: OutboundPagination }>(
    `/api/outbound/contacts${suffix}`,
    { token }
  );
}

export function importOutboundContacts(token: string, rawNumbers: string) {
  return request<{ importedCount: number; contacts: OutboundContact[] }>("/api/outbound/contacts/import", {
    token,
    method: "POST",
    body: { rawNumbers }
  });
}

export function createOutboundDemoCall(token: string, contactId: string) {
  return request<{ removedContactId: string; log: CallLog }>(`/api/outbound/contacts/${contactId}/mock-call`, {
    token,
    method: "POST"
  });
}

export function deleteOutboundContact(token: string, contactId: string) {
  return request<void>(`/api/outbound/contacts/${contactId}`, {
    token,
    method: "DELETE"
  });
}

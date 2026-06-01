import type { AssistantProfile, AuthResponse, CallLog, ReservedPhoneNumber } from "../types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

type ApiRequestOptions = {
  method?: "GET" | "POST" | "PUT";
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

export function register(payload: { email: string; password: string; fullName?: string }) {
  return request<AuthResponse>("/api/auth/register", { method: "POST", body: payload });
}

export function login(payload: { email: string; password: string }) {
  return request<AuthResponse>("/api/auth/login", { method: "POST", body: payload });
}

export function getMyProfile(token: string) {
  return request<{ profile: AssistantProfile | null }>("/api/profiles/me", { token });
}

export function getFreeNumbers(token: string) {
  return request<{ numbers: ReservedPhoneNumber[] }>("/api/profiles/numbers/free", { token });
}

export function saveProfile(
  token: string,
  payload: {
    title: string;
    businessName?: string;
    prompt: string;
    forwardingPhone: string;
    reservedNumberId?: string;
  }
) {
  return request<{ profile: AssistantProfile }>("/api/profiles/me", {
    token,
    method: "PUT",
    body: payload
  });
}

export function getCallLogs(token: string) {
  return request<{ logs: CallLog[] }>("/api/call-logs/me", { token });
}

export function createDemoCallLog(token: string) {
  const phrases = [
    "Клиент оформил заказ, эскалация не потребовалась.",
    "Клиент уточнил меню, затем попросил перевод на оператора.",
    "Запрос по доставке обработан автоматически."
  ];
  const randomStatus = ["SUCCESS", "ESCALATED", "MISSED"][Math.floor(Math.random() * 3)] as
    | "SUCCESS"
    | "ESCALATED"
    | "MISSED";
  const summary = phrases[Math.floor(Math.random() * phrases.length)] ?? phrases[0];

  return request<{ log: CallLog }>("/api/call-logs/mock", {
    token,
    method: "POST",
    body: {
      customerPhone: "+79054176285",
      durationSeconds: 45 + Math.floor(Math.random() * 240),
      status: randomStatus,
      summary,
      transcript: "Тестовый диалог: клиент уточнил самовывоз и подтвердил заказ.",
      recordingUrl: "https://example.com/calls/demo-call.mp3"
    }
  });
}

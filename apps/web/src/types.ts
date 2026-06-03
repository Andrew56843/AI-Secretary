export type AuthUser = {
  id: string;
  phone: string;
  fullName?: string | null;
  createdAt?: string;
};

export type AuthResponse = {
  token: string;
  user: AuthUser;
  issuedPassword?: string;
  delivery?: {
    channel: "sms_stub";
    message: string;
  };
};

export type ReservedPhoneNumber = {
  id: string;
  number: string;
  assigned: boolean;
};

export type RealtimeModel = "gpt-realtime-mini" | "gpt-realtime-2";
export type RealtimeVoice =
  | "alloy"
  | "ash"
  | "ballad"
  | "coral"
  | "echo"
  | "sage"
  | "shimmer"
  | "verse"
  | "marin"
  | "cedar";

export type AssistantProfile = {
  id: string;
  mode: "INBOUND" | "OUTBOUND";
  title: string;
  businessName?: string | null;
  prompt: string;
  greetingText: string;
  forwardingPhone: string;
  forwardingEnabled: boolean;
  forwardingOnComplete: boolean;
  forwardingOnStalemate: boolean;
  realtimeModel: RealtimeModel;
  voice: RealtimeVoice;
  maxDialogSeconds: number;
  status: "ACTIVE" | "PAUSED";
  reservedNumberId?: string | null;
  reservedNumber?: ReservedPhoneNumber | null;
  _count?: {
    callLogs: number;
  };
};

export type ProfilesByMode = {
  inbound: AssistantProfile | null;
  outbound: AssistantProfile | null;
};

export type CallLog = {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  customerPhone: string;
  status: "SUCCESS" | "ESCALATED" | "MISSED";
  durationSeconds: number;
  summary?: string | null;
  transcript?: string | null;
  recordingUrl?: string | null;
  createdAt: string;
  transcriptDeliveries?: TranscriptDelivery[];
};

export type TranscriptDelivery = {
  id: string;
  channel: "TELEGRAM";
  status: "PENDING" | "SENT" | "FAILED";
  target?: string | null;
  payloadPreview?: string | null;
  createdAt: string;
};

export type PhoneContactName = {
  id: string;
  phone: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type OutboundContact = {
  id: string;
  phone: string;
  status: "PENDING" | "CALLED" | "FAILED";
  queuedForCall: boolean;
  attempts: number;
  nextAttemptAt?: string | null;
  lastCallLogId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OutboundStats = {
  total: number;
  pending: number;
};

export type OutboundPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
};

export type CallLogsPagination = OutboundPagination;

export type BillingTransaction = {
  id: string;
  type: "FREE_GRANT" | "TOP_UP" | "NUMBER_PURCHASE" | "CALL_CHARGE";
  amountSeconds: number;
  amountRub?: number | null;
  note?: string | null;
  createdAt: string;
};

export type BillingPagination = OutboundPagination;

export type BillingState = {
  rubleBalance: number;
  minuteBalanceSeconds: number;
  totalPurchasedSeconds: number;
  numberPurchasedAt?: string | null;
  numberRentExpiresAt?: string | null;
  numberRentalPriceRub: number;
  numberRenewalAvailable: boolean;
  numberRentDaysLeft?: number | null;
  reservedNumber?: ReservedPhoneNumber | null;
  transactions: BillingTransaction[];
};

export type GoogleIntegration = {
  status: "DISCONNECTED" | "CONNECTED";
  googleEmail?: string | null;
  calendarId?: string | null;
  connectedAt?: string | null;
};

export type TelegramIntegration = {
  status: "DISCONNECTED" | "CONNECTED";
  botUsername: string;
  linkToken: string;
  botLink: string;
  chatId?: string | null;
  username?: string | null;
  connectedAt?: string | null;
};

export type IntegrationsState = {
  google: GoogleIntegration;
  telegram: TelegramIntegration;
};

export type UiMode = "inbound" | "outbound";

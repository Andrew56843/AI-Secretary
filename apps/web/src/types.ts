export type AuthUser = {
  id: string;
  email: string;
  fullName?: string | null;
};

export type AuthResponse = {
  token: string;
  user: AuthUser;
};

export type ReservedPhoneNumber = {
  id: string;
  number: string;
  assigned: boolean;
};

export type AssistantProfile = {
  id: string;
  title: string;
  businessName?: string | null;
  prompt: string;
  forwardingPhone: string;
  status: "ACTIVE" | "PAUSED";
  reservedNumberId: string;
  reservedNumber: ReservedPhoneNumber;
  _count?: {
    callLogs: number;
  };
};

export type CallLog = {
  id: string;
  customerPhone: string;
  status: "SUCCESS" | "ESCALATED" | "MISSED";
  durationSeconds: number;
  summary?: string | null;
  transcript?: string | null;
  recordingUrl?: string | null;
  createdAt: string;
};

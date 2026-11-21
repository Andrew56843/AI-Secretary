import { CallDirection } from "@prisma/client";
import { isValidPhone, normalizePhone } from "./phone.js";

function russianPhone(value: string | null | undefined) {
  const normalized = normalizePhone(value ?? "");
  return isValidPhone(normalized) ? normalized : null;
}

function mismatch() {
  return { ok: false, status: 409, message: "Call metadata does not match the authorized call" } as const;
}

export function validateVoiceCallBinding(input: {
  request: {
    uuid?: string;
    did?: string;
    callerId?: string;
    direction?: "INBOUND" | "OUTBOUND";
    assistantProfileId?: string;
    outboundContactId?: string;
  };
  profile: { id: string; userId: string; mode: CallDirection };
  ownedNumber?: { number: string; assigned: boolean } | null;
  numberRentExpiresAt?: Date | null;
  outboundContact?: {
    id: string;
    userId: string;
    phone: string;
    callMode: CallDirection;
    queuedForCall: boolean;
    activeCallUuid: string | null;
  } | null;
  route?: { callerId: string } | null;
  now: Date;
}) {
  const { request, profile, outboundContact } = input;
  if ((request.assistantProfileId && request.assistantProfileId !== profile.id) ||
      (request.direction && request.direction !== profile.mode)) {
    return mismatch();
  }

  const did = russianPhone(request.did);
  if (request.outboundContactId) {
    const destination = russianPhone(outboundContact?.phone);
    if (!request.uuid || !request.assistantProfileId || !request.direction ||
        !outboundContact || outboundContact.id !== request.outboundContactId || outboundContact.userId !== profile.userId ||
        !outboundContact.queuedForCall || outboundContact.callMode !== profile.mode ||
        !destination || russianPhone(request.callerId) !== destination ||
        (outboundContact.activeCallUuid && outboundContact.activeCallUuid !== request.uuid) ||
        !did || did !== russianPhone(input.route?.callerId)) {
      return mismatch();
    }
    return { ok: true } as const;
  }

  if (profile.mode !== CallDirection.INBOUND || !did || did !== russianPhone(input.ownedNumber?.number)) {
    return mismatch();
  }
  if (!input.ownedNumber?.assigned || !input.numberRentExpiresAt || input.numberRentExpiresAt <= input.now) {
    return { ok: false, status: 402, message: "Reserved number rent is not active" } as const;
  }
  return { ok: true } as const;
}

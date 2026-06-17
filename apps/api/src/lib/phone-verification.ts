import { PhoneVerificationPurpose, PhoneVerificationStatus, Prisma } from "@prisma/client";
import { env } from "../config.js";
import { isValidPhone, normalizePhone } from "./phone.js";
import { prisma } from "./prisma.js";

export const PHONE_VERIFICATION_CALL_NUMBER = env.PHONE_VERIFICATION_CALL_NUMBER;

type VerificationRequestLike = {
  id: string;
  phone: string;
  purpose: PhoneVerificationPurpose;
  status: PhoneVerificationStatus;
  expiresAt: Date;
  verifiedAt?: Date | null;
  createdAt: Date;
};

export function publicPhoneVerificationRequest(request: VerificationRequestLike) {
  return {
    id: request.id,
    phone: request.phone,
    purpose: request.purpose,
    status: request.status,
    verificationNumber: PHONE_VERIFICATION_CALL_NUMBER,
    expiresAt: request.expiresAt,
    verifiedAt: request.verifiedAt ?? null,
    createdAt: request.createdAt
  };
}

export function isPhoneVerificationDid(did: string | null | undefined) {
  const expected = createNumberLookupValues(PHONE_VERIFICATION_CALL_NUMBER);
  const actual = createNumberLookupValues(did);
  return [...actual].some((value) => expected.has(value));
}

export async function startPhoneVerificationRequest(input: {
  phone: string;
  purpose: PhoneVerificationPurpose;
  fullName?: string | null;
}) {
  const expiresAt = new Date(Date.now() + env.PHONE_VERIFICATION_TTL_SECONDS * 1000);

  return prisma.$transaction(
    async (tx) => {
      await tx.phoneVerificationRequest.updateMany({
        where: {
          phone: input.phone,
          status: {
            in: [PhoneVerificationStatus.PENDING, PhoneVerificationStatus.VERIFIED]
          },
          userId: null
        },
        data: {
          status: PhoneVerificationStatus.EXPIRED
        }
      });

      return tx.phoneVerificationRequest.create({
        data: {
          phone: input.phone,
          purpose: input.purpose,
          fullName: input.fullName || null,
          expiresAt
        }
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function getFreshPhoneVerificationRequest(id: string) {
  const request = await prisma.phoneVerificationRequest.findUnique({ where: { id } });

  if (!request) {
    return null;
  }

  if (request.status === PhoneVerificationStatus.PENDING && request.expiresAt.getTime() <= Date.now()) {
    return prisma.phoneVerificationRequest.update({
      where: { id: request.id },
      data: { status: PhoneVerificationStatus.EXPIRED }
    });
  }

  return request;
}

export async function completeLatestPhoneVerificationForCall(callerId: string | null | undefined) {
  const phone = normalizePhone(callerId ?? "");
  if (!isValidPhone(phone)) {
    return null;
  }

  return prisma.$transaction(
    async (tx) => {
      const now = new Date();

      await tx.phoneVerificationRequest.updateMany({
        where: {
          phone,
          status: PhoneVerificationStatus.PENDING,
          expiresAt: { lt: now }
        },
        data: {
          status: PhoneVerificationStatus.EXPIRED
        }
      });

      const request = await tx.phoneVerificationRequest.findFirst({
        where: {
          phone,
          status: PhoneVerificationStatus.PENDING,
          expiresAt: { gte: now }
        },
        orderBy: { createdAt: "desc" }
      });

      if (!request) {
        return null;
      }

      const claimed = await tx.phoneVerificationRequest.updateMany({
        where: {
          id: request.id,
          status: PhoneVerificationStatus.PENDING
        },
        data: {
          status: PhoneVerificationStatus.VERIFIED,
          verifiedAt: now
        }
      });

      if (claimed.count !== 1) {
        return null;
      }

      const completedRequest = await tx.phoneVerificationRequest.update({
        where: { id: request.id },
        data: {
          issuedPassword: null,
          userId: null
        }
      });

      return {
        completed: true as const,
        reason: null,
        request: completedRequest
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

function createNumberLookupValues(input: string | null | undefined) {
  const raw = String(input ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  const normalized = raw ? normalizePhone(raw) : "";
  const values = new Set<string>();

  if (raw) {
    values.add(raw);
  }
  if (digits) {
    values.add(digits);
    values.add(`+${digits}`);
  }
  if (normalized) {
    values.add(normalized);
  }

  return values;
}

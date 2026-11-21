import { CallDirection, type CallBillingSnapshot, type Prisma } from "@prisma/client";
import { normalizePhone } from "./phone.js";

const MODEL_RATES_KOPECKS_PER_MINUTE: Record<CallDirection, Record<string, number>> = {
  [CallDirection.INBOUND]: { "gpt-realtime-mini": 500, "gpt-realtime-2": 1000 },
  [CallDirection.OUTBOUND]: { "gpt-realtime-mini": 700, "gpt-realtime-2": 1200 }
};

type CallBillingIdentity = {
  callUuid: string;
  assistantProfileId: string;
  direction: CallDirection;
  customerPhone: string;
};

function normalizedCustomerPhone(value: string) {
  return normalizePhone(value) || value.trim();
}

function validateSnapshot(snapshot: CallBillingSnapshot, input: CallBillingIdentity) {
  if (snapshot.assistantProfileId !== input.assistantProfileId || snapshot.direction !== input.direction ||
      snapshot.customerPhone !== normalizedCustomerPhone(input.customerPhone)) {
    throw new Error("CALL_UUID_COLLISION");
  }
  const rates = MODEL_RATES_KOPECKS_PER_MINUTE[snapshot.direction];
  if (!Object.hasOwn(MODEL_RATES_KOPECKS_PER_MINUTE, snapshot.direction) || !rates ||
      !Object.hasOwn(rates, snapshot.realtimeModel) ||
      !Number.isSafeInteger(snapshot.rateKopecksPerMinute) || snapshot.rateKopecksPerMinute <= 0) {
    throw new Error("INVALID_CALL_BILLING_SNAPSHOT");
  }
  return snapshot;
}

export async function captureCallBillingSnapshot(
  tx: Prisma.TransactionClient,
  input: CallBillingIdentity & { realtimeModel: string }
) {
  if (!input.callUuid.trim() || input.callUuid.length > 80 || !input.assistantProfileId || !input.customerPhone.trim()) {
    throw new Error("INVALID_CALL_BILLING_SNAPSHOT");
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`call-billing:${input.callUuid}`})::bigint)`;
  const existing = await tx.callBillingSnapshot.findUnique({ where: { callUuid: input.callUuid } });
  if (existing) return validateSnapshot(existing, input);

  const rates = MODEL_RATES_KOPECKS_PER_MINUTE[input.direction];
  if (!Object.hasOwn(MODEL_RATES_KOPECKS_PER_MINUTE, input.direction) || !rates ||
      !Object.hasOwn(rates, input.realtimeModel)) throw new Error("UNSUPPORTED_REALTIME_MODEL");
  return tx.callBillingSnapshot.create({
    data: {
      callUuid: input.callUuid,
      assistantProfileId: input.assistantProfileId,
      direction: input.direction,
      customerPhone: normalizedCustomerPhone(input.customerPhone),
      realtimeModel: input.realtimeModel,
      rateKopecksPerMinute: rates[input.realtimeModel]!
    }
  });
}

export async function loadCallBillingSnapshot(tx: Prisma.TransactionClient, input: CallBillingIdentity) {
  const snapshot = await tx.callBillingSnapshot.findUnique({ where: { callUuid: input.callUuid } });
  return snapshot ? validateSnapshot(snapshot, input) : null;
}

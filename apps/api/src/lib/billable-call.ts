import {
  BillingTransactionType,
  CallDirection,
  CallStatus,
  Prisma,
  TranscriptChannel,
  TranscriptDeliveryStatus
} from "@prisma/client";
import { createBalanceLedgerEntry } from "./balance-ledger.js";
import { rublesToKopecks } from "./money.js";

type BillableCallInput = {
  userId: string;
  direction: CallDirection;
  customerPhone: string;
  status: CallStatus;
  durationSeconds: number;
  summary: string;
  transcript?: string;
  recordingUrl?: string;
};

const MODEL_RATES_RUB_PER_MINUTE: Record<CallDirection, Record<string, number>> = {
  [CallDirection.INBOUND]: {
    "gpt-realtime-mini": 5,
    "gpt-realtime-2": 10
  },
  [CallDirection.OUTBOUND]: {
    "gpt-realtime-mini": 7,
    "gpt-realtime-2": 12
  }
};
const DEFAULT_REALTIME_MODEL = "gpt-realtime-2";
const DEFAULT_RATE_RUB_PER_MINUTE: Record<CallDirection, number> = {
  [CallDirection.INBOUND]: 10,
  [CallDirection.OUTBOUND]: 12
};

function calculateCallChargeKopecks(durationSeconds: number, rateRubPerMinute: number) {
  if (durationSeconds <= 0) {
    return 0;
  }

  return Math.ceil((durationSeconds * rublesToKopecks(rateRubPerMinute)) / 60);
}

export async function createBillableCallLog(tx: Prisma.TransactionClient, input: BillableCallInput) {
  const profile = await tx.assistantProfile.findUnique({
    where: {
      userId_mode: {
        userId: input.userId,
        mode: input.direction
      }
    },
    select: {
      id: true,
      realtimeModel: true,
      user: {
        select: {
          id: true,
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
  });

  if (!profile) {
    throw new Error("PROFILE_NOT_FOUND");
  }

  const directionRates = MODEL_RATES_RUB_PER_MINUTE[input.direction];
  const realtimeModel = directionRates[profile.realtimeModel]
    ? profile.realtimeModel
    : DEFAULT_REALTIME_MODEL;
  const rateRubPerMinute = directionRates[realtimeModel] ?? DEFAULT_RATE_RUB_PER_MINUTE[input.direction];
  const amountKopecks = calculateCallChargeKopecks(input.durationSeconds, rateRubPerMinute);

  await createBalanceLedgerEntry(tx, {
    userId: input.userId,
    type: BillingTransactionType.CALL_CHARGE,
    amountSeconds: -input.durationSeconds,
    amountKopecks: -amountKopecks,
    note: `${realtimeModel} - ${input.direction.toLowerCase()} - ${input.customerPhone} - ${input.durationSeconds}s at ${rateRubPerMinute} RUB/min`
  });

  const log = await tx.callLog.create({
    data: {
      assistantProfileId: profile.id,
      direction: input.direction,
      customerPhone: input.customerPhone,
      status: input.status,
      durationSeconds: input.durationSeconds,
      summary: input.summary,
      transcript: input.transcript,
      recordingUrl: input.recordingUrl
    }
  });

  const telegram = profile.user.telegramAccount;
  if (telegram?.status === "CONNECTED" && input.transcript) {
    const target = telegram.chatId ?? telegram.username ?? "telegram";
    await tx.transcriptDelivery.create({
      data: {
        userId: input.userId,
        callLogId: log.id,
        channel: TranscriptChannel.TELEGRAM,
        status: TranscriptDeliveryStatus.PENDING,
        target,
        payloadPreview: `${input.summary}\n${input.transcript}`.slice(0, 700)
      }
    });
  }

  return tx.callLog.findUniqueOrThrow({
    where: { id: log.id },
    include: { transcriptDeliveries: true }
  });
}

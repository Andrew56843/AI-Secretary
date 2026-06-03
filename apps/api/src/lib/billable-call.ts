import {
  CallDirection,
  CallStatus,
  Prisma,
  TranscriptChannel,
  TranscriptDeliveryStatus
} from "@prisma/client";

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
      user: {
        select: {
          id: true,
          minuteBalanceSeconds: true,
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

  if (profile.user.minuteBalanceSeconds < input.durationSeconds) {
    throw new Error("INSUFFICIENT_MINUTES");
  }

  const amountRub = Math.ceil((input.durationSeconds / 60) * 9);

  await tx.user.update({
    where: { id: input.userId },
    data: {
      minuteBalanceSeconds: {
        decrement: input.durationSeconds
      },
      rubleBalance: {
        decrement: amountRub
      }
    }
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
        status: TranscriptDeliveryStatus.SENT,
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

import { BillingTransactionType, CallDirection, type Prisma } from "@prisma/client";
import { createBalanceLedgerEntry } from "./balance-ledger.js";
import { rublesToKopecks } from "./money.js";

export const REGISTRATION_START_BALANCE_RUB = 100;
export const REGISTRATION_START_BALANCE_KOPECKS = rublesToKopecks(REGISTRATION_START_BALANCE_RUB);

export async function createDefaultProfiles(tx: Prisma.TransactionClient, userId: string, phone: string) {
  await tx.assistantProfile.createMany({
    data: [
      {
        userId,
        mode: CallDirection.INBOUND,
        title: "Входящие звонки",
        businessName: "Мой бизнес",
        prompt: "",
        greetingText: "",
        forwardingPhone: phone,
        forwardingEnabled: true,
        forwardingOnComplete: true,
        forwardingOnStalemate: true,
        realtimeModel: "gpt-realtime-2",
        voice: "alloy",
        maxDialogSeconds: 120
      },
      {
        userId,
        mode: CallDirection.OUTBOUND,
        title: "Исходящие звонки",
        businessName: "Мой бизнес",
        prompt: "",
        greetingText: "",
        forwardingPhone: phone,
        forwardingEnabled: true,
        forwardingOnComplete: true,
        forwardingOnStalemate: true,
        realtimeModel: "gpt-realtime-2",
        voice: "alloy",
        maxDialogSeconds: 90
      }
    ]
  });
}

export async function createStartingBalanceGrant(tx: Prisma.TransactionClient, userId: string) {
  await createBalanceLedgerEntry(tx, {
    userId,
    type: BillingTransactionType.FREE_GRANT,
    amountKopecks: REGISTRATION_START_BALANCE_KOPECKS,
    note: "Registration starting balance"
  });
}

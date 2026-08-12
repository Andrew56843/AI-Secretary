import assert from "node:assert/strict";
import test from "node:test";
import { CallDirection, CallStatus, Prisma } from "@prisma/client";
import { createBillableCallLog } from "./billable-call.js";

test("saves a completed call and lets its final charge move the balance below zero", async () => {
  const ledgerEntries: Array<{ amountKopecks: number }> = [];
  const balanceUpdates: number[] = [];
  const callLog = {
    id: "log-1",
    callUuid: "call-1",
    assistantProfileId: "profile-1",
    direction: CallDirection.INBOUND,
    customerPhone: "+79000000000",
    status: CallStatus.SUCCESS,
    durationSeconds: 144,
    summary: "Completed call",
    transcript: "Assi: Здравствуйте\nUser: Здравствуйте",
    recordingUrl: null,
    createdAt: new Date(),
    transcriptDeliveries: []
  };
  const tx = {
    $executeRaw: async () => 1,
    assistantProfile: {
      findUnique: async () => ({
        id: "profile-1",
        userId: "user-1",
        mode: CallDirection.INBOUND,
        realtimeModel: "gpt-realtime-2",
        user: { id: "user-1", telegramAccount: null }
      })
    },
    billingTransaction: {
      aggregate: async () => ({ _sum: { amountKopecks: 81 } }),
      create: async ({ data }: { data: { amountKopecks: number } }) => {
        ledgerEntries.push(data);
        return data;
      }
    },
    user: {
      update: async ({ data }: { data: { rubleBalanceKopecks: number } }) => {
        balanceUpdates.push(data.rubleBalanceKopecks);
        return data;
      }
    },
    callLog: {
      findUnique: async () => null,
      create: async () => callLog,
      findUniqueOrThrow: async () => callLog
    },
    transcriptDelivery: {
      create: async () => null
    }
  } as unknown as Prisma.TransactionClient;

  const result = await createBillableCallLog(tx, {
    callUuid: "call-1",
    assistantProfileId: "profile-1",
    direction: CallDirection.INBOUND,
    customerPhone: "+79000000000",
    status: CallStatus.SUCCESS,
    durationSeconds: 144,
    summary: "Completed call",
    transcript: callLog.transcript
  });

  assert.equal(result.id, "log-1");
  assert.equal(ledgerEntries[0]?.amountKopecks, -2400);
  assert.deepEqual(balanceUpdates, [-2319]);
});

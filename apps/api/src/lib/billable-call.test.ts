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
    callBillingSnapshot: {
      findUnique: async () => ({
        callUuid: "call-1", assistantProfileId: "profile-1", direction: CallDirection.INBOUND,
        customerPhone: "+79000000000", realtimeModel: "gpt-realtime-2", rateKopecksPerMinute: 1000
      })
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

function billingFixture(input: { currentModel: string; startedModel?: string; rate?: number; direction?: CallDirection }) {
  const direction = input.direction ?? CallDirection.INBOUND;
  const entries: Array<{ amountKopecks: number; note: string }> = [];
  let saved: Record<string, unknown> | null = null;
  const tx = {
    $executeRaw: async () => 1,
    assistantProfile: { findUnique: async () => ({
      id: "profile-1", userId: "user-1", mode: direction, realtimeModel: input.currentModel,
      user: { id: "user-1", telegramAccount: null }
    }) },
    callBillingSnapshot: { findUnique: async () => input.startedModel ? ({
      callUuid: "call-1", assistantProfileId: "profile-1", direction,
      customerPhone: "+79990000001", realtimeModel: input.startedModel, rateKopecksPerMinute: input.rate
    }) : null },
    billingTransaction: {
      aggregate: async () => ({ _sum: { amountKopecks: 10000 } }),
      create: async ({ data }: { data: { amountKopecks: number; note: string } }) => { entries.push(data); return data; }
    },
    user: { update: async () => null },
    callLog: {
      findUnique: async () => saved,
      create: async ({ data }: { data: Record<string, unknown> }) => { saved = { id: "log-1", ...data }; return saved; },
      findUniqueOrThrow: async () => ({ ...saved, transcriptDeliveries: [] })
    },
    transcriptDelivery: { create: async () => null }
  } as unknown as Prisma.TransactionClient;
  const call = {
    callUuid: "call-1", assistantProfileId: "profile-1", direction, customerPhone: "+79990000001",
    status: CallStatus.SUCCESS, durationSeconds: 60, summary: "Completed call"
  };
  return { tx, call, entries };
}

test("mid-call model edits never change the full or mini rate captured at start", async () => {
  for (const direction of [CallDirection.INBOUND, CallDirection.OUTBOUND]) {
    for (const startedModel of ["gpt-realtime-mini", "gpt-realtime-2"]) {
      const currentModel = startedModel === "gpt-realtime-2" ? "gpt-realtime-mini" : "gpt-realtime-2";
      const rate = startedModel === "gpt-realtime-2"
        ? direction === CallDirection.INBOUND ? 1000 : 1200
        : direction === CallDirection.INBOUND ? 500 : 700;
      const f = billingFixture({ currentModel, startedModel, rate, direction });
      await createBillableCallLog(f.tx, f.call);
      assert.equal(f.entries[0]?.amountKopecks, -rate);
      assert.match(f.entries[0]!.note, new RegExp(startedModel));
    }
  }
});

test("historical snapshot rates remain immutable and fractional-minute charges round up in kopecks", async () => {
  const f = billingFixture({ currentModel: "gpt-realtime-mini", startedModel: "gpt-realtime-2", rate: 901 });
  await createBillableCallLog(f.tx, { ...f.call, durationSeconds: 1 });
  assert.equal(f.entries[0]?.amountKopecks, -16);
  assert.match(f.entries[0]!.note, /9\.01 RUB\/min/);
});

test("billable calls with missing or invalid start snapshots cannot charge a guessed current tariff", async () => {
  for (const input of [
    { currentModel: "gpt-realtime-2" },
    { currentModel: "gpt-realtime-2", startedModel: "gpt-realtime-mini", rate: -100 },
    { currentModel: "gpt-realtime-2", startedModel: "unknown-model", rate: 1000 }
  ]) {
    const f = billingFixture(input);
    await assert.rejects(createBillableCallLog(f.tx, f.call), /CALL_BILLING_SNAPSHOT_NOT_FOUND|INVALID_CALL_BILLING_SNAPSHOT/);
    assert.equal(f.entries.length, 0);
  }
  const f = billingFixture({ currentModel: "gpt-realtime-2" });
  await assert.rejects(createBillableCallLog(f.tx, { ...f.call, callUuid: undefined }), /CALL_BILLING_SNAPSHOT_NOT_FOUND/);
  await assert.rejects(createBillableCallLog(f.tx, { ...f.call, durationSeconds: 0 }), /CALL_BILLING_SNAPSHOT_NOT_FOUND/);
  assert.equal(f.entries.length, 0);
});

test("an unanswered zero-second missed call needs no invented start snapshot and charges nothing", async () => {
  const f = billingFixture({ currentModel: "gpt-realtime-2" });
  const result = await createBillableCallLog(f.tx, { ...f.call, status: CallStatus.MISSED, durationSeconds: 0 });
  assert.equal(result.status, CallStatus.MISSED);
  assert.equal(f.entries[0]?.amountKopecks, 0);
  assert.match(f.entries[0]!.note, /not-connected.*at 0 RUB\/min/);
});

test("repeated call UUIDs reuse their existing log without another ledger entry", async () => {
  const f = billingFixture({ currentModel: "gpt-realtime-mini", startedModel: "gpt-realtime-2", rate: 1000 });
  const first = await createBillableCallLog(f.tx, f.call);
  const second = await createBillableCallLog(f.tx, f.call);
  assert.equal(first.id, second.id);
  assert.equal(f.entries.length, 1);
  await assert.rejects(createBillableCallLog(f.tx, { ...f.call, customerPhone: "+79990000002" }), /CALL_UUID_COLLISION/);
});

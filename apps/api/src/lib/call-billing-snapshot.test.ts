import assert from "node:assert/strict";
import test from "node:test";
import { CallDirection, type CallBillingSnapshot, type Prisma } from "@prisma/client";
import { captureCallBillingSnapshot, loadCallBillingSnapshot } from "./call-billing-snapshot.js";

const identity = {
  callUuid: "call-1", assistantProfileId: "profile-1", direction: CallDirection.INBOUND,
  customerPhone: "+79990000001"
};

function fixture(existing?: CallBillingSnapshot) {
  let snapshot = existing;
  let creates = 0;
  const locks: string[] = [];
  const tx = {
    $executeRaw: async (_parts: TemplateStringsArray, value: string) => { locks.push(value); return 1; },
    callBillingSnapshot: {
      findUnique: async () => snapshot ?? null,
      create: async ({ data }: { data: Omit<CallBillingSnapshot, "createdAt"> }) => {
        creates += 1;
        snapshot = { ...data, createdAt: new Date("2026-11-21T12:00:00Z") };
        return snapshot;
      }
    }
  } as unknown as Prisma.TransactionClient;
  return { tx, locks, get creates() { return creates; } };
}

test("captures the selected model and direction-specific kopeck rate before a call", async () => {
  for (const [direction, realtimeModel, rate] of [
    [CallDirection.INBOUND, "gpt-realtime-mini", 500],
    [CallDirection.INBOUND, "gpt-realtime-2", 1000],
    [CallDirection.OUTBOUND, "gpt-realtime-mini", 700],
    [CallDirection.OUTBOUND, "gpt-realtime-2", 1200]
  ] as const) {
    const f = fixture();
    const result = await captureCallBillingSnapshot(f.tx, { ...identity, direction, realtimeModel });
    assert.equal(result.realtimeModel, realtimeModel);
    assert.equal(result.rateKopecksPerMinute, rate);
    assert.equal(f.creates, 1);
    assert.deepEqual(f.locks, ["call-billing:call-1"]);
  }
});

test("repeated resolution keeps the original model and historical rate after profile or price changes", async () => {
  const original: CallBillingSnapshot = {
    ...identity, realtimeModel: "gpt-realtime-2", rateKopecksPerMinute: 900,
    createdAt: new Date("2026-11-21T12:00:00Z")
  };
  const f = fixture(original);
  const result = await captureCallBillingSnapshot(f.tx, { ...identity, realtimeModel: "gpt-realtime-mini" });
  assert.equal(result, original);
  assert.equal(result.realtimeModel, "gpt-realtime-2");
  assert.equal(result.rateKopecksPerMinute, 900);
  assert.equal(f.creates, 0);
});

test("billing snapshots reject UUID rebinding to another profile, direction or caller", async () => {
  const original: CallBillingSnapshot = {
    ...identity, realtimeModel: "gpt-realtime-2", rateKopecksPerMinute: 1000, createdAt: new Date()
  };
  for (const change of [
    { assistantProfileId: "other-profile" }, { direction: CallDirection.OUTBOUND },
    { customerPhone: "+79990000002" }
  ]) {
    const f = fixture(original);
    await assert.rejects(captureCallBillingSnapshot(f.tx, { ...identity, ...change, realtimeModel: "gpt-realtime-2" }), /CALL_UUID_COLLISION/);
    assert.equal(f.creates, 0);
  }
});

test("snapshot identities normalize equivalent customer phone formatting", async () => {
  const f = fixture();
  await captureCallBillingSnapshot(f.tx, { ...identity, customerPhone: "8 (999) 000-00-01", realtimeModel: "gpt-realtime-mini" });
  const result = await loadCallBillingSnapshot(f.tx, identity);
  assert.equal(result?.customerPhone, identity.customerPhone);
});

test("unknown and malformed models never become a default billable tariff", async () => {
  for (const realtimeModel of ["", "unknown-model", "toString", "constructor"]) {
    const f = fixture();
    await assert.rejects(captureCallBillingSnapshot(f.tx, { ...identity, realtimeModel }), /UNSUPPORTED_REALTIME_MODEL/);
    assert.equal(f.creates, 0);
  }
});

test("invalid stored billing terms are rejected before use", async () => {
  for (const change of [
    { realtimeModel: "unknown-model" }, { rateKopecksPerMinute: 0 },
    { rateKopecksPerMinute: -1000 }, { rateKopecksPerMinute: 12.5 }
  ]) {
    const f = fixture({ ...identity, realtimeModel: "gpt-realtime-2", rateKopecksPerMinute: 1000, createdAt: new Date(), ...change });
    await assert.rejects(loadCallBillingSnapshot(f.tx, identity), /INVALID_CALL_BILLING_SNAPSHOT/);
  }
});

test("missing snapshots remain missing rather than reconstructing terms from current settings", async () => {
  const f = fixture();
  assert.equal(await loadCallBillingSnapshot(f.tx, identity), null);
  assert.equal(f.creates, 0);
});

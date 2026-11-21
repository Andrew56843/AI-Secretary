import assert from "node:assert/strict";
import test from "node:test";
import { CallDirection, Prisma, type PrismaClient } from "@prisma/client";
import { enqueueTestCall, TEST_CALL_COOLDOWN_MS } from "./test-call-queue.js";

const now = new Date("2026-11-20T19:00:00.000Z");
const input = { userId: "user-1", phone: "+79990000001", direction: CallDirection.INBOUND, now };

type FakeContact = {
  id: string;
  userId: string;
  phone: string;
  callMode: CallDirection;
  queuedForCall?: boolean;
  activeCallUuid?: string | null;
  attempts?: number;
  nextAttemptAt?: Date | null;
};

function queueHarness() {
  const contacts: FakeContact[] = [];
  const activeCalls: Array<{ id: string; userId: string; customerPhone: string }> = [];
  const callLogs: Array<{ id: string; userId: string; customerPhone: string; createdAt: Date }> = [];
  let lockTail = Promise.resolve();
  let createCount = 0;
  let lockCount = 0;
  let queryCount = 0;
  let createError: Error | null = null;

  const db = {
    $transaction: async (
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options: { isolationLevel: string }
    ) => {
      assert.equal(options.isolationLevel, Prisma.TransactionIsolationLevel.ReadCommitted);
      const previousLock = lockTail;
      let releaseLock = () => {};
      lockTail = new Promise<void>((resolve) => { releaseLock = resolve; });
      let locked = false;
      const assertLocked = () => {
        assert.equal(locked, true, "All queue state must be read after the transaction lock");
        queryCount += 1;
      };
      const tx = {
        $executeRaw: async (sql: TemplateStringsArray, userId: string) => {
          assert.match(sql.join("?"), /pg_advisory_xact_lock.*callsec:test-call/);
          assert.equal(userId, input.userId);
          await previousLock;
          locked = true;
          lockCount += 1;
          return 1;
        },
        activeCall: {
          findFirst: async ({ where }: { where: { userId: string; customerPhone: string } }) => {
            assertLocked();
            return activeCalls.find((call) => call.userId === where.userId && call.customerPhone === where.customerPhone) ?? null;
          }
        },
        outboundContact: {
          findFirst: async ({ where }: { where: { userId: string; phone: string } }) => {
            assertLocked();
            return contacts.find((contact) => contact.userId === where.userId && contact.phone === where.phone) ?? null;
          },
          create: async ({ data }: { data: Omit<FakeContact, "id"> }) => {
            assertLocked();
            if (createError) throw createError;
            const contact = { id: `contact-${++createCount}`, ...data };
            contacts.push(contact);
            return contact;
          }
        },
        callLog: {
          findFirst: async ({ where }: {
            where: { assistantProfile: { userId: string }; customerPhone: string; createdAt: { gte: Date } }
          }) => {
            assertLocked();
            return callLogs.find((log) => log.userId === where.assistantProfile.userId &&
              log.customerPhone === where.customerPhone && log.createdAt >= where.createdAt.gte) ?? null;
          }
        }
      } as unknown as Prisma.TransactionClient;
      try {
        return await callback(tx);
      } finally {
        releaseLock();
      }
    }
  } as unknown as Pick<PrismaClient, "$transaction">;

  return {
    db, contacts, activeCalls, callLogs,
    stats: () => ({ createCount, lockCount, queryCount }),
    failCreate: (error: Error) => { createError = error; }
  };
}

test("creates one test job when there is no queued, active or recent owner call", async () => {
  const harness = queueHarness();
  const result = await enqueueTestCall(harness.db, input);
  assert.equal(result.queued, true);
  assert.deepEqual(harness.contacts, [{ id: "contact-1", userId: input.userId, phone: input.phone, callMode: input.direction }]);
  assert.equal(harness.stats().lockCount, 1);
});

test("does not reset a pending, dialing, finalizing or retrying test on repeated requests", async () => {
  for (const state of [
    { queuedForCall: false, activeCallUuid: null, attempts: 0, nextAttemptAt: null },
    { queuedForCall: true, activeCallUuid: null, attempts: 0, nextAttemptAt: null },
    { queuedForCall: true, activeCallUuid: "call-1", attempts: 0, nextAttemptAt: null },
    { queuedForCall: false, activeCallUuid: null, attempts: 1, nextAttemptAt: new Date(now.getTime() + 900_000) }
  ]) {
    const harness = queueHarness();
    const contact = { id: "existing", userId: input.userId, phone: input.phone, callMode: CallDirection.OUTBOUND, ...state };
    harness.contacts.push(contact);
    const before = structuredClone(harness.contacts);
    const result = await enqueueTestCall(harness.db, input);
    assert.equal(result.queued, false);
    assert.deepEqual(harness.contacts, before);
    assert.equal(harness.stats().createCount, 0);
  }
});

test("serializes simultaneous requests across inbound and outbound modes into a single job", async () => {
  const harness = queueHarness();
  const results = await Promise.all([
    enqueueTestCall(harness.db, input),
    enqueueTestCall(harness.db, { ...input, direction: CallDirection.OUTBOUND }),
    enqueueTestCall(harness.db, input)
  ]);
  assert.equal(results.filter((result) => result.queued).length, 1);
  assert.equal(harness.contacts.length, 1);
  assert.equal(harness.stats().lockCount, 3);
});

test("rejects another test while the owner's call is active even without a contact row", async () => {
  const harness = queueHarness();
  harness.activeCalls.push({ id: "active-1", userId: input.userId, customerPhone: input.phone });
  const result = await enqueueTestCall(harness.db, input);
  assert.equal(result.queued, false);
  assert.equal(harness.stats().createCount, 0);
});

test("protects the post-call window after finalization deletes the test job", async () => {
  const harness = queueHarness();
  harness.callLogs.push({ id: "recent", userId: input.userId, customerPhone: input.phone, createdAt: now });
  assert.equal((await enqueueTestCall(harness.db, input)).queued, false);
  assert.equal((await enqueueTestCall(harness.db, { ...input, now: new Date(now.getTime() + TEST_CALL_COOLDOWN_MS + 1) })).queued, true);
});

test("does not modify or block ordinary customer contacts and other accounts", async () => {
  const harness = queueHarness();
  harness.contacts.push(
    { id: "ordinary", userId: input.userId, phone: "+79990000002", callMode: CallDirection.OUTBOUND, attempts: 1, nextAttemptAt: new Date(now.getTime() + 900_000) },
    { id: "other-user", userId: "user-2", phone: input.phone, callMode: CallDirection.INBOUND }
  );
  const before = structuredClone(harness.contacts);
  assert.equal((await enqueueTestCall(harness.db, input)).queued, true);
  assert.deepEqual(harness.contacts.slice(0, 2), before);
});

test("reports an external unique-key race as an already queued test without masking other errors", async () => {
  const harness = queueHarness();
  harness.failCreate(new Prisma.PrismaClientKnownRequestError("Duplicate contact", { code: "P2002", clientVersion: "test" }));
  assert.equal((await enqueueTestCall(harness.db, input)).queued, false);
  harness.failCreate(new Error("Database unavailable"));
  await assert.rejects(() => enqueueTestCall(harness.db, input), /Database unavailable/);
});

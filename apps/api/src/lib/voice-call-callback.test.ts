import assert from "node:assert/strict";
import test from "node:test";
import { CallDirection, CallStatus, Prisma, type PrismaClient } from "@prisma/client";
import { persistVoiceCallCallback } from "./voice-call-callback.js";

const input = {
  userId: "user-1", callUuid: "call-1", assistantProfileId: "profile-1", direction: CallDirection.OUTBOUND,
  customerPhone: "+79990000002", status: CallStatus.MISSED, durationSeconds: 0, summary: "Not answered"
};
type FakeLog = typeof input & { id: string; createdAt: Date; transcriptDeliveries: [] };
type State = { logs: Map<string, FakeLog>; charges: Array<{ amountKopecks: number }>; attempts: number };

function fixture(conflictCodes: Array<"P2034" | "P2002"> = []) {
  let state: State = { logs: new Map(), charges: [], attempts: 0 };
  let lockTail = Promise.resolve();
  let transactions = 0;
  let commits = 0;
  const failures = [...conflictCodes];
  const db = {
    $transaction: async (
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options: { isolationLevel: string }
    ) => {
      transactions += 1;
      assert.equal(options.isolationLevel, Prisma.TransactionIsolationLevel.Serializable);
      const previous = lockTail;
      let unlock = () => {};
      lockTail = new Promise<void>((resolve) => { unlock = resolve; });
      let work: State | undefined;
      const current = () => {
        assert.ok(work, "All callback reads and writes must follow its transaction lock");
        return work;
      };
      const tx = {
        $executeRaw: async (sql: TemplateStringsArray) => {
          if (sql.join("").includes("callsec:call-callback")) {
            await previous;
            work = structuredClone(state);
          } else {
            current();
          }
          return 1;
        },
        assistantProfile: { findUnique: async () => ({ id: input.assistantProfileId, userId: input.userId,
          mode: input.direction, user: { id: input.userId, telegramAccount: null } }) },
        callBillingSnapshot: { findUnique: async () => null },
        billingTransaction: {
          aggregate: async () => ({ _sum: { amountKopecks: 10000 } }),
          create: async ({ data }: { data: { amountKopecks: number } }) => { current().charges.push(data); return data; }
        },
        user: { update: async () => ({}) },
        callLog: {
          findUnique: async ({ where }: { where: { callUuid: string } }) => current().logs.get(where.callUuid) ?? null,
          create: async ({ data }: { data: typeof input }) => {
            const log: FakeLog = { ...data, id: `log-${current().logs.size + 1}`, createdAt: new Date(), transcriptDeliveries: [] };
            current().logs.set(data.callUuid, log);
            return log;
          },
          findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
            const log = [...current().logs.values()].find((item) => item.id === where.id);
            assert.ok(log);
            return log;
          }
        },
        outboundContact: { update: async () => { current().attempts += 1; return { attempts: current().attempts }; } },
        activeCall: { deleteMany: async () => ({ count: 0 }) }
      } as unknown as Prisma.TransactionClient;
      try {
        const result = await callback(tx);
        const conflict = failures.shift();
        if (conflict) {
          throw new Prisma.PrismaClientKnownRequestError("Simulated transaction conflict", {
            code: conflict, clientVersion: "test", meta: { target: ["callUuid"] }
          });
        }
        state = current();
        commits += 1;
        return result;
      } finally {
        unlock();
      }
    }
  } as unknown as Pick<PrismaClient, "$transaction">;
  const finish = (tx: Prisma.TransactionClient) => tx.outboundContact.update({
    where: { id: "contact-1" }, data: { attempts: { increment: 1 } }
  });
  return { db, finish, state: () => state, stats: () => ({ transactions, commits }) };
}

test("three deliveries of one missed-call UUID produce one log, one ledger entry and one dial attempt", async () => {
  const f = fixture();
  const results = [];
  for (let index = 0; index < 3; index += 1) {
    results.push(await persistVoiceCallCallback(f.db, input, f.finish));
  }
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => result.log.id)).size, 1);
  assert.equal(f.state().logs.size, 1);
  assert.equal(f.state().charges.length, 1);
  assert.equal(f.state().attempts, 1);
  const equivalentPhone = await persistVoiceCallCallback(f.db, { ...input, customerPhone: "8 (999) 000-00-02" }, f.finish);
  assert.equal(equivalentPhone.created, false);
  assert.equal(f.state().attempts, 1);
});

test("overlapping callbacks serialize the complete campaign update, not only the billing insert", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 3 }, () => persistVoiceCallCallback(f.db, input, f.finish)));
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(f.state().logs.size, 1);
  assert.equal(f.state().charges.length, 1);
  assert.equal(f.state().attempts, 1);
});

test("transaction and call-UUID conflicts retry the entire rolled-back callback without double accounting", async () => {
  for (const code of ["P2034", "P2002"] as const) {
    const f = fixture([code]);
    const result = await persistVoiceCallCallback(f.db, input, f.finish);
    assert.equal(result.created, true);
    assert.deepEqual(f.stats(), { transactions: 2, commits: 1 });
    assert.equal(f.state().logs.size, 1);
    assert.equal(f.state().charges.length, 1);
    assert.equal(f.state().attempts, 1);
  }
});

test("reusing a call UUID for another profile, direction or customer is rejected without advancing attempts", async () => {
  const f = fixture();
  await persistVoiceCallCallback(f.db, input, f.finish);
  for (const change of [
    { assistantProfileId: "another-profile" }, { direction: CallDirection.INBOUND }, { customerPhone: "+79990000003" }
  ]) {
    await assert.rejects(persistVoiceCallCallback(f.db, { ...input, ...change }, f.finish), /CALL_UUID_COLLISION/);
  }
  assert.equal(f.state().charges.length, 1);
  assert.equal(f.state().attempts, 1);
});

test("persistent serialization conflicts stop after a bounded number of transaction retries", async () => {
  const f = fixture(["P2034", "P2034", "P2034", "P2034"]);
  await assert.rejects(persistVoiceCallCallback(f.db, input, f.finish), { code: "P2034" });
  assert.deepEqual(f.stats(), { transactions: 3, commits: 0 });
  assert.equal(f.state().logs.size, 0);
  assert.equal(f.state().charges.length, 0);
  assert.equal(f.state().attempts, 0);
});

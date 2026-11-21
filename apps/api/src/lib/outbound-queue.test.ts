import assert from "node:assert/strict";
import test from "node:test";
import { CallDirection, OutboundContactStatus, Prisma } from "@prisma/client";
import {
  claimNextOutboundContact,
  OUTBOUND_QUEUE_BATCH_SIZE,
  OUTBOUND_QUEUE_MAX_BATCHES,
  OUTBOUND_ROUTE_RETRY_MS
} from "./outbound-queue.js";

const now = new Date("2026-11-21T12:00:00.000Z");
const reservedNumber = {
  number: "+79952225213",
  assigned: true,
  sipLine: {
    enabled: true,
    asteriskEndpoint: "callsec-sip-79952225213",
    server: "sip.novofon.ru",
    port: 5061,
    transport: "tls",
    updatedAt: now
  }
};

function contact(index: number, hasRoute: boolean) {
  return {
    id: `contact-${index}`,
    userId: "user-1",
    phone: `+799901${String(index).padStart(5, "0")}`,
    callMode: CallDirection.OUTBOUND,
    status: OutboundContactStatus.PENDING,
    queuedForCall: false,
    activeCallUuid: null as string | null,
    activeCallStartedAt: null as Date | null,
    attempts: 2,
    nextAttemptAt: null as Date | null,
    createdAt: new Date(now.getTime() + index),
    user: {
      phone: "+79990000001",
      rubleBalanceKopecks: 1000,
      numberRentExpiresAt: new Date(now.getTime() + 86_400_000),
      profiles: [{ reservedNumber: hasRoute ? structuredClone(reservedNumber) : null }]
    }
  };
}

type Contact = ReturnType<typeof contact>;
type Update = { where: { id: string; status: string; queuedForCall: boolean; OR: unknown[] }; data: Record<string, unknown> };

function harness(records: Contact[], lostClaimId?: string) {
  let reads = 0;
  let readNow = now;
  const writes: Update[] = [];
  const due = (row: Contact) => row.status === OutboundContactStatus.PENDING && !row.queuedForCall &&
    (!row.nextAttemptAt || row.nextAttemptAt <= readNow);
  const tx = {
    outboundContact: {
      findMany: async (query: {
        where: { user: { rubleBalanceKopecks: { gt: number } }; OR: Array<{ nextAttemptAt: null | { lte: Date } }> };
        orderBy: Array<{ nextAttemptAt?: string | { sort: string; nulls: string }; createdAt?: string }>;
        take: number;
      }) => {
        reads += 1;
        assert.equal(query.take, OUTBOUND_QUEUE_BATCH_SIZE);
        assert.equal(query.where.user.rubleBalanceKopecks.gt, 0);
        const dueCondition = query.where.OR.find((condition) => condition.nextAttemptAt !== null)?.nextAttemptAt;
        assert.ok(dueCondition);
        readNow = dueCondition.lte;
        const nextAttemptOrder = query.orderBy[0]?.nextAttemptAt;
        const nullsFirst = typeof nextAttemptOrder === "object" && nextAttemptOrder.nulls === "first";
        return records.filter((row) => due(row) && row.user.rubleBalanceKopecks > 0)
          .sort((left, right) => {
            if (!left.nextAttemptAt && right.nextAttemptAt) return nullsFirst ? -1 : 1;
            if (left.nextAttemptAt && !right.nextAttemptAt) return nullsFirst ? 1 : -1;
            return (left.nextAttemptAt?.getTime() ?? 0) - (right.nextAttemptAt?.getTime() ?? 0) ||
              left.createdAt.getTime() - right.createdAt.getTime();
          })
          .slice(0, query.take).map((row) => structuredClone(row));
      },
      updateMany: async (update: Update) => {
        writes.push(update);
        assert.equal(update.where.status, OutboundContactStatus.PENDING);
        assert.equal(update.where.queuedForCall, false);
        assert.equal(update.where.OR.length, 2);
        const row = records.find((item) => item.id === update.where.id);
        if (!row || !due(row)) return { count: 0 };
        if (row.id === lostClaimId && update.data.queuedForCall === true) {
          row.queuedForCall = true;
          row.activeCallUuid = "another-worker-call";
          return { count: 0 };
        }
        Object.assign(row, update.data);
        return { count: 1 };
      }
    }
  } as unknown as Prisma.TransactionClient;
  return { tx, records, writes, reads: () => reads };
}

test("ten unavailable routes do not hide an eligible eleventh contact", async () => {
  const blocked = Array.from({ length: 10 }, (_, index) => contact(index, false));
  const eligible = contact(10, true);
  const state = harness([...blocked, eligible]);
  const result = await claimNextOutboundContact(state.tx, { now });
  assert.equal(result?.id, eligible.id);
  assert.equal(state.reads(), 2);
  for (const row of blocked) {
    assert.equal(row.attempts, 2);
    assert.equal(row.status, OutboundContactStatus.PENDING);
    assert.equal(row.queuedForCall, false);
    assert.equal(row.nextAttemptAt?.getTime(), now.getTime() + OUTBOUND_ROUTE_RETRY_MS);
  }
  assert.equal(eligible.queuedForCall, true);
  assert.ok(state.writes.every((write) => !("attempts" in write.data) && !("status" in write.data)));
});

test("lost atomic claims are skipped without overwriting the other worker's call", async () => {
  const first = contact(0, true);
  const second = contact(1, true);
  const state = harness([first, second], first.id);
  const result = await claimNextOutboundContact(state.tx, { now });
  assert.equal(result?.id, second.id);
  assert.equal(first.activeCallUuid, "another-worker-call");
  assert.equal(first.attempts, 2);
  assert.equal(second.queuedForCall, true);
});

test("scans are bounded and deferred contacts allow the next poll to make progress", async () => {
  const blockedCount = OUTBOUND_QUEUE_BATCH_SIZE * OUTBOUND_QUEUE_MAX_BATCHES;
  const blocked = Array.from({ length: blockedCount }, (_, index) => contact(index, false));
  const eligible = contact(blockedCount, true);
  const state = harness([...blocked, eligible]);
  assert.equal(await claimNextOutboundContact(state.tx, { now }), null);
  assert.equal(state.reads(), OUTBOUND_QUEUE_MAX_BATCHES);
  assert.equal(state.writes.length, blockedCount);
  assert.equal(eligible.queuedForCall, false);
  assert.equal((await claimNextOutboundContact(state.tx, { now }))?.id, eligible.id);
});

test("existing campaign retry times and nonpositive balances are not reset", async () => {
  const futureRetry = contact(0, true);
  futureRetry.nextAttemptAt = new Date(now.getTime() + 15 * 60_000);
  const noBalance = contact(1, true);
  noBalance.user.rubleBalanceKopecks = 0;
  const state = harness([futureRetry, noBalance]);
  assert.equal(await claimNextOutboundContact(state.tx, { now }), null);
  assert.equal(state.writes.length, 0);
  assert.equal(futureRetry.nextAttemptAt.getTime(), now.getTime() + 15 * 60_000);
  assert.equal(noBalance.queuedForCall, false);
});

test("a large backlog of due unavailable retries cannot starve an untouched new contact", async () => {
  const blocked = Array.from({ length: 700 }, (_, index) => {
    const row = contact(index, false);
    row.nextAttemptAt = new Date(now.getTime() - OUTBOUND_ROUTE_RETRY_MS);
    return row;
  });
  const untouched = contact(700, true);
  const state = harness([...blocked, untouched]);
  assert.equal((await claimNextOutboundContact(state.tx, { now }))?.id, untouched.id);
  assert.equal(state.reads(), 1);
  assert.equal(state.writes.length, 1);
  assert.equal(untouched.queuedForCall, true);
});

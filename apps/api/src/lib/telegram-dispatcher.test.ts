import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptChannel, TranscriptDeliveryStatus, type PrismaClient } from "@prisma/client";
import { TELEGRAM_DELIVERY_STALE_MS } from "./telegram.js";
import { dispatchPendingTelegramTranscripts, startTelegramDispatcher } from "./telegram-dispatcher.js";

type DispatchQuery = Parameters<PrismaClient["transcriptDelivery"]["findMany"]>[0];

function mockDatabase(findMany: (query: DispatchQuery) => Promise<Array<{ callLogId: string }>>) {
  return { transcriptDelivery: { findMany } } as unknown as Pick<PrismaClient, "transcriptDelivery">;
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("dispatches bounded distinct durable pending and stale claims without selecting terminal siblings", async () => {
  const now = new Date("2026-11-21T12:00:00.000Z");
  const staleAt = new Date(now.getTime() - TELEGRAM_DELIVERY_STALE_MS);
  const delivered: string[] = [];
  const db = mockDatabase(async (query) => {
    assert.deepEqual(query, {
      where: {
        channel: TranscriptChannel.TELEGRAM,
        OR: [
          { status: TranscriptDeliveryStatus.PENDING },
          { status: TranscriptDeliveryStatus.SENDING, OR: [{ claimedAt: { lte: staleAt } }, { claimedAt: null }] }
        ],
        callLog: {
          transcriptDeliveries: {
            none: {
              channel: TranscriptChannel.TELEGRAM,
              OR: [
                { status: { in: [TranscriptDeliveryStatus.SENT, TranscriptDeliveryStatus.UNKNOWN, TranscriptDeliveryStatus.FAILED] } },
                { status: TranscriptDeliveryStatus.SENDING, claimedAt: { gt: staleAt } }
              ]
            }
          }
        }
      },
      select: { callLogId: true },
      distinct: ["callLogId"],
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 20
    });
    return [{ callLogId: "pending-log" }, { callLogId: "stale-claim-log" }, { callLogId: "pending-log" }];
  });
  const result = await dispatchPendingTelegramTranscripts(db, async (id) => { delivered.push(id); }, { now });
  assert.deepEqual(delivered, ["pending-log", "stale-claim-log"]);
  assert.deepEqual(result, { selected: 3, attempted: 2, failed: 0 });
});

test("keeps processing later rows after a delivery error without exposing exception details", async () => {
  const db = mockDatabase(async () => [{ callLogId: "failed" }, { callLogId: "next" }]);
  const attempted: string[] = [];
  const warnings: string[] = [];
  const result = await dispatchPendingTelegramTranscripts(db, async (id) => {
    attempted.push(id);
    if (id === "failed") throw new Error("bot-token-sensitive-private-payload");
  }, { warn: (message) => warnings.push(message) });
  assert.deepEqual(attempted, ["failed", "next"]);
  assert.equal(result.failed, 1);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings.join(" "), /token|private|payload/);
});

test("bounds batches even when an invalid caller option requests too many or no rows", async () => {
  const limits: unknown[] = [];
  const db = mockDatabase(async (query) => { limits.push(query?.take); return []; });
  await dispatchPendingTelegramTranscripts(db, async () => {}, { batchSize: 1_000 });
  await dispatchPendingTelegramTranscripts(db, async () => {}, { batchSize: 0 });
  await dispatchPendingTelegramTranscripts(db, async () => {}, { batchSize: Number.NaN });
  assert.deepEqual(limits, [100, 1, 20]);
});

test("runs immediately at boot, on later intervals and never again after shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let queries = 0;
  const db = mockDatabase(async () => { queries += 1; return []; });
  const stop = startTelegramDispatcher({ db, deliver: async () => {} });
  await flush();
  assert.equal(queries, 1);
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(queries, 2);
  await stop();
  t.mock.timers.tick(90_000);
  await flush();
  assert.equal(queries, 2);
});

test("does not overlap slow batches and stops before beginning another send during shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let queries = 0;
  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const attempted: string[] = [];
  const db = mockDatabase(async () => {
    queries += 1;
    return [{ callLogId: "first" }, { callLogId: "second" }];
  });
  const stop = startTelegramDispatcher({ db, deliver: async (id) => { attempted.push(id); await pending; } });
  await flush();
  t.mock.timers.tick(90_000);
  await flush();
  assert.equal(queries, 1);
  assert.deepEqual(attempted, ["first"]);
  const stopped = stop();
  release();
  await stopped;
  assert.deepEqual(attempted, ["first"]);
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(queries, 1);
});

test("a failed lookup is sanitized and does not prevent the next scheduled recovery pass", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const warnings: string[] = [];
  let queries = 0;
  const db = mockDatabase(async () => {
    queries += 1;
    if (queries === 1) throw new Error("database-private-connection-secret");
    return [];
  });
  const stop = startTelegramDispatcher({ db, deliver: async () => {}, warn: (message) => warnings.push(message) });
  await flush();
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0] ?? "", /private|secret/);
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(queries, 2);
  await stop();
});

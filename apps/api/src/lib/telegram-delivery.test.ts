import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import https from "node:https";
import { TranscriptDeliveryStatus } from "@prisma/client";
import { env } from "../config.js";
import { prisma } from "./prisma.js";
import { deliverTelegramTranscript, TelegramDeliveryError, TELEGRAM_DELIVERY_STALE_MS } from "./telegram.js";

type Row = {
  id: string;
  status: TranscriptDeliveryStatus;
  claimedAt: Date | null;
  claimToken: string | null;
  target?: string | null;
  payloadPreview?: string | null;
};

function fixture(t: TestContext, input: {
  rows?: Row[];
  telegram?: { status: string; chatId?: string | null; username?: string | null } | null;
  failCompletion?: boolean;
} = {}) {
  const rows = input.rows ?? [{ id: "delivery-1", status: TranscriptDeliveryStatus.PENDING, claimedAt: null, claimToken: null }];
  let inTransaction = false;
  let tail = Promise.resolve();
  let locks = 0;
  const storedLog = () => ({
    id: "call-1", direction: "INBOUND", customerPhone: "+79990000001", transcript: "User: Hello.\nAssi: Hello.",
    transcriptDeliveries: structuredClone(rows),
    assistantProfile: { user: { telegramAccount: input.telegram === undefined
      ? { status: "CONNECTED", chatId: "12345" } : input.telegram } },
  });
  type Update = { where: { id: string | { in: string[] }; status: TranscriptDeliveryStatus; claimToken?: string }; data: Partial<Row> };
  async function updateMany({ where, data }: Update) {
    if (input.failCompletion && !inTransaction) throw new Error("Database unavailable after send");
    let count = 0;
    for (const row of rows) {
      if ((typeof where.id === "string" ? row.id !== where.id : !where.id.in.includes(row.id)) ||
          row.status !== where.status || (where.claimToken !== undefined && row.claimToken !== where.claimToken)) continue;
      Object.assign(row, data);
      count += 1;
    }
    return { count };
  }
  const transaction = async (run: (tx: unknown) => Promise<unknown>) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    inTransaction = true;
    try {
      return await run({
        $executeRaw: async (parts: TemplateStringsArray, callLogId: string) => {
          assert.match(parts.join(""), /pg_advisory_xact_lock/);
          assert.match(parts.join(""), /callsec:telegram-transcript/);
          assert.equal(callLogId, "call-1");
          locks += 1;
          return 1;
        },
        callLog: { findUnique: async () => storedLog() },
        transcriptDelivery: { updateMany },
      });
    } finally { inTransaction = false; release(); }
  };
  const originals = { transaction: prisma.$transaction, findUnique: prisma.callLog.findUnique,
    updateMany: prisma.transcriptDelivery.updateMany, botToken: env.TELEGRAM_BOT_TOKEN };
  prisma.$transaction = transaction as unknown as typeof prisma.$transaction;
  prisma.callLog.findUnique = (async () => storedLog()) as unknown as typeof prisma.callLog.findUnique;
  prisma.transcriptDelivery.updateMany = updateMany as unknown as typeof prisma.transcriptDelivery.updateMany;
  env.TELEGRAM_BOT_TOKEN = "test-only-not-a-real-bot-token";
  t.after(() => {
    prisma.$transaction = originals.transaction;
    prisma.callLog.findUnique = originals.findUnique;
    prisma.transcriptDelivery.updateMany = originals.updateMany;
    env.TELEGRAM_BOT_TOKEN = originals.botToken;
  });
  return { rows, isInTransaction: () => inTransaction, lockCount: () => locks };
}

test("two concurrent delivery workers claim once and never hold a transaction while sending", async (t) => {
  const f = fixture(t);
  let sends = 0;
  let started!: () => void;
  const sent = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const send = async (chatId: string) => {
    assert.equal(f.isInTransaction(), false);
    assert.equal(chatId, "12345");
    sends += 1;
    started();
    await blocked;
  };
  const first = deliverTelegramTranscript("call-1", send);
  await sent;
  await deliverTelegramTranscript("call-1", send);
  assert.equal(sends, 1);
  assert.equal(f.rows[0]!.status, TranscriptDeliveryStatus.SENDING);
  release();
  await first;
  assert.equal(f.rows[0]!.status, TranscriptDeliveryStatus.SENT);
  assert.equal(f.rows[0]!.claimToken, null);
  assert.equal(f.lockCount(), 2);
});

test("an ambiguous transport failure becomes UNKNOWN and is never retried", async (t) => {
  const f = fixture(t);
  let sends = 0;
  const send = async () => { sends += 1; throw new Error("socket timeout with private transport details"); };
  await deliverTelegramTranscript("call-1", send);
  await deliverTelegramTranscript("call-1", send);
  assert.equal(sends, 1);
  assert.equal(f.rows[0]!.status, TranscriptDeliveryStatus.UNKNOWN);
  assert.doesNotMatch(f.rows[0]!.payloadPreview!, /private transport/);
});

test("a confirmed rejection is FAILED but neither it nor legacy FAILED is automatically resent", async (t) => {
  const f = fixture(t);
  let sends = 0;
  const send = async () => { sends += 1; throw new TelegramDeliveryError("FAILED", "Telegram rejected request"); };
  await deliverTelegramTranscript("call-1", send);
  await deliverTelegramTranscript("call-1", send);
  assert.equal(sends, 1);
  assert.equal(f.rows[0]!.status, TranscriptDeliveryStatus.FAILED);
});

test("a crashed sender's stale claim becomes UNKNOWN without reclaiming or sending", async (t) => {
  const f = fixture(t, { rows: [{ id: "delivery-1", status: TranscriptDeliveryStatus.SENDING,
    claimedAt: new Date(Date.now() - TELEGRAM_DELIVERY_STALE_MS - 1), claimToken: "old-claim" }] });
  await deliverTelegramTranscript("call-1", async () => { assert.fail("A stale claim must not send again"); });
  assert.equal(f.rows[0]!.status, TranscriptDeliveryStatus.UNKNOWN);
  assert.equal(f.rows[0]!.claimToken, null);
});

test("unknown legacy claim time is treated conservatively as UNKNOWN", async (t) => {
  const f = fixture(t, { rows: [{ id: "delivery-1", status: TranscriptDeliveryStatus.SENDING,
    claimedAt: null, claimToken: null }] });
  await deliverTelegramTranscript("call-1", async () => { assert.fail("An interrupted claim must not send again"); });
  assert.equal(f.rows[0]!.status, TranscriptDeliveryStatus.UNKNOWN);
});

test("a completed send with failed persistence is not repeated after lease expiry", async (t) => {
  const f = fixture(t, { failCompletion: true });
  let sends = 0;
  await assert.rejects(deliverTelegramTranscript("call-1", async () => { sends += 1; }), /Database unavailable/);
  assert.equal(f.rows[0]!.status, TranscriptDeliveryStatus.SENDING);
  f.rows[0]!.claimedAt = new Date(Date.now() - TELEGRAM_DELIVERY_STALE_MS - 1);
  await deliverTelegramTranscript("call-1", async () => { sends += 1; });
  assert.equal(sends, 1);
  assert.equal(f.rows[0]!.status, TranscriptDeliveryStatus.UNKNOWN);
});

test("any sent, sending, unknown or legacy failed sibling blocks historical pending rows", async (t) => {
  const f = fixture(t, { rows: [
    { id: "new-pending", status: TranscriptDeliveryStatus.PENDING, claimedAt: null, claimToken: null },
    { id: "older-sent", status: TranscriptDeliveryStatus.SENT, claimedAt: null, claimToken: null },
  ] });
  for (const status of [TranscriptDeliveryStatus.SENT, TranscriptDeliveryStatus.SENDING,
    TranscriptDeliveryStatus.UNKNOWN, TranscriptDeliveryStatus.FAILED]) {
    f.rows[1]!.status = status;
    f.rows[1]!.claimedAt = new Date();
    await deliverTelegramTranscript("call-1", async () => { assert.fail("A sibling already owns this delivery"); });
  }
  assert.equal(f.rows[0]!.status, TranscriptDeliveryStatus.PENDING);
});

test("missing, disconnected and username-only Telegram targets never send", async (t) => {
  const f = fixture(t, { telegram: { status: "CONNECTED", username: "display_name" } });
  await deliverTelegramTranscript("call-1", async () => { assert.fail("A username is not a verified chat target"); });
  assert.equal(f.rows[0]!.status, TranscriptDeliveryStatus.FAILED);
});

test("a connected negative group chat ID remains a valid tenant target", async (t) => {
  const f = fixture(t, { telegram: { status: "CONNECTED", chatId: "-1001234567890" } });
  await deliverTelegramTranscript("call-1", async (chatId) => assert.equal(chatId, "-1001234567890"));
  assert.equal(f.rows[0]!.status, TranscriptDeliveryStatus.SENT);
});

test("real transport classifies explicit rejection separately from ambiguous HTTP and socket outcomes", async (t) => {
  for (const input of [
    { name: "success", statusCode: 200, body: '{"ok":true}', status: TranscriptDeliveryStatus.SENT },
    { name: "rejection", statusCode: 400, body: '{"ok":false}', status: TranscriptDeliveryStatus.FAILED },
    { name: "server error", statusCode: 502, body: '{"ok":false}', status: TranscriptDeliveryStatus.UNKNOWN },
    { name: "invalid response", statusCode: 200, body: 'broken JSON', status: TranscriptDeliveryStatus.UNKNOWN },
    { name: "oversized response", statusCode: 200, body: 'x'.repeat(256 * 1024 + 1), status: TranscriptDeliveryStatus.UNKNOWN },
    { name: "aborted response", statusCode: 200, body: '', event: 'aborted', status: TranscriptDeliveryStatus.UNKNOWN },
    { name: "socket timeout", statusCode: 200, body: '', event: 'timeout', status: TranscriptDeliveryStatus.UNKNOWN },
    { name: "socket error", statusCode: 200, body: '', event: 'error', status: TranscriptDeliveryStatus.UNKNOWN },
  ]) {
    await t.test(input.name, async (t) => {
      const f = fixture(t);
      let requests = 0;
      const request = ((_url: unknown, options: { timeout: number }, callback: (response: unknown) => void) => {
        assert.equal(options.timeout, 30_000);
        requests += 1;
        const req = Object.assign(new EventEmitter(), {
          destroy() { return req; },
          end() {
            queueMicrotask(() => {
              if (input.event === 'timeout') { req.emit('timeout'); return; }
              if (input.event === 'error') { req.emit('error', new Error('sensitive proxy details')); return; }
              const response = Object.assign(new EventEmitter(), {
                statusCode: input.statusCode,
                destroy() { response.emit('aborted'); return response; },
              });
              callback(response);
              if (input.event === 'aborted') { response.emit('aborted'); return; }
              response.emit('data', Buffer.from(input.body));
              response.emit('end');
            });
          },
        });
        return req;
      }) as unknown as typeof https.request;
      t.mock.method(https, "request", request);
      await deliverTelegramTranscript("call-1");
      await deliverTelegramTranscript("call-1");
      assert.equal(requests, 1);
      assert.equal(f.rows[0]!.status, input.status);
      assert.doesNotMatch(f.rows[0]!.payloadPreview!, /sensitive proxy details/);
    });
  }
});

test("the absolute transport deadline terminates an otherwise silent request", async (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  let destroyed = false;
  t.mock.method(https, "request", (() => {
    const req = Object.assign(new EventEmitter(), {
      end() { started(); },
      destroy() { destroyed = true; return req; },
    });
    return req;
  }) as unknown as typeof https.request);
  const attempt = deliverTelegramTranscript("call-1");
  await requested;
  t.mock.timers.tick(30_000);
  await attempt;
  assert.equal(destroyed, true);
  assert.equal(f.rows[0]!.status, TranscriptDeliveryStatus.UNKNOWN);
});

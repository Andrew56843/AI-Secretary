import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import type { Prisma } from "@prisma/client";

function integrationDatabaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Integration tests require an explicit isolated local PostgreSQL test database");
  }
  if (!["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !/^\/[a-z0-9_]+_test$/i.test(url.pathname) || !url.username ||
      url.search || url.hash) {
    throw new Error("Integration tests require an explicit isolated local PostgreSQL test database");
  }
  return url.toString();
}

test("integration database guard refuses remote hosts, non-test databases and connection overrides", () => {
  for (const value of [
    "postgresql://test:test@83.217.203.61/callsec_test",
    "postgresql://test:test@127.0.0.1/callsec",
    "postgresql://test:test@127.0.0.1/callsec_test?host=remote.example",
    "postgresql://test:test@127.0.0.1/callsec_test?schema=production",
    "postgresql://test:test@127.0.0.1/callsec_test#ignored",
    "postgresql://test:test@localhost/callsec_test/other",
    "not-a-database-url"
  ]) {
    assert.throws(() => integrationDatabaseUrl(value), /isolated local PostgreSQL/);
  }
  assert.equal(
    integrationDatabaseUrl("postgresql://test:test@127.0.0.1:15432/callsec_finalization_test"),
    "postgresql://test:test@127.0.0.1:15432/callsec_finalization_test"
  );
});

const configuredDatabase = process.env.CALLSEC_INTEGRATION_DATABASE_URL;

async function waitForDeliveryStart(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Mock Telegram delivery did not start")), 10_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("PostgreSQL call finalization regressions", { skip: !configuredDatabase, timeout: 60_000 }, async (t) => {
  const databaseUrl = integrationDatabaseUrl(configuredDatabase!);
  // Never inherit production credentials or permit a test to contact an external integration.
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    JWT_SECRET: "local-integration-test-secret-not-used-for-authentication",
    VOICE_SERVICE_TOKEN: "local-integration-test-voice-token",
    SIP_CONFIG_TOKEN: "",
    OPENAI_API_KEY: "",
    OPENAI_PROXY_URL: "",
    SOCKS_PROXY_URL: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    TELEGRAM_BOT_TOKEN: "local-integration-mocked-transport-only",
    TELEGRAM_PROXY_URL: ""
  });

  const { BillingTransactionType, CallDirection, CallStatus, IntegrationStatus, PrismaClient,
    TranscriptChannel, TranscriptDeliveryStatus } = await import("@prisma/client");
  const { prisma } = await import("./prisma.js");
  const secondClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const { captureCallBillingSnapshot } = await import("./call-billing-snapshot.js");
  const { createBillableCallLog } = await import("./billable-call.js");
  const { persistVoiceCallCallback } = await import("./voice-call-callback.js");
  const { deliverTelegramTranscript, TELEGRAM_DELIVERY_STALE_MS } = await import("./telegram.js");

  t.after(async () => {
    await Promise.all([prisma.$disconnect(), secondClient.$disconnect()]);
  });

  async function tenant(mode: "INBOUND" | "OUTBOUND" = CallDirection.OUTBOUND) {
    const phone = `+700${String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, "0")}`;
    const user = await prisma.user.create({ data: {
      phone, password: "not-a-login-password", fullName: "Local integration test",
      rubleBalanceKopecks: 10_000,
      profiles: { create: {
        mode, prompt: "Local integration fixture", greetingText: "Test",
        forwardingPhone: "", realtimeModel: "gpt-realtime-2"
      } },
      billingTransactions: { create: { type: BillingTransactionType.FREE_GRANT, amountKopecks: 10_000 } }
    }, include: { profiles: true } });
    return { user, profile: user.profiles[0]! };
  }

  await t.test("the selected model and rate survive profile edits and repeated snapshot capture", async () => {
    for (const entry of [
      { start: "gpt-realtime-2", later: "gpt-realtime-mini", rate: 1200 },
      { start: "gpt-realtime-mini", later: "gpt-realtime-2", rate: 700 }
    ]) {
      const { user, profile } = await tenant();
      try {
        const callUuid = randomUUID();
        const identity = { callUuid, assistantProfileId: profile.id, direction: CallDirection.OUTBOUND,
          customerPhone: "+70000000001" };
        const original = await prisma.$transaction((tx) => captureCallBillingSnapshot(tx, {
          ...identity, realtimeModel: entry.start
        }));
        await prisma.assistantProfile.update({ where: { id: profile.id }, data: { realtimeModel: entry.later } });
        const repeated = await secondClient.$transaction((tx) => captureCallBillingSnapshot(tx, {
          ...identity, realtimeModel: entry.later
        }));
        assert.equal(repeated.realtimeModel, entry.start);
        assert.equal(repeated.rateKopecksPerMinute, entry.rate);
        assert.equal(repeated.createdAt.toISOString(), original.createdAt.toISOString());

        await prisma.$transaction((tx) => createBillableCallLog(tx, {
          ...identity, status: CallStatus.SUCCESS, durationSeconds: 60, summary: "Snapshot regression"
        }));
        const charges = await prisma.billingTransaction.findMany({
          where: { userId: user.id, type: BillingTransactionType.CALL_CHARGE }
        });
        assert.equal(charges.length, 1);
        assert.equal(charges[0]!.amountKopecks, -entry.rate);
        assert.ok(charges[0]!.note?.includes(entry.start));
        assert.equal(await prisma.callBillingSnapshot.count({ where: { callUuid } }), 1);
      } finally {
        await prisma.user.delete({ where: { id: user.id } });
      }
    }
  });

  await t.test("three concurrent callbacks create one log, one charge and one contact attempt", async () => {
    const { user, profile } = await tenant();
    try {
      const callUuid = randomUUID();
      const contact = await prisma.outboundContact.create({ data: {
        userId: user.id, phone: "+70000000001", callMode: CallDirection.OUTBOUND,
        queuedForCall: true, activeCallUuid: callUuid
      } });
      await prisma.activeCall.create({ data: {
        userId: user.id, assistantProfileId: profile.id, callUuid,
        outboundContactId: contact.id, direction: CallDirection.OUTBOUND, customerPhone: contact.phone
      } });
      const input = {
        callUuid, userId: user.id, assistantProfileId: profile.id, direction: CallDirection.OUTBOUND,
        customerPhone: contact.phone, status: CallStatus.MISSED, durationSeconds: 0, summary: "Missed regression"
      };
      const finish = async (tx: Prisma.TransactionClient, callLogId: string) =>
        tx.outboundContact.update({ where: { id: contact.id }, data: {
          attempts: { increment: 1 }, queuedForCall: false, activeCallUuid: null, lastCallLogId: callLogId
        } });
      const results = await Promise.all([
        persistVoiceCallCallback(prisma, input, finish),
        persistVoiceCallCallback(secondClient, input, finish),
        persistVoiceCallCallback(prisma, input, finish)
      ]);
      assert.equal(results.filter((result) => result.created).length, 1);
      assert.equal(new Set(results.map((result) => result.log.id)).size, 1);
      assert.equal(await prisma.callLog.count({ where: { callUuid } }), 1);
      assert.equal(await prisma.billingTransaction.count({
        where: { userId: user.id, type: BillingTransactionType.CALL_CHARGE }
      }), 1);
      assert.equal((await prisma.outboundContact.findUniqueOrThrow({ where: { id: contact.id } })).attempts, 1);
      assert.equal(await prisma.activeCall.count({ where: { callUuid } }), 0);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  async function telegramFixture() {
    const fixture = await tenant();
    try {
      await prisma.telegramAccount.create({ data: {
        userId: fixture.user.id, linkToken: randomUUID(), status: IntegrationStatus.CONNECTED, chatId: "123456789"
      } });
      const log = await prisma.callLog.create({ data: {
        assistantProfileId: fixture.profile.id, callUuid: randomUUID(), direction: CallDirection.OUTBOUND,
        customerPhone: "+70000000001", status: CallStatus.SUCCESS, transcript: "Assi: Test\nUser: Test"
      } });
      const delivery = await prisma.transcriptDelivery.create({ data: {
        userId: fixture.user.id, callLogId: log.id, channel: TranscriptChannel.TELEGRAM
      } });
      return { ...fixture, log, delivery };
    } catch (error) {
      await prisma.user.delete({ where: { id: fixture.user.id } });
      throw error;
    }
  }

  await t.test("parallel Telegram delivery claims send once, including historical pending siblings", async () => {
    const { user, log } = await telegramFixture();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started: () => void = () => {};
    const sending = new Promise<void>((resolve) => { started = resolve; });
    let sends = 0;
    const send = async () => { sends += 1; started(); await gate; };
    let first: ReturnType<typeof deliverTelegramTranscript> | undefined;
    try {
      await prisma.transcriptDelivery.create({ data: {
        userId: user.id, callLogId: log.id, channel: TranscriptChannel.TELEGRAM
      } });
      first = deliverTelegramTranscript(log.id, send);
      await waitForDeliveryStart(Promise.race([sending, first.then(() => {
        throw new Error("Telegram claim completed without starting the mock delivery");
      })]));
      await Promise.all([deliverTelegramTranscript(log.id, send), deliverTelegramTranscript(log.id, send)]);
      release();
      await first;
      await deliverTelegramTranscript(log.id, send);
      assert.equal(sends, 1);
      assert.equal(await prisma.transcriptDelivery.count({ where: {
        callLogId: log.id, status: TranscriptDeliveryStatus.SENT
      } }), 1);
    } finally {
      release();
      try {
        await first;
      } finally {
        await prisma.user.delete({ where: { id: user.id } });
      }
    }
  });

  await t.test("a stale sending lease becomes UNKNOWN and never triggers an automatic resend", async () => {
    const { user, log, delivery } = await telegramFixture();
    try {
      await prisma.transcriptDelivery.update({ where: { id: delivery.id }, data: {
        status: TranscriptDeliveryStatus.SENDING, claimToken: "interrupted-worker",
        claimedAt: new Date(Date.now() - TELEGRAM_DELIVERY_STALE_MS - 1000)
      } });
      let sends = 0;
      const send = async () => { sends += 1; };
      await deliverTelegramTranscript(log.id, send);
      await deliverTelegramTranscript(log.id, send);
      assert.equal(sends, 0);
      const stored = await prisma.transcriptDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      assert.equal(stored.status, TranscriptDeliveryStatus.UNKNOWN);
      assert.equal(stored.claimToken, null);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

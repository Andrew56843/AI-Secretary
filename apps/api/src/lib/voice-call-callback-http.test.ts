import assert from "node:assert/strict";
import test from "node:test";
import { CallDirection, CallStatus } from "@prisma/client";
import express from "express";
import { env } from "../config.js";
import { drainVoiceCallDeliveries, voiceInternalRouter } from "../routes/voice-internal.js";
import { prisma } from "./prisma.js";

test("callbacks respond immediately while shutdown drains existing, late and failed Telegram tasks safely", async (t) => {
  const original = {
    token: env.VOICE_SERVICE_TOKEN,
    transaction: prisma.$transaction,
    profile: prisma.assistantProfile.findUnique,
    log: prisma.callLog.findUnique,
    error: console.error
  };
  const voiceToken = "test-only-call-callback-token-000000000000000";
  env.VOICE_SERVICE_TOKEN = voiceToken;
  const log = { id: "log-1", callUuid: "call-1", assistantProfileId: "profile-1", direction: CallDirection.OUTBOUND,
    customerPhone: "+79990000002", status: CallStatus.MISSED, durationSeconds: 0, createdAt: new Date(),
    transcriptDeliveries: [{ status: "PENDING" }] };
  let transactions = 0;
  let deliveryStarted = false;
  let finishDelivery = (_value: null) => {};
  let finishLateDelivery = (_value: null) => {};
  const deliveryClaim = new Promise<null>((resolve) => { finishDelivery = resolve; });
  const lateDeliveryClaim = new Promise<null>((resolve) => { finishLateDelivery = resolve; });
  const errors: unknown[][] = [];
  console.error = (...values: unknown[]) => { errors.push(values); };
  prisma.$transaction = (async () => {
    transactions += 1;
    if (transactions % 2 === 1) return { log, outbound: { removed: false, attempts: 1 }, created: transactions === 1 };
    deliveryStarted = true;
    if (transactions === 2) return deliveryClaim;
    if (transactions === 4) return lateDeliveryClaim;
    throw new Error("private-database-error-must-not-be-logged");
  }) as unknown as typeof original.transaction;
  prisma.assistantProfile.findUnique = (async () => ({
    id: log.assistantProfileId, userId: "user-1", mode: CallDirection.OUTBOUND, prompt: ""
  })) as unknown as typeof original.profile;
  prisma.callLog.findUnique = (async () => log) as unknown as typeof original.log;

  const app = express();
  app.use(express.json());
  app.use("/internal/voice", voiceInternalRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    finishDelivery(null);
    finishLateDelivery(null);
    await drainVoiceCallDeliveries();
    env.VOICE_SERVICE_TOKEN = original.token;
    prisma.$transaction = original.transaction;
    prisma.assistantProfile.findUnique = original.profile;
    prisma.callLog.findUnique = original.log;
    console.error = original.error;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const send = () => fetch(`http://127.0.0.1:${address.port}/internal/voice/call/logs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voice-service-token": voiceToken },
    body: JSON.stringify({ callUuid: log.callUuid, assistantProfileId: log.assistantProfileId,
      direction: log.direction, customerPhone: log.customerPhone, status: CallStatus.MISSED, durationSeconds: 0 }),
    signal: AbortSignal.timeout(1000)
  });
  const response = await send();
  assert.equal(response.status, 201);
  assert.equal(deliveryStarted, true);
  const result = await response.json() as { log: { id: string; transcriptDeliveries: Array<{ status: string }> } };
  assert.equal(result.log.id, log.id);
  assert.equal(result.log.transcriptDeliveries[0]?.status, "PENDING");

  let drained = false;
  const draining = drainVoiceCallDeliveries().then(() => { drained = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  assert.equal((await send()).status, 201);
  finishDelivery(null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false, "An in-flight HTTP callback can register another delivery during shutdown");
  finishLateDelivery(null);
  await draining;
  assert.equal(drained, true);

  assert.equal((await send()).status, 201);
  await drainVoiceCallDeliveries();
  assert.equal(errors.length, 1);
  assert.doesNotMatch(JSON.stringify(errors), /private-database-error/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { CallDirection, ProfileStatus, type CallBillingSnapshot, type Prisma } from "@prisma/client";
import express from "express";
import { env } from "../config.js";
import { voiceInternalRouter } from "../routes/voice-internal.js";
import { prisma } from "./prisma.js";

test("HTTP admission snapshots billing before marking active and returns the same model after a profile edit", async (t) => {
  const original = {
    voiceToken: env.VOICE_SERVICE_TOKEN, testCaller: env.TEST_CALLER_ID,
    findProfile: prisma.assistantProfile.findFirst,
    findInbound: prisma.assistantProfile.findUnique,
    transaction: prisma.$transaction
  };
  env.VOICE_SERVICE_TOKEN = "test-billing-admission-token-00000000000000";
  env.TEST_CALLER_ID = undefined;
  let currentModel = "gpt-realtime-2";
  let snapshot: CallBillingSnapshot | null = null;
  const events: string[] = [];
  const number = { id: "number-1", number: "+79952225213", providerDid: "did_79952225213", assigned: true, sipLine: null };
  const profile = {
    id: "profile-1", userId: "user-1", mode: CallDirection.INBOUND, status: ProfileStatus.ACTIVE,
    title: "Test profile", businessName: null, prompt: "", greetingText: "Test greeting",
    voice: "marin", maxDialogSeconds: 120, greetingAudioCache: null, reservedNumber: number,
    forwardingEnabled: false, forwardingOnComplete: false, forwardingOnStalemate: false, forwardingPhone: "",
    user: {
      id: "user-1", phone: "+79990000001", timeZone: "Europe/Moscow", rubleBalanceKopecks: 10000,
      numberRentExpiresAt: new Date(Date.now() + 86400_000), googleAccount: null, telegramAccount: null
    }
  };
  prisma.assistantProfile.findFirst = (async () => ({ ...profile, realtimeModel: currentModel })) as unknown as typeof original.findProfile;
  prisma.assistantProfile.findUnique = (async () => ({ reservedNumber: number })) as unknown as typeof original.findInbound;
  const tx = {
    $executeRaw: async () => { events.push("lock"); return 1; },
    callBillingSnapshot: {
      findUnique: async () => { events.push("snapshot-read"); return snapshot; },
      create: async ({ data }: { data: Omit<CallBillingSnapshot, "createdAt"> }) => {
        events.push("snapshot-create");
        snapshot = { ...data, createdAt: new Date() };
        return snapshot;
      }
    },
    activeCall: { upsert: async () => { events.push("active-call"); return {}; } }
  } as unknown as Prisma.TransactionClient;
  prisma.$transaction = (async (callback: (client: Prisma.TransactionClient) => Promise<unknown>) => callback(tx)) as unknown as typeof original.transaction;

  const app = express();
  app.use(express.json());
  app.use("/internal/voice", voiceInternalRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    env.VOICE_SERVICE_TOKEN = original.voiceToken;
    env.TEST_CALLER_ID = original.testCaller;
    prisma.assistantProfile.findFirst = original.findProfile;
    prisma.assistantProfile.findUnique = original.findInbound;
    prisma.$transaction = original.transaction;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const send = () => fetch(`http://127.0.0.1:${address.port}/internal/voice/call/resolve`, {
    method: "POST", headers: {
      "content-type": "application/json", "x-voice-service-token": env.VOICE_SERVICE_TOKEN!
    },
    body: JSON.stringify({
      uuid: "call-start-snapshot", did: number.number, callerId: "+79990000002",
      assistantProfileId: profile.id, direction: "INBOUND"
    })
  });

  const first = await send();
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as { profile: { realtimeModel: string } }).profile.realtimeModel, "gpt-realtime-2");
  assert.deepEqual(events, ["lock", "snapshot-read", "snapshot-create", "active-call"]);
  assert.equal((snapshot as CallBillingSnapshot | null)?.rateKopecksPerMinute, 1000);

  currentModel = "gpt-realtime-mini";
  const repeated = await send();
  assert.equal(repeated.status, 200);
  assert.equal(((await repeated.json()) as { profile: { realtimeModel: string } }).profile.realtimeModel, "gpt-realtime-2");
  assert.deepEqual(events.slice(4), ["lock", "snapshot-read", "active-call"]);
  assert.equal((snapshot as CallBillingSnapshot | null)?.rateKopecksPerMinute, 1000);
});

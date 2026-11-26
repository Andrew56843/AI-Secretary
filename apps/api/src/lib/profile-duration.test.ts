import assert from "node:assert/strict";
import test from "node:test";
import { CallDirection, ProfileStatus, type Prisma } from "@prisma/client";
import express from "express";
import { env } from "../config.js";
import { profilesRouter } from "../routes/profiles.js";
import { createToken } from "./auth.js";
import { createGreetingAudioCacheKey } from "./greeting-audio.js";
import { prisma } from "./prisma.js";

test("profile updates save one-second and ten-minute limits and reject invalid durations", async (t) => {
  const original = {
    findUser: prisma.user.findUnique,
    findProfile: prisma.assistantProfile.findUnique,
    transaction: prisma.$transaction,
    openAiKey: env.OPENAI_API_KEY
  };
  env.OPENAI_API_KEY = undefined;
  const user = { id: "duration-user", phone: "+79990000001", authVersion: 0 };
  const payload = {
    title: "Duration test profile",
    businessName: "Test business",
    prompt: "Answer service questions briefly and politely.",
    greetingText: "Здравствуйте! Чем помочь?",
    voice: "alloy",
    forwardingEnabled: true,
    maxDialogSeconds: 120
  };
  let profile = {
    id: "duration-profile", userId: user.id, mode: CallDirection.INBOUND,
    status: ProfileStatus.ACTIVE, forwardingPhone: user.phone,
    forwardingOnComplete: true, forwardingOnStalemate: true,
    realtimeModel: "gpt-realtime-2", reservedNumber: null,
    _count: { callLogs: 0 }, ...payload,
    greetingAudioCache: { cacheKey: createGreetingAudioCacheKey(payload.greetingText, payload.voice) }
  };
  let writes = 0;
  prisma.user.findUnique = (async () => user) as unknown as typeof original.findUser;
  prisma.assistantProfile.findUnique = (async () => profile) as unknown as typeof original.findProfile;
  const tx = {
    user: { findUniqueOrThrow: async () => user },
    assistantProfile: {
      findUnique: async () => profile,
      update: async ({ data }: { data: { maxDialogSeconds: number } }) => {
        writes += 1;
        profile = { ...profile, ...data };
        return profile;
      }
    }
  } as unknown as Prisma.TransactionClient;
  prisma.$transaction = (async (callback: (client: Prisma.TransactionClient) => Promise<unknown>) => callback(tx)) as unknown as typeof original.transaction;

  const app = express();
  app.use(express.json());
  app.use("/profiles", profilesRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => {
    prisma.user.findUnique = original.findUser;
    prisma.assistantProfile.findUnique = original.findProfile;
    prisma.$transaction = original.transaction;
    env.OPENAI_API_KEY = original.openAiKey;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const token = createToken({ userId: user.id, phone: user.phone, authVersion: user.authVersion });
  const send = (seconds: number) => fetch(`http://127.0.0.1:${address.port}/profiles/inbound`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...payload, maxDialogSeconds: seconds })
  });

  for (const seconds of [1, 600]) {
    const response = await send(seconds);
    assert.equal(response.status, 200);
    const result = await response.json() as { profile: { maxDialogSeconds: number } };
    assert.equal(result.profile.maxDialogSeconds, seconds);
  }
  assert.equal(writes, 2);
  for (const seconds of [0, -1, 1.5, 601]) {
    const response = await send(seconds);
    assert.equal(response.status, 400);
  }
  assert.equal(writes, 2, "invalid durations must not update the profile");
});

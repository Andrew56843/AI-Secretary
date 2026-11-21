import assert from "node:assert/strict";
import test from "node:test";
import { CallDirection } from "@prisma/client";
import express from "express";
import { env } from "../config.js";
import { voiceInternalRouter } from "../routes/voice-internal.js";
import { prisma } from "./prisma.js";
import { validateVoiceCallBinding } from "./voice-call-binding.js";

const now = new Date("2026-11-21T12:00:00.000Z");
const ownedNumber = { number: "+79952225213", assigned: true };
const expiresAt = new Date("2036-12-21T12:00:00.000Z");
const profile = { id: "profile-1", userId: "user-1", mode: CallDirection.OUTBOUND };
const queued = {
  id: "contact-1", userId: profile.userId, phone: "+79990000002", callMode: CallDirection.OUTBOUND,
  queuedForCall: true, activeCallUuid: null
};
const request = {
  uuid: "call-1", did: ownedNumber.number, callerId: queued.phone,
  assistantProfileId: profile.id, direction: "OUTBOUND" as const, outboundContactId: queued.id
};
const base = { request, profile, ownedNumber, numberRentExpiresAt: expiresAt, outboundContact: queued,
  route: { callerId: ownedNumber.number }, now };

test("an authorized queued call and repeated resolution of the same UUID keep their binding", () => {
  assert.equal(validateVoiceCallBinding(base).ok, true);
  assert.equal(validateVoiceCallBinding({ ...base, outboundContact: { ...queued, activeCallUuid: request.uuid } }).ok, true);
});

test("queued calls reject missing, unclaimed, cross-tenant, wrong-mode and wrong-UUID contacts", () => {
  for (const contact of [null, { ...queued, queuedForCall: false }, { ...queued, userId: "another-user" },
    { ...queued, callMode: CallDirection.INBOUND }, { ...queued, activeCallUuid: "another-call" }]) {
    assert.equal(validateVoiceCallBinding({ ...base, outboundContact: contact }).ok, false);
  }
});

test("queued metadata must match caller, profile, current DID, direction and a complete call identity", () => {
  for (const change of [
    { callerId: "+79990000003" }, { assistantProfileId: "another-profile" }, { did: "+79952225212" },
    { direction: "INBOUND" as const }, { callerId: undefined }, { did: undefined }, { uuid: undefined },
    { assistantProfileId: undefined }, { direction: undefined }
  ]) {
    assert.equal(validateVoiceCallBinding({ ...base, request: { ...request, ...change } }).ok, false);
  }
});

test("an inbound-scenario owner test may use its explicitly authorized service route without a rental", () => {
  const inboundProfile = { ...profile, mode: CallDirection.INBOUND };
  const inboundContact = { ...queued, callMode: CallDirection.INBOUND, phone: "+79990000001" };
  const inboundRequest = { ...request, direction: "INBOUND" as const, callerId: inboundContact.phone, did: "+79952225212" };
  assert.equal(validateVoiceCallBinding({ ...base, profile: inboundProfile, ownedNumber: null,
    numberRentExpiresAt: null, request: inboundRequest, outboundContact: inboundContact,
    route: { callerId: inboundRequest.did } }).ok, true);
});

test("actual incoming calls require the assigned unexpired called number but not an outbound SIP route", () => {
  const incoming = { ...base, profile: { ...profile, mode: CallDirection.INBOUND }, outboundContact: null,
    request: { did: ownedNumber.number, callerId: "+441234567890", assistantProfileId: profile.id, direction: "INBOUND" as const },
    route: null };
  assert.equal(validateVoiceCallBinding(incoming).ok, true);
  assert.equal(validateVoiceCallBinding({ ...incoming, request: { ...incoming.request, did: "+79952225212" } }).ok, false);
  assert.equal(validateVoiceCallBinding({ ...incoming, ownedNumber: { ...ownedNumber, assigned: false } }).ok, false);
  assert.equal(validateVoiceCallBinding({ ...incoming, numberRentExpiresAt: null }).ok, false);
  assert.equal(validateVoiceCallBinding({ ...incoming, numberRentExpiresAt: now }).ok, false);
  assert.equal(validateVoiceCallBinding({ ...base, outboundContact: null, request: { ...request, outboundContactId: undefined } }).ok, false);
});

test("the HTTP resolver rejects stale DID and missing contacts before changing call or contact state", async (t) => {
  const original = {
    voiceToken: env.VOICE_SERVICE_TOKEN, testCaller: env.TEST_CALLER_ID,
    findProfile: prisma.assistantProfile.findFirst, findInbound: prisma.assistantProfile.findUnique,
    findContact: prisma.outboundContact.findFirst, updateContact: prisma.outboundContact.updateMany,
    activeUpsert: prisma.activeCall.upsert
  };
  env.VOICE_SERVICE_TOKEN = "test-only-voice-binding-token-00000000000000";
  env.TEST_CALLER_ID = undefined;
  let contactResult: typeof queued | null = queued;
  let writes = 0;
  const routeNumber = { ...ownedNumber, sipLine: { enabled: true, asteriskEndpoint: "callsec-sip-79952225213",
    server: "sip.novofon.ru", port: 5061, transport: "tls", updatedAt: now } };
  prisma.assistantProfile.findFirst = (async () => ({ ...profile, reservedNumber: ownedNumber,
    user: { phone: "+79990000001", rubleBalanceKopecks: 1000, numberRentExpiresAt: expiresAt } })) as unknown as typeof original.findProfile;
  prisma.assistantProfile.findUnique = (async () => ({ reservedNumber: routeNumber })) as unknown as typeof original.findInbound;
  prisma.outboundContact.findFirst = (async () => contactResult) as unknown as typeof original.findContact;
  prisma.outboundContact.updateMany = (async () => { writes += 1; return { count: 1 }; }) as unknown as typeof original.updateContact;
  prisma.activeCall.upsert = (async () => { writes += 1; throw new Error("Invalid requests must not reach active-call writes"); }) as unknown as typeof original.activeUpsert;

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
    prisma.outboundContact.findFirst = original.findContact;
    prisma.outboundContact.updateMany = original.updateContact;
    prisma.activeCall.upsert = original.activeUpsert;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/internal/voice/call/resolve`;
  const send = (body: typeof request) => fetch(url, { method: "POST", headers: {
    "content-type": "application/json", "x-voice-service-token": env.VOICE_SERVICE_TOKEN!
  }, body: JSON.stringify(body) });
  assert.equal((await send({ ...request, did: "+79952225212" })).status, 409);
  contactResult = null;
  assert.equal((await send(request)).status, 409);
  assert.equal(writes, 0);
});

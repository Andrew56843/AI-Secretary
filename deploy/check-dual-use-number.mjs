import assert from 'node:assert/strict';
import { prisma } from '/app/apps/api/dist/lib/prisma.js';

const phone = '+70000000001';
const otherCaller = '+70000000002';
const fixtureIds = [];
let checks = 0;
async function resolve(did, callerId, extra = {}) {
  const response = await fetch('http://127.0.0.1:4000/internal/voice/call/resolve', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-voice-service-token': process.env.VOICE_SERVICE_TOKEN },
    body: JSON.stringify({ did, callerId, direction: 'INBOUND', ...extra }),
  });
  return { status: response.status, body: await response.json() };
}
async function fixture(purpose, expired = false) {
  const request = await prisma.phoneVerificationRequest.create({
    data: { phone, purpose, expiresAt: new Date(Date.now() + (expired ? -60000 : 60000)) },
  });
  fixtureIds.push(request.id);
  return request;
}
async function assertStatus(id, status) {
  assert.equal((await prisma.phoneVerificationRequest.findUniqueOrThrow({ where: { id } })).status, status);
}
try {
  assert.equal(await prisma.phoneVerificationRequest.count({ where: { phone: { in: [phone, otherCaller] } } }), 0,
    'Synthetic test phones already have verification records; refusing to alter them.');
  const number = await prisma.reservedPhoneNumber.findUniqueOrThrow({
    where: { number: '+79952225212' }, include: { profiles: { where: { mode: 'INBOUND' } } },
  });
  assert.equal(number.profiles.length, 1);
  const inbound = number.profiles[0];
  const outbound = await prisma.assistantProfile.findUniqueOrThrow({ where: { userId_mode: { userId: inbound.userId, mode: 'OUTBOUND' } } });
  const normal = await resolve('did_79952225212', phone);
  assert.equal(normal.status, 200);
  assert.equal(normal.body.profile.assistantProfileId, inbound.id);
  checks++;
  for (const purpose of ['REGISTER', 'RECOVER']) {
    const request = await fixture(purpose);
    const wrongCaller = await resolve('79952225212', otherCaller);
    assert.equal(wrongCaller.body.profile.assistantProfileId, inbound.id);
    await assertStatus(request.id, 'PENDING');
    checks++;
    const matching = await resolve('+79952225212', phone);
    assert.equal(matching.body.profile.action, 'HANGUP');
    assert.equal(matching.body.profile.reason, 'PHONE_VERIFICATION');
    await assertStatus(request.id, 'VERIFIED');
    checks++;
    const repeated = await resolve('79952225212', phone);
    assert.equal(repeated.body.profile.assistantProfileId, inbound.id);
    checks++;
  }
  const pending = await fixture('RECOVER');
  const outgoing = await resolve('79952225212', phone, { direction: 'OUTBOUND', assistantProfileId: outbound.id });
  assert.equal(outgoing.body.profile.assistantProfileId, outbound.id);
  await assertStatus(pending.id, 'PENDING');
  checks++;
  const differentDid = await resolve('79952225213', phone);
  assert.notEqual(differentDid.body.profile?.reason, 'PHONE_VERIFICATION');
  await assertStatus(pending.id, 'PENDING');
  checks++;
  await prisma.phoneVerificationRequest.delete({ where: { id: pending.id } });
  const expired = await fixture('REGISTER', true);
  const expiredCall = await resolve('79952225212', phone);
  assert.equal(expiredCall.body.profile.assistantProfileId, inbound.id);
  await assertStatus(expired.id, 'EXPIRED');
  checks++;
} finally {
  await prisma.phoneVerificationRequest.deleteMany({ where: { id: { in: fixtureIds } } });
  await prisma.$disconnect();
}
console.log(JSON.stringify({ checksPassed: checks, verificationFixturesRemoved: true, phoneCallsCreated: false }));

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { buildOutboundCallFile, getOutboundCallerId } = require('../outbound-call');

test('archived failed calls retain their UUID for idempotent log retries', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const from = source.indexOf('async function scanOutboundDoneFiles()');
  const to = source.indexOf('async function outboundDialerTick()', from);
  assert.ok(from > 0 && to > from);
  const uuid = '12345678123442348234123456789abc';
  const inFlight = new Map([[uuid, {
    fileName: 'test.call', job: { id: 'contact-1', phone: '79990000001' },
    profile: { assistantProfileId: 'profile-1', direction: 'OUTBOUND' }, createdAt: Date.now()
  }]]);
  const payloads = [];
  const scan = vm.runInNewContext(`${source.slice(from, to)}\nscanOutboundDoneFiles`, {
    outboundInFlight: inFlight, path,
    CONFIG: { asteriskOutgoingDoneDir: '/test/archived', outboundWaitTimeSec: 45 },
    sudoFileExists: async () => true,
    sudoReadTextFile: async () => 'Status: Failed',
    parseArchivedCallStatus: () => 'Failed',
    getQueuedCallDirection: () => 'OUTBOUND',
    sendPlatformCallLog: async (payload) => { payloads.push(payload); },
    log: () => {}, logErr: () => {},
  });
  await scan();
  await scan();
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].callUuid, uuid);
  assert.equal(payloads[0].durationSeconds, 0);
});

const sipRoute = (number) => ({
  endpoint: `callsec-sip-${number}`,
  number: `+${number}`,
  server: 'sip.novofon.ru',
  port: 5061,
  transport: 'tls',
  revision: '2026-11-21T12:00:00.000Z',
});
const installedSipRoutes = {
  '79952225212': sipRoute('79952225212'),
  '79952225213': sipRoute('79952225213'),
};

const baseCall = {
  uuid: '2f374ebc-2a10-47b3-a012-3456789abcde',
  phone: '+7 (905) 417-62-85',
  job: { id: 'contact-1' },
  installedSipRoutes,
  outboundContext: 'ai-outbound',
  outboundExtension: 's',
  outboundWaitTimeSec: 45,
};

test('uses the client reserved number as outbound caller ID and DID', () => {
  const profile = {
    clientName: 'Callsec client',
    clientId: 'client-1',
    assistantProfileId: 'profile-1',
    direction: 'OUTBOUND',
    outboundCallerId: '+7 995 222-52-12',
    outboundSipLine: installedSipRoutes['79952225212'],
  };

  const content = buildOutboundCallFile({ ...baseCall, profile });

  assert.match(content, /^CallerID: "Callsec client" <79952225212>$/m);
  assert.match(content, /^Setvar: AI_DID=79952225212$/m);
  assert.match(content, /^Setvar: AI_CALLER=79054176285$/m);
  assert.match(content, /^Channel: PJSIP\/79054176285@callsec-sip-79952225212$/m);
  assert.match(content, /^Setvar: AI_SIP_ENDPOINT=callsec-sip-79952225212$/m);
  assert.doesNotMatch(content, /novofon-endpoint/);
  assert.doesNotMatch(content, /^CallerID: .*<79054176285>$/m);
});

test('falls back only to a reserved number from the same profile', () => {
  assert.equal(getOutboundCallerId({ reservedNumber: { number: '+7 999 000-00-01' } }), '79990000001');
  assert.equal(getOutboundCallerId({}), '');
});

test('refuses to create an outbound call without a client number', () => {
  assert.throws(
      () => buildOutboundCallFile({ ...baseCall, profile: { clientName: 'No number' } }),
      /Client reserved number is required/
  );
});

test('preserves the selected inbound scenario when the API authorizes a service test caller ID', () => {
  const profile = {
    assistantProfileId: 'inbound-test-profile',
    clientId: 'inbound-test-profile',
    direction: 'INBOUND',
    reservedNumber: null,
    outboundCallerId: '+79952225212',
    outboundSipLine: installedSipRoutes['79952225212'],
  };

  const content = buildOutboundCallFile({ ...baseCall, profile });

  assert.match(content, /^CallerID: "AI Secretary" <79952225212>$/m);
  assert.match(content, /^Setvar: AI_DID=79952225212$/m);
  assert.match(content, /^Setvar: AI_CALLER=79054176285$/m);
  assert.match(content, /^Setvar: AI_DIRECTION=INBOUND$/m);
  assert.match(content, /^Setvar: AI_ASSISTANT_PROFILE_ID=inbound-test-profile$/m);
  assert.match(content, /^Setvar: AI_CLIENT_ID=inbound-test-profile$/m);
});

test('uses the dedicated endpoint of the rented number, never the shared test line', () => {
  const profile = { outboundCallerId: '+79952225213', outboundSipLine: installedSipRoutes['79952225213'] };
  const content = buildOutboundCallFile({ ...baseCall, profile });
  assert.match(content, /^Channel: PJSIP\/79054176285@callsec-sip-79952225213$/m);
  assert.match(content, /^CallerID: "AI Secretary" <79952225213>$/m);
  assert.doesNotMatch(content, /79952225212/);
});

test('refuses missing, stale and mismatched dedicated routes even with a legacy trunk configured', () => {
  const route = installedSipRoutes['79952225213'];
  const profile = { outboundCallerId: '+79952225213', outboundSipLine: route };
  for (const overrides of [
    { profile: { ...profile, outboundSipLine: null } },
    { profile: { ...profile, outboundSipLine: installedSipRoutes['79952225212'] } },
    { installedSipRoutes: {} },
    { installedSipRoutes: { '79952225213': { ...route, revision: '2026-11-20T12:00:00.000Z' } } },
  ]) {
    assert.throws(() => buildOutboundCallFile({ ...baseCall, profile, outboundTrunk: 'PJSIP/novofon-endpoint/sip', ...overrides }),
      /Dedicated SIP route is not ready/);
  }
});

test('call files contain only the safe SIP endpoint, not credentials', () => {
  const profile = {
    outboundCallerId: '+79952225213',
    outboundSipLine: { ...installedSipRoutes['79952225213'], username: 'test-username', password: 'test-password' },
  };
  const content = buildOutboundCallFile({ ...baseCall, profile });
  assert.doesNotMatch(content, /test-username|test-password|password|username/);
});

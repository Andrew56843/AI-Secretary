'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { normalizeDialPhone } = require('../outbound-call');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

const code = [
  section('function platformApiUrl(', 'async function sendPlatformCallLog('),
  section('function resolveClientConfig(', '// ---------- Metadata registry ----------'),
  section('const callRegistry = new Map();', '\nsetInterval('),
  section('async function authorizeCallStart(', '// ---------- Metadata HTTP server ----------'),
  section('const metadataServer = http.createServer(', '\nmetadataServer.listen('),
  '({ authorizeCallStart, putCallMeta, getCallMeta, resolveClientConfig, metadataServer })'
].join('\n');

const uuid = '12345678-1234-4234-8234-123456789abc';
const queued = {
  uuid, did: '79952225213', callerId: '79990000001',
  assistantProfileId: 'tenant-profile', clientId: 'tenant-profile',
  direction: 'OUTBOUND', outboundContactId: 'tenant-contact',
  sipEndpoint: 'callsec-sip-79952225213'
};
const profile = {
  assistantProfileId: 'tenant-profile', clientId: 'tenant-profile',
  direction: 'OUTBOUND', voice: 'marin',
  outboundCallerId: '+79952225213',
  outboundSipLine: { endpoint: queued.sipEndpoint },
  outboundContact: { id: queued.outboundContactId },
  account: { id: 'tenant-account' }
};

function fixture({ response = { ok: true, profile }, status = 200, error, waitBeforeResponse } = {}) {
  const requests = [];
  const logs = [];
  const api = vm.runInNewContext(code, {
    CONFIG: { platformApiBaseUrl: 'http://127.0.0.1:14000', voiceServiceToken: 'test-token', metadataToken: 'test-metadata', platformApiTimeoutMs: 1000 },
    URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, payload: JSON.parse(options.body) });
      if (error) throw error;
      if (waitBeforeResponse) await waitBeforeResponse;
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(response) };
    },
    logErr: (...args) => logs.push(args),
    log: (...args) => logs.push(args),
    http: { createServer: (handle) => ({ handle }) },
    readJsonBody: async (req) => req.body,
    normalizeUuid: (value) => String(value || '').trim().toLowerCase().replace(/-/g, ''),
    normalizeDialPhone,
    ts: () => 1000,
    baseVoiceConfig: () => ({ voice: 'default', forwardPhone: '', turnDetection: { threshold: 0.6 } }),
  });
  return {
    ...api, requests, logs,
    postStart: async (body, token = 'test-metadata') => {
      const result = {};
      await api.metadataServer.handle({
        method: 'POST', url: '/call/start', body,
        headers: { host: '127.0.0.1:9020', 'x-metadata-token': token }
      }, {
        writeHead: (statusCode) => { result.statusCode = statusCode; },
        end: (text) => { result.text = text; }
      });
      return result;
    }
  };
}

test('a queued profile cannot open an AudioSocket session before fresh start authorization', () => {
  const f = fixture();
  f.putCallMeta({ ...queued, platformProfile: profile, startAuthorized: true });
  assert.equal(f.resolveClientConfig(f.getCallMeta(uuid)), null);
});

test('API timeout and HTTP errors clear cached profiles and reject call start', async () => {
  for (const options of [
    { error: new Error('request timed out') },
    { status: 500, response: { message: 'unavailable' } },
    { status: 404, response: { message: 'No active profile' } },
    { status: 402, response: { message: 'Rent has expired' } }
  ]) {
    const f = fixture(options);
    f.putCallMeta({ ...queued, platformProfile: profile }, true);
    const result = await f.authorizeCallStart({ ...queued, channel: 'PJSIP/test-channel' });
    assert.equal(result.action, 'HANGUP');
    assert.equal(result.reason, 'profile_unavailable');
    assert.equal(f.getCallMeta(uuid).platformProfile, null);
    assert.equal(f.getCallMeta(uuid).raw.platformProfile, null);
    assert.equal(f.resolveClientConfig(f.getCallMeta(uuid)), null);
  }
});

test('request-body profiles and authorization markers cannot bypass API denial', async () => {
  const f = fixture({ status: 403 });
  const result = await f.authorizeCallStart({ ...queued, platformProfile: profile, startAuthorized: true });
  assert.equal(result.action, 'HANGUP');
  assert.equal(f.resolveClientConfig(result.meta), null);
  assert.equal(result.meta.startAuthorized, false);
});

test('malformed or unrecognized successful API responses do not authorize default AI settings', async () => {
  for (const response of [
    {}, { profile }, { ok: false, profile }, { ok: true, profile: null },
    { ok: true, profile: [] }, { ok: true, profile: {} },
    { ok: true, profile: { ...profile, action: 'UNKNOWN' } },
    { ok: true, profile: { ...profile, direction: 'OTHER' } },
  ]) {
    const f = fixture({ response });
    const result = await f.authorizeCallStart(queued);
    assert.equal(result.action, 'HANGUP');
    assert.equal(f.resolveClientConfig(result.meta), null);
  }
});

test('fresh API settings and tenant identity replace cached and submitted values', async () => {
  const fresh = { ...profile, voice: 'cedar' };
  const f = fixture({ response: { ok: true, profile: fresh } });
  f.putCallMeta({ ...queued, platformProfile: profile });
  const result = await f.authorizeCallStart({ ...queued, clientId: 'untrusted-client', accountId: 'untrusted-account' });
  assert.equal(result.action, 'OK');
  assert.deepEqual(JSON.parse(JSON.stringify(result.meta.platformProfile)), fresh);
  assert.equal(result.meta.clientId, fresh.clientId);
  assert.equal(result.meta.accountId, fresh.account.id);
  assert.equal(f.resolveClientConfig(result.meta).voice, 'cedar');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].payload.outboundContactId, queued.outboundContactId);
});

test('explicit API hangup decisions remain authoritative for balance and registration', async () => {
  for (const reason of ['INSUFFICIENT_BALANCE', 'PHONE_VERIFICATION']) {
    const denial = { action: 'HANGUP', reason, direction: 'INBOUND', autoGreeting: false };
    const f = fixture({ response: { ok: true, profile: denial } });
    f.putCallMeta({ ...queued, platformProfile: profile });
    const result = await f.authorizeCallStart(queued);
    assert.equal(result.action, 'HANGUP');
    assert.equal(f.resolveClientConfig(result.meta).action, 'HANGUP');
    assert.equal(f.resolveClientConfig(result.meta).autoGreeting, false);
  }
});

test('a queued UUID cannot be rebound to another call identity', async () => {
  for (const change of [
    { did: '79952225212' }, { callerId: '79990000002' },
    { assistantProfileId: 'other-profile' }, { outboundContactId: 'other-contact' },
    { direction: 'INBOUND' }, { sipEndpoint: 'callsec-sip-79952225212' },
    { channel: 'PJSIP/other-channel' }
  ]) {
    const f = fixture();
    f.putCallMeta({ ...queued, channel: 'PJSIP/original-channel', platformProfile: profile });
    const result = await f.authorizeCallStart({ ...queued, channel: 'PJSIP/original-channel', ...change });
    assert.equal(result.action, 'HANGUP');
    assert.equal(result.reason, 'call_identity_changed');
    assert.equal(result.meta.did, queued.did);
    assert.equal(result.meta.assistantProfileId, queued.assistantProfileId);
    assert.equal(f.resolveClientConfig(result.meta), null);
    assert.equal(f.requests.length, 0);
  }
});

test('changed profile bindings and SIP routes are rejected instead of using the old call file', async () => {
  for (const change of [
    { assistantProfileId: 'other-profile' }, { direction: 'INBOUND' },
    { outboundContact: { id: 'other-contact' } },
    { outboundCallerId: '+79952225212' },
    { outboundSipLine: { endpoint: 'callsec-sip-79952225212' } },
  ]) {
    const f = fixture({ response: { ok: true, profile: { ...profile, ...change } } });
    f.putCallMeta({ ...queued, platformProfile: profile });
    const result = await f.authorizeCallStart(queued);
    assert.equal(result.action, 'HANGUP');
    assert.equal(f.resolveClientConfig(result.meta), null);
  }
});

test('normal incoming calls can resolve a fresh profile using only DID and caller', async () => {
  const incoming = { ...profile, direction: 'INBOUND', outboundContact: null };
  const f = fixture({ response: { ok: true, profile: incoming } });
  const result = await f.authorizeCallStart({ uuid, did: '+79952225213', callerId: queued.callerId, direction: 'INBOUND' });
  assert.equal(result.action, 'OK');
  assert.equal(f.resolveClientConfig(result.meta).assistantProfileId, incoming.assistantProfileId);
});

test('queued inbound tests without a rental keep the explicitly authorized 52-12 service line', async () => {
  const callback = { ...queued, direction: 'INBOUND', did: '79952225212', sipEndpoint: 'callsec-sip-79952225212' };
  const incomingTest = {
    ...profile, direction: 'INBOUND', reservedNumber: null,
    outboundCallerId: '+79952225212',
    outboundSipLine: { endpoint: callback.sipEndpoint }
  };
  const f = fixture({ response: { ok: true, profile: incomingTest } });
  f.putCallMeta({ ...callback, platformProfile: incomingTest });
  const result = await f.authorizeCallStart(callback);
  assert.equal(result.action, 'OK');
  assert.equal(f.resolveClientConfig(result.meta).direction, 'INBOUND');
  assert.equal(f.resolveClientConfig(result.meta).outboundCallerId, '+79952225212');
});

test('a new start check invalidates any previous authorization while the API is still pending', async () => {
  let finish;
  const waitBeforeResponse = new Promise((resolve) => { finish = resolve; });
  const f = fixture({ waitBeforeResponse });
  f.putCallMeta({ ...queued, platformProfile: profile }, true);
  const pending = f.authorizeCallStart(queued);
  assert.equal(f.resolveClientConfig(f.getCallMeta(uuid)), null);
  finish();
  assert.equal((await pending).action, 'OK');
});

test('invalid UUIDs are rejected before any platform request', async () => {
  const f = fixture();
  const result = await f.authorizeCallStart({ ...queued, uuid: 'not-a-uuid' });
  assert.equal(result.action, 'HANGUP');
  assert.equal(result.meta, null);
  assert.equal(f.requests.length, 0);
});

test('metadata HTTP handler returns HANGUP on API failure, never OK from its queued cache', async () => {
  const f = fixture({ error: new Error('offline') });
  f.putCallMeta({ ...queued, platformProfile: profile });
  const result = await f.postStart(queued);
  assert.equal(result.statusCode, 200);
  assert.equal(result.text, 'HANGUP');
  assert.equal(f.resolveClientConfig(f.getCallMeta(uuid)), null);
});

test('metadata HTTP handler requires its token and admits a fresh authorized profile', async () => {
  const f = fixture();
  assert.equal((await f.postStart(queued, 'wrong-token')).statusCode, 401);
  assert.equal(f.requests.length, 0);
  assert.equal(f.getCallMeta(uuid), null);
  const result = await f.postStart(queued);
  assert.equal(result.statusCode, 200);
  assert.equal(result.text, 'OK');
  assert.equal(f.resolveClientConfig(f.getCallMeta(uuid)).assistantProfileId, profile.assistantProfileId);
});

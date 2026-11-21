'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { validateSyncEnvironment, registrationsReady, assertNoLegacyIdentity, applySipConfiguration, runWithSyncLock, protectedFileLimit } = require('./sync-sip-lines.cjs');
const { MAX_GENERATED_PJSIP_BYTES, MAX_GENERATED_ROUTES_BYTES, sipLineObjectNames, renderSipLinesConfig } = require('./sip-lines-config.cjs');

const route = {
  endpoint: 'callsec-sip-79952225213', number: '+79952225213', server: 'sip.novofon.ru',
  port: 5061, transport: 'tls', revision: '2026-11-21T12:00:00.000Z',
};
const desired = { pjsip: 'new protected configuration\n', routes: { '79952225213': route } };
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');

function fixture(current = { pjsip: 'old protected configuration\n', routes: '{}\n', configHash: null }) {
  const events = [];
  const files = { ...current };
  const io = {
    read: () => ({ ...files }),
    write(name, text) {
      events.push(`write:${name}`);
      files[name] = text;
      if (name === 'state') files.configHash = JSON.parse(text).configHash;
    },
    isQuiescent: () => true,
    reload: () => events.push('reload'),
    waitUntilReady: async () => true,
  };
  return { files, events, io };
}

test('sync requires its own token and exact loopback URL', () => {
  const env = { SIP_CONFIG_API_URL: 'http://127.0.0.1:14000/internal/voice/sip-lines/config', SIP_CONFIG_TOKEN: 'a'.repeat(64) };
  assert.equal(validateSyncEnvironment(env).token, env.SIP_CONFIG_TOKEN);
  for (const update of [
    { SIP_CONFIG_API_URL: 'http://example.org/config' }, { SIP_CONFIG_API_URL: `${env.SIP_CONFIG_API_URL}?next=x` },
    { SIP_CONFIG_TOKEN: undefined, VOICE_SERVICE_TOKEN: 'a'.repeat(64) }, { SIP_CONFIG_TOKEN: 'a\nb'.repeat(32) },
  ]) assert.throws(() => validateSyncEnvironment({ ...env, ...update }));
});

test('new routes are published only after reload and registration readiness', async () => {
  const { io, events, files } = fixture();
  io.waitUntilReady = async () => { events.push('registered'); return true; };
  const result = await applySipConfiguration(desired, io);
  assert.deepEqual(events, ['write:pjsip', 'reload', 'write:state', 'registered', 'write:routes']);
  assert.equal(files.routes, json(desired.routes));
  assert.equal(result.ready, true);
});

test('unchanged loaded configuration does not reload Asterisk', async () => {
  const { io, events } = fixture({ pjsip: desired.pjsip, routes: json(desired.routes), configHash: hash(desired.pjsip) });
  assert.equal((await applySipConfiguration(desired, io)).changed, false);
  assert.deepEqual(events, []);
});

test('active calls or queued call files defer reload without activating routes', async () => {
  const { io, events } = fixture();
  io.isQuiescent = () => false;
  assert.equal((await applySipConfiguration(desired, io)).deferred, true);
  assert.deepEqual(events, []);
});

test('a call appearing during staging restores the previous config without a reload', async () => {
  const { io, files, events } = fixture();
  let checks = 0;
  io.isQuiescent = () => ++checks === 1;
  assert.equal((await applySipConfiguration(desired, io)).deferred, true);
  assert.equal(files.pjsip, 'old protected configuration\n');
  assert.deepEqual(events, ['write:pjsip', 'write:pjsip']);
});

test('revoked or rotated routes are removed even while reload is deferred', async () => {
  const { io, files, events } = fixture({ pjsip: 'old\n', routes: json(desired.routes), configHash: null });
  io.isQuiescent = () => false;
  const changed = { ...desired, routes: { '79952225213': { ...route, revision: '2026-11-21T12:00:01.000Z' } } };
  assert.equal((await applySipConfiguration(changed, io)).deferred, true);
  assert.equal(files.routes, '{}\n');
  assert.deepEqual(events, ['write:routes']);
});

test('reload failure retains old configuration and never activates new routes', async () => {
  const { io, files } = fixture();
  io.reload = () => { throw new Error('test failure'); };
  await assert.rejects(applySipConfiguration(desired, io), /synchronization failed/);
  assert.equal(files.pjsip, 'old protected configuration\n');
  assert.equal(files.routes, '{}\n');
});

test('unregistered lines remain unavailable without repeated unnecessary reloads', async () => {
  const { io, files, events } = fixture({ pjsip: desired.pjsip, routes: '{}\n', configHash: hash(desired.pjsip) });
  io.waitUntilReady = async () => false;
  assert.equal((await applySipConfiguration(desired, io)).ready, false);
  assert.equal(files.routes, '{}\n');
  assert.deepEqual(events, []);
});

test('registration checks require every dedicated registration to be Registered', () => {
  const text = ` ${sipLineObjectNames(route).registration}/sip:sip.novofon.ru:5061 callsec-auth Registered (exp. 42s)\n`;
  assert.equal(registrationsReady(text, desired.routes), true);
  assert.equal(registrationsReady(text.replace('Registered', 'Unregistered'), desired.routes), false);
  assert.equal(registrationsReady('', desired.routes), false);
});

test('password rotation cannot publish a new revision using an older Registered generation', async () => {
  const line = { ...route, id: 'example-line', username: 'example_account', password: 'old-example-password' };
  const previous = renderSipLinesConfig([line]);
  const next = renderSipLinesConfig([{ ...line, password: 'new-example-password', revision: '2026-11-21T12:00:01.000Z' }]);
  const previousRegistration = sipLineObjectNames(route).registration;
  const nextRegistration = sipLineObjectNames(next.routes['79952225213']).registration;
  const oldStatus = ` ${previousRegistration}/sip:sip.novofon.ru:5061 example-auth Registered (exp. 299s)\n`;
  const { io, files, events } = fixture({ pjsip: previous.pjsip, routes: json(previous.routes), configHash: hash(previous.pjsip) });
  io.waitUntilReady = async (routes) => registrationsReady(oldStatus, routes);
  const pending = await applySipConfiguration(next, io);
  assert.equal(pending.ready, false);
  assert.equal(files.routes, '{}\n');
  assert.deepEqual(events, ['write:routes', 'write:pjsip', 'reload', 'write:state']);
  io.waitUntilReady = async (routes) => registrationsReady(`${oldStatus} ${nextRegistration}/sip:sip.novofon.ru:5061 example-auth Registered (exp. 299s)\n`, routes);
  assert.equal((await applySipConfiguration(next, io)).ready, true);
  assert.equal(files.routes, json(next.routes));
  assert.equal(events.filter((event) => event === 'reload').length, 1);
  assert.equal(registrationsReady(' callsec-sip-79952225213-registration/sip:sip.novofon.ru:5061 example-auth Registered\n', next.routes), false);
});

test('oversized generated files are rejected before reading or modifying protected configuration', async () => {
  for (const output of [
    { ...desired, pjsip: 'a'.repeat(MAX_GENERATED_PJSIP_BYTES + 1) },
    { ...desired, routes: { oversized: 'a'.repeat(MAX_GENERATED_ROUTES_BYTES) } },
  ]) {
    const { io, events } = fixture();
    io.read = () => { events.push('read'); throw new Error('must not read'); };
    await assert.rejects(applySipConfiguration(output, io), /synchronization failed/);
    assert.deepEqual(events, []);
  }
});

test('protected generated PJSIP reads and writes share the expanded size bound', () => {
  assert.equal(protectedFileLimit('/etc/asterisk/callsec-sip-lines.conf'), MAX_GENERATED_PJSIP_BYTES);
  assert.ok(protectedFileLimit('/etc/asterisk/callsec-sip-lines.conf') > 2_653_559);
  assert.equal(protectedFileLimit('/etc/asterisk/callsec-sip-routes.json'), MAX_GENERATED_ROUTES_BYTES);
});

test('sync refuses a dedicated identity that is still registered by the legacy configuration', () => {
  const legacy = '[novofon-auth]\ntype=auth\nusername=old-login\n\n[novofon-registration]\ntype=registration\noutbound_auth=novofon-auth\n';
  assert.throws(() => assertNoLegacyIdentity([{ username: 'old-login' }], legacy), /synchronization failed/);
  assert.doesNotThrow(() => assertNoLegacyIdentity([{ username: 'another-login' }], legacy));
  assert.doesNotThrow(() => assertNoLegacyIdentity([{ username: 'old-login' }], '[novofon-endpoint]\ntype=endpoint\n'));
  assert.throws(() => assertNoLegacyIdentity([], '[novofon-registration]\ntype=registration\n'), /synchronization failed/);
  assert.throws(() => assertNoLegacyIdentity([{ username: 'old-login' }], legacy.replace('username=old-login', 'username=old-login ; comment')), /synchronization failed/);
  assert.throws(() => assertNoLegacyIdentity([], '[novofon-registration](+)\ntype=registration\n'), /synchronization failed/);
  const retired = '[novofon-auth]\ntype=auth\nusername=old-login\n';
  assert.throws(() => assertNoLegacyIdentity([{ username: 'old-login' }], retired, ' novofon-registration/sip:server novofon-auth Registered (exp. 42s)'), /synchronization failed/);
  assert.doesNotThrow(() => assertNoLegacyIdentity([{ username: 'old-login' }], retired, ' novofon-registration/sip:server novofon-auth Unregistered'));
});

test('manual and service entrypoints use the same protected kernel lock', () => {
  let invoked = 0;
  assert.equal(runWithSyncLock((command, args, options) => {
    invoked += 1;
    assert.equal(command, '/usr/bin/flock');
    assert.deepEqual(args.slice(0, 6), ['--exclusive', '--nonblock', '--no-fork', '--conflict-exit-code', '75', '/run/callsec-sip-sync/sync.lock']);
    assert.equal(options.env.CALLSEC_SIP_SYNC_LOCKED, '1');
    assert.equal(options.stdio, 'inherit');
    return { status: 0 };
  }), 0);
  assert.equal(invoked, 1);
  assert.equal(runWithSyncLock(() => ({ status: 75 })), 0);
  assert.equal(runWithSyncLock(() => ({ status: 1 })), 1);
  assert.throws(() => runWithSyncLock(() => ({ error: new Error('unavailable') })), /synchronization failed/);
});

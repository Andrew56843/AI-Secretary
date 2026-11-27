'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  SIP_RECOVERY_GATE_FILE, assessSipLineHealth, checkSipLineHealth, isSipRecoveryBlocked,
} = require('../sip-line-health');

const route = {
  endpoint: 'callsec-sip-79952225213', number: '+79952225213', server: 'sip.novofon.ru',
  port: 5061, transport: 'tls', revision: '2026-11-21T10:53:00.691Z',
};
const registration = 'callsec-sip-79952225213-registration-20261121105300691';
const snapshot = {
  registrations: `
 <Registration/ServerURI..............................> <Auth....................> <Status.......>
 ==========================================================================================
 ${registration}/sip:sip.novofon.ru:5061;transport=tls callsec-sip-79952225213-auth-20261121105300691 Registered (exp. 120s)
 Objects found: 1
`,
  contacts: `
 Contact: <Aor/ContactUri..............................> <Hash....> <Status> <RTT(ms)..>
 ==========================================================================================
 Contact: callsec-sip-79952225213-aor/sip:sip.novofon.ru 983419968f Avail 56.124
 Objects found: 1
`,
};

test('requires the exact versioned registration and a reachable contact for the selected DID', () => {
  assert.deepEqual(assessSipLineHealth(route, snapshot), { ready: true, reason: 'ready' });
  const windowsSnapshot = Object.fromEntries(Object.entries(snapshot).map(([name, text]) => [name, text.replace(/\n/g, '\r\n')]));
  assert.equal(assessSipLineHealth(route, windowsSnapshot).ready, true);
});

test('registration rejection, pending, timeout and expiration never authorize a call', () => {
  for (const status of ['Unregistered', 'Rejected', 'Registering', 'Request Sent', 'RegisteredButNotReally']) {
    assert.equal(assessSipLineHealth(route, { ...snapshot, registrations: snapshot.registrations.replace('Registered', status) }).ready, false, status);
  }
  assert.equal(assessSipLineHealth(route, { ...snapshot, registrations: snapshot.registrations.replace('120s', '0s') }).ready, false);
});

test('a Registered row alone is insufficient when the endpoint cannot receive calls', () => {
  for (const status of ['Unavail', 'Unknown', 'NonQual', 'Unavailable', 'AvailButNotReally']) {
    assert.equal(assessSipLineHealth(route, { ...snapshot, contacts: snapshot.contacts.replace('Avail', status) }).ready, false, status);
  }
  assert.equal(assessSipLineHealth(route, { ...snapshot, contacts: snapshot.contacts.replace('56.124', 'nan') }).ready, false);
});

test('another tenant, rotated registration, duplicate and ambiguous rows cannot satisfy readiness', () => {
  for (const statuses of [
    { ...snapshot, registrations: snapshot.registrations.replaceAll('79952225213', '79952225212') },
    { ...snapshot, contacts: snapshot.contacts.replaceAll('79952225213', '79952225212') },
    { ...snapshot, registrations: snapshot.registrations.replaceAll('20261121105300691', '20261121105300692') },
    { ...snapshot, registrations: snapshot.registrations + snapshot.registrations },
    { ...snapshot, contacts: snapshot.contacts + snapshot.contacts },
  ]) assert.equal(assessSipLineHealth(route, statuses).ready, false);
});

test('missing, malformed and excessive CLI status fail closed', () => {
  for (const statuses of [undefined, {}, { registrations: '', contacts: '' },
    { ...snapshot, registrations: 'Unable to connect to remote asterisk' },
    { ...snapshot, contacts: 'No such command' },
    { ...snapshot, contacts: 'x'.repeat(1024 * 1024 + 1) },
  ]) assert.equal(assessSipLineHealth(route, statuses).ready, false);
  for (const input of [undefined, {}, { ...route, number: '+79952225212' }, { ...route, endpoint: 'legacy-endpoint' },
    { ...route, revision: 'bad' }, { ...route, server: 'attacker.example' },
  ]) assert.equal(assessSipLineHealth(input, snapshot).ready, false);
});

test('preflight runs only fixed read-only commands and never uses a legacy tenant route', async () => {
  const commands = [];
  const result = await checkSipLineHealth(route, {
    isRecoveryBlocked: () => false,
    runAsterisk: async (command) => {
      commands.push(command);
      return command === 'pjsip show registrations' ? snapshot.registrations : snapshot.contacts;
    },
  });
  assert.equal(result.ready, true);
  assert.deepEqual(commands, ['pjsip show registrations', 'pjsip show contacts']);
  let runs = 0;
  assert.equal((await checkSipLineHealth({ ...route, endpoint: 'novofon-endpoint' }, {
    isRecoveryBlocked: () => false, runAsterisk: async () => { runs += 1; },
  })).ready, false);
  assert.equal(runs, 0);
});

test('CLI timeout, missing privileges and malformed command results do not enqueue calls', async () => {
  for (const failure of ['timed out', 'sudo: a password is required', 'asterisk unavailable']) {
    const result = await checkSipLineHealth(route, {
      isRecoveryBlocked: () => false,
      runAsterisk: async () => { throw new Error(failure); },
    });
    assert.deepEqual(result, { ready: false, reason: 'status_unavailable' });
  }
  assert.equal((await checkSipLineHealth(route, { isRecoveryBlocked: () => false, runAsterisk: async () => undefined })).ready, false);
});

test('recovery gate is checked before and after CLI status reads', async () => {
  let reads = 0;
  const blocked = await checkSipLineHealth(route, {
    isRecoveryBlocked: () => true, runAsterisk: async () => { reads += 1; },
  });
  assert.deepEqual(blocked, { ready: false, reason: 'recovery_in_progress' });
  assert.equal(reads, 0);
  let checks = 0;
  const during = await checkSipLineHealth(route, {
    isRecoveryBlocked: () => ++checks > 1,
    runAsterisk: async (command) => command === 'pjsip show registrations' ? snapshot.registrations : snapshot.contacts,
  });
  assert.deepEqual(during, { ready: false, reason: 'recovery_in_progress' });
});

test('a missing recovery gate is compatible with normal operation but access failures block', () => {
  assert.equal(SIP_RECOVERY_GATE_FILE, '/run/callsec-sip-health/recovering');
  assert.equal(isSipRecoveryBlocked('/gate', () => ({})), true);
  assert.equal(isSipRecoveryBlocked('/gate', () => { throw Object.assign(new Error(), { code: 'ENOENT' }); }), false);
  for (const code of ['EACCES', 'ELOOP', 'EIO']) {
    assert.equal(isSipRecoveryBlocked('/gate', () => { throw Object.assign(new Error(), { code }); }), true);
  }
});

const publisher = require('../deploy/asterisk/publish-outbound-call.cjs');
const filename = 'ai-secretary-contact-1-12345678.call';
const stagingName = `.${filename}.123.1795779440427.tmp`;
const noEntry = () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); };
const nodeStat = (type, fields = {}) => ({
  uid: 0, gid: 0, mode: 0o644, nlink: 1, size: 128,
  isFile: () => type === 'file', isDirectory: () => type === 'directory', isSymbolicLink: () => type === 'symlink',
  ...fields,
});

function publicationFixture() {
  const paths = publisher.validatePublishNames(stagingName, filename);
  const entries = new Map([
    ['/run/callsec-sip-health', nodeStat('directory', { mode: 0o755 })],
    [publisher.LOCK_FILE, nodeStat('file')],
    [publisher.STAGING_DIRECTORY, nodeStat('directory', { uid: 115, gid: 116, mode: 0o750 })],
    [publisher.OUTGOING_DIRECTORY, nodeStat('directory', { uid: 115, gid: 116, mode: 0o750 })],
    [paths.source, nodeStat('file', { uid: 115, gid: 116, mode: 0o640 })],
  ]);
  const moves = [];
  return {
    entries, paths, moves,
    io: { uid: 115, gid: 116, stat: (file) => entries.get(file) ?? noEntry(), rename: (...args) => moves.push(args) },
  };
}

test('publisher accepts only a matching generated staging/destination basename pair', () => {
  assert.deepEqual(publisher.validatePublishNames(stagingName, filename), {
    source: `${publisher.STAGING_DIRECTORY}/${stagingName}`, destination: `${publisher.OUTGOING_DIRECTORY}/${filename}`,
  });
  for (const [staging, destination] of [
    [stagingName, '../outside.call'], ['../outside.call', filename],
    [`.${filename}.1.2.tmp; id`, filename], [`.${filename}.1.2.tmp\n`, filename],
    [stagingName, 'ai-secretary-other.call'], [`.${filename}.0.12.tmp`, filename],
    [`.${filename}.1.2.tmp`, 'ai-secretary-../escape.call'],
    [undefined, filename], [stagingName, 'a'.repeat(201)],
  ]) assert.throws(() => publisher.validatePublishNames(staging, destination), /publication refused/);
});

test('root publisher publishes only a protected Asterisk-owned regular file into the fixed spool', () => {
  const { io, paths, moves } = publicationFixture();
  publisher.publishOutboundCall(stagingName, filename, io);
  assert.deepEqual(moves, [[paths.source, paths.destination]]);
});

test('publication never bypasses a recovery gate or an unreadable gate', () => {
  for (const entry of [nodeStat('file'), nodeStat('symlink')]) {
    const { io, entries, moves } = publicationFixture();
    entries.set(publisher.GATE_FILE, entry);
    assert.throws(() => publisher.publishOutboundCall(stagingName, filename, io));
    assert.equal(moves.length, 0);
  }
  const { io, moves } = publicationFixture();
  const originalStat = io.stat;
  io.stat = (file) => file === publisher.GATE_FILE ? (() => { throw Object.assign(new Error(), { code: 'EACCES' }); })() : originalStat(file);
  assert.throws(() => publisher.publishOutboundCall(stagingName, filename, io));
  assert.equal(moves.length, 0);
});

test('missing, writable or substituted lock files fail closed before publication', () => {
  for (const lock of [null, nodeStat('symlink'), nodeStat('file', { uid: 115 }), nodeStat('file', { mode: 0o666 }), nodeStat('file', { nlink: 2 })]) {
    const { io, entries, moves } = publicationFixture();
    if (lock) entries.set(publisher.LOCK_FILE, lock); else entries.delete(publisher.LOCK_FILE);
    assert.throws(() => publisher.publishOutboundCall(stagingName, filename, io));
    assert.equal(moves.length, 0);
  }
});

test('unsafe source, spool directories and existing destinations cannot be published', () => {
  for (const source of [
    nodeStat('symlink', { uid: 115, gid: 116, mode: 0o640 }),
    nodeStat('file', { uid: 0, gid: 116, mode: 0o640 }),
    nodeStat('file', { uid: 115, gid: 116, mode: 0o666 }),
    nodeStat('file', { uid: 115, gid: 116, mode: 0o640, nlink: 2 }),
    nodeStat('file', { uid: 115, gid: 116, mode: 0o640, size: 0 }),
    nodeStat('file', { uid: 115, gid: 116, mode: 0o640, size: 65537 }),
  ]) {
    const { io, entries, paths, moves } = publicationFixture();
    entries.set(paths.source, source);
    assert.throws(() => publisher.publishOutboundCall(stagingName, filename, io));
    assert.equal(moves.length, 0);
  }
  for (const folder of [publisher.STAGING_DIRECTORY, publisher.OUTGOING_DIRECTORY]) {
    const { io, entries, moves } = publicationFixture();
    entries.set(folder, nodeStat('directory', { uid: 115, gid: 116, mode: 0o777 }));
    assert.throws(() => publisher.publishOutboundCall(stagingName, filename, io));
    assert.equal(moves.length, 0);
  }
  const { io, entries, paths, moves } = publicationFixture();
  entries.set(paths.destination, nodeStat('file'));
  assert.throws(() => publisher.publishOutboundCall(stagingName, filename, io));
  assert.equal(moves.length, 0);
});

test('publisher holds the agreed shared nonblocking lock through publication', () => {
  let seen;
  assert.equal(publisher.runWithPublicationLock([stagingName, filename], (command, args, options) => {
    seen = { command, args, options };
    return { status: 75 };
  }), 75);
  assert.equal(seen.command, '/usr/bin/flock');
  assert.deepEqual(seen.args.slice(0, 6), ['--shared', '--nonblock', '--no-fork', '--conflict-exit-code', '75', publisher.LOCK_FILE]);
  assert.deepEqual(seen.args.slice(-2), [stagingName, filename]);
  assert.equal(seen.options.env.CALLSEC_OUTBOUND_PUBLISH_LOCKED, '1');
  assert.throws(() => publisher.runWithPublicationLock([], () => ({ signal: 'SIGTERM', status: null })));
});

function dialerFixture(health) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('async function outboundDialerTick()');
  const end = source.indexOf('function scheduleOutboundDialer(', start);
  const events = [];
  const context = {
    outboundDialerRunning: false, outboundInFlight: new Map(),
    CONFIG: { outboundMaxConcurrent: 1, sipRoutesFile: '/routes', outboundContext: 'ai-outbound', outboundExtension: 's', outboundWaitTimeSec: 45 },
    scanOutboundDoneFiles: async () => {},
    requestPlatformOutboundJob: async () => ({ job: { id: 'contact-1', phone: '+79990000001' }, profile: { assistantProfileId: 'profile-1' } }),
    normalizeDialPhone: () => '79990000001', getOutboundCallerId: () => '79952225213',
    readSipRoutes: () => ({ '79952225213': route }), getOutboundSipRoute: () => route,
    checkSipLineHealth: async (selected) => { events.push(['health', selected]); return health; },
    readAsteriskSipStatus: () => {}, releasePlatformOutboundJobWithoutAttempt: async (...args) => events.push(['defer', ...args]),
    releasePlatformOutboundJob: async (...args) => events.push(['attempt', ...args]),
    crypto: { randomUUID: () => 'uuid-1' }, normalizeUuid: (value) => value,
    getQueuedCallDirection: () => 'OUTBOUND', putCallMeta: () => events.push(['metadata']),
    safeName: (value) => value, buildOutboundCallFile: () => 'call content',
    installOutboundCallFile: async () => events.push(['publish']),
    callRegistry: new Map(), log: () => {}, logErr: () => {},
  };
  const tick = vm.runInNewContext(`${source.slice(start, end)}\noutboundDialerTick`, context);
  return { tick, events, context };
}

test('dialer defers an unhealthy dedicated line without counting an attempt or creating call metadata/files', async () => {
  for (const reason of ['registration_unavailable', 'contact_unavailable', 'recovery_in_progress', 'status_unavailable']) {
    const { tick, events } = dialerFixture({ ready: false, reason });
    await tick();
    assert.equal(events.length, 2);
    assert.equal(events[0][0], 'health');
    assert.deepEqual(events[1], ['defer', 'contact-1', 'dedicated SIP line temporarily unavailable']);
    assert.equal(events.some(([event]) => event === 'attempt' || event === 'publish' || event === 'metadata'), false);
  }
});

test('dialer queues a healthy selected line only after the SIP preflight', async () => {
  const { tick, events, context } = dialerFixture({ ready: true, reason: 'ready' });
  await tick();
  assert.deepEqual(events.map(([event]) => event), ['health', 'metadata', 'publish']);
  assert.equal(context.outboundInFlight.size, 1);
});

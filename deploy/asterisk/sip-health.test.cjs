'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  POLICY, parseTransportSnapshot, planRecovery, parseAsteriskSockets,
  socketResetArguments, recoverTransport,
} = require('./sip-health.cjs');
const { sipLineObjectNames } = require('./sip-lines-config.cjs');

const NOW = 1_800_000_000_000;
const makeRoute = number => ({ endpoint: `callsec-sip-${number}`, number: `+${number}`,
  server: 'sip.novofon.ru', port: 5061, transport: 'tls', revision: '2026-11-21T10:53:00.691Z' });
const first = makeRoute('79952225212');
const second = makeRoute('79952225213');
const routes = { 79952225212: first, 79952225213: second };

function fixture({ statuses = ['Rejected', 'Rejected'], contacts = ['Unavail', 'Unavail'], legacy = 'Unavail', truncated = false } = {}) {
  const registrations = Object.values(routes).map((route, i) =>
    ` ${sipLineObjectNames(route).registration}/sip:sip.novofon.ru:5061;transport=tls auth-${i} ${statuses[i]} (exp. 52s)`)
    .join('\n') + '\nObjects found: 2\n';
  const rows = Object.values(routes).map((route, i) =>
    ` Contact: ${route.endpoint}-aor/${truncated ? 'sip:sip.novofo' : 'sip:sip.novofon.ru:5061;transport=tls'} 983419968f ${contacts[i]} ${contacts[i] === 'Avail' ? '56.124' : 'nan'}`);
  if (legacy !== null) rows.push(` Contact: novofon-aor/${truncated ? 'sip:sip.novofon.ru' : 'sip:sip.novofon.ru:5061;transport=tls'} 111abc ${legacy} ${legacy === 'Avail' ? '54.123' : 'nan'}`);
  return { registrations, contacts: rows.join('\n') + `\nObjects found: ${rows.length}\n` };
}

const snapshotOf = options => {
  const f = fixture(options);
  return parseTransportSnapshot(routes, f.registrations, f.contacts);
};
function previous(snapshot, overrides = {}) {
  return { version: 1, lastCheckAt: NOW - 20_000, resets: [], lines: Object.fromEntries(snapshot.lines.map(line =>
    [line.registration, { failureSince: NOW - 180_000, lastSoftAt: NOW - 60_000 }])), ...overrides };
}
const socket = { localAddress: '83.217.203.61', localPort: 53191, remoteAddress: '37.139.38.224', pid: 772 };

test('snapshot accepts the exact expected versioned registrations and unhealthy contacts', () => {
  const s = snapshotOf();
  assert.equal(s.known, true);
  assert.equal(s.allUnavailable, true);
  assert.equal(s.lines.length, 2);
});
test('real Asterisk contact URI truncation does not hide the unavailable transport', () => {
  const s = snapshotOf({ truncated: true });
  assert.equal(s.known, true);
  assert.equal(s.allUnavailable, true);
});
test('healthy registrations and contacts are ready and never hard-reset candidates', () => {
  const s = snapshotOf({ statuses: ['Registered', 'Registered'], contacts: ['Avail', 'Avail'] });
  assert.equal(s.lines.every(line => line.ready), true);
  assert.equal(s.allUnavailable, false);
  assert.equal(planRecovery(s, previous(s), NOW).hard, false);
});
test('one healthy shared-transport contact blocks a hard reset', () => {
  assert.equal(snapshotOf({ contacts: ['Avail', 'Unavail'] }).allUnavailable, false);
});
test('healthy legacy contact blocks a shared-transport reset', () => {
  assert.equal(snapshotOf({ legacy: 'Avail' }).allUnavailable, false);
});
test('one registered line blocks a shared-transport reset even when contacts are unavailable', () => {
  assert.equal(snapshotOf({ statuses: ['Registered', 'Rejected'] }).allUnavailable, false);
});
test('unknown contact status does not authorize a reset', () => {
  assert.equal(snapshotOf({ contacts: ['Unknown', 'Unavail'] }).allUnavailable, false);
});
test('a missing registration is unknown and cannot authorize a reset', () => {
  const f = fixture();
  const text = f.registrations.split('\n').slice(1).join('\n');
  const s = parseTransportSnapshot(routes, text, f.contacts);
  assert.equal(s.known, false);
  assert.equal(s.allUnavailable, false);
});
test('a foreign registration is unknown and cannot authorize a reset', () => {
  const f = fixture();
  const text = f.registrations.replace('Objects found: 2', 'foreign/sip:other.example auth Rejected (exp. 52s)\nObjects found: 3');
  const s = parseTransportSnapshot(routes, text, f.contacts);
  assert.equal(s.known, false);
  assert.equal(s.allUnavailable, false);
});
test('a registration from a previous SIP credential revision is unknown', () => {
  const f = fixture();
  const text = f.registrations.replace(sipLineObjectNames(first).registration, `${first.endpoint}-registration-20261120105300691`);
  const s = parseTransportSnapshot(routes, text, f.contacts);
  assert.equal(s.known, false);
  assert.equal(s.allUnavailable, false);
});
test('empty or malformed CLI output never authorizes reset', () => {
  for (const [registrations, contacts] of [['', ''], ['Unable to connect to remote asterisk', ''], ['Objects found: 0', 'Objects found: 0']]) {
    const s = parseTransportSnapshot(routes, registrations, contacts);
    assert.equal(s.known, false);
    assert.equal(s.allUnavailable, false);
  }
});
test('empty desired routes never authorize recovery of an unknown transport', () => {
  const f = fixture();
  const s = parseTransportSnapshot({}, f.registrations, f.contacts);
  assert.equal(s.known, false);
  assert.equal(planRecovery(s, {}, NOW).hard, false);
});
test('a first failure starts a grace period without taking corrective action', () => {
  const s = snapshotOf();
  const plan = planRecovery(s, {}, NOW);
  assert.deepEqual(plan.soft, []);
  assert.equal(plan.hard, false);
  assert.equal(plan.state.lines[s.lines[0].registration].failureSince, NOW);
});
test('soft re-registration waits for the sustained-failure threshold', () => {
  const s = snapshotOf();
  const old = previous(s);
  for (const line of Object.values(old.lines)) { line.failureSince = NOW - POLICY.softAfterMs + 1; line.lastSoftAt = null; }
  assert.equal(planRecovery(s, old, NOW).soft.length, 0);
  for (const line of Object.values(old.lines)) line.failureSince--;
  assert.equal(planRecovery(s, old, NOW).soft.length, 2);
});
test('soft actions obey their per-line cooldown', () => {
  const s = snapshotOf();
  assert.equal(planRecovery(s, previous(s), NOW).soft.length, 0);
});
test('a delayed watchdog tick does not perform soft and hard recovery together', () => {
  const s = snapshotOf();
  const old = previous(s);
  for (const line of Object.values(old.lines)) line.lastSoftAt = null;
  const plan = planRecovery(s, old, NOW);
  assert.equal(plan.soft.length, 2);
  assert.equal(plan.hard, false);
});
test('hard recovery gives a recent soft registration time to settle', () => {
  const s = snapshotOf();
  const old = previous(s);
  for (const line of Object.values(old.lines)) line.lastSoftAt = NOW - POLICY.softSettleMs + 1;
  assert.equal(planRecovery(s, old, NOW).hard, false);
  for (const line of Object.values(old.lines)) line.lastSoftAt--;
  assert.equal(planRecovery(s, old, NOW).hard, true);
});
test('hard recovery waits for the sustained-transport-failure threshold', () => {
  const s = snapshotOf();
  const old = previous(s);
  for (const line of Object.values(old.lines)) line.failureSince = NOW - POLICY.resetAfterMs + 1;
  assert.equal(planRecovery(s, old, NOW).hard, false);
});
test('successful health clears a previous failure streak', () => {
  const s = snapshotOf({ statuses: ['Registered', 'Registered'], contacts: ['Avail', 'Avail'] });
  const plan = planRecovery(s, previous(s), NOW);
  for (const line of Object.values(plan.state.lines)) assert.equal(line.failureSince, null);
});
test('hard recovery obeys cooldown and an hourly circuit breaker', () => {
  const s = snapshotOf();
  assert.equal(planRecovery(s, previous(s, { resets: [NOW - 300_000] }), NOW).hard, false);
  assert.equal(planRecovery(s, previous(s, { resets: [NOW - 3_000_000, NOW - 2_000_000, NOW - 1_000_000] }), NOW).hard, false);
  assert.equal(planRecovery(s, previous(s, { resets: [NOW - 3_700_000] }), NOW).hard, true);
});
test('clock rollback resets the failure streak rather than allowing a hard reset', () => {
  const s = snapshotOf();
  const plan = planRecovery(s, previous(s, { lastCheckAt: NOW + 1000 }), NOW);
  assert.equal(plan.hard, false);
  assert.deepEqual(plan.soft, []);
});
test('socket parser accepts exact Asterisk-owned IPv4 TLS connections', () => {
  assert.deepEqual(parseAsteriskSockets('0 0 83.217.203.61:53191 37.139.38.224:5061 users:(("asterisk",pid=772,fd=26))', 772), [socket]);
  assert.deepEqual(parseAsteriskSockets('ESTAB 0 0 83.217.203.61:53191 37.139.38.224:5061 users:(("asterisk",pid=772,fd=26))', 772), [socket]);
});
test('socket parser rejects a different PID, process, invalid IP, or destination port', () => {
  const text = '0 0 83.217.203.61:53191 37.139.38.224:5061 users:(("asterisk",pid=772,fd=26))';
  for (const altered of [text.replace('pid=772', 'pid=773'), text.replace('"asterisk"', '"node"'), text.replace('37.139.38.224', '999.139.38.224'), text.replace(':5061', ':443')]) {
    assert.deepEqual(parseAsteriskSockets(altered, 772), []);
  }
  assert.deepEqual(parseAsteriskSockets(text, 1), []);
});
test('reset arguments pin the entire IPv4 TCP tuple', () => {
  assert.deepEqual(socketResetArguments(socket), ['-K', '-4', 'src', '83.217.203.61', 'sport', '=', '53191', 'dst', '37.139.38.224', 'dport', '=', '5061']);
  assert.throws(() => socketResetArguments({ ...socket, localPort: '53191;anything' }));
});

function recoveryIo(overrides = {}) {
  const s = snapshotOf();
  const events = [];
  return {
    events, snapshot: () => s, readState: () => previous(s), quiescent: () => true,
    sockets: () => [socket], probe: async () => true,
    writeState: state => events.push(['state', state]), reset: value => events.push(['reset', value]),
    register: name => events.push(['register', name]), ...overrides,
  };
}
test('healthy fresh TLS plus sustained idle failure recovers exactly the pinned socket', async () => {
  const io = recoveryIo();
  const result = await recoverTransport(io, NOW);
  assert.equal(result.reset, true);
  assert.deepEqual(io.events.filter(event => event[0] === 'reset'), [['reset', socket]]);
  assert.equal(io.events.filter(event => event[0] === 'register').length, 2);
  assert.equal(io.events[0][0], 'state');
});
test('active calls or outgoing spool contents prevent probing and resetting', async () => {
  const io = recoveryIo({ quiescent: () => false, probe: async () => { throw new Error('must not probe'); } });
  assert.equal((await recoverTransport(io, NOW)).reset, false);
  assert.deepEqual(io.events, []);
});
test('provider TLS failure prevents any socket reset', async () => {
  const io = recoveryIo({ probe: async () => false });
  const result = await recoverTransport(io, NOW);
  assert.equal(result.reason, 'provider_tls_unavailable');
  assert.deepEqual(io.events, []);
});
test('a call or spool file appearing during the probe prevents recovery', async () => {
  let checks = 0;
  const io = recoveryIo({ quiescent: () => ++checks === 1 });
  const result = await recoverTransport(io, NOW);
  assert.equal(result.reason, 'state_changed');
  assert.deepEqual(io.events, []);
});
test('a registration recovering during the probe prevents socket reset', async () => {
  let reads = 0;
  const bad = snapshotOf();
  const good = snapshotOf({ statuses: ['Registered', 'Registered'], contacts: ['Avail', 'Avail'] });
  const io = recoveryIo({ snapshot: () => ++reads === 1 ? bad : good });
  assert.equal((await recoverTransport(io, NOW)).reason, 'state_changed');
  assert.deepEqual(io.events, []);
});
test('a socket tuple or PID changing during the probe prevents reset', async () => {
  let reads = 0;
  const io = recoveryIo({ sockets: () => [++reads === 1 ? socket : { ...socket, pid: 773 }] });
  assert.equal((await recoverTransport(io, NOW)).reason, 'state_changed');
  assert.deepEqual(io.events, []);
});
test('a socket PID changing immediately before reset is not killed', async () => {
  let reads = 0;
  const io = recoveryIo({ sockets: () => [++reads < 3 ? socket : { ...socket, pid: 773 }] });
  assert.equal((await recoverTransport(io, NOW)).reason, 'state_changed');
  assert.deepEqual(io.events.filter(event => event[0] === 'reset'), []);
});
test('no sockets or an excessive socket count prevents reset', async () => {
  for (const sockets of [[], Array(5).fill(socket)]) {
    const io = recoveryIo({ sockets: () => sockets });
    assert.equal((await recoverTransport(io, NOW)).reason, 'no_unique_stale_transport');
    assert.deepEqual(io.events, []);
  }
});

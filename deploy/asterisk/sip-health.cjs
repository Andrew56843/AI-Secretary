#!/usr/local/bin/node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const dns = require('node:dns/promises');
const { execFileSync, spawnSync } = require('node:child_process');
const { readSipRoutes } = require('./sip-routing.cjs');
const { sipLineObjectNames } = require('./sip-lines-config.cjs');
const { assessSipLineHealth } = require('../../sip-line-health.js');

const RUNTIME = '/run/callsec-sip-health';
const STATE_DIRECTORY = '/var/lib/callsec-sip-health';
const STATE_FILE = `${STATE_DIRECTORY}/state.json`;
const GATE = `${RUNTIME}/recovering`;
const LOCK = `${RUNTIME}/recovery.lock`;
const SYNC_LOCK = '/run/callsec-sip-sync/sync.lock';
const SPOOLS = ['/var/spool/asterisk/outgoing', '/var/spool/asterisk/callsec-outgoing-staging'];
const POLICY = { softAfterMs: 60_000, softCooldownMs: 120_000, softSettleMs: 30_000, resetAfterMs: 120_000, resetCooldownMs: 600_000, maxResetsPerHour: 3 };
const MAX_BYTES = 1024 * 1024;
const emit = (event, data = {}) => console.log(JSON.stringify({ service: 'callsec-sip-health', event, ...data }));

function parseTransportSnapshot(routes, registrations, contacts) {
  const values = Object.values(routes);
  const registrationRows = registrations.split(/\r?\n/).filter(line => /^\s*\S+\/sip:\S+\s+\S+\s+(Registered|Rejected|Unregistered)\s+\(exp\.\s+\d+s\)\s*$/.test(line));
  const contactRows = contacts.split(/\r?\n/).filter(line => /^\s*Contact:\s+\S+\s+[0-9a-f]+\s+(Avail|Unavail|NonQual|Unknown)\s+\S+\s*$/i.test(line));
  const registrationCount = Number(registrations.match(/Objects found:\s*(\d+)/)?.[1] ?? -1);
  const contactCount = Number(contacts.match(/Objects found:\s*(\d+)/)?.[1] ?? -1);
  const expectedAors = new Set(values.map(route => `${route.endpoint}-aor`));
  const contactAors = contactRows.map(line => line.match(/^\s*Contact:\s+([^/]+)\//)?.[1]);
  const lines = values.map(route => {
    const registration = sipLineObjectNames(route).registration;
    const matches = registrationRows.filter(line => line.trim().startsWith(`${registration}/`));
    const status = matches.length === 1 ? matches[0].match(/\s(Registered|Rejected|Unregistered)\s+\(exp\./)?.[1] : null;
    const matchingContacts = contactRows.filter((line, index) => contactAors[index] === `${route.endpoint}-aor`);
    const contactStatus = matchingContacts.length === 1 ? matchingContacts[0].match(/\s(Avail|Unavail|NonQual|Unknown)\s+\S+\s*$/)?.[1] : null;
    const health = assessSipLineHealth(route, { registrations, contacts });
    return { endpoint: route.endpoint, registration, status, contactStatus, ready: health.ready, reason: health.reason };
  });
  // Unknown registrations or contacts may belong to another user of the shared transport.
  const known = values.length > 0 && registrationRows.length === values.length && registrationCount === values.length &&
    contactRows.length === contactCount && contactCount >= values.length && lines.every(line => line.status !== null) &&
    new Set(contactAors).size === contactAors.length && [...expectedAors].every(aor => contactAors.includes(aor)) &&
    contactAors.every(aor => expectedAors.has(aor) || aor === 'novofon-aor');
  const allUnavailable = known && lines.every(line => line.status !== 'Registered') &&
    contactRows.every(line => /\sUnavail\s/.test(line));
  return { lines, known, allUnavailable };
}

function planRecovery(snapshot, previous = {}, now = Date.now(), policy = POLICY) {
  const state = { version: 1, lastCheckAt: now, lines: {}, resets: [] };
  const clockValid = !previous.lastCheckAt || (Number.isFinite(previous.lastCheckAt) && now >= previous.lastCheckAt);
  state.resets = Array.isArray(previous.resets) ? previous.resets.filter(time => Number.isFinite(time) && time > now - 3_600_000) : [];
  const soft = [];
  for (const line of snapshot.lines) {
    const old = clockValid ? previous.lines?.[line.registration] : null;
    const failureSince = line.ready ? null : Number.isFinite(old?.failureSince) ? old.failureSince : now;
    const lastSoftAt = Number.isFinite(old?.lastSoftAt) ? old.lastSoftAt : null;
    state.lines[line.registration] = { failureSince, lastSoftAt };
    if (line.status && !line.ready && (line.status !== 'Registered' || line.contactStatus === 'Unavail') && failureSince !== null && now - failureSince >= policy.softAfterMs &&
        (lastSoftAt === null || now - lastSoftAt >= policy.softCooldownMs)) soft.push(line.registration);
  }
  const lastReset = state.resets.length ? Math.max(...state.resets) : null;
  const hard = clockValid && soft.length === 0 && snapshot.allUnavailable && snapshot.lines.every(line =>
    now - state.lines[line.registration].failureSince >= policy.resetAfterMs &&
    state.lines[line.registration].lastSoftAt !== null && now - state.lines[line.registration].lastSoftAt >= policy.softSettleMs) &&
    state.resets.length < policy.maxResetsPerHour && (lastReset === null || now - lastReset >= policy.resetCooldownMs);
  return { state, soft, hard };
}

function parseAsteriskSockets(text, pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return [];
  const sockets = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:ESTAB\s+)?\d+\s+\d+\s+(\d+(?:\.\d+){3}):(\d+)\s+(\d+(?:\.\d+){3}):5061\s+users:\(\("asterisk",pid=(\d+),fd=\d+\)\)\s*$/);
    if (!match || Number(match[4]) !== pid) continue;
    const localPort = Number(match[2]);
    const validIp = value => value.split('.').length === 4 && value.split('.').every(n => /^\d{1,3}$/.test(n) && Number(n) <= 255);
    if (!validIp(match[1]) || !validIp(match[3]) || localPort < 1024 || localPort > 65535) continue;
    sockets.push({ localAddress: match[1], localPort, remoteAddress: match[3], pid });
  }
  return sockets;
}

function socketResetArguments(socket) {
  const sample = `0 0 ${socket.localAddress}:${socket.localPort} ${socket.remoteAddress}:5061 users:(("asterisk",pid=${socket.pid},fd=1))`;
  if (parseAsteriskSockets(sample, socket.pid).length !== 1) throw new Error('Invalid SIP socket identity');
  return ['-K', '-4', 'src', socket.localAddress, 'sport', '=', String(socket.localPort), 'dst', socket.remoteAddress, 'dport', '=', '5061'];
}

async function recoverTransport(io, now = Date.now()) {
  const snapshot = io.snapshot();
  const planned = planRecovery(snapshot, io.readState(), now);
  if (!planned.hard || !io.quiescent()) return { reset: false, reason: 'not_quiescent_or_unhealthy' };
  const sockets = io.sockets();
  if (!sockets.length || sockets.length > 4) return { reset: false, reason: 'no_unique_stale_transport' };
  if (!await io.probe(sockets)) return { reset: false, reason: 'provider_tls_unavailable' };
  const fresh = io.snapshot();
  if (!fresh.allUnavailable || !io.quiescent() || JSON.stringify(io.sockets()) !== JSON.stringify(sockets)) {
    return { reset: false, reason: 'state_changed' };
  }
  planned.state.resets.push(now);
  io.writeState(planned.state);
  for (const socket of sockets) {
    if (!io.quiescent() || !io.snapshot().allUnavailable ||
        !io.sockets().some(current => JSON.stringify(current) === JSON.stringify(socket))) return { reset: false, reason: 'state_changed' };
    io.reset(socket);
  }
  for (const line of fresh.lines) io.register(line.registration);
  return { reset: true, sockets: sockets.length };
}

function command(file, args, timeout = 5000) {
  return execFileSync(file, args, { encoding: 'utf8', timeout, maxBuffer: MAX_BYTES });
}

function asterisk(value) {
  const output = command('/usr/sbin/asterisk', ['-rx', value]);
  if (/No such command|Unable to connect/i.test(output)) throw new Error('Asterisk CLI unavailable');
  return output;
}

function protectedDirectory(directory, mode) {
  try { fs.mkdirSync(directory, { mode }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('Unsafe SIP health directory');
}

function protectedFile(file, optional = false) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > MAX_BYTES) throw new Error('Unsafe SIP health file');
  return fs.readFileSync(file, 'utf8');
}

function atomicWrite(file, value, mode = 0o600) {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

function readState() {
  const text = protectedFile(STATE_FILE, true);
  if (!text) return {};
  const state = JSON.parse(text);
  if (state.version !== 1 || !state.lines || !Array.isArray(state.resets) || state.resets.length > 100 ||
      Object.keys(state.lines).length > 2000) throw new Error('Invalid SIP health state');
  return state;
}

function snapshot() {
  return parseTransportSnapshot(readSipRoutes(), asterisk('pjsip show registrations'), asterisk('pjsip show contacts'));
}

function quiescent() {
  if (!/^0 active channels$/m.test(asterisk('core show channels count'))) return false;
  return SPOOLS.every(directory => {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(directory).length === 0;
  });
}

function sockets() {
  const pid = Number(command('/usr/bin/systemctl', ['show', 'asterisk', '--property=MainPID', '--value']).trim());
  if (!Number.isSafeInteger(pid) || pid < 2 || fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'asterisk') return [];
  return parseAsteriskSockets(command('/usr/bin/ss', ['-Hntp', 'state', 'established', '( dport = :5061 )']), pid);
}

async function probe(socketsToCheck) {
  const addresses = await dns.resolve4('sip.novofon.ru');
  for (const socket of socketsToCheck) {
    if (!addresses.includes(socket.remoteAddress)) return false;
    const okay = await new Promise(resolve => {
      let settled = false;
      const connection = tls.connect({ host: socket.remoteAddress, port: 5061, servername: 'sip.novofon.ru',
        rejectUnauthorized: true, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' });
      const finish = result => { if (settled) return; settled = true; connection.destroy(); resolve(result); };
      connection.setTimeout(4000, () => finish(false));
      connection.once('secureConnect', () => finish(connection.authorized));
      connection.once('error', () => finish(false));
    });
    if (!okay) return false;
  }
  return true;
}

function prepare() {
  protectedDirectory(RUNTIME, 0o755);
  protectedDirectory(STATE_DIRECTORY, 0o700);
  protectedDirectory('/run/callsec-sip-sync', 0o700);
  for (const [file, mode] of [[LOCK, 0o644], [SYNC_LOCK, 0o600]]) {
    try { fs.writeFileSync(file, '', { flag: 'wx', mode }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    protectedFile(file);
  }
}

function withLock(lock, flag, args = []) {
  const child = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '--no-fork', '--conflict-exit-code', '75', lock,
    process.execPath, __filename, ...args], { env: { ...process.env, [flag]: '1' }, stdio: 'inherit', timeout: 40_000 });
  if (child.error || child.signal || !Number.isInteger(child.status)) throw new Error('SIP health lock failed');
  return child.status === 75 ? 0 : child.status;
}

async function run(mode) {
  if (mode === '--clear-gate') {
    if (process.env.CALLSEC_SIP_HEALTH_RECOVERING !== '1') throw new Error('Recovery lock is required');
    if (fs.existsSync(GATE)) { protectedFile(GATE); fs.unlinkSync(GATE); }
    return;
  }
  if (mode === '--recover') {
    if (process.env.CALLSEC_SIP_HEALTH_RECOVERING !== '1') throw new Error('Recovery lock is required');
    const result = await recoverTransport({ snapshot, quiescent, sockets, probe, readState,
      writeState: state => atomicWrite(STATE_FILE, state),
      reset: socket => command('/usr/bin/ss', socketResetArguments(socket)),
      register: registration => asterisk(`pjsip send register ${registration}`),
    });
    emit('transport_recovery', result);
    return;
  }
  const current = snapshot();
  const planned = planRecovery(current, readState());
  if (mode === '--check') { emit('check', { ...current, softPlanned: planned.soft.length, resetPlanned: planned.hard }); return; }
  // A previous interrupted recovery can leave a gate; normal runs hold the common sync lock.
  if (fs.existsSync(GATE)) {
    withLock(LOCK, 'CALLSEC_SIP_HEALTH_RECOVERING', ['--clear-gate']);
    if (fs.existsSync(GATE)) { emit('gate_cleanup_deferred'); return; }
  }
  for (const registration of planned.soft) {
    const fresh = snapshot().lines.find(line => line.registration === registration);
    if (!fresh?.status || fresh.ready || (fresh.status === 'Registered' && (fresh.contactStatus !== 'Unavail' || !quiescent()))) continue;
    planned.state.lines[registration].lastSoftAt = Date.now();
    atomicWrite(STATE_FILE, planned.state);
    asterisk(`pjsip send register ${registration}`);
    emit('reregister', { registration });
  }
  atomicWrite(STATE_FILE, planned.state);
  if (planned.hard) {
    atomicWrite(GATE, { since: Date.now() }, 0o644);
    try { if (withLock(LOCK, 'CALLSEC_SIP_HEALTH_RECOVERING', ['--recover']) !== 0) throw new Error('Transport recovery failed'); }
    finally { fs.unlinkSync(GATE); }
  }
  const after = snapshot();
  atomicWrite(`${RUNTIME}/status.json`, { checkedAt: Date.now(), ...after }, 0o644);
  if (after.lines.some(line => !line.ready)) emit('unhealthy', { lines: after.lines });
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0 || process.argv.length > 3 ||
        (process.argv[2] && !['--check', '--recover', '--clear-gate'].includes(process.argv[2]))) throw new Error('Invalid SIP health invocation');
    prepare();
    if (process.env.CALLSEC_SIP_HEALTH_LOCKED !== '1' && process.argv[2] !== '--check') {
      process.exitCode = withLock(SYNC_LOCK, 'CALLSEC_SIP_HEALTH_LOCKED', process.argv.slice(2));
    } else { await run(process.argv[2]); }
  }).catch(() => { emit('error', { message: 'SIP health check failed; no unrestricted recovery performed' }); process.exitCode = 1; });
}

module.exports = { POLICY, parseTransportSnapshot, planRecovery, parseAsteriskSockets, socketResetArguments, recoverTransport };

#!/usr/local/bin/node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseEnv } = require('node:util');
const { renderSipLinesConfig } = require('./sip-lines-config.cjs');
const { parseSipRoutes, matchingSipRoute } = require('./sip-routing.cjs');

const API_URL = 'http://127.0.0.1:14000/internal/voice/sip-lines/config';
const ENV_FILE = '/etc/callsec/sip-sync.env';
const LOCK_DIRECTORY = '/run/callsec-sip-sync';
const LOCK_FILE = `${LOCK_DIRECTORY}/sync.lock`;
const FILES = {
  pjsip: '/etc/asterisk/callsec-sip-lines.conf',
  routes: '/etc/asterisk/callsec-sip-routes.json',
  state: '/etc/asterisk/callsec-sip-sync.state.json',
};
const OUTGOING_DIRECTORIES = ['/var/spool/asterisk/outgoing', '/var/spool/asterisk/callsec-outgoing-staging'];
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function syncError(stage) {
  const error = new Error('Dedicated SIP synchronization failed');
  error.stage = stage;
  return error;
}

function validateSyncEnvironment(env) {
  if (env.SIP_CONFIG_API_URL !== API_URL || typeof env.SIP_CONFIG_TOKEN !== 'string' ||
      !/^[\x21-\x7e]{32,256}$/.test(env.SIP_CONFIG_TOKEN)) {
    throw syncError('environment');
  }
  return { url: API_URL, token: env.SIP_CONFIG_TOKEN };
}

function prepareSyncLock() {
  try { fs.mkdirSync(LOCK_DIRECTORY, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw syncError('lock'); }
  const directory = fs.lstatSync(LOCK_DIRECTORY);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o077)) throw syncError('lock');
  let descriptor;
  try {
    descriptor = fs.openSync(LOCK_FILE, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw syncError('lock');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  const file = fs.lstatSync(LOCK_FILE);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== 0 || (file.mode & 0o077)) throw syncError('lock');
}

function runWithSyncLock(invoke = spawnSync) {
  const result = invoke('/usr/bin/flock', [
    '--exclusive', '--nonblock', '--no-fork', '--conflict-exit-code', '75', LOCK_FILE, process.execPath, __filename,
  ], {
    stdio: 'inherit', timeout: 45_000,
    env: { ...process.env, CALLSEC_SIP_SYNC_LOCKED: '1' },
  });
  if (result.error || result.signal || !Number.isInteger(result.status)) throw syncError('lock');
  return result.status === 75 ? 0 : result.status;
}

function fetchSipLines(config) {
  return new Promise((resolve, reject) => {
    const request = http.get(config.url, {
      headers: { accept: 'application/json', 'x-sip-config-token': config.token },
    }, (response) => {
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) request.destroy(syncError('api'));
        else chunks.push(chunk);
      });
      response.on('error', () => reject(syncError('api')));
      response.on('end', () => {
        clearTimeout(timer);
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || data.ok !== true || !Array.isArray(data.lines) || data.lines.length > 2000) {
            throw syncError('api');
          }
          resolve(data.lines);
        } catch {
          reject(syncError('api'));
        }
      });
    });
    const timer = setTimeout(() => request.destroy(syncError('api')), 5000);
    request.on('error', () => { clearTimeout(timer); reject(syncError('api')); });
  });
}

function registrationsReady(text, routes) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  return Object.values(routes).every((route) => lines.some((line) =>
    line.startsWith(`${route.endpoint}-registration/`) && /\sRegistered(?:\s|$)/.test(line)));
}

function assertNoLegacyIdentity(lines, text, registrationStatus = '') {
  const sections = new Map();
  let current;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === ';' && !escaped) { line = line.slice(0, index); break; }
      escaped = line[index] === '\\' && !escaped;
    }
    const section = line.match(/^\s*\[([^\]]+)\](.*)$/);
    if (section) {
      if (section[2].trim()) throw syncError('legacy_registration');
      current = section[1];
      if (sections.has(current)) throw syncError('legacy_registration');
      sections.set(current, new Map());
      continue;
    }
    const setting = line.match(/^\s*([a-z_]+)\s*=\s*(.*?)\s*$/i);
    if (current && setting) sections.get(current).set(setting[1], setting[2]);
  }
  const registration = sections.get('novofon-registration');
  const auth = sections.get(registration?.get('outbound_auth') || 'novofon-auth');
  const username = auth?.get('username');
  const duplicatesIdentity = lines.some((line) => line.username === username);
  if (registration && (registration.get('type') !== 'registration' || !username || duplicatesIdentity)) {
    throw syncError('legacy_registration');
  }
  const liveLegacy = registrationStatus.split(/\r?\n/).find((line) => line.trim().startsWith('novofon-registration/'));
  if (lines.length && liveLegacy && !/\sUnregistered(?:\s|$)/.test(liveLegacy) && (!username || duplicatesIdentity)) {
    throw syncError('legacy_registration');
  }
}

async function applySipConfiguration(rendered, io) {
  const current = io.read();
  const configHash = hash(rendered.pjsip);
  const desiredRoutes = json(rendered.routes);
  const currentRoutes = parseSipRoutes(current.routes);
  const retainedRoutes = Object.fromEntries(Object.entries(currentRoutes).filter(([did, route]) =>
    matchingSipRoute(route, did, rendered.routes)));
  const retainedText = json(retainedRoutes);
  if (retainedText !== current.routes) io.write('routes', retainedText);

  const reloadNeeded = current.pjsip !== rendered.pjsip || current.configHash !== configHash;
  if (reloadNeeded) {
    if (!io.isQuiescent()) return { changed: false, deferred: true, ready: false };
    io.write('pjsip', rendered.pjsip);
    if (!io.isQuiescent()) {
      io.write('pjsip', current.pjsip);
      return { changed: false, deferred: true, ready: false };
    }
    try {
      io.reload();
      io.write('state', json({ configHash }));
    } catch {
      io.write('pjsip', current.pjsip);
      io.write('state', json({ configHash: null }));
      throw syncError('reload');
    }
  }

  if (!await io.waitUntilReady(rendered.routes)) {
    return { changed: reloadNeeded, deferred: false, ready: false };
  }
  if (desiredRoutes !== retainedText) io.write('routes', desiredRoutes);
  return { changed: reloadNeeded || desiredRoutes !== current.routes, deferred: false, ready: true };
}

function readProtected(file, optional = false) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw syncError('filesystem');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > 2 * 1024 * 1024) {
    throw syncError('filesystem');
  }
  return fs.readFileSync(file, 'utf8');
}

function writeProtected(file, text, groupId) {
  const directory = path.dirname(file);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw syncError('filesystem');
  const temporary = path.join(directory, `.${path.basename(file)}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o640);
    fs.fchownSync(descriptor, 0, groupId);
    fs.fchmodSync(descriptor, 0o640);
    fs.writeFileSync(descriptor, text);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function asterisk(command) {
  try {
    const output = execFileSync('/usr/sbin/asterisk', ['-rx', command], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    if (/No such command|Unable to connect|Unable to reload/i.test(output)) throw syncError('asterisk');
    return output;
  } catch {
    throw syncError('asterisk');
  }
}

async function run() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0 || process.argv.length !== 2) throw syncError('privilege');
  const envStat = fs.lstatSync(ENV_FILE);
  if (envStat.uid !== 0 || (envStat.mode & 0o077)) throw syncError('environment');
  const config = validateSyncEnvironment(parseEnv(readProtected(ENV_FILE)));
  const lines = await fetchSipLines(config);
  let rendered;
  try { rendered = renderSipLinesConfig(lines); } catch { throw syncError('records'); }
  assertNoLegacyIdentity(lines, readProtected('/etc/asterisk/pjsip.conf'), asterisk('pjsip show registrations'));
  const groupId = Number(execFileSync('/usr/bin/id', ['-g', 'asterisk'], { encoding: 'utf8' }).trim());
  if (!Number.isSafeInteger(groupId) || groupId < 0) throw syncError('filesystem');
  const result = await applySipConfiguration(rendered, {
    read() {
      const state = readProtected(FILES.state, true);
      let configHash = null;
      if (state) {
        try { configHash = JSON.parse(state).configHash; } catch { throw syncError('filesystem'); }
      }
      return { pjsip: readProtected(FILES.pjsip), routes: readProtected(FILES.routes), configHash };
    },
    write(name, value) { writeProtected(FILES[name], value, groupId); },
    isQuiescent() {
      if (!/^0 active channels$/m.test(asterisk('core show channels count'))) return false;
      return OUTGOING_DIRECTORIES.every((directory) => fs.readdirSync(directory).length === 0);
    },
    reload() { asterisk('pjsip reload'); },
    async waitUntilReady(routes) {
      const deadline = Date.now() + 15_000;
      do {
        if (registrationsReady(asterisk('pjsip show registrations'), routes)) return true;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } while (Date.now() < deadline);
      return false;
    },
  });
  console.log(JSON.stringify({ service: 'callsec-sip-sync', lines: lines.length, ...result }));
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0 || process.argv.length !== 2) throw syncError('privilege');
    if (process.env.CALLSEC_SIP_SYNC_LOCKED !== '1') {
      prepareSyncLock();
      process.exitCode = runWithSyncLock();
    } else {
      await run();
    }
  }).catch((error) => {
    const allowed = new Set(['environment', 'api', 'filesystem', 'asterisk', 'privilege', 'records', 'reload', 'legacy_registration', 'lock']);
    const stage = allowed.has(error.stage) ? error.stage : 'internal';
    console.error(`[SIP-SYNC] failed stage=${stage}; no new routes activated`);
    process.exitCode = 1;
  });
}

module.exports = { validateSyncEnvironment, fetchSipLines, registrationsReady, assertNoLegacyIdentity, applySipConfiguration, runWithSyncLock };

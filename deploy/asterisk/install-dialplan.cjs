#!/usr/local/bin/node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const DIALPLAN_FILE = '/etc/asterisk/extensions.conf';
const OUTGOING_DIRECTORIES = ['/var/spool/asterisk/outgoing', '/var/spool/asterisk/callsec-outgoing-staging'];

function assertMaintenanceReady(io) {
  for (const service of ['callsec-voice', 'callsec-sip-sync.timer', 'callsec-sip-sync.service']) {
    if (io.isServiceActive(service)) throw new Error(`Stop ${service} before installing Asterisk files`);
  }
  const running = io.isServiceActive('asterisk');
  if ((running && !/^0 active channels$/m.test(io.channels())) || !io.queuesEmpty()) {
    throw new Error('Wait for active calls and queued call files before installing Asterisk files');
  }
  return running;
}

function installDialplan(desired, io) {
  if (typeof desired !== 'string' || /@@[A-Z_]+@@/.test(desired) ||
      !desired.includes('[from-ai-forward]') || !desired.includes('@${AI_SIP_ENDPOINT},45)')) {
    throw new Error('Invalid dedicated-line dialplan template');
  }
  const running = assertMaintenanceReady(io);
  const current = io.read();
  if (current === desired) return { changed: false, reloaded: false };
  io.write(desired);
  if (!running) return { changed: true, reloaded: false };
  try {
    io.reload();
  } catch {
    io.write(current);
    try { io.reload(); } catch { /* Preserve the old file even if Asterisk is no longer available. */ }
    throw new Error('Dialplan reload failed; previous dialplan file restored');
  }
  return { changed: true, reloaded: true };
}

function isServiceActive(name) {
  const result = spawnSync('/usr/bin/systemctl', ['is-active', name], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
  });
  const state = result.stdout?.trim();
  if (!result.error && !result.signal && result.status === 0 && state === 'active') return true;
  if (!result.error && !result.signal && [3, 4].includes(result.status) &&
      ['inactive', 'failed', 'unknown'].includes(state)) return false;
  throw new Error(`Cannot verify maintenance state of ${name}`);
}

function asterisk(command) {
  const output = execFileSync('/usr/sbin/asterisk', ['-rx', command], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
  });
  if (/No such command|Unable to connect|Unable to reload/i.test(output)) throw new Error('Asterisk command failed');
  return output;
}

function protectedCurrent() {
  const stat = fs.lstatSync(DIALPLAN_FILE);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > 2 * 1024 * 1024) {
    throw new Error('Unsafe managed dialplan file');
  }
  return fs.readFileSync(DIALPLAN_FILE, 'utf8');
}

function writeDialplan(text) {
  const directory = path.dirname(DIALPLAN_FILE);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) {
    throw new Error('Unsafe Asterisk configuration directory');
  }
  const groupId = Number(execFileSync('/usr/bin/id', ['-g', 'asterisk'], { encoding: 'utf8' }).trim());
  if (!Number.isSafeInteger(groupId) || groupId < 0) throw new Error('Cannot resolve Asterisk group');
  const temporary = path.join(directory, `.extensions-callsec-${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o640);
    fs.fchownSync(descriptor, 0, groupId);
    fs.fchmodSync(descriptor, 0o640);
    fs.writeFileSync(descriptor, text);
    fs.fsyncSync(descriptor);
    fs.renameSync(temporary, DIALPLAN_FILE);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function main() {
  if (process.getuid?.() !== 0 || process.argv.length !== 3) throw new Error('Run as root with --check or a dialplan template');
  const io = {
    isServiceActive,
    channels: () => asterisk('core show channels count'),
    queuesEmpty: () => OUTGOING_DIRECTORIES.every((directory) => {
      try { return fs.readdirSync(directory).length === 0; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    }),
    read: protectedCurrent,
    write: writeDialplan,
    reload: () => asterisk('dialplan reload'),
  };
  if (process.argv[2] === '--check') { assertMaintenanceReady(io); return; }
  const desired = fs.readFileSync(process.argv[2], 'utf8').replace(/\r\n/g, '\n');
  console.log(JSON.stringify(installDialplan(desired, io)));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { assertMaintenanceReady, installDialplan };

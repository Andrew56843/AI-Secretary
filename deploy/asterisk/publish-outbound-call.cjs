#!/usr/local/bin/node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const DIRECTORY = '/run/callsec-sip-health';
const LOCK_FILE = `${DIRECTORY}/recovery.lock`;
const GATE_FILE = `${DIRECTORY}/recovering`;
const STAGING_DIRECTORY = '/var/spool/asterisk/callsec-outgoing-staging';
const OUTGOING_DIRECTORY = '/var/spool/asterisk/outgoing';

function publicationError(stage) {
  const error = new Error('Outbound call publication refused');
  error.stage = stage;
  return error;
}

function validatePublishNames(stagingName, destinationName) {
  if (typeof destinationName !== 'string' || destinationName.length > 200 ||
      !/^ai-secretary-[A-Za-z0-9_-]+[.]call$/.test(destinationName) ||
      typeof stagingName !== 'string' || stagingName.length > 250 ||
      /[^A-Za-z0-9_.-]/.test(stagingName + destinationName) ||
      !stagingName.startsWith(`.${destinationName}.`) ||
      !/^[1-9]\d*[.][1-9]\d*[.]tmp$/.test(stagingName.slice(destinationName.length + 2))) {
    throw publicationError('names');
  }
  return {
    source: path.posix.join(STAGING_DIRECTORY, stagingName),
    destination: path.posix.join(OUTGOING_DIRECTORY, destinationName),
  };
}

function assertPublishLock(stat = fs.lstatSync) {
  const directory = stat(DIRECTORY);
  const lock = stat(LOCK_FILE);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o022) ||
      !lock.isFile() || lock.isSymbolicLink() || lock.uid !== 0 || (lock.mode & 0o022) || lock.nlink !== 1) {
    throw publicationError('lock');
  }
}

function runWithPublicationLock(args, invoke = spawnSync) {
  const result = invoke('/usr/bin/flock', [
    '--shared', '--nonblock', '--no-fork', '--conflict-exit-code', '75', LOCK_FILE,
    process.execPath, __filename, ...args,
  ], {
    stdio: 'inherit', timeout: 10_000,
    env: { ...process.env, CALLSEC_OUTBOUND_PUBLISH_LOCKED: '1' },
  });
  if (result.error || result.signal || !Number.isInteger(result.status)) throw publicationError('lock');
  return result.status;
}

function publishOutboundCall(stagingName, destinationName, { uid, gid, stat = fs.lstatSync, rename = fs.renameSync } = {}) {
  const paths = validatePublishNames(stagingName, destinationName);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) throw publicationError('owner');
  assertPublishLock(stat);
  try {
    stat(GATE_FILE);
    throw publicationError('recovery');
  } catch (error) {
    if (error.code !== 'ENOENT') throw publicationError('recovery');
  }
  for (const directory of [STAGING_DIRECTORY, OUTGOING_DIRECTORY]) {
    const entry = stat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid || entry.gid !== gid || (entry.mode & 0o022)) {
      throw publicationError('filesystem');
    }
  }
  const source = stat(paths.source);
  if (!source.isFile() || source.isSymbolicLink() || source.uid !== uid || source.gid !== gid ||
      source.nlink !== 1 || (source.mode & 0o777) !== 0o640 || source.size < 1 || source.size > 64 * 1024) {
    throw publicationError('filesystem');
  }
  try {
    stat(paths.destination);
    throw publicationError('destination');
  } catch (error) {
    if (error.code !== 'ENOENT') throw publicationError('destination');
  }
  rename(paths.source, paths.destination);
}

if (require.main === module) {
  try {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0 || process.argv.length !== 4) {
      throw publicationError('privilege');
    }
    const args = process.argv.slice(2);
    validatePublishNames(...args);
    assertPublishLock();
    if (process.env.CALLSEC_OUTBOUND_PUBLISH_LOCKED !== '1') {
      process.exitCode = runWithPublicationLock(args);
    } else {
      const uid = Number(execFileSync('/usr/bin/id', ['-u', 'asterisk'], { encoding: 'utf8' }).trim());
      const gid = Number(execFileSync('/usr/bin/id', ['-g', 'asterisk'], { encoding: 'utf8' }).trim());
      publishOutboundCall(...args, { uid, gid });
    }
  } catch (error) {
    const stages = new Set(['names', 'lock', 'owner', 'recovery', 'filesystem', 'destination', 'privilege']);
    console.error(`[SIP-PUBLISH] refused stage=${stages.has(error.stage) ? error.stage : 'internal'}`);
    process.exitCode = 1;
  }
}

module.exports = {
  LOCK_FILE, GATE_FILE, STAGING_DIRECTORY, OUTGOING_DIRECTORY,
  validatePublishNames, assertPublishLock, runWithPublicationLock, publishOutboundCall,
};

'use strict';

const fs = require('node:fs');
const { safeSipRoute } = require('./deploy/asterisk/sip-routing.cjs');
const { sipLineObjectNames } = require('./deploy/asterisk/sip-lines-config.cjs');

const SIP_RECOVERY_GATE_FILE = '/run/callsec-sip-health/recovering';
const MAX_STATUS_BYTES = 1024 * 1024;

function assessSipLineHealth(route, { registrations, contacts } = {}) {
  if (!safeSipRoute(route, route?.number)) return { ready: false, reason: 'invalid_route' };
  if (typeof registrations !== 'string' || typeof contacts !== 'string' ||
      Buffer.byteLength(registrations) > MAX_STATUS_BYTES || Buffer.byteLength(contacts) > MAX_STATUS_BYTES) {
    return { ready: false, reason: 'invalid_status' };
  }

  const registrationName = sipLineObjectNames(route).registration;
  const registrationRows = registrations.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line.startsWith(`${registrationName}/`));
  if (registrationRows.length !== 1 || !/\sRegistered\s+\(exp\.\s+[1-9]\d*s\)\s*$/.test(registrationRows[0])) {
    return { ready: false, reason: 'registration_unavailable' };
  }

  const contactPrefix = `${route.endpoint}-aor/`;
  const contactRows = contacts.split(/\r?\n/).map((line) => line.match(/^\s*Contact:\s+(\S+)\s+([a-f0-9]+)\s+(\S+)\s+(\S+)\s*$/i))
      .filter((match) => match && match[1].startsWith(contactPrefix));
  if (contactRows.length !== 1 || contactRows[0][3] !== 'Avail' ||
      !/^\d+(?:\.\d+)?$/.test(contactRows[0][4]) || !Number.isFinite(Number(contactRows[0][4]))) {
    return { ready: false, reason: 'contact_unavailable' };
  }
  return { ready: true, reason: 'ready' };
}

function isSipRecoveryBlocked(filePath = SIP_RECOVERY_GATE_FILE, stat = fs.lstatSync) {
  try {
    stat(filePath);
    return true;
  } catch (error) {
    return error.code !== 'ENOENT';
  }
}

async function checkSipLineHealth(route, { runAsterisk, isRecoveryBlocked = isSipRecoveryBlocked } = {}) {
  if (!safeSipRoute(route, route?.number)) return { ready: false, reason: 'invalid_route' };
  try {
    if (isRecoveryBlocked()) return { ready: false, reason: 'recovery_in_progress' };
    const registrations = await runAsterisk('pjsip show registrations');
    const contacts = await runAsterisk('pjsip show contacts');
    if (isRecoveryBlocked()) return { ready: false, reason: 'recovery_in_progress' };
    return assessSipLineHealth(route, { registrations, contacts });
  } catch {
    return { ready: false, reason: 'status_unavailable' };
  }
}

module.exports = { SIP_RECOVERY_GATE_FILE, assessSipLineHealth, checkSipLineHealth, isSipRecoveryBlocked };

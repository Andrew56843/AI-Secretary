#!/usr/local/bin/node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const readline = require('node:readline');

function createLineReader(input) {
  const queue = [];
  const waiters = [];
  let ended = false;
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  reader.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else queue.push(line);
  });
  reader.on('close', () => {
    ended = true;
    while (waiters.length) waiters.shift()(null);
  });
  const readLine = () => queue.length ? Promise.resolve(queue.shift())
    : ended ? Promise.resolve(null) : new Promise((resolve) => waiters.push(resolve));
  readLine.close = () => reader.close();
  return readLine;
}

function findDid(values, allowedDids) {
  for (const value of values) {
    for (const match of String(value || '').matchAll(/(?:^|[^0-9])(7\d{10})(?!\d)/g)) {
      if (allowedDids.includes(match[1])) return match[1];
    }
  }
  return null;
}

function postMetadata(config, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      reject(new Error('Metadata endpoint must use local HTTP'));
      return;
    }
    const data = JSON.stringify(body);
    const request = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        'x-metadata-token': config.token,
      },
      timeout: 12000,
    }, (response) => {
      let result = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        result += chunk;
        if (result.length > 1024) response.destroy(new Error('Metadata response too large'));
      });
      response.on('error', reject);
      response.on('end', () => resolve(response.statusCode === 200 && result.trim() === 'OK' ? 'OK' : 'HANGUP'));
    });
    request.on('timeout', () => request.destroy(new Error('Metadata timeout')));
    request.on('error', reject);
    request.end(data);
  });
}

async function runSession(readLine) {
  const environment = {};
  for (;;) {
    const line = await readLine();
    if (line === null || line === '') break;
    const colon = line.indexOf(':');
    if (colon !== -1) environment[line.slice(0, colon)] = line.slice(colon + 1).trim();
  }
  async function command(value) {
    process.stdout.write(`${value}\n`);
    const response = await readLine();
    if (!response?.startsWith('200 result=')) throw new Error('Unexpected AGI response');
    return response;
  }
  async function getVariable(name) {
    const instruction = name.includes('(') ? `GET FULL VARIABLE "\${${name}}"` : `GET VARIABLE ${name}`;
    const response = await command(instruction);
    return response.match(/^200 result=1 \((.*)\)$/)?.[1] || '';
  }
  async function setVariable(name, value) {
    const escaped = String(value).replace(/[\r\n]/g, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await command(`SET VARIABLE ${name} "${escaped}"`);
  }

  await setVariable('AI_METADATA_ACTION', 'HANGUP');
  try {
    const config = JSON.parse(fs.readFileSync('/etc/asterisk/callsec-metadata.json', 'utf8'));
    const variables = {};
    for (const name of ['AI_UUID', 'AI_DID', 'AI_CALLER', 'AI_DIRECTION', 'AI_OUTBOUND_CONTACT_ID',
      'AI_ASSISTANT_PROFILE_ID', 'AI_CLIENT_ID', 'PJSIP_HEADER(read,P-Called-Party-ID)', 'PJSIP_HEADER(read,To)']) {
      variables[name] = await getVariable(name);
    }
    const did = findDid([
      variables.AI_DID,
      variables['PJSIP_HEADER(read,P-Called-Party-ID)'],
      variables['PJSIP_HEADER(read,To)'],
      environment.agi_extension,
    ], config.dids);
    if (!did) throw new Error('Called number is not in the configured DID list');
    const uuid = variables.AI_UUID || crypto.randomUUID();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uuid)) {
      throw new Error('Invalid call UUID');
    }
    const callerId = String(variables.AI_CALLER || environment.agi_callerid || '').replace(/\D/g, '').slice(0, 20);
    await setVariable('AI_UUID', uuid);
    await setVariable('AI_DID', did);
    const action = await postMetadata(config, {
      uuid,
      did,
      callerId,
      direction: variables.AI_DIRECTION === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND',
      channel: environment.agi_channel,
      outboundContactId: variables.AI_OUTBOUND_CONTACT_ID || undefined,
      assistantProfileId: variables.AI_ASSISTANT_PROFILE_ID || undefined,
      clientId: variables.AI_CLIENT_ID || undefined,
    });
    await setVariable('AI_METADATA_ACTION', action);
  } catch (error) {
    process.stderr.write(`[callsec-metadata] ${error.message}\n`);
  }
}

async function run() {
  const readLine = createLineReader(process.stdin);
  try {
    await runSession(readLine);
  } finally {
    readLine.close();
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`[callsec-metadata] ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { findDid, postMetadata };

'use strict';

const MAX_SIP_LINES = 2000;
const MAX_GENERATED_PJSIP_BYTES = 8 * 1024 * 1024;
const MAX_GENERATED_ROUTES_BYTES = 1024 * 1024;

function invalid(field) {
  throw new Error(`Invalid SIP line ${field}`);
}

function text(value, field, maximum = 512) {
  if (typeof value !== 'string' || !value || value.length > maximum ||
      /[^\x21-\x7e]|[;#\[\]\\]/.test(value)) {
    invalid(field);
  }
  return value;
}

function normalizeLine(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.enabled === false) {
    invalid('record');
  }
  const id = text(input.id, 'id', 80);
  if (!/^[a-z0-9-]+$/i.test(id)) invalid('id');
  const endpoint = text(input.endpoint, 'endpoint', 80);
  if (!/^callsec-sip-[a-z0-9-]+$/.test(endpoint)) invalid('endpoint');
  if (typeof input.number !== 'string' || !/^\+?[0-9 ()-]+$/.test(input.number.trim())) {
    invalid('number');
  }
  const number = input.number.replace(/\D/g, '');
  if (!/^7\d{10}$/.test(number)) invalid('number');
  if (endpoint !== `callsec-sip-${number}`) invalid('endpoint');
  const username = text(input.username, 'username', 128);
  if (!/^[a-z0-9_-]+$/i.test(username)) invalid('username');
  const password = text(input.password, 'password');
  const server = text(input.server, 'server', 253).toLowerCase();
  if (server !== 'sip.novofon.ru') invalid('server');
  const port = input.port;
  if (port !== 5061) invalid('port');
  if (input.transport !== 'tls') invalid('transport');
  const revision = input.revision;
  if (typeof revision !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(revision) ||
      !Number.isFinite(Date.parse(revision)) || new Date(revision).toISOString() !== revision) {
    invalid('revision');
  }
  return { id, endpoint, number, username, password, server, port, transport: 'tls', revision };
}

function sipLineObjectNames({ endpoint, revision }) {
  if (!/^callsec-sip-7\d{10}$/.test(endpoint) || typeof revision !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(revision) ||
      !Number.isFinite(Date.parse(revision)) || new Date(revision).toISOString() !== revision) {
    invalid('revision identity');
  }
  // Asterisk can reuse Registered state when only a referenced auth password changes.
  const generation = revision.replace(/\D/g, '');
  return { auth: `${endpoint}-auth-${generation}`, registration: `${endpoint}-registration-${generation}` };
}

function assertSipConfigurationSize({ pjsip, routes }) {
  if (typeof pjsip !== 'string' || !routes || typeof routes !== 'object' || Array.isArray(routes) ||
      Buffer.byteLength(pjsip, 'utf8') > MAX_GENERATED_PJSIP_BYTES ||
      Buffer.byteLength(`${JSON.stringify(routes, null, 2)}\n`, 'utf8') > MAX_GENERATED_ROUTES_BYTES) {
    throw new Error('Generated SIP configuration exceeds its protected file limit');
  }
}

function renderLine(line) {
  const { endpoint, username, password, server, port, revision } = line;
  const names = sipLineObjectNames(line);
  const uri = `sip:${server}:${port}\\;transport=tls`;
  const proxy = `${uri}\\;lr`;
  return [
    `; ${endpoint} revision=${revision}`,
    `[${names.auth}]`,
    'type=auth',
    'auth_type=userpass',
    `username=${username}`,
    `password=${password}`,
    '',
    `[${endpoint}-aor]`,
    'type=aor',
    `contact=${uri}`,
    `outbound_proxy=${proxy}`,
    'qualify_frequency=60',
    '',
    `[${endpoint}]`,
    'type=endpoint',
    'transport=callsec-tls',
    'context=from-novofon',
    'disallow=all',
    'allow=alaw,ulaw',
    'media_encryption=sdes',
    `aors=${endpoint}-aor`,
    `outbound_auth=${names.auth}`,
    `outbound_proxy=${proxy}`,
    `from_user=${username}`,
    `from_domain=${server}`,
    'direct_media=no',
    'rtp_symmetric=yes',
    'force_rport=yes',
    'rewrite_contact=yes',
    'dtmf_mode=rfc4733',
    'send_pai=yes',
    'send_rpid=yes',
    'trust_id_inbound=yes',
    'allow_subscribe=no',
    'timers=yes',
    'rtp_timeout=60',
    'rtp_timeout_hold=300',
    '',
    `[${names.registration}]`,
    'type=registration',
    'transport=callsec-tls',
    `outbound_auth=${names.auth}`,
    `outbound_proxy=${proxy}`,
    `server_uri=${uri}`,
    `client_uri=sip:${username}@${server}`,
    `contact_user=${username}`,
    'expiration=300',
    'retry_interval=60',
    'forbidden_retry_interval=300',
    'fatal_retry_interval=300',
    'auth_rejection_permanent=no',
    'max_retries=1000000',
    'line=yes',
    `endpoint=${endpoint}`,
  ].join('\n');
}

function renderSipLinesConfig(input) {
  if (!Array.isArray(input)) throw new Error('SIP lines must be an array');
  if (input.length > MAX_SIP_LINES) throw new Error('Too many SIP lines');
  const lines = input.map(normalizeLine).sort((a, b) => a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0);
  const ids = new Set();
  const numbers = new Set();
  const identities = new Set();
  const sections = new Set();
  const routes = {};

  for (const line of lines) {
    const identity = `${line.server}\0${line.username}`;
    const versionedNames = sipLineObjectNames(line);
    const names = [line.endpoint, versionedNames.auth, `${line.endpoint}-aor`, versionedNames.registration];
    if (ids.has(line.id) || numbers.has(line.number) || identities.has(identity) || names.some((name) => sections.has(name))) {
      throw new Error('Duplicate SIP line identity, number or configuration section');
    }
    ids.add(line.id);
    numbers.add(line.number);
    identities.add(identity);
    for (const name of names) sections.add(name);
    routes[line.number] = {
      endpoint: line.endpoint,
      number: `+${line.number}`,
      server: line.server,
      port: line.port,
      transport: line.transport,
      revision: line.revision,
    };
  }

  const rendered = { pjsip: lines.length ? `${lines.map(renderLine).join('\n\n')}\n` : '', routes };
  assertSipConfigurationSize(rendered);
  return rendered;
}

module.exports = {
  MAX_SIP_LINES, MAX_GENERATED_PJSIP_BYTES, MAX_GENERATED_ROUTES_BYTES,
  sipLineObjectNames, assertSipConfigurationSize, renderSipLinesConfig,
};

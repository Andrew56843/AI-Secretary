#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

function configurationValue(value, name) {
  const text = String(value ?? '');
  if (!text || /[\r\n;#\[\]\\]/.test(text) || /[^\x21-\x7e]/.test(text)) {
    throw new Error(`Invalid or missing ${name}`);
  }
  return text;
}

function render(config, outputDirectory) {
  if (net.isIP(config.publicIp) !== 4) throw new Error('publicIp must be an IPv4 address');
  const sipHost = configurationValue(config.sipHost || 'sip.novofon.ru', 'sipHost');
  if (!/^[a-z0-9.-]+$/i.test(sipHost)) throw new Error('Invalid sipHost');
  const sipUsername = configurationValue(config.sipUsername, 'sipUsername');
  if (!/^[a-z0-9_-]+$/i.test(sipUsername)) throw new Error('Invalid sipUsername');
  const sipPassword = configurationValue(config.sipPassword, 'sipPassword');
  const sipTransport = String(config.sipTransport || 'tls').toLowerCase();
  if (!['tls', 'tcp', 'udp'].includes(sipTransport)) throw new Error('sipTransport must be tls, tcp or udp');
  const sipPort = Number(config.sipPort || (sipTransport === 'tls' ? 5061 : sipTransport === 'tcp' ? 5065 : 5060));
  const sipBindPort = Number(config.sipBindPort || (sipTransport === 'udp' ? 5060 : 5071));
  for (const port of [sipPort, sipBindPort]) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid SIP port');
  }
  if (!/^[a-z0-9_-]{32,}$/i.test(config.metadataToken || '')) {
    throw new Error('metadataToken must contain at least 32 URL-safe characters');
  }
  if (!Array.isArray(config.dids) || !config.dids.length || config.dids.some((did) => !/^7\d{10}$/.test(did))) {
    throw new Error('dids must list the allowed 11-digit Russian phone numbers');
  }
  const replacements = {
    PUBLIC_IP: config.publicIp,
    SIP_HOST: sipHost,
    SIP_USERNAME: sipUsername,
    SIP_PASSWORD: sipPassword,
    SIP_PORT: String(sipPort),
    SIP_BIND_PORT: String(sipBindPort),
    SIP_TRANSPORT: sipTransport,
    SIP_SERVER_URI: `sip:${sipHost}:${sipPort}\\;transport=${sipTransport}`,
    SIP_OUTBOUND_PROXY: `sip:${sipHost}:${sipPort}\\;transport=${sipTransport}\\;lr`,
    TLS_OPTIONS: sipTransport === 'tls' ? [
      'ca_list_file=/etc/ssl/certs/ca-certificates.crt',
      'verify_server=yes',
      'allow_wildcard_certs=yes',
      'verify_client=no',
      'require_client_cert=no',
      'method=tlsv1_2',
      'symmetric_transport=yes',
    ].join('\n') : '',
  };
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  for (const fileName of ['pjsip.conf', 'extensions.conf']) {
    const template = fs.readFileSync(path.join(__dirname, `${fileName}.tpl`), 'utf8');
    const rendered = template.replace(/@@([A-Z_]+)@@/g, (_match, key) => {
      if (!Object.hasOwn(replacements, key)) throw new Error(`Unknown template field ${key}`);
      return replacements[key];
    });
    fs.writeFileSync(path.join(outputDirectory, fileName), rendered, { mode: 0o600 });
  }
  fs.writeFileSync(path.join(outputDirectory, 'callsec-metadata.json'), `${JSON.stringify({
    url: 'http://127.0.0.1:9020/call/start',
    token: config.metadataToken,
    dids: [...new Set(config.dids)],
  }, null, 2)}\n`, { mode: 0o600 });
}

if (require.main === module) {
  try {
    const [, , inputFile, outputDirectory] = process.argv;
    if (!inputFile || !outputDirectory) throw new Error('Usage: render-config.cjs input.json output-directory');
    render(JSON.parse(fs.readFileSync(inputFile, 'utf8')), outputDirectory);
    process.stdout.write('Asterisk configuration rendered.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { render };

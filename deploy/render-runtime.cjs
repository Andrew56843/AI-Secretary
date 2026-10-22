#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const [inputPath, outputPath, sourceCommit] = process.argv.slice(2);
if (!inputPath || !outputPath || !/^[a-f0-9]{40}$/.test(sourceCommit || '')) {
  throw new Error('Usage: node deploy/render-runtime.cjs private-input.json private-output-directory git-commit');
}
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const required = ['host', 'openaiApiKey', 'proxyHost', 'proxyPort', 'proxyUsername', 'proxyPassword',
  'googleClientId', 'googleClientSecret', 'telegramBotToken', 'sipUsername', 'sipPassword',
  'sipServer', 'sipPort', 'adminPhone', 'adminPassword'];
for (const key of required) {
  if (!String(input[key] || '').trim()) throw new Error(`Missing private input field: ${key}`);
}
fs.mkdirSync(outputPath, { recursive: true, mode: 0o700 });
const internalPath = path.join(outputPath, 'internal-secrets.json');
const internal = fs.existsSync(internalPath)
  ? JSON.parse(fs.readFileSync(internalPath, 'utf8'))
  : Object.fromEntries(['postgresPassword', 'jwtSecret', 'dataEncryptionKey', 'voiceServiceToken', 'metadataToken']
    .map((key) => [key, randomBytes(32).toString('hex')]));
if (!internal.backupKey) internal.backupKey = randomBytes(32).toString('hex');

function writeJson(name, value) {
  fs.writeFileSync(path.join(outputPath, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function writeEnv(name, values) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n');
  fs.writeFileSync(path.join(outputPath, name), `${text}\n`, { mode: 0o600 });
}
const proxyAuthority = `${encodeURIComponent(input.proxyUsername)}:${encodeURIComponent(input.proxyPassword)}@${input.proxyHost}:${input.proxyPort}`;
const integrations = {
  OPENAI_API_KEY: input.openaiApiKey,
  OPENAI_PROXY_URL: `socks5://${proxyAuthority}`,
  TELEGRAM_BOT_TOKEN: input.telegramBotToken,
  TELEGRAM_PROXY_URL: `socks5://${proxyAuthority}`,
};
writeJson('internal-secrets.json', internal);
fs.writeFileSync(path.join(outputPath, 'backup.key'), `${internal.backupKey}\n`, { mode: 0o600 });
writeEnv('app.env', {
  PUBLIC_DOMAIN: 'callsec.ru',
  ACME_EMAIL: '79054176285@yandex.ru',
  SOURCE_COMMIT: sourceCommit,
  POSTGRES_PASSWORD: internal.postgresPassword,
  JWT_SECRET: internal.jwtSecret,
  DATA_ENCRYPTION_KEY: internal.dataEncryptionKey,
  VOICE_SERVICE_TOKEN: internal.voiceServiceToken,
  ADMIN_PHONES: input.adminPhone,
  ...integrations,
  GOOGLE_CLIENT_ID: input.googleClientId,
  GOOGLE_CLIENT_SECRET: input.googleClientSecret,
  PHONE_VERIFICATION_CALL_NUMBER: '+79952225212',
});
writeEnv('voice.env', {
  ...integrations,
  AUDIOSOCKET_HOST: '127.0.0.1',
  AUDIOSOCKET_PORT: 9019,
  METADATA_HOST: '127.0.0.1',
  METADATA_PORT: 9020,
  METADATA_TOKEN: internal.metadataToken,
  PLATFORM_API_BASE_URL: 'http://127.0.0.1:14000',
  VOICE_SERVICE_TOKEN: internal.voiceServiceToken,
  RECORDS_DIR: '/home/andrew/ai/records',
  OUTBOUND_DIALER_ENABLED: true,
  OUTBOUND_MAX_CONCURRENT: 1,
  OUTBOUND_TRUNK: 'PJSIP/novofon-endpoint/sip',
  OUTBOUND_CONTEXT: 'ai-outbound',
  FORWARD_CONTEXT: 'from-ai-forward',
  TELEGRAM_LINK_POLLING_ENABLED: true,
});
writeJson('asterisk-secrets.json', {
  sipUsername: input.sipUsername,
  sipPassword: input.sipPassword,
  sipHost: input.sipServer,
  sipPort: input.sipPort,
  sipTransport: input.sipTransport || 'tls',
  sipBindPort: input.sipBindPort || 5071,
  publicIp: input.host,
  metadataToken: internal.metadataToken,
  dids: ['79952225212', '79952225213'],
});
writeJson('owner.json', { phone: input.adminPhone, password: input.adminPassword, fullName: 'Андрей' });
console.log('Runtime configurations generated outside the repository; secret values omitted.');

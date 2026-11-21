'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const renderer = path.join(__dirname, 'render-runtime.cjs');
const commit = 'a'.repeat(40);

function fixture(t, internalOverrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'callsec-runtime-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'output');
  fs.mkdirSync(output);
  const input = {
    host: '192.0.2.10', openaiApiKey: 'test-openai', proxyHost: '192.0.2.20',
    proxyPort: 10000, proxyUsername: 'test-user', proxyPassword: 'test-password',
    googleClientId: 'test-client', googleClientSecret: 'test-secret',
    telegramBotToken: 'test-bot', sipUsername: 'test-sip', sipPassword: 'test-sip-password',
    sipServer: 'sip.novofon.ru', sipPort: 5061, adminPhone: '+79990000000',
    adminPassword: '123456'
  };
  const internal = Object.fromEntries([
    'postgresPassword', 'jwtSecret', 'dataEncryptionKey', 'voiceServiceToken',
    'metadataToken', 'backupKey'
  ].map((key) => [key, `test-${key}-${'x'.repeat(40)}`]));
  Object.assign(internal, internalOverrides);
  const inputPath = path.join(directory, 'input.json');
  fs.writeFileSync(inputPath, JSON.stringify(input));
  fs.writeFileSync(path.join(output, 'internal-secrets.json'), JSON.stringify(internal));
  return {
    internal,
    run: () => spawnSync(process.execPath, [renderer, inputPath, output, commit], { encoding: 'utf8' }),
    read: (name) => fs.readFileSync(path.join(output, name), 'utf8')
  };
}

test('runtime adds an independent SIP token without rotating existing recovery secrets', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const generated = JSON.parse(f.read('internal-secrets.json'));
  for (const [key, value] of Object.entries(f.internal)) assert.equal(generated[key], value);
  assert.match(generated.sipConfigToken, /^[a-f0-9]{64}$/);
  const app = f.read('app.env');
  const sync = f.read('sip-sync.env');
  const voice = f.read('voice.env');
  assert.ok(app.includes(`SIP_CONFIG_TOKEN="${generated.sipConfigToken}"`));
  assert.ok(sync.includes(`SIP_CONFIG_TOKEN="${generated.sipConfigToken}"`));
  assert.ok(sync.includes('http://127.0.0.1:14000/internal/voice/sip-lines/config'));
  assert.ok(!voice.includes('SIP_CONFIG_TOKEN'));
  assert.ok(!voice.includes(generated.sipConfigToken));
  assert.ok(!voice.includes('OUTBOUND_TRUNK'));
  assert.ok(app.includes('TELEGRAM_PROXY_URL="socks5://'));
  assert.ok(voice.includes('TELEGRAM_PROXY_URL="socks5://'));
  assert.equal(f.run().status, 0);
  assert.equal(JSON.parse(f.read('internal-secrets.json')).sipConfigToken, generated.sipConfigToken);
});

test('runtime refuses a SIP export token reused from the voice service', (t) => {
  const shared = `test-voiceServiceToken-${'x'.repeat(40)}`;
  const f = fixture(t, { sipConfigToken: shared });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be independent/);
  assert.ok(!result.stderr.includes(shared));
});

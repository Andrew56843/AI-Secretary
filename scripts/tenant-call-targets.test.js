'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractFunction(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `Missing function ${name}`);
  return source.slice(start, end).trim();
}

function telegramHarness() {
  const sent = [];
  const context = vm.createContext({
    CONFIG: { telegramBotToken: 'test-bot-token', telegramChatId: '999999' },
    splitTelegramText: (text) => [text],
    tgFetch: async (method, payload) => sent.push({ method, ...payload }),
    console: { log() {} },
  });
  vm.runInContext(`async ${extractFunction('sendTelegram', 'splitTelegramText')}`, context);
  return { context, sent };
}

test('an omitted Telegram argument cannot restore the global chat fallback', async () => {
  const { context, sent } = telegramHarness();
  await vm.runInContext("sendTelegram('private transcript')", context);
  assert.equal(sent.length, 0);
});

test('Telegram link confirmation sends only to the explicit linking chat', async () => {
  const { context, sent } = telegramHarness();
  await vm.runInContext("sendTelegram('Link confirmed', '12345')", context);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, '12345');
  assert.equal(sent[0].text, 'Link confirmed');
});

test('an ambiguous API log failure never triggers a direct Telegram duplicate', async () => {
  let directSends = 0;
  const context = vm.createContext({
    persistPlatformCallLog: async () => { throw new Error('API response lost after commit'); },
    sendTelegram: async () => { directSends += 1; },
    logErr() {},
  });
  vm.runInContext(`async ${extractFunction('persistFinalCallLog', 'sendFinalCallLog')}`, context);
  const result = await vm.runInContext("persistFinalCallLog('private transcript', 'SUCCESS')", context);
  assert.equal(result, false);
  assert.equal(directSends, 0);
});

function forwardingHarness({ enabled = true, phone = '+79051112233', routeReady = true, mergedPhone } = {}) {
  const calls = [];
  const route = { endpoint: 'callsec-sip-79952225213' };
  const context = vm.createContext({
    closed: false,
    redirectRequested: false,
    meta: {
      channel: 'PJSIP/test-channel',
      did: '79952225213',
      sipEndpoint: route.endpoint,
      platformProfile: { forwardingEnabled: enabled, forwardPhone: phone },
    },
    clientCfg: { forwardingEnabled: enabled, forwardPhone: mergedPhone ?? phone, outboundSipLine: route },
    CONFIG: { defaultForwardPhone: '+79059999999', forwardContext: 'from-ai-forward' },
    summary: {},
    normalizeForwardPhone: (value) => String(value || '').replace(/\D/g, ''),
    matchingSipRoute: () => routeReady ? route : null,
    readSipRoutes: () => ({}),
    shellQuote: (value) => value,
    exec(command, callback) { calls.push(command); callback(null, '', ''); },
    log() {},
    logErr() {},
  });
  vm.runInContext(extractFunction('redirectCallToMobile', 'requestCallHangup'), context);
  return { context, calls };
}

test('disabled tenant forwarding stays disabled when OpenAI closes', () => {
  const { context, calls } = forwardingHarness({ enabled: false });
  vm.runInContext("redirectCallToMobile('openai_close:1006')", context);
  assert.equal(calls.length, 0);
});

test('a missing tenant forward phone never uses global or merged defaults', () => {
  const { context, calls } = forwardingHarness({ phone: '', mergedPhone: '+79059999999' });
  vm.runInContext("redirectCallToMobile('openai_close:1006')", context);
  assert.equal(calls.length, 0);
});

test('enabled tenant forwarding keeps its own phone and dedicated SIP route', () => {
  const { context, calls } = forwardingHarness();
  vm.runInContext("redirectCallToMobile('openai_close:1006')", context);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /from-ai-forward,79051112233,1$/);
  assert.doesNotMatch(calls[0], /79059999999/);
  assert.equal(context.summary.escalated, true);
});

test('an unavailable dedicated SIP route still blocks forwarding', () => {
  const { context, calls } = forwardingHarness({ routeReady: false });
  vm.runInContext("redirectCallToMobile('openai_close:1006')", context);
  assert.equal(calls.length, 0);
});

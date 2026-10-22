#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const https = require('node:https');
const dotenv = require('dotenv');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const WebSocket = require('ws');

const env = dotenv.parse(fs.readFileSync(process.argv[2] || '.env'));
function proxyAgent(value) {
  if (!value) throw new Error('Proxy configuration required');
  return /^socks/.test(value) ? new SocksProxyAgent(value) : new HttpsProxyAgent(value);
}
function requestJson(url, agent, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { agent, headers, timeout: 20000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ status: response.statusCode, json: { error: { code: 'NON_JSON_RESPONSE' } } }); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Timeout')));
    request.on('error', reject);
  });
}
async function check(name, run) {
  try { console.log(JSON.stringify({ check: name, ...await run() })); }
  catch (error) {
    const category = /auth|407/i.test(error.message) ? 'PROXY_AUTH'
      : /timeout/i.test(error.message) ? 'TIMEOUT'
      : /socket|tls|tunnel/i.test(error.message) ? 'PROXY_CONNECTION' : 'REQUEST_FAILED';
    console.log(JSON.stringify({ check: name, ok: false, errorCode: error.code || category }));
    process.exitCode = 1;
  }
}
Promise.all([
  process.argv.includes('--realtime') ? check('Realtime session via proxy', () => new Promise((resolve, reject) => {
    const socket = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime-2', {
      agent: proxyAgent(env.OPENAI_PROXY_URL),
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      handshakeTimeout: 20000,
    });
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Timeout')), 25000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) { socket.terminate(); reject(error); }
      else { socket.close(); resolve({ ok: true, model: 'gpt-realtime-2', audioGenerated: false }); }
    }
    socket.on('error', finish);
    socket.on('close', () => { if (!settled) finish(new Error('Session closed before creation')); });
    socket.on('message', (data) => {
      let event;
      try { event = JSON.parse(data.toString()); } catch { return; }
      if (event.type === 'session.created') finish();
      if (event.type === 'error') {
        const error = new Error('Realtime rejected the session');
        error.code = event.error?.code || 'REALTIME_REJECTED';
        finish(error);
      }
    });
  })) : Promise.resolve(),
  check('OpenAI via proxy', async () => {
    const { status, json } = await requestJson('https://api.openai.com/v1/models', proxyAgent(env.OPENAI_PROXY_URL),
      { Authorization: `Bearer ${env.OPENAI_API_KEY}` });
    const available = new Set((json.data || []).map((item) => item.id));
    const models = Object.fromEntries(['gpt-realtime-2', 'gpt-realtime-mini', 'gpt-4o-mini-tts',
      'gpt-4o-transcribe', 'gpt-4o-transcribe-diarize', 'gpt-4o-mini'].map((name) => [name, available.has(name)]));
    if (status !== 200) process.exitCode = 1;
    return { ok: status === 200, httpStatus: status, errorCode: json.error?.code, models };
  }),
  check('Telegram via proxy', async () => {
    const agent = proxyAgent(process.argv.includes('--telegram-socks') ? env.OPENAI_PROXY_URL : env.TELEGRAM_PROXY_URL);
    const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
    const me = await requestJson(`${base}/getMe`, agent);
    const hook = await requestJson(`${base}/getWebhookInfo`, agent);
    if (!me.json.ok || !hook.json.ok) process.exitCode = 1;
    return { ok: Boolean(me.json.ok && hook.json.ok), httpStatus: me.status, webhookHttpStatus: hook.status,
      errorCode: me.json.error?.code,
      botUsername: me.json.result?.username, webhookConfigured: Boolean(hook.json.result?.url) };
  }),
]);

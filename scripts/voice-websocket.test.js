'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

test('voice WebSocket transport exchanges JSON, ping/pong and a clean close', { timeout: 5000 }, async (t) => {
  const server = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0, path: '/v1/realtime' });
  const errors = [];
  server.on('error', (error) => errors.push(error));
  let client;

  t.after(async () => {
    client?.terminate();
    for (const peer of server.clients) peer.terminate();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Loopback WebSocket server did not close')), 1000);
      server.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  });

  await once(server, 'listening');
  const connection = once(server, 'connection');
  client = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/realtime?model=local-test`, {
    headers: { Authorization: 'Bearer local-test-token' },
    handshakeTimeout: 3000,
  });
  client.on('error', (error) => errors.push(error));
  const [[peer, request]] = await Promise.all([connection, once(client, 'open')]);
  peer.on('error', (error) => errors.push(error));

  assert.equal(client.readyState, WebSocket.OPEN);
  assert.equal(request.headers.authorization, 'Bearer local-test-token');
  assert.equal(request.url, '/v1/realtime?model=local-test');

  const append = { type: 'input_audio_buffer.append', audio: Buffer.alloc(320).toString('base64') };
  const input = once(peer, 'message');
  client.send(JSON.stringify(append));
  const [inputRaw, inputBinary] = await input;
  assert.equal(inputBinary, false);
  assert.deepEqual(JSON.parse(inputRaw.toString()), append);

  const response = { type: 'response.output_audio.delta', delta: Buffer.from([0, 1, 2, 3]).toString('base64') };
  const output = once(client, 'message');
  peer.send(JSON.stringify(response));
  const [outputRaw, outputBinary] = await output;
  assert.equal(outputBinary, false);
  assert.deepEqual(JSON.parse(outputRaw.toString()), response);

  const clientPong = once(client, 'pong');
  client.ping('client-health');
  assert.equal((await clientPong)[0].toString(), 'client-health');
  const serverPong = once(peer, 'pong');
  peer.ping('server-health');
  assert.equal((await serverPong)[0].toString(), 'server-health');

  const closed = Promise.all([once(client, 'close'), once(peer, 'close')]);
  client.close(1000, 'smoke complete');
  for (const [code, reason] of await closed) {
    assert.equal(code, 1000);
    assert.equal(reason.toString(), 'smoke complete');
  }
  assert.equal(client.readyState, WebSocket.CLOSED);
  assert.deepEqual(errors, []);
});

test('voice proxy factory preserves CommonJS HTTP and SOCKS agent construction', { timeout: 3000 }, () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('function createProxyAgent(');
  const end = source.indexOf('\nconst proxyAgent =', start);
  assert.ok(start >= 0 && end > start, 'Voice proxy factory must be present');
  // Load only the pure factory, without booting Asterisk, dotenv or any external connections.
  const createProxyAgent = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    HttpsProxyAgent,
    SocksProxyAgent,
  });

  const cases = [
    ['http://test%40user:local%3Apassword@127.0.0.1:1080', HttpsProxyAgent],
    ['https://test%40user:local%3Apassword@[::1]:1080', HttpsProxyAgent],
    ['socks4://test-user:local-password@127.0.0.1:1080', SocksProxyAgent],
    ['socks5://test-user:local-password@[::1]:1080', SocksProxyAgent],
    ['socks5h://test-user:local-password@127.0.0.1:1080', SocksProxyAgent],
    ['socks://test-user:local-password@[::1]:1080', SocksProxyAgent],
  ];
  for (const [url, Agent] of cases) {
    const agent = createProxyAgent(url);
    try {
      assert.ok(agent instanceof Agent, `Unexpected agent for ${new URL(url).protocol}`);
      assert.equal(Number(agent.proxy.port), 1080);
      assert.equal(Object.keys(agent.sockets).length, 0);
      assert.equal(Object.keys(agent.requests).length, 0);
    } finally {
      agent.destroy();
    }
  }
});

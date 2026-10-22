'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { render } = require('./render-config.cjs');
const { findDid, postMetadata } = require('./callsec-metadata.agi.cjs');

const example = {
  publicIp: '192.0.2.1',
  sipUsername: 'example_account',
  sipPassword: 'example-password',
  metadataToken: 'a'.repeat(40),
  dids: ['79952225212', '79952225213'],
};

test('templates preserve the SIP URI separator and produce matching metadata', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'callsec-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  render(example, directory);
  const pjsip = fs.readFileSync(path.join(directory, 'pjsip.conf'), 'utf8');
  const dialplan = fs.readFileSync(path.join(directory, 'extensions.conf'), 'utf8');
  assert.match(pjsip, /client_uri=sip:example_account@sip[.]novofon[.]ru/);
  assert.match(pjsip, /protocol=tls\nbind=0[.]0[.]0[.]0:5071/);
  assert.match(pjsip, /server_uri=sip:sip[.]novofon[.]ru:5061\\;transport=tls/);
  assert.equal((pjsip.match(/outbound_proxy=sip:sip[.]novofon[.]ru:5061\\;transport=tls\\;lr/g) || []).length, 3);
  assert.match(pjsip, /verify_server=yes/);
  assert.match(pjsip, /allow_wildcard_certs=yes/);
  assert.match(dialplan, /\}@sip[.]novofon[.]ru,45/);
  assert.doesNotMatch(pjsip + dialplan, /@@[A-Z_]+@@/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'callsec-metadata.json'), 'utf8')), {
    url: 'http://127.0.0.1:9020/call/start', token: example.metadataToken, dids: example.dids,
  });
});

test('renderer refuses config injection and incomplete identity', () => {
  for (const override of [{ sipPassword: 'abc\n[evil]' }, { metadataToken: '' }, { dids: ['123'] },
    { sipHost: 'sip.example/invalid' }, { publicIp: 'not-an-ip' }]) {
    assert.throws(() => render({ ...example, ...override }, 'must-not-be-created'));
  }
});

test('UDP compatibility remains explicit and uses no TLS settings', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'callsec-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  render({ ...example, sipTransport: 'udp' }, directory);
  const pjsip = fs.readFileSync(path.join(directory, 'pjsip.conf'), 'utf8');
  assert.match(pjsip, /protocol=udp\nbind=0[.]0[.]0[.]0:5060/);
  assert.match(pjsip, /server_uri=sip:sip[.]novofon[.]ru:5060\\;transport=udp/);
  assert.doesNotMatch(pjsip, /verify_server|ca_list_file/);
  assert.throws(() => render({ ...example, sipTransport: 'bogus' }, directory), /sipTransport/);
});

test('DID identification accepts trunk aliases and rejects unconfigured numbers', () => {
  assert.equal(findDid(['did_79952225213'], example.dids), '79952225213');
  assert.equal(findDid(['s', '<sip:+79952225212@example.org>'], example.dids), '79952225212');
  assert.equal(findDid(['caller799522252130'], example.dids), null);
  assert.equal(findDid(['79991112233'], example.dids), null);
});

test('metadata client authenticates JSON and fails closed for non-OK responses', async (t) => {
  const received = [];
  let reply = 'OK';
  let status = 200;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ token: request.headers['x-metadata-token'], body: JSON.parse(Buffer.concat(chunks)) });
    response.writeHead(status);
    response.end(reply);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { url: `http://127.0.0.1:${server.address().port}/call/start`, token: 'example-token' };
  const body = { did: '79952225213', channel: 'PJSIP/novofon-endpoint-00000001' };
  assert.equal(await postMetadata(config, body), 'OK');
  assert.deepEqual(received[0], { token: 'example-token', body });
  reply = 'HANGUP';
  assert.equal(await postMetadata(config, body), 'HANGUP');
  reply = 'OK';
  status = 401;
  assert.equal(await postMetadata(config, body), 'HANGUP');
  await assert.rejects(postMetadata({ ...config, url: 'http://example.org/' }, body), /local HTTP/);
});

test('AGI returns control to Asterisk after rejecting an unknown call', { timeout: 3000 }, async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, 'callsec-metadata.agi.cjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let received = '';
  let buffer = '';
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    received += chunk;
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const command = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      child.stdin.write(command.startsWith('SET VARIABLE ') ? '200 result=1\n' : '200 result=0\n');
    }
  });
  child.stdin.write('agi_channel: PJSIP/example-00000001\nagi_extension: s\nagi_callerid: 79991112233\n\n');
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exitCode, 0);
  assert.match(received, /SET VARIABLE AI_METADATA_ACTION "HANGUP"/);
});

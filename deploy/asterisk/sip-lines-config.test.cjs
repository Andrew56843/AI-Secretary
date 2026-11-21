'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_SIP_LINES, MAX_GENERATED_PJSIP_BYTES, MAX_GENERATED_ROUTES_BYTES,
  sipLineObjectNames, assertSipConfigurationSize, renderSipLinesConfig,
} = require('./sip-lines-config.cjs');

const first = {
  id: 'line-a',
  number: '+79952225212',
  endpoint: 'callsec-sip-79952225212',
  username: 'example_account_a',
  password: 'example-password-a',
  server: 'sip.novofon.ru',
  port: 5061,
  transport: 'tls',
  revision: '2026-11-21T00:00:00.000Z',
};
const second = {
  ...first,
  id: 'line-b',
  number: '+79952225213',
  endpoint: 'callsec-sip-79952225213',
  username: 'example_account_b',
  password: 'example-password-b',
};

function section(config, name) {
  const start = config.indexOf(`[${name}]\n`);
  assert.notEqual(start, -1);
  const end = config.indexOf('\n[', start + 1);
  return config.slice(start, end === -1 ? config.length : end);
}

test('renders independent SIP identities without shared IP identification or an inbound caller ID override', () => {
  const { pjsip } = renderSipLinesConfig([first, second]);
  for (const line of [first, second]) {
    const names = sipLineObjectNames(line);
    const auth = section(pjsip, names.auth);
    const endpoint = section(pjsip, line.endpoint);
    const registration = section(pjsip, names.registration);
    assert.ok(auth.includes(`username=${line.username}\npassword=${line.password}`));
    assert.ok(endpoint.includes(`outbound_auth=${names.auth}`));
    assert.ok(endpoint.includes(`from_user=${line.username}`));
    assert.doesNotMatch(endpoint, /^callerid\s*=/mi);
    assert.match(endpoint, /^transport=callsec-tls$/m);
    assert.match(endpoint, /^allow=alaw,ulaw$/m);
    assert.match(endpoint, /^media_encryption=sdes$/m);
    assert.match(endpoint, /^send_pai=yes$/m);
    assert.match(endpoint, /^send_rpid=yes$/m);
    assert.match(endpoint, /^trust_id_inbound=yes$/m);
    assert.ok(registration.includes(`outbound_auth=${names.auth}`));
    assert.match(registration, /^line=yes$/m);
    assert.ok(registration.includes(`endpoint=${line.endpoint}`));
  }
  assert.doesNotMatch(pjsip, /^type=identify$|^match=|media_encryption_optimistic|verify_server=no/m);
  assert.equal((pjsip.match(/^outbound_proxy=sip:sip\.novofon\.ru:5061\\;transport=tls\\;lr$/gm) || []).length, 6);
});

test('exposes only safe normalized routes keyed by 11-digit DID', () => {
  const { routes } = renderSipLinesConfig([{ ...first, number: '+7 (995) 222-52-12', server: 'SIP.NOVOFON.RU' }]);
  assert.deepEqual(routes, {
    '79952225212': {
      endpoint: first.endpoint,
      number: first.number,
      server: first.server,
      port: first.port,
      transport: first.transport,
      revision: first.revision,
    },
  });
  assert.doesNotMatch(JSON.stringify(routes), /username|password|example_account|example-password/);
});

test('is deterministic without mutating input and accepts an empty enabled-line set', () => {
  const input = [second, first];
  const before = JSON.stringify(input);
  assert.deepEqual(renderSipLinesConfig(input), renderSipLinesConfig([first, second]));
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(renderSipLinesConfig([]), { pjsip: '', routes: {} });
});

test('rejects configuration injection without exposing credentials in errors', () => {
  const unsafe = [
    { id: 'a\n[other]' },
    { endpoint: 'novofon-endpoint' },
    { endpoint: second.endpoint },
    { endpoint: 'callsec-sip-a\n[other]' },
    { username: 'account;secret-marker' },
    { username: 'account with space' },
    { password: 'private-marker\n[other]' },
    { password: 'private-marker#comment' },
    { password: 'private-marker;comment' },
    { password: 'private-marker\\value' },
    { password: 'private-marker value' },
    { server: 'sip.novofon.ru;transport=udp' },
    { server: 'sip.novofon.ru/path' },
    { server: 'sip..novofon.ru' },
    { server: '-sip.novofon.ru' },
    { number: '79952225212\nusername=other' },
  ];
  for (const override of unsafe) {
    assert.throws(() => renderSipLinesConfig([{ ...first, ...override }]), (error) => {
      assert.match(error.message, /^Invalid SIP line /);
      assert.doesNotMatch(error.message, /private-marker|secret-marker|example-password/);
      return true;
    });
  }
});

test('rejects duplicates of IDs, endpoints, normalized DIDs and provider identities', () => {
  for (const override of [
    { id: first.id },
    { number: '79952225212', endpoint: first.endpoint },
    { number: '+7 (995) 222-52-12', endpoint: first.endpoint },
    { username: first.username },
    { username: first.username, server: first.server.toUpperCase() },
  ]) {
    assert.throws(() => renderSipLinesConfig([first, { ...second, ...override }]), /Duplicate SIP line /);
  }
});

test('requires each canonical endpoint to match its normalized DID', () => {
  for (const endpoint of [second.endpoint, `${first.endpoint}-auth`, 'callsec-sip-custom']) {
    assert.throws(() => renderSipLinesConfig([{ ...first, endpoint }]), /Invalid SIP line endpoint/);
  }
});

test('requires verified Novofon TLS, Russian DIDs and nonempty record identity', () => {
  for (const override of [
    { transport: 'udp' }, { transport: 'tcp' }, { transport: undefined },
    { port: 0 }, { port: 65536 }, { port: 5061.5 }, { port: '5061' }, { port: 5062 }, { port: 443 },
    { server: 'example.org' }, { server: 'sip-1.novofon.ru' },
    { number: '+441234567890' }, { number: '7995222521' }, { number: '' },
    { id: '' }, { id: 'a'.repeat(81) }, { endpoint: `callsec-sip-${'a'.repeat(80)}` },
    { enabled: false },
  ]) {
    assert.throws(() => renderSipLinesConfig([{ ...first, ...override }]), /Invalid SIP line /);
  }
  for (const input of [null, {}, 'lines']) assert.throws(() => renderSipLinesConfig(input), /must be an array/);
  for (const line of [null, [], 'line']) assert.throws(() => renderSipLinesConfig([line]), /Invalid SIP line /);
});

test('requires canonical update revisions and changes both outputs when a line is rotated', () => {
  for (const revision of [undefined, '', 'not-a-date', '2026-11-21', '2026-02-30T00:00:00.000Z',
    '2026-11-21T00:00:00Z', '2026-11-21T00:00:00.000Z\n[other]']) {
    assert.throws(() => renderSipLinesConfig([{ ...first, revision }]), /Invalid SIP line revision/);
  }
  const before = renderSipLinesConfig([first]);
  const revision = '2026-11-21T00:00:01.000Z';
  const after = renderSipLinesConfig([{ ...first, revision }]);
  assert.notEqual(after.pjsip, before.pjsip);
  assert.equal(after.routes['79952225212'].revision, revision);
  assert.ok(after.pjsip.includes(`; ${first.endpoint} revision=${revision}`));
});

test('password rotation replaces authentication and registration identities without changing the DID endpoint', () => {
  const rotated = { ...first, password: 'rotated-private-password', revision: '2026-11-21T00:00:01.000Z' };
  const beforeNames = sipLineObjectNames(first);
  const afterNames = sipLineObjectNames(rotated);
  const after = renderSipLinesConfig([rotated]);
  assert.notEqual(afterNames.auth, beforeNames.auth);
  assert.notEqual(afterNames.registration, beforeNames.registration);
  assert.match(afterNames.registration, /-20261121000001000$/);
  assert.doesNotMatch(JSON.stringify(afterNames), /private|password/);
  assert.ok(!after.pjsip.includes(`[${beforeNames.registration}]`));
  const registration = section(after.pjsip, afterNames.registration);
  assert.ok(registration.includes(`outbound_auth=${afterNames.auth}`));
  assert.ok(registration.includes(`contact_user=${first.username}`));
  assert.ok(registration.includes(`endpoint=${first.endpoint}`));
  assert.ok(section(after.pjsip, first.endpoint).includes(`outbound_auth=${afterNames.auth}`));
  assert.equal(after.routes['79952225212'].endpoint, first.endpoint);
});

test('all 2000 valid maximum-size lines fit consistent protected output limits', () => {
  const lines = Array.from({ length: MAX_SIP_LINES }, (_, index) => {
    const number = String(79950000000 + index);
    return {
      ...first, id: `line-${index}`.padEnd(80, 'a'), number: `+${number}`,
      endpoint: `callsec-sip-${number}`, username: `account_${index}`.padEnd(128, 'a'), password: 'a'.repeat(512),
    };
  });
  const output = renderSipLinesConfig(lines);
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, lines })) <= 2 * 1024 * 1024);
  assert.equal(Object.keys(output.routes).length, MAX_SIP_LINES);
  assert.ok(Buffer.byteLength(output.pjsip) > 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(output.pjsip) <= MAX_GENERATED_PJSIP_BYTES);
  assert.ok(Buffer.byteLength(`${JSON.stringify(output.routes, null, 2)}\n`) <= MAX_GENERATED_ROUTES_BYTES);
  assert.throws(() => renderSipLinesConfig([...lines, first]), /Too many SIP lines/);
});

test('generated limits use UTF-8 bytes and accept the exact PJSIP boundary', () => {
  assert.doesNotThrow(() => assertSipConfigurationSize({ pjsip: 'a'.repeat(MAX_GENERATED_PJSIP_BYTES), routes: {} }));
  assert.throws(() => assertSipConfigurationSize({ pjsip: 'a'.repeat(MAX_GENERATED_PJSIP_BYTES + 1), routes: {} }), /file limit/);
  assert.throws(() => assertSipConfigurationSize({ pjsip: '\u00e9'.repeat(MAX_GENERATED_PJSIP_BYTES / 2 + 1), routes: {} }), /file limit/);
  assert.throws(() => assertSipConfigurationSize({ pjsip: '', routes: { oversized: 'a'.repeat(MAX_GENERATED_ROUTES_BYTES) } }), /file limit/);
});

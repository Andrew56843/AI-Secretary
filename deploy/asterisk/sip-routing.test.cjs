'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { safeSipRoute, parseSipRoutes, installedSipRoute, matchingSipRoute } = require('./sip-routing.cjs');

const did = '79952225213';
const route = {
  endpoint: `callsec-sip-${did}`,
  number: `+${did}`,
  server: 'sip.novofon.ru',
  port: 5061,
  transport: 'tls',
  revision: '2026-11-21T12:00:00.000Z',
};

test('safe routes bind the DID to the canonical endpoint and discard credentials', () => {
  assert.deepEqual(safeSipRoute({ ...route, username: 'private', password: 'private' }, did), route);
  assert.equal(safeSipRoute(route, '79952225212'), null);
});

test('safe routes reject shared endpoints, insecure providers and missing revisions', () => {
  for (const update of [
    { endpoint: 'novofon-endpoint' }, { endpoint: 'callsec-sip-79952225212' },
    { endpoint: 'callsec-sip-79952225213\n' }, { server: 'other.example' },
    { port: 5060 }, { transport: 'udp' }, { revision: undefined }, { revision: 'not-a-date' },
  ]) assert.equal(safeSipRoute({ ...route, ...update }, did), null);
});

test('route maps reject corrupted or noncanonical DID keys', () => {
  assert.deepEqual(parseSipRoutes(JSON.stringify({ [did]: route })), { [did]: route });
  for (const value of [null, [], { [`+${did}`]: route }, { '79952225212': route }]) {
    assert.throws(() => parseSipRoutes(JSON.stringify(value)), /dedicated SIP route/i);
  }
});

test('a route becomes usable only after the exact revision is installed', () => {
  const routes = { [did]: route };
  assert.deepEqual(installedSipRoute(`+${did}`, routes), route);
  assert.deepEqual(matchingSipRoute(route, did, routes), route);
  assert.equal(matchingSipRoute({ ...route, revision: '2026-11-21T12:00:01.000Z' }, did, routes), null);
  assert.equal(matchingSipRoute(route, did, {}), null);
});

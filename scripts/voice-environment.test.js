'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const end = source.indexOf("const net = require('net');");
assert.ok(end > 0 && end < 1024);
const bootstrap = source.slice(0, end);

test('production voice never reads repository dotenv secrets', () => {
  vm.runInNewContext(bootstrap, {
    process: { env: { NODE_ENV: 'production' } },
    require() { throw new Error('Production voice must not load dotenv'); },
  });
});

test('local development can still load the repository environment', () => {
  let loads = 0;
  vm.runInNewContext(bootstrap, {
    process: { env: { NODE_ENV: 'development' } },
    require(name) { assert.equal(name, 'dotenv'); return { config() { loads += 1; } }; },
  });
  assert.equal(loads, 1);
});

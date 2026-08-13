'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCallTiming, getCompletedCallSeconds } = require('../call-timing');

test('freezes call duration when the phone channel ends', () => {
  const timing = createCallTiming(1_000);

  assert.equal(timing.snapshot(21_000).durationMs, 20_000);
  assert.equal(timing.finish(102_180).durationMs, 101_180);
  assert.equal(timing.snapshot(156_000).durationMs, 101_180);
  assert.equal(timing.finish(200_000).durationMs, 101_180);
  assert.equal(getCompletedCallSeconds(timing.snapshot(300_000).durationMs), 101);
});

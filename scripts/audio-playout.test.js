'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getDueFrameCount,
  getNextTickDelayMs,
} = require('../audio-playout');

test('one audio frame is due on an on-time 20 ms tick', () => {
  assert.equal(getDueFrameCount({
    nowMs: 1_000,
    nextFrameAtMs: 1_000,
    frameMs: 20,
    maxFrames: 3,
  }), 1);
});

test('late ticks catch up without an unbounded audio burst', () => {
  assert.equal(getDueFrameCount({
    nowMs: 1_075,
    nextFrameAtMs: 1_000,
    frameMs: 20,
    maxFrames: 3,
  }), 3);
});

test('early ticks wait until the absolute audio deadline', () => {
  assert.equal(getDueFrameCount({
    nowMs: 990,
    nextFrameAtMs: 1_000,
    frameMs: 20,
    maxFrames: 3,
  }), 0);
  assert.equal(getNextTickDelayMs({
    nowMs: 990,
    nextFrameAtMs: 1_000,
    maxDelayMs: 20,
  }), 10);
});

test('the next tick delay is bounded to one frame interval', () => {
  assert.equal(getNextTickDelayMs({
    nowMs: 900,
    nextFrameAtMs: 1_000,
    maxDelayMs: 20,
  }), 20);
});

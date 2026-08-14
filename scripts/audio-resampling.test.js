'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDownsampler24kTo8k } = require('../audio-resampling');

function makeTone(frequencyHz, seconds, amplitude = 12_000) {
  const sampleRate = 24_000;
  const sampleCount = Math.round(seconds * sampleRate);
  const pcm = Buffer.alloc(sampleCount * 2);

  for (let i = 0; i < sampleCount; i++) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate));
    pcm.writeInt16LE(value, i * 2);
  }

  return pcm;
}

function rms(pcm, skipSamples = 0) {
  let sumSquares = 0;
  let samples = 0;

  for (let offset = skipSamples * 2; offset + 1 < pcm.length; offset += 2) {
    const value = pcm.readInt16LE(offset);
    sumSquares += value * value;
    samples += 1;
  }

  return Math.sqrt(sumSquares / Math.max(samples, 1));
}

test('24 kHz to 8 kHz downsampler preserves speech-band audio', () => {
  const downsample = createDownsampler24kTo8k();
  const output = downsample(makeTone(1_000, 0.5));

  assert.equal(output.length, 8_000);
  assert.ok(rms(output, 100) > 7_500);
});

test('24 kHz to 8 kHz downsampler suppresses frequencies that would alias', () => {
  const downsample = createDownsampler24kTo8k();
  const output = downsample(makeTone(6_000, 0.5));

  assert.ok(rms(output, 100) < 150);
});

test('streaming chunks produce the same samples as one complete buffer', () => {
  const input = makeTone(1_700, 0.5);
  const complete = createDownsampler24kTo8k()(input);
  const streaming = createDownsampler24kTo8k();
  const chunks = [];
  const chunkSizes = [317, 802, 1_103, 58, 2_401, 777, 4_096];
  let offset = 0;
  let chunkIndex = 0;

  while (offset < input.length) {
    const size = chunkSizes[chunkIndex % chunkSizes.length];
    chunks.push(streaming(input.subarray(offset, Math.min(offset + size, input.length))));
    offset += size;
    chunkIndex += 1;
  }

  assert.deepEqual(Buffer.concat(chunks), complete);
});

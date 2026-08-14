'use strict';

const INPUT_SAMPLE_RATE = 24_000;
const OUTPUT_SAMPLE_RATE = 8_000;
const DECIMATION_FACTOR = INPUT_SAMPLE_RATE / OUTPUT_SAMPLE_RATE;
const FILTER_TAP_COUNT = 63;
const FILTER_CUTOFF_HZ = 3_400;

function clampPcm16(value) {
  return Math.max(-32_768, Math.min(32_767, value));
}

function buildLowPassTaps() {
  const taps = new Float64Array(FILTER_TAP_COUNT);
  const center = (FILTER_TAP_COUNT - 1) / 2;
  const normalizedCutoff = FILTER_CUTOFF_HZ / INPUT_SAMPLE_RATE;
  let sum = 0;

  for (let i = 0; i < FILTER_TAP_COUNT; i++) {
    const offset = i - center;
    const sinc = offset === 0
      ? 2 * normalizedCutoff
      : Math.sin(2 * Math.PI * normalizedCutoff * offset) / (Math.PI * offset);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FILTER_TAP_COUNT - 1));
    taps[i] = sinc * hamming;
    sum += taps[i];
  }

  for (let i = 0; i < taps.length; i++) {
    taps[i] /= sum;
  }

  return taps;
}

const LOW_PASS_TAPS = buildLowPassTaps();

// Stateful anti-aliasing FIR decimator. State and phase are preserved across
// Realtime audio deltas so chunk boundaries cannot create clicks or aliases.
function createDownsampler24kTo8k() {
  const historySize = LOW_PASS_TAPS.length - 1;
  let history = new Float64Array(historySize);
  let samplePhase = 0;
  let byteCarry = Buffer.alloc(0);

  const reset = () => {
    history = new Float64Array(historySize);
    samplePhase = 0;
    byteCarry = Buffer.alloc(0);
  };

  const downsample = (pcm24) => {
    if (!pcm24?.length && !byteCarry.length) return Buffer.alloc(0);

    const input = byteCarry.length
      ? Buffer.concat([byteCarry, pcm24 || Buffer.alloc(0)])
      : (pcm24 || Buffer.alloc(0));
    const usableBytes = input.length - (input.length % 2);
    byteCarry = usableBytes < input.length ? Buffer.from(input.subarray(usableBytes)) : Buffer.alloc(0);

    const sampleCount = usableBytes / 2;
    if (!sampleCount) return Buffer.alloc(0);

    const combined = new Float64Array(historySize + sampleCount);
    combined.set(history);
    for (let i = 0; i < sampleCount; i++) {
      combined[historySize + i] = input.readInt16LE(i * 2);
    }

    const firstOutputSample = (DECIMATION_FACTOR - samplePhase) % DECIMATION_FACTOR;
    const outputCount = firstOutputSample < sampleCount
      ? Math.floor((sampleCount - 1 - firstOutputSample) / DECIMATION_FACTOR) + 1
      : 0;
    const output = Buffer.alloc(outputCount * 2);
    let outputIndex = 0;

    for (let inputIndex = firstOutputSample; inputIndex < sampleCount; inputIndex += DECIMATION_FACTOR) {
      const combinedIndex = historySize + inputIndex;
      let filtered = 0;

      for (let tapIndex = 0; tapIndex < LOW_PASS_TAPS.length; tapIndex++) {
        filtered += LOW_PASS_TAPS[tapIndex] * combined[combinedIndex - tapIndex];
      }

      output.writeInt16LE(clampPcm16(Math.round(filtered)), outputIndex * 2);
      outputIndex += 1;
    }

    history = combined.slice(combined.length - historySize);
    samplePhase = (samplePhase + sampleCount) % DECIMATION_FACTOR;
    return output;
  };

  downsample.reset = reset;
  return downsample;
}

module.exports = {
  createDownsampler24kTo8k,
};

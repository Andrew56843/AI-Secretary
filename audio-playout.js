'use strict';

function getDueFrameCount({ nowMs, nextFrameAtMs, frameMs, maxFrames }) {
  const safeFrameMs = Math.max(1, Number(frameMs) || 1);
  const safeMaxFrames = Math.max(1, Math.floor(Number(maxFrames) || 1));

  if (!Number.isFinite(nextFrameAtMs) || nextFrameAtMs <= 0) return 1;
  if (!Number.isFinite(nowMs) || nowMs < nextFrameAtMs) return 0;

  return Math.min(
      safeMaxFrames,
      Math.floor((nowMs - nextFrameAtMs) / safeFrameMs) + 1
  );
}

function getNextTickDelayMs({ nowMs, nextFrameAtMs, maxDelayMs }) {
  const safeMaxDelayMs = Math.max(0, Number(maxDelayMs) || 0);
  if (!Number.isFinite(nowMs) || !Number.isFinite(nextFrameAtMs)) return 0;
  return Math.max(0, Math.min(safeMaxDelayMs, nextFrameAtMs - nowMs));
}

module.exports = {
  getDueFrameCount,
  getNextTickDelayMs,
};

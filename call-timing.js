'use strict';

function createCallTiming(startedAt = Date.now()) {
  let endedAt = null;

  function snapshot(at = Date.now()) {
    const snapshotAt = endedAt ?? at;
    return {
      startedAt,
      endedAt: snapshotAt,
      durationMs: Math.max(0, snapshotAt - startedAt),
    };
  }

  function finish(at = Date.now()) {
    if (endedAt === null) {
      endedAt = at;
    }
    return snapshot(at);
  }

  return { finish, snapshot };
}

function getCompletedCallSeconds(durationMs) {
  return Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
}

module.exports = { createCallTiming, getCompletedCallSeconds };

'use strict';

function normalizeTranscriptComparison(text) {
  return String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
}

function transcriptTokens(text) {
  return normalizeTranscriptComparison(text)
      .split(' ')
      .filter((token) => token.length > 1);
}

function spokenTextSimilarity(left, right) {
  const normalizedLeft = normalizeTranscriptComparison(left);
  const normalizedRight = normalizeTranscriptComparison(right);

  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;

  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = shorter === normalizedLeft ? normalizedRight : normalizedLeft;
  if (shorter.length >= 32 && longer.includes(shorter)) {
    return shorter.length / longer.length;
  }

  const leftTokens = new Set(transcriptTokens(normalizedLeft));
  const rightTokens = new Set(transcriptTokens(normalizedRight));
  if (leftTokens.size < 4 || rightTokens.size < 4) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }

  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function isLikelyAssistantEcho(userText, assistantText) {
  if (transcriptTokens(userText).length < 4) return false;
  return spokenTextSimilarity(userText, assistantText) >= 0.78;
}

function transcriptionReferenceMatch(userText, referenceText) {
  const userTokens = new Set(transcriptTokens(userText));
  const referenceTokens = new Set(transcriptTokens(referenceText));
  if (userTokens.size < 12 || referenceTokens.size < 12) return null;

  let intersection = 0;
  for (const token of userTokens) {
    if (referenceTokens.has(token)) intersection += 1;
  }

  const coverage = intersection / userTokens.size;
  const similarity = (2 * intersection) / (userTokens.size + referenceTokens.size);
  if (coverage < 0.88 || similarity < 0.55) return null;

  return { coverage, similarity };
}

function findLikelyTranscriptionPromptLeak(userText, references = []) {
  let bestMatch = null;

  references.forEach((reference, index) => {
    const match = transcriptionReferenceMatch(userText, reference);
    if (!match) return;
    if (!bestMatch || match.similarity > bestMatch.similarity) {
      bestMatch = { ...match, referenceIndex: index };
    }
  });

  return bestMatch;
}

function parseTranscriptLine(line) {
  const match = String(line || '').match(/^(Assi|Assistant|User):\s*(.*)$/i);
  if (!match) return null;
  return {
    role: /^User$/i.test(match[1]) ? 'user' : 'assistant',
    text: match[2].trim(),
  };
}

function formatTranscriptTimestamp(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds % 60).toFixed(1).padStart(4, '0');
  return `${String(minutes).padStart(2, '0')}:${remainder}`;
}

function formatDiarizedTranscript(segments, rawLog) {
  const validSegments = Array.isArray(segments)
      ? segments.filter((segment) => segment && String(segment.text || '').trim() && segment.speaker)
      : [];
  const assistantReference = String(rawLog || '')
      .split(/\r?\n/)
      .map(parseTranscriptLine)
      .filter((turn) => turn?.role === 'assistant' && turn.text)
      .map((turn) => turn.text)
      .join(' ');
  const speakerTexts = new Map();

  for (const segment of validSegments) {
    const speaker = String(segment.speaker);
    speakerTexts.set(speaker, `${speakerTexts.get(speaker) || ''} ${String(segment.text).trim()}`.trim());
  }

  let assistantSpeaker = null;
  let assistantScore = 0;
  for (const [speaker, text] of speakerTexts) {
    const score = spokenTextSimilarity(text, assistantReference);
    if (score > assistantScore) {
      assistantScore = score;
      assistantSpeaker = speaker;
    }
  }

  if (assistantScore < 0.25) {
    assistantSpeaker = null;
  }

  const text = validSegments
      .map((segment) => {
        const speaker = String(segment.speaker);
        const role = assistantSpeaker
            ? speaker === assistantSpeaker ? 'Assi' : 'User'
            : `Speaker ${speaker}`;
        return `[${formatTranscriptTimestamp(segment.start)}-${formatTranscriptTimestamp(segment.end)}] ${role}: ${String(segment.text).trim()}`;
      })
      .join('\n');

  return { text, assistantSpeaker, assistantScore };
}

function indexRawTranscript(rawLog) {
  let assistantIndex = 0;
  let userIndex = 0;
  const assistantTurns = [];
  const annotatedLines = [];

  for (const line of String(rawLog || '').split(/\r?\n/)) {
    const assistant = line.match(/^(?:Assi|Assistant):\s*(.*)$/i);
    if (assistant) {
      assistantIndex += 1;
      const text = String(assistant[1] || '').trim();
      assistantTurns.push(text);
      annotatedLines.push(`A${assistantIndex}: ${text}`);
      continue;
    }

    const user = line.match(/^User:\s*(.*)$/i);
    if (user) {
      userIndex += 1;
      annotatedLines.push(`U${userIndex} (после A${assistantIndex}): ${String(user[1] || '').trim()}`);
    }
  }

  return { assistantTurns, annotatedText: annotatedLines.join('\n') };
}

function transcriptEvidenceTokens(value) {
  return normalizeTranscriptComparison(value)
      .split(/\s+/)
      .filter((token) => token.length > 1);
}

function buildCanonicalTranscript(rawLog, correctionText, callerEvidence = '') {
  const indexed = indexRawTranscript(rawLog);
  const parsed = JSON.parse(String(correctionText || ''));
  if (!Array.isArray(parsed?.userTurns)) {
    throw new Error('post-call correction has no userTurns array');
  }

  const userTurnsByAssistant = new Map();
  for (const turn of parsed.userTurns) {
    const afterAssistantIndex = Number(turn?.afterAssistantIndex);
    const text = String(turn?.text || '')
        .replace(/^(?:User|Assi|Assistant):\s*/i, '')
        .trim();
    if (!Number.isInteger(afterAssistantIndex) || afterAssistantIndex < 0 || afterAssistantIndex > indexed.assistantTurns.length || !text) {
      throw new Error('post-call correction contains an invalid user turn');
    }
    const bucket = userTurnsByAssistant.get(afterAssistantIndex) || [];
    bucket.push(text);
    userTurnsByAssistant.set(afterAssistantIndex, bucket);
  }

  const lines = [];
  for (const text of userTurnsByAssistant.get(0) || []) {
    lines.push(`User: ${text}`);
  }
  indexed.assistantTurns.forEach((assistantText, index) => {
    lines.push(`Assi: ${assistantText}`);
    for (const text of userTurnsByAssistant.get(index + 1) || []) {
      lines.push(`User: ${text}`);
    }
  });

  if (lines.length === indexed.assistantTurns.length) {
    throw new Error('post-call correction removed every caller turn');
  }

  const evidenceTokens = new Set(transcriptEvidenceTokens(callerEvidence));
  if (evidenceTokens.size >= 4) {
    const resultTokens = new Set(transcriptEvidenceTokens(
      lines
          .filter((line) => line.startsWith('User: '))
          .join(' ')
    ));
    const matchedTokens = [...evidenceTokens].filter((token) => resultTokens.has(token)).length;
    const coverage = matchedTokens / evidenceTokens.size;
    if (coverage < 0.5) {
      throw new Error(`post-call correction covers only ${Math.round(coverage * 100)}% of caller evidence`);
    }
  }
  return lines.join('\n');
}

function sanitizeRealtimeTranscript(rawLog, callInfo = {}) {
  const lines = String(rawLog || '').split(/\r?\n/);
  const parsed = lines.map(parseTranscriptLine);
  const previousAssistantTexts = [];
  const references = [
    callInfo.greetingText,
    callInfo.instructions,
    callInfo.transcriptionPrompt,
  ].filter(Boolean);
  const suppressed = [];
  const kept = [];

  lines.forEach((line, index) => {
    const turn = parsed[index];
    if (turn?.role === 'assistant' && turn.text) {
      previousAssistantTexts.push(turn.text);
      kept.push(line);
      return;
    }

    if (!turn || turn.role !== 'user' || !turn.text) {
      kept.push(line);
      return;
    }

    const promptLeak = findLikelyTranscriptionPromptLeak(turn.text, references);
    if (promptLeak) {
      suppressed.push({ reason: 'transcription_prompt_leak', text: turn.text, ...promptLeak });
      return;
    }

    const assistantEcho = previousAssistantTexts.find((assistantText) =>
      isLikelyAssistantEcho(turn.text, assistantText)
    );
    if (assistantEcho) {
      suppressed.push({
        reason: 'assistant_echo',
        text: turn.text,
        similarity: spokenTextSimilarity(turn.text, assistantEcho),
      });
      return;
    }

    kept.push(line);
  });

  return {
    text: kept.join('\n').trim(),
    suppressed,
  };
}

module.exports = {
  buildCanonicalTranscript,
  findLikelyTranscriptionPromptLeak,
  formatDiarizedTranscript,
  indexRawTranscript,
  isLikelyAssistantEcho,
  normalizeTranscriptComparison,
  sanitizeRealtimeTranscript,
  spokenTextSimilarity,
};

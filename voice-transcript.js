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

function sanitizeRealtimeTranscript(rawLog, callInfo = {}) {
  const lines = String(rawLog || '').split(/\r?\n/);
  const parsed = lines.map(parseTranscriptLine);
  const assistantTexts = parsed
      .filter((turn) => turn?.role === 'assistant' && turn.text)
      .map((turn) => turn.text);
  const references = [
    callInfo.greetingText,
    callInfo.instructions,
    callInfo.transcriptionPrompt,
  ].filter(Boolean);
  const suppressed = [];
  const kept = [];

  lines.forEach((line, index) => {
    const turn = parsed[index];
    if (!turn || turn.role !== 'user' || !turn.text) {
      kept.push(line);
      return;
    }

    const promptLeak = findLikelyTranscriptionPromptLeak(turn.text, references);
    if (promptLeak) {
      suppressed.push({ reason: 'transcription_prompt_leak', text: turn.text, ...promptLeak });
      return;
    }

    const assistantEcho = assistantTexts.find((assistantText) => isLikelyAssistantEcho(turn.text, assistantText));
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
  findLikelyTranscriptionPromptLeak,
  isLikelyAssistantEcho,
  normalizeTranscriptComparison,
  sanitizeRealtimeTranscript,
  spokenTextSimilarity,
};

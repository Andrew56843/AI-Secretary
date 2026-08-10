'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  findLikelyTranscriptionPromptLeak,
  sanitizeRealtimeTranscript,
} = require('../voice-transcript');

const collectorScenario = 'Здравствуйте, [имя]! Это Коллектор из компании Moibike. Я звоню вам по поводу задолженности за аренду самокатов в размере [сумма] рублей. Срок возврата денег истек вчера, и завтра мы планируем подать исковое заявление в суд. У вас есть 24 часа, чтобы погасить долг. Вы готовы сделать оплату? Если да, я отправлю вам смс с реквизитами для оплаты.';

const hallucinatedUserTurn = 'Здравствуйте, Алёша! Это Коллектор из компании Moibike. Я звоню вам по поводу задолженности за аренду самокатов в размере 2000 рублей. Срок возврата денег истек вчера, и завтра мы планируем подать исковое заявление в суд. У вас есть 24 часа, чтобы погасить долг. Вы готовы сделать оплату? Если да, я отправлю вам смс с реквизитами для оплаты.';

test('detects a long ASR hallucination copied from the assistant scenario', () => {
  const match = findLikelyTranscriptionPromptLeak(hallucinatedUserTurn, [collectorScenario]);

  assert.ok(match);
  assert.ok(match.coverage > 0.95);
  assert.ok(match.similarity > 0.9);
});

test('keeps short and unrelated real caller answers', () => {
  assert.equal(findLikelyTranscriptionPromptLeak('Да.', [collectorScenario]), null);
  assert.equal(
      findLikelyTranscriptionPromptLeak('Мне сказали пять тысяч, я не согласен.', [collectorScenario]),
      null
  );
});

test('removes scenario leaks and assistant echoes before post-call processing', () => {
  const rawLog = [
    'Assi: Здравствуйте! Это MoiBike Коллектор!',
    `User: ${hallucinatedUserTurn}`,
    'Assi: Имран, это MoiBike Коллектор, удобно говорить?',
    'User: Да.',
    'User: Имран, это MoiBike Коллектор, удобно говорить?',
    'User: Мне сказали пять тысяч, я не согласен.',
  ].join('\n');

  const result = sanitizeRealtimeTranscript(rawLog, { instructions: collectorScenario });

  assert.equal(result.suppressed.length, 2);
  assert.match(result.text, /User: Да\./);
  assert.match(result.text, /User: Мне сказали пять тысяч, я не согласен\./);
  assert.doesNotMatch(result.text, /Алёша/);
  assert.equal(result.text.match(/Имран, это MoiBike Коллектор, удобно говорить\?/g)?.length, 1);
});

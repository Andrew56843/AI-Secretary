'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildCanonicalTranscript,
  findLikelyTranscriptionPromptLeak,
  formatDiarizedTranscript,
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

test('keeps caller intent that resembles a later assistant confirmation', () => {
  const rawLog = [
    'Assi: Какую услугу хотите?',
    'User: Отмените запись на 11:45.',
    'Assi: Запись перенесена на 11:45.',
  ].join('\n');

  const result = sanitizeRealtimeTranscript(rawLog);

  assert.equal(result.suppressed.length, 0);
  assert.match(result.text, /User: Отмените запись на 11:45\./);
});

test('maps diarized speakers to exact assistant and caller roles', () => {
  const rawLog = [
    'Assi: Здравствуйте! Я секретарь салона. Хотите записаться?',
    'User: Да, хочу.',
    'Assi: На какое время вас записать?',
    'User: На восемнадцать часов.'
  ].join('\n');
  const diarized = formatDiarizedTranscript([
    { start: 0, end: 3.2, speaker: 'A', text: 'Здравствуйте, я секретарь салона, хотите записаться?' },
    { start: 3.5, end: 4.1, speaker: 'B', text: 'Да, хочу.' },
    { start: 4.4, end: 6.2, speaker: 'A', text: 'На какое время вас записать?' },
    { start: 6.5, end: 7.8, speaker: 'B', text: 'На восемнадцать часов.' }
  ], rawLog);

  assert.equal(diarized.assistantSpeaker, 'A');
  assert.ok(diarized.assistantScore > 0.7);
  assert.match(diarized.text, /Assi: Здравствуйте/);
  assert.match(diarized.text, /User: Да, хочу\./);
  assert.match(diarized.text, /\[00:06\.5-00:07\.8\]/);
});

test('builds the final transcript without allowing assistant text to be rewritten', () => {
  const rawLog = [
    'Assi: Назовите точное время.',
    'User: На пятнадцать.',
    'Assi: Запись сделана на 15:30.',
    'User: Нет, я сказал девятнадцать ноль ноль.',
    'Assi: Хотите перенести запись?',
    'User: Тогда на восемнадцать.'
  ].join('\n');
  const correction = JSON.stringify({
    userTurns: [
      { afterAssistantIndex: 1, text: 'На 19:00.' },
      { afterAssistantIndex: 2, text: 'Нет, я сказал 19:00.' },
      { afterAssistantIndex: 3, text: 'Тогда на 18:00.' }
    ]
  });

  const result = buildCanonicalTranscript(rawLog, correction);

  assert.match(result, /^Assi: Назовите точное время\./);
  assert.match(result, /Assi: Запись сделана на 15:30\./);
  assert.match(result, /User: Нет, я сказал 19:00\./);
  assert.equal(result.match(/^Assi:/gm)?.length, 3);
  assert.equal(result.match(/^User:/gm)?.length, 3);
});

test('rejects a correction that removes every caller turn', () => {
  assert.throws(
      () => buildCanonicalTranscript('Assi: Здравствуйте.\nUser: Алло.', '{"userTurns":[]}'),
      /removed every caller turn/
  );
});

test('rejects a correction that drops most of the caller-only evidence', () => {
  const rawLog = [
    'Assi: Как вас зовут?',
    'User: Добрый.',
    'Assi: На какое время?',
    'User: На пятнадцать.'
  ].join('\n');
  const correction = JSON.stringify({
    userTurns: [{ afterAssistantIndex: 1, text: 'Андрей.' }]
  });

  assert.throws(
      () => buildCanonicalTranscript(
        rawLog,
        correction,
        'Андрей. Я сказал девятнадцать ноль ноль. Тогда давайте на восемнадцать ноль ноль.'
      ),
      /covers only/
  );
});

test('accepts a complete correction when spoken time is normalized to digits', () => {
  const rawLog = [
    'Assi: Как вас зовут?',
    'User: Добрый.',
    'Assi: На какое время?',
    'User: На пятнадцать.'
  ].join('\n');
  const correction = JSON.stringify({
    userTurns: [
      { afterAssistantIndex: 1, text: 'Меня зовут Андрей.' },
      { afterAssistantIndex: 2, text: 'Я сказал на 19:00, давайте на 18:00.' }
    ]
  });

  assert.doesNotThrow(() => buildCanonicalTranscript(
    rawLog,
    correction,
    'Меня зовут Андрей. Я сказал девятнадцать ноль ноль, давайте на восемнадцать ноль ноль.'
  ));
});

import assert from "node:assert/strict";
import test from "node:test";
import { CallDirection } from "@prisma/client";
import { createProfileTranscriptionPrompt, extractTranscriptionHints } from "./transcription-context.js";

test("keeps scenario-specific services, names and prices", () => {
  const context = createProfileTranscriptionPrompt({
    mode: CallDirection.INBOUND,
    title: "Парикмахерская Катюша",
    businessName: "Катюша",
    prompt: "Мужская стрижка — 800 рублей. Женская стрижка — 1200 рублей. Детская стрижка — 600 рублей."
  });

  assert.match(context, /Мужская/u);
  assert.match(context, /Женская/u);
  assert.match(context, /Детская/u);
  assert.match(context, /800/u);
  assert.match(context, /1200/u);
});

test("prioritizes repeated domain terms without hard-coded industries", () => {
  const hints = extractTranscriptionHints(
    "Запишите клиента. Керамические виниры стоят 45000 рублей. Виниры устанавливает доктор Артамонов. Виниры доступны по записи."
  );

  assert.match(hints, /виниры/iu);
  assert.match(hints, /45000/u);
  assert.match(hints, /Артамонов/u);
  assert.doesNotMatch(hints, /клиента/u);
});

test("keeps the realtime transcription prompt within the API limit", () => {
  const context = createProfileTranscriptionPrompt({
    mode: CallDirection.OUTBOUND,
    title: "Исходящий сценарий",
    businessName: "Компания",
    prompt: Array.from({ length: 500 }, (_, index) => `Термин${index}`).join(" ")
  });

  assert.ok(context.length <= 1024);
});

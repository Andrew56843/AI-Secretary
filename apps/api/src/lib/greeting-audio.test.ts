import assert from "node:assert/strict";
import test from "node:test";
import { createGreetingAudioCacheKey } from "./greeting-audio.js";

test("greeting audio cache changes with text, voice, or model", () => {
  const base = createGreetingAudioCacheKey("Здравствуйте!", "alloy", "tts-model");

  assert.equal(base, createGreetingAudioCacheKey(" Здравствуйте! ", "ALLOY", "tts-model"));
  assert.notEqual(base, createGreetingAudioCacheKey("Добрый день!", "alloy", "tts-model"));
  assert.notEqual(base, createGreetingAudioCacheKey("Здравствуйте!", "cedar", "tts-model"));
  assert.notEqual(base, createGreetingAudioCacheKey("Здравствуйте!", "alloy", "tts-model-2"));
});

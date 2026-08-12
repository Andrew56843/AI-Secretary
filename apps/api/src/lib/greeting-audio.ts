import { createHash } from "node:crypto";
import { env } from "../config.js";
import { postOpenAiBinary } from "./openai.js";

const MAX_GREETING_PCM_BYTES = 4_800_000;

export function createGreetingAudioCacheKey(text: string, voice: string, model = env.OPENAI_TTS_MODEL) {
  return createHash("sha256")
    .update(JSON.stringify({ text: text.trim(), voice: voice.trim().toLowerCase(), model }))
    .digest("hex");
}

export async function generateGreetingAudioPcm24(text: string, voice: string) {
  const pcm24 = await postOpenAiBinary("/audio/speech", {
    model: env.OPENAI_TTS_MODEL,
    voice,
    input: text.trim(),
    instructions: "Speak naturally in Russian as a calm telephone AI secretary. Keep the wording exact.",
    response_format: "pcm"
  });

  if (pcm24.length < 2 || pcm24.length % 2 !== 0 || pcm24.length > MAX_GREETING_PCM_BYTES) {
    throw new Error(`OpenAI returned invalid greeting PCM (${pcm24.length} bytes)`);
  }

  return {
    cacheKey: createGreetingAudioCacheKey(text, voice),
    model: env.OPENAI_TTS_MODEL,
    voice,
    pcm24: Uint8Array.from(pcm24)
  };
}

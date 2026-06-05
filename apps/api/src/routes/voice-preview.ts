import https from "node:https";
import { Router } from "express";
import { SocksProxyAgent } from "socks-proxy-agent";
import { z } from "zod";
import { env } from "../config.js";
import { requireAuth } from "../middleware/require-auth.js";

const voicePreviewRouter = Router();

const voiceSchema = z.enum(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);

const previewSchema = z.object({
  voice: voiceSchema,
  text: z.string().trim().min(1).max(320).optional()
});

const DEFAULT_PREVIEW_TEXT =
  "Здравствуйте! Я AI секретарь. Отвечу на звонок, уточню детали и аккуратно передам итог владельцу.";
const PREVIEW_INSTRUCTIONS =
  "Говори по-русски естественно, тепло и уверенно. Темп спокойный, интонация живого телефонного секретаря.";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const previewCache = new Map<string, { audio: Buffer; createdAt: number }>();

function createOpenAiSpeech(payload: { voice: z.infer<typeof voiceSchema>; text: string }) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_NOT_CONFIGURED");
  }

  const requestBody = JSON.stringify({
    model: env.OPENAI_TTS_MODEL,
    voice: payload.voice,
    input: payload.text,
    instructions: PREVIEW_INSTRUCTIONS,
    response_format: "mp3"
  });

  return new Promise<Buffer>((resolve, reject) => {
    const request = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/audio/speech",
        method: "POST",
        agent: env.OPENAI_PROXY_URL ? new SocksProxyAgent(env.OPENAI_PROXY_URL) : undefined,
        timeout: 30_000,
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          const statusCode = response.statusCode ?? 500;

          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`OpenAI speech failed with HTTP ${statusCode}: ${body.toString("utf8").slice(0, 300)}`));
            return;
          }

          resolve(body);
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("OpenAI speech request timed out"));
    });
    request.on("error", reject);
    request.write(requestBody);
    request.end();
  });
}

voicePreviewRouter.post("/", requireAuth, async (req, res) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const text = parsed.data.text || DEFAULT_PREVIEW_TEXT;
  const cacheKey = `${env.OPENAI_TTS_MODEL}:${parsed.data.voice}:${text}`;
  const cached = previewCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(cached.audio);
    return;
  }

  try {
    const audio = await createOpenAiSpeech({ voice: parsed.data.voice, text });
    previewCache.set(cacheKey, { audio, createdAt: Date.now() });
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(audio);
  } catch (error) {
    if (error instanceof Error && error.message === "OPENAI_NOT_CONFIGURED") {
      res.status(503).json({ message: "OpenAI voice preview is not configured" });
      return;
    }

    console.error(error);
    res.status(502).json({ message: "OpenAI voice preview failed" });
  }
});

export { voicePreviewRouter };

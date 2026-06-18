require('dotenv').config();

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { exec } = require('child_process');
const WebSocket = require('ws');

const { SocksProxyAgent } = require('socks-proxy-agent');

const CONFIG = {
  audioSocketHost: process.env.AUDIOSOCKET_HOST || '127.0.0.1',
  audioSocketPort: Number(process.env.AUDIOSOCKET_PORT || 9019),

  forwardAfterMs: Number(process.env.FORWARD_AFTER_MS || 180000),
  forwardContext: process.env.FORWARD_CONTEXT || 'from-ai-forward',

  metadataHost: process.env.METADATA_HOST || '127.0.0.1',
  forceBargeInPcmThreshold: Number(process.env.FORCE_BARGE_IN_PCM_THRESHOLD || 300),
  metadataPort: Number(process.env.METADATA_PORT || 9020),
  metadataToken: process.env.METADATA_TOKEN || 'change-me',

  openAiApiKey: process.env.OPENAI_API_KEY || '',
  openAiProxyUrl: process.env.OPENAI_PROXY_URL || process.env.SOCKS_PROXY_URL || '',
  realtimeModel: process.env.REALTIME_MODEL || 'gpt-realtime-2',//
  //realtimeModel: process.env.REALTIME_MODEL || 'gpt-realtime-mini',
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || 'hpp4J3VqNfWAUOO0d1Us', // Bella
  elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
  elevenLabsOutputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT || 'pcm_16000',
  elevenLabsStreaming: String(process.env.ELEVENLABS_STREAMING || 'true') === 'true',
  elevenLabsTimeoutMs: Number(process.env.ELEVENLABS_TIMEOUT_MS || 15000),
  elevenLabsStability: Number(process.env.ELEVENLABS_STABILITY || 0.45),
  elevenLabsSimilarityBoost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.8),
  elevenLabsStyle: Number(process.env.ELEVENLABS_STYLE || 0.35),
  elevenLabsSpeed: Number(process.env.ELEVENLABS_SPEED || 1),
  elevenLabsSpeakerBoost: String(process.env.ELEVENLABS_SPEAKER_BOOST || 'true') === 'true',
  openAiTextOnlyWithElevenLabs: String(process.env.OPENAI_TEXT_ONLY_WITH_ELEVENLABS || 'true') === 'true',
  defaultForwardPhone: process.env.DEFAULT_FORWARD_PHONE || process.env.FORWARD_PHONE || '',

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  autoGreeting: String(process.env.AUTO_GREETING || 'true') === 'true',
  recordsDir: process.env.RECORDS_DIR || path.join(process.cwd(), 'records'),
  clientsConfigPath: process.env.CLIENTS_CONFIG_PATH || path.join(process.cwd(), 'clients.json'),

  keepMetadataMs: Number(process.env.KEEP_METADATA_MS || 30 * 60 * 1000),
  maxResponseOutputTokens: Number(process.env.MAX_RESPONSE_OUTPUT_TOKENS || 400),

  inputSampleRate: 8000,
  modelSampleRate: 24000,
  inputPcmGain: Number(process.env.INPUT_PCM_GAIN || 1.4),
  asteriskFrameBytes: 320, // 20ms @ 8kHz mono s16le
  asteriskFrameMs: 20,
  outboundStartBufferFrames: Number(process.env.OUTBOUND_START_BUFFER_FRAMES || 13),
  outboundResumeBufferFrames: Number(process.env.OUTBOUND_RESUME_BUFFER_FRAMES || 6),
  outboundSendFramesPerTick: Number(process.env.OUTBOUND_SEND_FRAMES_PER_TICK || 2),
  outboundPcmGain: Number(process.env.OUTBOUND_PCM_GAIN || 0.9),
  outboundLowpass: String(process.env.OUTBOUND_LOWPASS || 'true') === 'true',
  ttsEdgeFadeMs: Number(process.env.TTS_EDGE_FADE_MS || 8),

  vadThreshold: Number(process.env.VAD_THRESHOLD || 0.55),
  vadSilenceMs: Number(process.env.VAD_SILENCE_MS || 450),
  vadPrefixMs: Number(process.env.VAD_PREFIX_MS || 300),
  bargeInEchoGuardMs: Number(process.env.BARGE_IN_ECHO_GUARD_MS || 250),

  noiseReductionType: process.env.NOISE_REDUCTION_TYPE || 'near_field',
  wsHandshakeTimeoutMs: Number(process.env.WS_HANDSHAKE_TIMEOUT_MS || 10000),
  wsCloseAfterNoSessionMs: Number(process.env.WS_CLOSE_AFTER_NO_SESSION_MS || 15000),

  defaultVoice: process.env.DEFAULT_VOICE || 'marin',
  defaultLanguage: process.env.DEFAULT_LANGUAGE || 'ru',

  recordAssistantWav: String(process.env.RECORD_ASSISTANT_WAV || 'false') === 'true',
  recordTalkWav: String(process.env.RECORD_TALK_WAV || 'true') === 'true',
  postCallLogEnabled: String(process.env.POST_CALL_LOG_ENABLED || 'true') === 'true',
  postCallLogModel: process.env.POST_CALL_LOG_MODEL || 'gpt-4o-mini',
  postCallLogTimeoutMs: Number(process.env.POST_CALL_LOG_TIMEOUT_MS || 45_000),
  postCallLogMaxChars: Number(process.env.POST_CALL_LOG_MAX_CHARS || 20_000),
};

if (!CONFIG.openAiApiKey) {
  console.warn('[BOOT] OPENAI_API_KEY is empty. Realtime will not work until it is set.');
}

if (!CONFIG.openAiProxyUrl) {
  console.warn('[BOOT] OPENAI_PROXY_URL is empty. Realtime traffic will not be opened without proxy.');
}

if (!CONFIG.telegramBotToken) {
  console.warn('[BOOT] TELEGRAM_BOT_TOKEN is empty. Call summaries will not be sent.');
} else if (!CONFIG.telegramChatId) {
  console.warn('[BOOT] TELEGRAM_CHAT_ID is empty. Only linked account chat ids will receive call summaries.');
}

const proxyAgent = CONFIG.openAiProxyUrl
    ? new SocksProxyAgent(CONFIG.openAiProxyUrl)
    : null;
const useElevenLabsTts = Boolean(CONFIG.elevenLabsApiKey && CONFIG.elevenLabsVoiceId);
const useOpenAiTextOnly = Boolean(useElevenLabsTts && CONFIG.openAiTextOnlyWithElevenLabs);

if (CONFIG.elevenLabsApiKey && !CONFIG.elevenLabsVoiceId) {
  console.warn('[BOOT] ELEVENLABS_API_KEY is set but ELEVENLABS_VOICE_ID is empty. ElevenLabs TTS is disabled.');
}
if (useElevenLabsTts && !proxyAgent) {
  console.warn('[BOOT] ElevenLabs TTS requested but OPENAI_PROXY_URL is empty; ElevenLabs requests will fail.');
}

fs.mkdirSync(CONFIG.recordsDir, { recursive: true });

// AudioSocket protocol
const TYPE_TERMINATE = 0x00;
const TYPE_UUID = 0x01;
const TYPE_DTMF = 0x03;
const TYPE_PCM_8K = 0x10;

function nowIso() {
  return new Date().toISOString();
}

function ts() {
  return Date.now();
}

async function tgFetch(method, params = {}) {
  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/${method}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return r.json();
}
async function sendTelegramDocument(chatId, text, fileName = 'call-transcript.txt') {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', 'call end\nТранскрипт во вложении.');
  form.append('document', new Blob([String(text || '')], { type: 'text/plain;charset=utf-8' }), fileName);

  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendDocument`;
  const response = await fetch(url, {
    method: 'POST',
    body: form,
  });
  return response.json();
}

async function sendTelegram(text, chatId = CONFIG.telegramChatId, fileName = 'call-transcript.txt') {
  if (!CONFIG.telegramBotToken || !chatId) return;

  try {
    const clean = String(text || '');
    if (clean.length <= 3900) {
      await tgFetch("sendMessage", {
        chat_id: chatId,
        text: clean,
      });
      return;
    }

    await sendTelegramDocument(chatId, clean, fileName);
  } catch (e) {
    console.log("TG send error:", String(e?.message || e));
  }
}

function getTelegramTargetFromConfig(clientCfg) {
  const telegram = clientCfg?.account?.telegram || null;
  if (telegram?.chatId) return String(telegram.chatId);
  if (telegram?.username) {
    const username = String(telegram.username);
    return username.startsWith('@') ? username : `@${username}`;
  }
  return CONFIG.telegramChatId || '';
}

function splitTelegramText(text, limit = 3900) {
  const src = String(text || '');
  if (src.length <= limit) return [src];

  const chunks = [];
  let rest = src;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function openAiPostJson(apiPath, body, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.openAiApiKey) {
      reject(new Error('OPENAI_API_KEY is empty'));
      return;
    }
    if (!proxyAgent) {
      reject(new Error('OPENAI_PROXY_URL is empty; refusing post-call OpenAI request without proxy'));
      return;
    }

    const payload = JSON.stringify(body);
    const req = https.request(
        {
          hostname: 'api.openai.com',
          path: apiPath,
          method: 'POST',
          agent: proxyAgent,
          timeout: timeoutMs,
          headers: {
            Authorization: `Bearer ${CONFIG.openAiApiKey}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = text ? JSON.parse(text) : {};
            } catch {
              reject(new Error(`OpenAI returned non-JSON response: ${text.slice(0, 300)}`));
              return;
            }

            if (res.statusCode < 200 || res.statusCode >= 300) {
              const msg = json?.error?.message || text.slice(0, 300) || `HTTP ${res.statusCode}`;
              reject(new Error(`OpenAI post-call request failed: ${msg}`));
              return;
            }

            resolve(json);
          });
        }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`OpenAI post-call request timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function clampUnit(v, fallback = 0) {
  if (!Number.isFinite(v)) return fallback;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function russianPlural(n, one, few, many) {
  const abs = Math.abs(n);
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function russianUnderThousandToWords(n, gender = 'm') {
  const masculineUnits = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const feminineUnits = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const teens = [
    'десять',
    'одиннадцать',
    'двенадцать',
    'тринадцать',
    'четырнадцать',
    'пятнадцать',
    'шестнадцать',
    'семнадцать',
    'восемнадцать',
    'девятнадцать',
  ];
  const tens = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
  const hundreds = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
  const units = gender === 'f' ? feminineUnits : masculineUnits;
  const parts = [];

  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(hundreds[h]);

  if (rest >= 10 && rest <= 19) {
    parts.push(teens[rest - 10]);
  } else {
    const t = Math.floor(rest / 10);
    const u = rest % 10;
    if (t) parts.push(tens[t]);
    if (u) parts.push(units[u]);
  }

  return parts.join(' ');
}

function russianIntegerToWords(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return String(n);
  const rounded = Math.trunc(Math.abs(value));
  if (rounded === 0) return 'ноль';
  if (rounded > 999999) return spellDigits(String(rounded));

  const parts = [];
  const thousands = Math.floor(rounded / 1000);
  const rest = rounded % 1000;

  if (thousands) {
    parts.push(russianUnderThousandToWords(thousands, 'f'));
    parts.push(russianPlural(thousands, 'тысяча', 'тысячи', 'тысяч'));
  }
  if (rest) parts.push(russianUnderThousandToWords(rest, 'm'));

  return parts.join(' ');
}

function spellDigits(value) {
  const digitWords = {
    '0': 'ноль',
    '1': 'один',
    '2': 'два',
    '3': 'три',
    '4': 'четыре',
    '5': 'пять',
    '6': 'шесть',
    '7': 'семь',
    '8': 'восемь',
    '9': 'девять',
  };
  return String(value || '')
      .split('')
      .map((ch) => digitWords[ch] || ch)
      .join(', ');
}

function russianLetterName(letter) {
  const names = {
    А: 'а',
    Б: 'бэ',
    В: 'вэ',
    Г: 'гэ',
    Д: 'дэ',
    Е: 'е',
    Ж: 'жэ',
    З: 'зэ',
    И: 'и',
    Й: 'и краткое',
    К: 'ка',
    Л: 'эль',
    М: 'эм',
    Н: 'эн',
    О: 'о',
    П: 'пэ',
    Р: 'эр',
    С: 'эс',
    Т: 'тэ',
    У: 'у',
    Ф: 'эф',
    Х: 'ха',
    Ц: 'цэ',
    Ч: 'че',
    Ш: 'ша',
    Щ: 'ща',
    Э: 'э',
    Ю: 'ю',
    Я: 'я',
  };
  return names[String(letter || '').toUpperCase()] || String(letter || '');
}

function normalizeElevenLabsNumbersForSpeech(text) {
  return String(text || '')
      .replace(/\b(\d{1,4})([А-ЯЁа-яё])\b/gu, (_, n, letter) => (
        `${russianIntegerToWords(n)} ${russianLetterName(letter)}`
      ))
      .replace(/\b\d{5,}\b/g, (n) => spellDigits(n))
      .replace(/\b\d{1,4}\b/g, (n) => russianIntegerToWords(n));
}

function isElevenLabsUlaw8k() {
  return String(CONFIG.elevenLabsOutputFormat || '').toLowerCase().startsWith('ulaw_8000');
}

function ulawByteToPcm16(byte) {
  const u = (~byte) & 0xff;
  let sample = ((u & 0x0f) << 3) + 0x84;
  sample <<= (u & 0x70) >> 4;
  sample = (u & 0x80) ? (0x84 - sample) : (sample - 0x84);
  return clampPcm16(sample);
}

function decodeUlaw8kToPcm16(buf) {
  if (!buf?.length) return Buffer.alloc(0);
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i += 1) {
    out.writeInt16LE(ulawByteToPcm16(buf[i]), i * 2);
  }
  return out;
}

function applyElevenLabsPronunciationHints(text) {
  return String(text || '')
      .replace(/Echte Doner/giu, 'Эхте Дё\u0301нер')
      .replace(/ии оператор/giu, 'ай-ай оператор')
      .replace(/самовывоз/giu, 'самовы\u0301воз')
      .replace(/Пушкина/giu, 'Пу\u0301шкина')
      .replace(/Кулакова/giu, 'Кулако\u0301ва')
      .replace(/Дюрюм/giu, 'Дю\u0301рюм')
      .replace(/Дёнер/giu, 'Дё\u0301нер')
      .replace(/Скепасти/giu, 'Скепа\u0301сти')
      .replace(/Теллер/giu, 'Те\u0301ллер')
      .replace(/Гирос/giu, 'Ги\u0301рос')
      .replace(/Айран/giu, 'Айра\u0301н')
      .replace(/морс/giu, 'мо\u0301рс')
      .replace(/Добрый Кола/giu, 'До\u0301брый Ко\u0301ла');
}

function buildElevenLabsTtsBody(text, languageCode = null) {
  const body = {
    text: String(text || ''),
    model_id: CONFIG.elevenLabsModelId,
    voice_settings: {
        stability: clampUnit(CONFIG.elevenLabsStability, 0.45),
        similarity_boost: clampUnit(CONFIG.elevenLabsSimilarityBoost, 0.8),
        style: clampUnit(CONFIG.elevenLabsStyle, 0.35),
        speed: Number.isFinite(CONFIG.elevenLabsSpeed) && CONFIG.elevenLabsSpeed > 0
            ? CONFIG.elevenLabsSpeed
            : 1,
        use_speaker_boost: !!CONFIG.elevenLabsSpeakerBoost,
      },
  };
  if (languageCode) {
    body.language_code = String(languageCode);
  }
  return body;
}

function elevenLabsSynthesizePcm16k(text, languageCode = null) {
  return new Promise((resolve, reject) => {
    if (!useElevenLabsTts) {
      reject(new Error('ElevenLabs TTS is disabled'));
      return;
    }
    if (!proxyAgent) {
      reject(new Error('OPENAI_PROXY_URL is empty; refusing ElevenLabs TTS without proxy'));
      return;
    }

    const payload = JSON.stringify(buildElevenLabsTtsBody(text, languageCode));
    const pathWithQuery =
        `/v1/text-to-speech/${encodeURIComponent(CONFIG.elevenLabsVoiceId)}` +
        `?output_format=${encodeURIComponent(CONFIG.elevenLabsOutputFormat)}`;

    const req = https.request(
        {
          hostname: 'api.elevenlabs.io',
          path: pathWithQuery,
          method: 'POST',
          agent: proxyAgent,
          timeout: CONFIG.elevenLabsTimeoutMs,
          headers: {
            'xi-api-key': CONFIG.elevenLabsApiKey,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const audio = Buffer.concat(chunks);
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const snippet = audio.toString('utf8').slice(0, 300);
              reject(new Error(`ElevenLabs TTS failed HTTP ${res.statusCode}: ${snippet}`));
              return;
            }
            if (!audio.length) {
              reject(new Error('ElevenLabs TTS returned empty audio payload'));
              return;
            }
            resolve(audio);
          });
        }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`ElevenLabs TTS timeout after ${CONFIG.elevenLabsTimeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function elevenLabsStreamPcm16k(text, languageCode = null, onChunk = () => {}) {
  return new Promise((resolve, reject) => {
    if (!useElevenLabsTts) {
      reject(new Error('ElevenLabs TTS is disabled'));
      return;
    }
    if (!proxyAgent) {
      reject(new Error('OPENAI_PROXY_URL is empty; refusing ElevenLabs TTS without proxy'));
      return;
    }

    const payload = JSON.stringify(buildElevenLabsTtsBody(text, languageCode));
    const pathWithQuery =
        `/v1/text-to-speech/${encodeURIComponent(CONFIG.elevenLabsVoiceId)}/stream` +
        `?output_format=${encodeURIComponent(CONFIG.elevenLabsOutputFormat)}`;

    const req = https.request(
        {
          hostname: 'api.elevenlabs.io',
          path: pathWithQuery,
          method: 'POST',
          agent: proxyAgent,
          timeout: CONFIG.elevenLabsTimeoutMs,
          headers: {
            'xi-api-key': CONFIG.elevenLabsApiKey,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              const snippet = Buffer.concat(chunks).toString('utf8').slice(0, 300);
              reject(new Error(`ElevenLabs stream failed HTTP ${res.statusCode}: ${snippet}`));
            });
            return;
          }

          let totalBytes = 0;
          let settled = false;

          const failOnce = (err) => {
            if (settled) return;
            settled = true;
            reject(err instanceof Error ? err : new Error(String(err || 'unknown error')));
          };

          res.on('data', (chunk) => {
            if (!chunk?.length) return;
            totalBytes += chunk.length;
            try {
              onChunk(chunk);
            } catch (err) {
              failOnce(err);
              req.destroy();
            }
          });

          res.on('error', failOnce);
          res.on('end', () => {
            if (settled) return;
            if (!totalBytes) {
              failOnce(new Error('ElevenLabs stream returned empty audio payload'));
              return;
            }
            settled = true;
            resolve(totalBytes);
          });
        }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`ElevenLabs TTS stream timeout after ${CONFIG.elevenLabsTimeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function log(scope, msg, extra) {
  if (extra === undefined) console.log(`${nowIso()} ${scope} ${msg}`);
  else console.log(`${nowIso()} ${scope} ${msg}`, extra);
}

function logErr(scope, msg, extra) {
  if (extra === undefined) console.error(`${nowIso()} ${scope} ${msg}`);
  else console.error(`${nowIso()} ${scope} ${msg}`, extra);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(v) {
  return String(v || '')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'unknown';
}

function normalizeForwardPhone(v) {
  return String(v || '').replace(/\D+/g, '').slice(0, 20);
}

function shellQuote(v) {
  return "'" + String(v).replace(/'/g, "'\\''") + "'";
}

function normalizeUuid(v) {
  return String(v || '')
      .trim()
      .toLowerCase()
      .replace(/-/g, '');
}

function makeHeader(type, length) {
  const h = Buffer.alloc(3);
  h.writeUInt8(type, 0);
  h.writeUInt16BE(length, 1);
  return h;
}

function makeFrame(type, payload = Buffer.alloc(0)) {
  return Buffer.concat([makeHeader(type, payload.length), payload]);
}

function splitBuffer(buf, size) {
  const out = [];
  for (let i = 0; i < buf.length; i += size) {
    out.push(buf.subarray(i, Math.min(i + size, buf.length)));
  }
  return out;
}

// ---------- WAV helpers ----------

function writeWavHeader(fd, dataBytes, sampleRate = 8000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);

  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);

  fs.writeSync(fd, header, 0, header.length, 0);
}

function patchWavHeader(fd, dataBytes, sampleRate = 8000, channels = 1) {
  writeWavHeader(fd, dataBytes, sampleRate, channels, 16);
}

function openWav(filePath, sampleRate = 8000, channels = 1) {
  const fd = fs.openSync(filePath, 'w+');
  writeWavHeader(fd, 0, sampleRate, channels, 16);
  return { fd, filePath, bytes: 0, sampleRate, channels };
}

function appendWav(wav, pcm) {
  if (!wav || wav.fd == null || !pcm?.length) return;
  fs.writeSync(wav.fd, pcm, 0, pcm.length, 44 + wav.bytes);
  wav.bytes += pcm.length;
}

function closeWav(wav) {
  if (!wav || wav.fd == null) return;
  patchWavHeader(wav.fd, wav.bytes, wav.sampleRate, wav.channels || 1);
  fs.closeSync(wav.fd);
  wav.fd = null;
}

function appendStereoPcm16Frame(wav, leftFrame, rightFrame, frameBytes) {
  if (!wav || wav.fd == null) return;
  const samples = frameBytes / 2;
  const out = Buffer.alloc(frameBytes * 2);

  for (let i = 0; i < samples; i += 1) {
    const src = i * 2;
    const dst = i * 4;
    const left = leftFrame && src + 1 < leftFrame.length ? leftFrame.readInt16LE(src) : 0;
    const right = rightFrame && src + 1 < rightFrame.length ? rightFrame.readInt16LE(src) : 0;
    out.writeInt16LE(left, dst);
    out.writeInt16LE(right, dst + 2);
  }

  appendWav(wav, out);
}

// ---------- JSON / files ----------

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

const POST_CALL_LOG_SYSTEM_PROMPT = `
Ты редактор транскрипта телефонного разговора ресторана Echte Doner.
На входе сырой realtime-лог с репликами "Assi:" и "User:".
Верни только очищенный лог в том же формате, без комментариев, без markdown.

Правила:
- Сохраняй порядок реплик.
- Реплики Assi сохраняй дословно или почти дословно, потому что это текст синтеза.
- Реплики User исправляй по контексту разговора, меню и здравому смыслу.
- Не выдумывай новые блюда, адреса, имена и номера.
- Если фразу невозможно восстановить уверенно, пиши: User: [неразборчиво]
- Если понятно только частично, оставь понятную часть и пометь сомнение скобками: [неразборчиво].
- Исправляй очевидные ошибки ASR: "Артамонов" -> "самовывоз", "Кукие" -> "Кулакова", "Эрам" -> "айран", "Доброе коло" -> "Добрый Кола", если это подтверждается контекстом.
- Слова домена: доставка, самовывоз, Пушкина 25, Кулакова 29Д, дёнер, Дюрюм Дёнер, картофель фри, картофель по-деревенски, Добрый Кола, фирменный морс, айран.
`.trim();

function buildPostCallLogUserPrompt(rawLog, callInfo = {}) {
  const clipped = String(rawLog || '').slice(0, CONFIG.postCallLogMaxChars);
  return [
    `DID: ${callInfo.did || '-'}`,
    `Caller: ${callInfo.callerId || '-'}`,
    '',
    'Сырой лог:',
    clipped || '[пустой лог]',
  ].join('\n');
}

async function buildProcessedCallLog(rawLog, callInfo = {}) {
  if (!CONFIG.postCallLogEnabled) return String(rawLog || '').trim();

  const response = await openAiPostJson('/v1/chat/completions', {
    model: CONFIG.postCallLogModel,
    temperature: 0,
    max_tokens: 2400,
    messages: [
      { role: 'system', content: POST_CALL_LOG_SYSTEM_PROMPT },
      { role: 'user', content: buildPostCallLogUserPrompt(rawLog, callInfo) },
    ],
  }, CONFIG.postCallLogTimeoutMs);

  const text = response?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI post-call log response is empty');
  return text;
}

function meanAbsPcm16(buf) {
  if (!buf || buf.length < 2) return 0;
  let sum = 0;
  const samples = Math.floor(buf.length / 2);
  for (let i = 0; i < samples; i++) {
    sum += Math.abs(buf.readInt16LE(i * 2));
  }
  return Math.round(sum / samples);
}

function clampPcm16(v) {
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v;
}

function applyPcm16Gain(buf, gain) {
  if (!buf?.length || !Number.isFinite(gain) || gain === 1) return buf;

  const out = Buffer.allocUnsafe(buf.length);
  const samples = Math.floor(buf.length / 2);
  for (let i = 0; i < samples; i++) {
    const v = buf.readInt16LE(i * 2);
    out.writeInt16LE(clampPcm16(Math.round(v * gain)), i * 2);
  }

  if (buf.length % 2) {
    out[out.length - 1] = buf[buf.length - 1];
  }

  return out;
}

function fadePcm16InPlace(buf, samples, fadeIn = true) {
  if (!buf?.length || samples <= 0) return buf;

  const totalSamples = Math.floor(buf.length / 2);
  const fadeSamples = Math.min(totalSamples, samples);
  if (fadeSamples <= 0) return buf;

  for (let i = 0; i < fadeSamples; i += 1) {
    const sampleIndex = fadeIn ? i : (totalSamples - fadeSamples + i);
    const offset = sampleIndex * 2;
    const factor = fadeIn
        ? (i + 1) / fadeSamples
        : (fadeSamples - i - 1) / fadeSamples;
    const v = buf.readInt16LE(offset);
    buf.writeInt16LE(clampPcm16(Math.round(v * factor)), offset);
  }

  return buf;
}

function createPcm8EdgeSmoother(sampleRate = 8000, fadeMs = 8) {
  const fadeSamples = Math.max(0, Math.round(sampleRate * Math.max(0, fadeMs) / 1000));
  const fadeBytes = fadeSamples * 2;
  let started = false;
  let tail = Buffer.alloc(0);

  return {
    push(pcm8) {
      if (!pcm8?.length && !tail.length) return Buffer.alloc(0);

      const input = tail.length
          ? Buffer.concat([tail, pcm8 || Buffer.alloc(0)])
          : Buffer.from(pcm8 || Buffer.alloc(0));

      if (!started) {
        fadePcm16InPlace(input, fadeSamples, true);
        started = true;
      }

      if (!fadeBytes || input.length <= fadeBytes) {
        tail = input;
        return Buffer.alloc(0);
      }

      const emitBytes = Math.floor((input.length - fadeBytes) / 2) * 2;
      const out = Buffer.from(input.subarray(0, emitBytes));
      tail = Buffer.from(input.subarray(emitBytes));
      return out;
    },

    finish() {
      if (!tail.length) return Buffer.alloc(0);

      const out = Buffer.from(tail);
      fadePcm16InPlace(out, fadeSamples, false);
      tail = Buffer.alloc(0);
      return out;
    },
  };
}

function createPcm8LowpassFir() {
  let hasPrevious = false;
  let previous = 0;

  return function lowpassPcm8(pcm8) {
    if (!pcm8?.length) return pcm8;

    const samples = Math.floor(pcm8.length / 2);
    if (samples <= 1) return pcm8;

    const out = Buffer.allocUnsafe(samples * 2);
    for (let i = 0; i < samples; i += 1) {
      const current = pcm8.readInt16LE(i * 2);
      const prev = i > 0
          ? pcm8.readInt16LE((i - 1) * 2)
          : (hasPrevious ? previous : current);
      const next = i + 1 < samples
          ? pcm8.readInt16LE((i + 1) * 2)
          : current;
      const filtered = Math.round((prev + 2 * current + next) / 4);
      out.writeInt16LE(clampPcm16(filtered), i * 2);
    }

    previous = pcm8.readInt16LE((samples - 1) * 2);
    hasPrevious = true;
    return out;
  };
}

// ---------- Resampling ----------

function downsample16kTo8k(pcm16k) {
  if (!pcm16k?.length) return Buffer.alloc(0);
  const inSamples = Math.floor(pcm16k.length / 2);
  const outSamples = Math.floor(inSamples / 2);
  if (outSamples <= 0) return Buffer.alloc(0);

  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const s1 = pcm16k.readInt16LE(i * 4);
    const s2 = pcm16k.readInt16LE(i * 4 + 2);
    out.writeInt16LE(clampPcm16(Math.round((s1 + s2) / 2)), i * 2);
  }
  return out;
}

// Streaming 16k -> 8k downsampler with carry, to avoid clicks on chunk boundaries.
function createDownsampler16kTo8k() {
  let carry = Buffer.alloc(0);

  return function downsample16kTo8kStream(pcm16kChunk) {
    if (!pcm16kChunk?.length && !carry.length) return Buffer.alloc(0);

    const input = carry.length
        ? Buffer.concat([carry, pcm16kChunk || Buffer.alloc(0)])
        : (pcm16kChunk || Buffer.alloc(0));

    const inSamples = Math.floor(input.length / 2);
    const usableSamples = Math.floor(inSamples / 2) * 2;
    const usableBytes = usableSamples * 2;

    carry = input.subarray(usableBytes);
    if (usableSamples <= 0) return Buffer.alloc(0);

    const outSamples = usableSamples / 2;
    const out = Buffer.alloc(outSamples * 2);
    for (let i = 0; i < outSamples; i += 1) {
      const s1 = input.readInt16LE(i * 4);
      const s2 = input.readInt16LE(i * 4 + 2);
      out.writeInt16LE(clampPcm16(Math.round((s1 + s2) / 2)), i * 2);
    }
    return out;
  };
}

// 8k -> 24k with lightweight linear interpolation for cleaner ASR input.
function upsample8kTo24k(pcm8) {
  const inSamples = Math.floor(pcm8.length / 2);
  const out = Buffer.alloc(inSamples * 2 * 3);

  let outOffset = 0;
  for (let i = 0; i < inSamples; i++) {
    const s0 = pcm8.readInt16LE(i * 2);
    const s1 = i + 1 < inSamples ? pcm8.readInt16LE((i + 1) * 2) : s0;

    out.writeInt16LE(s0, outOffset); outOffset += 2;
    out.writeInt16LE(clampPcm16(Math.round((2 * s0 + s1) / 3)), outOffset); outOffset += 2;
    out.writeInt16LE(clampPcm16(Math.round((s0 + 2 * s1) / 3)), outOffset); outOffset += 2;
  }
  return out;
}

// Streaming 24k -> 8k downsampler with carry, so remainder is not lost between deltas
function createDownsampler24kTo8k() {
  let carry = Buffer.alloc(0);

  return function downsample24kTo8kStream(pcm24) {
    if (!pcm24?.length && !carry.length) return Buffer.alloc(0);

    const input = carry.length
        ? Buffer.concat([carry, pcm24 || Buffer.alloc(0)])
        : (pcm24 || Buffer.alloc(0));

    const inSamples = Math.floor(input.length / 2);
    const usableSamples = Math.floor(inSamples / 3) * 3;
    const usableBytes = usableSamples * 2;

    carry = input.subarray(usableBytes);

    if (usableSamples <= 0) return Buffer.alloc(0);

    const outSamples = usableSamples / 3;
    const out = Buffer.alloc(outSamples * 2);

    let outIndex = 0;

    for (let i = 0; i < outSamples; i++) {
      const s1 = input.readInt16LE(i * 6);
      const s2 = input.readInt16LE(i * 6 + 2);
      const s3 = input.readInt16LE(i * 6 + 4);

      const avg = Math.round((s1 + s2 + s3) / 3);

      out.writeInt16LE(avg, outIndex);
      outIndex += 2;
    }

    return out;
  };
}

// ---------- Clients config ----------

let clientsConfigCache = null;
let clientsConfigMtimeMs = 0;

function defaultClientConfig() {
  return {
    clientId: 'default',
    clientName: 'Default',
    forwardPhone: CONFIG.defaultForwardPhone,
    language: CONFIG.defaultLanguage,
    voice: CONFIG.defaultVoice,
    autoGreeting: CONFIG.autoGreeting,
    greetingText: 'Коротко поприветствуй звонящего по-русски и спроси, чем помочь.',
    instructions:
        'Ты телефонный AI-секретарь. Всегда отвечай только по-русски. ' +
        'Говори кратко и по делу. ' +
        'Отвечай максимум 1-2 короткими предложениями. ' +
        'Не перечисляй длинные списки и не растягивай ответ. ' +
        'Если информации не хватает, честно скажи об этом и задай один короткий уточняющий вопрос. ' +
        'Если тебя перебивают, сразу переставай говорить и слушай. ' +
        'Если человек просит менеджера, скажи что зафиксируешь обращение.',
    transcriptionModel: 'gpt-4o-transcribe',
    maxResponseOutputTokens: CONFIG.maxResponseOutputTokens,
    turnDetection: {
      threshold: CONFIG.vadThreshold,
      silenceDurationMs: CONFIG.vadSilenceMs,
      prefixPaddingMs: CONFIG.vadPrefixMs,
    },
  };
}

function loadClientsConfig() {
  try {
    const stat = fs.statSync(CONFIG.clientsConfigPath);
    if (clientsConfigCache && stat.mtimeMs === clientsConfigMtimeMs) {
      return clientsConfigCache;
    }

    const parsed = JSON.parse(fs.readFileSync(CONFIG.clientsConfigPath, 'utf8'));
    clientsConfigCache = parsed;
    clientsConfigMtimeMs = stat.mtimeMs;
    log('[CFG]', `loaded ${path.basename(CONFIG.clientsConfigPath)}`);
    return clientsConfigCache;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logErr('[CFG]', `failed to load ${CONFIG.clientsConfigPath}: ${err.message}`);
    }
    clientsConfigCache = null;
    clientsConfigMtimeMs = 0;
    return null;
  }
}

function resolveClientConfig(meta) {
  const base = defaultClientConfig();
  const cfg = loadClientsConfig();
  if (!cfg) return base;

  const defaults = cfg.defaults || {};
  const didMap = cfg.didMap || {};
  const clientMap = cfg.clientMap || {};

  const byDid = meta?.did ? didMap[String(meta.did)] || null : null;
  const byClientId = meta?.clientId ? clientMap[String(meta.clientId)] || null : null;

  return {
    ...base,
    ...defaults,
    ...byClientId,
    ...byDid,
    turnDetection: {
      ...base.turnDetection,
      ...(defaults.turnDetection || {}),
      ...(byClientId?.turnDetection || {}),
      ...(byDid?.turnDetection || {}),
    },
  };
}

// ---------- Metadata registry ----------

const callRegistry = new Map();

function putCallMeta(meta) {
  const key = normalizeUuid(meta.uuid);
  if (!key) return false;

  callRegistry.set(key, {
    uuid: key,
    createdAt: ts(),
    updatedAt: ts(),
    did: meta.did ? String(meta.did) : null,
    callerId: meta.callerId ? String(meta.callerId) : null,
    clientId: meta.clientId ? String(meta.clientId) : null,
    channel: meta.channel ? String(meta.channel) : null,
    accountId: meta.accountId ? String(meta.accountId) : null,
    note: meta.note ? String(meta.note) : null,
    raw: meta,
  });
  return true;
}

function getCallMeta(uuid) {
  const m = callRegistry.get(normalizeUuid(uuid));
  if (!m) return null;
  m.updatedAt = ts();
  return m;
}

setInterval(() => {
  const cutoff = ts() - CONFIG.keepMetadataMs;
  for (const [key, value] of callRegistry.entries()) {
    if (value.updatedAt < cutoff) callRegistry.delete(key);
  }
}, 60_000).unref();

function tryParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(raw.replace(/\\,/g, ','));
    } catch {
      return JSON.parse(raw.replace(/\\/g, ''));
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(tryParseJson(raw));
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

// ---------- Metadata HTTP server ----------

const metadataServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: nowIso() }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/call/start') {
      const token = req.headers['x-metadata-token'];
      if (token !== CONFIG.metadataToken) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }

      const body = await readJsonBody(req);
      if (!putCallMeta(body)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'uuid required' }));
        return;
      }

      const saved = getCallMeta(body.uuid);
      log('[META]', `saved uuid=${saved?.uuid || '-'} did=${saved?.did || '-'} callerId=${saved?.callerId || '-'} clientId=${saved?.clientId || '-'}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/call/meta') {
      const uuid = url.searchParams.get('uuid');
      const meta = getCallMeta(uuid);
      res.writeHead(meta ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: !!meta, meta }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  } catch (err) {
    logErr('[META]', err.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
  }
});

metadataServer.listen(CONFIG.metadataPort, CONFIG.metadataHost, () => {
  log('[META]', `listening on ${CONFIG.metadataHost}:${CONFIG.metadataPort}`);
});

// ---------- OpenAI session builders ----------

const DEFAULT_TRANSCRIPTION_PROMPT = `
Телефонный разговор на русском языке с рестораном Echte Doner в Ставрополе.
Ожидаемые слова и фразы: доставка, самовывоз, оформить заказ, забрать заказ, Пушкина 25, Кулакова 29Д, Кулакова, сколько сейчас времени, до скольки работает.
Позиции меню: шаурма, дёнер, Дёнер, Дюрюм Дёнер, Дюрюм, картофель фри, картофель по-деревенски, Добрый Кола, фирменный морс, айран, напиток.
Типичные короткие ответы: да, нет, ага, алло, повтори, тот же номер, Андрей.
Не заменяй слова из этого словаря на похожие фамилии или случайные слова: самовывоз, не Артамонов; Кулакова, не Кукие; айран, не Эрам; Добрый Кола, не доброе коло.
`.trim();

const ORDER_FLOW_INSTRUCTIONS = `
ОПЕРАЦИОННЫЕ ПРАВИЛА ОФОРМЛЕНИЯ ЗАКАЗА:
- Задавай только один сборочный вопрос за раз. Не спрашивай имя и подтверждение номера в одном ответе.
- Если нужно имя и подтверждение номера, сначала спроси имя. После ответа клиента отдельно уточни номер.
- Если ты только что попросил имя, а клиент ответил коротким словом, принимай его как имя только если это похоже на имя.
- Не считай именем служебные слова связи и реакции: "алло", "ой", "да", "нет", "ага", "повтори", "не слышу", "связь оборвалась".
- Если короткий ответ похож на редкое имя, например "Алли", принимай его как имя. Если сомневаешься, уточни: "Как вас записать?"
- После подтверждения состава заказа кратко назови позиции, количество, сумму и ресторан или адрес. Затем задай только один вопрос по одному недостающему полю.
- Не начинай длинный ответ со служебных фраз вроде "сейчас уточню", если можно сразу дать полезный ответ.
- Если ответ получается длинным, разбей его на короткое подтверждение и один короткий вопрос.
- Если клиент отвечает "да", "ага", "верно", "всё хорошо" после вопроса подтверждения, считай это подтверждением.
- Не повторяй просьбу назвать имя, если клиент уже дал похожее на имя слово после твоего вопроса.
`.trim();

function buildSessionUpdate(clientCfg, callMeta) {
  const callerNumber = String(callMeta?.callerId || '').trim();
  const callerInstruction = callerNumber
      ? `\n- Номер телефона с которого звонят: ${callerNumber}`
      : '';
  const runtimeInstructions = [
    clientCfg.instructions,
    ORDER_FLOW_INSTRUCTIONS,
    callerInstruction.trim(),
  ].filter(Boolean).join('\n\n');
  const inputTranscription = {
    model: clientCfg.transcriptionModel,
    language: clientCfg.language,
  };

  const transcriptionPrompt = clientCfg.transcriptionPrompt || DEFAULT_TRANSCRIPTION_PROMPT;

  if (transcriptionPrompt) {
    inputTranscription.prompt = String(transcriptionPrompt);
  }

  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: useOpenAiTextOnly ? ['text'] : ['audio'],
      instructions: runtimeInstructions,
      max_output_tokens: clientCfg.maxResponseOutputTokens,
      audio: {
        input: {
          format: {
            type: 'audio/pcm',
            rate: CONFIG.modelSampleRate,
          },
          noise_reduction: { type: CONFIG.noiseReductionType },
          turn_detection: {
            type: 'server_vad',
            create_response: true,
            interrupt_response: true,
            silence_duration_ms: clientCfg.turnDetection.silenceDurationMs,
            prefix_padding_ms: clientCfg.turnDetection.prefixPaddingMs,
            threshold: clientCfg.turnDetection.threshold,
          },
          transcription: {
            ...inputTranscription,
          },
        },
        output: useOpenAiTextOnly ? undefined : {
          format: {
            type: 'audio/pcm',
            rate: CONFIG.modelSampleRate,
          },
          voice: clientCfg.voice,
          speed: 1.0,
        },
      },
      truncation: 'auto',
    },
  };
}

function buildGreetingResponse(clientCfg) {
  return {
    type: 'response.create',
    response: {
      instructions: clientCfg.greetingText,
      max_output_tokens: clientCfg.maxResponseOutputTokens,
    },
  };
}

// ---------- AudioSocket server ----------

const audioServer = net.createServer((socket) => {
  let forwardTimer = null;

  const connId = crypto.randomUUID().slice(0, 8);
  const startedAt = ts();

  socket.setNoDelay(true);
  socket.setKeepAlive(true, 10_000);

  log('[TCP]', `connected ${connId} from ${socket.remoteAddress}:${socket.remotePort}`);

  let buffer = Buffer.alloc(0);
  let uuidHex = null;
  let closed = false;
  let totalTextSpeech = "";

  let meta = null;
  let clientCfg = defaultClientConfig();
  let sessionDir = null;
  let transcriptPath = null;
  let realtimeTranscriptTextPath = null;
  let processedTranscriptPath = null;
  let metaPath = null;

  let callerWav = null;
  let assistantWav = null;
  let talkWav = null;
  let talkAssistantFrames = [];

  let ws = null;
  let sessionReady = false;
  let responseActive = false;
  let cancelRequested = false;
  let redirectRequested = false;
  let currentResponseId = null;
  let handshakeTimer = null;

  let outboundQueue = [];
  let outboundPumping = false;
  let outboundTimers = new Set();
  let outboundGeneration = 0;
  let outboundAssemble = Buffer.alloc(0);

  
  const START_BUFFER_FRAMES = Math.max(1, CONFIG.outboundStartBufferFrames);
  const RESUME_BUFFER_FRAMES = Math.max(1, CONFIG.outboundResumeBufferFrames);
  const SEND_FRAMES_PER_TICK = Math.max(1, CONFIG.outboundSendFramesPerTick);

  let responseAudioDone = false;
  let playbackStarted = false;

  let pendingAssistantTranscript = '';
  let pendingAssistantText = '';
  let elevenTtsSeq = 0;
  let elevenTtsChain = Promise.resolve();
  let openAiAudioFallbackChunks = [];
  let openAiAudioFallbackBytes = 0;
  let openAiFallbackArmed = false;
  let assistantPlaybackUntil = 0;
  let lastInputLevel = 0;
  let outboundLowpass = createPcm8LowpassFir();

  const downsample24to8 = createDownsampler24kTo8k();

  const summary = {
    connId,
    uuid: null,
    startedAt: nowIso(),
    endedAt: null,
    durationMs: 0,
    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort,
    did: null,
    callerId: null,
    clientId: null,
    model: CONFIG.realtimeModel,
    voice: null,
    bytesFromAsterisk: 0,
    bytesToAsterisk: 0,
    pcm24BytesToOpenAI: 0,
    pcm24BytesFromOpenAI: 0,
    callerFrames: 0,
    assistantFrames: 0,
    talkFrames: 0,
    recordings: {
      caller: null,
      assistant: null,
      talk: null,
    },
    logs: {
      realtime: null,
      processed: null,
      processedStatus: 'pending',
      processedError: null,
    },
    dtmf: [],
    turns: {
      user: 0,
      assistant: 0,
    },
    openaiUsage: [],
    closeReason: null,
  };

  function redirectCallToMobile(reason = 'manual') {
    if (closed) {
      log('[FWD]', `skip redirect (${reason}): call already closed`);
      return;
    }
    if (redirectRequested) {
      log('[FWD]', `skip duplicate redirect (${reason})`);
      return;
    }

    const ch = meta?.channel;
    if (!ch) {
      logErr('[FWD]', 'no channel in metadata, cannot redirect');
      return;
    }

    const forwardPhone = normalizeForwardPhone(clientCfg.forwardPhone || CONFIG.defaultForwardPhone);
    if (!forwardPhone) {
      logErr('[FWD]', 'no forwardPhone configured, cannot redirect');
      return;
    }
    if (forwardPhone.length < 5 || forwardPhone.length > 15) {
      logErr('[FWD]', `invalid forwardPhone length for ${forwardPhone}`);
      return;
    }

    redirectRequested = true;
    const cliCommand = `channel redirect ${ch} ${CONFIG.forwardContext},${forwardPhone},1`;
    exec(`sudo /usr/sbin/asterisk -rx ${shellQuote(cliCommand)}`, (err, stdout, stderr) => {
      if (err) {
        logErr('[FWD]', `redirect failed: ${err.message}`);
        return;
      }

      log('[FWD]', `redirect sent for ${ch} to ${forwardPhone} (${reason})`);
      if (stdout?.trim()) log('[FWD]', stdout.trim());
      if (stderr?.trim()) logErr('[FWD]', stderr.trim());
    });
  }

  function initFiles() {
    const datePart = new Date().toISOString().slice(0, 10);
    const didPart = safeName(meta?.did || 'no_did');
    const callerPart = safeName(meta?.callerId || 'anonymous');
    const uuidPart = safeName(uuidHex || connId);
    const sessionPart = `${Date.now()}_${callerPart}_${uuidPart}`;

    sessionDir = path.join(
        CONFIG.recordsDir,
        didPart,
        datePart,
        sessionPart
    );
    ensureDir(sessionDir);

    callerWav = openWav(path.join(sessionDir, 'caller_8k.wav'), 8000);
    summary.recordings.caller = 'caller_8k.wav';

    if (CONFIG.recordAssistantWav) {
      assistantWav = openWav(path.join(sessionDir, 'assistant_8k.wav'), 8000);
      summary.recordings.assistant = 'assistant_8k.wav';
    }

    if (CONFIG.recordTalkWav) {
      talkWav = openWav(path.join(sessionDir, 'talk_8k_stereo.wav'), 8000, 2);
      summary.recordings.talk = 'talk_8k_stereo.wav';
    }

    transcriptPath = path.join(sessionDir, 'transcript.jsonl');
    realtimeTranscriptTextPath = path.join(sessionDir, 'transcript_realtime.txt');
    processedTranscriptPath = path.join(sessionDir, 'transcript_processed.txt');
    metaPath = path.join(sessionDir, 'meta.json');
    summary.logs.realtime = 'transcript_realtime.txt';
    summary.logs.processed = 'transcript_processed.txt';

    summary.uuid = uuidHex;
    summary.did = meta?.did || null;
    summary.callerId = meta?.callerId || null;
    summary.clientId = meta?.clientId || clientCfg.clientId || null;
    summary.voice = clientCfg.voice;

    writeJson(metaPath, { summary, meta, clientCfg });
  }

  function persistMeta() {
    if (!metaPath) return;
    summary.endedAt = nowIso();
    summary.durationMs = ts() - startedAt;
    writeJson(metaPath, { summary, meta, clientCfg });
  }

  function pushTranscript(role, text, extra = {}) {
    if (!transcriptPath || !text) return;
    appendJsonl(transcriptPath, {
      ts: nowIso(),
      role,
      text,
      ...extra,
    });
  }

  function assistantTextHasForward(text) {
    const normalized = String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();

    return normalized.includes('\u043f\u0435\u0440\u0435\u0432\u043e\u0436\u0443') &&
        normalized.includes('\u0432\u0430\u0441') &&
        normalized.includes('\u0441\u043e\u0437\u0434\u0430\u0442\u0435\u043b\u044f');
  }

  function commitAssistantText(text, evt = {}, source = 'text') {
    const clean = String(text || '').trim();
    if (!clean) return;

    summary.turns.assistant += 1;
    totalTextSpeech = totalTextSpeech + "\nAssi: " + clean;
    log('[TTS-TXT]', clean);
    pushTranscript('assistant', clean, {
      responseId: evt.response_id || currentResponseId || null,
      itemId: evt.item_id || null,
      source,
    });

    if (assistantTextHasForward(clean)) {
      log('[FWD]', 'redirecting call');
      clearOutboundAudio('forward_to_mobile');
      redirectCallToMobile('assistant_forward');
    }

    if (useElevenLabsTts) {
      scheduleElevenLabsTts(clean, evt.response_id || currentResponseId || null);
    }
  }

  function sendFinalCallLog(rawLog) {
    const realtimeLog = String(rawLog || '').trim();
    const fallbackText = `call end\n${realtimeLog}`.trimEnd();

    if (realtimeTranscriptTextPath) {
      fs.writeFileSync(realtimeTranscriptTextPath, fallbackText + '\n', 'utf8');
    }

    buildProcessedCallLog(realtimeLog, {
      did: summary.did,
      callerId: summary.callerId,
      clientId: summary.clientId,
    }).then(async (processed) => {
      const clean = String(processed || '').trim();
      if (!clean) throw new Error('processed log is empty');

      const telegramText = `call end\n${clean}`;
      if (processedTranscriptPath) {
        fs.writeFileSync(processedTranscriptPath, telegramText + '\n', 'utf8');
      }
      summary.logs.processedStatus = 'ok';
      summary.logs.processedError = null;
      summary.logs.processedAt = nowIso();
      persistMeta();
      await sendTelegram(telegramText, getTelegramTargetFromConfig(clientCfg), `call-${summary.uuid || Date.now()}.txt`);
    }).catch(async (err) => {
      const message = String(err?.message || err);
      logErr('[POSTCALL]', message);
      summary.logs.processedStatus = 'failed';
      summary.logs.processedError = message.slice(0, 500);
      summary.logs.processedAt = nowIso();
      if (processedTranscriptPath) {
        fs.writeFileSync(processedTranscriptPath, fallbackText + '\n', 'utf8');
      }
      persistMeta();
      await sendTelegram(
          `${fallbackText}\n\n[post-call log processing failed: ${message}]`,
          getTelegramTargetFromConfig(clientCfg),
          `call-${summary.uuid || Date.now()}.txt`
      );
    });
  }

  function appendTalkFrame(callerFrame) {
    if (!talkWav) return;
    const assistantFrame = talkAssistantFrames.length ? talkAssistantFrames.shift() : null;
    appendStereoPcm16Frame(talkWav, callerFrame, assistantFrame, CONFIG.asteriskFrameBytes);
    summary.talkFrames += 1;
  }

  function rememberAssistantTalkFrame(frame) {
    if (!talkWav || !frame?.length) return;
    talkAssistantFrames.push(Buffer.from(frame));
  }

  function flushTalkAssistantTail() {
    if (!talkWav) return;
    while (talkAssistantFrames.length) {
      appendStereoPcm16Frame(
          talkWav,
          null,
          talkAssistantFrames.shift(),
          CONFIG.asteriskFrameBytes
      );
      summary.talkFrames += 1;
    }
  }

  function clearOutboundAudio(reason = 'clear') {
    responseAudioDone = false;
    playbackStarted = false;
    outboundQueue = [];
    outboundAssemble = Buffer.alloc(0);
    assistantPlaybackUntil = 0;
    openAiAudioFallbackChunks = [];
    openAiAudioFallbackBytes = 0;
    openAiFallbackArmed = false;
    outboundLowpass = createPcm8LowpassFir();

    for (const t of outboundTimers) clearTimeout(t);
    outboundTimers.clear();

    outboundGeneration += 1;
    outboundPumping = false;

    log('[AUDIO-OUT]', `${reason}; generation=${outboundGeneration}`);
  }

  function queuePcm8ToAsterisk(pcm8) {
    if (!pcm8?.length || closed) return;

    let sourcePcm = Buffer.from(pcm8);
    if (CONFIG.outboundLowpass) {
      sourcePcm = outboundLowpass(sourcePcm);
    }
    if (Number.isFinite(CONFIG.outboundPcmGain) && CONFIG.outboundPcmGain > 0) {
      sourcePcm = applyPcm16Gain(sourcePcm, CONFIG.outboundPcmGain);
    }

    outboundAssemble = outboundAssemble.length
        ? Buffer.concat([outboundAssemble, sourcePcm])
        : Buffer.from(sourcePcm);

    while (outboundAssemble.length >= CONFIG.asteriskFrameBytes) {
      const frame = outboundAssemble.subarray(0, CONFIG.asteriskFrameBytes);
      outboundQueue.push(frame);
      outboundAssemble = outboundAssemble.subarray(CONFIG.asteriskFrameBytes);
      assistantPlaybackUntil = Math.max(assistantPlaybackUntil, Date.now()) + CONFIG.asteriskFrameMs;
    }

    const needFrames = playbackStarted ? RESUME_BUFFER_FRAMES : START_BUFFER_FRAMES;

    if (!outboundPumping && outboundQueue.length >= needFrames) {
      pumpOutbound();
    }
  }

  function rememberOpenAiFallbackPcm8(pcm8) {
    if (!pcm8?.length) return;
    openAiAudioFallbackChunks.push(Buffer.from(pcm8));
    openAiAudioFallbackBytes += pcm8.length;
  }

  function playOpenAiFallbackAudio(reason = 'elevenlabs_error') {
    if (!openAiAudioFallbackChunks.length) return false;
    openAiFallbackArmed = true;
    for (const chunk of openAiAudioFallbackChunks) {
      queuePcm8ToAsterisk(chunk);
    }
    log(
        '[AUDIO-OUT]',
        `fallback OpenAI audio enabled (${reason}), buffered=${openAiAudioFallbackBytes} bytes`
    );
    openAiAudioFallbackChunks = [];
    openAiAudioFallbackBytes = 0;
    return true;
  }

  function scheduleElevenLabsTts(text, responseId = null) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText || !useElevenLabsTts) return;

    const seq = ++elevenTtsSeq;
    const generationAtStart = outboundGeneration;

    elevenTtsChain = elevenTtsChain
        .catch(() => {})
        .then(async () => {
          if (closed || generationAtStart !== outboundGeneration) {
            return;
          }

          const startedAtMs = Date.now();
          const languageCode = clientCfg.language || CONFIG.defaultLanguage || null;
          const ttsText = normalizeElevenLabsNumbersForSpeech(
              applyElevenLabsPronunciationHints(normalizedText)
          );
          const elevenOutputIsUlaw = isElevenLabsUlaw8k();
          const downsample16to8 = elevenOutputIsUlaw ? null : createDownsampler16kTo8k();
          const edgeSmoother = createPcm8EdgeSmoother(CONFIG.inputSampleRate, CONFIG.ttsEdgeFadeMs);
          let totalInputBytes = 0;
          let total8kBytes = 0;
          let firstChunkLatencyMs = -1;
          responseAudioDone = false;
          outboundLowpass = createPcm8LowpassFir();

          try {
            if (CONFIG.elevenLabsStreaming) {
              await elevenLabsStreamPcm16k(ttsText, languageCode, (audioChunk) => {
                if (closed || generationAtStart !== outboundGeneration) {
                  return;
                }
                if (firstChunkLatencyMs < 0) {
                  firstChunkLatencyMs = Date.now() - startedAtMs;
                }
                totalInputBytes += audioChunk.length;
                const chunk8k = elevenOutputIsUlaw
                    ? decodeUlaw8kToPcm16(audioChunk)
                    : downsample16to8(audioChunk);
                if (!chunk8k.length) return;
                const smoothed = edgeSmoother.push(chunk8k);
                if (!smoothed.length) return;
                total8kBytes += smoothed.length;
                queuePcm8ToAsterisk(smoothed);
              });
            } else {
              const audio = await elevenLabsSynthesizePcm16k(ttsText, languageCode);
              totalInputBytes = audio.length;
              const pcm8 = elevenOutputIsUlaw
                  ? decodeUlaw8kToPcm16(audio)
                  : downsample16kTo8k(audio);
              if (pcm8.length) {
                const smoothed = edgeSmoother.push(pcm8);
                if (smoothed.length) {
                  total8kBytes += smoothed.length;
                  queuePcm8ToAsterisk(smoothed);
                }
              }
            }

            const finalPcm8 = edgeSmoother.finish();
            if (finalPcm8.length) {
              total8kBytes += finalPcm8.length;
              queuePcm8ToAsterisk(finalPcm8);
            }
          } catch (err) {
            const message = String(err?.message || err);
            logErr('[TTS11]', `failed seq=${seq} response=${responseId || '-'}: ${message}`);
            if (closed || generationAtStart !== outboundGeneration) return;

            if (total8kBytes <= 0) {
              if (!playOpenAiFallbackAudio('elevenlabs_error')) {
                logErr('[TTS11]', `no fallback OpenAI audio for seq=${seq}`);
              }
            } else {
              const finalPcm8 = edgeSmoother.finish();
              if (finalPcm8.length) {
                total8kBytes += finalPcm8.length;
                queuePcm8ToAsterisk(finalPcm8);
              }
              flushOutboundTail();
              logErr('[TTS11]', `partial stream sent seq=${seq}, skipping full fallback to avoid duplicate speech`);
            }
            return;
          }

          if (closed || generationAtStart !== outboundGeneration) {
            log('[TTS11]', `drop stale seq=${seq}`);
            return;
          }

          if (total8kBytes <= 0) {
            logErr('[TTS11]', `empty synthesized audio seq=${seq}`);
            if (!playOpenAiFallbackAudio('elevenlabs_empty')) {
              logErr('[TTS11]', `no fallback OpenAI audio for seq=${seq}`);
            }
            return;
          }

          flushOutboundTail();
          log(
              '[TTS11]',
              `ok seq=${seq} mode=${CONFIG.elevenLabsStreaming ? 'stream' : 'buffer'} format=${CONFIG.elevenLabsOutputFormat} response=${responseId || '-'} chars=${normalizedText.length} tts_chars=${ttsText.length} input_bytes=${totalInputBytes} bytes8k=${total8kBytes} first_chunk_ms=${firstChunkLatencyMs < 0 ? 'n/a' : firstChunkLatencyMs} total_ms=${Date.now() - startedAtMs}`
          );
        });
  }

  function flushOutboundTail() {
    responseAudioDone = true;

    if (outboundAssemble.length) {
      const last = Buffer.alloc(CONFIG.asteriskFrameBytes);
      outboundAssemble.copy(last, 0, 0, outboundAssemble.length);
      outboundQueue.push(last);
      outboundAssemble = Buffer.alloc(0);
      assistantPlaybackUntil = Math.max(assistantPlaybackUntil, Date.now()) + CONFIG.asteriskFrameMs;
    }

    if (!outboundPumping && outboundQueue.length) {
      pumpOutbound();
    }
  }

  function pumpOutbound() {
    if (closed || outboundPumping) return;
    if (!outboundQueue.length) return;

    outboundPumping = true;
    playbackStarted = true;

    const myGeneration = outboundGeneration;

    const sendTick = () => {
      if (closed || myGeneration !== outboundGeneration) {
        outboundPumping = false;
        return;
      }

      let sent = 0;

      while (sent < SEND_FRAMES_PER_TICK && outboundQueue.length) {
        const chunk = outboundQueue.shift();

        try {
          socket.write(makeFrame(TYPE_PCM_8K, chunk));
          summary.bytesToAsterisk += chunk.length;
          summary.assistantFrames += 1;
          rememberAssistantTalkFrame(chunk);

          if (assistantWav) {
            appendWav(assistantWav, chunk);
          }
        } catch (err) {
          logErr('[AUDIO-OUT]', err.message);
          outboundPumping = false;
          return;
        }

        sent += 1;
      }

      if (!outboundQueue.length) {
        outboundPumping = false;

        if (!responseAudioDone) {
          playbackStarted = false;
          log('[AUDIO-OUT]', 'underflow waiting for more audio');
        }

        return;
      }

      const timer = setTimeout(() => {
        outboundTimers.delete(timer);
        sendTick();
      }, CONFIG.asteriskFrameMs * SEND_FRAMES_PER_TICK);

      outboundTimers.add(timer);
    };

    sendTick();
  }

  function safeWsSend(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      logErr('[OA]', `send failed: ${err.message}`);
      return false;
    }
  }

  function cancelActiveResponse(reason = 'barge-in') {
    if (!responseActive || cancelRequested) return;
    if (safeWsSend({ type: 'response.cancel' })) {
      cancelRequested = true;
      log('[OA]', `response.cancel (${reason})`);
    }
  }

  function cleanup(closeReason = 'normal') {
    if (forwardTimer) {
      clearTimeout(forwardTimer);
      forwardTimer = null;
    }
    if (closed) return;
    closed = true;
    summary.closeReason = closeReason;

    const finalRawLog = totalTextSpeech;
    totalTextSpeech = "";

    clearOutboundAudio('cleanup');

    if (handshakeTimer) clearTimeout(handshakeTimer);

    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    } catch {}

    flushTalkAssistantTail();
    closeWav(callerWav);
    closeWav(assistantWav);
    closeWav(talkWav);
    persistMeta();
    sendFinalCallLog(finalRawLog);

    if (sessionDir) {
      log('[CALL]', `saved ${sessionDir}`);
    }
  }

  function openRealtime() {
    if (ws || !CONFIG.openAiApiKey) return;
    if (!proxyAgent) {
      logErr('[OA]', 'OPENAI_PROXY_URL is empty; refusing to open Realtime without proxy');
      return;
    }
    //todo: если невозможно установить соединение
    ws = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(CONFIG.realtimeModel)}`,
        {
          headers: {
            Authorization: `Bearer ${CONFIG.openAiApiKey}`,
          },
          handshakeTimeout: CONFIG.wsHandshakeTimeoutMs,
          agent: proxyAgent,
        }
    );

    handshakeTimer = setTimeout(() => {
      if (!sessionReady) {
        logErr('[OA]', 'session not ready in time');
      }
    }, CONFIG.wsCloseAfterNoSessionMs);

    ws.on('open', () => {
      log('[OA]', 'open');
      safeWsSend(buildSessionUpdate(clientCfg, meta));
    });

    ws.on('message', (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (evt.type) {
        case 'session.created':
          log('[OA]', 'session.created');
          break;

        case 'session.updated':
          sessionReady = true;
          if (handshakeTimer) clearTimeout(handshakeTimer);
          log('[OA]', 'session.updated');

          if (clientCfg.autoGreeting) {
            safeWsSend(buildGreetingResponse(clientCfg));
          }
          break;

        case 'input_audio_buffer.speech_started': {
          const now = Date.now();
          const likelyEcho = now < assistantPlaybackUntil + CONFIG.bargeInEchoGuardMs;
          const strongMic = lastInputLevel >= CONFIG.forceBargeInPcmThreshold;

          if (likelyEcho && !strongMic) {
            log('[OA]', `speech_started ignored (likely echo, level=${lastInputLevel})`);
            break;
          }

          log('[OA]', `speech_started accepted (level=${lastInputLevel})`);
          clearOutboundAudio('user_speech_started');

          if (responseActive) {
            cancelActiveResponse('speech_started');
          }
          break;
        }

        case 'input_audio_buffer.speech_stopped':
          log('[OA]', 'speech_stopped');
          break;

        case 'conversation.item.input_audio_transcription.completed': {
          const transcript = String(evt.transcript || '').trim();
          if (transcript) {
            summary.turns.user += 1;
            totalTextSpeech = totalTextSpeech + "\nUser: " + transcript;
            log('[ASR]', transcript);
            pushTranscript('user', transcript, {
              itemId: evt.item_id || null,
              contentIndex: evt.content_index ?? null,
            });
          }
          break;
        }

        case 'conversation.item.input_audio_transcription.failed':
          logErr('[ASR]', JSON.stringify(evt));
          break;

        case 'response.created':
          responseActive = true;
          cancelRequested = false;
          responseAudioDone = false;
          playbackStarted = false;
          currentResponseId = evt.response?.id || evt.response_id || null;
          pendingAssistantTranscript = '';
          pendingAssistantText = '';
          openAiAudioFallbackChunks = [];
          openAiAudioFallbackBytes = 0;
          openAiFallbackArmed = false;
          log('[OA]', `response.created ${currentResponseId || ''}`.trim());
          break;

        case 'response.output_text.delta':
          if (evt.delta) pendingAssistantText += evt.delta;
          break;

        case 'response.output_text.done': {
          const text = String(evt.text || pendingAssistantText || '').trim();
          pendingAssistantText = '';
          commitAssistantText(text, evt, 'output_text');
          break;
        }

        case 'response.output_audio.delta': {
          if (!evt.delta || closed) break;
          const pcm24 = Buffer.from(evt.delta, 'base64');
          summary.pcm24BytesFromOpenAI += pcm24.length;

          const pcm8 = downsample24to8(pcm24);
          if (!pcm8.length) break;

          if (useElevenLabsTts && !openAiFallbackArmed) {
            rememberOpenAiFallbackPcm8(pcm8);
            break;
          }

          if (pcm8.length) {
            queuePcm8ToAsterisk(pcm8);
          }
          break;
        }

        case 'response.output_audio_transcript.delta':
          if (evt.delta) pendingAssistantTranscript += evt.delta;
          break;

        case 'response.output_audio_transcript.done': {
          const text = String(evt.transcript || pendingAssistantTranscript || '').trim();
          pendingAssistantTranscript = '';
          if (text) {
            summary.turns.assistant += 1;
            totalTextSpeech = totalTextSpeech + "\nAssi: " + text;
            log('[TTS-TXT]', text);
            pushTranscript('assistant', text, {
              responseId: evt.response_id || currentResponseId || null,
              itemId: evt.item_id || null,
            });
            const normalized = text
                .toLowerCase()
                .replace(/[^\p{L}\p{N}\s]/gu, '')
                .replace(/\s+/g, ' ')
                .trim();

            const hasForward =
                normalized.includes('перевожу') &&
                normalized.includes('вас') &&
                normalized.includes('создателя');

            if (hasForward) {
              log('[FWD]', 'redirecting call');
              clearOutboundAudio('forward_to_mobile');
              redirectCallToMobile('assistant_forward');
            }

            if (useElevenLabsTts) {
              scheduleElevenLabsTts(text, evt.response_id || currentResponseId || null);
            }
          }
          break;
        }

        case 'response.output_audio.done':
          flushOutboundTail();
          log('[OA]', 'output_audio.done');
          break;

        case 'response.done':
          responseActive = false;
          cancelRequested = false;
          currentResponseId = null;

          if (evt.response?.status_details) {
            log('[OA]', `status_details=${JSON.stringify(evt.response.status_details)}`);
          }
          if (evt.response?.usage) {
            log('[OA]', `usage=${JSON.stringify(evt.response.usage)}`);
          }
          if (evt.response?.usage) {
            summary.openaiUsage.push({
              ts: nowIso(),
              usage: evt.response.usage,
            });
          }

          log('[OA]', 'response.done');
          persistMeta();
          break;

        case 'rate_limits.updated':
          break;

        case 'error':
          responseActive = false;
          cancelRequested = false;
          currentResponseId = null;
          if (evt.error?.code === 'response_cancel_not_active') {
            log('[OA]', `nonfatal ${evt.error.code}: ${evt.error.message || ''}`.trim());
            break;
          }
          logErr('[OA]', JSON.stringify(evt));
          break;

        default:
          break;
      }
    });

    ws.on('close', (code, reason) => {
      responseActive = false;
      cancelRequested = false;
      currentResponseId = null;
      log('[OA]', `close ${code} ${String(reason || '')}`.trim());
      if (!closed) {
        redirectCallToMobile(`openai_close:${code}`);
      }
    });

    ws.on('error', (err) => {
      logErr('[OA]', `ws error: ${err.message}`);
    });
  }

  socket.on('data', (chunk) => {
    summary.bytesFromAsterisk += chunk.length;
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 3) {
      const type = buffer.readUInt8(0);
      const len = buffer.readUInt16BE(1);
      if (buffer.length < 3 + len) break;

      const payload = buffer.subarray(3, 3 + len);
      buffer = buffer.subarray(3 + len);

      if (type === TYPE_UUID) {
        uuidHex = normalizeUuid(payload.toString('hex'));
        meta = getCallMeta(uuidHex);
        clientCfg = resolveClientConfig(meta);

        initFiles();

        if (CONFIG.forwardAfterMs > 0) {
          forwardTimer = setTimeout(() => {
            log('[FWD]', 'time limit reached, redirecting call');
            clearOutboundAudio('forward_to_mobile');
            redirectCallToMobile('time_limit');
          }, CONFIG.forwardAfterMs);
        }

        log('[UUID]', uuidHex);
        if (meta) {
          log('[META]', `did=${meta.did || '-'} callerId=${meta.callerId || '-'} clientId=${meta.clientId || '-'}`);
        } else {
          log('[META]', 'not found for uuid; using default client config');
        }

        persistMeta();
        openRealtime();
        continue;
      }

      if (type === TYPE_PCM_8K) {
        appendWav(callerWav, payload);
        appendTalkFrame(payload);
        summary.callerFrames += 1;

        const level = meanAbsPcm16(payload);
        lastInputLevel = level;

        if (summary.callerFrames % 50 === 1) {
          log('[PCM-IN]', `bytes=${payload.length} mean_abs=${level}`);
        }

        if (ws && ws.readyState === WebSocket.OPEN && sessionReady) {
          const inputPcm8 = applyPcm16Gain(payload, CONFIG.inputPcmGain);
          const pcm24 = upsample8kTo24k(inputPcm8);
          summary.pcm24BytesToOpenAI += pcm24.length;
          safeWsSend({
            type: 'input_audio_buffer.append',
            audio: pcm24.toString('base64'),
          });
        }
        continue;
      }

      if (type === TYPE_DTMF) {
        const tone = payload.toString('ascii');
        summary.dtmf.push({ ts: nowIso(), tone });
        log('[DTMF]', tone);
        continue;
      }

      if (type === TYPE_TERMINATE) {
        log('[TCP]', 'terminate frame received');
        socket.end();
        continue;
      }

      log('[WARN]', `unknown frame type=0x${type.toString(16)} len=${len}`);
    }
  });

  socket.on('close', () => {
    cleanup('socket_close');
    log('[TCP]', `closed ${connId}`);
  });

  socket.on('error', (err) => {
    logErr('[TCP]', `error ${connId}: ${err.message}`);
    cleanup('socket_error');
  });
});

audioServer.listen(CONFIG.audioSocketPort, CONFIG.audioSocketHost, () => {
  log('[LISTEN]', `AudioSocket on ${CONFIG.audioSocketHost}:${CONFIG.audioSocketPort}`);
});

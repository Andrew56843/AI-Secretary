// Asterisk AudioSocket voice service entrypoint.
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
  platformApiBaseUrl: process.env.PLATFORM_API_BASE_URL || '',
  voiceServiceToken: process.env.VOICE_SERVICE_TOKEN || '',
  platformApiTimeoutMs: Number(process.env.PLATFORM_API_TIMEOUT_MS || 1500),
  calendarToolTimeoutMs: Number(process.env.CALENDAR_TOOL_TIMEOUT_MS || 12_000),
  outboundDialerEnabled: String(process.env.OUTBOUND_DIALER_ENABLED || 'false') === 'true',
  outboundDialerIntervalMs: Number(process.env.OUTBOUND_DIALER_INTERVAL_MS || 5000),
  outboundMaxConcurrent: Number(process.env.OUTBOUND_MAX_CONCURRENT || 1),
  outboundWaitTimeSec: Number(process.env.OUTBOUND_WAIT_TIME_SEC || 45),
  outboundTrunk: process.env.OUTBOUND_TRUNK || 'PJSIP/novofon-endpoint/sip',
  outboundContext: process.env.OUTBOUND_CONTEXT || 'ai-outbound',
  outboundExtension: process.env.OUTBOUND_EXTENSION || 's',
  outboundCallerId: process.env.OUTBOUND_CALLER_ID || '',
  asteriskOutgoingDir: process.env.ASTERISK_OUTGOING_DIR || '/var/spool/asterisk/outgoing',
  asteriskOutgoingDoneDir: process.env.ASTERISK_OUTGOING_DONE_DIR || '/var/spool/asterisk/outgoing_done',

  openAiApiKey: process.env.OPENAI_API_KEY || '',
  openAiProxyUrl: process.env.OPENAI_PROXY_URL || process.env.SOCKS_PROXY_URL || '',
  realtimeModel: process.env.REALTIME_MODEL || 'gpt-realtime-2',//
  //realtimeModel: process.env.REALTIME_MODEL || 'gpt-realtime-mini',
  defaultForwardPhone: process.env.DEFAULT_FORWARD_PHONE || process.env.FORWARD_PHONE || '',

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  telegramLinkPollingEnabled: String(process.env.TELEGRAM_LINK_POLLING_ENABLED || 'true') === 'true',
  telegramLinkPollIntervalMs: Number(process.env.TELEGRAM_LINK_POLL_INTERVAL_MS || 1000),
  telegramLinkPollTimeoutSec: Number(process.env.TELEGRAM_LINK_POLL_TIMEOUT_SEC || 25),

  autoGreeting: String(process.env.AUTO_GREETING || 'true') === 'true',
  recordsDir: process.env.RECORDS_DIR || path.join(process.cwd(), 'records'),
  clientsConfigPath: process.env.CLIENTS_CONFIG_PATH || path.join(process.cwd(), 'clients.json'),

  keepMetadataMs: Number(process.env.KEEP_METADATA_MS || 30 * 60 * 1000),
  maxResponseOutputTokens: Number(process.env.MAX_RESPONSE_OUTPUT_TOKENS || 600),

  inputSampleRate: 8000,
  modelSampleRate: 24000,
  inputPcmGain: Number(process.env.INPUT_PCM_GAIN || 1.4),
  asteriskFrameBytes: 320, // 20ms @ 8kHz mono s16le
  asteriskFrameMs: 20,
  outboundStartBufferFrames: Number(process.env.OUTBOUND_START_BUFFER_FRAMES || 13),
  outboundResumeBufferFrames: Number(process.env.OUTBOUND_RESUME_BUFFER_FRAMES || 6),
  outboundSendFramesPerTick: Number(process.env.OUTBOUND_SEND_FRAMES_PER_TICK || 2),

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
  recordPlaybackWav: String(process.env.RECORD_PLAYBACK_WAV || 'true') === 'true',
  playbackCallerGain: Number(process.env.PLAYBACK_CALLER_GAIN || 1.35),
  playbackAssistantGain: Number(process.env.PLAYBACK_ASSISTANT_GAIN || 1.0),
  playbackTargetPeak: Number(process.env.PLAYBACK_TARGET_PEAK || 0.9),
  postCallLogEnabled: String(process.env.POST_CALL_LOG_ENABLED || 'true') === 'true',
  postCallLogModel: process.env.POST_CALL_LOG_MODEL || 'gpt-4o-mini',
  postCallLogTimeoutMs: Number(process.env.POST_CALL_LOG_TIMEOUT_MS || 45_000),
  postCallLogMaxChars: Number(process.env.POST_CALL_LOG_MAX_CHARS || 20_000),
  transcriptionPromptMaxChars: Number(process.env.TRANSCRIPTION_PROMPT_MAX_CHARS || 1024),
  postCallLogFinalizeDelayMs: Number(process.env.POST_CALL_LOG_FINALIZE_DELAY_MS || 750),
  postCallLogMinRawTurns: Number(process.env.POST_CALL_LOG_MIN_RAW_TURNS || 2),
  finalHangupDelayMs: Number(process.env.FINAL_HANGUP_DELAY_MS || 500),
};

if (!CONFIG.openAiApiKey) {
  console.warn('[BOOT] OPENAI_API_KEY is empty. Realtime will not work until it is set.');
}

if (!CONFIG.openAiProxyUrl) {
  console.warn('[BOOT] OPENAI_PROXY_URL is empty. Realtime traffic will not be opened without proxy.');
}

if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
  console.warn('[BOOT] Telegram is not configured. Call summaries will not be sent.');
}

if (!CONFIG.platformApiBaseUrl || !CONFIG.voiceServiceToken) {
  console.warn('[BOOT] Platform API integration is not configured. Falling back to clients.json only.');
}

const proxyAgent = CONFIG.openAiProxyUrl
    ? new SocksProxyAgent(CONFIG.openAiProxyUrl)
    : null;

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

function clampTranscriptionPrompt(prompt) {
  const text = String(prompt || '').trim();
  const maxChars = Math.max(0, CONFIG.transcriptionPromptMaxChars || 1024);

  if (!text || text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }

  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
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
async function sendTelegram(text, chatId = CONFIG.telegramChatId) {
  if (!CONFIG.telegramBotToken || !chatId) return;

  try {
    for (const chunk of splitTelegramText(text)) {
      await tgFetch("sendMessage", {
        chat_id: chatId,
        text: chunk,
      });
    }
  } catch (e) {
    console.log("TG send error:", String(e?.message || e));
  }
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

function platformApiUrl(apiPath) {
  if (!CONFIG.platformApiBaseUrl) return null;
  return new URL(apiPath, CONFIG.platformApiBaseUrl.replace(/\/+$/, '') + '/').toString();
}

async function platformPostJson(apiPath, body, timeoutMs = CONFIG.platformApiTimeoutMs) {
  const url = platformApiUrl(apiPath);
  if (!url || !CONFIG.voiceServiceToken) {
    throw new Error('Platform API integration is not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-voice-service-token': CONFIG.voiceServiceToken,
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });

    const text = await response.text();
    let json = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Platform API returned non-JSON response: ${text.slice(0, 300)}`);
      }
    }

    if (!response.ok) {
      const message = json?.message || json?.error || text.slice(0, 300) || `HTTP ${response.status}`;
      throw new Error(`Platform API request failed: ${message}`);
    }

    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function resolvePlatformProfile(meta) {
  if (!CONFIG.platformApiBaseUrl || !CONFIG.voiceServiceToken || (!meta?.did && !meta?.assistantProfileId)) {
    return null;
  }

  try {
    const payload = {
      uuid: meta.uuid || undefined,
      did: meta.did || undefined,
      callerId: meta.callerId || undefined,
      direction: meta.direction || undefined,
      assistantProfileId: meta.assistantProfileId || undefined,
      outboundContactId: meta.outboundContactId || undefined,
    };

    for (const key of Object.keys(payload)) {
      if (payload[key] == null || payload[key] === '') {
        delete payload[key];
      }
    }

    const response = await platformPostJson('/internal/voice/call/resolve', payload);

    return response?.profile || null;
  } catch (err) {
    logErr('[PLATFORM]', `resolve failed: ${String(err?.message || err)}`);
    return null;
  }
}

async function sendPlatformCallLog(payload) {
  if (!CONFIG.platformApiBaseUrl || !CONFIG.voiceServiceToken) {
    return null;
  }

  try {
    return await platformPostJson('/internal/voice/call/logs', payload, Math.max(CONFIG.platformApiTimeoutMs, 5000));
  } catch (err) {
    logErr('[PLATFORM]', `call log failed: ${String(err?.message || err)}`);
    return null;
  }
}

async function sendPlatformCalendarAction(payload) {
  if (!CONFIG.platformApiBaseUrl || !CONFIG.voiceServiceToken) {
    throw new Error('Platform API integration is not configured');
  }

  return platformPostJson(
      '/internal/voice/calendar/action',
      payload,
      Math.max(CONFIG.platformApiTimeoutMs, CONFIG.calendarToolTimeoutMs)
  );
}

let telegramBotUsername = '';
let telegramPollOffset = 0;
let telegramPollTimer = null;
let telegramPollRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanTelegramUsername(username) {
  const value = String(username || '').trim();
  return value ? value.replace(/^@+/, '') : '';
}

function parseTelegramStartToken(text) {
  const value = String(text || '').trim();
  const match = value.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  if (!match?.[1]) return '';
  return match[1].trim().split(/\s+/)[0] || '';
}

async function detectTelegramBotUsername() {
  if (telegramBotUsername || !CONFIG.telegramBotToken) {
    return telegramBotUsername;
  }

  try {
    const response = await tgFetch('getMe');
    if (response?.ok && response?.result?.username) {
      telegramBotUsername = cleanTelegramUsername(response.result.username);
      log('[TG]', `bot username @${telegramBotUsername}`);
    } else {
      logErr('[TG]', `getMe failed: ${JSON.stringify(response || {})}`);
    }
  } catch (err) {
    logErr('[TG]', `getMe failed: ${String(err?.message || err)}`);
  }

  return telegramBotUsername;
}

async function linkPlatformTelegramAccount({ linkToken, chatId, username }) {
  if (!CONFIG.platformApiBaseUrl || !CONFIG.voiceServiceToken) {
    throw new Error('Platform API integration is not configured');
  }

  const botUsername = await detectTelegramBotUsername();
  return platformPostJson(
      '/internal/voice/telegram/link',
      {
        linkToken,
        chatId: String(chatId),
        username: cleanTelegramUsername(username) || undefined,
        botUsername: botUsername || undefined,
      },
      Math.max(CONFIG.platformApiTimeoutMs, 5000)
  );
}

async function handleTelegramUpdate(update) {
  const message = update?.message;
  const text = message?.text || '';
  const linkToken = parseTelegramStartToken(text);
  const chatId = message?.chat?.id;

  if (!linkToken || !chatId) {
    return;
  }

  try {
    await linkPlatformTelegramAccount({
      linkToken,
      chatId,
      username: message?.from?.username || message?.chat?.username || '',
    });
    await sendTelegram('Telegram подключен. Теперь логи звонков будут приходить сюда.', chatId);
    log('[TG]', `linked chat=${chatId} token=${linkToken.slice(0, 6)}...`);
  } catch (err) {
    const messageText = String(err?.message || err);
    logErr('[TG]', `link failed: ${messageText}`);
    await sendTelegram('Не удалось подключить Telegram. Откройте сайт и нажмите подключение ещё раз.', chatId);
  }
}

async function pollTelegramUpdates() {
  if (telegramPollRunning) return;
  telegramPollRunning = true;

  try {
    const response = await tgFetch('getUpdates', {
      offset: telegramPollOffset || undefined,
      timeout: CONFIG.telegramLinkPollTimeoutSec,
      allowed_updates: ['message'],
    });

    if (!response?.ok) {
      throw new Error(JSON.stringify(response || {}));
    }

    for (const update of response.result || []) {
      telegramPollOffset = Math.max(telegramPollOffset, Number(update.update_id || 0) + 1);
      await handleTelegramUpdate(update);
    }
  } catch (err) {
    logErr('[TG]', `poll failed: ${String(err?.message || err)}`);
    await sleep(Math.max(1000, CONFIG.telegramLinkPollIntervalMs));
  } finally {
    telegramPollRunning = false;
  }
}

async function initializeTelegramPollOffset() {
  const response = await tgFetch('getUpdates', {
    timeout: 0,
    allowed_updates: ['message'],
  });

  if (!response?.ok) {
    throw new Error(JSON.stringify(response || {}));
  }

  const updates = response.result || [];
  if (updates.length > 0) {
    telegramPollOffset = Math.max(...updates.map((update) => Number(update.update_id || 0))) + 1;
    log('[TG]', `skipped ${updates.length} old updates`);
  }
}

function scheduleTelegramPolling(delayMs = 0) {
  if (telegramPollTimer) {
    clearTimeout(telegramPollTimer);
  }

  telegramPollTimer = setTimeout(async () => {
    await pollTelegramUpdates();
    scheduleTelegramPolling(CONFIG.telegramLinkPollIntervalMs);
  }, delayMs);
  telegramPollTimer.unref?.();
}

function startTelegramLinkPolling() {
  if (!CONFIG.telegramLinkPollingEnabled) {
    log('[TG]', 'link polling disabled');
    return;
  }
  if (!CONFIG.telegramBotToken) {
    logErr('[TG]', 'link polling skipped: TELEGRAM_BOT_TOKEN is empty');
    return;
  }
  if (!CONFIG.platformApiBaseUrl || !CONFIG.voiceServiceToken) {
    logErr('[TG]', 'link polling skipped: Platform API is not configured');
    return;
  }

  Promise.all([
    detectTelegramBotUsername(),
    initializeTelegramPollOffset(),
  ]).catch((err) => {
    logErr('[TG]', `poll init failed: ${String(err?.message || err)}`);
  }).finally(() => {
    scheduleTelegramPolling(500);
    log('[TG]', 'link polling started');
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

function getWavChunks(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Unsupported WAV file');
  }

  let fmt = null;
  let data = null;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + size;

    if (chunkEnd > buffer.length) break;

    if (id === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (id === 'data') {
      data = { offset: chunkStart, size };
    }

    offset = chunkEnd + (size % 2);
  }

  if (!fmt || !data) {
    throw new Error('WAV fmt/data chunks are missing');
  }

  return { fmt, data };
}

function createPlaybackWavFromStereo(stereoPath, playbackPath, options = {}) {
  const input = fs.readFileSync(stereoPath);
  const { fmt, data } = getWavChunks(input);

  if (fmt.audioFormat !== 1 || fmt.channels !== 2 || fmt.bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV format: format=${fmt.audioFormat}, channels=${fmt.channels}, bits=${fmt.bitsPerSample}`);
  }

  const callerGain = Number.isFinite(options.callerGain) ? options.callerGain : 1.35;
  const assistantGain = Number.isFinite(options.assistantGain) ? options.assistantGain : 1.0;
  const targetPeak = Math.max(0.1, Math.min(1, Number.isFinite(options.targetPeak) ? options.targetPeak : 0.9));
  const frameBytes = 4;
  const frames = Math.floor(data.size / frameBytes);
  const target = Math.floor(32767 * targetPeak);
  let peak = 0;

  for (let frame = 0; frame < frames; frame += 1) {
    const src = data.offset + frame * frameBytes;
    const left = input.readInt16LE(src);
    const right = input.readInt16LE(src + 2);
    const mixed = left * callerGain + right * assistantGain;
    peak = Math.max(peak, Math.abs(mixed));
  }

  const scale = peak > 0 ? Math.min(target / peak, 1.2) : 1;
  const output = Buffer.alloc(frames * 2);

  for (let frame = 0; frame < frames; frame += 1) {
    const src = data.offset + frame * frameBytes;
    const left = input.readInt16LE(src);
    const right = input.readInt16LE(src + 2);
    const mixed = Math.round((left * callerGain + right * assistantGain) * scale);
    output.writeInt16LE(clampPcm16(mixed), frame * 2);
  }

  const wav = openWav(playbackPath, fmt.sampleRate, 1);
  appendWav(wav, output);
  closeWav(wav);

  return { frames, peak: Math.round(peak), scale };
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

function getRawTranscriptStats(rawLog) {
  const lines = String(rawLog || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

  let userTurns = 0;
  let assistantTurns = 0;

  for (const line of lines) {
    if (/^User:\s*/i.test(line)) userTurns += 1;
    if (/^(Assi|Assistant):\s*/i.test(line)) assistantTurns += 1;
  }

  return {
    userTurns,
    assistantTurns,
    turns: userTurns + assistantTurns,
  };
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

function normalizeAssistantText(text) {
  return String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
}

function isAssistantFinalText(text) {
  const normalized = normalizeAssistantText(text);
  if (!normalized) return false;

  const closingPhrases = [
    '\u0445\u043e\u0440\u043e\u0448\u0435\u0433\u043e \u0434\u043d\u044f',
    '\u0445\u043e\u0440\u043e\u0448\u0435\u0433\u043e \u0432\u0435\u0447\u0435\u0440\u0430',
    '\u0434\u043e \u0441\u0432\u0438\u0434\u0430\u043d\u0438\u044f',
    '\u0432\u0441\u0435\u0433\u043e \u0434\u043e\u0431\u0440\u043e\u0433\u043e',
    '\u0436\u0434\u0435\u043c \u0432\u0430\u0441',
    '\u0436\u0434\u0451\u043c \u0432\u0430\u0441',
    '\u043c\u043e\u0436\u0435\u0442\u0435 \u0437\u0430\u0431\u0440\u0430\u0442\u044c',
    '\u0431\u0443\u0434\u0443 \u043d\u0430 \u0441\u0432\u044f\u0437\u0438',
    '\u043e\u0436\u0438\u0434\u0430\u0439\u0442\u0435 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u044f',
    '\u0435\u0441\u043b\u0438 \u0447\u0442\u043e \u0438\u0437\u043c\u0435\u043d\u0438\u0442\u0441\u044f',
  ];

  if (closingPhrases.some((phrase) => normalized.includes(phrase))) {
    return true;
  }

  const mentionsOrder = normalized.includes('\u0437\u0430\u043a\u0430\u0437');
  const orderDone =
      normalized.includes('\u043f\u0440\u0438\u043d\u044f\u0442') ||
      normalized.includes('\u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d') ||
      normalized.includes('\u0433\u043e\u0442\u043e\u0432');

  const mentionsAppointment =
      normalized.includes('\u0437\u0430\u043f\u0438\u0441') ||
      normalized.includes('\u0441\u0442\u0440\u0438\u0436') ||
      normalized.includes('\u0443\u0441\u043b\u0443\u0433');
  const appointmentDone =
      normalized.includes('\u0437\u0430\u0444\u0438\u043a\u0441\u0438\u0440\u043e\u0432\u0430\u043d') ||
      normalized.includes('\u0437\u0430\u043f\u0438\u0441\u044c \u0441\u0434\u0435\u043b\u0430\u043d') ||
      normalized.includes('\u0437\u0430\u043f\u0438\u0441\u0430\u043d') ||
      normalized.includes('\u043e\u0442\u043c\u0435\u043d\u0435\u043d') ||
      normalized.includes('\u043e\u0442\u043c\u0435\u043d\u0438\u043b') ||
      normalized.includes('\u043f\u0435\u0440\u0435\u043d\u0435\u0441');

  return (mentionsOrder && orderDone) || (mentionsAppointment && appointmentDone);
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

// ---------- Resampling ----------

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
        'Говори кратко и по делу. Это платный телефонный звонок: береги секунды клиента. ' +
        'Отвечай одним коротким предложением до 12 слов, кроме финального итога. ' +
        'Не перечисляй длинные списки, не растягивай ответ и не произноси служебные фразы. ' +
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
  const byPlatform = meta?.platformProfile || null;

  return {
    ...base,
    ...defaults,
    ...byDid,
    ...byClientId,
    ...byPlatform,
    turnDetection: {
      ...base.turnDetection,
      ...(defaults.turnDetection || {}),
      ...(byDid?.turnDetection || {}),
      ...(byClientId?.turnDetection || {}),
      ...(byPlatform?.turnDetection || {}),
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
    direction: meta.direction ? String(meta.direction).toUpperCase() : null,
    outboundContactId: meta.outboundContactId ? String(meta.outboundContactId) : null,
    assistantProfileId: meta.assistantProfileId ? String(meta.assistantProfileId) : null,
    channel: meta.channel ? String(meta.channel) : null,
    accountId: meta.accountId ? String(meta.accountId) : null,
    note: meta.note ? String(meta.note) : null,
    platformProfile: meta.platformProfile || null,
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

// ---------- Outbound dialer ----------

const outboundInFlight = new Map();
let outboundDialerTimer = null;
let outboundDialerRunning = false;

function execCommand(command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function callFileValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function normalizeDialPhone(value) {
  return String(value || '').replace(/\D+/g, '').slice(0, 20);
}

function getQueuedCallDirection(profile) {
  return String(profile?.direction || 'OUTBOUND').toUpperCase() === 'INBOUND' ? 'INBOUND' : 'OUTBOUND';
}

async function requestPlatformOutboundJob() {
  if (!CONFIG.platformApiBaseUrl || !CONFIG.voiceServiceToken) return null;
  const response = await platformPostJson(
      '/internal/voice/outbound/next',
      {},
      Math.max(CONFIG.platformApiTimeoutMs, 5000)
  );
  if (!response?.job || !response?.profile) return null;
  return { job: response.job, profile: response.profile };
}

async function releasePlatformOutboundJob(outboundContactId, reason) {
  if (!outboundContactId || !CONFIG.platformApiBaseUrl || !CONFIG.voiceServiceToken) return null;
  return platformPostJson(
      '/internal/voice/outbound/release',
      { outboundContactId, reason },
      Math.max(CONFIG.platformApiTimeoutMs, 5000)
  ).catch((err) => {
    logErr('[OUTBOUND]', `release failed: ${String(err?.message || err)}`);
    return null;
  });
}

function buildOutboundCallFile({ uuid, phone, profile, job }) {
  const direction = getQueuedCallDirection(profile);
  const callerId = normalizeDialPhone(CONFIG.outboundCallerId || profile.outboundCallerId || profile.reservedNumber?.number || '');
  const did = callerId || 'outbound';
  const channel = `${CONFIG.outboundTrunk}:${phone}@sip.novofon.ru`;
  const callerIdLine = callerId
      ? `"${callFileValue(profile.clientName || 'AI Secretary')}" <${callerId}>`
      : `"${callFileValue(profile.clientName || 'AI Secretary')}" <${phone}>`;

  return [
    `Channel: ${channel}`,
    `CallerID: ${callerIdLine}`,
    'MaxRetries: 0',
    'RetryTime: 60',
    `WaitTime: ${Math.max(10, CONFIG.outboundWaitTimeSec)}`,
    `Context: ${CONFIG.outboundContext}`,
    `Extension: ${CONFIG.outboundExtension}`,
    'Priority: 1',
    'Archive: yes',
    `Setvar: AI_UUID=${uuid}`,
    `Setvar: AI_DID=${did}`,
    `Setvar: AI_CALLER=${phone}`,
    `Setvar: AI_DIRECTION=${direction}`,
    `Setvar: AI_OUTBOUND_CONTACT_ID=${callFileValue(job.id)}`,
    `Setvar: AI_ASSISTANT_PROFILE_ID=${callFileValue(profile.assistantProfileId || '')}`,
    `Setvar: AI_CLIENT_ID=${callFileValue(profile.clientId || '')}`,
    '',
  ].join('\n');
}

async function installOutboundCallFile(fileName, content) {
  const tmpPath = path.join('/tmp', fileName);
  const destPath = path.join(CONFIG.asteriskOutgoingDir, fileName);
  fs.writeFileSync(tmpPath, content, 'utf8');
  await execCommand(`sudo /usr/bin/install -o asterisk -g asterisk -m 0640 ${shellQuote(tmpPath)} ${shellQuote(destPath)}`);
  fs.unlink(tmpPath, () => {});
  return destPath;
}

function parseArchivedCallStatus(text) {
  const match = String(text || '').match(/^Status:\s*(.+)$/mi);
  return match ? match[1].trim() : '';
}

async function scanOutboundDoneFiles() {
  for (const [uuid, item] of [...outboundInFlight.entries()]) {
    const donePath = path.join(CONFIG.asteriskOutgoingDoneDir, item.fileName);
    if (!fs.existsSync(donePath)) {
      if (Date.now() - item.createdAt > Math.max(120000, (CONFIG.outboundWaitTimeSec + 90) * 1000)) {
        outboundInFlight.delete(uuid);
        await releasePlatformOutboundJob(item.job.id, 'outbound call file timed out');
      }
      continue;
    }

    let status = '';
    try {
      status = parseArchivedCallStatus(fs.readFileSync(donePath, 'utf8'));
    } catch (err) {
      logErr('[OUTBOUND]', `failed to read archived call file ${donePath}: ${err.message}`);
    }

    outboundInFlight.delete(uuid);
    log('[OUTBOUND]', `archived uuid=${uuid} contact=${item.job.id} status=${status || '-'}`);

    if (/failed|expired/i.test(status)) {
      const direction = getQueuedCallDirection(item.profile);
      await sendPlatformCallLog({
        assistantProfileId: item.profile.assistantProfileId,
        outboundContactId: item.job.id,
        direction,
        customerPhone: item.job.phone,
        status: 'MISSED',
        durationSeconds: 0,
        summary: `${direction === 'INBOUND' ? 'Inbound test call' : 'Outbound call'} was not answered or failed before AI conversation. Asterisk status: ${status || 'unknown'}.`,
      });
    }
  }
}

async function outboundDialerTick() {
  if (outboundDialerRunning) return;
  outboundDialerRunning = true;

  try {
    await scanOutboundDoneFiles();

    while (outboundInFlight.size < Math.max(1, CONFIG.outboundMaxConcurrent)) {
      const next = await requestPlatformOutboundJob();
      if (!next) break;

      const { job, profile } = next;
      const phone = normalizeDialPhone(job.phone);
      if (!phone) {
        await releasePlatformOutboundJob(job.id, 'invalid phone');
        continue;
      }

      const uuid = crypto.randomUUID();
      const normalizedUuid = normalizeUuid(uuid);
      const did = normalizeDialPhone(CONFIG.outboundCallerId || profile.outboundCallerId || profile.reservedNumber?.number || '') || 'outbound';
      const direction = getQueuedCallDirection(profile);
      const meta = {
        uuid,
        did,
        callerId: phone,
        clientId: profile.clientId || profile.assistantProfileId,
        assistantProfileId: profile.assistantProfileId,
        direction,
        outboundContactId: job.id,
        platformProfile: profile,
        note: 'outbound_dialer',
      };

      putCallMeta(meta);

      const fileName = `ai-secretary-${safeName(job.id)}-${normalizedUuid}.call`;
      const content = buildOutboundCallFile({ uuid, phone, profile, job });

      try {
        await installOutboundCallFile(fileName, content);
        outboundInFlight.set(normalizedUuid, {
          fileName,
          job: { ...job, phone },
          profile,
          createdAt: Date.now(),
        });
        log('[OUTBOUND]', `queued contact=${job.id} phone=${phone} uuid=${uuid}`);
      } catch (err) {
        callRegistry.delete(normalizedUuid);
        logErr('[OUTBOUND]', `failed to install call file for ${phone}: ${String(err?.message || err)}`);
        await releasePlatformOutboundJob(job.id, 'failed to create Asterisk call file');
      }
    }
  } catch (err) {
    logErr('[OUTBOUND]', String(err?.message || err));
  } finally {
    outboundDialerRunning = false;
  }
}

function scheduleOutboundDialer(delayMs = CONFIG.outboundDialerIntervalMs) {
  if (outboundDialerTimer) clearTimeout(outboundDialerTimer);
  outboundDialerTimer = setTimeout(() => {
    outboundDialerTick().finally(() => scheduleOutboundDialer());
  }, Math.max(1000, delayMs));
  outboundDialerTimer.unref?.();
}

function startOutboundDialer() {
  if (!CONFIG.outboundDialerEnabled) {
    log('[OUTBOUND]', 'dialer disabled');
    return;
  }
  if (!CONFIG.platformApiBaseUrl || !CONFIG.voiceServiceToken) {
    logErr('[OUTBOUND]', 'dialer requires Platform API integration');
    return;
  }
  log('[OUTBOUND]', `dialer enabled interval=${CONFIG.outboundDialerIntervalMs}ms max=${CONFIG.outboundMaxConcurrent}`);
  scheduleOutboundDialer(1000);
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
      const existing = getCallMeta(body.uuid);
      const platformProfile = existing?.platformProfile || await resolvePlatformProfile(body) || null;
      const mergedBody = {
        ...(existing?.raw || {}),
        ...body,
        uuid: body.uuid || existing?.uuid,
        did: body.did || existing?.did,
        callerId: body.callerId || existing?.callerId,
        clientId: body.clientId || existing?.clientId,
        direction: body.direction || existing?.direction,
        outboundContactId: body.outboundContactId || existing?.outboundContactId,
        assistantProfileId: body.assistantProfileId || existing?.assistantProfileId,
        channel: body.channel || existing?.channel,
        accountId: body.accountId || existing?.accountId,
        note: body.note || existing?.note,
      };
      if (platformProfile) {
        mergedBody.platformProfile = platformProfile;
        mergedBody.clientId = mergedBody.clientId || platformProfile.clientId || platformProfile.assistantProfileId;
        mergedBody.assistantProfileId = mergedBody.assistantProfileId || platformProfile.assistantProfileId;
        mergedBody.direction = mergedBody.direction || platformProfile.direction;
        mergedBody.outboundContactId = mergedBody.outboundContactId || platformProfile.outboundContact?.id;
      }

      if (!putCallMeta(mergedBody)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'uuid required' }));
        return;
      }

      const saved = getCallMeta(mergedBody.uuid);
      const platformAction = String(platformProfile?.action || '').toUpperCase();
      const startAction = platformAction === 'HANGUP' ? 'HANGUP' : 'OK';
      log('[META]', `saved uuid=${saved?.uuid || '-'} did=${saved?.did || '-'} callerId=${saved?.callerId || '-'} clientId=${saved?.clientId || '-'} platform=${platformProfile ? 'yes' : 'no'}`);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(startAction);
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
Русский телефонный разговор с AI-секретарём.
Ожидаются короткие ответы, имена, телефоны, адреса, названия компаний, услуг, товаров, дат и времени.
Сохраняй короткие русские ответы как короткие ответы: да, нет, ага, алло, повтори, тот же номер.
Не заменяй слова из сценария случайными фамилиями или похожими по звучанию словами.
`.trim();

const SECRETARY_RUNTIME_INSTRUCTIONS = `
ОПЕРАЦИОННЫЕ ПРАВИЛА AI-СЕКРЕТАРЯ:
- Следуй сценарию профиля, который пришёл из сайта, и не придумывай бизнес-правила вне этого сценария.
- Задавай только один уточняющий вопрос за раз.
- Если нужно имя и подтверждение номера, сначала спроси имя. После ответа клиента отдельно уточни номер.
- Если ты только что попросил имя, а клиент ответил коротким словом, принимай его как имя только если это похоже на имя.
- Не считай именем служебные слова связи и реакции: "алло", "ой", "да", "нет", "ага", "повтори", "не слышу", "связь оборвалась".
- Если короткий ответ похож на редкое имя, например "Алли", принимай его как имя. Если сомневаешься, уточни: "Как вас записать?"
- Не начинай длинный ответ со служебных фраз вроде "сейчас уточню", если можно сразу дать полезный ответ.
- Если ответ получается длинным, разбей его на короткое подтверждение и один короткий вопрос.
- Если клиент отвечает "да", "ага", "верно", "всё хорошо" после вопроса подтверждения, считай это подтверждением.
- Не диктуй номер телефона клиента по цифрам без прямой просьбы. Для подтверждения номера спрашивай: "Подтверждаете номер, с которого звоните?"
- Если клиент сам просит продиктовать номер, произнеси все цифры полностью и в конце добавь "верно?".
- Если разговор зашёл в тупик или клиент явно просит человека, используй доступные правила переадресации.
- Не говори от женского лица, если выбран мужской или нейтральный голос. Не используй женские формы вроде "готова", "записала", "передала", "администраторша", если профиль явно не требует женский голос и женскую роль.
- Если пол роли не задан явно, говори нейтрально: "могу помочь", "запись сделана", "уточню". Не называй себя девушкой, женщиной, администраторшей или мастерицей.
- Телефонный эконом-режим: каждый ответ максимум одно короткое предложение до 12 слов, кроме финального итога.
- Не произноси фразы-заполнители: "давайте аккуратно", "сейчас подумаю", "важный момент", "секунду", "сейчас уточню", если можно сразу спросить или ответить.
- При записи спрашивай только недостающий обязательный факт: услугу, дату, время, имя или подтверждение номера.
- При переносе записи не выясняй услугу и мастера заново, если уже известны старая дата/время, новая дата/время и имя или номер клиента.
- Если клиент просит создать, перенести или отменить запись, собери минимально нужные данные, затем действуй как полноценный секретарь: подтверждай итог клиенту без фраз "передам владельцу", "ожидайте подтверждения", "запрос на подтверждение".
- Не отправляй владельцу для подтверждения обычные записи, переносы и отмены, если в сценарии есть расписание или подключён календарь. Передача владельцу нужна только для тупика, явной просьбы поговорить с человеком или нестандартной ситуации вне сценария.
- По завершении записи, переноса или отмены скажи один короткий итог и заверши разговор фразой: "Запись сделана", "Запись отменена", "Запись перенесена" или "Ждём вас".
`.trim();

const MASCULINE_OR_NEUTRAL_VOICES = new Set(['alloy', 'ash', 'ballad', 'echo', 'sage', 'verse', 'cedar']);

function buildVoicePersonaInstruction(voice) {
  const normalizedVoice = String(voice || '').trim().toLowerCase();

  if (MASCULINE_OR_NEUTRAL_VOICES.has(normalizedVoice)) {
    return [
      `Выбран голос "${normalizedVoice}". Он должен звучать как мужской или нейтральный AI-секретарь.`,
      'Говори от мужского лица или безлично-нейтрально.',
      'Запрещено использовать женские формы и женскую роль: "готова", "записала", "передала", "администраторша", "девушка", "мастерица".',
    ].join(' ');
  }

  return [
    `Выбран голос "${normalizedVoice || 'default'}".`,
    'Сохраняй роль AI-секретаря последовательной и не меняй пол роли внутри разговора.',
    'Если профиль не задаёт пол явно, говори нейтрально и избегай гендерных форм.',
  ].join(' ');
}

function getClientTimeZone(clientCfg) {
  return String(clientCfg?.account?.timeZone || clientCfg?.timeZone || 'Europe/Moscow').trim() || 'Europe/Moscow';
}

function isCalendarToolEnabled(clientCfg) {
  return String(clientCfg?.account?.google?.status || '').toUpperCase() === 'CONNECTED';
}

function getReferenceLocalDateTime(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second} ${timeZone}`;
  } catch {
    return new Date().toISOString();
  }
}

function buildCalendarToolInstruction(clientCfg) {
  if (!isCalendarToolEnabled(clientCfg)) return '';

  const timeZone = getClientTimeZone(clientCfg);
  return [
    'У тебя подключён инструмент Google Calendar callsec_calendar_action.',
    `Рабочая временная зона клиента: ${timeZone}. Текущее локальное время: ${getReferenceLocalDateTime(timeZone)}.`,
    'Когда клиент хочет создать, перенести или отменить запись, сначала собери только минимально нужные данные.',
    'Для CREATE нужны услуга, дата, время, имя и подтверждение номера.',
    'Для RESCHEDULE нужны старая дата/время, новая дата/время, имя или подтверждённый номер. Не спрашивай услугу и мастера заново, если можно найти старую запись по телефону и времени.',
    'Для CANCEL нужны старая дата/время или дата, имя или подтверждённый номер.',
    'Перед словами "запись создана", "запись перенесена" или "запись отменена" обязательно вызови callsec_calendar_action и дождись результата. Без успешного результата инструмента запрещено подтверждать успех.',
    'Если клиент говорит "перенести", "перенос", "поменять время" или "сдвинуть", действие всегда RESCHEDULE, никогда CREATE.',
    'Для CREATE передавай startDateTime и endDateTime в ISO 8601 с UTC offset. Для RESCHEDULE передавай старое время в targetStartDateTime или targetDate и новое время в startDateTime/endDateTime. Для CANCEL передавай targetStartDateTime или targetDate.',
    'Если инструмент вернул conflict, скажи, что это время занято, и попроси другое время. Если not_found, уточни дату, время или имя. Если created, cancelled или rescheduled, подтверди результат коротко.',
    'Не говори "передам владельцу", "ожидайте подтверждения" или "запрос зафиксирован" для обычных календарных действий.',
  ].join(' ');
}

function buildCalendarToolDefinition() {
  return {
    type: 'function',
    name: 'callsec_calendar_action',
    description: [
      'Create, cancel, or reschedule an appointment in the connected Google Calendar.',
      'Call this only after collecting the required appointment details and before confirming success to the caller.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['CREATE', 'CANCEL', 'RESCHEDULE'],
          description: 'Calendar action to perform.',
        },
        title: {
          type: 'string',
          description: 'Short appointment title, for example "Мужская стрижка". Omit if unknown.',
        },
        customerName: {
          type: 'string',
          description: 'Customer name. Omit if unknown.',
        },
        reason: {
          type: 'string',
          description: 'Service or reason for the appointment. Omit if unknown.',
        },
        targetStartDateTime: {
          type: 'string',
          description: 'Existing appointment start time for CANCEL or RESCHEDULE, ISO 8601 with UTC offset. Omit if unknown.',
        },
        targetDate: {
          type: 'string',
          description: 'Existing appointment date as YYYY-MM-DD when exact time is unknown. Omit if unknown.',
        },
        startDateTime: {
          type: 'string',
          description: 'New appointment start time for CREATE or RESCHEDULE, ISO 8601 with UTC offset. Omit if not applicable.',
        },
        endDateTime: {
          type: 'string',
          description: 'New appointment end time for CREATE or RESCHEDULE, ISO 8601 with UTC offset. Omit if unknown.',
        },
      },
      required: ['action'],
    },
  };
}

function buildSessionUpdate(clientCfg, callMeta) {
  const callerNumber = String(callMeta?.callerId || '').trim();
  const direction = String(clientCfg.direction || callMeta?.direction || 'INBOUND').toUpperCase();
  const contactName = String(clientCfg?.outboundContact?.name || '').trim();
  const callerInstruction = callerNumber
      ? direction === 'OUTBOUND'
          ? `\n- Это исходящий звонок. Номер клиента, которому звоним: ${callerNumber}${contactName ? `. Имя контакта: ${contactName}` : ''}.`
          : `\n- Номер телефона, с которого звонят: ${callerNumber}. Используй его как внутренний факт для записи. Не диктуй его по цифрам без прямой просьбы клиента; для подтверждения спроси: "Подтверждаете номер, с которого звоните?"`
      : '';
  const directionInstruction = direction === 'OUTBOUND'
      ? 'Это исходящий звонок от AI-секретаря. Сначала коротко представься по greetingText, уточни, удобно ли говорить, затем действуй по сценарию пользователя. Не говори, что клиент сам позвонил.'
      : '';
  const runtimeInstructions = [
    clientCfg.instructions,
    SECRETARY_RUNTIME_INSTRUCTIONS,
    buildCalendarToolInstruction(clientCfg),
    buildVoicePersonaInstruction(clientCfg.voice),
    directionInstruction,
    callerInstruction.trim(),
  ].filter(Boolean).join('\n\n');
  const inputTranscription = {
    model: clientCfg.transcriptionModel,
    language: clientCfg.language,
  };

  const transcriptionPrompt = clientCfg.transcriptionPrompt || DEFAULT_TRANSCRIPTION_PROMPT;

  if (transcriptionPrompt) {
    inputTranscription.prompt = clampTranscriptionPrompt(transcriptionPrompt);
  }

  const tools = isCalendarToolEnabled(clientCfg) ? [buildCalendarToolDefinition()] : [];
  const session = {
    type: 'realtime',
    output_modalities: ['audio'],
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
      output: {
        format: {
          type: 'audio/pcm',
          rate: CONFIG.modelSampleRate,
        },
        voice: clientCfg.voice,
        speed: 1.0,
      },
    },
    truncation: 'auto',
  };

  if (tools.length > 0) {
    session.tools = tools;
    session.tool_choice = 'auto';
  }

  return {
    type: 'session.update',
    session,
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
  let skipFinalCallLog = false;
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
  let pendingFinalHangupReason = null;
  let finalHangupTimer = null;
  let assistantPlaybackUntil = 0;
  let lastInputLevel = 0;
  const handledToolCallIds = new Set();
  const functionCallNames = new Map();

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
    direction: null,
    outboundContactId: null,
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
    platform: {
      assistantProfileId: null,
      logStatus: 'pending',
      logId: null,
      logError: null,
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
    summary.escalated = true;
    summary.escalationReason = reason;
    const cliCommand = `channel redirect ${ch} ${CONFIG.forwardContext},${forwardPhone},1`;
    exec(`/usr/bin/sudo /usr/sbin/asterisk -rx ${shellQuote(cliCommand)}`, (err, stdout, stderr) => {
      if (err) {
        logErr('[FWD]', `redirect failed: ${err.message}`);
        return;
      }

      log('[FWD]', `redirect sent for ${ch} to ${forwardPhone} (${reason})`);
      if (stdout?.trim()) log('[FWD]', stdout.trim());
      if (stderr?.trim()) logErr('[FWD]', stderr.trim());
    });
  }

  function requestCallHangup(reason = 'manual', options = {}) {
    if (closed) {
      log('[HANGUP]', `skip hangup (${reason}): call already closed`);
      return;
    }

    if (options.skipFinalLog !== false) {
      skipFinalCallLog = true;
    }
    const ch = meta?.channel;
    if (!ch) {
      log('[HANGUP]', `no channel in metadata; closing AudioSocket only (${reason})`);
      socket.destroy();
      return;
    }

    const cliCommand = `channel request hangup ${ch}`;
    exec(`/usr/bin/sudo /usr/sbin/asterisk -rx ${shellQuote(cliCommand)}`, (err, stdout, stderr) => {
      if (err) {
        logErr('[HANGUP]', `hangup failed: ${err.message}`);
        socket.destroy();
        return;
      }

      log('[HANGUP]', `hangup requested for ${ch} (${reason})`);
      if (stdout?.trim()) log('[HANGUP]', stdout.trim());
      if (stderr?.trim()) logErr('[HANGUP]', stderr.trim());
      socket.end();
    });
  }

  function scheduleFinalHangupAfterPlayback(reason = 'assistant_completed') {
    if (closed || finalHangupTimer) return;

    pendingFinalHangupReason = null;
    const waitForPlaybackMs = Math.max(0, assistantPlaybackUntil - Date.now());
    const delayMs = Math.max(CONFIG.finalHangupDelayMs, waitForPlaybackMs + CONFIG.finalHangupDelayMs);

    log('[HANGUP]', `scheduled after final assistant phrase in ${delayMs}ms (${reason})`);
    finalHangupTimer = setTimeout(() => {
      outboundTimers.delete(finalHangupTimer);
      finalHangupTimer = null;
      requestCallHangup(reason, { skipFinalLog: false });
    }, delayMs);
    finalHangupTimer.unref?.();
    outboundTimers.add(finalHangupTimer);
  }

  function getPlatformAction() {
    return String(clientCfg?.action || meta?.platformProfile?.action || '').toUpperCase();
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
    summary.direction = clientCfg.direction || meta?.direction || 'INBOUND';
    summary.outboundContactId = clientCfg?.outboundContact?.id || meta?.outboundContactId || null;
    summary.model = clientCfg.realtimeModel || CONFIG.realtimeModel;
    summary.voice = clientCfg.voice;
    summary.platform.assistantProfileId = clientCfg.assistantProfileId || null;

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

  function telegramTargetForCall() {
    return (
        clientCfg?.account?.telegram?.chatId ||
        clientCfg?.account?.telegram?.username ||
        CONFIG.telegramChatId
    );
  }

  async function persistPlatformCallLog(transcriptText, status) {
    const assistantProfileId = clientCfg.assistantProfileId || summary.platform.assistantProfileId || null;
    const direction = String(clientCfg.direction || meta?.direction || summary.direction || 'INBOUND').toUpperCase() === 'OUTBOUND'
        ? 'OUTBOUND'
        : 'INBOUND';
    const outboundContactId = clientCfg?.outboundContact?.id || meta?.outboundContactId || summary.outboundContactId || null;
    if (!assistantProfileId && !summary.did) {
      return;
    }

    const durationSeconds = Math.max(0, Math.ceil((summary.durationMs || (ts() - startedAt)) / 1000));
    const recordingUrl = sessionDir && summary.recordings.playback
        ? path.join(sessionDir, summary.recordings.playback)
        : sessionDir && summary.recordings.talk
        ? path.join(sessionDir, summary.recordings.talk)
        : sessionDir && summary.recordings.caller
            ? path.join(sessionDir, summary.recordings.caller)
            : undefined;

    const response = await sendPlatformCallLog({
      assistantProfileId,
      did: summary.did || undefined,
      outboundContactId: outboundContactId || undefined,
      direction,
      customerPhone: summary.callerId || 'unknown',
      status,
      durationSeconds,
      summary: status === 'ESCALATED'
          ? `Call was escalated to the account owner. Direction ${direction}, DID ${summary.did || '-'}, caller ${summary.callerId || '-'}.`
          : `Call was handled by the AI secretary. Direction ${direction}, DID ${summary.did || '-'}, caller ${summary.callerId || '-'}.`,
      transcript: transcriptText || undefined,
      recordingUrl,
    });

    if (response?.log?.id) {
      summary.platform.logStatus = 'ok';
      summary.platform.logId = response.log.id;
      summary.platform.logError = null;
      persistMeta();
    } else {
      summary.platform.logStatus = 'failed';
      summary.platform.logError = 'Platform API did not return a call log id';
      persistMeta();
      throw new Error(summary.platform.logError);
    }
  }

  async function persistPlatformCallLogOrSendTelegramFallback(transcriptText, status, fallbackSuffix = '') {
    try {
      await persistPlatformCallLog(transcriptText, status);
    } catch (err) {
      const message = String(err?.message || err);
      logErr('[POSTCALL]', `platform log failed, sending Telegram fallback: ${message}`);
      const fallbackText = fallbackSuffix
          ? `${transcriptText}\n\n${fallbackSuffix}`
          : transcriptText;
      await sendTelegram(fallbackText, telegramTargetForCall());
    }
  }

  function sendFinalCallLog(rawLog) {
    const realtimeLog = String(rawLog || '').trim();
    const fallbackText = `call end\n${realtimeLog}`.trimEnd();
    const rawStats = getRawTranscriptStats(realtimeLog);

    if (realtimeTranscriptTextPath) {
      fs.writeFileSync(realtimeTranscriptTextPath, fallbackText + '\n', 'utf8');
    }

    if (rawStats.userTurns === 0 || rawStats.turns < CONFIG.postCallLogMinRawTurns) {
      summary.logs.processedStatus = 'skipped';
      summary.logs.processedError = `not enough realtime transcript turns: user=${rawStats.userTurns}, assistant=${rawStats.assistantTurns}`;
      summary.logs.processedAt = nowIso();
      if (processedTranscriptPath) {
        fs.writeFileSync(processedTranscriptPath, fallbackText + '\n', 'utf8');
      }
      persistMeta();
      persistPlatformCallLogOrSendTelegramFallback(fallbackText, redirectRequested ? 'ESCALATED' : 'SUCCESS')
          .catch((err) => logErr('[POSTCALL]', `fallback post-call handling failed: ${String(err?.message || err)}`));
      return;
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
      await persistPlatformCallLogOrSendTelegramFallback(telegramText, redirectRequested ? 'ESCALATED' : 'SUCCESS');
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
      await persistPlatformCallLogOrSendTelegramFallback(
          fallbackText,
          redirectRequested ? 'ESCALATED' : 'SUCCESS',
          `[post-call log processing failed: ${message}]`
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
    pendingFinalHangupReason = null;
    finalHangupTimer = null;
    outboundQueue = [];
    outboundAssemble = Buffer.alloc(0);
    assistantPlaybackUntil = 0;

    for (const t of outboundTimers) clearTimeout(t);
    outboundTimers.clear();

    outboundGeneration += 1;
    outboundPumping = false;

    log('[AUDIO-OUT]', `${reason}; generation=${outboundGeneration}`);
  }

  function queuePcm8ToAsterisk(pcm8) {
    if (!pcm8?.length || closed) return;

    outboundAssemble = outboundAssemble.length
        ? Buffer.concat([outboundAssemble, pcm8])
        : Buffer.from(pcm8);

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

  function parseToolArguments(rawArguments) {
    if (!rawArguments) return {};
    if (typeof rawArguments === 'object') return rawArguments;

    try {
      return JSON.parse(String(rawArguments));
    } catch (err) {
      throw new Error(`invalid tool arguments: ${err.message}`);
    }
  }

  function normalizeCalendarToolArgs(args) {
    const action = String(args?.action || '').toUpperCase();
    const allowed = new Set(['CREATE', 'CANCEL', 'RESCHEDULE']);
    const normalized = {
      action: allowed.has(action) ? action : 'NONE',
    };

    for (const key of [
      'title',
      'customerName',
      'reason',
      'targetStartDateTime',
      'targetDate',
      'startDateTime',
      'endDateTime',
    ]) {
      const value = args?.[key];
      if (value != null && String(value).trim()) {
        normalized[key] = String(value).trim();
      }
    }

    return normalized;
  }

  function buildCalendarToolFailureOutput(message) {
    return {
      ok: false,
      result: {
        status: 'error',
        reason: message || 'CALENDAR_TOOL_FAILED',
      },
      assistantInstruction: [
        'Календарное действие сейчас не удалось выполнить технически.',
        'Коротко извинись, не подтверждай запись/отмену/перенос как выполненные, уточни данные или предложи другое время.',
        'Владельцу передавай только если клиент явно просит человека.',
      ].join(' '),
    };
  }

  function extractFunctionCall(evt) {
    const item = evt?.item || evt;
    const callId = evt?.call_id || item?.call_id;
    const name = evt?.name || item?.name || functionCallNames.get(callId);
    const rawArguments = evt?.arguments || item?.arguments;

    if (name !== 'callsec_calendar_action' || !callId) {
      return null;
    }

    return { callId, rawArguments };
  }

  async function handleCalendarToolCall(evt) {
    const call = extractFunctionCall(evt);
    if (!call || handledToolCallIds.has(call.callId)) return;
    handledToolCallIds.add(call.callId);

    let output;
    try {
      const args = normalizeCalendarToolArgs(parseToolArguments(call.rawArguments));
      if (args.action === 'NONE') {
        throw new Error('missing or unsupported calendar action');
      }
      if (!clientCfg.assistantProfileId) {
        throw new Error('assistant profile id is missing');
      }

      log('[CAL]', `tool call ${call.callId} ${JSON.stringify(args)}`);

      output = await sendPlatformCalendarAction({
        assistantProfileId: clientCfg.assistantProfileId,
        callUuid: uuidHex || undefined,
        customerPhone: meta?.callerId || '',
        direction: clientCfg.direction || meta?.direction || 'INBOUND',
        transcript: totalTextSpeech.slice(-30_000),
        action: args,
      });

      log('[CAL]', `tool result ${call.callId} ${JSON.stringify(output?.result || output)}`);
    } catch (err) {
      output = buildCalendarToolFailureOutput(String(err?.message || err));
      logErr('[CAL]', `tool failed ${call.callId}: ${String(err?.message || err)}`);
    }

    safeWsSend({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: call.callId,
        output: JSON.stringify(output),
      },
    });

    safeWsSend({
      type: 'response.create',
      response: {
        instructions: output?.assistantInstruction || 'Коротко сообщи клиенту результат календарного действия.',
        max_output_tokens: clientCfg.maxResponseOutputTokens,
      },
    });
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

    clearOutboundAudio('cleanup');

    if (handshakeTimer) clearTimeout(handshakeTimer);

    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    } catch {}

    flushTalkAssistantTail();
    closeWav(callerWav);
    closeWav(assistantWav);
    closeWav(talkWav);

    if (CONFIG.recordPlaybackWav && sessionDir && summary.recordings.talk) {
      const stereoPath = path.join(sessionDir, summary.recordings.talk);
      const playbackName = 'talk_8k_playback.wav';
      const playbackPath = path.join(sessionDir, playbackName);

      try {
        const playback = createPlaybackWavFromStereo(stereoPath, playbackPath, {
          callerGain: CONFIG.playbackCallerGain,
          assistantGain: CONFIG.playbackAssistantGain,
          targetPeak: CONFIG.playbackTargetPeak,
        });
        summary.recordings.playback = playbackName;
        log('[REC]', `playback ${playbackName} frames=${playback.frames} scale=${playback.scale.toFixed(3)}`);
      } catch (err) {
        logErr('[REC]', `playback mix failed: ${String(err?.message || err)}`);
      }
    }

    persistMeta();

    if (!skipFinalCallLog) {
      const finalizeTimer = setTimeout(() => {
        const finalRawLog = totalTextSpeech;
        totalTextSpeech = "";
        sendFinalCallLog(finalRawLog);
      }, Math.max(0, CONFIG.postCallLogFinalizeDelayMs));
      finalizeTimer.unref?.();
    } else {
      log('[POSTCALL]', `skipped final log: ${closeReason}`);
    }

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
    const realtimeModel = clientCfg.realtimeModel || CONFIG.realtimeModel;
    ws = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel)}`,
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
          log('[OA]', `response.created ${currentResponseId || ''}`.trim());
          break;

        case 'response.output_item.added':
        case 'conversation.item.created':
          if (evt.item?.type === 'function_call' && evt.item.call_id && evt.item.name) {
            functionCallNames.set(evt.item.call_id, evt.item.name);
          }
          break;

        case 'response.function_call_arguments.done':
          void handleCalendarToolCall(evt);
          break;

        case 'response.output_item.done':
          if (evt.item?.type === 'function_call') {
            void handleCalendarToolCall(evt);
          }
          break;

        case 'response.output_audio.delta': {
          if (!evt.delta || closed) break;
          const pcm24 = Buffer.from(evt.delta, 'base64');
          summary.pcm24BytesFromOpenAI += pcm24.length;

          const pcm8 = downsample24to8(pcm24);
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
            } else if (isAssistantFinalText(text)) {
              pendingFinalHangupReason = 'assistant_completed';
              log('[HANGUP]', 'final assistant phrase detected');
              if (responseAudioDone) {
                scheduleFinalHangupAfterPlayback(pendingFinalHangupReason);
              }
            }
          }
          break;
        }

        case 'response.output_audio.done':
          flushOutboundTail();
          log('[OA]', 'output_audio.done');
          if (pendingFinalHangupReason) {
            scheduleFinalHangupAfterPlayback(pendingFinalHangupReason);
          }
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

        if (getPlatformAction() === 'HANGUP') {
          summary.uuid = uuidHex;
          summary.did = meta?.did || null;
          summary.callerId = meta?.callerId || null;
          summary.clientId = meta?.clientId || clientCfg.clientId || null;
          summary.direction = clientCfg.direction || meta?.direction || 'INBOUND';
          summary.closeReason = clientCfg.reason || meta?.platformProfile?.reason || 'platform_hangup';
          log('[CALL]', `platform requested hangup uuid=${uuidHex} did=${summary.did || '-'} callerId=${summary.callerId || '-'} reason=${summary.closeReason}`);
          requestCallHangup(summary.closeReason);
          continue;
        }

        initFiles();

        const forwardAfterMs = Number.isFinite(Number(clientCfg.forwardAfterMs))
            ? Number(clientCfg.forwardAfterMs)
            : CONFIG.forwardAfterMs;
        if (forwardAfterMs > 0) {
          forwardTimer = setTimeout(() => {
            log('[FWD]', 'time limit reached, redirecting call');
            clearOutboundAudio('forward_to_mobile');
            redirectCallToMobile('time_limit');
          }, forwardAfterMs);
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

startTelegramLinkPolling();
startOutboundDialer();

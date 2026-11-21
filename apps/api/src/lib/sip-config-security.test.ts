import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { env } from "../config.js";
import { voiceInternalRouter } from "../routes/voice-internal.js";
import { prisma } from "./prisma.js";
import { decryptSecret, encryptSecret } from "./secret-box.js";
import { decodeSipLineProvisionInput } from "./sip-line-provision-input.js";

test("encrypted provisioning bundles round trip with the configured GCM key and reject a wrong key safely", () => {
  const originalKey = env.DATA_ENCRYPTION_KEY;
  try {
    env.DATA_ENCRYPTION_KEY = "test-only-bundle-key-0000000000000000000000";
    const input = { lines: [{ number: "+79990000001", username: "test_line", password: "not-real-password" }] };
    const encrypted = encryptSecret(JSON.stringify(input))!;
    const decoded = decodeSipLineProvisionInput({ encrypted }, decryptSecret);
    assert.equal(decoded.lines[0]?.password, "not-real-password");
    env.DATA_ENCRYPTION_KEY = "different-test-bundle-key-00000000000000000";
    assert.throws(() => decodeSipLineProvisionInput({ encrypted }, decryptSecret), (error: Error) => {
      assert.match(error.message, /Invalid encrypted SIP line input/);
      assert.doesNotMatch(error.message, /not-real-password|test_line|enc:v2|ciphertext/);
      return true;
    });
  } finally {
    env.DATA_ENCRYPTION_KEY = originalKey;
  }
});

test("credential export requires its separate token, rejects plaintext secrets and never caches credentials", async (t) => {
  const originalTokens = {
    sip: env.SIP_CONFIG_TOKEN,
    voice: env.VOICE_SERVICE_TOKEN,
    encryption: env.DATA_ENCRYPTION_KEY
  };
  env.SIP_CONFIG_TOKEN = "test-only-sip-config-token-0000000000000000";
  env.VOICE_SERVICE_TOKEN = "test-only-voice-token-000000000000000000000";
  env.DATA_ENCRYPTION_KEY = "test-only-encryption-key-000000000000000000";
  const originalFindMany = prisma.sipLine.findMany;
  let queries = 0;
  let passwordEncrypted = encryptSecret("not-a-real-sip-password")!;
  const revision = new Date("2026-11-21T12:00:00.000Z");
  const row = () => ({
    id: "line-1",
    username: "test_line_1",
    passwordEncrypted,
    enabled: true,
    asteriskEndpoint: "callsec-sip-79990000001",
    server: "sip.novofon.ru",
    port: 5061,
    transport: "tls",
    updatedAt: revision,
    reservedNumber: { number: "+79990000001" }
  });
  prisma.sipLine.findMany = (async (query: { where: { enabled: boolean } }) => {
    assert.equal(query.where.enabled, true);
    queries += 1;
    return [row()];
  }) as unknown as typeof originalFindMany;

  const app = express();
  app.use("/internal/voice", voiceInternalRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    prisma.sipLine.findMany = originalFindMany;
    env.SIP_CONFIG_TOKEN = originalTokens.sip;
    env.VOICE_SERVICE_TOKEN = originalTokens.voice;
    env.DATA_ENCRYPTION_KEY = originalTokens.encryption;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/internal/voice/sip-lines/config`;

  const unauthorizedHeaders: Array<Record<string, string>> = [
    {},
    { "x-voice-service-token": env.VOICE_SERVICE_TOKEN },
    { "x-sip-config-token": env.VOICE_SERVICE_TOKEN }
  ];
  for (const headers of unauthorizedHeaders) {
    const response = await fetch(url, { headers });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
  assert.equal(queries, 0);

  const dedicatedToken = env.SIP_CONFIG_TOKEN;
  env.SIP_CONFIG_TOKEN = env.VOICE_SERVICE_TOKEN;
  const sameToken = await fetch(url, { headers: { "x-sip-config-token": env.VOICE_SERVICE_TOKEN } });
  assert.equal(sameToken.status, 503);
  assert.equal(queries, 0);
  env.SIP_CONFIG_TOKEN = dedicatedToken;

  const authorizedHeaders = { "x-sip-config-token": env.SIP_CONFIG_TOKEN };
  const authorized = await fetch(url, { headers: authorizedHeaders });
  assert.equal(authorized.status, 200);
  assert.match(authorized.headers.get("cache-control") ?? "", /no-store/);
  const result = await authorized.json() as { ok: boolean; lines: Array<Record<string, unknown>> };
  assert.equal(result.ok, true);
  assert.deepEqual(result.lines[0], {
    id: "line-1",
    endpoint: "callsec-sip-79990000001",
    number: "+79990000001",
    server: "sip.novofon.ru",
    port: 5061,
    transport: "tls",
    revision: revision.toISOString(),
    username: "test_line_1",
    password: "not-a-real-sip-password"
  });

  passwordEncrypted = "unencrypted-secret-that-must-not-be-exported";
  const plaintext = await fetch(url, { headers: authorizedHeaders });
  assert.equal(plaintext.status, 503);
  assert.doesNotMatch(await plaintext.text(), /unencrypted|secret-that/);

  passwordEncrypted = "enc:v2:malformed-test-ciphertext";
  const malformed = await fetch(url, { headers: authorizedHeaders });
  assert.equal(malformed.status, 503);
  assert.doesNotMatch(await malformed.text(), /ciphertext|decrypt|Error/);

  env.SIP_CONFIG_TOKEN = undefined;
  const unconfigured = await fetch(url, { headers: authorizedHeaders });
  assert.equal(unconfigured.status, 503);

  env.SIP_CONFIG_TOKEN = dedicatedToken;
  env.DATA_ENCRYPTION_KEY = undefined;
  const queriesBeforeMissingKey = queries;
  const missingKey = await fetch(url, { headers: authorizedHeaders });
  assert.equal(missingKey.status, 503);
  assert.equal(queries, queriesBeforeMissingKey);
});

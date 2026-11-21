import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSipLineProvisionInput,
  isSipLineProvisionUnchanged,
  MAX_SIP_LINE_INPUT_BYTES,
  parseSipLineProvisionInput
} from "./sip-line-provision-input.js";

const line = { number: "+79990000001", username: "test_sip_line", password: "test-Password123!" };

test("normalizes an explicit Russian number and creates a deterministic dedicated TLS endpoint", () => {
  const result = parseSipLineProvisionInput({ lines: [{ ...line, number: "79990000001" }] });
  assert.deepEqual(result.lines[0], {
    ...line,
    asteriskEndpoint: "callsec-sip-79990000001",
    server: "sip.novofon.ru",
    port: 5061,
    transport: "tls",
    enabled: true
  });
});

test("preserves explicit provider identifiers and a canonical endpoint without assuming an employee relation", () => {
  const result = parseSipLineProvisionInput({ lines: [{
    ...line, asteriskEndpoint: "callsec-sip-79990000001", providerSipLineId: "line-1", providerEmployeeId: "employee-1", enabled: false
  }] });
  assert.equal(result.lines[0]?.asteriskEndpoint, "callsec-sip-79990000001");
  assert.equal(result.lines[0]?.providerSipLineId, "line-1");
  assert.equal(result.lines[0]?.providerEmployeeId, "employee-1");
  assert.equal(result.lines[0]?.enabled, false);
});

test("rejects duplicate canonical numbers, SIP usernames, endpoints and provider identifiers", () => {
  for (const duplicate of [
    { number: "79990000001", username: "line2" },
    { number: "+79990000002", username: line.username },
    { number: "+79990000002", username: "line2", providerSipLineId: "same" }
  ]) {
    assert.throws(() => parseSipLineProvisionInput({ lines: [
      { ...line, providerSipLineId: "same", providerEmployeeId: "same" }, { ...line, ...duplicate }
    ] }), /duplicate identifiers/);
  }
});

test("rejects every explicit endpoint that does not exactly match its phone number", () => {
  for (const asteriskEndpoint of ["callsec-sip-custom-line", "callsec-sip-79990000002", "callsec-sip-79990000001-auth"]) {
    assert.throws(() => parseSipLineProvisionInput({ lines: [{ ...line, asteriskEndpoint }] }), /Invalid SIP line input/);
  }
});

test("allows multiple distinct SIP lines to reference the same employee metadata", () => {
  const result = parseSipLineProvisionInput({ lines: [
    { ...line, providerSipLineId: "sip-1", providerEmployeeId: "employee-1" },
    { ...line, number: "+79990000002", username: "another_sip_line", providerSipLineId: "sip-2", providerEmployeeId: "employee-1" }
  ] });
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0]?.providerEmployeeId, result.lines[1]?.providerEmployeeId);
  assert.notEqual(result.lines[0]?.asteriskEndpoint, result.lines[1]?.asteriskEndpoint);
});

test("rejects configuration injection and shared or arbitrary endpoint names", () => {
  for (const override of [
    { username: "line\n[evil]" }, { password: "secret\ninclude=bad" }, { password: "secret;comment" },
    { asteriskEndpoint: "novofon-endpoint" }, { asteriskEndpoint: "default" }, { asteriskEndpoint: "callsec-sip-../bad" },
    { server: "sip.novofon.ru\n[evil]" }, { server: "127.0.0.1" }, { server: "attacker.example" },
    { transport: "udp" }, { transport: "tcp" }, { port: 5060 }, { providerSipLineId: "line\nsecret" }
  ]) {
    assert.throws(() => parseSipLineProvisionInput({ lines: [{ ...line, ...override }] }), /Invalid SIP line input/);
  }
});

test("rejects SIP credentials that cannot be rendered safely by the host configuration", () => {
  for (const override of [{ username: "sip.line" }, { password: "test#Password123" }]) {
    assert.throws(() => parseSipLineProvisionInput({ lines: [{ ...line, ...override }] }), /Invalid SIP line input/);
  }
  assert.equal(parseSipLineProvisionInput({ lines: [{ ...line, username: "SIP_line-123" }] }).lines[0]?.username, "SIP_line-123");
});

test("requires explicit existing-number identities and rejects unknown fields or empty input", () => {
  for (const input of [null, {}, { lines: [] }, { lines: [{ ...line, number: "+441234567890" }] },
    { lines: [{ ...line, number: "" }] }, { lines: [{ ...line, password: "" }] },
    { lines: [{ ...line, passwordEncrypted: "pretend" }] }, { lines: [line], assignToUser: "not-allowed" }]) {
    assert.throws(() => parseSipLineProvisionInput(input), /Invalid SIP line input/);
  }
});

test("does not include secret values in validation exceptions", () => {
  const password = "sensitive-test-value;do-not-print";
  assert.throws(() => parseSipLineProvisionInput({ lines: [{ ...line, password }] }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(password), false);
    return true;
  });
});

function unchangedFixture() {
  const parsed = parseSipLineProvisionInput({ lines: [line] }).lines[0]!;
  const existing = {
    provider: "novofon",
    providerSipLineId: "existing-line-id",
    providerEmployeeId: "existing-employee-id",
    username: parsed.username,
    passwordEncrypted: "enc:v2:authenticated-ciphertext",
    server: parsed.server,
    port: parsed.port,
    transport: parsed.transport,
    asteriskEndpoint: parsed.asteriskEndpoint,
    enabled: parsed.enabled
  };
  return { parsed, existing };
}

test("an identical import with omitted provider metadata preserves the existing encrypted row", () => {
  const { parsed, existing } = unchangedFixture();
  assert.equal(isSipLineProvisionUnchanged(existing, parsed, line.password), true);
  assert.equal(isSipLineProvisionUnchanged(existing, {
    ...parsed, providerSipLineId: existing.providerSipLineId, providerEmployeeId: existing.providerEmployeeId
  }, line.password), true);
});

test("password rotation or any changed line field requires an encrypted update", () => {
  const { parsed, existing } = unchangedFixture();
  assert.equal(isSipLineProvisionUnchanged(existing, { ...parsed, password: "rotated-password" }, line.password), false);
  assert.equal(isSipLineProvisionUnchanged(existing, { ...parsed, providerSipLineId: "new-line-id" }, line.password), false);
  assert.equal(isSipLineProvisionUnchanged(existing, { ...parsed, providerEmployeeId: "new-employee-id" }, line.password), false);
  for (const change of [
    { provider: "other-provider" }, { username: "other_line" }, { server: "other.example" }, { port: 5060 },
    { transport: "udp" }, { asteriskEndpoint: "callsec-sip-79990000002" }, { enabled: false }
  ]) {
    assert.equal(isSipLineProvisionUnchanged({ ...existing, ...change }, parsed, line.password), false);
  }
});

test("legacy or unverified password storage is never treated as an unchanged encrypted row", () => {
  const { parsed, existing } = unchangedFixture();
  assert.equal(isSipLineProvisionUnchanged({ ...existing, passwordEncrypted: line.password }, parsed, line.password), false);
  assert.equal(isSipLineProvisionUnchanged({ ...existing, passwordEncrypted: "enc:v1:legacy" }, parsed, line.password), false);
  assert.equal(isSipLineProvisionUnchanged(existing, parsed, null), false);
});

const encryptedBundle = "enc:v2:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbb:cccc";

test("decodes a strict encrypted bundle in memory while retaining plain stdin compatibility", () => {
  let decryptCalls = 0;
  const decrypt = (ciphertext: string) => {
    assert.equal(ciphertext, encryptedBundle);
    decryptCalls += 1;
    return JSON.stringify({ lines: [line] });
  };
  const plain = decodeSipLineProvisionInput({ lines: [line] }, decrypt);
  assert.equal(decryptCalls, 0);
  assert.deepEqual(decodeSipLineProvisionInput({ encrypted: encryptedBundle }, decrypt), plain);
  assert.equal(decryptCalls, 1);
});

test("rejects legacy, malformed and ambiguous encrypted envelopes without leaking their contents", () => {
  let decryptCalls = 0;
  for (const envelope of [
    { encrypted: "enc:v1:legacy" }, { encrypted: "private-unencrypted-password" }, { encrypted: "enc:v2:malformed" },
    { encrypted: encryptedBundle, lines: [line] }, { encrypted: 42 }
  ]) {
    assert.throws(() => decodeSipLineProvisionInput(envelope, () => {
      decryptCalls += 1;
      return JSON.stringify({ lines: [line] });
    }), /Invalid encrypted SIP line input/);
  }
  assert.equal(decryptCalls, 0);
});

test("reports wrong keys, malformed inner JSON and oversized decrypted bundles with generic errors", () => {
  const secret = "sensitive-inner-payload-do-not-print";
  for (const decrypt of [
    () => { throw new Error(`Wrong key: ${secret}`); },
    () => secret,
    () => null,
    () => "x".repeat(MAX_SIP_LINE_INPUT_BYTES + 1),
    () => JSON.stringify({ encrypted: encryptedBundle })
  ]) {
    assert.throws(() => decodeSipLineProvisionInput({ encrypted: encryptedBundle }, decrypt), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid encrypted SIP line input/);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});

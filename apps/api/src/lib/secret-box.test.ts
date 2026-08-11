import assert from "node:assert/strict";
import test from "node:test";
import { decryptSecret, encryptSecret } from "./secret-box.js";

test("encrypts integration secrets with authenticated encryption", () => {
  const plainText = "refresh-token-for-test";
  const encrypted = encryptSecret(plainText);

  assert.ok(encrypted?.startsWith("enc:v2:"));
  assert.notEqual(encrypted, plainText);
  assert.equal(decryptSecret(encrypted), plainText);
});

test("keeps backward compatibility with unencrypted legacy values", () => {
  assert.equal(decryptSecret("legacy-token"), "legacy-token");
});

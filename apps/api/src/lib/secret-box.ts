import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config.js";

const CURRENT_PREFIX = "enc:v2";
const LEGACY_PREFIX = "enc:v1";

function getKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(env.DATA_ENCRYPTION_KEY ?? env.JWT_SECRET), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${CURRENT_PREFIX}:${iv.toString("base64url")}:${authTag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptSecret(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const prefix = value.startsWith(`${CURRENT_PREFIX}:`)
    ? CURRENT_PREFIX
    : value.startsWith(`${LEGACY_PREFIX}:`)
      ? LEGACY_PREFIX
      : null;

  if (!prefix) {
    return value;
  }

  const payload = value.slice(prefix.length + 1);
  const parts = payload.split(":");
  const [ivText, authTagText, encryptedText] = parts;

  if (parts.length !== 3 || !ivText || !authTagText || !encryptedText) {
    throw new Error("Invalid encrypted secret format");
  }

  const secret = prefix === LEGACY_PREFIX ? env.JWT_SECRET : (env.DATA_ENCRYPTION_KEY ?? env.JWT_SECRET);
  const decipher = createDecipheriv("aes-256-gcm", getKey(secret), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(authTagText, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

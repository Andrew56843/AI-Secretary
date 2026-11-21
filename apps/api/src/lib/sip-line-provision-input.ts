import { z } from "zod";

export const MAX_SIP_LINE_INPUT_BYTES = 64 * 1024;

const encryptedEnvelopeSchema = z.object({
  encrypted: z.string().max(MAX_SIP_LINE_INPUT_BYTES).regex(/^enc:v2:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/)
}).strict();

const providerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const lineSchema = z.object({
  number: z.string().regex(/^\+?7\d{10}$/).transform((value) => `+${value.replace(/^\+/, "")}`),
  username: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  password: z.string().min(1).max(256).regex(/^[A-Za-z0-9!$%&()*+,\-./:<=>?@^_{|}~]+$/),
  asteriskEndpoint: z.string().regex(/^callsec-sip-[a-z0-9-]{1,64}$/).optional(),
  providerSipLineId: providerIdSchema.optional(),
  providerEmployeeId: providerIdSchema.optional(),
  server: z.literal("sip.novofon.ru").default("sip.novofon.ru"),
  port: z.literal(5061).default(5061),
  transport: z.literal("tls").default("tls"),
  enabled: z.boolean().default(true)
}).strict().transform((line) => ({
  ...line,
  asteriskEndpoint: line.asteriskEndpoint ?? `callsec-sip-${line.number.slice(1)}`
})).refine((line) => line.asteriskEndpoint === `callsec-sip-${line.number.slice(1)}`);

const provisionSchema = z.object({ lines: z.array(lineSchema).min(1).max(100) }).strict();

export type SipLineProvisionInput = z.output<typeof provisionSchema>;

type ExistingSipLine = {
  provider: string;
  providerSipLineId: string | null;
  providerEmployeeId: string | null;
  username: string;
  passwordEncrypted: string;
  server: string;
  port: number;
  transport: string;
  asteriskEndpoint: string;
  enabled: boolean;
};

export function isSipLineProvisionUnchanged(
  existing: ExistingSipLine,
  line: SipLineProvisionInput["lines"][number],
  decryptedPassword: string | null
) {
  return existing.passwordEncrypted.startsWith("enc:v2:") &&
    decryptedPassword === line.password &&
    existing.provider === "novofon" &&
    existing.username === line.username &&
    existing.server === line.server &&
    existing.port === line.port &&
    existing.transport === line.transport &&
    existing.asteriskEndpoint === line.asteriskEndpoint &&
    existing.enabled === line.enabled &&
    (line.providerSipLineId === undefined || existing.providerSipLineId === line.providerSipLineId) &&
    (line.providerEmployeeId === undefined || existing.providerEmployeeId === line.providerEmployeeId);
}

export function parseSipLineProvisionInput(value: unknown): SipLineProvisionInput {
  const result = provisionSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Invalid SIP line input. Check the documented fields and allowed formats.");
  }

  for (const key of ["number", "username", "asteriskEndpoint", "providerSipLineId"] as const) {
    const seen = new Set<string>();
    for (const line of result.data.lines) {
      const identifier = line[key];
      if (identifier === undefined) continue;
      if (seen.has(identifier)) {
        throw new Error("SIP line input contains duplicate identifiers.");
      }
      seen.add(identifier);
    }
  }

  return result.data;
}

export function decodeSipLineProvisionInput(
  value: unknown,
  decrypt: (ciphertext: string) => string | null
): SipLineProvisionInput {
  const isEnvelope = value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "encrypted");
  if (!isEnvelope) {
    return parseSipLineProvisionInput(value);
  }

  const envelope = encryptedEnvelopeSchema.safeParse(value);
  try {
    if (!envelope.success) {
      throw new Error("Invalid envelope");
    }
    const decrypted = decrypt(envelope.data.encrypted);
    if (typeof decrypted !== "string" || Buffer.byteLength(decrypted, "utf8") > MAX_SIP_LINE_INPUT_BYTES) {
      throw new Error("Invalid decrypted input");
    }
    return parseSipLineProvisionInput(JSON.parse(decrypted) as unknown);
  } catch {
    throw new Error("Invalid encrypted SIP line input. Check the private bundle and encryption key.");
  }
}

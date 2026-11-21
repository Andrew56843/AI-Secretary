import { Prisma } from "@prisma/client";
import { env } from "../config.js";
import { decryptSecret, encryptSecret } from "../lib/secret-box.js";
import { decodeSipLineProvisionInput, isSipLineProvisionUnchanged, MAX_SIP_LINE_INPUT_BYTES } from "../lib/sip-line-provision-input.js";

async function readInput() {
  if (process.argv.length !== 2 || process.stdin.isTTY) {
    throw new Error("Provide SIP line JSON through stdin; command-line arguments are not accepted.");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_SIP_LINE_INPUT_BYTES) {
      throw new Error("SIP line input exceeds the size limit.");
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("SIP line input must be valid JSON.");
  }
}

async function main() {
  if (!env.DATA_ENCRYPTION_KEY || env.DATA_ENCRYPTION_KEY.length < 32 || /change-me|replace-with/i.test(env.DATA_ENCRYPTION_KEY)) {
    throw new Error("A dedicated DATA_ENCRYPTION_KEY of at least 32 characters is required.");
  }

  const input = decodeSipLineProvisionInput(await readInput(), decryptSecret);
  const { prisma } = await import("../lib/prisma.js");
  try {
    const provisioned = await prisma.$transaction(async (tx) => {
      const results: Array<{ number: string; endpoint: string; enabled: boolean }> = [];
      for (const line of input.lines) {
        const number = await tx.reservedPhoneNumber.findUnique({ where: { number: line.number }, select: { id: true } });
        if (!number) {
          throw new Error("SIP lines may only be provisioned for existing phone numbers.");
        }

        const existing = await tx.sipLine.findUnique({ where: { reservedNumberId: number.id } });
        if (existing?.passwordEncrypted.startsWith("enc:v2:") &&
          isSipLineProvisionUnchanged(existing, line, decryptSecret(existing.passwordEncrypted))) {
          // Preserve ciphertext and routing revision when an identical private input is imported again.
          results.push({ number: line.number, endpoint: line.asteriskEndpoint, enabled: line.enabled });
          continue;
        }

        const passwordEncrypted = encryptSecret(line.password);
        if (!passwordEncrypted?.startsWith("enc:v2:")) {
          throw new Error("SIP password encryption failed.");
        }
        const data = {
          provider: "novofon",
          providerSipLineId: line.providerSipLineId,
          providerEmployeeId: line.providerEmployeeId,
          username: line.username,
          passwordEncrypted,
          server: line.server,
          port: line.port,
          transport: line.transport,
          asteriskEndpoint: line.asteriskEndpoint,
          enabled: line.enabled
        };
        await tx.sipLine.upsert({
          where: { reservedNumberId: number.id },
          update: data,
          create: { ...data, reservedNumberId: number.id }
        });
        results.push({ number: line.number, endpoint: line.asteriskEndpoint, enabled: line.enabled });
      }
      return results;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });

    console.log(JSON.stringify({ ok: true, count: provisioned.length, lines: provisioned }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  // Database and validation exceptions can contain credentials; keep failures non-sensitive.
  console.error("SIP line provisioning failed. Check the private input, encryption key and database configuration.");
  process.exitCode = 1;
});

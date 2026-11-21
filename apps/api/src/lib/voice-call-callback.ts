import { Prisma, type PrismaClient } from "@prisma/client";
import { createBillableCallLog } from "./billable-call.js";
import { normalizePhone } from "./phone.js";

type CallbackInput = Parameters<typeof createBillableCallLog>[1] & { callUuid: string };

function isRetryableConflict(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  const target = error.meta?.target;
  const targets = Array.isArray(target) ? target : [target];
  return error.code === "P2002" && targets.some((value) =>
    value === "callUuid" || String(value ?? "").includes("CallLog_callUuid")
  );
}

export async function persistVoiceCallCallback(
  db: Pick<PrismaClient, "$transaction">,
  input: CallbackInput & { userId: string },
  finishContact: (tx: Prisma.TransactionClient, callLogId: string) => Promise<unknown>
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        // Serialize the whole callback, including campaign state, across API instances.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('callsec:call-callback'), hashtext(${input.callUuid}))`;
        const existing = await tx.callLog.findUnique({
          where: { callUuid: input.callUuid },
          include: { transcriptDeliveries: true }
        });
        if (existing) {
          if (existing.assistantProfileId !== input.assistantProfileId || existing.direction !== input.direction ||
              (normalizePhone(existing.customerPhone) || existing.customerPhone.trim()) !==
                (normalizePhone(input.customerPhone) || input.customerPhone.trim())) {
            throw new Error("CALL_UUID_COLLISION");
          }
          await tx.activeCall.deleteMany({ where: {
            callUuid: input.callUuid, userId: input.userId, assistantProfileId: input.assistantProfileId
          } });
          return { log: existing, outbound: null, created: false } as const;
        }

        const log = await createBillableCallLog(tx, input);
        const outbound = await finishContact(tx, log.id);
        await tx.activeCall.deleteMany({ where: {
          callUuid: input.callUuid, userId: input.userId, assistantProfileId: input.assistantProfileId
        } });
        return { log, outbound, created: true } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000 });
    } catch (error) {
      if (attempt >= 2 || !isRetryableConflict(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

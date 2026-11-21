import { CallDirection, Prisma, type PrismaClient } from "@prisma/client";

export const TEST_CALL_COOLDOWN_MS = 60_000;

function alreadyQueuedResult() {
  return {
    queued: false,
    message: "Тестовый звонок уже в очереди или ещё обрабатывается. Дождитесь его завершения."
  } as const;
}

export async function enqueueTestCall(
  db: Pick<PrismaClient, "$transaction">,
  input: { userId: string; phone: string; direction: CallDirection; now?: Date }
) {
  try {
    return await db.$transaction(
      async (tx) => {
        // One lock covers both scenario modes, including requests from other API instances.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('callsec:test-call'), hashtext(${input.userId}))`;

        const activeCall = await tx.activeCall.findFirst({
          where: { userId: input.userId, customerPhone: input.phone },
          select: { id: true }
        });
        if (activeCall) {
          return {
            queued: false,
            message: "Тестовый звонок уже идёт. Завершите его, прежде чем запускать новый."
          } as const;
        }

        const existingContact = await tx.outboundContact.findFirst({
          where: { userId: input.userId, phone: input.phone },
          select: { id: true }
        });
        if (existingContact) {
          return alreadyQueuedResult();
        }

        const now = input.now ?? new Date();
        const recentCall = await tx.callLog.findFirst({
          where: {
            assistantProfile: { userId: input.userId },
            customerPhone: input.phone,
            createdAt: { gte: new Date(now.getTime() - TEST_CALL_COOLDOWN_MS) }
          },
          select: { id: true }
        });
        if (recentCall) {
          return {
            queued: false,
            message: "Предыдущий звонок только что завершился. Подождите минуту перед новым тестом."
          } as const;
        }

        const contact = await tx.outboundContact.create({
          data: { userId: input.userId, phone: input.phone, callMode: input.direction }
        });
        return { queued: true, contact } as const;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 }
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return alreadyQueuedResult();
    }
    throw error;
  }
}

import { CallDirection, OutboundContactStatus, ProfileStatus, type Prisma } from "@prisma/client";
import { reservedNumberRouteSelect, resolveOutboundSipRoute } from "./outbound-sip-route.js";

export const OUTBOUND_QUEUE_BATCH_SIZE = 10;
export const OUTBOUND_QUEUE_MAX_BATCHES = 5;
export const OUTBOUND_ROUTE_RETRY_MS = 60_000;

export async function claimNextOutboundContact(
  tx: Prisma.TransactionClient,
  input: {
    now: Date;
    testCallerId?: string;
    testNumber?: Parameters<typeof resolveOutboundSipRoute>[0]["testNumber"];
  }
) {
  const due = { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: input.now } }] };

  for (let batch = 0; batch < OUTBOUND_QUEUE_MAX_BATCHES; batch += 1) {
    const candidates = await tx.outboundContact.findMany({
      where: {
        status: OutboundContactStatus.PENDING,
        queuedForCall: false,
        ...due,
        user: { rubleBalanceKopecks: { gt: 0 } },
        AND: [{ OR: [
          {
            callMode: CallDirection.OUTBOUND,
            user: { profiles: { some: { mode: CallDirection.OUTBOUND, status: ProfileStatus.ACTIVE } } }
          },
          {
            callMode: CallDirection.INBOUND,
            user: { profiles: { some: { mode: CallDirection.INBOUND, status: ProfileStatus.ACTIVE } } }
          }
        ] }]
      },
      include: {
        user: {
          select: {
            phone: true,
            numberRentExpiresAt: true,
            profiles: {
              where: { mode: CallDirection.INBOUND },
              select: { reservedNumber: { select: reservedNumberRouteSelect } }
            }
          }
        }
      },
      // Never-attempted contacts precede deferred retries so expired backoffs cannot trap the scan window.
      orderBy: [{ nextAttemptAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      take: OUTBOUND_QUEUE_BATCH_SIZE
    });
    if (candidates.length === 0) {
      return null;
    }

    for (const candidate of candidates) {
      const route = resolveOutboundSipRoute({
        ownerPhone: candidate.user.phone,
        destinationPhone: candidate.phone,
        reservedNumber: candidate.user.profiles[0]?.reservedNumber,
        numberRentExpiresAt: candidate.user.numberRentExpiresAt,
        testCallerId: input.testCallerId,
        testNumber: input.testNumber,
        now: input.now
      });
      const claimWhere = {
        id: candidate.id,
        status: OutboundContactStatus.PENDING,
        queuedForCall: false,
        ...due
      };
      if (!route) {
        // Defer unavailable routes without consuming a real dial attempt, then scan the next batch.
        await tx.outboundContact.updateMany({
          where: claimWhere,
          data: { nextAttemptAt: new Date(input.now.getTime() + OUTBOUND_ROUTE_RETRY_MS) }
        });
        continue;
      }

      const claimed = await tx.outboundContact.updateMany({
        where: claimWhere,
        data: { queuedForCall: true, activeCallUuid: null, activeCallStartedAt: null }
      });
      if (claimed.count === 1) {
        return candidate;
      }
    }
  }
  return null;
}

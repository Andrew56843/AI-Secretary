import { TranscriptChannel, TranscriptDeliveryStatus, type PrismaClient } from "@prisma/client";
import { TELEGRAM_DELIVERY_STALE_MS } from "./telegram.js";

type DispatcherDatabase = Pick<PrismaClient, "transcriptDelivery">;
type DeliverTranscript = (callLogId: string) => Promise<unknown>;

type DispatchOptions = {
  now?: Date;
  batchSize?: number;
  shouldStop?: () => boolean;
  warn?: (message: string) => void;
};

export async function dispatchPendingTelegramTranscripts(
  db: DispatcherDatabase,
  deliver: DeliverTranscript,
  options: DispatchOptions = {}
) {
  const now = options.now ?? new Date();
  const staleAt = new Date(now.getTime() - TELEGRAM_DELIVERY_STALE_MS);
  const requestedBatchSize = options.batchSize ?? 20;
  const batchSize = Number.isFinite(requestedBatchSize)
    ? Math.max(1, Math.min(100, Math.trunc(requestedBatchSize)))
    : 20;
  const deliveries = await db.transcriptDelivery.findMany({
    where: {
      channel: TranscriptChannel.TELEGRAM,
      OR: [
        { status: TranscriptDeliveryStatus.PENDING },
        {
          status: TranscriptDeliveryStatus.SENDING,
          OR: [{ claimedAt: { lte: staleAt } }, { claimedAt: null }]
        }
      ],
      // Terminal or currently owned sibling deliveries must not starve later queued calls.
      callLog: {
        transcriptDeliveries: {
          none: {
            channel: TranscriptChannel.TELEGRAM,
            OR: [
              { status: { in: [TranscriptDeliveryStatus.SENT, TranscriptDeliveryStatus.UNKNOWN, TranscriptDeliveryStatus.FAILED] } },
              { status: TranscriptDeliveryStatus.SENDING, claimedAt: { gt: staleAt } }
            ]
          }
        }
      }
    },
    select: { callLogId: true },
    distinct: ["callLogId"],
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize
  });

  let attempted = 0;
  let failed = 0;
  for (const callLogId of new Set(deliveries.map((delivery) => delivery.callLogId))) {
    if (options.shouldStop?.()) break;
    attempted += 1;
    try {
      // The delivery helper atomically claims PENDING, or marks stale SENDING as UNKNOWN without sending.
      await deliver(callLogId);
    } catch {
      failed += 1;
      (options.warn ?? console.warn)("[TELEGRAM] Queued transcript processing failed");
    }
  }
  return { selected: deliveries.length, attempted, failed };
}

export function startTelegramDispatcher(options: {
  db: DispatcherDatabase;
  deliver: DeliverTranscript;
  intervalMs?: number;
  batchSize?: number;
  warn?: (message: string) => void;
}) {
  let stopped = false;
  let running: Promise<void> | null = null;
  const warn = options.warn ?? console.warn;

  const run = () => {
    if (stopped || running) return;
    running = (async () => {
      try {
        await dispatchPendingTelegramTranscripts(options.db, options.deliver, {
          batchSize: options.batchSize,
          shouldStop: () => stopped,
          warn
        });
      } catch {
        warn("[TELEGRAM] Pending transcript lookup failed");
      } finally {
        running = null;
      }
    })();
  };

  run();
  const timer = setInterval(run, options.intervalMs ?? 30_000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

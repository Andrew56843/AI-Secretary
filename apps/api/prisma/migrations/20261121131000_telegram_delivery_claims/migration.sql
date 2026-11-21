ALTER TYPE "TranscriptDeliveryStatus" ADD VALUE 'SENDING';
ALTER TYPE "TranscriptDeliveryStatus" ADD VALUE 'UNKNOWN';

ALTER TABLE "TranscriptDelivery"
ADD COLUMN "claimToken" TEXT,
ADD COLUMN "claimedAt" TIMESTAMP(3);

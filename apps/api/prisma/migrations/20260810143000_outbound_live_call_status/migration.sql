ALTER TABLE "OutboundContact"
ADD COLUMN "activeCallUuid" TEXT,
ADD COLUMN "activeCallStartedAt" TIMESTAMP(3);

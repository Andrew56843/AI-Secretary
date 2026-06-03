-- CreateEnum
CREATE TYPE "BillingTransactionType" AS ENUM ('FREE_GRANT', 'TOP_UP', 'NUMBER_PURCHASE');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('DISCONNECTED', 'CONNECTED');

-- CreateEnum
CREATE TYPE "TranscriptChannel" AS ENUM ('TELEGRAM');

-- CreateEnum
CREATE TYPE "TranscriptDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "minuteBalanceSeconds" INTEGER NOT NULL DEFAULT 300;
ALTER TABLE "User" ADD COLUMN "totalPurchasedSeconds" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "numberPurchasedAt" TIMESTAMP(3);

-- Mark users that already had a reserved inbound number as having purchased/reserved it before this migration.
UPDATE "User"
SET "numberPurchasedAt" = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1
  FROM "AssistantProfile"
  WHERE "AssistantProfile"."userId" = "User"."id"
    AND "AssistantProfile"."mode" = 'INBOUND'
    AND "AssistantProfile"."reservedNumberId" IS NOT NULL
);

-- CreateTable
CREATE TABLE "BillingTransaction" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "BillingTransactionType" NOT NULL,
  "amountSeconds" INTEGER NOT NULL,
  "amountRub" INTEGER,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BillingTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleAccount" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "IntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
  "googleEmail" TEXT,
  "calendarId" TEXT,
  "connectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GoogleAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramAccount" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "IntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
  "botUsername" TEXT NOT NULL DEFAULT 'AISecretaryDemoBot',
  "linkToken" TEXT NOT NULL,
  "chatId" TEXT,
  "username" TEXT,
  "connectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TelegramAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptDelivery" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "callLogId" TEXT NOT NULL,
  "channel" "TranscriptChannel" NOT NULL,
  "status" "TranscriptDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "target" TEXT,
  "payloadPreview" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TranscriptDelivery_pkey" PRIMARY KEY ("id")
);

-- Seed free minute grants for existing users.
INSERT INTO "BillingTransaction" ("id", "userId", "type", "amountSeconds", "note")
SELECT
  'free_grant_' || "id",
  "id",
  'FREE_GRANT',
  300,
  'Registration free minutes'
FROM "User"
ON CONFLICT DO NOTHING;

-- CreateIndex
CREATE INDEX "BillingTransaction_userId_createdAt_idx" ON "BillingTransaction"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAccount_userId_key" ON "GoogleAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramAccount_userId_key" ON "TelegramAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramAccount_linkToken_key" ON "TelegramAccount"("linkToken");

-- CreateIndex
CREATE INDEX "TranscriptDelivery_userId_createdAt_idx" ON "TranscriptDelivery"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TranscriptDelivery_callLogId_idx" ON "TranscriptDelivery"("callLogId");

-- AddForeignKey
ALTER TABLE "BillingTransaction" ADD CONSTRAINT "BillingTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleAccount" ADD CONSTRAINT "GoogleAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramAccount" ADD CONSTRAINT "TelegramAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptDelivery" ADD CONSTRAINT "TranscriptDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptDelivery" ADD CONSTRAINT "TranscriptDelivery_callLogId_fkey" FOREIGN KEY ("callLogId") REFERENCES "CallLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

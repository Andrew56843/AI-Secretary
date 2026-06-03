ALTER TYPE "BillingTransactionType" ADD VALUE IF NOT EXISTS 'CALL_CHARGE';

ALTER TABLE "AssistantProfile"
ADD COLUMN "realtimeModel" TEXT NOT NULL DEFAULT 'gpt-realtime-mini';

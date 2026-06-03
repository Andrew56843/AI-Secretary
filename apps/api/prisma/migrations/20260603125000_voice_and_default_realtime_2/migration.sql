ALTER TABLE "AssistantProfile"
ADD COLUMN "voice" TEXT NOT NULL DEFAULT 'alloy';

ALTER TABLE "AssistantProfile"
ALTER COLUMN "realtimeModel" SET DEFAULT 'gpt-realtime-2';

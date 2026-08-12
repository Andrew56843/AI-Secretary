CREATE TABLE "GreetingAudioCache" (
  "id" TEXT NOT NULL,
  "assistantProfileId" TEXT NOT NULL,
  "cacheKey" TEXT NOT NULL,
  "voice" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "pcm24" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GreetingAudioCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GreetingAudioCache_assistantProfileId_key"
  ON "GreetingAudioCache"("assistantProfileId");

CREATE INDEX "GreetingAudioCache_cacheKey_idx"
  ON "GreetingAudioCache"("cacheKey");

ALTER TABLE "GreetingAudioCache"
  ADD CONSTRAINT "GreetingAudioCache_assistantProfileId_fkey"
  FOREIGN KEY ("assistantProfileId") REFERENCES "AssistantProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

DROP TABLE IF EXISTS "PaymentOrder";
DROP TYPE IF EXISTS "PaymentOrderStatus";

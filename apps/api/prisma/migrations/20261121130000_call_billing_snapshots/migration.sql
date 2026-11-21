CREATE TABLE "CallBillingSnapshot" (
    "callUuid" TEXT NOT NULL,
    "assistantProfileId" TEXT NOT NULL,
    "direction" "CallDirection" NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "realtimeModel" TEXT NOT NULL,
    "rateKopecksPerMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallBillingSnapshot_pkey" PRIMARY KEY ("callUuid"),
    CONSTRAINT "CallBillingSnapshot_positive_rate" CHECK ("rateKopecksPerMinute" > 0)
);

CREATE INDEX "CallBillingSnapshot_assistantProfileId_createdAt_idx"
ON "CallBillingSnapshot"("assistantProfileId", "createdAt");

ALTER TABLE "CallBillingSnapshot" ADD CONSTRAINT "CallBillingSnapshot_assistantProfileId_fkey"
FOREIGN KEY ("assistantProfileId") REFERENCES "AssistantProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ActiveCall" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assistantProfileId" TEXT NOT NULL,
    "callUuid" TEXT NOT NULL,
    "outboundContactId" TEXT,
    "direction" "CallDirection" NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActiveCall_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ActiveCall_callUuid_key" ON "ActiveCall"("callUuid");
CREATE INDEX "ActiveCall_userId_startedAt_idx" ON "ActiveCall"("userId", "startedAt");
CREATE INDEX "ActiveCall_outboundContactId_idx" ON "ActiveCall"("outboundContactId");

ALTER TABLE "ActiveCall"
ADD CONSTRAINT "ActiveCall_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActiveCall"
ADD CONSTRAINT "ActiveCall_assistantProfileId_fkey"
FOREIGN KEY ("assistantProfileId") REFERENCES "AssistantProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

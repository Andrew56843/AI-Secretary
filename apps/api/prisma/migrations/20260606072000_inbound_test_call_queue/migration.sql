ALTER TABLE "OutboundContact" ADD COLUMN "callMode" "CallDirection" NOT NULL DEFAULT 'OUTBOUND';

DROP INDEX "OutboundContact_userId_phone_key";

CREATE UNIQUE INDEX "OutboundContact_userId_phone_callMode_key" ON "OutboundContact"("userId", "phone", "callMode");

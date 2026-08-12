ALTER TABLE "CallLog" ADD COLUMN "callUuid" TEXT;

CREATE UNIQUE INDEX "CallLog_callUuid_key" ON "CallLog"("callUuid");

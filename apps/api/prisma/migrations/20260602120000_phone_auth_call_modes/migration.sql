-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "OutboundContactStatus" AS ENUM ('PENDING', 'CALLED', 'FAILED');

-- Alter User from email auth to phone auth.
ALTER TABLE "User" ADD COLUMN "phone" TEXT;

WITH ranked_users AS (
  SELECT
    "User"."id",
    ROW_NUMBER() OVER (ORDER BY "User"."createdAt", "User"."id") AS rn,
    (
      SELECT "AssistantProfile"."forwardingPhone"
      FROM "AssistantProfile"
      WHERE "AssistantProfile"."userId" = "User"."id"
      ORDER BY "AssistantProfile"."createdAt"
      LIMIT 1
    ) AS forwarding_phone
  FROM "User"
)
UPDATE "User"
SET "phone" = CASE
  WHEN ranked_users.rn = 1 THEN COALESCE(ranked_users.forwarding_phone, '+79054176285')
  ELSE '+7999000' || LPAD(ranked_users.rn::TEXT, 4, '0')
END
FROM ranked_users
WHERE "User"."id" = ranked_users."id";

ALTER TABLE "User" ALTER COLUMN "phone" SET NOT NULL;
DROP INDEX IF EXISTS "User_email_key";
ALTER TABLE "User" DROP COLUMN "email";
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- Add call mode settings to profiles.
ALTER TABLE "AssistantProfile" ADD COLUMN "mode" "CallDirection" NOT NULL DEFAULT 'INBOUND';
ALTER TABLE "AssistantProfile" ADD COLUMN "greetingText" TEXT NOT NULL DEFAULT 'Здравствуйте! Я ИИ-секретарь. Чем могу помочь?';
ALTER TABLE "AssistantProfile" ADD COLUMN "maxDialogSeconds" INTEGER NOT NULL DEFAULT 120;
ALTER TABLE "AssistantProfile" ALTER COLUMN "reservedNumberId" DROP NOT NULL;

WITH ranked_profiles AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "createdAt", "id") AS rn
  FROM "AssistantProfile"
)
UPDATE "AssistantProfile"
SET "mode" = CASE
  WHEN ranked_profiles.rn = 1 THEN 'INBOUND'::"CallDirection"
  ELSE 'OUTBOUND'::"CallDirection"
END
FROM ranked_profiles
WHERE "AssistantProfile"."id" = ranked_profiles."id";

ALTER TABLE "AssistantProfile" ALTER COLUMN "mode" DROP DEFAULT;
ALTER TABLE "AssistantProfile" ALTER COLUMN "greetingText" DROP DEFAULT;
CREATE UNIQUE INDEX "AssistantProfile_userId_mode_key" ON "AssistantProfile"("userId", "mode");

-- Add direction to existing logs.
ALTER TABLE "CallLog" ADD COLUMN "direction" "CallDirection" NOT NULL DEFAULT 'INBOUND';

UPDATE "CallLog"
SET "direction" = "AssistantProfile"."mode"
FROM "AssistantProfile"
WHERE "CallLog"."assistantProfileId" = "AssistantProfile"."id";

ALTER TABLE "CallLog" ALTER COLUMN "direction" DROP DEFAULT;
CREATE INDEX "CallLog_direction_createdAt_idx" ON "CallLog"("direction", "createdAt");

-- CreateTable
CREATE TABLE "OutboundContact" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "status" "OutboundContactStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastCallLogId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OutboundContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutboundContact_userId_phone_key" ON "OutboundContact"("userId", "phone");

-- CreateIndex
CREATE INDEX "OutboundContact_userId_status_idx" ON "OutboundContact"("userId", "status");

-- AddForeignKey
ALTER TABLE "OutboundContact" ADD CONSTRAINT "OutboundContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

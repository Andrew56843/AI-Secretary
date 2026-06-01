-- CreateEnum
CREATE TYPE "ProfileStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('SUCCESS', 'ESCALATED', 'MISSED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT,
    "password" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservedPhoneNumber" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "assigned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservedPhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'My AI Secretary',
    "businessName" TEXT,
    "prompt" TEXT NOT NULL,
    "forwardingPhone" TEXT NOT NULL,
    "status" "ProfileStatus" NOT NULL DEFAULT 'ACTIVE',
    "reservedNumberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallLog" (
    "id" TEXT NOT NULL,
    "assistantProfileId" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "status" "CallStatus" NOT NULL,
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "transcript" TEXT,
    "summary" TEXT,
    "recordingUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ReservedPhoneNumber_number_key" ON "ReservedPhoneNumber"("number");

-- CreateIndex
CREATE INDEX "AssistantProfile_userId_idx" ON "AssistantProfile"("userId");

-- CreateIndex
CREATE INDEX "AssistantProfile_reservedNumberId_idx" ON "AssistantProfile"("reservedNumberId");

-- CreateIndex
CREATE INDEX "CallLog_assistantProfileId_createdAt_idx" ON "CallLog"("assistantProfileId", "createdAt");

-- AddForeignKey
ALTER TABLE "AssistantProfile" ADD CONSTRAINT "AssistantProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantProfile" ADD CONSTRAINT "AssistantProfile_reservedNumberId_fkey" FOREIGN KEY ("reservedNumberId") REFERENCES "ReservedPhoneNumber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_assistantProfileId_fkey" FOREIGN KEY ("assistantProfileId") REFERENCES "AssistantProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

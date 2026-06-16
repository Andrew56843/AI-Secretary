CREATE TYPE "PhoneVerificationPurpose" AS ENUM ('REGISTER', 'RECOVER');

CREATE TYPE "PhoneVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED');

CREATE TABLE "PhoneVerificationRequest" (
  "id" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "purpose" "PhoneVerificationPurpose" NOT NULL,
  "status" "PhoneVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "fullName" TEXT,
  "issuedPassword" TEXT,
  "userId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PhoneVerificationRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PhoneVerificationRequest_phone_status_createdAt_idx" ON "PhoneVerificationRequest"("phone", "status", "createdAt");

CREATE INDEX "PhoneVerificationRequest_status_expiresAt_idx" ON "PhoneVerificationRequest"("status", "expiresAt");

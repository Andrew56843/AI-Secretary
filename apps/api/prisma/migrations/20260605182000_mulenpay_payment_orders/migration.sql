CREATE TYPE "PaymentProvider" AS ENUM ('MULENPAY');

CREATE TYPE "PaymentOrderStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'CANCELED', 'FAILED');

CREATE TABLE "PaymentOrder" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" "PaymentProvider" NOT NULL DEFAULT 'MULENPAY',
  "providerPaymentId" TEXT,
  "uuid" TEXT NOT NULL,
  "amountRub" INTEGER NOT NULL,
  "status" "PaymentOrderStatus" NOT NULL DEFAULT 'PENDING',
  "paymentUrl" TEXT,
  "rawStatus" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentOrder_uuid_key" ON "PaymentOrder"("uuid");

CREATE INDEX "PaymentOrder_userId_createdAt_idx" ON "PaymentOrder"("userId", "createdAt");

CREATE INDEX "PaymentOrder_providerPaymentId_idx" ON "PaymentOrder"("providerPaymentId");

ALTER TABLE "PaymentOrder"
ADD CONSTRAINT "PaymentOrder_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

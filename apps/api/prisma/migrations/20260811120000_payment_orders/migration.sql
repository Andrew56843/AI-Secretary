ALTER TYPE "BillingTransactionType" ADD VALUE 'PAYMENT_REFUND';

CREATE TYPE "PaymentOrderStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

CREATE TABLE "PaymentOrder" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'CLOUDPAYMENTS',
  "providerTransactionId" TEXT,
  "amountKopecks" INTEGER NOT NULL,
  "status" "PaymentOrderStatus" NOT NULL DEFAULT 'PENDING',
  "paidAt" TIMESTAMP(3),
  "refundedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentOrder_providerTransactionId_key" ON "PaymentOrder"("providerTransactionId");
CREATE INDEX "PaymentOrder_userId_createdAt_idx" ON "PaymentOrder"("userId", "createdAt");
CREATE INDEX "PaymentOrder_status_createdAt_idx" ON "PaymentOrder"("status", "createdAt");

ALTER TABLE "PaymentOrder"
ADD CONSTRAINT "PaymentOrder_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "User" ADD COLUMN "rubleBalanceKopecks" INTEGER NOT NULL DEFAULT 0;

UPDATE "User"
SET "rubleBalanceKopecks" = "rubleBalance" * 100;

ALTER TABLE "User" ALTER COLUMN "rubleBalanceKopecks" SET DEFAULT 10000;

ALTER TABLE "BillingTransaction" ADD COLUMN "amountKopecks" INTEGER;

UPDATE "BillingTransaction"
SET "amountKopecks" = "amountRub" * 100
WHERE "amountRub" IS NOT NULL;

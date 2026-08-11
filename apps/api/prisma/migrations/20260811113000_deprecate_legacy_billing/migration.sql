-- New ledger entries use amountKopecks as the only monetary source of truth.
-- Keep legacy columns for one compatibility release before removing them.
ALTER TABLE "BillingTransaction" ALTER COLUMN "amountSeconds" SET DEFAULT 0;

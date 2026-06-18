UPDATE "BillingTransaction"
SET "amountKopecks" = COALESCE("amountKopecks", COALESCE("amountRub", 0) * 100, 0);

WITH ledger_before AS (
  SELECT
    "User"."id" AS "userId",
    "User"."rubleBalanceKopecks" - COALESCE(SUM("BillingTransaction"."amountKopecks"), 0)::INTEGER AS "differenceKopecks"
  FROM "User"
  LEFT JOIN "BillingTransaction" ON "BillingTransaction"."userId" = "User"."id"
  GROUP BY "User"."id", "User"."rubleBalanceKopecks"
)
INSERT INTO "BillingTransaction" (
  "id",
  "userId",
  "type",
  "amountSeconds",
  "amountRub",
  "amountKopecks",
  "note",
  "createdAt"
)
SELECT
  'ledger_reconcile_' || "userId",
  "userId",
  'ADMIN_ADJUSTMENT',
  0,
  NULL,
  "differenceKopecks",
  'Ledger reconciliation from cached balance before ledger-source-of-truth switch',
  CURRENT_TIMESTAMP
FROM ledger_before
WHERE "differenceKopecks" <> 0
ON CONFLICT ("id") DO NOTHING;

WITH ledger_after AS (
  SELECT
    "User"."id" AS "userId",
    COALESCE(SUM("BillingTransaction"."amountKopecks"), 0)::INTEGER AS "balanceKopecks"
  FROM "User"
  LEFT JOIN "BillingTransaction" ON "BillingTransaction"."userId" = "User"."id"
  GROUP BY "User"."id"
)
UPDATE "User"
SET
  "rubleBalanceKopecks" = ledger_after."balanceKopecks",
  "rubleBalance" = FLOOR(GREATEST(ledger_after."balanceKopecks", 0) / 100.0)::INTEGER
FROM ledger_after
WHERE "User"."id" = ledger_after."userId";

ALTER TABLE "BillingTransaction" ALTER COLUMN "amountKopecks" SET DEFAULT 0;
ALTER TABLE "BillingTransaction" ALTER COLUMN "amountKopecks" SET NOT NULL;

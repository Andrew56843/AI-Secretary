ALTER TABLE "User" ADD COLUMN "rubleBalance" INTEGER NOT NULL DEFAULT 0;

UPDATE "User"
SET "rubleBalance" = CEIL("minuteBalanceSeconds" / 60.0 * 9)::INTEGER;

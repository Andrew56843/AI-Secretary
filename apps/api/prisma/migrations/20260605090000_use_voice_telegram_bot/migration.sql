ALTER TABLE "TelegramAccount" ALTER COLUMN "botUsername" SET DEFAULT 'TestLetBot';

UPDATE "TelegramAccount"
SET "botUsername" = 'TestLetBot'
WHERE "botUsername" IN ('AISecretaryBot', 'AISecretaryDemoBot');

ALTER TABLE "TelegramAccount" ALTER COLUMN "botUsername" SET DEFAULT 'AISecretaryBot';

UPDATE "TelegramAccount"
SET "botUsername" = 'AISecretaryBot'
WHERE "botUsername" = 'AISecretaryDemoBot';

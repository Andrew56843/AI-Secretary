ALTER TABLE "AssistantProfile" ADD COLUMN "forwardingOnComplete" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AssistantProfile" ADD COLUMN "forwardingOnStalemate" BOOLEAN NOT NULL DEFAULT true;

UPDATE "AssistantProfile"
SET
  "forwardingOnComplete" = "forwardingEnabled",
  "forwardingOnStalemate" = "forwardingEnabled";

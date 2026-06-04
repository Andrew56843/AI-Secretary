ALTER TABLE "ReservedPhoneNumber" ADD COLUMN "providerDid" TEXT;

CREATE UNIQUE INDEX "ReservedPhoneNumber_providerDid_key" ON "ReservedPhoneNumber"("providerDid");

INSERT INTO "ReservedPhoneNumber" ("id", "number", "assigned", "createdAt", "updatedAt")
VALUES
  ('rpn_79952225212', '+79952225212', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('rpn_79952225213', '+79952225213', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("number") DO NOTHING;

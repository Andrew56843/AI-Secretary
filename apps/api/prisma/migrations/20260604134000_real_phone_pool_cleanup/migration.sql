DELETE FROM "ReservedPhoneNumber"
WHERE assigned = false
  AND number LIKE '+7495001000%';

UPDATE "ReservedPhoneNumber"
SET "providerDid" = regexp_replace(number, '\D', '', 'g'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE number IN ('+79952225212', '+79952225213')
  AND "providerDid" IS NULL;

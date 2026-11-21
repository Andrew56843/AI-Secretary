CREATE TABLE "SipLine" (
    "id" TEXT NOT NULL,
    "reservedNumberId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'novofon',
    "providerSipLineId" TEXT,
    "providerEmployeeId" TEXT,
    "username" TEXT NOT NULL,
    "passwordEncrypted" TEXT NOT NULL,
    "server" TEXT NOT NULL DEFAULT 'sip.novofon.ru',
    "port" INTEGER NOT NULL DEFAULT 5061,
    "transport" TEXT NOT NULL DEFAULT 'tls',
    "asteriskEndpoint" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SipLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SipLine_reservedNumberId_key" ON "SipLine"("reservedNumberId");
CREATE UNIQUE INDEX "SipLine_providerSipLineId_key" ON "SipLine"("providerSipLineId");
CREATE UNIQUE INDEX "SipLine_username_key" ON "SipLine"("username");
CREATE UNIQUE INDEX "SipLine_asteriskEndpoint_key" ON "SipLine"("asteriskEndpoint");

ALTER TABLE "SipLine" ADD CONSTRAINT "SipLine_reservedNumberId_fkey"
FOREIGN KEY ("reservedNumberId") REFERENCES "ReservedPhoneNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

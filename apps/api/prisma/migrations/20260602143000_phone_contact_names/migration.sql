-- CreateTable
CREATE TABLE "PhoneContactName" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PhoneContactName_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PhoneContactName_userId_phone_key" ON "PhoneContactName"("userId", "phone");

-- CreateIndex
CREATE INDEX "PhoneContactName_userId_idx" ON "PhoneContactName"("userId");

-- AddForeignKey
ALTER TABLE "PhoneContactName" ADD CONSTRAINT "PhoneContactName_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

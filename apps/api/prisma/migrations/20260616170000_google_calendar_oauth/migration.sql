ALTER TABLE "GoogleAccount"
  ADD COLUMN "accessToken" TEXT,
  ADD COLUMN "refreshToken" TEXT,
  ADD COLUMN "tokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "scope" TEXT;

CREATE TABLE "GoogleOAuthState" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL DEFAULT 'primary',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GoogleOAuthState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoogleOAuthState_state_key" ON "GoogleOAuthState"("state");

CREATE INDEX "GoogleOAuthState_userId_idx" ON "GoogleOAuthState"("userId");

CREATE INDEX "GoogleOAuthState_expiresAt_idx" ON "GoogleOAuthState"("expiresAt");

ALTER TABLE "GoogleOAuthState"
  ADD CONSTRAINT "GoogleOAuthState_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

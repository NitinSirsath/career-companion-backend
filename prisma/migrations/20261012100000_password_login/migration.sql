-- Sign-in with email and password, next to Google sign-in. Additive only.

-- Salted scrypt hash; NULL for a user who signs in with Google only.
ALTER TABLE "users" ADD COLUMN "passwordHash" TEXT;

-- Failed sign-ins of the last minutes, to slow down guessing. Never a password.
CREATE TABLE "login_attempts" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "login_attempts_email_createdAt_idx" ON "login_attempts"("email", "createdAt");

CREATE INDEX "login_attempts_ip_createdAt_idx" ON "login_attempts"("ip", "createdAt");

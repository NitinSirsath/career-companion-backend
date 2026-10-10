-- Fake-inbox email content for the manual test environment. Additive only.
CREATE TABLE "simulated_email_contents" (
    "emailId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "labels" TEXT[],
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "simulated_email_contents_pkey" PRIMARY KEY ("emailId")
);

CREATE INDEX "simulated_email_contents_userId_idx" ON "simulated_email_contents"("userId");

ALTER TABLE "simulated_email_contents" ADD CONSTRAINT "simulated_email_contents_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

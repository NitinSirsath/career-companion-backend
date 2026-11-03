-- CreateTable
CREATE TABLE "mail_scan_days" (
    "userId" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "mail_scan_days_pkey" PRIMARY KEY ("userId","day")
);

-- AddForeignKey
ALTER TABLE "mail_scan_days" ADD CONSTRAINT "mail_scan_days_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Count the mail already stored, by its date in UTC (the columns hold UTC times). Mail that is
-- not about a job and was already deleted cannot be counted, so older totals are partial.
INSERT INTO "mail_scan_days" ("userId", "day", "count")
SELECT "userId", to_char(COALESCE("receivedAt", "createdAt"), 'YYYY-MM-DD'), COUNT(*)::int
FROM "emails"
GROUP BY 1, 2;

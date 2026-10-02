CREATE TYPE "DeadlinePrecision" AS ENUM ('DATE', 'DATETIME');
ALTER TABLE "actions" ADD COLUMN "deadlinePrecision" "DeadlinePrecision";

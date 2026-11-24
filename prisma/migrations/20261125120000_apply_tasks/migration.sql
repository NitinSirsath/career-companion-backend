-- NorthList Apply runs as tasks (owner, 25 Nov 2026): one row per run, keyed by its start time; entries point to their run.
-- AlterTable
ALTER TABLE "external_submissions" ADD COLUMN     "taskId" UUID;

-- AlterTable
ALTER TABLE "not_submitted_jobs" ADD COLUMN     "taskId" UUID;

-- CreateTable
CREATE TABLE "apply_tasks" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "utcOffsetMinutes" INTEGER NOT NULL,
    "plan" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "apply_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "apply_tasks_userId_startedAt_key" ON "apply_tasks"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "external_submissions_taskId_idx" ON "external_submissions"("taskId");

-- CreateIndex
CREATE INDEX "not_submitted_jobs_taskId_idx" ON "not_submitted_jobs"("taskId");

-- AddForeignKey
ALTER TABLE "external_submissions" ADD CONSTRAINT "external_submissions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "apply_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "not_submitted_jobs" ADD CONSTRAINT "not_submitted_jobs_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "apply_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apply_tasks" ADD CONSTRAINT "apply_tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

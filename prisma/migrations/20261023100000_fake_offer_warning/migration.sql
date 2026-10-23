-- Fake job offer warning (owner decision, 23 Oct 2026): extraction/v4 and v5 say when a job mail
-- asks for money or bank, card or ID details. Older results keep null; they are never re-read.

-- AlterTable
ALTER TABLE "ai_processing_results" ADD COLUMN     "fakeOfferWarning" TEXT;

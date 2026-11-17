-- A named person writing to the user about their work or career, not a specific job (owner,
-- 17 Nov 2026). Such a mail never gets an application. Additive only; old mails keep their type.
ALTER TYPE "EmailCategory" ADD VALUE 'CAREER_CONTACT';

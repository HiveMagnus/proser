-- Browser sessions signed in before this instant are refused.
ALTER TABLE "users" ADD COLUMN "sessions_revoked_before" TIMESTAMP(3);

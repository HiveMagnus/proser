-- Oathweave's user ID (the OIDC `sub`) an account is keyed on after its first
-- Oathweave OIDC sign-in. Nullable and additive: existing accounts keep their
-- `github_id` handle and earlier releases ignore the column.
ALTER TABLE "users" ADD COLUMN "oathweave_subject" TEXT;
CREATE UNIQUE INDEX "users_oathweave_subject_key" ON "users"("oathweave_subject");

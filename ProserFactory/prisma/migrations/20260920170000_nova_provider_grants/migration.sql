CREATE TABLE "nova_resource_claims" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "resource_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "caller" TEXT NOT NULL,
  "grant_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "nova_resource_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uniq_nova_resource_claim" ON "nova_resource_claims"("kind", "resource_id");
CREATE INDEX "idx_nova_resource_request" ON "nova_resource_claims"("request_id", "caller", "kind");

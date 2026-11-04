-- P4-P3: 平台渠道抓取 Grant 的持久签发记录（replay 以 crawl_run_id 唯一）。
CREATE TABLE "r4_channel_crawl_grant" (
    "jti" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "page_cap" BIGINT NOT NULL,
    "crawl_run_id" UUID NOT NULL,
    "request_sha256" TEXT NOT NULL,
    "technical_policy_revision" TEXT NOT NULL,
    "cap_per_run_microusd" BIGINT NOT NULL,
    "campaign_cap_microusd" BIGINT NOT NULL,
    "max_runs" BIGINT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "token_sha256" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "r4_channel_crawl_grant_pkey" PRIMARY KEY ("jti")
);

CREATE UNIQUE INDEX "r4_channel_crawl_grant_crawl_run_id_key" ON "r4_channel_crawl_grant"("crawl_run_id");
CREATE INDEX "r4_channel_crawl_grant_channel_id_issued_at_idx" ON "r4_channel_crawl_grant"("channel_id", "issued_at");

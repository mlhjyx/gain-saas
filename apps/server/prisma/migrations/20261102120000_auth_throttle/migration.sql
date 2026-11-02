-- 登录/注册/接受邀请的持久化限流;重启与多实例下不丢计数。
CREATE TABLE "auth_throttle" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "reset_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "auth_throttle_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "auth_throttle_reset_at_idx" ON "auth_throttle"("reset_at");

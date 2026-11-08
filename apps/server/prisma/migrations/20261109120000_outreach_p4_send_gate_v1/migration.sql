-- 第 5 章 P4-01/P4-02(v1)/P4-03 发送门（《GainOS 深化计划 v3.0》ch05，DRAFT）：Additive，无回填。
-- 1) 草稿携带收件人国家（法域同意门输入，缺失按 REVIEW_REQUIRED fail-closed）；
-- 2) 批次绑定 Campaign ExecutionAuthorization（执行器只读消费，无有效授权不发）；
-- 3) 发送台账记录授权 id 与消费序号（重试沿用首次序号，不重复计数）；
-- 4) 回复台账支持投诉（ARF/人工），进投诉率熔断。

ALTER TYPE "OutreachReplyKind" ADD VALUE 'COMPLAINT';

ALTER TABLE "outreach_draft" ADD COLUMN "country_code" CHAR(2);

ALTER TABLE "outreach_batch" ADD COLUMN "authorization_id" UUID;

ALTER TABLE "outreach_send"
    ADD COLUMN "authorization_id" UUID,
    ADD COLUMN "authorization_use" INTEGER;

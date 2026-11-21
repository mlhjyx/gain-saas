-- 引擎联系人可触达性回写需要 contact_point id；draft 创建时由 SaaS 落库（legacy 行为 NULL，回写跳过）。
ALTER TABLE "outreach_draft" ADD COLUMN "contact_point_id" UUID;

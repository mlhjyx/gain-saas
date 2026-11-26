-- M9-PR2: 外联 PII enc:v2 字段加密列扩容 + 多租户 BYO 发信箱加密凭据托管 + DNS 校验状态 + 数据库行级发送租约锁
-- 遵循 #43 生产非 superuser (NOSUPERUSER NOBYPASSRLS) 迁移策略对等原则。

-- 1) 扩容外联 PII 明文列为 TEXT，容纳 enc:v2:<keyId>:<iv>:<tag>:<ct> 密文（完全向后兼容存量明文读取）
ALTER TABLE public.outreach_draft
  ALTER COLUMN recipient_email TYPE TEXT;

ALTER TABLE public.outreach_send
  ALTER COLUMN recipient_email TYPE TEXT;

ALTER TABLE public.outreach_reply
  ALTER COLUMN recipient_email TYPE TEXT;

ALTER TABLE public.outreach_unsubscribe_token
  ALTER COLUMN recipient_email TYPE TEXT;

ALTER TABLE public.outreach_call_basis
  ALTER COLUMN phone_e164 TYPE TEXT;

ALTER TABLE public.outreach_call_attempt
  ALTER COLUMN notes_ref TYPE TEXT;

-- 2) 多租户 BYO 发信箱加密凭据托管与连通性自检字段
ALTER TABLE public.outreach_mailbox
  ADD COLUMN IF NOT EXISTS auth_mode VARCHAR(24) NOT NULL DEFAULT 'password',
  ADD COLUMN IF NOT EXISTS smtp_host VARCHAR(253),
  ADD COLUMN IF NOT EXISTS smtp_port INTEGER,
  ADD COLUMN IF NOT EXISTS smtp_secure BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS imap_host VARCHAR(253),
  ADD COLUMN IF NOT EXISTS imap_port INTEGER,
  ADD COLUMN IF NOT EXISTS imap_secure BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS imap_mailbox VARCHAR(128) NOT NULL DEFAULT 'INBOX',
  ADD COLUMN IF NOT EXISTS credentials_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS credentials_key_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS credentials_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS oauth_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_verify_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS last_verify_error VARCHAR(500);

ALTER TABLE public.outreach_mailbox
  ADD CONSTRAINT outreach_mailbox_auth_mode_chk
    CHECK (auth_mode IN ('password', 'oauth_google', 'oauth_m365')),
  ADD CONSTRAINT outreach_mailbox_smtp_port_chk
    CHECK (smtp_port IS NULL OR (smtp_port BETWEEN 1 AND 65535)),
  ADD CONSTRAINT outreach_mailbox_imap_port_chk
    CHECK (imap_port IS NULL OR (imap_port BETWEEN 1 AND 65535));

-- 3) 发信域 DNS 实时核验快照（SPF / DKIM / DMARC / MX）
ALTER TABLE public.outreach_domain
  ADD COLUMN IF NOT EXISTS dkim_selector VARCHAR(63) NOT NULL DEFAULT 'google',
  ADD COLUMN IF NOT EXISTS dns_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dns_ready BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dns_report JSONB;

-- 4) 批次数据库行级发送租约锁（替代单进程内存 inFlight Set）与可选 BYO 发信箱绑定
ALTER TABLE public.outreach_batch
  ADD COLUMN IF NOT EXISTS send_lock_token UUID,
  ADD COLUMN IF NOT EXISTS send_locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mailbox_id UUID;

ALTER TABLE public.outreach_batch
  ADD CONSTRAINT outreach_batch_mailbox_id_fkey
    FOREIGN KEY (mailbox_id) REFERENCES public.outreach_mailbox(id)
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS outreach_batch_send_lock_idx
  ON public.outreach_batch (workspace_id, id, send_locked_until)
  WHERE send_lock_token IS NOT NULL;

-- 5) 受审 SECURITY DEFINER 隔离 IMAP 轮询列表函数（仅暴露激活空间中 ACTIVE 发信箱的必要连接元数据与密文）
--    复用 20261126060000 约定的 outreach_mailbox_definer_helper_select 策略命名，确保非 superuser 迁移 owner 可读且不重复建策略。
DO $$
DECLARE
  v_owner name := current_user;
BEGIN
  IF v_owner = 'gain_saas_app' THEN
    RAISE EXCEPTION 'Migration owner must not be runtime role gain_saas_app';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'outreach_mailbox'
      AND policyname = 'outreach_mailbox_definer_helper_select'
  ) THEN
    EXECUTE format(
      'CREATE POLICY outreach_mailbox_definer_helper_select ON public.outreach_mailbox FOR SELECT TO %I USING (true)',
      v_owner
    );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.app_list_byo_imap_mailboxes()
RETURNS TABLE(
  id uuid,
  workspace_id uuid,
  address text,
  auth_mode text,
  imap_host text,
  imap_port integer,
  imap_secure boolean,
  imap_mailbox text,
  credentials_ciphertext text,
  oauth_token_expires_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT
    m.id,
    m.workspace_id,
    m.address::text,
    m.auth_mode::text,
    m.imap_host::text,
    m.imap_port,
    m.imap_secure,
    m.imap_mailbox::text,
    m.credentials_ciphertext,
    m.oauth_token_expires_at
  FROM public.outreach_mailbox m
  JOIN public.workspace w ON w.id = m.workspace_id
  WHERE m.state = 'ACTIVE'
    AND w.status = 'ACTIVE'::"WorkspaceStatus"
$$;

REVOKE ALL ON FUNCTION public.app_list_byo_imap_mailboxes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_list_byo_imap_mailboxes() TO gain_saas_app;

-- M9 Prepaid Credits Wallet (W1):
-- 5 BIGINT tables (wallet_account, wallet_credit_lot, wallet_hold, wallet_ledger, billing_price_card)
-- with ENABLE + FORCE ROW LEVEL SECURITY, minimal gain_saas_app privileges (wallet_ledger append-only
-- except note redaction; billing_price_card platform read-only), and audited SECURITY DEFINER helpers
-- with explicit owner-role policies compatible with NOSUPERUSER NOBYPASSRLS production DB owners.
BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. wallet_account
CREATE TABLE "public"."wallet_account" (
  "workspace_id"       UUID         NOT NULL,
  "currency"           VARCHAR(16)  NOT NULL DEFAULT 'CREDITS',
  "available_credits"  BIGINT       NOT NULL DEFAULT 0,
  "held_credits"       BIGINT       NOT NULL DEFAULT 0,
  "lifetime_topped_up" BIGINT       NOT NULL DEFAULT 0,
  "lifetime_spent"     BIGINT       NOT NULL DEFAULT 0,
  "status"             VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
  "version"            BIGINT       NOT NULL DEFAULT 1,
  "updated_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "wallet_account_pkey" PRIMARY KEY ("workspace_id"),
  CONSTRAINT "wallet_account_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wallet_account_available_nonneg" CHECK ("available_credits" >= 0),
  CONSTRAINT "wallet_account_held_nonneg" CHECK ("held_credits" >= 0),
  CONSTRAINT "wallet_account_topped_up_nonneg" CHECK ("lifetime_topped_up" >= 0),
  CONSTRAINT "wallet_account_spent_nonneg" CHECK ("lifetime_spent" >= 0),
  CONSTRAINT "wallet_account_status_check" CHECK ("status" IN ('ACTIVE', 'FROZEN'))
);

-- 2. wallet_credit_lot
CREATE TABLE "public"."wallet_credit_lot" (
  "id"                UUID          NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id"      UUID          NOT NULL,
  "source_type"       VARCHAR(32)   NOT NULL,
  "initial_credits"   BIGINT        NOT NULL,
  "remaining_credits" BIGINT        NOT NULL,
  "unit_price_micros" BIGINT        NOT NULL DEFAULT 0,
  "priority"          SMALLINT      NOT NULL DEFAULT 10,
  "expires_at"        TIMESTAMPTZ(3),
  "external_order_id" VARCHAR(128),
  "note"              VARCHAR(500),
  "actor_id"          VARCHAR(128),
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "wallet_credit_lot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_credit_lot_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."wallet_account"("workspace_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wallet_credit_lot_source_type_check"
    CHECK ("source_type" IN ('TOPUP_PAID', 'PLAN_GRANT', 'PROMO_BONUS', 'MANUAL_ADJUST')),
  CONSTRAINT "wallet_credit_lot_initial_pos" CHECK ("initial_credits" > 0),
  CONSTRAINT "wallet_credit_lot_remaining_bounds"
    CHECK ("remaining_credits" >= 0 AND "remaining_credits" <= "initial_credits"),
  CONSTRAINT "wallet_credit_lot_unit_price_nonneg" CHECK ("unit_price_micros" >= 0)
);

CREATE UNIQUE INDEX "wallet_credit_lot_workspace_id_external_order_id_key"
  ON "public"."wallet_credit_lot"("workspace_id", "external_order_id");
CREATE INDEX "wallet_credit_lot_consume_order_idx"
  ON "public"."wallet_credit_lot"("workspace_id", "priority", "expires_at", "created_at");

-- 3. wallet_hold
CREATE TABLE "public"."wallet_hold" (
  "id"               UUID           NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id"     UUID           NOT NULL,
  "idempotency_key"  VARCHAR(160)   NOT NULL,
  "action_code"      VARCHAR(64)    NOT NULL,
  "ref_type"         VARCHAR(64)    NOT NULL,
  "ref_id"           VARCHAR(160)   NOT NULL,
  "held_credits"     BIGINT         NOT NULL,
  "settled_credits"  BIGINT         NOT NULL DEFAULT 0,
  "released_credits" BIGINT         NOT NULL DEFAULT 0,
  "status"           VARCHAR(24)    NOT NULL DEFAULT 'HELD',
  "expires_at"       TIMESTAMPTZ(3) NOT NULL,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_at"       TIMESTAMPTZ(3),

  CONSTRAINT "wallet_hold_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_hold_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."wallet_account"("workspace_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wallet_hold_held_pos" CHECK ("held_credits" > 0),
  CONSTRAINT "wallet_hold_settled_nonneg" CHECK ("settled_credits" >= 0),
  CONSTRAINT "wallet_hold_released_nonneg" CHECK ("released_credits" >= 0),
  CONSTRAINT "wallet_hold_sum_le_held" CHECK ("settled_credits" + "released_credits" <= "held_credits"),
  CONSTRAINT "wallet_hold_status_check"
    CHECK ("status" IN ('HELD', 'SETTLED', 'RELEASED', 'EXPIRED_RELEASED'))
);

CREATE UNIQUE INDEX "wallet_hold_workspace_id_idempotency_key_key"
  ON "public"."wallet_hold"("workspace_id", "idempotency_key");
CREATE INDEX "wallet_hold_status_expires_at_idx"
  ON "public"."wallet_hold"("status", "expires_at");
CREATE INDEX "wallet_hold_workspace_ref_idx"
  ON "public"."wallet_hold"("workspace_id", "ref_type", "ref_id");

-- 4. wallet_ledger (append-only double-entry ledger)
CREATE TABLE "public"."wallet_ledger" (
  "id"                UUID           NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id"      UUID           NOT NULL,
  "idempotency_key"   VARCHAR(160)   NOT NULL,
  "entry_type"        VARCHAR(24)    NOT NULL,
  "delta_available"   BIGINT         NOT NULL DEFAULT 0,
  "delta_held"        BIGINT         NOT NULL DEFAULT 0,
  "balance_available" BIGINT         NOT NULL,
  "balance_held"      BIGINT         NOT NULL,
  "revenue_micros"    BIGINT         NOT NULL DEFAULT 0,
  "hold_id"           UUID,
  "lot_id"            UUID,
  "action_code"       VARCHAR(64),
  "ref_type"          VARCHAR(64),
  "ref_id"            VARCHAR(160),
  "billable_units"    INTEGER,
  "note"              VARCHAR(500),
  "actor_id"          VARCHAR(128),
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "wallet_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_ledger_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."wallet_account"("workspace_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wallet_ledger_hold_id_fkey"
    FOREIGN KEY ("hold_id") REFERENCES "public"."wallet_hold"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wallet_ledger_lot_id_fkey"
    FOREIGN KEY ("lot_id") REFERENCES "public"."wallet_credit_lot"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wallet_ledger_entry_type_check"
    CHECK ("entry_type" IN ('TOPUP', 'PLAN_GRANT', 'HOLD', 'SETTLE', 'RELEASE', 'REFUND', 'EXPIRE', 'ADJUST')),
  CONSTRAINT "wallet_ledger_bal_avail_nonneg" CHECK ("balance_available" >= 0),
  CONSTRAINT "wallet_ledger_bal_held_nonneg" CHECK ("balance_held" >= 0),
  CONSTRAINT "wallet_ledger_revenue_nonneg" CHECK ("revenue_micros" >= 0)
);

CREATE UNIQUE INDEX "wallet_ledger_workspace_id_idempotency_key_key"
  ON "public"."wallet_ledger"("workspace_id", "idempotency_key");
CREATE INDEX "wallet_ledger_workspace_id_created_at_idx"
  ON "public"."wallet_ledger"("workspace_id", "created_at" DESC);
CREATE INDEX "wallet_ledger_entry_type_created_at_idx"
  ON "public"."wallet_ledger"("entry_type", "created_at");

-- 5. billing_price_card (platform read-only catalog for gain_saas_app)
CREATE TABLE "public"."billing_price_card" (
  "id"                 UUID           NOT NULL DEFAULT gen_random_uuid(),
  "action_code"        VARCHAR(64)    NOT NULL,
  "display_name"       VARCHAR(120)   NOT NULL,
  "pricing_mode"       VARCHAR(32)    NOT NULL,
  "credits_per_unit"   BIGINT         NOT NULL,
  "default_hold_units" INTEGER        NOT NULL DEFAULT 1,
  "effective_from"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effective_to"       TIMESTAMPTZ(3),
  "active"             BOOLEAN        NOT NULL DEFAULT true,
  "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "billing_price_card_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_price_card_pricing_mode_check"
    CHECK ("pricing_mode" IN ('PER_UNIT_OUTCOME', 'FLAT_ACTION')),
  CONSTRAINT "billing_price_card_credits_nonneg" CHECK ("credits_per_unit" >= 0),
  CONSTRAINT "billing_price_card_hold_units_pos" CHECK ("default_hold_units" >= 1)
);

CREATE UNIQUE INDEX "billing_price_card_active_action_key"
  ON "public"."billing_price_card"("action_code")
  WHERE ("active" = true);
CREATE INDEX "billing_price_card_action_active_idx"
  ON "public"."billing_price_card"("action_code", "active", "effective_from");

-- Seed default commercial price cards (idempotent; company profile & ICP remain free)
INSERT INTO "public"."billing_price_card" ("action_code", "display_name", "pricing_mode", "credits_per_unit", "default_hold_units", "active")
SELECT v.action_code, v.display_name, v.pricing_mode, v.credits_per_unit, v.default_hold_units, true
FROM (
  VALUES
    ('DISCOVERY_QUALIFIED_LEAD', '有效买家线索', 'PER_UNIT_OUTCOME', 10::bigint, 20),
    ('CONTACT_DISCOVER',         '决策人线索发现', 'PER_UNIT_OUTCOME', 5::bigint,  5),
    ('CONTACT_ENRICH',           '联系人信息补全', 'PER_UNIT_OUTCOME', 5::bigint,  5),
    ('CONTACT_VALID_EMAIL',      '验真有效邮箱',   'PER_UNIT_OUTCOME', 2::bigint,  1),
    ('OUTREACH_EMAIL_SENT',      '成功发送开发信', 'PER_UNIT_OUTCOME', 1::bigint,  1)
) AS v(action_code, display_name, pricing_mode, credits_per_unit, default_hold_units)
WHERE NOT EXISTS (
  SELECT 1 FROM "public"."billing_price_card" b
  WHERE b.action_code = v.action_code AND b.active = true
);

-- Privileges for runtime principal gain_saas_app
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."wallet_account" TO gain_saas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."wallet_credit_lot" TO gain_saas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."wallet_hold" TO gain_saas_app;

-- wallet_ledger is append-only at DB privilege level (only free-text note may be redacted on purge; no DELETE)
REVOKE ALL ON TABLE "public"."wallet_ledger" FROM gain_saas_app;
GRANT SELECT, INSERT ON TABLE "public"."wallet_ledger" TO gain_saas_app;
GRANT UPDATE ("note") ON TABLE "public"."wallet_ledger" TO gain_saas_app;

-- billing_price_card is strictly read-only for gain_saas_app
REVOKE ALL ON TABLE "public"."billing_price_card" FROM gain_saas_app;
GRANT SELECT ON TABLE "public"."billing_price_card" TO gain_saas_app;

-- ENABLE + FORCE RLS on all 5 tables
ALTER TABLE "public"."wallet_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."wallet_account" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wallet_account_tenant_isolation" ON "public"."wallet_account";
CREATE POLICY "wallet_account_tenant_isolation"
  ON "public"."wallet_account"
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

ALTER TABLE "public"."wallet_credit_lot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."wallet_credit_lot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wallet_credit_lot_tenant_isolation" ON "public"."wallet_credit_lot";
CREATE POLICY "wallet_credit_lot_tenant_isolation"
  ON "public"."wallet_credit_lot"
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

ALTER TABLE "public"."wallet_hold" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."wallet_hold" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wallet_hold_tenant_isolation" ON "public"."wallet_hold";
CREATE POLICY "wallet_hold_tenant_isolation"
  ON "public"."wallet_hold"
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

ALTER TABLE "public"."wallet_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."wallet_ledger" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wallet_ledger_tenant_isolation" ON "public"."wallet_ledger";
CREATE POLICY "wallet_ledger_tenant_isolation"
  ON "public"."wallet_ledger"
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

ALTER TABLE "public"."billing_price_card" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."billing_price_card" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "billing_price_card_platform_read" ON "public"."billing_price_card";
CREATE POLICY "billing_price_card_platform_read"
  ON "public"."billing_price_card"
  FOR SELECT
  TO gain_saas_app
  USING (true);

-- Explicit minimal owner-role policies for SECURITY DEFINER helpers (NOSUPERUSER NOBYPASSRLS parity)
DO $$
DECLARE
  owner_role TEXT := current_user;
  t TEXT;
  select_tables TEXT[] := ARRAY['wallet_account', 'wallet_hold', 'wallet_ledger'];
BEGIN
  IF owner_role = 'gain_saas_app' THEN
    RAISE EXCEPTION 'RLS_DEFINER_POLICY_OWNER_MUST_NOT_BE_APP_ROLE';
  END IF;

  FOREACH t IN ARRAY select_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_definer_helper_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO %I USING (true)',
      t || '_definer_helper_select',
      t,
      owner_role
    );
  END LOOP;

  DROP POLICY IF EXISTS "billing_price_card_definer_helper_all" ON "public"."billing_price_card";
  EXECUTE format(
    'CREATE POLICY %I ON public.billing_price_card FOR ALL TO %I USING (true) WITH CHECK (true)',
    'billing_price_card_definer_helper_all',
    owner_role
  );
END $$;

-- Audited SECURITY DEFINER helpers (5 functions)
CREATE OR REPLACE FUNCTION public.app_list_expired_wallet_holds(p_limit INTEGER DEFAULT 50)
RETURNS TABLE (
  id           UUID,
  workspace_id UUID,
  action_code  VARCHAR,
  ref_type     VARCHAR,
  ref_id       VARCHAR,
  held_credits BIGINT,
  expires_at   TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT h.id, h.workspace_id, h.action_code, h.ref_type, h.ref_id, h.held_credits, h.expires_at
  FROM public.wallet_hold h
  WHERE h.status = 'HELD'
    AND h.expires_at <= CURRENT_TIMESTAMP
  ORDER BY h.expires_at ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
$$;

REVOKE ALL ON FUNCTION public.app_list_expired_wallet_holds(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_list_expired_wallet_holds(INTEGER) TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_ops_list_wallet_accounts(
  p_limit  INTEGER DEFAULT 100,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  workspace_id       UUID,
  workspace_name     TEXT,
  workspace_status   TEXT,
  currency           VARCHAR,
  available_credits  BIGINT,
  held_credits       BIGINT,
  lifetime_topped_up BIGINT,
  lifetime_spent     BIGINT,
  wallet_status      VARCHAR,
  updated_at         TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    w.id AS workspace_id,
    w.name::text AS workspace_name,
    w.status::text AS workspace_status,
    COALESCE(a.currency, 'CREDITS')::varchar AS currency,
    COALESCE(a.available_credits, 0::bigint) AS available_credits,
    COALESCE(a.held_credits, 0::bigint) AS held_credits,
    COALESCE(a.lifetime_topped_up, 0::bigint) AS lifetime_topped_up,
    COALESCE(a.lifetime_spent, 0::bigint) AS lifetime_spent,
    COALESCE(a.status, 'ACTIVE')::varchar AS wallet_status,
    COALESCE(a.updated_at, w.updated_at::timestamptz) AS updated_at
  FROM public.workspace w
  LEFT JOIN public.wallet_account a ON a.workspace_id = w.id
  ORDER BY COALESCE(a.lifetime_spent, 0) DESC, w.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

REVOKE ALL ON FUNCTION public.app_ops_list_wallet_accounts(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_ops_list_wallet_accounts(INTEGER, INTEGER) TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_ops_wallet_profit_summary(
  p_from         TIMESTAMPTZ,
  p_to           TIMESTAMPTZ,
  p_workspace_id UUID DEFAULT NULL
)
RETURNS TABLE (
  workspace_id        UUID,
  workspace_name      TEXT,
  settled_credits     BIGINT,
  paid_revenue_micros BIGINT,
  topup_credits       BIGINT,
  bonus_credits       BIGINT,
  released_credits    BIGINT,
  ledger_entries      BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    l.workspace_id,
    w.name::text AS workspace_name,
    COALESCE(SUM(CASE WHEN l.entry_type = 'SETTLE' THEN ABS(l.delta_held) ELSE 0 END), 0)::bigint AS settled_credits,
    COALESCE(SUM(CASE WHEN l.entry_type = 'SETTLE' THEN l.revenue_micros ELSE 0 END), 0)::bigint AS paid_revenue_micros,
    COALESCE(SUM(CASE WHEN l.entry_type = 'TOPUP' THEN GREATEST(l.delta_available, 0) ELSE 0 END), 0)::bigint AS topup_credits,
    COALESCE(SUM(CASE WHEN l.entry_type IN ('PLAN_GRANT', 'ADJUST') THEN GREATEST(l.delta_available, 0) ELSE 0 END), 0)::bigint AS bonus_credits,
    COALESCE(SUM(CASE WHEN l.entry_type IN ('RELEASE', 'EXPIRE') AND l.hold_id IS NOT NULL THEN GREATEST(l.delta_available, 0) ELSE 0 END), 0)::bigint AS released_credits,
    COUNT(*)::bigint AS ledger_entries
  FROM public.wallet_ledger l
  JOIN public.workspace w ON w.id = l.workspace_id
  WHERE l.created_at >= p_from
    AND l.created_at < p_to
    AND (p_workspace_id IS NULL OR l.workspace_id = p_workspace_id)
  GROUP BY l.workspace_id, w.name
  ORDER BY paid_revenue_micros DESC, settled_credits DESC;
$$;

REVOKE ALL ON FUNCTION public.app_ops_wallet_profit_summary(TIMESTAMPTZ, TIMESTAMPTZ, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_ops_wallet_profit_summary(TIMESTAMPTZ, TIMESTAMPTZ, UUID) TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_ops_create_price_card(
  p_action_code        VARCHAR,
  p_display_name       VARCHAR,
  p_pricing_mode       VARCHAR,
  p_credits_per_unit   BIGINT,
  p_default_hold_units INTEGER,
  p_active             BOOLEAN DEFAULT true
)
RETURNS SETOF public.billing_price_card
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_active THEN
    UPDATE public.billing_price_card
    SET active = false,
        effective_to = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE action_code = p_action_code
      AND active = true;
  END IF;

  RETURN QUERY
  INSERT INTO public.billing_price_card (
    action_code,
    display_name,
    pricing_mode,
    credits_per_unit,
    default_hold_units,
    active
  )
  VALUES (
    p_action_code,
    p_display_name,
    p_pricing_mode,
    p_credits_per_unit,
    p_default_hold_units,
    p_active
  )
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.app_ops_create_price_card(VARCHAR, VARCHAR, VARCHAR, BIGINT, INTEGER, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_ops_create_price_card(VARCHAR, VARCHAR, VARCHAR, BIGINT, INTEGER, BOOLEAN) TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_ops_update_price_card(
  p_id                 UUID,
  p_display_name       VARCHAR,
  p_pricing_mode       VARCHAR,
  p_credits_per_unit   BIGINT,
  p_default_hold_units INTEGER,
  p_active             BOOLEAN
)
RETURNS SETOF public.billing_price_card
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_action VARCHAR(64);
BEGIN
  SELECT action_code INTO v_action
  FROM public.billing_price_card
  WHERE id = p_id
  FOR UPDATE;

  IF v_action IS NULL THEN
    RETURN;
  END IF;

  IF p_active THEN
    UPDATE public.billing_price_card
    SET active = false,
        effective_to = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE action_code = v_action
      AND active = true
      AND id <> p_id;
  END IF;

  RETURN QUERY
  UPDATE public.billing_price_card
  SET display_name = COALESCE(p_display_name, display_name),
      pricing_mode = COALESCE(p_pricing_mode, pricing_mode),
      credits_per_unit = COALESCE(p_credits_per_unit, credits_per_unit),
      default_hold_units = COALESCE(p_default_hold_units, default_hold_units),
      active = COALESCE(p_active, active),
      effective_to = CASE
        WHEN COALESCE(p_active, active) = false AND effective_to IS NULL THEN CURRENT_TIMESTAMP
        WHEN COALESCE(p_active, active) = true THEN NULL
        ELSE effective_to
      END,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_id
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.app_ops_update_price_card(UUID, VARCHAR, VARCHAR, BIGINT, INTEGER, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_ops_update_price_card(UUID, VARCHAR, VARCHAR, BIGINT, INTEGER, BOOLEAN) TO gain_saas_app;

COMMIT;

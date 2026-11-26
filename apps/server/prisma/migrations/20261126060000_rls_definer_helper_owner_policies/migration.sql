-- Allow the migration/table owner role executing the 15 audited SECURITY DEFINER
-- helper functions (app_find_login_membership, app_list_user_workspaces, etc.)
-- to read/claim across workspaces under FORCE ROW LEVEL SECURITY even when the
-- owner is NOSUPERUSER NOBYPASSRLS (as in production / gain_saas DB).
--
-- Runtime principal gain_saas_app has zero role memberships (enforced at boot
-- by PrismaService.verifyPrincipal) and therefore remains strictly bound by
-- <table_name>_tenant_isolation across all 53 tenant tables.
BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  owner_role TEXT := current_user;
  t TEXT;
  select_tables TEXT[] := ARRAY[
    'membership',
    'invitation',
    'outreach_unsubscribe_token',
    'workspace_registry',
    'outreach_mailbox',
    'outreach_send_job',
    'outreach_bounce_writeback',
    'campaign_approval',
    'campaign_decision_trace',
    'campaign_revision'
  ];
  update_tables TEXT[] := ARRAY[
    'outreach_send_job',
    'outreach_bounce_writeback'
  ];
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

  FOREACH t IN ARRAY update_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_definer_helper_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO %I USING (true) WITH CHECK (true)',
      t || '_definer_helper_update',
      t,
      owner_role
    );
  END LOOP;
END $$;

COMMIT;

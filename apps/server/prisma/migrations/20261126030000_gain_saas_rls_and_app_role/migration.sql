BEGIN;

-- 1. Non-superuser, non-BYPASSRLS runtime role (idempotent, cluster-global, no password literal)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gain_saas_app') THEN
    CREATE ROLE gain_saas_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO gain_saas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gain_saas_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gain_saas_app;
REVOKE ALL ON TABLE "_prisma_migrations" FROM PUBLIC, gain_saas_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gain_saas_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gain_saas_app;

-- 2. Tenant context helper (fail-closed NULL when unset or empty)
CREATE OR REPLACE FUNCTION public.current_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.current_workspace_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION public.current_workspace_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_workspace_id() TO gain_saas_app;

-- 3. Enable & Force RLS on all 50 tenant tables
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'acquisition_task', 'campaign', 'campaign_approval', 'campaign_audience',
    'campaign_decision_trace', 'campaign_execution_authorization', 'campaign_plan_job',
    'campaign_revision', 'cost_ledger', 'deletion_mirror', 'discovery_run_link',
    'event_inbox', 'feedback_submission', 'idempotency_record', 'invitation',
    'legal_review', 'membership', 'notification', 'opportunity_outcome',
    'outreach_audit_package', 'outreach_batch', 'outreach_batch_approval',
    'outreach_batch_event', 'outreach_bounce_writeback', 'outreach_breaker',
    'outreach_call_attempt', 'outreach_call_basis', 'outreach_consent',
    'outreach_domain', 'outreach_domain_counter', 'outreach_draft',
    'outreach_experiment', 'outreach_experiment_assignment', 'outreach_health_event',
    'outreach_mailbox', 'outreach_mailbox_counter', 'outreach_metric_snapshot',
    'outreach_reply', 'outreach_seed_test', 'outreach_send', 'outreach_send_job',
    'outreach_template_version', 'outreach_unsubscribe_token', 'qgo',
    'qualified_lead', 'sao', 'task_run', 'workspace_budget_policy',
    'workspace_compliance_declaration', 'workspace_registry'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I USING (workspace_id = public.current_workspace_id()) WITH CHECK (workspace_id = public.current_workspace_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- 4. Attribution views must run as invoker so PG16 enforces RLS for gain_saas_app
ALTER VIEW public."v_campaign_authorized_plans" SET (security_invoker = true);
ALTER VIEW public."v_campaign_attribution" SET (security_invoker = true);
ALTER VIEW public."v_outcome_chain" SET (security_invoker = true);

-- 5. Least-privilege SECURITY DEFINER helpers for pre-auth / cross-workspace / worker / ops paths

CREATE OR REPLACE FUNCTION public.app_find_login_membership(p_user_id uuid)
RETURNS TABLE(
  id uuid,
  workspace_id uuid,
  role text,
  workspace_status text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT m.id, m.workspace_id, m.role, w.status::text AS workspace_status
  FROM public.membership m
  JOIN public.workspace w ON w.id = m.workspace_id
  WHERE m.user_id = p_user_id
    AND m.status = 'active'
  ORDER BY m.created_at ASC
$$;
REVOKE ALL ON FUNCTION public.app_find_login_membership(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_find_login_membership(uuid) TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_list_user_workspaces(p_user_id uuid)
RETURNS TABLE(
  workspace_id uuid,
  workspace_name text,
  workspace_status text,
  role text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT m.workspace_id, w.name AS workspace_name, w.status::text AS workspace_status, m.role
  FROM public.membership m
  JOIN public.workspace w ON w.id = m.workspace_id
  WHERE m.user_id = p_user_id
    AND m.status = 'active'
    AND w.status = 'ACTIVE'::"WorkspaceStatus"
  ORDER BY m.created_at ASC
$$;
REVOKE ALL ON FUNCTION public.app_list_user_workspaces(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_list_user_workspaces(uuid) TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_lookup_invitation_by_token(p_token text)
RETURNS TABLE(
  id uuid,
  workspace_id uuid,
  email text,
  role text,
  expires_at timestamp(3),
  accepted_at timestamp(3),
  workspace_status text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT i.id, i.workspace_id, i.email, i.role, i.expires_at, i.accepted_at, w.status::text AS workspace_status
  FROM public.invitation i
  JOIN public.workspace w ON w.id = i.workspace_id
  WHERE i.token = p_token
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.app_lookup_invitation_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_lookup_invitation_by_token(text) TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_lookup_unsubscribe_token(p_token_hash char(64))
RETURNS TABLE(
  id uuid,
  workspace_id uuid,
  contact_ref uuid,
  recipient_email text,
  expires_at timestamp(3),
  used_at timestamp(3)
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT t.id, t.workspace_id, t.contact_ref, t.recipient_email::text, t.expires_at, t.used_at
  FROM public.outreach_unsubscribe_token t
  WHERE t.token_hash = p_token_hash
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.app_lookup_unsubscribe_token(char(64)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_lookup_unsubscribe_token(char(64)) TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_list_enabled_workspaces()
RETURNS TABLE(
  workspace_id uuid,
  cursor text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT r.workspace_id, r.cursor
  FROM public.workspace_registry r
  JOIN public.workspace w ON w.id = r.workspace_id
  WHERE r.enabled = true
    AND w.status = 'ACTIVE'::"WorkspaceStatus"
$$;
REVOKE ALL ON FUNCTION public.app_list_enabled_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_list_enabled_workspaces() TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_list_active_outreach_workspaces()
RETURNS TABLE(workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT DISTINCT m.workspace_id
  FROM public.outreach_mailbox m
  JOIN public.workspace w ON w.id = m.workspace_id
  WHERE w.status = 'ACTIVE'::"WorkspaceStatus"
$$;
REVOKE ALL ON FUNCTION public.app_list_active_outreach_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_list_active_outreach_workspaces() TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_list_active_outreach_mailboxes()
RETURNS TABLE(
  workspace_id uuid,
  address text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT m.workspace_id, m.address::text
  FROM public.outreach_mailbox m
  JOIN public.workspace w ON w.id = m.workspace_id
  WHERE m.state = 'ACTIVE'
    AND w.status = 'ACTIVE'::"WorkspaceStatus"
$$;
REVOKE ALL ON FUNCTION public.app_list_active_outreach_mailboxes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_list_active_outreach_mailboxes() TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_claim_outreach_send_jobs(
  p_limit integer,
  p_now timestamptz,
  p_claim_token uuid
)
RETURNS TABLE(
  id uuid,
  workspace_id uuid,
  batch_id uuid,
  draft_id uuid,
  attempts integer
)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH due AS (
    SELECT j.id
    FROM public.outreach_send_job j
    WHERE j.state = 'PENDING'::"OutreachSendJobState"
      AND j.next_attempt_at <= (p_now AT TIME ZONE 'UTC')
    ORDER BY j.next_attempt_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outreach_send_job j
  SET state = 'CLAIMED'::"OutreachSendJobState",
      claim_token = p_claim_token,
      claimed_at = (p_now AT TIME ZONE 'UTC'),
      attempts = j.attempts + 1,
      updated_at = (now() AT TIME ZONE 'UTC')
  FROM due
  WHERE j.id = due.id
  RETURNING j.id, j.workspace_id, j.batch_id, j.draft_id, j.attempts
$$;
REVOKE ALL ON FUNCTION public.app_claim_outreach_send_jobs(integer, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_claim_outreach_send_jobs(integer, timestamptz, uuid) TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_list_pending_bounce_writebacks(
  p_limit integer,
  p_max_attempts integer
)
RETURNS TABLE(
  id uuid,
  workspace_id uuid,
  contact_point_id uuid,
  event text,
  message_id text,
  smtp_code text,
  received_at timestamp(3),
  attempts integer
)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT b.id, b.workspace_id, b.contact_point_id, b.event::text, b.message_id::text, b.smtp_code::text, b.received_at, b.attempts
  FROM public.outreach_bounce_writeback b
  WHERE b.status = 'PENDING'
    AND b.attempts < p_max_attempts
  ORDER BY b.created_at ASC
  LIMIT p_limit
  FOR UPDATE SKIP LOCKED
$$;
REVOKE ALL ON FUNCTION public.app_list_pending_bounce_writebacks(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_list_pending_bounce_writebacks(integer, integer) TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_ops_list_workspaces()
RETURNS TABLE(
  id uuid,
  name text,
  status text,
  status_updated_at timestamp(3),
  status_note text,
  created_at timestamp(3),
  member_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT w.id, w.name, w.status::text AS status, w.status_updated_at, w.status_note, w.created_at,
         count(m.id) FILTER (WHERE m.status = 'active')::bigint AS member_count
  FROM public.workspace w
  LEFT JOIN public.membership m ON m.workspace_id = w.id
  GROUP BY w.id, w.name, w.status, w.status_updated_at, w.status_note, w.created_at
  ORDER BY w.created_at ASC
$$;
REVOKE ALL ON FUNCTION public.app_ops_list_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_ops_list_workspaces() TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_ops_list_user_memberships(p_user_ids uuid[])
RETURNS TABLE(
  user_id uuid,
  workspace_id uuid,
  workspace_name text,
  role text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT m.user_id, m.workspace_id, w.name AS workspace_name, m.role
  FROM public.membership m
  JOIN public.workspace w ON w.id = m.workspace_id
  WHERE m.user_id = ANY(p_user_ids)
    AND m.status = 'active'
  ORDER BY m.created_at ASC
$$;
REVOKE ALL ON FUNCTION public.app_ops_list_user_memberships(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_ops_list_user_memberships(uuid[]) TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_ops_campaign_approvals(
  p_workspace_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE(
  id uuid,
  revision_id uuid,
  state text,
  decided_at timestamp(3),
  expires_at timestamp(3),
  created_at timestamp(3),
  campaign_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT ca.id, ca.revision_id, ca.state::text, ca.decided_at, ca.expires_at, ca.created_at, cr.campaign_id
  FROM public.campaign_approval ca
  JOIN public.campaign_revision cr ON cr.id = ca.revision_id
  WHERE (p_workspace_id IS NULL OR ca.workspace_id = p_workspace_id)
    AND ca.created_at >= (p_from AT TIME ZONE 'UTC')
    AND ca.created_at < (p_to AT TIME ZONE 'UTC')
$$;
REVOKE ALL ON FUNCTION public.app_ops_campaign_approvals(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_ops_campaign_approvals(uuid, timestamptz, timestamptz) TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_ops_campaign_replan_traces(
  p_workspace_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE(
  campaign_id uuid,
  cost_actual_micros bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT t.campaign_id, t.cost_actual_micros
  FROM public.campaign_decision_trace t
  WHERE t.decision_type = 'campaign.replan'
    AND (p_workspace_id IS NULL OR t.workspace_id = p_workspace_id)
    AND t.created_at >= (p_from AT TIME ZONE 'UTC')
    AND t.created_at < (p_to AT TIME ZONE 'UTC')
$$;
REVOKE ALL ON FUNCTION public.app_ops_campaign_replan_traces(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_ops_campaign_replan_traces(uuid, timestamptz, timestamptz) TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_ops_campaign_revisions_by_ids(p_revision_ids uuid[])
RETURNS TABLE(
  id uuid,
  campaign_id uuid,
  revision_no integer,
  plan jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT r.id, r.campaign_id, r.revision_no, r.plan
  FROM public.campaign_revision r
  WHERE r.id = ANY(p_revision_ids)
$$;
REVOKE ALL ON FUNCTION public.app_ops_campaign_revisions_by_ids(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_ops_campaign_revisions_by_ids(uuid[]) TO gain_saas_app;

CREATE OR REPLACE FUNCTION public.app_ops_campaign_revisions_by_campaigns(p_campaign_ids uuid[])
RETURNS TABLE(
  id uuid,
  campaign_id uuid,
  revision_no integer,
  plan jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT r.id, r.campaign_id, r.revision_no, r.plan
  FROM public.campaign_revision r
  WHERE r.campaign_id = ANY(p_campaign_ids)
$$;
REVOKE ALL ON FUNCTION public.app_ops_campaign_revisions_by_campaigns(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_ops_campaign_revisions_by_campaigns(uuid[]) TO gain_saas_app;

COMMIT;

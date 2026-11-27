import type { MockBackend } from './mock-backend';

export function allowSourcing(backend: MockBackend, companyId: string | null = null): void {
  const { session } = backend;
  backend.set('GET', '/workspace/context', {
    allowedActions: ['acquisition.run', 'leads.review'],
    onboarding: { companyId, complete: backend.onboardingComplete },
    user: session.user,
    workspace: { ...session.workspaces[0], role: session.workspace.role },
  });
}

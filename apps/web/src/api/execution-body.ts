import type { components } from '@gain-saas/engine-client';

/** Only generated engine contract fields can opt a new execution into evidence capture. */
export type ExecutionFeatureOptions = Pick<
  components['schemas']['ExecuteQueryPlanDto'],
  'manufacturerNetworkRevision'
>;

/** Legacy bodies retain their exact shape; options cannot overwrite the user's attempt. */
export function buildExecutionBody(attemptId?: string, options?: ExecutionFeatureOptions) {
  const revision = options?.manufacturerNetworkRevision;
  return {
    ...(attemptId ? { attemptId } : {}),
    ...(revision === undefined ? {} : { manufacturerNetworkRevision: revision }),
  };
}

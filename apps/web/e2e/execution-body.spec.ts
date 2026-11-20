import { expect, test } from '@playwright/test';
import { buildExecutionBody } from '../src/api/execution-body';

test('legacy execution keeps its exact empty or attempt-only body', () => {
  expect(buildExecutionBody()).toEqual({});
  expect(buildExecutionBody('same-attempt')).toEqual({ attemptId: 'same-attempt' });
});

test('explicit evidence capture preserves the original attempt and known option', () => {
  for (const revision of ['manufacturer-network/v1', 'manufacturer-network/v2'] as const) {
    expect(buildExecutionBody('same-attempt', { manufacturerNetworkRevision: revision })).toEqual({
      attemptId: 'same-attempt', manufacturerNetworkRevision: revision,
    });
  }
});

test('feature options cannot replace the operation attempt or add unrelated request fields', () => {
  const options = { manufacturerNetworkRevision: 'manufacturer-network/v2', attemptId: 'changed', planId: 'changed', taskRef: { taskId: 'changed' } };
  expect(buildExecutionBody('frozen-attempt', options as never)).toEqual({
    attemptId: 'frozen-attempt', manufacturerNetworkRevision: 'manufacturer-network/v2',
  });
});

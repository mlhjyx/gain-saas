import { describe, expect, it } from 'vitest';
import { BFF_ROUTES, budgetQuoteRequest } from './routes.js';

describe('understanding retry BFF route', () => {
  const route = BFF_ROUTES.find(
    (candidate) => candidate.saasPath === 'companies/:companyId/understanding/retry',
  );

  it('is registered as a member write that needs an Execution Budget Grant', () => {
    expect(route).toBeDefined();
    expect(route).toMatchObject({
      method: 'POST',
      enginePath: '/companies/:companyId/understanding/retry',
      access: 'member',
      grant: true,
    });
  });

  it('maps to the engine quote operation for the addressed company', () => {
    expect(budgetQuoteRequest(route!, { companyId: 'c1' }, {})).toEqual({
      operation: 'POST /companies/:companyId/understanding/retry',
      companyId: 'c1',
    });
  });
});

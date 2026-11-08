import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { OutreachSendGate } from './outreach-send.gate.js';

function gate(enabled: boolean) {
  return new OutreachSendGate({ OUTREACH_SEND_ENABLED: enabled } as AppConfig);
}

describe('OutreachSendGate', () => {
  it('is fail-closed by default', () => {
    const g = gate(false);
    expect(g.enabled()).toBe(false);
    expect(() => g.assertEnabled()).toThrowError('Conflict Exception');
    try {
      g.assertEnabled();
    } catch (error) {
      expect((error as { response?: { error?: { code?: string } } }).response?.error?.code).toBe(
        'OUTREACH_SEND_DISABLED',
      );
    }
  });

  it('only allows sending when explicitly enabled', () => {
    const g = gate(true);
    expect(g.enabled()).toBe(true);
    expect(() => g.assertEnabled()).not.toThrow();
  });
});

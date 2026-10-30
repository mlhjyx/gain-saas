import { describe, expect, it } from 'vitest';
import { SecretBox } from './secret-box.js';

describe('SecretBox', () => {
  it('round-trips a provider key without exposing plaintext', () => {
    const box = new SecretBox('test-material-0123456789abcdef');
    const cipher = box.encrypt('sk-upstream-secret');
    expect(cipher.startsWith('v1:')).toBe(true);
    expect(cipher).not.toContain('sk-upstream-secret');
    expect(box.decrypt(cipher)).toBe('sk-upstream-secret');
  });

  it('rejects tampered ciphertext', () => {
    const box = new SecretBox('test-material-0123456789abcdef');
    const cipher = box.encrypt('sk-upstream-secret');
    const parts = cipher.split(':');
    parts[3] = `${parts[3]}AAAA`;
    expect(() => box.decrypt(parts.join(':'))).toThrow();
  });

  it('rejects a different encryption material', () => {
    const cipher = new SecretBox('material-a').encrypt('sk-upstream-secret');
    expect(() => new SecretBox('material-b').decrypt(cipher)).toThrow();
  });
});

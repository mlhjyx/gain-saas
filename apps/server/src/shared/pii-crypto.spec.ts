import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import {
  PiiCryptoError,
  blindIndexEquals,
  computeAllPiiBlindIndexes,
  computePiiBlindIndex,
  decryptPii,
  encryptPii,
  extractPiiKeyId,
  isEncryptedPii,
  parsePiiKeyring,
} from './pii-crypto.js';
import { PiiCryptoService } from './pii-crypto.service.js';

const KEY_1_HEX = '11'.repeat(32);
const KEY_2_HEX = '22'.repeat(32);

describe('pii-crypto (enc:v2 HKDF-SHA256 + workspaceId AAD + Keyring rotation)', () => {
  const wsA = randomUUID();
  const wsB = randomUUID();

  it('encrypts with enc:v2:<keyId> format and isolates ciphertexts across workspaces and purposes', () => {
    const keyring = parsePiiKeyring(
      JSON.stringify({ activeKeyId: 'k1', keys: { k1: KEY_1_HEX } }),
    )!;
    const ct = encryptPii(keyring, wsA, 'buyer@acme.de', 'outreach_draft.recipient_email');

    expect(isEncryptedPii(ct)).toBe(true);
    expect(ct.startsWith('enc:v2:k1:')).toBe(true);
    expect(extractPiiKeyId(ct)).toBe('k1');
    expect(ct).not.toContain('buyer@acme.de');

    // Same workspace + same purpose decrypts cleanly
    expect(decryptPii(keyring, wsA, ct, 'outreach_draft.recipient_email')).toBe('buyer@acme.de');

    // Cross-workspace transplant fails GCM authentication
    expect(() =>
      decryptPii(keyring, wsB, ct, 'outreach_draft.recipient_email'),
    ).toThrow(PiiCryptoError);

    // Cross-purpose replay fails GCM authentication
    expect(() =>
      decryptPii(keyring, wsA, ct, 'outreach_send.recipient_email'),
    ).toThrow(PiiCryptoError);

    // Tampered ciphertext fails GCM authentication
    const tampered = `${ct.slice(0, -2)}AA`;
    expect(() =>
      decryptPii(keyring, wsA, tampered, 'outreach_draft.recipient_email'),
    ).toThrow(PiiCryptoError);
  });

  it('supports zero-downtime keyring rotation and legacy plaintext read compatibility', () => {
    const ringV1 = parsePiiKeyring(
      JSON.stringify({ activeKeyId: 'k1', keys: { k1: KEY_1_HEX } }),
    )!;
    const oldCt = encryptPii(ringV1, wsA, '+49301234567', 'outreach_call_basis.phone_e164');

    const ringV2 = parsePiiKeyring(
      JSON.stringify({ activeKeyId: 'k2', keys: { k1: KEY_1_HEX, k2: KEY_2_HEX } }),
    )!;
    // Old ciphertext still decrypts under rotated keyring
    expect(decryptPii(ringV2, wsA, oldCt, 'outreach_call_basis.phone_e164')).toBe('+49301234567');
    // New writes use k2
    const newCt = encryptPii(ringV2, wsA, '+49301234567', 'outreach_call_basis.phone_e164');
    expect(extractPiiKeyId(newCt)).toBe('k2');
    expect(decryptPii(ringV2, wsA, newCt, 'outreach_call_basis.phone_e164')).toBe('+49301234567');

    // Legacy plaintext passes through transparently during migration
    expect(decryptPii(ringV2, wsA, 'legacy@example.com', 'outreach_draft.recipient_email')).toBe(
      'legacy@example.com',
    );
  });

  it('computes tenant-scoped HMAC-SHA256 blind indexes across rotated keys', () => {
    const ring = parsePiiKeyring(
      JSON.stringify({ activeKeyId: 'k2', keys: { k1: KEY_1_HEX, k2: KEY_2_HEX } }),
    )!;
    const biA = computePiiBlindIndex(ring, wsA, 'buyer@acme.de', 'email');
    const biB = computePiiBlindIndex(ring, wsB, 'buyer@acme.de', 'email');
    expect(biA.startsWith('bi:v2:k2:')).toBe(true);
    expect(blindIndexEquals(biA, biB)).toBe(false);

    const all = computeAllPiiBlindIndexes(ring, wsA, 'buyer@acme.de', 'email');
    expect(all).toHaveLength(2);
    expect(all.some((h) => h.startsWith('bi:v2:k1:'))).toBe(true);
    expect(all.some((h) => h.startsWith('bi:v2:k2:'))).toBe(true);
  });

  it('PiiCryptoService fails closed on encryptSecret when keyring is unconfigured', () => {
    const disabled = new PiiCryptoService({} as AppConfig);
    expect(disabled.enabled).toBe(false);
    expect(disabled.encryptField(wsA, 'a@b.com', 'p')).toBe('a@b.com');
    expect(() => disabled.encryptSecret(wsA, 'secret-pass', 'mailbox')).toThrow();

    const enabled = new PiiCryptoService({
      PII_KEYRING_JSON: JSON.stringify({ activeKeyId: 'k1', keys: { k1: KEY_1_HEX } }),
    } as unknown as AppConfig);
    expect(enabled.enabled).toBe(true);
    const { ciphertext, keyId } = enabled.encryptSecret(wsA, '{"pass":"p1"}', 'mailbox');
    expect(keyId).toBe('k1');
    expect(enabled.decryptSecret(wsA, ciphertext, 'mailbox')).toBe('{"pass":"p1"}');
    // encryptField avoids double-encryption on active ciphertext
    expect(enabled.encryptField(wsA, ciphertext, 'mailbox')).toBe(ciphertext);
  });
});

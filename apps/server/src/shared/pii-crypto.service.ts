import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AppConfig } from '../config/configuration.js';
import { APP_CONFIG } from './config.module.js';
import {
  PiiCryptoError,
  computePiiBlindIndex,
  decryptPii,
  encryptPii,
  extractPiiKeyId,
  isEncryptedPii,
  parsePiiKeyring,
  type PiiCryptoOptions,
  type PiiKeyring,
} from './pii-crypto.js';

/**
 * gain_saas 外联 PII 与 BYO 邮箱凭据加密服务：
 * - 统一采用 enc:v2（每租户 HKDF-SHA256 DEK + workspaceId/purpose AAD + Keyring 零停机轮换）；
 * - 外联 PII 列（邮箱/电话）支持迁移期兼容读取存量明文；配置密钥环后写入自动加密；
 * - 高敏感凭据（BYO SMTP/IMAP 密码与 OAuth2 token）强制要求密钥环存在（fail-closed，绝不明文落库）。
 */
@Injectable()
export class PiiCryptoService {
  private readonly keyring: PiiKeyring | null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const ext = config as AppConfig & {
      PII_KEYRING_JSON?: string;
      PII_ENCRYPTION_KEY?: string;
    };
    this.keyring = parsePiiKeyring(ext.PII_KEYRING_JSON, ext.PII_ENCRYPTION_KEY);
  }

  get enabled(): boolean {
    return this.keyring !== null;
  }

  get activeKeyId(): string | null {
    return this.keyring?.activeKeyId ?? null;
  }

  requireKeyring(): PiiKeyring {
    if (!this.keyring) {
      throw new ServiceUnavailableException({
        error: {
          code: 'PII_CRYPTO_NOT_CONFIGURED',
          message: '平台未配置加密密钥环（PII_KEYRING_JSON），拒绝存储敏感凭据',
        },
      });
    }
    return this.keyring;
  }

  /** 外联 PII 写入：若已配置密钥环则输出 enc:v2 密文；未配置时仅在非强制模式下透传原值。 */
  encryptField(
    workspaceId: string,
    plaintext: string,
    purpose: string,
    options?: PiiCryptoOptions,
  ): string {
    if (!this.keyring) return plaintext;
    if (isEncryptedPii(plaintext)) {
      // 防双重加密：已是活跃 keyId 的合法密文则原样返回（先验可解密）
      const decrypted = decryptPii(this.keyring, workspaceId, plaintext, purpose);
      if (extractPiiKeyId(plaintext) === this.keyring.activeKeyId) {
        return plaintext;
      }
      return encryptPii(this.keyring, workspaceId, decrypted, purpose, options);
    }
    return encryptPii(this.keyring, workspaceId, plaintext, purpose, options);
  }

  encryptNullableField(
    workspaceId: string,
    plaintext: string | null | undefined,
    purpose: string,
    options?: PiiCryptoOptions,
  ): string | null {
    if (plaintext === null || plaintext === undefined) return null;
    return this.encryptField(workspaceId, plaintext, purpose, options);
  }

  /** 外联 PII 读取：enc:v2 密文解密返回，存量明文原样兼容返回。 */
  decryptField(workspaceId: string, stored: string, purpose: string): string {
    if (!isEncryptedPii(stored)) return stored;
    const keyring = this.requireKeyring();
    return decryptPii(keyring, workspaceId, stored, purpose);
  }

  decryptNullableField(
    workspaceId: string,
    stored: string | null | undefined,
    purpose: string,
  ): string | null {
    if (stored === null || stored === undefined) return null;
    return this.decryptField(workspaceId, stored, purpose);
  }

  /** 高敏感密文（如 BYO SMTP/IMAP 凭据、OAuth state/token）：强制 fail-closed 加密。 */
  encryptSecret(workspaceId: string, plaintext: string, purpose: string): {
    ciphertext: string;
    keyId: string;
  } {
    const keyring = this.requireKeyring();
    return {
      ciphertext: encryptPii(keyring, workspaceId, plaintext, purpose),
      keyId: keyring.activeKeyId,
    };
  }

  decryptSecret(workspaceId: string, ciphertext: string, purpose: string): string {
    const keyring = this.requireKeyring();
    if (!isEncryptedPii(ciphertext)) {
      throw new PiiCryptoError('PII_DECRYPT_FAILED', '敏感凭据缺少 enc:v2 密文封装');
    }
    return decryptPii(keyring, workspaceId, ciphertext, purpose);
  }

  blindIndex(workspaceId: string, normalizedValue: string, purpose: string): string | null {
    if (!this.keyring) return null;
    return computePiiBlindIndex(this.keyring, workspaceId, normalizedValue, purpose);
  }

  needsRotation(stored: string | null | undefined): boolean {
    if (!this.keyring || !stored) return false;
    if (!isEncryptedPii(stored)) return true;
    return extractPiiKeyId(stored) !== this.keyring.activeKeyId;
  }
}

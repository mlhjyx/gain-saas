import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * gain_saas 多租户 PII 字段级加密与盲索引原语（与 global-backend M8 字节级同标准）：
 * - 密文格式：`enc:v2:<keyId>:<ivB64>:<tagB64>:<ctB64>`（AES-256-GCM，12 字节 IV，16 字节 AuthTag）
 * - 盲索引格式：`bi:v2:<keyId>:<hex64>`（HMAC-SHA256，支持不解密精准查重）
 * - 每租户 DEK 派生：HKDF-SHA256(ikm=masterKey, salt=`ws:${workspaceId}`, info=`pii-dek:v2`, 32B)
 * - GCM AAD：`pii:v2:ws:${workspaceId}:${purpose}`（绑定租户与字段用途，防止跨租户/跨列密文移植）
 * - 密钥环零停机轮换：`PII_KEYRING_JSON={"activeKeyId":"k2","keys":{"k1":"...","k2":"..."}}`
 */

export const PII_CIPHERTEXT_PREFIX = 'enc:v2:';
export const PII_BLIND_INDEX_PREFIX = 'bi:v2:';

const AES_ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

const INFO_DEK = Buffer.from('pii-dek:v2', 'utf8');
const INFO_IV = Buffer.from('pii-iv-key:v2', 'utf8');
const INFO_BLIND = Buffer.from('pii-blind-key:v2', 'utf8');

export interface PiiKeyring {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface PiiCryptoOptions {
  readonly deterministic?: boolean;
}

export class PiiCryptoError extends Error {
  constructor(
    readonly code:
      | 'PII_KEYRING_INVALID'
      | 'PII_KEY_NOT_FOUND'
      | 'PII_DECRYPT_FAILED'
      | 'PII_CRYPTO_NOT_CONFIGURED',
    message: string,
  ) {
    super(message);
    this.name = 'PiiCryptoError';
  }
}

export function isEncryptedPii(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PII_CIPHERTEXT_PREFIX);
}

export function extractPiiKeyId(ciphertext: string): string | null {
  if (!isEncryptedPii(ciphertext)) return null;
  const rest = ciphertext.slice(PII_CIPHERTEXT_PREFIX.length);
  const idx = rest.indexOf(':');
  if (idx <= 0) return null;
  const keyId = rest.slice(0, idx);
  return KEY_ID_RE.test(keyId) ? keyId : null;
}

function decodeKeyMaterial(raw: string, label: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  const b64 = Buffer.from(trimmed, 'base64');
  if (b64.length === KEY_BYTES) {
    return b64;
  }
  throw new PiiCryptoError(
    'PII_KEYRING_INVALID',
    `${label} 必须是 32 字节（64 位 hex 或 44 位 base64）密钥材料`,
  );
}

export function parsePiiKeyring(
  keyringJson?: string | null,
  legacySingleKey?: string | null,
): PiiKeyring | null {
  const jsonText = keyringJson?.trim();
  if (jsonText) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new PiiCryptoError('PII_KEYRING_INVALID', 'PII_KEYRING_JSON 不是合法 JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new PiiCryptoError('PII_KEYRING_INVALID', 'PII_KEYRING_JSON 必须是 JSON 对象');
    }
    const obj = parsed as Record<string, unknown>;
    const activeKeyId = typeof obj.activeKeyId === 'string' ? obj.activeKeyId.trim() : '';
    if (!KEY_ID_RE.test(activeKeyId)) {
      throw new PiiCryptoError('PII_KEYRING_INVALID', 'PII_KEYRING_JSON.activeKeyId 格式非法');
    }
    const rawKeys = obj.keys;
    if (!rawKeys || typeof rawKeys !== 'object' || Array.isArray(rawKeys)) {
      throw new PiiCryptoError('PII_KEYRING_INVALID', 'PII_KEYRING_JSON.keys 必须是非空对象');
    }
    const keys = new Map<string, Buffer>();
    for (const [k, v] of Object.entries(rawKeys as Record<string, unknown>)) {
      if (!KEY_ID_RE.test(k) || typeof v !== 'string') {
        throw new PiiCryptoError('PII_KEYRING_INVALID', `PII_KEYRING_JSON 键 ${k} 不合法`);
      }
      keys.set(k, decodeKeyMaterial(v, `keys.${k}`));
    }
    if (!keys.has(activeKeyId)) {
      throw new PiiCryptoError(
        'PII_KEYRING_INVALID',
        `PII_KEYRING_JSON.activeKeyId (${activeKeyId}) 未出现在 keys 映射中`,
      );
    }
    return { activeKeyId, keys };
  }

  const single = legacySingleKey?.trim();
  if (single) {
    return {
      activeKeyId: 'v1',
      keys: new Map([['v1', decodeKeyMaterial(single, 'PII_ENCRYPTION_KEY')]]),
    };
  }

  return null;
}

function deriveKey(masterKey: Buffer, workspaceId: string, info: Buffer): Buffer {
  const salt = Buffer.from(`ws:${workspaceId}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', masterKey, salt, info, KEY_BYTES));
}

function buildAad(workspaceId: string, purpose: string): Buffer {
  return Buffer.from(`pii:v2:ws:${workspaceId}:${purpose}`, 'utf8');
}

export function encryptPii(
  keyring: PiiKeyring,
  workspaceId: string,
  plaintext: string,
  purpose: string,
  options: PiiCryptoOptions = {},
): string {
  const masterKey = keyring.keys.get(keyring.activeKeyId);
  if (!masterKey) {
    throw new PiiCryptoError('PII_KEY_NOT_FOUND', `活跃密钥 ${keyring.activeKeyId} 不存在`);
  }
  const dek = deriveKey(masterKey, workspaceId, INFO_DEK);
  const aad = buildAad(workspaceId, purpose);

  let iv: Buffer;
  if (options.deterministic) {
    const ivKey = deriveKey(masterKey, workspaceId, INFO_IV);
    iv = createHmac('sha256', ivKey)
      .update(purpose, 'utf8')
      .update('\0')
      .update(plaintext, 'utf8')
      .digest()
      .subarray(0, IV_BYTES);
  } else {
    iv = randomBytes(IV_BYTES);
  }

  const cipher = createCipheriv(AES_ALGO, dek, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PII_CIPHERTEXT_PREFIX}${keyring.activeKeyId}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeStrictBase64(value: string): Buffer {
  if (!STRICT_BASE64_RE.test(value)) {
    throw new PiiCryptoError('PII_DECRYPT_FAILED', 'enc:v2 base64 编码非法或被篡改');
  }
  const buf = Buffer.from(value, 'base64');
  if (buf.toString('base64') !== value) {
    throw new PiiCryptoError('PII_DECRYPT_FAILED', 'enc:v2 base64 编码非规范形式');
  }
  return buf;
}

export function decryptPii(
  keyring: PiiKeyring,
  workspaceId: string,
  ciphertext: string,
  purpose: string,
): string {
  if (!isEncryptedPii(ciphertext)) {
    // 兼容迁移期存量明文读取
    return ciphertext;
  }
  const body = ciphertext.slice(PII_CIPHERTEXT_PREFIX.length);
  const parts = body.split(':');
  if (parts.length !== 4) {
    throw new PiiCryptoError('PII_DECRYPT_FAILED', 'enc:v2 密文格式损坏');
  }
  const [keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const masterKey = keyring.keys.get(keyId);
  if (!masterKey) {
    throw new PiiCryptoError('PII_KEY_NOT_FOUND', `密钥环缺少 keyId=${keyId}`);
  }
  const iv = decodeStrictBase64(ivB64);
  const tag = decodeStrictBase64(tagB64);
  const ct = decodeStrictBase64(ctB64);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new PiiCryptoError('PII_DECRYPT_FAILED', 'enc:v2 IV/AuthTag 长度不合法');
  }
  const dek = deriveKey(masterKey, workspaceId, INFO_DEK);
  const aad = buildAad(workspaceId, purpose);
  try {
    const decipher = createDecipheriv(AES_ALGO, dek, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new PiiCryptoError('PII_DECRYPT_FAILED', 'enc:v2 解密失败（密钥、租户或用途不匹配）');
  }
}

export function computePiiBlindIndex(
  keyring: PiiKeyring,
  workspaceId: string,
  normalizedValue: string,
  purpose: string,
  keyId: string = keyring.activeKeyId,
): string {
  const masterKey = keyring.keys.get(keyId);
  if (!masterKey) {
    throw new PiiCryptoError('PII_KEY_NOT_FOUND', `密钥环缺少 keyId=${keyId}`);
  }
  const blindKey = deriveKey(masterKey, workspaceId, INFO_BLIND);
  const digest = createHmac('sha256', blindKey)
    .update(purpose, 'utf8')
    .update('\0')
    .update(normalizedValue, 'utf8')
    .digest('hex');
  return `${PII_BLIND_INDEX_PREFIX}${keyId}:${digest}`;
}

export function computeAllPiiBlindIndexes(
  keyring: PiiKeyring,
  workspaceId: string,
  normalizedValue: string,
  purpose: string,
): string[] {
  const out: string[] = [];
  for (const keyId of keyring.keys.keys()) {
    out.push(computePiiBlindIndex(keyring, workspaceId, normalizedValue, purpose, keyId));
  }
  return out;
}

export function blindIndexEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

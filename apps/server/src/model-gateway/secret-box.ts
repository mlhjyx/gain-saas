import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * 上游 API Key 落库加密(AES-256-GCM)。
 * 密钥材料优先 MODEL_GATEWAY_ENC_KEY,缺失时用 SESSION_SECRET 派生;都不进库。
 * 密文格式 v1:<iv b64>:<tag b64>:<ciphertext b64>。
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(material: string) {
    this.key = createHash('sha256').update(`gainos-model-gateway:v1:${material}`).digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [version, ivB64, tagB64, ciphertextB64] = payload.split(':');
    if (version !== 'v1' || !ivB64 || !tagB64 || !ciphertextB64) {
      throw new Error('MODEL_PROVIDER_KEY_CORRUPT');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}

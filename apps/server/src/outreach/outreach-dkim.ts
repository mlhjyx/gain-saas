import { createHash, sign as cryptoSign } from 'node:crypto';

export interface DkimSigningOptions {
  domain: string;
  selector: string;
  privateKeyPem: string;
  now?: Date;
}

function sha256Base64(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('base64');
}

/** RFC 6376 relaxed body canonicalization。 */
export function canonicalizeDkimBody(body: string): string {
  const lines = body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.length > 0 ? `${lines.join('\r\n')}\r\n` : '\r\n';
}

/** RFC 6376 relaxed header canonicalization（保留末尾 CRLF，签名头除外由调用方裁掉）。 */
export function canonicalizeDkimHeader(name: string, value: string): string {
  const unfolded = value.replace(/\r?\n[ \t]+/g, ' ');
  const normalized = unfolded.replace(/[ \t]+/g, ' ').replace(/^ /, '').replace(/[ \t]+$/, '');
  return `${name.trim().toLowerCase()}:${normalized}\r\n`;
}

const SIGNED_HEADERS = [
  'from',
  'to',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'list-unsubscribe',
  'list-unsubscribe-post',
] as const;

/**
 * 给已构建的 MIME 消息加 DKIM-Signature（relaxed/relaxed, rsa-sha256）。
 * 返回带签名头的新消息；不做 DNS 发布——测试时由验证工具注入公钥。
 */
export function signDkimMessage(mime: string, options: DkimSigningOptions): string {
  const separator = mime.indexOf('\r\n\r\n');
  if (separator === -1) throw new Error('MIME 消息缺少头/正文分隔');
  const headerBlock = mime.slice(0, separator);
  const body = mime.slice(separator + 4);

  const headers = new Map<string, string>();
  for (const line of headerBlock.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) throw new Error('MIME 头格式不合法');
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1));
  }
  const selected = SIGNED_HEADERS.filter((name) => headers.has(name));
  if (!selected.includes('from') || !selected.includes('subject')) {
    throw new Error('DKIM 需要 From 与 Subject 头');
  }

  const bodyHash = sha256Base64(canonicalizeDkimBody(body));
  const dkimValueBase = [
    'v=1',
    'a=rsa-sha256',
    'c=relaxed/relaxed',
    `d=${options.domain}`,
    `s=${options.selector}`,
    `t=${Math.floor((options.now ?? new Date()).getTime() / 1000)}`,
    `h=${selected.join(':')}`,
    `bh=${bodyHash}`,
    'b=',
  ].join('; ');

  const signingInput =
    selected
      .map((name) => canonicalizeDkimHeader(name, headers.get(name)!))
      .join('') + canonicalizeDkimHeader('DKIM-Signature', dkimValueBase).slice(0, -2);
  const signature = cryptoSign('sha256', Buffer.from(signingInput, 'utf8'), options.privateKeyPem)
    .toString('base64');

  return `DKIM-Signature: ${dkimValueBase}${signature}\r\n${mime}`;
}

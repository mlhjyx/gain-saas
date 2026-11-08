/**
 * 入站邮件解析（P4-06 ingest 核心，纯函数、无 IO）：
 * - 普通回复：In-Reply-To / References → 归因到 outreach_send.messageId；
 * - DSN 退信（multipart/report; report-type=delivery-status）：解析 Status/Action/收件人/原邮件 id，
 *   5.x.x=硬退（永久压制），4.x.x=软退（计数，不压制）；
 * - ARF 投诉（report-type=feedback-report）：Feedback-Type + 原收件人/原邮件 id。
 * 只覆盖产品会收到的邮件形态（纯文本 / multipart / base64 / quoted-printable），不做完整 MIME。
 */

export interface EmailHeaders {
  [name: string]: string[];
}

export interface EmailPart {
  contentType: string;
  reportType: string | null;
  headers: EmailHeaders;
  body: string;
}

export interface ParsedEmail {
  headers: EmailHeaders;
  subject: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string | null;
  contentType: string;
  reportType: string | null;
  parts: EmailPart[];
  textBody: string;
}

function splitHeaderBlock(block: string): EmailHeaders {
  const headers: EmailHeaders = {};
  let lastName: string | null = null;
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    if (/^[ \t]/.test(line) && lastName) {
      const values = headers[lastName];
      values[values.length - 1] = `${values[values.length - 1]} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] ?? [];
    headers[name].push(value);
    lastName = name;
  }
  return headers;
}

function splitHeadersAndBody(raw: string): { headers: EmailHeaders; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  const boundaryIndex = normalized.indexOf('\n\n');
  if (boundaryIndex === -1) return { headers: splitHeaderBlock(normalized), body: '' };
  return {
    headers: splitHeaderBlock(normalized.slice(0, boundaryIndex)),
    body: normalized.slice(boundaryIndex + 2),
  };
}

export function headerValues(headers: EmailHeaders, name: string): string[] {
  return headers[name.toLowerCase()] ?? [];
}

export function headerValue(headers: EmailHeaders, name: string): string | null {
  return headerValues(headers, name)[0] ?? null;
}

function parseContentType(value: string | null): {
  mediaType: string;
  params: Record<string, string>;
} {
  if (!value) return { mediaType: 'text/plain', params: {} };
  const [typePart, ...paramParts] = value.split(';');
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[name] = val;
  }
  return { mediaType: typePart.trim().toLowerCase(), params };
}

function decodeQuotedPrintable(input: string): string {
  const withoutSoftBreaks = input.replace(/=\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < withoutSoftBreaks.length; index += 1) {
    const char = withoutSoftBreaks[index];
    if (char === '=' && index + 2 < withoutSoftBreaks.length) {
      const hex = withoutSoftBreaks.slice(index + 1, index + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    bytes.push(char.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeBody(body: string, encoding: string | null): string {
  const cte = (encoding ?? '').toLowerCase();
  if (cte === 'base64') {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  if (cte === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const segments = body.split(delimiter);
  const parts: string[] = [];
  for (const segment of segments.slice(1)) {
    if (segment.startsWith('--')) break; // 结束分隔符
    parts.push(segment.replace(/^\n/, ''));
  }
  return parts;
}

export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /<([^<>\s]+)>/.exec(value);
  const id = (match ? match[1] : value.trim().split(/\s+/)[0] ?? '').trim();
  return id || null;
}

export function parseEmail(raw: string): ParsedEmail {
  const top = splitHeadersAndBody(raw);
  const contentType = parseContentType(headerValue(top.headers, 'content-type'));
  const parts: EmailPart[] = [];
  if (contentType.mediaType.startsWith('multipart/') && contentType.params.boundary) {
    for (const segment of splitMultipart(top.body, contentType.params.boundary)) {
      const parsed = splitHeadersAndBody(segment);
      const partType = parseContentType(headerValue(parsed.headers, 'content-type'));
      parts.push({
        contentType: partType.mediaType,
        reportType: partType.params['report-type'] ?? null,
        headers: parsed.headers,
        body: decodeBody(
          parsed.body,
          headerValue(parsed.headers, 'content-transfer-encoding'),
        ),
      });
    }
  }
  const directText =
    contentType.mediaType === 'text/plain'
      ? decodeBody(top.body, headerValue(top.headers, 'content-transfer-encoding'))
      : null;
  const textBody =
    directText ?? parts.find((part) => part.contentType === 'text/plain')?.body ?? '';
  const references = (headerValue(top.headers, 'references') ?? '')
    .split(/\s+/)
    .map((value) => normalizeMessageId(value))
    .filter((value): value is string => Boolean(value));
  return {
    headers: top.headers,
    subject: headerValue(top.headers, 'subject'),
    messageId: normalizeMessageId(headerValue(top.headers, 'message-id')),
    inReplyTo: normalizeMessageId(headerValue(top.headers, 'in-reply-to')),
    references,
    from: headerValue(top.headers, 'from'),
    contentType: contentType.mediaType,
    reportType: contentType.params['report-type'] ?? null,
    parts,
    textBody,
  };
}

export interface ParsedBounce {
  hard: boolean;
  status: string | null;
  action: string | null;
  recipient: string | null;
  messageId: string | null;
  diagnostic: string | null;
}

function extractAddress(value: string | null): string | null {
  if (!value) return null;
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  if (angle) return angle[1].toLowerCase();
  const bare = /[^\s<>;,]+@[^\s<>;,]+/.exec(value);
  return bare ? bare[0].toLowerCase() : null;
}

/** 解析 DSN；非退信返回 null。 */
export function parseDsn(email: ParsedEmail): ParsedBounce | null {
  const dsnPart = email.parts.find((part) => part.contentType === 'message/delivery-status');
  if (!dsnPart && email.reportType !== 'delivery-status') return null;
  const blocks = (dsnPart?.body ?? '')
    .split(/\n\s*\n/)
    .map((block) => splitHeaderBlock(block))
    .filter((headers) => Object.keys(headers).length > 0);
  const merged: EmailHeaders = {};
  for (const block of blocks) {
    for (const [name, values] of Object.entries(block)) {
      merged[name] = [...(merged[name] ?? []), ...values];
    }
  }
  const status = headerValue(merged, 'status');
  const originalRfc822 = email.parts.find((part) => part.contentType === 'message/rfc822');
  const originalHeaders = originalRfc822
    ? splitHeadersAndBody(originalRfc822.body).headers
    : {};
  const messageId =
    normalizeMessageId(headerValue(merged, 'original-message-id')) ??
    normalizeMessageId(headerValue(originalHeaders, 'message-id')) ??
    email.inReplyTo ??
    email.references[0] ??
    null;
  return {
    hard: /^5\./.test(status ?? ''),
    status,
    action: headerValue(merged, 'action'),
    recipient:
      extractAddress(headerValue(merged, 'final-recipient')) ??
      extractAddress(headerValue(merged, 'original-recipient')),
    messageId,
    diagnostic: headerValue(merged, 'diagnostic-code'),
  };
}

export interface ParsedComplaint {
  feedbackType: string | null;
  recipient: string | null;
  messageId: string | null;
}

/** 解析 ARF 投诉报告；非投诉返回 null。 */
export function parseArf(email: ParsedEmail): ParsedComplaint | null {
  const arfPart = email.parts.find((part) => part.contentType === 'message/feedback-report');
  if (!arfPart && email.reportType !== 'feedback-report') return null;
  // RFC 5965：feedback-report 部件的「正文」本身就是一组头字段。
  const arfHeaders = splitHeaderBlock(arfPart?.body ?? '');
  const originalRfc822 = email.parts.find((part) => part.contentType === 'message/rfc822');
  const originalHeaders = originalRfc822
    ? splitHeadersAndBody(originalRfc822.body).headers
    : {};
  return {
    feedbackType: headerValue(arfHeaders, 'feedback-type'),
    recipient: extractAddress(headerValue(arfHeaders, 'original-rcpt-to')),
    messageId:
      normalizeMessageId(headerValue(arfHeaders, 'original-message-id')) ??
      normalizeMessageId(headerValue(originalHeaders, 'message-id')) ??
      email.inReplyTo ??
      email.references[0] ??
      null,
  };
}

const UNSUBSCRIBE_RE = /unsubscribe|abmelden|d[ée]sinscri(?:re|ption)/i;

/** 保守的退订识别：只匹配明确的退订关键词，不做情绪/意图推断（分类由步 13 技能负责）。 */
export function looksLikeUnsubscribe(email: ParsedEmail): boolean {
  return UNSUBSCRIBE_RE.test(email.subject ?? '') || UNSUBSCRIBE_RE.test(email.textBody);
}

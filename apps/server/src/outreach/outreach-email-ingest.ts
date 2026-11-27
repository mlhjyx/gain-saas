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

const MAX_RAW_EMAIL_BYTES = 256 * 1024;
const MAX_MIME_DEPTH = 6;

function decodeRfc2047Word(charset: string, encoding: string, encoded: string): string {
  const enc = encoding.toUpperCase();
  let bytes: Buffer;
  if (enc === 'B') {
    bytes = Buffer.from(encoded, 'base64');
  } else if (enc === 'Q') {
    const out: number[] = [];
    const normalized = encoded.replace(/_/g, ' ');
    for (let i = 0; i < normalized.length; i += 1) {
      if (normalized[i] === '=' && i + 2 < normalized.length && /^[0-9A-Fa-f]{2}$/.test(normalized.slice(i + 1, i + 3))) {
        out.push(parseInt(normalized.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        out.push(normalized.charCodeAt(i) & 0xff);
      }
    }
    bytes = Buffer.from(out);
  } else {
    return encoded;
  }
  const lower = charset.toLowerCase();
  if (lower === 'iso-8859-1' || lower === 'latin1' || lower === 'windows-1252') {
    return bytes.toString('latin1');
  }
  return bytes.toString('utf8');
}

/** 解码 RFC 2047 邮件头（=?UTF-8?B?...?= / =?ISO-8859-1?Q?...?=）。 */
export function decodeRfc2047Header(value: string | null): string | null {
  if (!value) return null;
  // RFC 2047 §6.2：相邻编码词之间的空白应折叠消除。
  const collapsed = value.replace(/\?=\s+=\?/g, '?==?');
  return collapsed.replace(
    /=\?([^?\s]+)\?([bBqQ])\?([^?\s]+)\?=/g,
    (_full, charset: string, enc: string, payload: string) => decodeRfc2047Word(charset, enc, payload),
  );
}

function collectMultipartParts(body: string, boundary: string, depth: number, acc: EmailPart[]): void {
  if (depth >= MAX_MIME_DEPTH) return;
  for (const segment of splitMultipart(body, boundary)) {
    const parsed = splitHeadersAndBody(segment);
    const partType = parseContentType(headerValue(parsed.headers, 'content-type'));
    if (partType.mediaType.startsWith('multipart/') && partType.params.boundary) {
      collectMultipartParts(parsed.body, partType.params.boundary, depth + 1, acc);
      continue;
    }
    acc.push({
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

export function parseEmail(raw: string): ParsedEmail {
  const safeRaw =
    Buffer.byteLength(raw, 'utf8') > MAX_RAW_EMAIL_BYTES
      ? Buffer.from(raw, 'utf8').subarray(0, MAX_RAW_EMAIL_BYTES).toString('utf8')
      : raw;
  const top = splitHeadersAndBody(safeRaw);
  const contentType = parseContentType(headerValue(top.headers, 'content-type'));
  const parts: EmailPart[] = [];
  if (contentType.mediaType.startsWith('multipart/') && contentType.params.boundary) {
    collectMultipartParts(top.body, contentType.params.boundary, 0, parts);
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
    subject: decodeRfc2047Header(headerValue(top.headers, 'subject')),
    messageId: normalizeMessageId(headerValue(top.headers, 'message-id')),
    inReplyTo: normalizeMessageId(headerValue(top.headers, 'in-reply-to')),
    references,
    from: decodeRfc2047Header(headerValue(top.headers, 'from')),
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

const QUOTE_SEPARATOR_PATTERNS: readonly RegExp[] = [
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^-{2,}\s*Ursprüngliche Nachricht\s*-{2,}/i,
  /^-{2,}\s*Messaggio originale\s*-{2,}/i,
  /^On .+ wrote:\s*$/i,
  /^Am .+ schrieb .+:\s*$/i,
  /^Le .+ a écrit\s*:\s*$/i,
  /^Il giorno .+ ha scritto:\s*$/i,
  /^El .+ escribió:\s*$/i,
  /^Em .+ escreveu:\s*$/i,
  /^From:\s+.+@.+$/i,
  /^Von:\s+.+@.+$/i,
  /^_{5,}$/,
];

/**
 * 剥离回信末尾引用的原外联邮件正文（防止我方页脚自带的 Unsubscribe/Abmelden 令正常买家回复全部误判退订拉黑）。
 */
export function stripQuotedReplyText(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('>')) continue;
    if (QUOTE_SEPARATOR_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      break;
    }
    kept.push(line);
  }
  return kept.join('\n').trim();
}

const OOO_SUBJECT_RE =
  /\b(?:out of office|auto(?:matic)?\s*reply|autoreply|abwesenheitsnotiz|automatische\s+antwort|fuori\s+ufficio|respuesta\s+autom[áa]tica|r[ée]ponse\s+automatique)\b/i;

/** 识别自动回复 / 外出休假（OOO），避免把休假自动回复误判为有效回复或退订。 */
export function isAutoReplyOrOoo(email: ParsedEmail): boolean {
  const autoSubmitted = (headerValue(email.headers, 'auto-submitted') ?? '').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  const xAutoreply = (headerValue(email.headers, 'x-autoreply') ?? '').trim().toLowerCase();
  if (xAutoreply === 'yes' || xAutoreply === 'true') return true;
  if (headerValue(email.headers, 'x-auto-response-suppress')) return true;
  const precedence = (headerValue(email.headers, 'precedence') ?? '').trim().toLowerCase();
  if (precedence === 'auto_reply' || precedence === 'junk') return true;
  return OOO_SUBJECT_RE.test(email.subject ?? '');
}

/** 保守的退订识别：剥离引用块后只匹配买家亲写的明确退订关键词，绝不因引用我方原邮件页脚误杀正常回复。 */
export function looksLikeUnsubscribe(email: ParsedEmail): boolean {
  if (isAutoReplyOrOoo(email)) return false;
  const stripped = stripQuotedReplyText(email.textBody);
  return UNSUBSCRIBE_RE.test(email.subject ?? '') || UNSUBSCRIBE_RE.test(stripped);
}

export type OutreachReplyIntent =
  | 'REFERRAL_NEW_CONTACT'
  | 'ASK_DATASHEET_QUOTE'
  | 'OBJECTION_PRICE_OR_SUPPLIER'
  | 'POSITIVE_INTEREST'
  | 'TIMING_LATER'
  | 'NEGATIVE_DECLINE'
  | 'OUT_OF_OFFICE'
  | 'NONE';

export interface ReplyIntentAnalysis {
  readonly intent: OutreachReplyIntent;
  readonly classification: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'OUT_OF_OFFICE' | 'UNKNOWN';
  /** 从转交回复正文里提取到的候选新联系人邮箱（已剔除发件人/原收件人自身）。 */
  readonly referredEmails: readonly string[];
}

const NEGATIVE_DECLINE_RE =
  /\b(?:not\s+interested|no\s+interest|no\s+thanks|do\s+not\s+contact|don'?t\s+contact|stop\s+(?:emailing|contacting|writing)|remove\s+(?:me|us)|kein\s+interesse|nicht\s+interessiert|bitte\s+nicht\s+mehr\s+(?:kontaktieren|schreiben)|non\s+interessat[oi]|pas\s+int[ée]ress[ée]|no\s+(?:nos\s+)?interesa|n[ãa]o\s+temos\s+interesse)\b|(?:不需要|暂无需求|不用再联系|请勿再(?:联系|发邮件)|退订)/iu;

const REFERRAL_RE =
  /\b(?:please\s+(?:contact|reach\s+out\s+to|write\s+to|email)|right\s+person|person\s+in\s+charge|forward(?:ed|ing)?\s+(?:this|your)|loop(?:ed|ing)?\s+in|in\s+cc|cc'?d|copied|wenden\s+sie\s+sich\s+an|weitergeleitet|zust[äa]ndig|ansprechpartner|contattare|inoltrato|responsabile\s+acquisti|contactar\s+(?:con|a)|encaminh(?:ei|ando)|respons[áa]vel\s+de\s+compras|contacter|transmis\s+[àa])\b|(?:请联系|转交(?:给|了)|负责采购|抄送给)/iu;

const OBJECTION_PRICE_OR_SUPPLIER_RE =
  /\b(?:already\s+(?:have|work(?:ing)?\s+with)\s+(?:a|our|an\s+existing)\s+(?:supplier|vendor|partner|manufacturer)|existing\s+(?:supplier|vendor)|happy\s+with\s+(?:our|current)\s+(?:supplier|vendor)|price\s+(?:is\s+)?(?:too\s+high|not\s+competitive)|too\s+expensive|moq\s+(?:is\s+)?too\s+high|out\s+of\s+budget|bereits\s+einen\s+lieferanten|preis\s+(?:ist\s+)?zu\s+hoch|gi[àa]\s+un\s+fornitore|prezzo\s+troppo\s+alto|ya\s+tenemos\s+proveedor|precio\s+demasiado\s+alto|j[áa]\s+temos\s+fornecedor|d[ée]j[àa]\s+un\s+fournisseur)\b|(?:已有(?:固定)?供应商|价格(?:太高|偏高)|起订量(?:太高|过高)|超出预算)/iu;

const DATASHEET_QUOTE_RE =
  /\b(?:data\s*sheet|spec(?:ification)?\s*sheet|quote|quotation|price\s*list|pricing|moq|sample|cif|fob|ddp|iec\s*6\d{4}|angebot|datenblatt|preisliste|muster|preventivo|scheda\s+tecnica|listino|cotizaci[óo]n|ficha\s+t[ée]cnica|or[çc]amento|tabela\s+de\s+pre[çc]os|devis|fiche\s+technique)\b|(?:规格书|参数表|报价单|价目表|目录|样品|起订量)/iu;

const POSITIVE_INTEREST_RE =
  /\b(?:klingt\s+interessant|rufen\s+sie\s+(?:mich\s+|uns\s+)?an|sounds?\s+(?:interesting|good)|interested|let'?s\s+(?:talk|connect|discuss)|call\s+me|schedule\s+a\s+call|send\s+(?:more\s+)?info|tell\s+me\s+more|happy\s+to\s+discuss|ci\s+interessa|int[ée]ress[ée]|nos\s+interesa|temos\s+interesse)\b|(?:感兴趣|方便通话|发点资料|详细聊聊)/iu;

const TIMING_LATER_RE =
  /\b(?:next\s+(?:quarter|year|month)|in\s+(?:q[1-4]|\d+\s+months?)|reach\s+out\s+(?:later|again\s+in)|check\s+back|not\s+(?:right\s+now|at\s+the\s+moment)|n[äa]chstes\s+(?:quartal|jahr)|sp[äa]ter\s+(?:nochmal|wieder)|prossimo\s+trimestre|pi[ùu]\s+avanti|m[áa]s\s+adelante|pr[óo]ximo\s+trimestre|plus\s+tard|trimestre\s+prochain)\b|(?:下个?季度|明年再|过段时间|晚些时候再联系)/iu;

const INLINE_EMAIL_RE = /\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/giu;

/**
 * 细粒度回复意图分类（Batch 1.4 + Phase 1 拒联识别 + Step 5 异议归类）：
 *  - NEGATIVE_DECLINE：明确拒绝/要求停止联系 → NEGATIVE（触发 OPT_OUT）；
 *  - REFERRAL_NEW_CONTACT：转交采购联系人 → POSITIVE（自动提取候选新邮箱）；
 *  - OBJECTION_PRICE_OR_SUPPLIER：已有供应商/价格或 MOQ 异议 → NEUTRAL（不拉黑，转异议副驾）；
 *  - ASK_DATASHEET_QUOTE：索取规格书/认证/报价 → POSITIVE；
 *  - POSITIVE_INTEREST：明确表达兴趣/邀约电话 → POSITIVE；
 *  - TIMING_LATER：下季度/延后联系 → NEUTRAL。
 * 严格在 stripQuotedReplyText 后分析，绝不把原发信正文的词或邮箱误当成买家意图。
 */
export function classifyReplyIntent(
  email: ParsedEmail,
  excludeEmails: readonly (string | null | undefined)[] = [],
): ReplyIntentAnalysis {
  if (isAutoReplyOrOoo(email)) {
    return { intent: 'OUT_OF_OFFICE', classification: 'OUT_OF_OFFICE', referredEmails: [] };
  }
  const stripped = stripQuotedReplyText(email.textBody);
  const combined = `${email.subject ?? ''}\n${stripped}`;
  const excluded = new Set(
    excludeEmails
      .map((addr) => addr?.trim().toLowerCase())
      .filter((addr): addr is string => Boolean(addr)),
  );
  const referred = new Set<string>();
  for (const match of stripped.matchAll(INLINE_EMAIL_RE)) {
    const addr = match[1]!.toLowerCase();
    if (!excluded.has(addr)) referred.add(addr);
  }
  const referredEmails = [...referred].slice(0, 5);
  if (
    REFERRAL_RE.test(stripped) &&
    (referredEmails.length > 0 ||
      /\b(?:procurement|purchasing|buyer|einkauf|acquisti|compras|achats)\b|(?:采购|负责)/iu.test(stripped))
  ) {
    return { intent: 'REFERRAL_NEW_CONTACT', classification: 'POSITIVE', referredEmails };
  }
  if (NEGATIVE_DECLINE_RE.test(stripped)) {
    return { intent: 'NEGATIVE_DECLINE', classification: 'NEGATIVE', referredEmails: [] };
  }
  if (OBJECTION_PRICE_OR_SUPPLIER_RE.test(stripped)) {
    return { intent: 'OBJECTION_PRICE_OR_SUPPLIER', classification: 'NEUTRAL', referredEmails };
  }
  if (DATASHEET_QUOTE_RE.test(combined)) {
    return { intent: 'ASK_DATASHEET_QUOTE', classification: 'POSITIVE', referredEmails };
  }
  if (TIMING_LATER_RE.test(stripped)) {
    return { intent: 'TIMING_LATER', classification: 'NEUTRAL', referredEmails };
  }
  if (POSITIVE_INTEREST_RE.test(stripped)) {
    return { intent: 'POSITIVE_INTEREST', classification: 'POSITIVE', referredEmails };
  }
  return { intent: 'NONE', classification: 'UNKNOWN', referredEmails };
}

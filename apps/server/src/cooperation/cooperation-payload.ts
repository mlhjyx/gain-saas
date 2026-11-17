import { cleanEmail, cleanText } from './cooperation-sanitizer.js';

/** 官网表单固定来源；客户端不能自报来源，避免伪造渠道口径。 */
export const COOPERATION_INTENT_SOURCE = 'website';

export interface CooperationIntentInput {
  name: string;
  email: string;
  company: string | null;
  contact: string | null;
  industry: string | null;
  region: string | null;
  message: string | null;
}

/**
 * 校验并清洗官网提交体。
 * 字段与官网表单一一对应（姓名/邮箱/公司/网站或联系方式/行业/覆盖区域/合作意向）。
 * 只强制姓名与邮箱，其余可选——官网下拉/自由文本缺失时不丢线索。
 */
export function parseCooperationIntentPayload(body: unknown): CooperationIntentInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('body must be an object');
  }
  const record = body as Record<string, unknown>;
  return {
    name: cleanText('name', record.name, { max: 100, required: true })!,
    email: cleanEmail(record.email),
    company: cleanText('company', record.company, { max: 200 }),
    contact: cleanText('contact', record.contact, { max: 300 }),
    industry: cleanText('industry', record.industry, { max: 100 }),
    region: cleanText('region', record.region, { max: 100 }),
    message: cleanText('message', record.message, { max: 500, multiline: true }),
  };
}

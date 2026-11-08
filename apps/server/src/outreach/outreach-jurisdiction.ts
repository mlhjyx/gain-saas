export type OutreachJurisdictionPolicy =
  | 'CONSENT_REQUIRED'
  | 'OPT_OUT'
  | 'REVIEW_REQUIRED';

export type OutreachConsentState = 'OPT_IN' | 'OPT_OUT' | 'UNKNOWN' | 'MISSING';

/**
 * 外联法域矩阵（第 5 章 §5.3.1.1，随 P4-01 扩展 FR）：
 * - DE/AT：UWG §7(2) Nr.2，B2B 邮件也必须事先明示同意（OPT_IN），无同意不发；
 * - US：CAN-SPAM opt-out 模型，可发，但页脚必须有真实物理邮政地址；
 * - FR：CNIL 对职业相关 B2B 允许合法利益（opt-out 模型），可发，但必须告知数据来源与反对方式；
 * - 其它法域：REVIEW_REQUIRED，默认不发，由运营逐国启用。
 */
export function outreachJurisdictionPolicy(
  countryCode: unknown,
): OutreachJurisdictionPolicy {
  const country = normalizeCountry(countryCode);
  if (country === 'DE' || country === 'AT') return 'CONSENT_REQUIRED';
  if (country === 'US' || country === 'FR') return 'OPT_OUT';
  return 'REVIEW_REQUIRED';
}

export function normalizeCountry(countryCode: unknown): string {
  return typeof countryCode === 'string' ? countryCode.trim().toUpperCase() : '';
}

export interface EmailJurisdictionConfig {
  /** CAN-SPAM 要求的物理邮政地址（OUTREACH_US_POSTAL_ADDRESS）。 */
  usPostalAddress?: string;
  /** CNIL 要求的来源告知（OUTREACH_FR_SOURCE_NOTICE）。 */
  frSourceNotice?: string;
}

export interface EmailJurisdictionDecision {
  allowed: boolean;
  policy: OutreachJurisdictionPolicy;
  /** 拒绝原因闭集码；allowed=true 时为空。 */
  code?: string;
  message?: string;
  /** 该法域要求随信发送的页脚行（身份/地址/来源告知），发送器负责拼装。 */
  footerLines: string[];
}

/**
 * 法域同意策略的唯一判定梯（发送门与只读 eligibility API 共用，防止两份合规逻辑漂移）：
 * OPT_OUT 永久压制 → REVIEW_REQUIRED 默认不发 → CONSENT_REQUIRED 必须 OPT_IN。
 * 页脚要求（US 地址 / FR 来源告知）不在此层，由发送门的 evaluateEmailJurisdiction 追加。
 */
export function evaluateConsentPolicy(input: {
  countryCode: unknown;
  consentStatus: OutreachConsentState;
}): {
  allowed: boolean;
  policy: OutreachJurisdictionPolicy;
  code?: string;
  message?: string;
} {
  const policy = outreachJurisdictionPolicy(input.countryCode);
  if (input.consentStatus === 'OPT_OUT') {
    return {
      allowed: false,
      policy,
      code: 'OUTREACH_OPTED_OUT',
      message: '该联系人已退订或回复，任何批次不得再发送',
    };
  }
  if (policy === 'REVIEW_REQUIRED') {
    return {
      allowed: false,
      policy,
      code: 'JURISDICTION_REVIEW_REQUIRED',
      message: '该法域默认不发送，需运营逐国启用（或缺少收件人国家）',
    };
  }
  if (policy === 'CONSENT_REQUIRED' && input.consentStatus !== 'OPT_IN') {
    return {
      allowed: false,
      policy,
      code: 'JURISDICTION_CONSENT_REQUIRED',
      message: '该法域要求事先显式同意（OPT_IN），当前无有效同意记录',
    };
  }
  return { allowed: true, policy };
}

/**
 * 发送路径上的法域同意门（逐封判定，纯函数，便于单测与审计复算）。
 * 输入：收件人国家 + 该联系人最新同意状态 + 法域页脚配置；输出：放行/拒绝 + 页脚行。
 * fail-closed：国家无法识别 → REVIEW_REQUIRED；US/FR 缺少必需页脚 → 拒绝（不裸发）。
 */
export function evaluateEmailJurisdiction(input: {
  countryCode: unknown;
  consentStatus: OutreachConsentState;
  usPostalAddress?: string;
  frSourceNotice?: string;
}): EmailJurisdictionDecision {
  const decision = evaluateConsentPolicy(input);
  if (!decision.allowed) {
    return { ...decision, footerLines: [] };
  }
  const country = normalizeCountry(input.countryCode);
  if (country === 'US') {
    const address = input.usPostalAddress?.trim();
    if (!address) {
      return {
        allowed: false,
        policy: decision.policy,
        code: 'JURISDICTION_US_POSTAL_ADDRESS_REQUIRED',
        message: '美国收件人需要 CAN-SPAM 物理邮政地址页脚（OUTREACH_US_POSTAL_ADDRESS 未配置）',
        footerLines: [],
      };
    }
    return { allowed: true, policy: decision.policy, footerLines: [address] };
  }
  if (country === 'FR') {
    const notice = input.frSourceNotice?.trim();
    if (!notice) {
      return {
        allowed: false,
        policy: decision.policy,
        code: 'JURISDICTION_FR_SOURCE_NOTICE_REQUIRED',
        message: '法国收件人需要数据来源告知页脚（OUTREACH_FR_SOURCE_NOTICE 未配置）',
        footerLines: [],
      };
    }
    return { allowed: true, policy: decision.policy, footerLines: [notice] };
  }
  return { allowed: true, policy: decision.policy, footerLines: [] };
}

export type OutreachJurisdictionPolicy =
  | 'CONSENT_REQUIRED'
  | 'OPT_OUT'
  | 'REVIEW_REQUIRED';

/**
 * 外联法域矩阵 v0（D-11-a，自包含实现）：
 * - DE/AT：UWG §7 红线，必须存在 explicit consent（OPT_IN）才可发送；
 * - US：CAN-SPAM opt-out 模型，可发送（身份/地址/退订必须齐备）；
 * - 其它法域：REVIEW_REQUIRED，默认不发，由运营逐国启用。
 */
export function outreachJurisdictionPolicy(
  countryCode: unknown,
): OutreachJurisdictionPolicy {
  const country =
    typeof countryCode === 'string' ? countryCode.trim().toUpperCase() : '';
  if (country === 'DE' || country === 'AT') return 'CONSENT_REQUIRED';
  if (country === 'US') return 'OPT_OUT';
  return 'REVIEW_REQUIRED';
}

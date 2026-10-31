/**
 * 引擎错误码 → 用户三层文案(PRD §14.4:「发生了什么 / 为什么 / 怎么办」)。
 *
 * BFF 把引擎错误映射到这里;「技术详情」(错误码/trace)由前端折叠展示。
 * 覆盖 PRD D6 的 409 阻断族与已知业务错误;未登记的码走 fallback,
 * 不允许把 fallback 文案当兜底语义长期使用——新码出现时补表。
 */

export interface ErrorCopy {
  /** 发生了什么(一句话) */
  readonly title: string;
  /** 为什么 */
  readonly why: string;
  /** 怎么办(用户可执行的行动) */
  readonly next: string;
}

export const ENGINE_ERROR_COPY = {
  SUPPRESSED: {
    title: '该对象在禁联名单中,不能继续操作',
    why: '退订、投诉或删除请求过的对象,任何对外动作前都会被拦下,这是合规红线。',
    next: '到「设置 → 禁联名单」查看记录;确有错误可提交复核。',
  },
  SUPPRESSED_CONTACT_UNREACHABLE: {
    title: '当前联系不上这家公司',
    why: '系统没有找到可用的公司级联系路径(官网联系页/表单等)。',
    next: '可先判断其他线索;该公司补充联系路径后会重新参与评分。',
  },
  CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED: {
    title: '发现决策人前需要先声明合法性依据',
    why: '具名联系人属于个人数据,引擎要求每次发现都带上明确的合法性基础(GDPR Art.6),并留下可审计的依据引用。',
    next: '在「发现联系人」弹窗里选择合法性依据、填写依据引用后重试;操作没有写入任何数据。',
  },
  NO_DOMAIN: {
    title: '这家公司没有可用于推断的域名',
    why: '邮箱猜测需要公司域名来学习邮箱格式;没有域名时引擎不会凭空猜测。',
    next: '先在公司档案里补齐官网域名,再回来猜邮箱。',
  },
  NO_PROVIDER: {
    title: '所需的数据源还没有启用',
    why: '引擎没有找到可用的数据源(联系人发现或邮箱验证),因此没有发起任何外部调用。',
    next: '联系运营启用对应的数据源后重试。',
  },
  STORAGE_RIGHTS_NOT_GRANTED: {
    title: '缺少该线索的数据使用授权',
    why: '交付这条线索需要保存对方公开信息,但当前工作空间的数据授权未覆盖。',
    next: '联系管理员在「数据与隐私」中确认授权范围。',
  },
  SANCTIONS_HOLD_UNRESOLVED: {
    title: '该线索命中制裁名单,待合规核验',
    why: '制裁名单命中必须由管理员人工核验后才能放行,系统不能自动跳过。',
    next: '管理员可到线索详情中完成合规复核。',
  },
  CONFLICT: {
    title: '操作冲突,请刷新后重试',
    why: '这条数据刚被其他操作修改过,当前操作基于的是旧状态。',
    next: '刷新页面查看最新状态后再次尝试。',
  },
  INVALID_STATE: {
    title: '当前状态不允许这个操作',
    why: '该线索/任务所处阶段与操作不匹配。',
    next: '刷新页面确认当前状态;若持续出现请联系运营。',
  },
  REASON_CODE_REQUIRED: {
    title: '请先选择原因',
    why: '「暂不跟进」必须留下原因,系统用它改进后续推荐质量。',
    next: '在弹出的原因选项中选择最接近的一项。',
  },
  INVALID_REASON_CODE: {
    title: '原因选项无效',
    why: '提交的原因不在可选范围。',
    next: '重新从列表中选择。',
  },
  VALIDATION_ERROR: {
    title: '填写内容有误',
    why: '部分字段不符合要求。',
    next: '按页面提示修正标红的字段后重试。',
  },
  NOT_FOUND: {
    title: '内容不存在或没有权限',
    why: '可能已被删除,或不属于当前工作空间。',
    next: '返回列表;若链接来自他人,请确认已加入对应工作空间。',
  },
  EXECUTION_BUDGET_GRANT_REQUIRED: {
    title: '这项操作需要执行预算授权',
    why: '建档、建 ICP、生成/执行寻源方案等写操作,引擎要求每次出示一次性、请求绑定的执行预算 Grant;当前工作空间还没有获得。',
    next: '你的操作没有写入任何数据。联系运营开通该工作空间的执行预算后重试。',
  },
  EXECUTION_BUDGET_GRANT_EXPIRED: {
    title: '执行预算授权已过期',
    why: 'Grant 只有约 5 分钟出示窗口,且只能使用一次。',
    next: '重新发起操作以获取新的授权。',
  },
  EXECUTION_BUDGET_AUTHORITY_EXHAUSTED: {
    title: '执行预算已用完',
    why: '该工作空间本期的执行额度已经耗尽。',
    next: '联系运营追加预算后再继续。',
  },
  EXECUTION_BUDGET_QUOTE_UNAVAILABLE: {
    title: '这项操作还没有可用的执行预算账户',
    why: '引擎还没有为这个操作配置执行预算报价,因此系统无法签发一次性授权;操作没有写入任何数据。',
    next: '请联系运营确认引擎版本与该能力的开放进度。',
  },
  EXECUTION_BUDGET_QUOTE_INVALID: {
    title: '这次操作的预算报价参数不合法',
    why: '提交的内容没有通过引擎的预算边界校验,操作没有写入任何数据。',
    next: '刷新页面后重试;反复出现请联系运营。',
  },
  EXECUTION_BUDGET_POLICY_DRIFT: {
    title: '执行预算策略正在变更',
    why: '引擎的预算策略与本次报价不一致,系统拒绝继续以避免超支。',
    next: '稍后重试;持续出现请联系运营。',
  },
  EXECUTION_BUDGET_GRANT_FAILED: {
    title: '执行预算授权暂时不可用',
    why: '系统没能从引擎取得这次操作的预算报价,或签发授权失败;操作没有写入任何数据。',
    next: '稍后重试;持续失败请联系运营检查引擎预算服务。',
  },
  EXECUTION_BUDGET_GRANT_INVALID: {
    title: '执行预算授权无效',
    why: '引擎没有接受这次操作的一次性授权(签名/字段/有效期不符合合同)。',
    next: '重新发起操作;若反复出现请联系运营。',
  },
  EXECUTION_BUDGET_AUTHORITY_REVOKED: {
    title: '执行预算授权已被平台撤销',
    why: '平台策略发生了变化,这期间的写操作会被引擎拒绝,操作没有写入任何数据。',
    next: '稍后重试;若持续出现请联系运营确认平台策略状态。',
  },
  EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH: {
    title: '执行预算授权与本次操作不匹配',
    why: '授权绑定的是另一份请求内容(例如页面内容在两次请求之间变了)。',
    next: '刷新页面后重新提交。',
  },
  EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE: {
    title: '执行预算校验暂时不可用',
    why: '引擎暂时无法读取预算授权方的公钥或校验服务不可用。',
    next: '稍后重试;持续失败请联系运营。',
  },
  WEEKLY_REPORT_TOO_LARGE: {
    title: '本周导出条数超出上限',
    why: '周报按周全量导出,单周条数有上限,系统拒绝截断以保数据完整。',
    next: '本周先处理部分线索后重试,或联系运营分批导出。',
  },
  MODEL_UPSTREAM_UNUSABLE: {
    title: '系统服务暂时不可用',
    why: '上游服务暂时故障,与你的操作无关。',
    next: '稍后重试;持续失败请联系运营。',
  },
  OUTREACH_DRAFT_LEAD_NOT_ACCEPTED: {
    title: '这条线索还不能生成开发信草稿',
    why: '草稿只对已接受的线索生成;当前线索还没被接受。',
    next: '先在「待判断」里接受这条线索,再回来生成草稿。',
  },
  OUTREACH_DRAFT_UNGROUNDED: {
    title: '这版草稿没有通过事实校验',
    why: '模型引用了未提供的公司事实,系统已丢弃这版草稿,没有存进线索。',
    next: '重新生成一版;若反复出现请联系运营检查模型输出。',
  },
  OUTREACH_DRAFT_VERSION_CONFLICT: {
    title: '草稿版本冲突',
    why: '同一线索的草稿刚被另一个请求更新过,本次版本号落空。',
    next: '刷新后重新生成。',
  },
  EXECUTION_BUDGET_GRANT_REUSED: {
    title: '这次授权已经使用过',
    why: 'Grant 一次性,同一次授权不能用于两次操作。',
    next: '重新发起操作以获取新的授权。',
  },
} as const satisfies Record<string, ErrorCopy>;

export type EngineErrorCode = keyof typeof ENGINE_ERROR_COPY;

export function copyForError(code: string): ErrorCopy {
  return (
    ENGINE_ERROR_COPY[code as EngineErrorCode] ?? {
      title: '操作没有成功',
      why: '系统返回了一个未登记的错误。',
      next: '请重试;若反复出现,请复制「技术详情」联系运营。',
    }
  );
}

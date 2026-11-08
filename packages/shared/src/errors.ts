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
  /** 英文三层文案：BFF 依 Accept-Language 选用（en-US 界面不再回落到中文）。 */
  readonly en?: { readonly next: string; readonly title: string; readonly why: string };
}

export const ENGINE_ERROR_COPY = {
  SUPPRESSED: {
    title: '该对象在禁联名单中,不能继续操作',
    why: '退订、投诉或删除请求过的对象,任何对外动作前都会被拦下,这是合规红线。',
    next: '到「设置 → 禁联名单」查看记录;确有错误可提交复核。',
    en: {
      title: "This contact is on the do-not-contact list",
      why: "Unsubscribes, complaints or erasure requests are blocked before any outbound action — a hard compliance rule.",
      next: "Review the record under Settings → Do-not-contact list; submit a review request if it was added in error.",
    },
  },
  SUPPRESSED_CONTACT_UNREACHABLE: {
    title: '当前联系不上这家公司',
    why: '系统没有找到可用的公司级联系路径(官网联系页/表单等)。',
    next: '可先判断其他线索;该公司补充联系路径后会重新参与评分。',
    en: {
      title: "We cannot reach this company right now",
      why: "No usable company-level contact path (contact page or form) was found.",
      next: "Judge other leads first; this company re-enters scoring once a contact path is found.",
    },
  },
  CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED: {
    title: '发现决策人前需要先声明合法性依据',
    why: '具名联系人属于个人数据,引擎要求每次发现都带上明确的合法性基础(GDPR Art.6),并留下可审计的依据引用。',
    next: '在「发现联系人」弹窗里选择合法性依据、填写依据引用后重试;操作没有写入任何数据。',
    en: {
      title: "Declare a lawful basis before discovering decision makers",
      why: "Named contacts are personal data; each discovery needs an explicit lawful basis (GDPR Art.6) with an auditable reference.",
      next: "Pick a lawful basis and reference in the discovery dialog, then retry; nothing was written.",
    },
  },
  NO_DOMAIN: {
    title: '这家公司没有可用于推断的域名',
    why: '邮箱猜测需要公司域名来学习邮箱格式;没有域名时引擎不会凭空猜测。',
    next: '先在公司档案里补齐官网域名,再回来猜邮箱。',
    en: {
      title: "This company has no domain to infer from",
      why: "E-mail guessing needs a company domain to learn the address pattern; the engine never invents one.",
      next: "Add the website domain in the company profile first, then guess addresses here.",
    },
  },
  NO_PROVIDER: {
    title: '所需的数据源还没有启用',
    why: '引擎没有找到可用的数据源(联系人发现或邮箱验证),因此没有发起任何外部调用。',
    next: '联系运营启用对应的数据源后重试。',
    en: {
      title: "The required data source is not enabled",
      why: "No data source was available (contact discovery or e-mail verification), so no external call was made.",
      next: "Ask operations to enable the matching data source, then retry.",
    },
  },
  STORAGE_RIGHTS_NOT_GRANTED: {
    title: '缺少该线索的数据使用授权',
    why: '交付这条线索需要保存对方公开信息,但当前工作空间的数据授权未覆盖。',
    next: '联系管理员在「数据与隐私」中确认授权范围。',
    en: {
      title: "This lead lacks a data-use authorization",
      why: "Delivering this lead requires storing public information, which the current workspace authorization does not cover.",
      next: "Ask an admin to confirm the authorization scope under Settings → Data & privacy.",
    },
  },
  SANCTIONS_HOLD_UNRESOLVED: {
    title: '该线索命中制裁名单,待合规核验',
    why: '制裁名单命中必须由管理员人工核验后才能放行,系统不能自动跳过。',
    next: '管理员可到线索详情中完成合规复核。',
    en: {
      title: "This lead hit the sanctions list and awaits compliance review",
      why: "Sanctions hits must be cleared by a human admin; the system cannot skip them.",
      next: "An admin can complete the compliance review in the lead details.",
    },
  },
  CONFLICT: {
    title: '操作冲突,请刷新后重试',
    why: '这条数据刚被其他操作修改过,当前操作基于的是旧状态。',
    next: '刷新页面查看最新状态后再次尝试。',
    en: {
      title: "The operation conflicted — refresh and retry",
      why: "Another action just changed this record, so this operation was based on a stale state.",
      next: "Refresh to see the latest state, then try again.",
    },
  },
  INVALID_STATE: {
    title: '当前状态不允许这个操作',
    why: '该线索/任务所处阶段与操作不匹配。',
    next: '刷新页面确认当前状态;若持续出现请联系运营。',
    en: {
      title: "The current state does not allow this action",
      why: "The lead or task is in a stage that does not match this operation.",
      next: "Refresh to confirm the current state; contact operations if it persists.",
    },
  },
  REASON_CODE_REQUIRED: {
    title: '请先选择原因',
    why: '「暂不跟进」必须留下原因,系统用它改进后续推荐质量。',
    next: '在弹出的原因选项中选择最接近的一项。',
    en: {
      title: "Choose a reason first",
      why: "'Not following up' requires a reason; the system uses it to improve future recommendations.",
      next: "Pick the closest option in the reason dialog.",
    },
  },
  INVALID_REASON_CODE: {
    title: '原因选项无效',
    why: '提交的原因不在可选范围。',
    next: '重新从列表中选择。',
    en: {
      title: "The reason option is invalid",
      why: "The submitted reason is outside the allowed options.",
      next: "Choose again from the list.",
    },
  },
  VALIDATION_ERROR: {
    title: '填写内容有误',
    why: '部分字段不符合要求。',
    next: '按页面提示修正标红的字段后重试。',
    en: {
      title: "Some fields need fixing",
      why: "One or more fields do not meet the requirements.",
      next: "Correct the highlighted fields as prompted and retry.",
    },
  },
  NOT_FOUND: {
    title: '内容不存在或没有权限',
    why: '可能已被删除,或不属于当前工作空间。',
    next: '返回列表;若链接来自他人,请确认已加入对应工作空间。',
    en: {
      title: "Not found, or you lack access",
      why: "It may have been deleted, or it belongs to another workspace.",
      next: "Go back to the list; if the link came from someone else, confirm you joined the right workspace.",
    },
  },
  EXECUTION_BUDGET_GRANT_REQUIRED: {
    title: '这项操作需要执行预算授权',
    why: '建档、建 ICP、生成/执行寻源方案等写操作,引擎要求每次出示一次性、请求绑定的执行预算 Grant;当前工作空间还没有获得。',
    next: '你的操作没有写入任何数据。联系运营开通该工作空间的执行预算后重试。',
    en: {
      title: "This action needs an execution-budget grant",
      why: "Write actions (profiles, target profiles, plans) require a one-time, request-bound execution-budget grant; this workspace does not have one yet.",
      next: "Nothing was written. Ask operations to enable an execution budget for this workspace, then retry.",
    },
  },
  EXECUTION_BUDGET_GRANT_EXPIRED: {
    title: '执行预算授权已过期',
    why: 'Grant 只有约 5 分钟出示窗口,且只能使用一次。',
    next: '重新发起操作以获取新的授权。',
    en: {
      title: "The execution-budget grant expired",
      why: "A grant is valid for about five minutes and can be used only once.",
      next: "Start the action again to obtain a fresh grant.",
    },
  },
  EXECUTION_BUDGET_AUTHORITY_EXHAUSTED: {
    title: '执行预算已用完',
    why: '该工作空间本期的执行额度已经耗尽。',
    next: '联系运营追加预算后再继续。',
    en: {
      title: "The execution budget is used up",
      why: "This workspace has consumed its execution quota for the current period.",
      next: "Ask operations to top up the budget, then continue.",
    },
  },
  EXECUTION_BUDGET_QUOTE_UNAVAILABLE: {
    title: '这项操作还没有可用的执行预算账户',
    why: '引擎还没有为这个操作配置执行预算报价,因此系统无法签发一次性授权;操作没有写入任何数据。',
    next: '请联系运营确认引擎版本与该能力的开放进度。',
    en: {
      title: "No execution-budget account is available for this action yet",
      why: "The engine has no budget quote configured for this operation, so no one-time grant can be issued; nothing was written.",
      next: "Ask operations to confirm the engine version and the rollout progress of this capability.",
    },
  },
  EXECUTION_BUDGET_QUOTE_INVALID: {
    title: '这次操作的预算报价参数不合法',
    why: '提交的内容没有通过引擎的预算边界校验,操作没有写入任何数据。',
    next: '刷新页面后重试;反复出现请联系运营。',
    en: {
      title: "The budget quote for this action is invalid",
      why: "The submitted content failed the engine's budget boundary checks; nothing was written.",
      next: "Refresh and retry; contact operations if it persists.",
    },
  },
  EXECUTION_BUDGET_POLICY_DRIFT: {
    title: '执行预算策略正在变更',
    why: '引擎的预算策略与本次报价不一致,系统拒绝继续以避免超支。',
    next: '稍后重试;持续出现请联系运营。',
    en: {
      title: "The execution-budget policy is changing",
      why: "The engine's budget policy no longer matches this quote; the system stopped to prevent overspending.",
      next: "Retry shortly; contact operations if it persists.",
    },
  },
  EXECUTION_BUDGET_GRANT_FAILED: {
    title: '执行预算授权暂时不可用',
    why: '系统没能从引擎取得这次操作的预算报价,或签发授权失败;操作没有写入任何数据。',
    next: '稍后重试;持续失败请联系运营检查引擎预算服务。',
    en: {
      title: "The execution-budget authorization is temporarily unavailable",
      why: "The system could not obtain a budget quote or sign a grant for this action; nothing was written.",
      next: "Retry shortly; if it keeps failing, ask operations to check the budget service.",
    },
  },
  EXECUTION_BUDGET_GRANT_INVALID: {
    title: '执行预算授权无效',
    why: '引擎没有接受这次操作的一次性授权(签名/字段/有效期不符合合同)。',
    next: '重新发起操作;若反复出现请联系运营。',
    en: {
      title: "The execution-budget grant is invalid",
      why: "The engine rejected the one-time grant (signature, fields or validity do not match the contract).",
      next: "Start the action again; contact operations if it keeps happening.",
    },
  },
  EXECUTION_BUDGET_AUTHORITY_REVOKED: {
    title: '执行预算授权已被平台撤销',
    why: '平台策略发生了变化,这期间的写操作会被引擎拒绝,操作没有写入任何数据。',
    next: '稍后重试;若持续出现请联系运营确认平台策略状态。',
    en: {
      title: "The execution-budget authorization was revoked by the platform",
      why: "The platform policy changed; the engine rejects write actions during this window and nothing was written.",
      next: "Retry shortly; if it persists, ask operations to check the platform policy state.",
    },
  },
  EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH: {
    title: '执行预算授权与本次操作不匹配',
    why: '授权绑定的是另一份请求内容(例如页面内容在两次请求之间变了)。',
    next: '刷新页面后重新提交。',
    en: {
      title: "The grant does not match this action",
      why: "The grant is bound to a different request payload (for example the page content changed between requests).",
      next: "Refresh the page and submit again.",
    },
  },
  EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE: {
    title: '执行预算校验暂时不可用',
    why: '引擎暂时无法读取预算授权方的公钥或校验服务不可用。',
    next: '稍后重试;持续失败请联系运营。',
    en: {
      title: "Budget verification is temporarily unavailable",
      why: "The engine cannot currently read the budget authority's public keys or the verification service is down.",
      next: "Retry shortly; if it keeps failing, contact operations.",
    },
  },
  WEEKLY_REPORT_TOO_LARGE: {
    title: '本周导出条数超出上限',
    why: '周报按周全量导出,单周条数有上限,系统拒绝截断以保数据完整。',
    next: '本周先处理部分线索后重试,或联系运营分批导出。',
    en: {
      title: "This week's export exceeds the row limit",
      why: "Weekly reports export whole weeks and have a per-week cap; the system refuses to truncate so data stays complete.",
      next: "Process some leads first and retry, or ask operations for a split export.",
    },
  },
  MODEL_UPSTREAM_UNUSABLE: {
    title: '系统服务暂时不可用',
    why: '上游服务暂时故障,与你的操作无关。',
    next: '稍后重试;持续失败请联系运营。',
    en: {
      title: "A system service is temporarily unavailable",
      why: "An upstream service is failing; this is unrelated to your input.",
      next: "Retry later; contact operations if it persists.",
    },
  },
  OUTREACH_DRAFT_LEAD_NOT_ACCEPTED: {
    title: '这条线索还不能生成开发信草稿',
    why: '草稿只对已接受的线索生成;当前线索还没被接受。',
    next: '先在「待判断」里接受这条线索,再回来生成草稿。',
    en: {
      title: "A first-contact draft needs an accepted lead",
      why: "Drafts are generated only for accepted leads; this lead has not been accepted yet.",
      next: "Accept the lead in 'To review' first, then come back to draft.",
    },
  },
  OUTREACH_DRAFT_UNGROUNDED: {
    title: '这版草稿没有通过事实校验',
    why: '模型引用了未提供的公司事实,系统已丢弃这版草稿,没有存进线索。',
    next: '重新生成一版;若反复出现请联系运营检查模型输出。',
    en: {
      title: "This draft failed fact grounding",
      why: "The model referenced company facts that were not provided; the draft was discarded and not saved to the lead.",
      next: "Regenerate a draft; if it keeps happening, contact operations to check model output.",
    },
  },
  OUTREACH_DRAFT_VERSION_CONFLICT: {
    title: '草稿版本冲突',
    why: '同一线索的草稿刚被另一个请求更新过,本次版本号落空。',
    next: '刷新后重新生成。',
    en: {
      title: "Draft version conflict",
      why: "The draft for this lead was just updated by another request; this version number is stale.",
      next: "Refresh and regenerate.",
    },
  },
  EXECUTION_BUDGET_GRANT_REUSED: {
    title: '这次授权已经使用过',
    why: 'Grant 一次性,同一次授权不能用于两次操作。',
    next: '重新发起操作以获取新的授权。',
    en: {
      title: "This grant has already been used",
      why: "Grants are single-use; one authorization cannot cover two actions.",
      next: "Start the action again to obtain a fresh grant.",
    },
  },
  WORKSPACE_BUDGET_EXCEEDED: {
    title: '本月运行额度已用完',
    why: '当前工作空间在额度周期内的运行次数或预算已达到上限,这次操作没有执行、也没有产生费用。',
    next: '联系运营提升额度,或等下个周期再试。',
    en: {
      title: "This month's usage quota is used up",
      why: "The workspace reached its run-count or budget cap for the current period; this action did not execute and incurred no cost.",
      next: "Ask operations to raise the quota, or retry next period.",
    },
  },
  // ── P5 补表：租户/引导/档案高频码（设计 2026-11-08-p5-user-loop §5.4）──────────
  NO_APPROVED_CLAIMS: {
    title: '还没有已确认的企业事实，暂时无法生成买家画像',
    why: '买家画像只能建立在你确认过的企业事实上，系统不会凭空生成。',
    next: '到「公司档案 → 企业事实」确认至少一条；没有待确认事实时，先用「从档案生成事实草稿」补齐。',
    en: {
      title: "No confirmed company facts yet, so a target customer profile cannot be generated",
      why: "Profiles can only build on facts you confirmed; the system never invents them.",
      next: "Confirm at least one fact under Company profile → Facts; if none are pending, use 'Generate fact drafts from profile' first.",
    },
  },
  AUTH_REQUIRED: {
    title: '登录已过期',
    why: '你的登录状态已失效——这是为了保护账号安全，不是操作出错。',
    next: '重新登录即可继续；未保存的草稿会保留。',
    en: {
      title: "Your session has expired",
      why: "Your sign-in state is no longer valid — this protects your account and is not an error of your operation.",
      next: "Sign in again to continue; unsaved drafts are kept.",
    },
  },
  SESSION_EXPIRED: {
    title: '登录已过期',
    why: '你的登录状态已失效——这是为了保护账号安全，不是操作出错。',
    next: '重新登录即可继续；未保存的草稿会保留。',
    en: {
      title: "Your session has expired",
      why: "Your sign-in state is no longer valid — this protects your account and is not an error of your operation.",
      next: "Sign in again to continue; unsaved drafts are kept.",
    },
  },
  WORKSPACE_DISABLED: {
    title: '当前工作空间已停用',
    why: '空间被停用或归档后，所有读写都会暂停（数据仍保留）。',
    next: '联系运营确认原因并恢复；恢复后刷新页面继续。',
    en: {
      title: "This workspace is disabled",
      why: "A disabled or archived workspace pauses all reads and writes (data is kept).",
      next: "Ask operations for the reason and to restore it; refresh once restored.",
    },
  },
  ONBOARDING_INCOMPLETE: {
    title: '先完成建档向导',
    why: '公司信息与主营产品是后续能力的基础，完成向导前业务功能暂不开放。',
    next: '按页面引导完成建档（公司、产品、目标市场）。',
    en: {
      title: "Finish the setup wizard first",
      why: "Company information and products are the base for everything else; business features stay closed until the wizard is complete.",
      next: "Complete the guided setup (company, products, target markets).",
    },
  },
  RATE_LIMITED: {
    title: '操作太频繁，请稍后再试',
    why: '登录与敏感操作有频率限制，用于保护账号安全。',
    next: '等待几分钟后重试；反复出现请联系运营。',
    en: {
      title: "Too many attempts — try again shortly",
      why: "Sign-in and sensitive actions are rate limited to protect the account.",
      next: "Wait a few minutes and retry; contact operations if it keeps happening.",
    },
  },
  EMAIL_TAKEN: {
    title: '该邮箱已注册',
    why: '同一邮箱只能注册一个账号。',
    next: '直接登录；忘记密码请走重置流程。',
    en: {
      title: "This e-mail is already registered",
      why: "One e-mail can only hold one account.",
      next: "Sign in instead; use the reset flow if you forgot the password.",
    },
  },
  ALREADY_MEMBER: {
    title: '该用户已是工作空间成员',
    why: '邀请的对象已经在成员列表里。',
    next: '到「设置 → 成员」查看现有成员，无需重复邀请。',
    en: {
      title: "This user is already a workspace member",
      why: "The invitee is already on the member list.",
      next: "Check existing members under Settings → Members; no new invite is needed.",
    },
  },
  FORBIDDEN: {
    title: '当前账号没有执行这一步的权限',
    why: '该操作只对工作空间管理员开放。',
    next: '请管理员完成该操作，或请管理员调整你的角色。',
    en: {
      title: "Your account lacks permission for this step",
      why: "This action is limited to workspace admins.",
      next: "Ask an admin to perform it, or to adjust your role.",
    },
  },
  NOT_A_MEMBER: {
    title: '你已不在该工作空间',
    why: '成员资格被移除后，原会话立即失效。',
    next: '重新登录；若应保留权限，请联系工作空间管理员重新邀请。',
    en: {
      title: "You are no longer in this workspace",
      why: "Membership removal invalidates the existing session immediately.",
      next: "Sign in again; if you should keep access, ask the workspace admin to re-invite you.",
    },
  },
  LAST_ADMIN: {
    title: '至少保留一名管理员',
    why: '移除或降级最后一名管理员会让工作空间无人可管理。',
    next: '先把另一位成员设为管理员，再执行本次操作。',
    en: {
      title: "Keep at least one admin",
      why: "Removing or demoting the last admin leaves the workspace unmanageable.",
      next: "Make another member an admin first, then repeat this action.",
    },
  },
  LAST_MEMBER: {
    title: '你是最后一名成员，不能退出',
    why: '工作空间至少要有一名成员。',
    next: '邀请成员加入后再退出，或直接停用该空间。',
    en: {
      title: "You are the last member and cannot leave",
      why: "A workspace must have at least one member.",
      next: "Invite a member before leaving, or disable the workspace instead.",
    },
  },
  VERSION_CONFLICT: {
    title: '这条内容刚被更新过',
    why: '你看到的是旧版本，系统拒绝用旧内容覆盖新内容。',
    next: '刷新页面查看最新内容后重新操作。',
    en: {
      title: "This content was just updated",
      why: "You are looking at an older version; the system refuses to overwrite newer content with it.",
      next: "Refresh to see the latest content, then redo the action.",
    },
  },
  UNDERSTANDING_WEBSITE_REQUIRED: {
    title: '先补充公司官网',
    why: '企业理解需要从官网抓取内容，没有官网时不会启动。',
    next: '在「公司档案」补齐官网后重试；也可以先用「从档案生成事实草稿」继续。',
    en: {
      title: "Add the company website first",
      why: "Company understanding reads the website; it does not start without one.",
      next: "Add the website under Company profile and retry; you can also continue with 'Generate fact drafts from profile'.",
    },
  },
  UNDERSTANDING_ALREADY_PENDING: {
    title: '企业理解已在进行中',
    why: '同一家公司的理解任务已在排队或执行。',
    next: '稍后刷新公司档案查看进度。',
    en: {
      title: "Company understanding is already in progress",
      why: "The understanding task for this company is queued or executing.",
      next: "Refresh the company profile shortly to check progress.",
    },
  },
  UNDERSTANDING_RETRY_NOT_ALLOWED: {
    title: '当前状态不能重新理解',
    why: '只有草稿状态的档案可以启动或重试理解。',
    next: '刷新页面确认档案状态；已完成理解则无需重试。',
    en: {
      title: "The current state cannot be re-understood",
      why: "Only draft profiles can start or retry understanding.",
      next: "Refresh to confirm the profile state; a finished profile needs no retry.",
    },
  },
  COMPANY_NOT_DELETABLE: {
    title: '只有草稿档案可以删除',
    why: '已进入理解或已可用的档案被下游引用，不能直接删除。',
    next: '如需停用请联系运营处理。',
    en: {
      title: "Only draft profiles can be deleted",
      why: "A profile that entered understanding or is already usable is referenced downstream and cannot be deleted directly.",
      next: "Contact operations if you need it disabled.",
    },
  },
  INVALID_URL: {
    title: '这个网址不可用',
    why: '只接受可公开访问的 http/https 地址；内网地址或无法解析的域名会被拒绝。',
    next: '填写公司官网首页地址（例如 https://example.com）后重试。',
    en: {
      title: "This URL is not usable",
      why: "Only publicly reachable http/https addresses are accepted; intranet hosts or unresolvable domains are rejected.",
      next: "Enter the company's homepage (for example https://example.com) and retry.",
    },
  },
  INVITE_INVALID: {
    title: '邀请链接无效或已过期',
    why: '邀请已被使用、撤销或超过有效期。',
    next: '请管理员重新发送邀请。',
    en: {
      title: "The invite link is invalid or expired",
      why: "The invite was used, revoked, or has expired.",
      next: "Ask an admin to send a new invite.",
    },
  },
  SANCTIONS_CONFIRMED_IMMUTABLE: {
    title: '已确认的制裁命中不可直接解除',
    why: '真命中结论只能经更高层级的人工合规流程变更。',
    next: '联系运营走合规升级流程。',
    en: {
      title: "Confirmed sanctions hits cannot be cleared directly",
      why: "A true-hit conclusion can only be changed through the higher-level human compliance process.",
      next: "Contact operations to start the compliance escalation.",
    },
  },
  INTERNAL: {
    title: '系统出了点问题，操作没有完成',
    why: '服务端遇到未预期的错误，与你的输入无关。',
    next: '请重试；若反复出现，请复制「技术详情」联系运营。',
    en: {
      title: "Something went wrong and the action did not complete",
      why: "The server hit an unexpected error unrelated to your input.",
      next: "Retry; if it keeps happening, copy the technical details and contact operations.",
    },
  },
  // ── M2 步 10：商机域（QGO/SAO/Outcome）────────────────────────────────────
  QGO_EVIDENCE_REQUIRED: {
    title: '提升为商机需要需求或时机证据',
    why: '商机必须有至少一条支撑证据（客户回复、采购页、招标命中、海关信号等）和明确的下一步，避免把「只是匹配」当成商机。',
    next: '在提升表单里补充证据链接或说明，并填写下一步动作后重试。',
    en: {
      title: "Promoting to an opportunity needs demand or timing evidence",
      why: "An opportunity requires at least one supporting evidence item (customer reply, procurement page, tender hit, customs signal…) and a clear next step, so a mere match is not treated as an opportunity.",
      next: "Add an evidence link or note and a next step in the promotion form, then retry.",
    },
  },
  LEAD_NOT_QUALIFIED: {
    title: '只有已接受的线索才能提升为商机',
    why: '机器候选还不是线索——先在「买家线索」里接受它，系统才会留下可追溯的接受记录（LeadQualified）。',
    next: '到「买家线索」接受这条线索，再回来提升为商机。',
    en: {
      title: "Only accepted leads can become opportunities",
      why: "Machine candidates are not leads yet — accept the lead under 'Buyer leads' first so the acceptance is recorded (LeadQualified).",
      next: "Accept this lead under 'Buyer leads', then promote it again.",
    },
  },
  INVALID_OUTCOME: {
    title: '结果类型不在允许范围',
    why: '商机结果只接受固定选项：已回复 / 已约会议 / 已报价 / 赢单 / 丢单 / 无响应 / 不合格。',
    next: '从下拉列表选择一项结果后重试。',
    en: {
      title: "This outcome type is not allowed",
      why: "Outcomes accept a fixed set: replied / meeting booked / quote sent / won / lost / no response / disqualified.",
      next: "Pick one from the list and retry.",
    },
  },
  // ── 第 5 章 P4：触达发送门（法域同意 / 执行授权 / 控制面）─────────────────
  JURISDICTION_CONSENT_REQUIRED: {
    title: '该收件人所在国家要求事先同意',
    why: '德国/奥地利法律要求对电子邮件广告取得事先明示同意，这位收件人目前没有同意记录。',
    next: '补充同意记录（表单/展会 opt-in）后再发送，或从本批次移除该联系人。',
    en: {
      title: "This recipient's country requires prior consent",
      why: "German/Austrian law requires explicit prior consent for e-mail advertising; this recipient has no consent on file.",
      next: "Record consent (form or fair opt-in) before sending, or remove this contact from the batch.",
    },
  },
  JURISDICTION_REVIEW_REQUIRED: {
    title: '该收件人国家暂未开放发送',
    why: '系统的法域策略默认只覆盖 US/FR/DE/AT；该国别（或草稿缺少收件人国家）需要运营先启用。',
    next: '在草稿里补齐收件人国家，或联系运营为该国家启用发送策略。',
    en: {
      title: "Outreach to this country is not enabled yet",
      why: "The jurisdiction policy covers US/FR/DE/AT by default; this country (or a missing recipient country) needs operator enablement first.",
      next: "Add the recipient country to the draft, or ask operations to enable this country.",
    },
  },
  JURISDICTION_US_POSTAL_ADDRESS_REQUIRED: {
    title: '缺少美国法定的物理地址页脚',
    why: 'CAN-SPAM 要求营销邮件包含真实物理邮政地址；系统尚未配置该地址，因此不会发出这封邮件。',
    next: '联系运营配置发件物理地址（OUTREACH_US_POSTAL_ADDRESS）后重试。',
    en: {
      title: "The U.S. physical postal address footer is missing",
      why: "CAN-SPAM requires a real physical postal address in marketing e-mail; none is configured, so this message is not sent.",
      next: "Ask operations to configure the sender postal address (OUTREACH_US_POSTAL_ADDRESS), then retry.",
    },
  },
  JURISDICTION_FR_SOURCE_NOTICE_REQUIRED: {
    title: '缺少法国要求的来源告知页脚',
    why: 'CNIL 要求面向职业邮箱的推广告知数据来源与反对方式；系统尚未配置来源说明，因此不会发出这封邮件。',
    next: '联系运营配置来源告知（OUTREACH_FR_SOURCE_NOTICE）后重试。',
    en: {
      title: "The French data-source notice footer is missing",
      why: "CNIL requires telling business recipients where their data came from and how to object; no notice is configured, so this message is not sent.",
      next: "Ask operations to configure the source notice (OUTREACH_FR_SOURCE_NOTICE), then retry.",
    },
  },
  OUTREACH_WINDOW_CLOSED: {
    title: '当前不在收件人的接收时段',
    why: '发送窗口按收件人当地时区（工作日 09:00–17:00）判定，现在发出去容易被忽视或投诉。',
    next: '无需操作：该封已顺延，草稿保留在批次里，窗口开启后再次发送即可。',
    en: {
      title: "Outside the recipient's receiving window",
      why: "The send window follows the recipient's local time (weekdays 09:00–17:00); sending now risks missed or complained mail.",
      next: "No action needed: this message is deferred and the draft stays in the batch for a later window.",
    },
  },
  OUTREACH_MAILBOX_DAILY_CAP: {
    title: '发件信箱今日额度已用完',
    why: '每个发件信箱每天有发送上限，用于保护域名声誉与送达率。',
    next: '无需操作：该封已顺延，草稿保留在批次里，明天或换信箱后再次发送即可。',
    en: {
      title: "Today's mailbox sending quota is used up",
      why: "Each sending mailbox has a daily cap that protects domain reputation and deliverability.",
      next: "No action needed: this message is deferred and the draft stays in the batch for tomorrow.",
    },
  },
  OUTREACH_MAILBOX_WEEKLY_CAP: {
    title: '发件信箱本周额度已用完',
    why: '每个发件信箱每周有发送上限，用于保护域名声誉与送达率。',
    next: '无需操作：该封已顺延，草稿保留在批次里，下周再次发送即可。',
    en: {
      title: "This week's mailbox sending quota is used up",
      why: "Each sending mailbox has a weekly cap that protects domain reputation and deliverability.",
      next: "No action needed: this message is deferred and the draft stays in the batch for next week.",
    },
  },
  OUTREACH_DOMAIN_RATE_LIMITED: {
    title: '同一家公司的收件过多',
    why: '同一收件域每小时最多发送 5 封，避免同一公司同时收到多封造成骚扰与投诉。',
    next: '无需操作：该封已顺延到下一小时，草稿保留在批次里。',
    en: {
      title: "Too many messages to the same company domain",
      why: "At most 5 messages per recipient domain per hour, to avoid flooding one company.",
      next: "No action needed: this message is deferred to the next hour and the draft stays in the batch.",
    },
  },
  OUTREACH_MAILBOX_PAUSED: {
    title: '发送已暂停：退信率超过熔断线',
    why: '滚动 7 天的硬退信率达到 5% 熔断线，继续发送会损害域名声誉，整批已停止。',
    next: '联系运营复核名单质量（剔除 catch-all/猜测地址），清除原因后再恢复发送。',
    en: {
      title: "Sending paused: bounce rate above the circuit-breaker line",
      why: "The rolling 7-day hard-bounce rate reached the 5% breaker; continuing would damage domain reputation, so the batch was stopped.",
      next: "Ask operations to review list quality (drop catch-all/guessed addresses), then resume once the cause is cleared.",
    },
  },
  OUTREACH_DOMAIN_PAUSED: {
    title: '发送已暂停：投诉率超过红线',
    why: '滚动 7 天的投诉率达到 0.3% 红线（Gmail 硬线），继续发送可能导致域名被封。',
    next: '联系运营复核模板与名单；根因清除并人工确认后才可恢复。',
    en: {
      title: "Sending paused: complaint rate above the hard line",
      why: "The rolling 7-day complaint rate reached the 0.3% hard line (Gmail's threshold); continuing risks domain blocking.",
      next: "Ask operations to review templates and lists; resume only after the root cause is cleared and confirmed.",
    },
  },
  OUTREACH_AUTHORIZATION_SCOPE_MISMATCH: {
    title: '执行授权与当前批次不一致',
    why: '授权绑定的是某一次批准冻结的批次内容与收件人范围；当前批次内容或范围与授权不符，系统拒绝发送。',
    next: '重新提交该批次审批，取得与当前内容一致的新授权后再发送。',
    en: {
      title: "The execution authorization does not match this batch",
      why: "An authorization is bound to the approved, frozen content and recipient set; this batch no longer matches it, so sending is refused.",
      next: "Re-submit this batch for approval to obtain a matching authorization, then send.",
    },
  },
  OUTREACH_SCHEDULE_OUT_OF_WINDOW: {
    title: '当前不在授权计划的发送时段',
    why: '执行授权带有计划发送区间（notBefore–notAfter），现在不在该区间内。',
    next: '到授权计划时间再发送；若计划有误，重新提交审批调整窗口。',
    en: {
      title: "Outside the authorized send schedule",
      why: "The execution authorization carries a planned window (notBefore–notAfter); the current time is outside it.",
      next: "Send within the planned window, or re-submit for approval to adjust it.",
    },
  },
  OUTREACH_BUDGET_EXCEEDED: {
    title: '本批预估成本超出授权预算',
    why: '执行授权带有本批发送成本上限；按整批估算已超过该上限，系统拒绝发送。',
    next: '缩小批次规模，或重新提交审批申请更高的预算上限。',
    en: {
      title: "Estimated cost exceeds the authorized budget",
      why: "The execution authorization caps this batch's sending cost; the whole-batch estimate exceeds it, so sending is refused.",
      next: "Shrink the batch, or re-submit for approval with a higher budget cap.",
    },
  },
  CAMPAIGN_AUTHORIZATION_USES_EXHAUSTED: {
    title: '执行授权次数已用完',
    why: '执行授权按收件人数逐封消费，剩余次数不足以覆盖本次待发邮件。',
    next: '重新提交审批以取得新的授权后再发送。',
    en: {
      title: "The execution authorization is used up",
      why: "Each authorization is consumed once per recipient; the remaining uses cannot cover this send.",
      next: "Re-submit for approval to obtain a fresh authorization, then send.",
    },
  },
  CAMPAIGN_AUTHORIZATION_INVALID: {
    title: '批次没有有效的执行授权',
    why: '发送必须持有与批次绑定的执行授权；当前批次缺少授权或授权不可用。',
    next: '重新提交该批次审批，待授权签发并绑定后再发送。',
    en: {
      title: "This batch has no valid execution authorization",
      why: "Sending requires an execution authorization bound to the batch; it is missing or unusable.",
      next: "Re-submit the batch for approval and send once a new authorization is issued and bound.",
    },
  },
  CAMPAIGN_AUTHORIZATION_REVOKED: {
    title: '执行授权已被撤销',
    why: '授权会在同意撤销、批次取消或工作空间停用时联动失效。',
    next: '确认原因并重新提交审批，取得新授权后再发送。',
    en: {
      title: "The execution authorization was revoked",
      why: "Authorizations are revoked automatically when consent is withdrawn, the batch is cancelled, or the workspace is disabled.",
      next: "Confirm the cause and re-submit for approval to obtain a fresh authorization.",
    },
  },
  CAMPAIGN_AUTHORIZATION_EXPIRED: {
    title: '执行授权已过期',
    why: '执行授权有有效期；过期后不能再用于发送。',
    next: '重新提交审批，取得新授权后再发送。',
    en: {
      title: "The execution authorization expired",
      why: "Execution authorizations are time-limited and cannot be used after expiry.",
      next: "Re-submit for approval to obtain a fresh authorization, then send.",
    },
  },
  OUTREACH_BATCH_SIZE_EXCEEDED: {
    title: '单批收件人超过上限',
    why: '单个批次最多 50 位收件人，这是发送质量与可审计性约束（扩量靠加信箱与加域）。',
    next: '拆分为多个批次后重新提交审批。',
    en: {
      title: "Too many recipients in one batch",
      why: "A batch is capped at 50 recipients to protect quality and auditability; scale comes from more mailboxes and domains.",
      next: "Split into several batches and re-submit for approval.",
    },
  },
  OUTREACH_MAILBOX_NOT_FOUND: {
    title: '发件信箱不存在',
    why: '该信箱可能已被删除，或不属于当前工作空间。',
    next: '刷新信箱列表后重试。',
    en: {
      title: "The sending mailbox does not exist",
      why: "It may have been deleted or belong to another workspace.",
      next: "Refresh the mailbox list and retry.",
    },
  },
  OUTREACH_MAILBOX_DUPLICATE: {
    title: '该发件信箱已存在',
    why: '同一工作空间内，一个发件地址只能登记一次。',
    next: '在现有信箱上修改配置，而不是重复创建。',
    en: {
      title: "This sending mailbox already exists",
      why: "A sending address can be registered only once per workspace.",
      next: "Edit the existing mailbox instead of creating a duplicate.",
    },
  },
  OUTREACH_DOMAIN_NOT_FOUND: {
    title: '发件域不存在',
    why: '该域名还没有任何信箱或种子测试记录。',
    next: '先创建该域下的发件信箱，或核对域名拼写。',
    en: {
      title: "The sending domain does not exist",
      why: "No mailbox or seed test has been recorded for this domain yet.",
      next: "Create a mailbox on this domain first, or check the spelling.",
    },
  },
} as const satisfies Record<string, ErrorCopy>;

export type EngineErrorCode = keyof typeof ENGINE_ERROR_COPY;

export function copyForError(code: string, lang?: string | null): ErrorCopy {
  const copy: ErrorCopy =
    ENGINE_ERROR_COPY[code as EngineErrorCode] ?? {
      title: '操作没有成功',
      why: '系统返回了一个未登记的错误。',
      next: '请重试;若反复出现,请复制「技术详情」联系运营。',
    };
  if (lang && lang.toLowerCase().startsWith('en') && copy.en) {
    return { title: copy.en.title, why: copy.en.why, next: copy.en.next };
  }
  return copy;
}

import {
  classifyReplyIntent,
  type OutreachReplyIntent,
  type ParsedEmail,
} from './outreach-email-ingest.js';

export type ReplyCopilotLanguage = 'en' | 'de' | 'es' | 'fr' | 'it' | 'pt' | 'zh';

export type ReplyCopilotAction =
  | 'SEND_DATASHEET_AND_QUOTE'
  | 'FOLLOW_UP_REFERRED_CONTACT'
  | 'HANDLE_OBJECTION'
  | 'BOOK_CALL_OR_SAMPLE'
  | 'SCHEDULE_LATER_FOLLOWUP'
  | 'WAIT_UNTIL_RETURN'
  | 'RESPECT_OPTOUT'
  | 'MANUAL_REVIEW';

export interface ReplyCopilotDraft {
  readonly replyId: string;
  readonly intent: OutreachReplyIntent;
  readonly classification: string;
  readonly language: ReplyCopilotLanguage;
  readonly recommendedAction: ReplyCopilotAction;
  /** 合规门禁：对退订/投诉/硬退/拒联严禁生成外发跟进草稿。 */
  readonly sendBlocked: boolean;
  readonly summary: string;
  readonly checklist: readonly string[];
  readonly suggestedSubject: string | null;
  readonly suggestedBody: string | null;
  readonly referredEmails: readonly string[];
  /** 当买家转交了新联系人时，附带给新联系人的“转交破冰”开场草稿。 */
  readonly referralIntroDraft: {
    readonly to: string;
    readonly subject: string;
    readonly body: string;
  } | null;
}

export interface ReplyCopilotInput {
  readonly replyId: string;
  readonly kind: 'REPLY' | 'BOUNCE' | 'UNSUBSCRIBE' | 'COMPLAINT';
  readonly classification: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'OUT_OF_OFFICE' | 'UNKNOWN';
  readonly subject: string | null;
  readonly snippet: string | null;
  readonly recipientEmail: string | null;
  readonly companyName?: string | null;
  readonly countryCode?: string | null;
  readonly sellerCompanyName?: string | null;
}

const REFERRED_TAG_RE = /\[referred:\s*([^\]]+)\]/i;
const EMAIL_TOKEN_RE = /\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/giu;

export function detectReplyLanguage(
  text: string,
  countryCode?: string | null,
): ReplyCopilotLanguage {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  if (/[äöüß]|(?:\b(?:angebot|datenblatt|preisliste|lieferant|danke|bitte|sehr\s+geehrte|grüße)\b)/iu.test(text)) {
    return 'de';
  }
  if (/(?:\b(?:cotizaci[óo]n|ficha\s+t[ée]cnica|gracias|proveedor|estimado|precio)\b)/iu.test(text)) {
    return 'es';
  }
  if (/(?:\b(?:devis|bonjour|merci|fournisseur|fiche\s+technique|cordialement)\b)/iu.test(text)) {
    return 'fr';
  }
  if (/(?:\b(?:preventivo|scheda\s+tecnica|grazie|fornitore|buongiorno|cordiali)\b)/iu.test(text)) {
    return 'it';
  }
  if (/(?:\b(?:or[çc]amento|obrigado|fornecedor|pre[çc]os|atenciosamente)\b)/iu.test(text)) {
    return 'pt';
  }
  const cc = countryCode?.trim().toUpperCase();
  if (cc === 'DE' || cc === 'AT' || cc === 'CH') return 'de';
  if (cc === 'ES' || cc === 'MX' || cc === 'CL' || cc === 'CO') return 'es';
  if (cc === 'FR' || cc === 'BE') return 'fr';
  if (cc === 'IT') return 'it';
  if (cc === 'BR' || cc === 'PT') return 'pt';
  if (cc === 'CN' || cc === 'TW' || cc === 'HK') return 'zh';
  return 'en';
}

function extractReferredFromSnippet(snippet: string | null, recipientEmail: string | null): string[] {
  if (!snippet) return [];
  const excluded = new Set(recipientEmail ? [recipientEmail.trim().toLowerCase()] : []);
  const out = new Set<string>();
  const tagMatch = REFERRED_TAG_RE.exec(snippet);
  const scanTarget = tagMatch ? `${tagMatch[1]}\n${snippet}` : snippet;
  for (const m of scanTarget.matchAll(EMAIL_TOKEN_RE)) {
    const addr = m[1]!.toLowerCase();
    if (!excluded.has(addr)) out.add(addr);
  }
  return [...out].slice(0, 5);
}

function replySubject(originalSubject: string | null, fallback: string): string {
  const clean = originalSubject?.trim();
  if (!clean) return fallback;
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

function localizedBody(
  action: ReplyCopilotAction,
  lang: ReplyCopilotLanguage,
  ctx: { seller: string; company: string; referredEmail?: string },
): { subject: string; body: string } {
  const { seller, company, referredEmail } = ctx;
  switch (action) {
    case 'SEND_DATASHEET_AND_QUOTE':
      if (lang === 'de') {
        return {
          subject: 'Datenblatt, Zertifikate und Richtpreis',
          body: `Guten Tag,\n\nvielen Dank für Ihre schnelle Rückmeldung. Im Anhang senden wir Ihnen das aktuelle technische Datenblatt sowie unsere Zertifikatsübersicht.\n\nDamit wir Ihnen ein passgenaues Angebot (FOB/CIF/DDP, Lieferzeit und MOQ) erstellen können, teilen Sie uns bitte kurz den geschätzten Projektbedarf und den gewünschten Zielhafen mit.\n\nFreundliche Grüße\n${seller}`,
        };
      }
      if (lang === 'zh') {
        return {
          subject: '产品规格书、认证清单与阶梯报价',
          body: `您好，\n\n感谢您的及时回复。附件已附上最新产品规格书与相关认证资料。\n\n为方便为您提供更精准的报价（FOB/CIF/DDP、交期与起订量），请告知您的大致采购量、目标交货地与期望交付周期，我方当天即可出具正式报价单。\n\n顺祝商祺\n${seller}`,
        };
      }
      return {
        subject: 'Datasheet, certifications & indicative quotation',
        body: `Hello,\n\nThank you for your reply. Please find attached our latest technical datasheet and compliance certification summary.\n\nTo prepare an accurate quotation (MOQ, lead time, and FOB/CIF/DDP terms), could you share your estimated project volume and destination port? We can turn around a formal offer within 24 hours.\n\nBest regards,\n${seller}`,
      };

    case 'HANDLE_OBJECTION':
      if (lang === 'de') {
        return {
          subject: 'Kurze Rückmeldung — Option als Zweitlieferant',
          body: `Guten Tag,\n\nvielen Dank für Ihre offene Rückmeldung. Dass ${company} bereits etablierte Lieferanten hat, ist absolut nachvollziehbar.\n\nViele unserer europäischen Partner nutzen uns zunächst gezielt als qualifizierten Zweitlieferanten für Spitzenbedarf oder Kleinserien-Testaufträge, um Lieferzeiten und Stückkosten ohne Umstellungsrisiko zu vergleichen. Falls hilfreich, senden wir gern eine unverbindliche Kurzübersicht für Ihr nächstes Ausschreibungsfenster.\n\nFreundliche Grüße\n${seller}`,
        };
      }
      if (lang === 'zh') {
        return {
          subject: '理解贵司已有合作供应商——提供备选二供与小单验证方案',
          body: `您好，\n\n非常感谢坦诚告知，完全理解 ${company} 目前已有稳定的合作供应商。\n\n我们很多海外客户最初也是先将我们纳入备选二供池，在旺季补货或小批量试单时做交期与综合成本对比，零切换风险。如果您方便，我可先留一份精简规格与交付能力摘要供下次询价比价参考。\n\n顺祝商祺\n${seller}`,
        };
      }
      return {
        subject: 'Understood — qualified backup supplier option',
        body: `Hello,\n\nThank you for your candid reply — completely understand that ${company} already has established supply partners.\n\nMost of our B2B partners initially qualify us as a backup supplier for peak-season overflow or a small trial lot to benchmark lead time and landed cost with zero switching risk. If helpful, I can share a concise one-page capability & lead-time sheet to keep on file for your next sourcing cycle.\n\nBest regards,\n${seller}`,
      };

    case 'FOLLOW_UP_REFERRED_CONTACT':
      if (lang === 'de') {
        return {
          subject: 'Vielen Dank für die Weiterleitung',
          body: `Guten Tag,\n\nvielen Dank für den freundlichen Hinweis${referredEmail ? ` und die Kontaktdaten (${referredEmail})` : ''}. Wir wenden uns direkt an die zuständige Kollegin bzw. den zuständigen Kollegen und nehmen Sie aus weiteren Rückfragen heraus.\n\nFreundliche Grüße\n${seller}`,
        };
      }
      if (lang === 'zh') {
        return {
          subject: '感谢引荐对接人',
          body: `您好，\n\n非常感谢您的热心转交${referredEmail ? `（${referredEmail}）` : ''}。我们将直接联系相关负责同事，后续不再打扰您的邮箱。\n\n顺祝商祺\n${seller}`,
        };
      }
      return {
        subject: 'Thank you for the introduction',
        body: `Hello,\n\nThank you for pointing me in the right direction${referredEmail ? ` (${referredEmail})` : ''}. I will reach out to them directly and take you off this thread.\n\nBest regards,\n${seller}`,
      };

    case 'BOOK_CALL_OR_SAMPLE':
      if (lang === 'de') {
        return {
          subject: 'Terminvorschlag für kurzes Fachgespräch',
          body: `Guten Tag,\n\nvielen Dank für Ihr Interesse! Für ein kurzes 15-minütiges Gespräch zur Klärung Ihrer Anforderungen schlage ich zwei Zeitfenster vor (gerne auch alternativ nach Ihrem Kalender):\n- Dienstag, 10:00 oder 15:00 Uhr MEZ\n- Donnerstag, 10:00 oder 14:30 Uhr MEZ\n\nAlternativ senden wir vorab gern Muster- und Spezifikationsdetails.\n\nFreundliche Grüße\n${seller}`,
        };
      }
      if (lang === 'zh') {
        return {
          subject: '预约 15 分钟沟通或寄样确认',
          body: `您好，\n\n很高兴收到您的积极回复！我们可以安排 15 分钟电话/视频沟通具体需求，以下两个时段供您参考（也可按您的时间调整）：\n- 周二 10:00 或 15:00\n- 周四 10:00 或 14:30\n\n如您更倾向先看样品与规格对比，也可直接告知收件信息。\n\n顺祝商祺\n${seller}`,
        };
      }
      return {
        subject: 'Quick 15-min call or sample follow-up',
        body: `Hello,\n\nGlad to hear this is relevant for ${company}. I would be happy to walk through specs, lead times, or a sample evaluation in a brief 15-minute call.\n\nWould either of these windows work (or feel free to suggest another time)?\n- Tuesday 10:00 or 15:00 (your local time)\n- Thursday 10:00 or 14:30 (your local time)\n\nBest regards,\n${seller}`,
      };

    case 'SCHEDULE_LATER_FOLLOWUP':
      if (lang === 'zh') {
        return {
          subject: '收到，后续按您的时间再联系',
          body: `您好，\n\n收到，感谢告知排期。我方已暂停当前跟进，将在您提到的下一采购窗口前再简要同步最新产品与交期，期间不再打扰。\n\n顺祝商祺\n${seller}`,
        };
      }
      return {
        subject: 'Noted — will check back next cycle',
        body: `Hello,\n\nThank you for letting me know the timing. I have paused all current follow-ups and will briefly check back ahead of your next sourcing window.\n\nBest regards,\n${seller}`,
      };

    case 'WAIT_UNTIL_RETURN':
      return {
        subject: '休假自动回复，无需立即发送',
        body: '',
      };

    default:
      return {
        subject: 'Follow-up on your reply',
        body: `Hello,\n\nThank you for getting back to us. Could you let us know the key specifications or timeline you are evaluating so we can send the most relevant information?\n\nBest regards,\n${seller}`,
      };
  }
}

/**
 * 回复副驾纯函数：基于已剥离引用块的回信分类结果，输出合规门控状态、行动清单与多语种可编辑回复草稿。
 */
export function buildReplyCopilotDraft(input: ReplyCopilotInput): ReplyCopilotDraft {
  const seller = input.sellerCompanyName?.trim() || 'Our Export Team';
  const company = input.companyName?.trim() || 'your team';
  const snippet = input.snippet ?? '';
  const combinedText = `${input.subject ?? ''}\n${snippet}`;
  const language = detectReplyLanguage(combinedText, input.countryCode);
  const referredEmails = extractReferredFromSnippet(snippet, input.recipientEmail);

  // 合规优先：退订/投诉/硬退/明确拒联绝不输出销售回复草稿。
  if (
    input.kind === 'UNSUBSCRIBE' ||
    input.kind === 'COMPLAINT' ||
    input.kind === 'BOUNCE' ||
    input.classification === 'NEGATIVE'
  ) {
    const intent: OutreachReplyIntent =
      input.classification === 'NEGATIVE' ? 'NEGATIVE_DECLINE' : 'NONE';
    return {
      replyId: input.replyId,
      intent,
      classification: input.classification,
      language,
      recommendedAction: 'RESPECT_OPTOUT',
      sendBlocked: true,
      summary:
        input.kind === 'BOUNCE'
          ? '该邮箱退信，已自动停止当前跟进；请核验新决策人邮箱后再联系。'
          : '买家明确退订/投诉或拒绝联系，已写入 OPT_OUT 并刹停同公司待发队列，严禁再发推广邮件。',
      checklist: [
        '确认 OPT_OUT 压制记录已生效，切勿手工绕过重发',
        '检查同公司其他在途任务是否已全部自动取消',
      ],
      suggestedSubject: null,
      suggestedBody: null,
      referredEmails: [],
      referralIntroDraft: null,
    };
  }

  const fakeEmail: ParsedEmail = {
    headers: {},
    subject: input.subject,
    messageId: null,
    inReplyTo: null,
    references: [],
    from: input.recipientEmail,
    contentType: 'text/plain',
    reportType: null,
    parts: [],
    textBody: snippet.replace(REFERRED_TAG_RE, '').trim(),
  };
  const analyzed = classifyReplyIntent(fakeEmail, [input.recipientEmail]);
  const effectiveIntent: OutreachReplyIntent =
    input.classification === 'OUT_OF_OFFICE'
      ? 'OUT_OF_OFFICE'
      : analyzed.intent !== 'NONE'
        ? analyzed.intent
        : input.classification === 'POSITIVE'
          ? 'POSITIVE_INTEREST'
          : 'NONE';

  const mergedReferred = [
    ...new Set([...referredEmails, ...analyzed.referredEmails]),
  ].slice(0, 5);

  if (effectiveIntent === 'OUT_OF_OFFICE') {
    return {
      replyId: input.replyId,
      intent: 'OUT_OF_OFFICE',
      classification: 'OUT_OF_OFFICE',
      language,
      recommendedAction: 'WAIT_UNTIL_RETURN',
      sendBlocked: false,
      summary: '检测到对方外出休假自动回复（OOO），未拉黑联系人，建议等返岗后再跟进。',
      checklist: ['从休假邮件中确认返岗日期与代理联系人', '待返岗后再恢复跟进'],
      suggestedSubject: null,
      suggestedBody: null,
      referredEmails: mergedReferred,
      referralIntroDraft: null,
    };
  }

  let action: ReplyCopilotAction = 'MANUAL_REVIEW';
  let summary = '买家已回信且同公司自动跟进已刹停，请结合上下文人工回复。';
  let checklist: string[] = ['确认买家具体诉求与产品型号', '核对附件与报价条款后人工发送'];

  if (effectiveIntent === 'REFERRAL_NEW_CONTACT') {
    action = 'FOLLOW_UP_REFERRED_CONTACT';
    summary =
      mergedReferred.length > 0
        ? `买家转交了新联系人（${mergedReferred.join(', ')}），建议先致谢原联系人并立即向新联系人发送转交破冰信。`
        : '买家表示已转交采购同事，建议礼貌致谢并询问具体对接邮箱。';
    checklist = [
      '向原联系人发一句简短致谢并停止对其后续打扰',
      '对转交邮箱执行合法性核验后，使用下方转交破冰草稿发起首封联系',
    ];
  } else if (effectiveIntent === 'ASK_DATASHEET_QUOTE') {
    action = 'SEND_DATASHEET_AND_QUOTE';
    summary = '高意向询盘：买家索取规格书/认证/报价，建议 24 小时内附上资料并确认采购量与目的港。';
    checklist = [
      '附上对应产品规格书 PDF 与目标市场认证（如 IEC / UL / CE）',
      '明确最小起订量（MOQ）、交期与 FOB/CIF/DDP 贸易条款',
    ];
  } else if (effectiveIntent === 'OBJECTION_PRICE_OR_SUPPLIER') {
    action = 'HANDLE_OBJECTION';
    summary = '价格或既有供应商异议：未拉黑买家，建议切入“备选二供 + 小批量试单验证”避免直接价格战。';
    checklist = [
      '尊重买家现有合作关系，不贬低竞品',
      '突出差异化优势（交期/质保/局部现货/小单试产）争取进入备选池',
    ];
  } else if (effectiveIntent === 'POSITIVE_INTEREST') {
    action = 'BOOK_CALL_OR_SAMPLE';
    summary = '正向兴趣回复：建议直接给出两个明确的 15 分钟沟通时段或寄样确认。';
    checklist = ['按买家当地时区给出两个可选时段', '提前准备公司背书与同区域客户案例'];
  } else if (effectiveIntent === 'TIMING_LATER') {
    action = 'SCHEDULE_LATER_FOLLOWUP';
    summary = '买家表示下阶段再议：已暂停当前自动跟进，礼貌确认后续窗口并记录提醒时间。';
    checklist = ['礼貌回复确认暂不打扰', '在商机管线标注下季度回访日期'];
  }

  const template = localizedBody(action, language, {
    seller,
    company,
    referredEmail: mergedReferred[0],
  });

  const referralIntroDraft =
    mergedReferred.length > 0
      ? {
          to: mergedReferred[0]!,
          subject:
            language === 'zh'
              ? `贵司同事转交对接 — ${seller}`
              : `Referred by your colleague at ${company}`,
          body:
            language === 'zh'
              ? `您好，\n\n贵司同事建议我们就产品供应方案直接与您对接。附件附上我司精简资料，如您本周方便，欢迎回复告知您当前关注的规格与交期需求。\n\n顺祝商祺\n${seller}`
              : `Hello,\n\nYour colleague at ${company} kindly suggested I reach out to you directly regarding our supply capabilities. I have attached a brief one-page overview — would you be open to a quick exchange if this aligns with your upcoming sourcing plans?\n\nBest regards,\n${seller}`,
        }
      : null;

  return {
    replyId: input.replyId,
    intent: effectiveIntent,
    classification: input.classification,
    language,
    recommendedAction: action,
    sendBlocked: false,
    summary,
    checklist,
    suggestedSubject: replySubject(input.subject, template.subject),
    suggestedBody: template.body,
    referredEmails: mergedReferred,
    referralIntroDraft,
  };
}

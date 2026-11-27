import { formatCredits } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

import { $t } from '#/locales';

/**
 * 接口没给三层文案时的兜底说明（页面报错块和右上角的全局提示共用）。
 *
 * 服务端自己抛的错都会带 userCopy，走到这里的只有：网关 502、断网、超时，
 * 以及引擎透传的裸报错。以前这些情况会把英文原文直接摆给用户
 * （「Request failed with status code 502」），现在按状态码给本语言的说明，
 * 英文原文只留在「技术详情」里。
 */

/** 文案里已有中文：说明这条说明本来就是写给中文用户看的。 */
const hasCjk = (text: string): boolean => /[\u3400-\u9fff]/.test(text);

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

interface ErrorLike {
  code?: unknown;
  isAxiosError?: boolean;
  message?: unknown;
  response?: { data?: unknown; status?: number };
}

function errorOf(error: unknown): ErrorLike | null {
  return error && typeof error === 'object' ? (error as ErrorLike) : null;
}

function responseOf(error: unknown): ErrorLike['response'] {
  return errorOf(error)?.response;
}

/** 服务端响应体里可能带的原始说明：{ error: { message } } 或 { message }。 */
function serverMessageOf(error: unknown): string | undefined {
  const data = responseOf(error)?.data as { error?: { message?: unknown }; message?: unknown } | null | undefined;
  return textOf(data?.error?.message) ?? textOf(data?.message);
}

/** 请求层面的失败（有响应，或是 axios 抛的）；页面代码自己 throw 的不算。 */
function isRequestFailure(error: unknown): boolean {
  const source = errorOf(error);
  return Boolean(source?.response) || Boolean(source?.isAxiosError);
}

/** 文案键（gainos.errors.*）。没有响应说明请求根本没到服务器：断网或超时。 */
function copyKey(error: unknown, status: number | undefined): string {
  if (status === undefined) {
    const source = errorOf(error);
    const timedOut =
      source?.code === 'ECONNABORTED' || /timeout/i.test(textOf(source?.message) ?? '');
    return timedOut ? 'timeout' : 'network';
  }
  if (status === 401) return 'loginExpired';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'notFound';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rateLimited';
  if (status >= 500) return 'server';
  return 'request';
}

export interface FailureCopy {
  next?: string;
  title: string;
}

function walletFailureCopy(error: unknown): FailureCopy | undefined {
  const data = responseOf(error)?.data as {
    error?: { code?: unknown; details?: { availableCredits?: unknown; requiredCredits?: unknown } };
  } | null | undefined;
  const body = data?.error;
  if (body?.code === 'WALLET_FROZEN') {
    return {
      next: $t('gainosBuyerJourney.billing.frozenNext'),
      title: $t('gainosBuyerJourney.billing.frozen'),
    };
  }
  if (body?.code !== 'INSUFFICIENT_CREDITS') return undefined;

  // Wallet use is denominated in integral bigint credits. Keep the server's precision.
  const { availableCredits, requiredCredits } = body.details ?? {};
  const validCredits = (value: unknown): value is string =>
    typeof value === 'string' && /^\d{1,19}$/.test(value);
  return {
    title: $t('gainosBuyerJourney.billing.insufficient'),
    next: validCredits(availableCredits) && validCredits(requiredCredits)
      ? $t('gainosBuyerJourney.billing.amounts', {
          available: formatCredits(availableCredits),
          required: formatCredits(requiredCredits),
        })
      : $t('gainosBuyerJourney.billing.insufficientNext'),
  };
}

export function httpFailureCopy(error: unknown): FailureCopy {
  const walletCopy = walletFailureCopy(error);
  if (walletCopy) return walletCopy;

  const serverMessage = serverMessageOf(error);
  const english = preferences.app.locale === 'en-US';
  // 服务端写了本语言的说明就直接用（中文界面配中文说明，英文界面配英文说明）；
  // 语言对不上的原文用户看不懂，换成下面按状态码给的说明。
  if (serverMessage && (english ? !hasCjk(serverMessage) : hasCjk(serverMessage))) {
    return { title: serverMessage };
  }
  if (!isRequestFailure(error)) {
    const message = textOf(errorOf(error)?.message);
    if (message) return { title: message };
    return {
      next: $t('gainos.errors.unknown.next'),
      title: $t('gainos.errors.unknown.title'),
    };
  }
  const status = responseOf(error)?.status;
  const key = `gainos.errors.${copyKey(error, status)}`;
  const base = $t(`${key}.title`);
  return {
    next: $t(`${key}.next`),
    // 5xx 带上状态码：用户反馈问题时说得出「看到 502」。
    title: status !== undefined && status >= 500 ? `${base}（${status}）` : base,
  };
}

/**
 * 给「技术详情」用的原始信息。页面上的主文案换成中文说明后，英文原文留在这里，
 * 反馈问题时拿它对账。没有可留的就返回 undefined，页面不显示这一栏。
 */
export function httpFailureTechText(error: unknown): string | undefined {
  if (!isRequestFailure(error)) return undefined;
  const status = responseOf(error)?.status;
  const serverMessage = serverMessageOf(error);
  const parts = [
    status === undefined ? undefined : `HTTP ${status}`,
    serverMessage ?? textOf(errorOf(error)?.message),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

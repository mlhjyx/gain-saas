/**
 * 把文字复制到剪贴板。复制不了时抛错，由调用方提示用户，不要静默吞掉。
 *
 * navigator.clipboard 只在安全来源（HTTPS、localhost）下存在。用内网 IP 或 http:// 地址打开系统时，
 * 它是 undefined，直接调用会抛错——用户看到的就是「点复制没反应」。所以先用它，
 * 不可用或被浏览器拒绝时，退回到隐藏文本框 + execCommand('copy')（非安全来源下也能用）。
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 没有用户手势、权限被拒等：接着试老办法。
    }
  }
  legacyCopy(text);
}

function legacyCopy(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  // 不能用 display:none / visibility:hidden：那样的元素选不中。挪到可视区域外即可。
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    textarea.remove();
    // 把用户原来选中的内容还回去。
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
  if (!ok) throw new Error('copy command was rejected');
}

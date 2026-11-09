import { ref } from 'vue';

/**
 * 待决动作（P5b-05）：双击防抖 + Idempotency-Key 透传。
 *
 * 语义：
 *  - `pending` 为真时，重复调用 `run` 直接复用同一个在飞 Promise（不会发出第二个请求）；
 *  - 每次「新的逻辑动作」生成一个 `crypto.randomUUID()` 键；**失败后键保留**——
 *    用户重试同一个动作时沿用旧键，服务端按幂等重放而不是重复执行副作用；
 *    成功后清空键，下一次动作换新键。
 */
export function usePendingAction() {
  const pending = ref(false);
  let inFlight: null | Promise<unknown> = null;
  let currentKey: null | string = null;

  function nextKey(): string {
    if (!currentKey) {
      currentKey =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `idem-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    }
    return currentKey;
  }

  async function run<T>(action: (idempotencyKey: string) => Promise<T>): Promise<T> {
    if (inFlight) return inFlight as Promise<T>;
    const key = nextKey();
    pending.value = true;
    inFlight = (async () => {
      try {
        const result = await action(key);
        currentKey = null; // 成功：本次动作结束，下次换新键
        return result;
      } finally {
        pending.value = false;
        inFlight = null;
      }
    })();
    return inFlight as Promise<T>;
  }

  return { pending, run };
}

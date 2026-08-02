export const LOCATOR_ATTRIBUTE_TIMEOUT_MS = 2000;

type AttributeLocator = {
  getAttribute(name: string, options?: { timeout?: number }): Promise<string | null>;
};

export type AttributeReadResult =
  | { ok: true; value: string | null }
  | { ok: false; value: null; timedOut: boolean; error: string };

export function attributeReadFailureImpact(total: number, index: number, timedOut: boolean) {
  return {
    unverified: timedOut ? Math.max(0, total - index) : 1,
    stop: timedOut,
  };
}

/**
 * Playwright locator 읽기 하나가 전체 test timeout까지 붙잡지 않도록 호출 자체에 상한을 둔다.
 * 실패를 삼키지 않고 분류해 돌려주므로 호출부가 커버리지 누락을 기록할 수 있다.
 */
export async function readLocatorAttribute(
  locator: AttributeLocator,
  name: string,
  timeoutMs = LOCATOR_ATTRIBUTE_TIMEOUT_MS,
): Promise<AttributeReadResult> {
  try {
    return { ok: true, value: await locator.getAttribute(name, { timeout: timeoutMs }) };
  } catch (error) {
    const message = String((error as Error)?.message ?? error).split('\n')[0].slice(0, 240);
    return {
      ok: false,
      value: null,
      timedOut: /timeout|timed out/i.test(message),
      error: message || 'locator 속성 읽기 실패',
    };
  }
}

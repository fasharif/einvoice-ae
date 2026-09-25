/** Retry policy: exponential backoff with full jitter, honouring Retry-After. */

export interface RetryPolicy {
  /** Total attempts including the first one. */
  readonly maxAttempts: number;
  /** Upper bound of the first delay. */
  readonly baseDelayMs: number;
  /** No delay is longer than this, including delays asked for by Retry-After. */
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 10_000 };

/**
 * Delay before retry number `attempt` (1 for the first retry): a random value between 0
 * and min(maxDelay, base x 2^(attempt-1)). Full jitter spreads retries from many clients
 * so that they do not hit a recovering provider at the same moment.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError(`attempt must be a positive integer (got ${attempt})`);
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

/** Status codes worth retrying: timeouts, rate limits and temporary server failures. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** Parses a Retry-After header (seconds or an HTTP date) into milliseconds from now. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** A sleep that ends early (with the abort reason) when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

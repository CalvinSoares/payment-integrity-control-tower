export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

export function retryDelayMs(attempts: number, policy: RetryPolicy): number {
  const exponent = Math.max(attempts - 1, 0);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
}

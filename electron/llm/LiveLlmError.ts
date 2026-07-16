export type LiveLlmErrorCode =
  | 'fast_unavailable'
  | 'auth_failure'
  | 'rate_limited'
  | 'server_unavailable'
  | 'request_failed';

const USER_VISIBLE_LIVE_LLM_ERRORS = new Set<LiveLlmErrorCode>([
  'fast_unavailable',
  'auth_failure',
  'rate_limited',
  'server_unavailable',
  'request_failed',
]);

export function isUserVisibleLiveLlmError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code as LiveLlmErrorCode | undefined;
  return Boolean(code && USER_VISIBLE_LIVE_LLM_ERRORS.has(code));
}

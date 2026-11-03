/** True when Google rejected the refresh token (expired, revoked, or Testing-mode 7-day limit). */
export function isInvalidGrant(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { message, response } = err as { message?: unknown; response?: { data?: unknown } };
  const data = response?.data;
  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { error?: unknown }).error === 'invalid_grant'
  ) {
    return true;
  }
  return typeof message === 'string' && message.includes('invalid_grant');
}

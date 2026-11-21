/**
 * The one error Groundwork must never handle itself.
 *
 * `api.asUser()` throws it when the current person's access to the app is not
 * set up yet. Forge then sets it up, silently or with its "Allow access" prompt,
 * but only when the error leaves the function. A handler that catches it and
 * answers with its own message leaves that person locked out, so every catch on
 * the way out has to let it through.
 */
const NEEDS_AUTHENTICATION = 'NEEDS_AUTHENTICATION_ERR';

/** True for the error Forge throws when the current person's access is not set up. */
export function needsUserConsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === NEEDS_AUTHENTICATION;
}

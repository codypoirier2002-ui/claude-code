import { isForgePlatformError, NeedsAuthenticationError } from '@forge/api';
import { describe, expect, it } from 'vitest';
import { needsUserConsent } from '../src/platform/consent';
import { JiraError } from '../src/platform/jira';

describe('needsUserConsent', () => {
  it("recognizes the error Forge throws when a person's access is not set up yet", () => {
    // The error `api.asUser().requestJira()` throws in that case, built by Forge's own class.
    const consent = new NeedsAuthenticationError('Authentication Required', 'atlassian-token-service-key');
    expect(isForgePlatformError(consent)).toBe(true);
    expect(needsUserConsent(consent)).toBe(true);
    // It is matched by name, so a copy from another bundle of the class still counts.
    expect(needsUserConsent({ name: consent.name, status: 401 })).toBe(true);
  });

  it('leaves every other failure to Groundwork', () => {
    expect(needsUserConsent(new Error('socket hang up'))).toBe(false);
    expect(needsUserConsent(new JiraError('You do not have permission to view work item KAN-1.', 403))).toBe(false);
    expect(needsUserConsent('NEEDS_AUTHENTICATION_ERR')).toBe(false);
    expect(needsUserConsent(undefined)).toBe(false);
    expect(needsUserConsent(null)).toBe(false);
  });
});

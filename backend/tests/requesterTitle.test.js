import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { requesterTitle } from '../src/utils/requesterTitle.js';

/**
 * One title for a requester everywhere (18 Nov 2026): Maria Dietrich was
 * promoted in Entra, but search and Teams cards still showed the FreshService
 * title while her profile page showed the new one.
 */
describe('requesterTitle', () => {
  test('Entra wins over the FreshService copy', () => {
    expect(requesterTitle({ jobTitle: 'Senior Project Administrator', entraJobTitle: 'Project Accountant I' })).toBe('Project Accountant I');
  });

  test('FreshService fills in when Entra has nothing', () => {
    expect(requesterTitle({ jobTitle: 'Geologist', entraJobTitle: null })).toBe('Geologist');
    expect(requesterTitle({ jobTitle: 'Geologist', entraJobTitle: '   ' })).toBe('Geologist');
  });

  test('no title at all is null', () => {
    expect(requesterTitle({})).toBeNull();
    expect(requesterTitle(null)).toBeNull();
    expect(requesterTitle({ jobTitle: '' })).toBeNull();
  });

  test('no surface reads the FreshService title first any more', () => {
    const files = [
      '../src/routes/apiV1.routes.js',
      '../src/services/globalSearchService.js',
      '../src/services/teamsNotificationService.js',
      '../src/services/requesterProfileService.js',
      '../src/services/ticketApprovalService.js',
    ];
    for (const f of files) {
      const s = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(s).not.toMatch(/jobTitle \|\| (?:\w+\.)?entraJobTitle/);
      expect(s).toContain('requesterTitle(');
    }
  });
});

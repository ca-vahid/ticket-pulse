import { requesterContextFromSource } from '../src/services/requesterProfileService.js';

describe('requester profile service', () => {
  test('builds requester location context from Entra fields', () => {
    const context = requesterContextFromSource({
      id: 40,
      name: 'Requester',
      email: 'requester@example.com',
      department: 'Vancouver',
      jobTitle: 'Project Manager',
      timeZone: 'American Samoa',
      language: 'en',
      entraOfficeLocation: 'Vancouver',
      entraCity: 'Vancouver',
      entraState: 'CA-BC',
      entraCountry: 'Canada',
      entraCountryCode: 'CA',
      entraDepartment: 'Operations',
      entraJobTitle: 'Project Manager',
      entraPreferredLanguage: null,
      entraProfileSyncedAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(context.officeLocation).toBe('Vancouver');
    expect(context.city).toBe('Vancouver');
    expect(context.stateName).toBe('British Columbia');
    expect(context.country).toBe('Canada');
    expect(context.locationSummary).toBe('Vancouver, British Columbia, Canada');
    expect(context.locationSource).toBe('entra');
    expect(context.timeZone).toBe('American Samoa');
    expect(context.timeZoneIana).toBe('America/Vancouver');
    expect(context.freshserviceDepartment).toBe('Vancouver');
    expect(context.entraDepartment).toBe('Operations');
  });

  test('falls back to FreshService department as conservative location label', () => {
    const context = requesterContextFromSource({
      id: 41,
      name: 'Requester',
      email: 'requester@example.com',
      department: 'Calgary',
      jobTitle: 'Engineer',
      timeZone: 'Pacific Time (US & Canada)',
      language: 'en',
    });

    expect(context.officeLocation).toBe('Calgary');
    expect(context.city).toBe('Calgary');
    expect(context.locationSummary).toBe('Calgary');
    expect(context.locationSource).toBe('freshservice_department');
    expect(context.timeZoneIana).toBe('America/Edmonton');
  });
});

import { describe, expect, test } from 'vitest';
import { absoluteApiUrl, personMetaLines } from './approvalMeta';

describe('absoluteApiUrl', () => {
  test('prefixes app-relative API paths with the configured API origin', () => {
    const origin = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
    expect(absoluteApiUrl('/api/ticket-approvals/public/tok/photo?who=requester')).toBe(`${origin}/api/ticket-approvals/public/tok/photo?who=requester`);
  });
  test('leaves absolute, data and empty URLs alone', () => {
    expect(absoluteApiUrl('https://x.test/p.jpg')).toBe('https://x.test/p.jpg');
    expect(absoluteApiUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(absoluteApiUrl(null)).toBeNull();
    expect(absoluteApiUrl('')).toBeNull();
  });
});

describe('personMetaLines', () => {
  test('drops a department that repeats the location, and a location already in the title', () => {
    expect(personMetaLines({ title: 'Geotechnical Engineer-in-Training', location: 'Vancouver', department: 'Vancouver' }))
      .toEqual(['Geotechnical Engineer-in-Training · Vancouver']);
    expect(personMetaLines({ title: 'Geotechnical Engineer, Vancouver', location: 'Vancouver', department: 'Geotechnical' }))
      .toEqual(['Geotechnical Engineer, Vancouver']);
  });
  test('keeps distinct department and handles missing fields', () => {
    expect(personMetaLines({ title: 'Analyst', location: 'Calgary', department: 'Finance' })).toEqual(['Analyst · Calgary', 'Finance']);
    expect(personMetaLines({})).toEqual([]);
    expect(personMetaLines({ location: 'Kamloops' })).toEqual(['Kamloops']);
  });
});

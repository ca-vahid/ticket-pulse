import { isSiteVisitLeave, isAwayLeave } from '../src/utils/leaveKinds.js';

/**
 * 25 Nov 2026: a Vacation Pulse "Site visit" (availability ONSITE) is stored as
 * category OTHER and every reader took it as away. A site visit is work at
 * another site; other OTHER rows (physio, training) stay away.
 */
const other = (leaveTypeName) => ({ category: 'OTHER', leaveTypeName });

describe('isSiteVisitLeave', () => {
  test.each(['Site visit', 'Site Visit', 'site-visit', 'Site visits', 'Field work', 'Field', 'On site', 'Business trip'])('%s is a site visit', (name) => {
    expect(isSiteVisitLeave(other(name))).toBe(true);
  });

  test.each(['Physio', 'Training', 'Leaving early', 'Doctor', 'Sick', '', null])('%s is not a site visit', (name) => {
    expect(isSiteVisitLeave(other(name))).toBe(false);
  });

  test('the category wins: OFF, WFH and IGNORED rows are never site visits', () => {
    for (const category of ['OFF', 'WFH', 'IGNORED']) {
      expect(isSiteVisitLeave({ category, leaveTypeName: 'Site visit' })).toBe(false);
      expect(isSiteVisitLeave({ category, availability: 'ONSITE' })).toBe(false);
    }
  });

  test('reads the name in any of the shapes the readers pass', () => {
    expect(isSiteVisitLeave({ category: 'OTHER', leave_type_name: 'Site visit' })).toBe(true);
    expect(isSiteVisitLeave({ category: 'OTHER', leaveType: 'Site visit' })).toBe(true);
    expect(isSiteVisitLeave({ category: 'OTHER', typeName: 'Site visit' })).toBe(true);
    expect(isSiteVisitLeave({ category: 'OTHER', availability: 'onsite' })).toBe(true);
    expect(isSiteVisitLeave(null)).toBe(false);
  });
});

describe('isAwayLeave', () => {
  test('a site visit is not away; physio and training are', () => {
    expect(isAwayLeave(other('Site visit'))).toBe(false);
    expect(isAwayLeave(other('Site Visit'))).toBe(false);
    expect(isAwayLeave(other('Physio'))).toBe(true);
    expect(isAwayLeave(other('Training'))).toBe(true);
  });

  test('OFF is away; WFH and IGNORED are not; no category keeps the old away meaning', () => {
    expect(isAwayLeave({ category: 'OFF', leaveTypeName: 'Vacation' })).toBe(true);
    expect(isAwayLeave({ category: 'OFF', leaveTypeName: 'Site visit' })).toBe(true);
    expect(isAwayLeave({ category: 'WFH' })).toBe(false);
    expect(isAwayLeave({ category: 'IGNORED' })).toBe(false);
    expect(isAwayLeave({ category: null })).toBe(true);
    expect(isAwayLeave(null)).toBe(false);
  });
});

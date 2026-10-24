import { jest } from '@jest/globals';

/**
 * QA 10-23 #2: the after-hours contact shown to requesters is the on-call
 * person of Urgent response → On-call (handover time and covers). The old
 * manual contact, weekly rotation, first-roster-phone and legacy-phone
 * fallbacks are gone: they printed one person's number every week.
 */
const prismaMock = {
  urgentEscalationPolicy: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn() },
};
const onCallMock = { current: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/urgentResponse/onCallService.js', () => ({ default: onCallMock }));

const { resolveAfterHoursActiveContact } = await import('../src/services/urgentEscalationContactService.js');

const pref = (phone, verified = true) => ({ phoneOverride: phone, phoneVerifiedAt: phone && verified ? new Date('2026-01-01T00:00:00Z') : null });
const person = (id, name, phone, verified) => ({ id, name, email: `${id}@example.com`, notificationPreference: pref(phone, verified) });
const AT = new Date('2026-10-14T16:00:00Z');
const UNTIL = new Date('2026-10-19T16:00:00Z');
const onCall = (id, name, extra = {}) => ({ configured: true, technician: { id, name }, scheduled: { id, name }, cover: null, until: UNTIL, onLeaveNoCover: false, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.urgentEscalationPolicy.findUnique.mockResolvedValue({ showAfterHoursPhoneInEmail: true });
  prismaMock.technician.findFirst.mockResolvedValue(null);
  onCallMock.current.mockResolvedValue({ configured: false, technician: null });
});

test('the on-call person and their verified phone', async () => {
  onCallMock.current.mockResolvedValue(onCall(11, 'Alex Fong'));
  prismaMock.technician.findFirst.mockResolvedValue(person(11, 'Alex Fong', '+16045550111'));
  const contact = await resolveAfterHoursActiveContact(1, { at: AT });
  expect(contact).toMatchObject({
    technicianId: 11, name: 'Alex Fong', phone: '+16045550111', phoneVerified: true, source: 'on_call',
    rotationLabel: 'On call this week', until: UNTIL.toISOString(), photoUrl: null, warnings: [],
  });
  expect(onCallMock.current).toHaveBeenCalledWith(1, AT);
  // Never the photo.
  expect(prismaMock.technician.findFirst).toHaveBeenCalledWith({
    where: { id: 11, workspaceId: 1, isActive: true },
    select: { id: true, name: true, email: true, notificationPreference: true },
  });
});

test('a cover is followed', async () => {
  onCallMock.current.mockResolvedValue(onCall(33, 'Jordan Lee', { scheduled: { id: 11, name: 'Alex Fong' }, cover: { id: 7 } }));
  prismaMock.technician.findFirst.mockResolvedValue(person(33, 'Jordan Lee', '+16045550133'));
  const contact = await resolveAfterHoursActiveContact(1, { at: AT });
  expect(contact).toMatchObject({ technicianId: 33, phone: '+16045550133', rotationLabel: 'On call (covering for Alex Fong)' });
});

test('an unverified phone is never printed, and nobody else stands in', async () => {
  onCallMock.current.mockResolvedValue(onCall(42, 'Pat Moore'));
  prismaMock.technician.findFirst.mockResolvedValue(person(42, 'Pat Moore', '+16045550142', false));
  const contact = await resolveAfterHoursActiveContact(1, { at: AT });
  expect(contact).toMatchObject({ technicianId: 42, name: 'Pat Moore', phone: null, phoneVerified: false, source: 'on_call', warnings: ['on_call_phone_not_verified'] });
});

test('numbers hidden for the workspace: the person, no number', async () => {
  prismaMock.urgentEscalationPolicy.findUnique.mockResolvedValue({ showAfterHoursPhoneInEmail: false });
  onCallMock.current.mockResolvedValue(onCall(11, 'Alex Fong'));
  prismaMock.technician.findFirst.mockResolvedValue(person(11, 'Alex Fong', '+16045550111'));
  const contact = await resolveAfterHoursActiveContact(1, { at: AT });
  expect(contact).toMatchObject({ technicianId: 11, phone: null, phoneHidden: true, warnings: ['phone_hidden_by_workspace_setting'] });
});

test('away all day with nobody covering: no number printed', async () => {
  onCallMock.current.mockResolvedValue(onCall(11, 'Alex Fong', { onLeaveNoCover: true }));
  prismaMock.technician.findFirst.mockResolvedValue(person(11, 'Alex Fong', '+16045550111'));
  const contact = await resolveAfterHoursActiveContact(1, { at: AT });
  expect(contact).toMatchObject({ technicianId: 11, phone: null, warnings: ['on_call_person_away_no_cover'] });
});

test.each([
  ['no on-call order saved', () => {}, 'on_call_not_configured'],
  ['the on-call service throws', () => onCallMock.current.mockRejectedValue(new Error('relation does not exist')), 'on_call_not_configured'],
  ['an order, but nobody holds it now', () => onCallMock.current.mockResolvedValue({ configured: true, technician: null }), 'no_one_on_call'],
])('%s: no contact and no fallback number', async (_label, arrange, warning) => {
  arrange();
  const contact = await resolveAfterHoursActiveContact(1, { at: AT });
  expect(contact).toMatchObject({ technicianId: null, phone: null, source: 'none', warnings: [warning] });
});

test('the on-call person cannot be read: named, no number', async () => {
  onCallMock.current.mockResolvedValue(onCall(99, 'Alex Fong'));
  prismaMock.technician.findFirst.mockRejectedValue(new Error('down'));
  const contact = await resolveAfterHoursActiveContact(1, { at: AT });
  expect(contact).toMatchObject({ technicianId: null, name: 'Alex Fong', phone: null, warnings: ['on_call_person_not_found'] });
});

test('no escalation policy or no workspace', async () => {
  prismaMock.urgentEscalationPolicy.findUnique.mockResolvedValue(null);
  expect(await resolveAfterHoursActiveContact(1)).toMatchObject({ source: 'none', warnings: ['policy_missing'] });
  expect(await resolveAfterHoursActiveContact(null)).toMatchObject({ source: 'none', warnings: ['missing_workspace'] });
  expect(onCallMock.current).not.toHaveBeenCalled();
});

import { jest } from '@jest/globals';

/**
 * The after-hours contact shown to requesters (weekly_rotation mode) follows
 * the Urgent response on-call rotation — handover time and covers — once an
 * order is saved there. With no order, or on any failure, the legacy weekly
 * rotation answers exactly as before.
 */
const prismaMock = {
  urgentEscalationPolicy: { findUnique: jest.fn() },
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn() },
};
const onCallMock = { current: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/urgentResponse/onCallService.js', () => ({ default: onCallMock }));

const { resolveAfterHoursActiveContact } = await import('../src/services/urgentEscalationContactService.js');

const pref = (phone) => ({ phoneOverride: phone, phoneVerifiedAt: phone ? new Date('2026-01-01T00:00:00Z') : null });
const recipient = (id, name, phone) => ({ technicianId: id, technician: { id, name, email: `${id}@example.com`, photoUrl: null, notificationPreference: pref(phone) } });
const POLICY = {
  workspaceId: 1, afterHoursContactMode: 'weekly_rotation', afterHoursRotationOrder: [11, 22], afterHoursRotationAnchorDate: new Date('2026-10-05T07:00:00Z'),
  showAfterHoursPhoneInEmail: true, legacyPhones: [], recipients: [recipient(11, 'Andrew Fong', '+16045550111'), recipient(22, 'Maria Lee', '+16045550122')],
};
// Wednesday 14 Oct 2026: week 2 of the legacy rotation → Maria (22).
const AT = new Date('2026-10-14T16:00:00Z');
const notConfigured = { configured: false, technician: null, scheduled: null, cover: null, until: null };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.urgentEscalationPolicy.findUnique.mockResolvedValue({ ...POLICY });
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
  prismaMock.technician.findFirst.mockResolvedValue(null);
  onCallMock.current.mockResolvedValue(notConfigured);
});

test('no on-call order saved: the legacy weekly rotation, unchanged', async () => {
  const contact = await resolveAfterHoursActiveContact(1, { at: AT });
  expect(contact).toMatchObject({ technicianId: 22, name: 'Maria Lee', phone: '+16045550122', source: 'weekly_rotation', rotationLabel: 'Weekly rotation 2 of 2' });
  expect(onCallMock.current).toHaveBeenCalledWith(1, AT);
});

test('an order is saved: the on-call person of the new rotation', async () => {
  onCallMock.current.mockResolvedValue({ configured: true, technician: { id: 11, name: 'Andrew Fong' }, scheduled: { id: 11, name: 'Andrew Fong' }, cover: null });
  const contact = await resolveAfterHoursActiveContact(1, { at: AT });
  expect(contact).toMatchObject({ technicianId: 11, name: 'Andrew Fong', phone: '+16045550111', source: 'weekly_rotation', rotationLabel: 'On call this week', phoneVerified: true });
});

test('a cover is followed, even when the cover is not on the escalation roster (read without the photo)', async () => {
  onCallMock.current.mockResolvedValue({ configured: true, technician: { id: 33, name: 'David Zapata' }, scheduled: { id: 11, name: 'Andrew Fong' }, cover: { id: 7 } });
  prismaMock.technician.findFirst.mockResolvedValue({ id: 33, name: 'David Zapata', email: 'dz@example.com', notificationPreference: pref('+16045550133') });
  const contact = await resolveAfterHoursActiveContact(1, { at: AT });
  expect(contact).toMatchObject({ technicianId: 33, name: 'David Zapata', phone: '+16045550133', photoUrl: null, rotationLabel: 'On call (covering for Andrew Fong)' });
  expect(prismaMock.technician.findFirst).toHaveBeenCalledWith({
    where: { id: 33, workspaceId: 1, isActive: true },
    select: { id: true, name: true, email: true, notificationPreference: true },
  });
});

test('the on-call person has no verified phone: the roster fallback still applies', async () => {
  onCallMock.current.mockResolvedValue({ configured: true, technician: { id: 33, name: 'David Zapata' }, scheduled: { id: 33, name: 'David Zapata' }, cover: null });
  prismaMock.technician.findFirst.mockResolvedValue({ id: 33, name: 'David Zapata', email: 'dz@example.com', notificationPreference: pref(null) });
  const contact = await resolveAfterHoursActiveContact(1, { at: AT });
  expect(contact).toMatchObject({ technicianId: 11, source: 'roster_fallback', phone: '+16045550111' });
});

test.each([
  ['the on-call service throws', () => onCallMock.current.mockRejectedValue(new Error('relation does not exist'))],
  ['the on-call person cannot be read', () => {
    onCallMock.current.mockResolvedValue({ configured: true, technician: { id: 99, name: 'Ghost' }, scheduled: { id: 99, name: 'Ghost' }, cover: null });
    prismaMock.technician.findFirst.mockRejectedValue(new Error('down'));
  }],
  ['the on-call person is not an active technician any more', () => {
    onCallMock.current.mockResolvedValue({ configured: true, technician: { id: 99, name: 'Ghost' }, scheduled: { id: 99, name: 'Ghost' }, cover: null });
  }],
])('%s: the legacy rotation answers', async (_label, arrange) => {
  arrange();
  const contact = await resolveAfterHoursActiveContact(1, { at: AT });
  expect(contact).toMatchObject({ technicianId: 22, name: 'Maria Lee', rotationLabel: 'Weekly rotation 2 of 2' });
});

test('manual mode never asks the on-call service', async () => {
  prismaMock.urgentEscalationPolicy.findUnique.mockResolvedValue({ ...POLICY, afterHoursContactMode: 'manual', afterHoursManualTechnicianId: 11 });
  const contact = await resolveAfterHoursActiveContact(1, { at: AT });
  expect(contact).toMatchObject({ technicianId: 11, source: 'manual' });
  expect(onCallMock.current).not.toHaveBeenCalled();
});

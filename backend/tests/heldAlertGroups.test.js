/**
 * QA 10-26 #3 — held mail grouped by device: alert kinds with numbers masked,
 * broken-sounding and new kinds first, and the fold target rule.
 */
import {
  alertKindKey, deviceLabel, groupHeldRows, isAttentionKind, kindLabel, kindTicketFor, senderKindFor, stripDeviceTag,
} from '../src/utils/heldAlertGroups.js';

const NAS = 'nas-one@x.io';
const OTHER = 'nas-two@x.io';
const row = (id, subject, over = {}) => ({
  id, subject, fromEmail: NAS, fromName: null, reason: 'sender_burst', receivedAt: `2026-10-23T16:${String(10 + (id % 50)).padStart(2, '0')}:00Z`, bestGuessTicket: null, ...over,
});

describe('alert kinds', () => {
  test('drive numbers, counters and the device tag do not split a kind; a different alert does', () => {
    const a = alertKindKey('[NAS-ONE] Drive 9 on RS3621RPxs is not on the Products Compatibility List of your NAS model');
    const b = alertKindKey('[NAS-ONE] Drive 12 on RS3621RPxs is not on the Products Compatibility List of your NAS model');
    expect(a).toBe(b);
    expect(alertKindKey('[NAS-ONE] Storage Pool 1 on NAS-ONE has degraded (10/11)')).toBe(alertKindKey('[NAS-ONE] Storage Pool 1 on NAS-ONE has degraded (29/30)'));
    expect(alertKindKey('[NAS-ONE] Storage Pool 1 on NAS-ONE has crashed')).not.toBe(a);
  });

  test('device label comes from the subject tag, else the sender', () => {
    expect(deviceLabel({ subject: '[NAS-ONE] Drive 3 failed', fromEmail: NAS })).toBe('NAS-ONE');
    expect(deviceLabel({ subject: 'Drive 3 failed', fromName: 'Rack UPS', fromEmail: NAS })).toBe('Rack UPS');
    expect(deviceLabel({ subject: 'Drive 3 failed', fromEmail: NAS })).toBe('nas-one');
    expect(stripDeviceTag('RE: [NAS-ONE] Volume 1 is full')).toBe('Volume 1 is full');
  });

  test('failure words mark a kind; capacity and compatibility notices do not', () => {
    expect(isAttentionKind('Storage Pool 1 on NAS-ONE has crashed')).toBe(true);
    expect(isAttentionKind('System failed to repair Storage Pool 1')).toBe(true);
    expect(isAttentionKind('Drive 3 on RS3621RPxs is in critical status')).toBe(true);
    expect(isAttentionKind('Storage Pool 1 has degraded (10/11)')).toBe(true);
    expect(isAttentionKind('Drive 9 is not on the Products Compatibility List')).toBe(false);
    expect(isAttentionKind('Volume 1 is running out of available capacity')).toBe(false);
  });

  test('the label keeps the shared words and shows the differing ones as #', () => {
    expect(kindLabel(['[NAS-ONE] Drive 9 on RS1 is not listed', '[NAS-ONE] Drive 12 on RS1 is not listed'])).toBe('Drive # on RS1 is not listed');
    expect(kindLabel(['[NAS-ONE] Volume 1 is full'])).toBe('Volume 1 is full');
  });
});

describe('groupHeldRows', () => {
  const drive = (id, n) => row(id, `[NAS-ONE] Drive ${n} on RS1 is not on the Products Compatibility List`);
  const rows = [
    drive(1, 9), drive(2, 10), drive(3, 11), drive(4, 12),
    row(5, '[NAS-ONE] Storage Pool 1 on NAS-ONE has crashed'),
    row(6, '[NAS-ONE] Volume 1 on NAS-ONE is running out of available capacity'),
    row(7, 'Re: printer', { fromEmail: OTHER, reason: 'unknown_reference' }),
  ];
  const tickets = [
    { id: 70, displayRef: 'TP-70', subject: '[NAS-ONE] Drive 3 on RS1 is not on the Products Compatibility List', status: 'Closed', createdAt: '2026-10-23T15:59:00Z', requesterEmail: 'NAS-ONE@x.io' },
  ];

  test('one group per busy sender, the crash first, the new kind before the known one; other mail stays single', () => {
    const { groups, singles } = groupHeldRows(rows, { tickets });
    expect(groups).toHaveLength(1);
    const [g] = groups;
    expect(g).toMatchObject({ sender: NAS, device: 'NAS-ONE', count: 6, attention: true, newKinds: 2 });
    expect(g.kinds.map((k) => k.label)).toEqual([
      'Storage Pool 1 on NAS-ONE has crashed',
      'Volume 1 on NAS-ONE is running out of available capacity',
      'Drive # on RS1 is not on the Products Compatibility List',
    ]);
    expect(g.kinds[0]).toMatchObject({ attention: true, newKind: true, ticket: null, count: 1 });
    expect(g.kinds[2]).toMatchObject({ count: 4, newKind: false, ticket: { id: 70, displayRef: 'TP-70', status: 'Closed' } });
    expect(g.suggestedTicket).toMatchObject({ id: 70 });
    expect(singles.map((r) => r.id)).toEqual([7]);
  });

  test('a sender with fewer than three held mails is not a group', () => {
    const { groups, singles } = groupHeldRows(rows.slice(0, 2));
    expect(groups).toEqual([]);
    expect(singles).toHaveLength(2);
  });
});

describe('kindTicketFor (what a repeat may be counted on)', () => {
  const t = (id, subject, status) => ({ id, subject, status, createdAt: `2026-10-23T1${id % 10}:00:00Z` });
  test('the newest ticket of the same kind', () => {
    const tickets = [t(1, '[NAS] Drive 9 on RS1 is not listed', 'Closed'), t(2, '[NAS] Drive 12 on RS1 is not listed', 'Open'), t(3, '[NAS] Volume 1 is full', 'Open')];
    expect(kindTicketFor({ kindKey: alertKindKey('[NAS] Drive 4 on RS1 is not listed'), tickets })?.id).toBe(2);
  });
  test('no ticket of that kind → nothing (a new kind stays in front of a person)', () => {
    expect(kindTicketFor({ kindKey: alertKindKey('[NAS] Storage Pool 1 has crashed'), tickets: [t(1, '[NAS] Volume 1 is full', 'Open')] })).toBeNull();
  });
  test('a broken-sounding kind never lands on a closed ticket', () => {
    const tickets = [t(1, '[NAS] Storage Pool 1 has crashed', 'Closed')];
    const kindKey = alertKindKey('[NAS] Storage Pool 1 has crashed');
    expect(kindTicketFor({ kindKey, attention: true, tickets })).toBeNull();
    expect(kindTicketFor({ kindKey, attention: true, tickets: [{ ...tickets[0], status: 'Open' }] })?.id).toBe(1);
  });
});

// 11 Nov 2026 (mail triage, part 1).
describe('a long number is part of the kind', () => {
  test('two invoices from one vendor are two kinds; drive numbers still are not', () => {
    const a = alertKindKey('Invoice from Acme Rentals_XVC4250_16520151_US_CAD_186076352_1695121008_0_462009816071');
    const b = alertKindKey('Invoice from Acme Rentals_XVC4250_16520151_US_CAD_186145539_1692847322_0_462009826568');
    expect(a).not.toBe(b);
    expect(alertKindKey('Reminder: 70 Days Outstanding Invoice - 4053829 - Northwind')).toBe(alertKindKey('Reminder: 71 Days Outstanding Invoice - 4053829 - Northwind'));
    expect(alertKindKey('[NAS] Drive 9 on RS1221 is not listed')).toBe(alertKindKey('[NAS] Drive 12 on RS1221 is not listed'));
  });

  test('the fold never offers the ticket of a different invoice; the same invoice still folds', () => {
    const ticket = { id: 120165, subject: 'Invoice from Acme Rentals_186145539_462009826568', status: 'Open', createdAt: '2026-11-10T18:00:00Z' };
    expect(kindTicketFor({ kindKey: alertKindKey('Invoice from Acme Rentals_186076352_462009816071'), tickets: [ticket] })).toBeNull();
    expect(kindTicketFor({ kindKey: alertKindKey('RE: Invoice from Acme Rentals_186145539_462009826568'), tickets: [ticket] })?.id).toBe(120165);
  });
});

describe('who sent a group: a person or an automated sender', () => {
  const held = (id, over = {}) => ({ id, subject: 'RE: Reminder ' + id, fromEmail: 'alex.rivera@example.com', fromName: 'Alex Rivera', reason: 'agent_reply_no_requester', receivedAt: '2026-11-10T18:0' + (id % 10) + ':00Z', bestGuessTicket: null, ...over });

  test('senderKindFor', () => {
    expect(senderKindFor({ sender: 'alex.rivera@example.com', reasons: ['agent_reply_no_requester'] })).toBe('person');
    expect(senderKindFor({ sender: 'nas-one@x.io', reasons: ['sender_burst', 'sender_burst'] })).toBe('automated');
    expect(senderKindFor({ sender: 'noreply@vendor.example.net', reasons: ['unknown_reference'] })).toBe('automated');
    expect(senderKindFor({ sender: 'jo.park@client.example.org', reasons: ['unknown_reference'] })).toBe('person');
    // A colleague whose mail was burst-held is still a person when the caller knows them.
    expect(senderKindFor({ sender: 'alex.rivera@example.com', reasons: ['sender_burst'], knownPerson: true })).toBe('person');
  });

  test('groupHeldRows marks each group', () => {
    const rows = [held(1), held(2), held(3), ...[4, 5, 6].map((id) => held(id, { fromEmail: 'nas-one@x.io', fromName: null, reason: 'sender_burst', subject: '[NAS-ONE] Drive ' + id + ' is not listed' }))];
    const { groups } = groupHeldRows(rows);
    expect(groups.find((g) => g.sender === 'alex.rivera@example.com')).toMatchObject({ senderKind: 'person', fromName: 'Alex Rivera', count: 3 });
    expect(groups.find((g) => g.sender === 'nas-one@x.io')).toMatchObject({ senderKind: 'automated', count: 3 });
    const known = groupHeldRows(rows, { people: ['NAS-ONE@x.io'] }).groups.find((g) => g.sender === 'nas-one@x.io');
    expect(known.senderKind).toBe('person');
  });
});

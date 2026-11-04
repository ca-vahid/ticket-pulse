import { jest } from '@jest/globals';

// Ticket number before or after the subject (3 Nov 2026): Outlook groups a
// conversation by subject, so every mail on a ticket must share one.
const store = new Map();
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: {
    get: jest.fn(async (k) => store.get(k) ?? null),
    set: jest.fn(async (k, v) => { store.set(k, v); }),
  },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const svc = await import('../src/services/mailSubjectService.js');
const { replySubject } = await import('../src/services/approvalReplyMail.js');
const { replySubjectDefault, effectiveReplySubject } = await import('../src/services/ticketService.js');

const TICKET = { id: 9, origin: 'ticketpulse', nativeNumber: 11013, subject: 'Laptop broken', workspaceId: 1 };

beforeEach(() => { store.clear(); svc.clearMailSubjectCache(); });

describe('setting', () => {
  test('defaults to after, saves before per workspace, rejects junk', async () => {
    expect(await svc.refPositionFor(1)).toBe('after');
    await svc.setMailSubjectSettings(1, { refPosition: 'before' });
    expect(await svc.refPositionFor(1)).toBe('before');
    expect(await svc.refPositionFor(5)).toBe('after');
    expect(svc.normalizeMailSubjectSettings({ refPosition: 'middle' })).toEqual({ refPosition: 'after' });
  });
});

describe('after (unchanged)', () => {
  test('replies keep today\'s exact subjects', () => {
    expect(replySubjectDefault(TICKET)).toBe('Re: Laptop broken [TP-11013]');
    expect(effectiveReplySubject(TICKET, 'Quick update')).toBe('Quick update [TP-11013]');
    expect(effectiveReplySubject(TICKET, 'Update [TP-11013] done')).toBe('Update [TP-11013] done');
    expect(replySubject('RE: Laptop broken', 'TP-11013')).toBe('Re: Laptop broken [TP-11013]');
    expect(svc.ticketMailSubject('Laptop broken', 'TP-11013')).toBe('Laptop broken [TP-11013]');
  });
});

describe('before', () => {
  test('reply, approval and workflow subjects share one Outlook conversation', () => {
    const reply = replySubjectDefault(TICKET, 'before');
    const approval = replySubject('Laptop broken', 'TP-11013', 'before');
    const workflow = svc.ticketMailSubject('Laptop broken', 'TP-11013', 'before');
    expect(reply).toBe('Re: [TP-11013] Laptop broken');
    expect(approval).toBe('Re: [TP-11013] Laptop broken');
    expect(workflow).toBe('[TP-11013] Laptop broken');
    const topic = (s) => s.replace(/^((re|fw|fwd)\s*:\s*)+/i, '');
    expect(new Set([reply, approval, workflow, 'RE: [TP-11013] Laptop broken'].map(topic)).size).toBe(1);
  });

  test('an RE:/FW: or a number already in the ticket subject is not doubled', () => {
    expect(svc.ticketMailSubject('RE: FW: Laptop broken [TP-11013]', 'TP-11013', 'before')).toBe('[TP-11013] Laptop broken');
    expect(replySubject('RE: Laptop broken', 'TP-11013', 'before')).toBe('Re: [TP-11013] Laptop broken');
  });

  test("an agent's own subject gets the number after its RE:, and is kept when it has one", () => {
    expect(effectiveReplySubject(TICKET, 'Quick update', 'before')).toBe('[TP-11013] Quick update');
    expect(effectiveReplySubject(TICKET, 'RE: Quick update', 'before')).toBe('RE: [TP-11013] Quick update');
    expect(effectiveReplySubject(TICKET, 'Done [TP-11013]', 'before')).toBe('Done [TP-11013]');
    expect(effectiveReplySubject(TICKET, '  ', 'before')).toBe('Re: [TP-11013] Laptop broken');
  });

  test('an empty subject still carries the number', () => {
    expect(svc.ticketMailSubject('', 'TP-11013', 'before')).toBe('[TP-11013] Your ticket');
  });
});

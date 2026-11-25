import { describe, expect, test } from '@jest/globals';
import {
  GENERIC_TICKET_WORDS, OUTCOMES, SAME_SYMPTOM_WORDS, categoryNameWords, hasAccessSymptom, isServiceMailbox, machineCreatedReason, mergeNote, normalizeSettings, notAPersonSentence, senderNotAPerson, sharedContentWords, subjectTokens, priorityId, raisedPriority, routingSentence, sameProblem, subjectSimilarity, ticketRef,
} from '../src/services/assignmentFollowUp/rules.js';

describe('settings (followup_routing_ws<N>)', () => {
  test('off by default everywhere; Level match JSON or a bare mode string both work', () => {
    expect(normalizeSettings(null).mode).toBe('off');
    expect(normalizeSettings('rubbish').mode).toBe('off');
    expect(normalizeSettings('shadow').mode).toBe('shadow');
    expect(normalizeSettings('"live"').mode).toBe('live');
    expect(normalizeSettings('{"mode":"shadow","updatedBy":"Dana Fox"}')).toMatchObject({ mode: 'shadow', updatedBy: 'Dana Fox', persisted: true });
    expect(normalizeSettings({ mode: 'on' }).mode).toBe('off');
  });
});

describe('same problem', () => {
  const teams = { internalCategoryId: 10, internalSubcategoryId: 101 };
  // The Teams subcategory, under Collaboration: "Teams" is the product, not the problem.
  const TEAMS_WORDS = categoryNameWords('Collaboration', 'Teams');

  test('category / subcategory name words never count as shared', () => {
    expect(TEAMS_WORDS).toEqual(['collaboration', 'team']);
    // The licence pair shares only "Teams": not a repeat.
    expect(sameProblem({ ...teams, subject: 'Teams licence for a starter' }, { ...teams, subject: "Can't sign in to Teams" }, { categoryWords: TEAMS_WORDS }))
      .toBeNull();
    // Names unreadable (null): shared words do not count at all.
    expect(sameProblem({ ...teams, subject: 'Teams licence renewal' }, { ...teams, subject: 'Teams licence for a starter' }, { categoryWords: null }))
      .toBeNull();
    // A shared word that is not the product still counts.
    expect(sameProblem({ ...teams, subject: 'Teams licence renewal' }, { ...teams, subject: 'Teams licence for a starter' }, { categoryWords: TEAMS_WORDS }))
      .toMatchObject({ matchedOn: 'subcategory', sharedWords: ['licence'], symptom: false });
  });

  test('the production shape matches on the sign-in / access symptom', () => {
    expect(sameProblem({ ...teams, subject: 'Lost access to Teams again' }, { ...teams, subject: "Can't sign into Teams" }, { categoryWords: TEAMS_WORDS }))
      .toMatchObject({ matchedOn: 'subcategory', sharedWords: [], symptom: true });
    expect(sameProblem({ ...teams, subject: "Still can't sign in to Teams" }, { ...teams, subject: "Can't sign in to Teams" }, { categoryWords: TEAMS_WORDS }))
      .toEqual({ matchedOn: 'subcategory', similarity: 1, textSimilarity: null, sharedWords: ['sign'], symptom: true });
  });

  test('the same-symptom set', () => {
    for (const s of ['Sign in fails', 'sign-in loop', 'Signin broken', "Can't log in", 'Log into Teams', 'login page', 'logon error', 'Locked out', 'Password expired', 'No access to the share']) {
      expect(hasAccessSymptom(s)).toBe(true);
    }
    for (const s of ['Printer jam on floor 3', 'Need a new monitor', 'Teams licence for a starter', 'Signature block wrong', 'Accessory order']) {
      expect(hasAccessSymptom(s)).toBe(false);
    }
    expect(SAME_SYMPTOM_WORDS).toEqual(['sign in', 'sign-in', 'signin', 'log in', 'login', 'logon', 'locked out', 'password', 'access']);
  });

  test('same subcategory, two different problems with no shared content word: not a repeat', () => {
    const hw = { internalCategoryId: 20, internalSubcategoryId: 201 };
    expect(sameProblem({ ...hw, subject: 'Printer jam on floor 3' }, { ...hw, subject: 'Need a new monitor' }, { categoryWords: categoryNameWords('Hardware', 'Peripherals') }))
      .toBeNull();
    // Generic words alone never make two tickets the same problem.
    expect(sameProblem({ ...hw, subject: 'Not working, error again' }, { ...hw, subject: 'Broken, need help' })).toBeNull();
    // Close embedded text still can.
    expect(sameProblem({ ...hw, subject: 'Printer jam on floor 3' }, { ...hw, subject: 'Need a new monitor' }, { textSimilarity: 0.9 }))
      .toMatchObject({ matchedOn: 'subcategory', similarity: 0.9 });
  });

  test('the generic word list', () => {
    for (const w of ['cant', 'cannot', 'unable', 'help', 'issue', 'problem', 'request', 'again', 'please', 'urgent', 'not', 'working', 'access', 'lost', 'error', 'need']) {
      expect(GENERIC_TICKET_WORDS).toContain(w);
    }
    expect(subjectTokens("Can't access Outlook — errors again, please help")).toEqual(['outlook']);
    expect(sharedContentWords('Outlook not working', 'Lost access to Outlook')).toEqual(['outlook']);
    expect(sharedContentWords('Not working', 'Lost access')).toEqual([]);
  });

  test('category-only and no-category matches keep the 0.6 subject bar', () => {
    // "Teams licence for a starter" / "can't sign into Teams" share one word: 0.4, under the bar.
    expect(subjectSimilarity('Teams licence for a starter', "can't sign into Teams")).toBeCloseTo(0.4, 5);
    expect(sameProblem({ internalCategoryId: 10, subject: 'Teams licence for a starter' }, { ...teams, subject: "can't sign into Teams" })).toBeNull();
    expect(sameProblem({ subject: 'Teams licence for a starter' }, { subject: "can't sign into Teams" })).toBeNull();
  });

  test('same category counts only when one side has no subcategory (words close too)', () => {
    expect(sameProblem({ internalCategoryId: 10, internalSubcategoryId: null, subject: 'VPN not connecting' }, { ...teams, subject: 'VPN not connecting' }))
      .toMatchObject({ matchedOn: 'category' });
    expect(sameProblem({ internalCategoryId: 10, internalSubcategoryId: null, subject: 'New laptop' }, { ...teams, subject: 'Teams sign-in' })).toBeNull();
    expect(sameProblem({ internalCategoryId: 10, internalSubcategoryId: 102, subject: 'Teams sign-in' }, { ...teams, subject: 'Teams sign-in' }))
      .toMatchObject({ matchedOn: 'subject' });
  });

  test('a close subject matches when the categories do not', () => {
    const m = sameProblem({ subject: 'Outlook password reset not working' }, { subject: 'RE: Outlook password reset' });
    expect(m).toMatchObject({ matchedOn: 'subject' });
    expect(sameProblem({ subject: 'Printer jam on 3rd floor' }, { subject: 'VPN keeps dropping' })).toBeNull();
  });

  test('embedding similarity is the last resort', () => {
    expect(sameProblem({ subject: 'a' }, { subject: 'b' }, { textSimilarity: 0.9 })).toEqual({ matchedOn: 'text', similarity: 0.9, textSimilarity: 0.9, sharedWords: [], symptom: false });
    expect(sameProblem({ subject: 'a' }, { subject: 'b' }, { textSimilarity: 0.5 })).toBeNull();
  });

  test('subject similarity ignores filler words and casing', () => {
    expect(subjectSimilarity('Please help: VPN not connecting', 'vpn NOT connecting again')).toBe(1);
    expect(subjectSimilarity('', 'anything')).toBe(0);
  });
});

describe('machine-made tickets and service mailboxes', () => {
  test('workflow, API, trusted intake, alerts and Ticket Pulse automation are machines; mail intake and FS-born are people', () => {
    expect(machineCreatedReason({}, { performedBy: 'Notification workflow', details: { actorKind: 'workflow' } })).toBe('workflow');
    expect(machineCreatedReason({}, { performedBy: 'Integration', details: { actorKind: 'human', createdVia: 'api' } })).toBe('api');
    expect(machineCreatedReason({ triageMode: 'trusted' })).toBe('trusted_intake');
    expect(machineCreatedReason({ occurrenceCount: 2 })).toBe('alert');
    expect(machineCreatedReason({}, { performedBy: 'Ticket Pulse (Onboarding)', details: { actorKind: 'human' } })).toBe('automation');
    expect(machineCreatedReason({}, { performedBy: 'Ticket Pulse grouping', details: { actorKind: 'system', actorEmail: 'grouping@ticketpulse.internal' } })).toBe('automation');
    expect(machineCreatedReason({}, { performedBy: 'Ticket Pulse Mail', details: { actorKind: 'system', actorEmail: 'mailbox@ticketpulse.internal' } })).toBeNull();
    expect(machineCreatedReason({ requester: { email: 'dana.fox@example.com' } }, null)).toBeNull();
  });

  test('service mailboxes', () => {
    for (const e of ['no-reply@example.com', 'noreply@example.com', 'alerts@example.com', 'svc-backup@example.com', 'monitoring2@example.com']) {
      expect(isServiceMailbox(e)).toBe(true);
    }
    for (const e of ['dana.fox@example.com', 'eli.park@example.com', 'sam.okafor@example.com', '']) expect(isServiceMailbox(e)).toBe(false);
  });

  test('a prefixed no-reply is a service mailbox too (the Azure Monitor alert of 24 Nov)', () => {
    // The start-only pattern missed these: the raise went through.
    for (const e of ['azure-noreply@monitor.example.com', 'billing.noreply@vendor.example.com', 'portal-notifications@vendor.example.com']) {
      expect(isServiceMailbox(e)).toBe(true);
    }
    expect(machineCreatedReason({ requester: { email: 'azure-noreply@monitor.example.com' } }, null)).toBe('service_mailbox');
  });
});

describe('senderNotAPerson: only a person on staff reports again', () => {
  const DOMAINS = ['corp.example.com', '@corp2.example.com'];
  const t = (email, over = {}) => ({ subject: 'Files locked', occurrenceCount: 0, requester: { email, unattended: false }, ...over });

  test('a person on an internal domain (sub-domains too) is a person', () => {
    expect(senderNotAPerson(t('dana.fox@corp.example.com'), { internalDomains: DOMAINS })).toBeNull();
    expect(senderNotAPerson(t('Eli.Park@CORP2.example.com'), { internalDomains: DOMAINS })).toBeNull();
    expect(senderNotAPerson(t('dana.fox@eu.corp.example.com'), { internalDomains: DOMAINS })).toBeNull();
  });

  test('outside the internal domains: external_sender; no internal domains configured skips the test', () => {
    expect(senderNotAPerson(t('ar@billing-vendor.example.com'), { internalDomains: DOMAINS }))
      .toEqual({ reason: 'external_sender', why: 'outside_internal_domains', email: 'ar@billing-vendor.example.com' });
    expect(senderNotAPerson(t(null), { internalDomains: DOMAINS })).toMatchObject({ reason: 'external_sender', why: 'no_email' });
    expect(senderNotAPerson(t('ar@billing-vendor.example.com'), { internalDomains: [] })).toBeNull();
  });

  test('machine signals win, internal domain or not', () => {
    const opts = { internalDomains: DOMAINS };
    expect(senderNotAPerson(t('dana.fox@corp.example.com'), { ...opts, createdReason: 'api' })).toMatchObject({ reason: 'machine_sender', why: 'api' });
    expect(senderNotAPerson(t('backup-box@corp.example.com', { requester: { email: 'backup-box@corp.example.com', unattended: true } }), opts))
      .toMatchObject({ reason: 'machine_sender', why: 'unattended' });
    expect(senderNotAPerson(t('dana.fox@corp.example.com', { occurrenceCount: 2 }), opts)).toMatchObject({ why: 'alert' });
    expect(senderNotAPerson(t('azuremon@corp.example.com'), { ...opts, monitoringSender: true })).toMatchObject({ why: 'monitoring_alert' });
    expect(senderNotAPerson(t('ops@corp.example.com', { subject: 'Fired:Sev3 Azure Monitor Alert vm availability - vm-app-01 (x)' }), opts))
      .toMatchObject({ why: 'monitoring_alert' });
    expect(senderNotAPerson(t('ops@corp.example.com', { subject: 'Resolved: Sev2 something' }), opts)).toMatchObject({ why: 'monitoring_alert' });
    expect(senderNotAPerson(t('azure-noreply@monitor.example.com'), opts)).toMatchObject({ reason: 'machine_sender', why: 'service_mailbox' });
    expect(senderNotAPerson(t('scanner@corp.example.com'), { ...opts, machineSenderEntry: 'scanner@corp.example.com' }))
      .toMatchObject({ why: 'machine_sender_list' });
    // A person's subject that merely mentions an alert is still a person.
    expect(senderNotAPerson(t('dana.fox@corp.example.com', { subject: 'FW: Fired:Sev3 alert - is this mine?' }), opts)).toBeNull();
  });

  test('the run sentence', () => {
    expect(notAPersonSentence({ reason: 'machine_sender', email: 'azure-noreply@monitor.example.com' }))
      .toBe('Not raised: azure-noreply@monitor.example.com is a machine sender, not a person reporting again.');
    expect(notAPersonSentence({ reason: 'external_sender', email: 'ar@billing-vendor.example.com' }))
      .toBe("Not raised: ar@billing-vendor.example.com is outside the workspace's internal domains; only a person on staff reporting again raises the priority.");
  });
});

describe('priority raise', () => {
  test('one level up, Urgent at most, never down', () => {
    expect(raisedPriority('Low')).toBe('Medium');
    expect(raisedPriority('medium')).toBe('High');
    expect(raisedPriority('High')).toBe('Urgent');
    expect(raisedPriority('Urgent')).toBe('Urgent');
    expect(raisedPriority(null)).toBeNull();
    expect(priorityId('High')).toBe(3);
  });
});

describe('words', () => {
  test('refs and sentences', () => {
    expect(ticketRef({ id: 5, origin: 'ticketpulse', nativeNumber: 1042 })).toBe('TP-1042');
    expect(ticketRef({ id: 5, origin: 'freshservice', freshserviceTicketId: BigInt(123456) })).toBe('#123456');
    expect(routingSentence({ outcome: OUTCOMES.WOULD_ROUTE, ownerName: 'Eli Park', ref: 'TP-1042' }))
      .toBe('Would send to Eli Park: same problem as TP-1042 reported today.');
    expect(routingSentence({ outcome: OUTCOMES.ROUTED, ownerName: 'Eli Park', ref: 'TP-1042' }))
      .toBe('Sent to Eli Park: same problem as TP-1042 reported today.');
    expect(routingSentence({ outcome: OUTCOMES.OWNER_UNAVAILABLE, ownerName: 'Eli Park', ref: 'TP-1042', reason: 'away today' }))
      .toMatch(/not sent to Eli Park \(away today\)/);
    expect(mergeNote({ ref: 'TP-1042', subject: "can't sign into Teams", ownerName: 'Eli Park' }))
      .toMatch(/Consider merging this ticket into TP-1042\.$/);
  });
});

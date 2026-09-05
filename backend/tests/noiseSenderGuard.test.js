import { jest } from '@jest/globals';

/**
 * QA 09-04 — the human-sender guard on the noise RULE path.
 *
 * Rod Kostaschuk forwarded his own "Your archive mailbox is almost full" warning
 * to IT and the ticket was auto-closed without a person or the AI ever reading
 * it: the rule tests the SUBJECT only, so a colleague's forward is indistinguishable
 * from the machine's original notice. Every ticket that rule ever caught was the
 * forward, not the notice.
 *
 * Two defences, both covered here:
 *   (A) a matched rule may only auto-close when the sender looks automated;
 *   (B) a rule can additionally require the sender's ADDRESS to match.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  noiseRule: { count: jest.fn(), createMany: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
  ticket: { findFirst: jest.fn(), count: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: noiseRuleService, classifySender, NOISE_SUPPRESS_REASONS } = await import('../src/services/noiseRuleService.js');

const RULES = [
  { id: 1, name: 'Mailbox Full / Archive Warnings', pattern: '(?:mailbox is almost full|archive mailbox is almost full)', senderPattern: 'microsoftexchange[0-9a-f]{6,}@|^postmaster@', autoCloseFromPeople: false, category: 'monitoring', mode: 'noise', isEnabled: true, dedupWindowDays: null },
  { id: 2, name: 'Synology NAS Alerts', pattern: '^\\[(?:BGC-|bgc-)', senderPattern: null, autoCloseFromPeople: false, category: 'infrastructure', mode: 'noise', isEnabled: true, dedupWindowDays: null },
  // Real prod rule, unanchored — this is the shape that can swallow a forward.
  { id: 4, name: 'Training Enrollment Notifications', pattern: "(?:you've been enrolled|complete your assigned training)", senderPattern: null, autoCloseFromPeople: false, category: 'vendor', mode: 'noise', isEnabled: true, dedupWindowDays: null },
  { id: 3, name: 'Phishing simulation forwards', pattern: 'Your incident has been opened', senderPattern: null, autoCloseFromPeople: true, category: 'security', mode: 'noise', isEnabled: true, dedupWindowDays: null },
];

beforeEach(() => {
  jest.clearAllMocks();
  noiseRuleService.invalidateCache();
  prismaMock.noiseRule.findMany.mockResolvedValue(RULES);
  prismaMock.ticket.findFirst.mockResolvedValue(null); // requester files no ordinary tickets
});

describe('classifySender', () => {
  test('reads the forward/reply envelope, including other languages', () => {
    for (const subject of ['FW: Your archive mailbox is almost full.', 'Fw: x', 're: x', 'TR: x', 'AW: x', 'SV: x']) {
      expect(classifySender({ subject }).humanPrefix).toBe(true);
    }
    expect(classifySender({ subject: 'Your archive mailbox is almost full.' }).humanPrefix).toBe(false);
    // "Review the firewall" must not read as "RE:".
    expect(classifySender({ subject: 'Review the firewall rules' }).humanPrefix).toBe(false);
  });

  test('spots automation addresses and leaves real people alone', () => {
    for (const email of ['noreply@site24x7.com', 'no-reply@vendor.com', 'alerts@bgcengineering.ca', 'postmaster@bgcengineering.ca', 'microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@bgcengineering.ca', 'quarantine@messaging.microsoft.com']) {
      expect(classifySender({ email, requesterEmail: email }).machineAddress).toBe(true);
    }
    for (const email of ['rkostaschuk@bgcengineering.ca', 'sarah.newton@cambioearth.com']) {
      expect(classifySender({ requesterEmail: email }).machineAddress).toBe(false);
    }
  });
});

describe('(A) a rule may not auto-close a person\'s mail', () => {
  test("Rod's forward is NOT noise any more — the match is recorded as suppressed", async () => {
    const verdict = await noiseRuleService.evaluate(
      'FW: Your archive mailbox is almost full.', new Date(), 1,
      { requesterEmail: 'rkostaschuk@bgcengineering.ca', requesterId: 42 },
    );
    expect(verdict.isNoise).toBe(false);
    expect(verdict.ruleId).toBeNull();
    // The sender condition (B) stops this rule before the forward guard is needed —
    // either way the ticket survives, and the near miss is still recorded for the audit.
    expect(verdict.suppressedRule).toBe('Mailbox Full / Archive Warnings');
    expect(verdict.suppressReason).toBe(NOISE_SUPPRESS_REASONS.SENDER_MISMATCH);
  });

  test('a forward caught by an unanchored rule is held by the guard itself', async () => {
    // Anchored patterns (^\[BGC-) already miss a forward because of the "Fw: " prefix;
    // unanchored ones like this are exactly where the guard earns its keep.
    const verdict = await noiseRuleService.evaluate("Fw: You've been enrolled in Remedial Training", new Date(), 1, {
      requesterEmail: 'ghuerta@bgcengineering.ca', requesterId: 42,
    });
    expect(verdict.isNoise).toBe(false);
    expect(verdict.suppressedRule).toBe('Training Enrollment Notifications');
    expect(verdict.suppressReason).toBe(NOISE_SUPPRESS_REASONS.FORWARDED);
  });

  test('a requester who also files ordinary tickets is a person, even without a forward prefix', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 9 }); // they file real tickets
    const verdict = await noiseRuleService.evaluate('[BGC-VAN] volume degraded', new Date(), 1, {
      requesterEmail: 'someone@bgcengineering.ca', requesterId: 7,
    });
    expect(verdict.isNoise).toBe(false);
    expect(verdict.suppressReason).toBe(NOISE_SUPPRESS_REASONS.PERSON);
  });

  test('the machine alerts that make the detector worth having still close', async () => {
    const verdict = await noiseRuleService.evaluate('[BGC-VAN-LIDAR1] Volume degraded', new Date(), 1, {
      requesterEmail: 'bgc-van-lidar1@bgcengineering.ca', requesterId: 5,
    });
    expect(verdict.isNoise).toBe(true);
    expect(verdict.ruleId).toBe('Synology NAS Alerts');
    expect(verdict.suppressedRule).toBeNull();
  });

  test('a campaign rule may still swallow forwards when it opts in', async () => {
    const verdict = await noiseRuleService.evaluate('FW: Your incident has been opened', new Date(), 1, {
      requesterEmail: 'jhill@bgcengineering.ca', requesterId: 11,
    });
    expect(verdict.isNoise).toBe(true);
    expect(verdict.ruleId).toBe('Phishing simulation forwards');
  });

  test('an unavailable requester lookup holds the ticket instead of closing it', async () => {
    prismaMock.ticket.findFirst.mockRejectedValue(new Error('db down'));
    const verdict = await noiseRuleService.evaluate('[BGC-VAN] volume degraded', new Date(), 1, {
      requesterEmail: 'someone@bgcengineering.ca', requesterId: 7,
    });
    expect(verdict.isNoise).toBe(false);
    expect(verdict.suppressReason).toBe(NOISE_SUPPRESS_REASONS.PERSON);
  });
});

describe('(B) a rule can require the sender address too', () => {
  test('the mailbox rule fires for Exchange itself and for nobody else', async () => {
    const fromExchange = await noiseRuleService.evaluate(
      'Your archive mailbox is almost full.', new Date(), 1,
      { requesterEmail: 'microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@bgcengineering.ca', requesterId: 3 },
    );
    expect(fromExchange.isNoise).toBe(true);
    expect(fromExchange.ruleId).toBe('Mailbox Full / Archive Warnings');

    // Same words, sent by a person: the rule does not even match.
    const fromPerson = await noiseRuleService.evaluate(
      'Your archive mailbox is almost full.', new Date(), 1,
      { requesterEmail: 'rkostaschuk@bgcengineering.ca', requesterId: 42 },
    );
    expect(fromPerson.isNoise).toBe(false);
    expect(fromPerson.suppressReason).toBe(NOISE_SUPPRESS_REASONS.SENDER_MISMATCH);
  });

  test('an invalid sender pattern disables that condition instead of throwing', async () => {
    prismaMock.noiseRule.findMany.mockResolvedValue([
      { ...RULES[0], senderPattern: '([unclosed', name: 'Broken sender rule' },
    ]);
    noiseRuleService.invalidateCache();
    const verdict = await noiseRuleService.evaluate('Your archive mailbox is almost full.', new Date(), 1, {
      requesterEmail: 'noreply@exchange.local', requesterId: 1,
    });
    expect(verdict.isNoise).toBe(true);
  });
});

describe('rule editing accepts the new fields', () => {
  test('createRule rejects an invalid sender pattern', async () => {
    await expect(noiseRuleService.createRule({ name: 'x', pattern: 'ok', senderPattern: '([bad', workspaceId: 1 }))
      .rejects.toThrow(/Invalid sender pattern/);
  });
});

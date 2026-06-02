import { guardNotificationEmailPayload } from '../src/services/notificationWorkflowOutputGuard.js';

const claudeTicketContext = {
  ticket: {
    subject: 'Claude account access problem',
    descriptionText: 'Claude AI Desktop Version will not open after login.',
    category: 'Software',
    subCategory: 'AI Tools',
    priorityLabel: 'Medium',
  },
  threadSummary: {
    entries: [
      {
        evidenceId: 'thread:1',
        content: 'The requester says Claude is showing an account error.',
      },
    ],
  },
  outageSignals: {
    allowedPublicPhrases: [],
  },
};

describe('notification workflow output guard', () => {
  test('allows Claude product names when they appear in ticket evidence', () => {
    const result = guardNotificationEmailPayload({
      subject: 'Claude account update',
      html: '<p>We are reviewing the Claude AI Desktop Version account issue.</p>',
      text: 'We are reviewing the Claude AI Desktop Version account issue.',
    }, {
      contextBundle: claudeTicketContext,
    });

    expect(result.accepted).toBe(true);
  });

  test.each([
    ['OpenAI provider'],
    ['Claude model'],
    ['GPT fallback'],
    ['Anthropic provider'],
    ['audit id'],
    ['TP-NWF-900'],
  ])('blocks unsupported internal wording: %s', (phrase) => {
    expect(() => guardNotificationEmailPayload({
      subject: 'Ticket update',
      html: `<p>${phrase} was used while drafting this email.</p>`,
      text: `${phrase} was used while drafting this email.`,
    }, {
      contextBundle: {
        ticket: {
          subject: 'VPN access problem',
          descriptionText: 'Requester cannot connect to VPN.',
          category: 'Access',
          priorityLabel: 'High',
        },
      },
    })).toThrow();
  });

  test('rejects unsupported timing claims unless deterministic evidence is present', () => {
    expect(() => guardNotificationEmailPayload({
      subject: 'Ticket update',
      html: '<p>We typically resolve this within 1 business day.</p>',
      text: 'We typically resolve this within 1 business day.',
    }, {
      contextBundle: {
        ticket: {
          subject: 'Laptop failure',
          category: 'Hardware',
          priorityLabel: 'High',
        },
      },
    })).toThrow(/response-time|resolution-time/);

    expect(guardNotificationEmailPayload({
      subject: 'Ticket update',
      html: '<p>We typically resolve this within 1 business day.</p>',
      text: 'We typically resolve this within 1 business day.',
    }, {
      contextBundle: {
        ticket: {
          subject: 'Laptop failure',
          category: 'Hardware',
          priorityLabel: 'High',
        },
        timingEvidence: {
          supported: true,
          metric: 'category_p75_resolution',
          sampleSize: 44,
        },
      },
    }).accepted).toBe(true);
  });

  test('rejects emoji and playful metaphors for sensitive requester contexts', () => {
    const contextBundle = {
      ticket: {
        subject: 'Executive VPN access failure',
        category: 'Identity and Access',
        priorityLabel: 'Urgent',
      },
    };

    expect(() => guardNotificationEmailPayload({
      subject: 'VPN update',
      html: '<p>We are on it. &#128640;</p>',
      text: 'We are on it. \u{1F680}',
    }, { contextBundle })).toThrow(/emoji/);

    expect(() => guardNotificationEmailPayload({
      subject: 'VPN update',
      html: '<p>We will get this back on rock solid ground.</p>',
      text: 'We will get this back on rock solid ground.',
    }, { contextBundle })).toThrow(/playful metaphors/);
  });

  test('custom prompt relaxation can allow tone while timing claims still need evidence', () => {
    const contextBundle = {
      ticket: {
        subject: 'Executive VPN access failure',
        category: 'Identity and Access',
        priorityLabel: 'Urgent',
      },
    };

    expect(guardNotificationEmailPayload({
      subject: 'VPN update',
      html: '<p>We will get this back on rock solid ground. &#128640;</p>',
      text: 'We will get this back on rock solid ground. \u{1F680}',
    }, {
      contextBundle,
      allowEmoji: true,
      allowPlayfulTone: true,
    }).accepted).toBe(true);

    expect(() => guardNotificationEmailPayload({
      subject: 'VPN update',
      html: '<p>We should have this resolved within 30 minutes. &#128640;</p>',
      text: 'We should have this resolved within 30 minutes. \u{1F680}',
    }, {
      contextBundle,
      allowEmoji: true,
      allowPlayfulTone: true,
    })).toThrow(/response-time|resolution-time/);
  });

  test('repairs enabled copy guardrails and tags the issue details', () => {
    const result = guardNotificationEmailPayload({
      subject: 'VPN update within 30 minutes',
      html: '<p>We received your VPN request.</p><p>We should have this resolved within 30 minutes.</p>',
      text: 'We received your VPN request. We should have this resolved within 30 minutes.',
    }, {
      repairGuardrails: ['unsupported_timing_claims'],
    });

    expect(result.accepted).toBe(true);
    expect(result.payload.subject).toBe('VPN update');
    expect(result.payload.text).not.toMatch(/within 30 minutes/i);
    expect(result.repairedIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'unsupported_timing_claims',
        action: 'repaired',
      }),
    ]));
  });

  test('disabled guardrails are skipped and audited', () => {
    const result = guardNotificationEmailPayload({
      subject: 'VPN update within 30 minutes',
      html: '<p>We should have this resolved within 30 minutes.</p>',
      text: 'We should have this resolved within 30 minutes.',
    }, {
      disabledGuardrails: ['unsupported_timing_claims'],
    });

    expect(result.accepted).toBe(true);
    expect(result.payload.text).toMatch(/within 30 minutes/i);
    expect(result.skippedChecks).toEqual(expect.arrayContaining(['unsupported_timing_claims']));
  });
});

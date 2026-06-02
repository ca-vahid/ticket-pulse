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
});

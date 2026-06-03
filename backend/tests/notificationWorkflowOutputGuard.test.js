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

  test('repairs sentence claims without flattening unrelated html structure', () => {
    const result = guardNotificationEmailPayload({
      subject: 'VPN update',
      html: '<div class="body"><p>We received your VPN request.</p><p>We should have this resolved within 30 minutes.</p><p><strong>Thanks,</strong><br>IT Support</p></div>',
      text: 'We received your VPN request. We should have this resolved within 30 minutes. Thanks, IT Support',
    }, {
      repairGuardrails: ['unsupported_timing_claims'],
    });

    expect(result.accepted).toBe(true);
    expect(result.payload.html).toContain('<div class="body">');
    expect(result.payload.html).toContain('<p>We received your VPN request.</p>');
    expect(result.payload.html).toContain('<p><strong>Thanks,</strong><br>IT Support</p>');
    expect(result.payload.html).not.toMatch(/within 30 minutes/i);
  });

  test('repairs subject-only claims without rewriting unchanged html', () => {
    const html = '<div class="body"><p><strong>Hi,</strong></p><p>We received your request.</p></div>';
    const result = guardNotificationEmailPayload({
      subject: 'VPN update within 30 minutes',
      html,
      text: 'Hi,\n\nWe received your request.',
    }, {
      repairGuardrails: ['unsupported_timing_claims'],
    });

    expect(result.accepted).toBe(true);
    expect(result.payload.subject).toBe('VPN update');
    expect(result.payload.html).toBe(html);
  });

  test('strips unknown cited signals from metadata without rewriting email formatting', () => {
    const html = '<div class="body"><p><strong>Hi Dulaney,</strong></p><p>We are reviewing your phone request.</p></div>';
    const text = 'Hi Dulaney,\n\nWe are reviewing your phone request.';
    const result = guardNotificationEmailPayload({
      subject: 'Ticket #225336 assigned',
      html,
      text,
      citedSignals: [
        'notification_context',
        '2a725d1bce5e4eddadec9d8d898a82c6e9e7f2a3741661900444be7d38c535b6',
        'similar-ticket:27913',
      ],
    }, {
      strictCitations: true,
      extraEvidenceIds: ['similar-ticket:27913'],
    });

    expect(result.accepted).toBe(true);
    expect(result.payload.html).toBe(html);
    expect(result.payload.text).toBe(text);
    expect(result.citedSignals).toEqual(['notification_context', 'similar-ticket:27913']);
    expect(result.payload.citedSignals).toEqual(['notification_context', 'similar-ticket:27913']);
    expect(result.repairedIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'unknown_cited_evidence_ids',
        action: 'repaired',
        removed: ['2a725d1bce5e4eddadec9d8d898a82c6e9e7f2a3741661900444be7d38c535b6'],
      }),
    ]));
  });

  test('blocks unknown cited signals when the id leaks into requester-facing copy', () => {
    expect(() => guardNotificationEmailPayload({
      subject: 'Ticket update',
      html: '<p>Evidence 2a725d1bce5e4eddadec9d8d898a82c6e9e7f2a3741661900444be7d38c535b6 confirms this.</p>',
      text: 'Evidence 2a725d1bce5e4eddadec9d8d898a82c6e9e7f2a3741661900444be7d38c535b6 confirms this.',
      citedSignals: ['2a725d1bce5e4eddadec9d8d898a82c6e9e7f2a3741661900444be7d38c535b6'],
    }, {
      strictCitations: true,
    })).toThrow(/unknown evidence id/i);
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

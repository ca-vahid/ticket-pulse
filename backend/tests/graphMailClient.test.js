import { jest } from '@jest/globals';

/**
 * MB-1b — sendMailAsMailbox threading + Reply-To against a mocked Graph client.
 *
 * Graph refuses non-`x-` names in internetMessageHeaders, so In-Reply-To /
 * References must come from Exchange itself via createReply on the message
 * being answered (resolved from the caller's RFC Message-ID). These tests pin
 * the request shapes: createReply → PATCH (our subject/body/recipients/
 * replyTo) → attachments → send; plain draft when no anchor resolves.
 */

const calls = [];
let messageLookup = {}; // internetMessageId -> graph id
let failCreateReply = false;

function fakeRequest(path) {
  const query = {};
  const req = {
    filter: (v) => { query.filter = v; return req; },
    select: (v) => { query.select = v; return req; },
    top: (v) => { query.top = v; return req; },
    orderby: (v) => { query.orderby = v; return req; },
    get: async () => {
      calls.push({ method: 'GET', path, query });
      if (/\/messages$/.test(path) && query.filter) {
        const m = query.filter.match(/^internetMessageId eq '(.*)'$/);
        const wanted = m ? m[1].replace(/''/g, "'") : null;
        const id = wanted ? messageLookup[wanted] : null;
        return { value: id ? [{ id }] : [] };
      }
      return { value: [] };
    },
    post: async (body) => {
      calls.push({ method: 'POST', path, body });
      if (/\/createReply$/.test(path)) {
        if (failCreateReply) throw new Error('ErrorItemNotFound');
        return { id: 'reply-draft-1', internetMessageId: '<reply-1@mailbox.example>', conversationId: 'conv-1', subject: 'RE: original' };
      }
      if (/\/messages$/.test(path)) {
        return { id: 'draft-1', internetMessageId: '<draft-1@mailbox.example>', conversationId: 'conv-2' };
      }
      return {};
    },
    patch: async (body) => {
      calls.push({ method: 'PATCH', path, body });
      return { id: 'reply-draft-1', internetMessageId: '<reply-1@mailbox.example>', conversationId: 'conv-1', subject: body.subject };
    },
  };
  return req;
}

const fakeClient = { api: (path) => fakeRequest(path) };

jest.unstable_mockModule('@azure/identity', () => ({ ClientSecretCredential: class {} }));
jest.unstable_mockModule('@microsoft/microsoft-graph-client', () => ({
  Client: { initWithMiddleware: () => fakeClient },
}));
jest.unstable_mockModule('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js', () => ({
  TokenCredentialAuthenticationProvider: class {},
}));
jest.unstable_mockModule('../src/config/index.js', () => ({
  default: { graph: { tenantId: 'tenant', clientId: 'client', clientSecret: 'secret' } },
}));
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { default: graphMailClient } = await import('../src/integrations/graphMailClient.js');

const MAILBOX = 'patickets@bgcengineering.ca';
const baseSend = {
  to: ['rita@example.com'],
  cc: ['boss@example.com'],
  subject: 'Re: Invoice question [TP-1042]',
  html: '<p>Hello</p>',
  fromName: 'Susan Xu',
  replyTo: 'patickets+tp1042@bgcengineering.ca',
};

const flatten = (v) => JSON.stringify(v).toLowerCase();

beforeEach(() => {
  calls.length = 0;
  messageLookup = {};
  failCreateReply = false;
  jest.clearAllMocks();
});

describe('sendMailAsMailbox threading (MB-1b)', () => {
  test('anchor found → createReply on the referenced message, PATCH our content, send the reply draft', async () => {
    messageLookup['<inbound-77@requester.example>'] = 'graph-msg-77';

    const result = await graphMailClient.sendMailAsMailbox(MAILBOX, {
      ...baseSend,
      inReplyTo: '<inbound-77@requester.example>',
      references: ['<our-first@mailbox.example>', '<inbound-77@requester.example>'],
    });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /users/${MAILBOX}/messages`,
      `POST /users/${MAILBOX}/messages/graph-msg-77/createReply`,
      `PATCH /users/${MAILBOX}/messages/reply-draft-1`,
      `POST /users/${MAILBOX}/messages/reply-draft-1/send`,
    ]);
    expect(calls[0].query).toEqual({ filter: "internetMessageId eq '<inbound-77@requester.example>'", select: 'id', top: 1 });

    const patch = calls[2].body;
    expect(patch).toEqual({
      subject: 'Re: Invoice question [TP-1042]',
      body: { contentType: 'HTML', content: '<p>Hello</p>' },
      toRecipients: [{ emailAddress: { address: 'rita@example.com' } }],
      ccRecipients: [{ emailAddress: { address: 'boss@example.com' } }],
      from: { emailAddress: { address: MAILBOX, name: 'Susan Xu' } },
      replyTo: [{ emailAddress: { address: 'patickets+tp1042@bgcengineering.ca' } }],
    });
    // Never smuggle standard headers through internetMessageHeaders (Graph rejects non x- names).
    for (const c of calls) {
      expect(c.body?.internetMessageHeaders).toBeUndefined();
      expect(flatten(c.body || {})).not.toContain('in-reply-to');
    }
    expect(result).toEqual({
      messageId: 'reply-draft-1',
      internetMessageId: '<reply-1@mailbox.example>',
      conversationId: 'conv-1',
      threadedVia: 'createReply',
    });
  });

  test('no anchor resolves → plain draft (existing behaviour) with Reply-To; threadedVia null', async () => {
    const result = await graphMailClient.sendMailAsMailbox(MAILBOX, {
      ...baseSend, inReplyTo: '<never-seen@elsewhere.example>', references: [],
    });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /users/${MAILBOX}/messages`,
      `POST /users/${MAILBOX}/messages`,
      `POST /users/${MAILBOX}/messages/draft-1/send`,
    ]);
    expect(calls[1].body.replyTo).toEqual([{ emailAddress: { address: 'patickets+tp1042@bgcengineering.ca' } }]);
    expect(calls[1].body.from).toEqual({ emailAddress: { address: MAILBOX, name: 'Susan Xu' } });
    expect(result).toEqual({
      messageId: 'draft-1', internetMessageId: '<draft-1@mailbox.example>', conversationId: 'conv-2', threadedVia: null,
    });
  });

  test('no threading inputs at all → exactly the pre-MB-1b request shape (no replyTo key, no lookup)', async () => {
    await graphMailClient.sendMailAsMailbox(MAILBOX, {
      to: 'rita@example.com', subject: 'FW: Ticket [TP-1042]', html: '<p>fw</p>',
    });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /users/${MAILBOX}/messages`,
      `POST /users/${MAILBOX}/messages/draft-1/send`,
    ]);
    expect(calls[0].body).toEqual({
      subject: 'FW: Ticket [TP-1042]',
      body: { contentType: 'HTML', content: '<p>fw</p>' },
      toRecipients: [{ emailAddress: { address: 'rita@example.com' } }],
      ccRecipients: [],
    });
    expect(calls[0].body).not.toHaveProperty('replyTo');
    expect(calls[0].body).not.toHaveProperty('from');
  });

  test('anchor order: In-Reply-To first, then References newest-first, bounded to 3 lookups', async () => {
    messageLookup['<r2@x>'] = 'graph-r2';

    await graphMailClient.sendMailAsMailbox(MAILBOX, {
      ...baseSend,
      inReplyTo: null,
      references: ['<r0@x>', '<r1@x>', '<r2@x>', '<r3-missing@x>'],
    });

    const lookups = calls.filter((c) => c.method === 'GET').map((c) => c.query.filter);
    expect(lookups).toEqual([
      "internetMessageId eq '<r3-missing@x>'",
      "internetMessageId eq '<r2@x>'",
    ]);
    expect(calls.some((c) => c.path.endsWith('/graph-r2/createReply'))).toBe(true);

    calls.length = 0;
    messageLookup = {};
    await graphMailClient.sendMailAsMailbox(MAILBOX, {
      ...baseSend, inReplyTo: '<a@x>', references: ['<b@x>', '<c@x>', '<d@x>', '<e@x>'],
    });
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(3);
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.query.filter)).toEqual([
      "internetMessageId eq '<a@x>'", "internetMessageId eq '<e@x>'", "internetMessageId eq '<d@x>'",
    ]);
  });

  test("odata literal escaping: a Message-ID containing ' is doubled in the filter", async () => {
    messageLookup["<it's@x>"] = 'graph-q';
    await graphMailClient.sendMailAsMailbox(MAILBOX, { ...baseSend, inReplyTo: "<it's@x>" });
    expect(calls[0].query.filter).toBe("internetMessageId eq '<it''s@x>'");
    expect(calls[1].path).toBe(`/users/${MAILBOX}/messages/graph-q/createReply`);
  });

  test('createReply failure degrades to a plain draft instead of failing the send', async () => {
    messageLookup['<gone@x>'] = 'graph-gone';
    failCreateReply = true;

    const result = await graphMailClient.sendMailAsMailbox(MAILBOX, { ...baseSend, inReplyTo: '<gone@x>' });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /users/${MAILBOX}/messages`,
      `POST /users/${MAILBOX}/messages/graph-gone/createReply`,
      `POST /users/${MAILBOX}/messages`,
      `POST /users/${MAILBOX}/messages/draft-1/send`,
    ]);
    expect(result.threadedVia).toBeNull();
    expect(result.internetMessageId).toBe('<draft-1@mailbox.example>');
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  test('attachments attach to the reply draft, before send', async () => {
    messageLookup['<in@x>'] = 'graph-in';
    await graphMailClient.sendMailAsMailbox(MAILBOX, {
      ...baseSend,
      inReplyTo: '<in@x>',
      attachments: [
        { name: 'a.pdf', contentType: 'application/pdf', contentBytes: 'QUJD' },
        { name: 'skipped-no-bytes.txt' },
      ],
    });
    const seq = calls.map((c) => `${c.method} ${c.path}`);
    expect(seq).toEqual([
      `GET /users/${MAILBOX}/messages`,
      `POST /users/${MAILBOX}/messages/graph-in/createReply`,
      `PATCH /users/${MAILBOX}/messages/reply-draft-1`,
      `POST /users/${MAILBOX}/messages/reply-draft-1/attachments`,
      `POST /users/${MAILBOX}/messages/reply-draft-1/send`,
    ]);
    expect(calls[3].body).toEqual({
      '@odata.type': '#microsoft.graph.fileAttachment', name: 'a.pdf', contentType: 'application/pdf', contentBytes: 'QUJD',
    });
  });

  test('a recipient is still required', async () => {
    await expect(graphMailClient.sendMailAsMailbox(MAILBOX, { to: [], subject: 's', html: 'h' }))
      .rejects.toThrow('Email recipient is required');
    expect(calls).toHaveLength(0);
  });
});

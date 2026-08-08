import { jest } from '@jest/globals';
import FreshServiceClient, { getFreshServiceDetail, getFreshServiceStatus } from '../src/integrations/freshservice.js';
import { ExternalAPIError } from '../src/utils/errors.js';

describe('FreshServiceClient.closeTicket', () => {
  test('hydrates closure payload with inferred department before first close attempt', async () => {
    const client = new FreshServiceClient('example.freshservice.com', 'api-key');
    client.getTicket = jest.fn().mockResolvedValue({
      id: 220089,
      subject: '[BGC-TOR-LIDAR1] Volume 2 on BGC-TOR-LIDAR1 is running out of available capacity',
      source: 1,
      priority: 2,
      group_id: 1000205455,
      category: null,
      description: '<div>Existing ticket body</div>',
      custom_fields: { security: null },
    });
    client.listDepartments = jest.fn().mockResolvedValue([
      { id: 1000151664, name: 'Non-BGC Email' },
      { id: 1000131297, name: 'Toronto' },
    ]);
    client._put = jest.fn().mockResolvedValue({ data: { ticket: { id: 220089, status: 4 } } });

    await client.closeTicket(220089, 4);

    expect(client._put).toHaveBeenCalledTimes(1);
    expect(client._put).toHaveBeenCalledWith('/tickets/220089', {
      ticket: expect.objectContaining({
        status: 4,
        department_id: 1000131297,
        description: '<div>Existing ticket body</div>',
        resolution_notes: 'This automated notification did not require helpdesk follow-up.',
      }),
    });
  });

  test('hydrates closure payload with fallback description when Freshservice ticket body is blank', async () => {
    const client = new FreshServiceClient('example.freshservice.com', 'api-key');
    client.getTicket = jest.fn().mockResolvedValue({
      id: 220208,
      subject: 'Microsoft 365 security: You have messages in quarantine',
      source: 1,
      priority: 2,
      group_id: 1000205455,
      category: 'Security',
      description: null,
      description_text: '',
      custom_fields: {},
    });
    client.listDepartments = jest.fn().mockResolvedValue([
      { id: 1000151664, name: 'Non-BGC Email' },
    ]);
    client._put = jest.fn().mockResolvedValue({ data: { ticket: { id: 220208, status: 4 } } });

    await client.closeTicket(220208, 4);

    expect(client._put).toHaveBeenCalledTimes(1);
    expect(client._put).toHaveBeenCalledWith('/tickets/220208', {
      ticket: expect.objectContaining({
        status: 4,
        category: 'Security',
        department_id: 1000151664,
        description: 'Automated notification ticket: Microsoft 365 security: You have messages in quarantine',
      }),
    });
  });
});

describe('FreshServiceClient custom object records', () => {
  test('updates custom object records with data payload', async () => {
    const client = new FreshServiceClient('example.freshservice.com', 'api-key');
    client._put = jest.fn().mockResolvedValue({
      data: {
        record: {
          data: {
            name: 'MFA',
            parent_skill: { id: 10, value: 'Identity' },
          },
        },
      },
    });

    const result = await client.updateCustomObjectRecord(1000000539, 101, {
      name: 'MFA',
      parent_skill: 10,
    });

    expect(client._put).toHaveBeenCalledWith('/objects/1000000539/records/101', {
      data: {
        name: 'MFA',
        parent_skill: 10,
      },
    });
    expect(result.data.parent_skill.value).toBe('Identity');
  });
});

// QA 08-05 #6 regression: the response interceptor replaces axios errors with
// an ExternalAPIError (raw axios error only under .originalError), so catch
// blocks reading `error.response?.data` always saw undefined — killing the
// department retry AND all field-level error surfacing. These tests run the
// REAL interceptor rejection handler to produce the exact wrapped shape, then
// verify every write-path catch preserves the FS detail through re-wrapping.
describe('FreshServiceClient FS error detail propagation (interceptor-wrapped errors)', () => {
  const validationDetail = {
    description: 'Validation failed',
    errors: [{ field: 'department_id', code: 'missing_field' }],
  };

  function makeAxiosError(detail = validationDetail, status = 400) {
    const err = new Error(`Request failed with status code ${status}`);
    err.response = { status, data: detail, headers: {} };
    err.config = { url: '/tickets/236253' };
    return err;
  }

  // Feed a fake axios rejection through the client's real response
  // interceptor so the tests exercise the actual wrapping code, not a
  // hand-rolled imitation of it.
  function interceptorWrap(client, axiosError) {
    const handler = client.client.interceptors.response.handlers
      .find((h) => typeof h?.rejected === 'function');
    expect(handler).toBeDefined();
    try {
      handler.rejected(axiosError);
    } catch (wrapped) {
      return wrapped;
    }
    throw new Error('interceptor rejection handler did not throw');
  }

  test('interceptor wraps axios errors into ExternalAPIError: no .response, detail under stamps + .originalError', () => {
    const client = new FreshServiceClient('example.freshservice.com', 'api-key');
    const wrapped = interceptorWrap(client, makeAxiosError());

    expect(wrapped).toBeInstanceOf(ExternalAPIError);
    expect(wrapped.response).toBeUndefined(); // the shape the old broken catches read
    expect(wrapped.freshserviceStatus).toBe(400);
    expect(wrapped.freshserviceDetail).toEqual(validationDetail);
    expect(wrapped.originalError.response.data).toEqual(validationDetail);
    expect(getFreshServiceDetail(wrapped)).toEqual(validationDetail);
    expect(getFreshServiceStatus(wrapped)).toBe(400); // NOT the wrapper's own 502
  });

  test('updateTicketFields re-wraps interceptor errors without losing field-level detail (dead-branch regression)', async () => {
    const client = new FreshServiceClient('example.freshservice.com', 'api-key');
    client._put = jest.fn().mockRejectedValue(interceptorWrap(client, makeAxiosError()));

    let thrown;
    try {
      await client.updateTicketFields(236253, { status: 5 });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    expect(thrown.freshserviceStatus).toBe(400);
    expect(thrown.freshserviceDetail?.errors?.[0]?.field).toBe('department_id');
    // FS's own description wins — no "FreshService API error: " double prefix.
    expect(thrown.message).toBe('Validation failed');
  });

  test('detail survives when it lives ONLY under .originalError (no interceptor stamps)', async () => {
    const client = new FreshServiceClient('example.freshservice.com', 'api-key');
    const bare = new ExternalAPIError('FreshService', 'Validation failed', makeAxiosError());
    client._put = jest.fn().mockRejectedValue(bare);

    let thrown;
    try {
      await client.updateTicket(236253, { status: 5 });
    } catch (e) {
      thrown = e;
    }

    expect(thrown.freshserviceDetail?.errors?.[0]?.field).toBe('department_id');
    expect(thrown.freshserviceStatus).toBe(400); // originalError's 400, not AppError's 502
  });

  test('every ticket write path preserves interceptor-wrapped detail and status', async () => {
    const client = new FreshServiceClient('example.freshservice.com', 'api-key');
    const wrapped = interceptorWrap(client, makeAxiosError());
    client._put = jest.fn().mockRejectedValue(wrapped);
    client._post = jest.fn().mockRejectedValue(wrapped);

    const writePaths = [
      ['assignTicket', () => client.assignTicket(1, 2)],
      ['updateTicketFields', () => client.updateTicketFields(1, { status: 4 })],
      ['updateTicketCustomFields', () => client.updateTicketCustomFields(1, { a: 'b' })],
      ['updateTicketGroup', () => client.updateTicketGroup(1, 3)],
      ['updateTicketPriority', () => client.updateTicketPriority(1, 2)],
      ['updateTicketType', () => client.updateTicketType(1, 'Incident')],
      ['updateTicket', () => client.updateTicket(1, { status: 4 })],
      ['createReply', () => client.createReply(1, '<p>hi</p>')],
    ];
    for (const [name, call] of writePaths) {
      let thrown;
      try {
        await call();
      } catch (e) {
        thrown = e;
      }
      expect(`${name}:${thrown?.freshserviceDetail?.errors?.[0]?.field}`).toBe(`${name}:department_id`);
      expect(`${name}:${thrown?.freshserviceStatus}`).toBe(`${name}:400`);
    }
  });

  test('createTicket appends field-level errors to the wrapped message', async () => {
    const client = new FreshServiceClient('example.freshservice.com', 'api-key');
    client._post = jest.fn().mockRejectedValue(interceptorWrap(client, makeAxiosError()));

    let thrown;
    try {
      await client.createTicket({ subject: 'x', email: 'r@example.com' });
    } catch (e) {
      thrown = e;
    }

    expect(thrown.message).toBe('Validation failed (department_id: missing_field)');
    expect(thrown.freshserviceDetail).toEqual(validationDetail);
    expect(thrown.freshserviceStatus).toBe(400);
  });
});

// FR 08-07 #8/#9 — note-edit write-back + FS notification suppression.
describe('FreshServiceClient.updateConversation', () => {
  test('PUTs the new body to /conversations/:id', async () => {
    const client = new FreshServiceClient('example.freshservice.com', 'api-key');
    client._put = jest.fn().mockResolvedValue({ data: { conversation: { id: 555 } } });

    const result = await client.updateConversation(555, { body: '<p>edited</p>' });

    expect(client._put).toHaveBeenCalledWith('/conversations/555', { body: '<p>edited</p>' });
    expect(result.conversation.id).toBe(555);
  });

  test('tolerates 404/405 (entry gone or immutable) like deleteConversation', async () => {
    const client = new FreshServiceClient('example.freshservice.com', 'api-key');
    const gone = new Error('Request failed with status code 404');
    gone.response = { status: 404, data: null };
    client._put = jest.fn().mockRejectedValue(gone);

    const result = await client.updateConversation(555, { body: '<p>edited</p>' });

    expect(result).toEqual({ id: 555, skipped: true, reason: 'conversation_gone_or_immutable' });
  });

  test('other failures throw with the FS status/detail preserved', async () => {
    const client = new FreshServiceClient('example.freshservice.com', 'api-key');
    const denied = new Error('Request failed with status code 403');
    denied.response = { status: 403, data: { description: 'Access denied' } };
    client._put = jest.fn().mockRejectedValue(denied);

    await expect(client.updateConversation(555, { body: '<p>x</p>' }))
      .rejects.toMatchObject({ freshserviceStatus: 403, message: 'Access denied' });
  });
});

describe('FreshService note payloads suppress FS notifications (notify_emails: [])', () => {
  test('addPrivateNote sends notify_emails: []', async () => {
    const client = new FreshServiceClient('example.freshservice.com', 'api-key');
    client._post = jest.fn().mockResolvedValue({ data: { conversation: { id: 1 } } });

    await client.addPrivateNote(9, '<p>note</p>');

    expect(client._post).toHaveBeenCalledWith('/tickets/9/notes', {
      body: '<p>note</p>',
      private: true,
      notify_emails: [],
    });
  });

  test('addNote (JSON branch) sends notify_emails: []', async () => {
    const client = new FreshServiceClient('example.freshservice.com', 'api-key');
    client._post = jest.fn().mockResolvedValue({ data: { conversation: { id: 2 } } });

    await client.addNote(9, '<p>note</p>', { isPrivate: true });

    expect(client._post).toHaveBeenCalledWith('/tickets/9/notes', {
      body: '<p>note</p>',
      private: true,
      notify_emails: [],
    });
  });

  test('addNote (multipart branch) still posts a form when attachments ride along', async () => {
    const client = new FreshServiceClient('example.freshservice.com', 'api-key');
    client._post = jest.fn().mockResolvedValue({ data: { conversation: { id: 3 } } });

    await client.addNote(9, '<p>note</p>', {
      isPrivate: true,
      attachments: [{ filename: 'a.txt', buffer: Buffer.from('hi'), contentType: 'text/plain' }],
    });

    const [url, form] = client._post.mock.calls[0];
    expect(url).toBe('/tickets/9/notes');
    // FormData cannot express an EMPTY array — nothing is appended for
    // notify_emails there; suppression for attachment notes relies on the
    // FS-side marker exclusion rule (docs/FRESHSERVICE_WEBHOOK_SETUP.md).
    expect(typeof form.getHeaders).toBe('function');
  });
});

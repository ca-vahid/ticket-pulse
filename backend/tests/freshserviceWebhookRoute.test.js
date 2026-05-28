import { jest } from '@jest/globals';

jest.unstable_mockModule('../src/services/freshServiceWebhookIngestService.js', () => ({
  default: { handleTicketWebhook: jest.fn() },
  WebhookIngestError: class WebhookIngestError extends Error {},
}));

jest.unstable_mockModule('../src/services/workspaceWebhookService.js', () => ({
  default: {
    headerName: 'X-Ticket-Pulse-Webhook-Secret',
  },
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { normalizeFreshServiceWebhookTicketId } = await import('../src/routes/freshserviceWebhook.routes.js');

describe('freshserviceWebhook.routes', () => {
  test('normalizes ticket IDs from supported FreshService payload shapes', () => {
    expect(normalizeFreshServiceWebhookTicketId({ ticket_id: 224183 })).toBe('224183');
    expect(normalizeFreshServiceWebhookTicketId({ ticket: { id: '224184' } })).toBe('224184');
    expect(normalizeFreshServiceWebhookTicketId({ data: { ticket: { id: 224185 } } })).toBe('224185');
    expect(normalizeFreshServiceWebhookTicketId({ payload: { ticketId: '224186' } })).toBe('224186');
  });

  test('rejects non-numeric payload candidates', () => {
    expect(normalizeFreshServiceWebhookTicketId({ ticket_id: 'abc-123' })).toBeNull();
    expect(normalizeFreshServiceWebhookTicketId({ ticket: { id: '' } })).toBeNull();
  });
});

import { jest } from '@jest/globals';
import FreshServiceClient from '../src/integrations/freshservice.js';

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

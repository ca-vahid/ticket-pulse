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
        resolution_notes: 'This automated notification did not require helpdesk follow-up.',
      }),
    });
  });
});

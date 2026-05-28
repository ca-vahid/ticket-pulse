import { jest } from '@jest/globals';

const prismaMock = {
  assignmentConfig: {
    findUnique: jest.fn(),
  },
  assignmentPipelineRun: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  technician: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
  },
  workspace: {
    findUnique: jest.fn(),
  },
  ticket: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  ticketAssignmentEpisode: {
    findFirst: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

const settingsRepositoryMock = {
  getFreshServiceConfigForWorkspace: jest.fn(),
  getServiceAccountNames: jest.fn(),
};

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: settingsRepositoryMock,
}));

jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: jest.fn(),
}));

jest.unstable_mockModule('../src/services/assignmentFlowGuards.js', () => ({
  shouldCloseNoiseDismissedRun: jest.fn(() => true),
}));

const notificationPreferenceServiceMock = {
  queueNotificationsForAssignment: jest.fn().mockResolvedValue({ queued: 1 }),
};

jest.unstable_mockModule('../src/services/notificationPreferenceService.js', () => ({
  default: notificationPreferenceServiceMock,
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { default: freshServiceActionService } = await import('../src/services/freshServiceActionService.js');
const freshserviceModule = await import('../src/integrations/freshservice.js');

const ticket = (overrides = {}) => ({
  freshserviceTicketId: 222018,
  subject: 'Vendor payment confirmation',
  ticketCategory: 'Accounting',
  tpSkill: null,
  tpSubskill: null,
  internalCategory: { name: 'Invoice Processing and Accounts Payable' },
  internalSubcategory: { name: 'Vendor Payment Confirmation and EFT Processing' },
  ...overrides,
});

const run = (overrides = {}) => ({
  id: 2174,
  workspaceId: 2,
  decision: 'approved',
  assignedTechId: 901,
  ticket: ticket(),
  recommendation: {
    agentBriefingHtml: '<p>Please review the vendor payment.</p>',
    recommendations: [],
  },
  ...overrides,
});

describe('freshServiceActionService workspace-scoped category writeback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.technician.findUnique.mockResolvedValue({
      freshserviceId: 1001082570,
      name: 'Zoe Dio',
    });
    prismaMock.workspace.findUnique.mockResolvedValue({
      tpSkillCustomField: 'lf_ticket_pulse_category',
      tpSubskillCustomField: 'lf_ticket_pulse_subcategory',
    });
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({ autoCloseNoise: true });
    prismaMock.assignmentPipelineRun.update.mockResolvedValue({});
    prismaMock.ticket.update.mockResolvedValue({});
    prismaMock.technician.findFirst.mockResolvedValue(null);
    prismaMock.ticketAssignmentEpisode.findFirst.mockResolvedValue(null);
    settingsRepositoryMock.getServiceAccountNames.mockResolvedValue(['Ticket Pulse']);
    settingsRepositoryMock.getFreshServiceConfigForWorkspace.mockResolvedValue({
      domain: 'example.freshservice.com',
      apiKey: 'test-key',
    });
  });

  test('does not write Ticket Pulse category fields for non-IT approvals', async () => {
    const result = await freshServiceActionService.buildAction(run());

    expect(result.error).toBeNull();
    expect(result.actions.map((action) => action.type)).toEqual(['assign', 'note']);
    expect(result.actions).not.toContainEqual(expect.objectContaining({ type: 'update_custom_fields' }));
    expect(prismaMock.workspace.findUnique).not.toHaveBeenCalled();
  });

  test('keeps canonical category writeback for the IT skill hierarchy workspace', async () => {
    const result = await freshServiceActionService.buildAction(run({
      workspaceId: 1,
      ticket: ticket({
        internalCategory: { name: 'Software & Apps' },
        internalSubcategory: { name: 'Power Platform / Power Apps' },
      }),
    }));

    expect(result.error).toBeNull();
    expect(result.actions.map((action) => action.type)).toEqual(['update_custom_fields', 'assign', 'note']);
    expect(result.actions[0]).toEqual(expect.objectContaining({
      type: 'update_custom_fields',
      customFields: {
        lf_ticket_pulse_category: 'Software & Apps',
        lf_ticket_pulse_subcategory: 'Power Platform / Power Apps',
      },
    }));
  });

  test('does not write IT noise category fields for non-IT dismissed runs', async () => {
    const result = await freshServiceActionService.buildAction(run({
      decision: 'noise_dismissed',
      assignedTechId: null,
      recommendation: {
        closureNoticeHtml: '<p>No action needed.</p>',
        recommendations: [],
      },
    }));

    expect(result.error).toBeNull();
    expect(result.actions.map((action) => action.type)).toEqual(['note', 'close']);
    expect(result.actions).not.toContainEqual(expect.objectContaining({ type: 'update_custom_fields' }));
    expect(prismaMock.workspace.findUnique).not.toHaveBeenCalled();
  });

  test('skips closing noise-dismissed tickets when workspace auto-close is disabled', async () => {
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({ autoCloseNoise: false });
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(run({
      decision: 'noise_dismissed',
      assignedTechId: null,
      recommendation: {
        closureNoticeHtml: '<p>No action needed.</p>',
        recommendations: [],
      },
    }));

    const result = await freshServiceActionService.execute(2174, 2, false);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      reason: 'noise_auto_close_disabled',
    }));
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenCalledWith({
      where: { id: 2174 },
      data: expect.objectContaining({
        syncStatus: 'skipped',
        syncError: 'Noise auto-close disabled for workspace',
      }),
    });
    expect(freshserviceModule.createFreshServiceClient).not.toHaveBeenCalled();
  });

  test('continues closing noise-dismissed tickets when optional category writeback fails', async () => {
    const customFieldError = new Error('FreshService API error: Validation failed');
    customFieldError.freshserviceStatus = 400;
    customFieldError.freshserviceDetail = {
      description: 'Validation failed',
      errors: [{ field: 'lf_ticket_pulse_category', code: 'datatype_mismatch' }],
    };
    const client = {
      listCustomObjects: jest.fn().mockResolvedValue([]),
      updateTicketCustomFields: jest.fn().mockRejectedValue(customFieldError),
      addPrivateNote: jest.fn().mockResolvedValue({ id: 88 }),
      closeTicket: jest.fn().mockResolvedValue({ id: 224242, status: 4 }),
    };
    freshserviceModule.createFreshServiceClient.mockReturnValue(client);
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(run({
      id: 3301,
      ticketId: 501,
      workspaceId: 1,
      decision: 'noise_dismissed',
      assignedTechId: null,
      ticket: ticket({
        id: 501,
        freshserviceTicketId: 224242,
        firstAssignedAt: null,
        internalCategory: { name: 'Service Desk & Routing' },
        internalSubcategory: { name: 'Non-actionable Notifications' },
      }),
      recommendation: {
        closureNoticeHtml: '<p>No action needed.</p>',
        recommendations: [],
      },
    }));

    const result = await freshServiceActionService.execute(3301, 1, false);

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(client.updateTicketCustomFields).toHaveBeenCalled();
    expect(client.addPrivateNote).toHaveBeenCalledWith(
      224242,
      expect.stringContaining('Ticket closed without assignment'),
    );
    expect(client.closeTicket).toHaveBeenCalledWith(224242, 4);
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenLastCalledWith({
      where: { id: 3301 },
      data: expect.objectContaining({
        syncStatus: 'synced',
        syncError: expect.stringContaining('Optional Ticket Pulse category write failed'),
        syncPayload: expect.objectContaining({
          optionalActionFailures: [
            expect.objectContaining({
              type: 'update_custom_fields',
              ticketId: 224242,
              error: 'FreshService API error: Validation failed',
              freshserviceError: expect.objectContaining({ status: 400 }),
            }),
          ],
        }),
      }),
    });
  });
});

describe('freshServiceActionService priority writeback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.assignmentPipelineRun.update.mockResolvedValue({});
    prismaMock.ticket.update.mockResolvedValue({});
    settingsRepositoryMock.getFreshServiceConfigForWorkspace.mockResolvedValue({
      domain: 'example.freshservice.com',
      apiKey: 'test-key',
    });
  });

  const priorityRun = (overrides = {}) => ({
    id: 3101,
    ticketId: 501,
    workspaceId: 1,
    ticket: {
      id: 501,
      freshserviceTicketId: 222999,
      assessedPriority: 'Urgent',
      assessedPriorityId: 4,
      priorityRationale: 'Active outage affecting a project team.',
    },
    ...overrides,
  });

  test('builds native priority writeback actions with preview text', async () => {
    const result = await freshServiceActionService.buildPriorityWritebackAction(priorityRun());

    expect(result.error).toBeNull();
    expect(result.preview).toBe('Update ticket #222999 priority to Urgent');
    expect(result.actions).toEqual([expect.objectContaining({
      type: 'update_priority',
      ticketId: 222999,
      priorityId: 4,
      priorityLabel: 'Urgent',
    })]);
  });

  test('stores intended priority update in dry-run payload without calling FreshService', async () => {
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(priorityRun());

    const result = await freshServiceActionService.executePriorityWriteback(3101, 1, true);

    expect(result).toEqual(expect.objectContaining({ success: true, dryRun: true }));
    expect(freshserviceModule.createFreshServiceClient).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenCalledWith({
      where: { id: 3101 },
      data: expect.objectContaining({
        priorityWritebackStatus: 'dry_run',
        priorityWritebackError: null,
        priorityWritebackPayload: expect.objectContaining({
          dryRun: true,
          preview: 'Update ticket #222999 priority to Urgent',
        }),
      }),
    });
  });

  test('mirrors successful priority writeback back to the local ticket', async () => {
    const client = {
      updateTicketPriority: jest.fn().mockResolvedValue({ id: 222999, priority: 4 }),
    };
    freshserviceModule.createFreshServiceClient.mockReturnValue(client);
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(priorityRun());

    const result = await freshServiceActionService.executePriorityWriteback(3101, 1, false);

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(client.updateTicketPriority).toHaveBeenCalledWith(222999, 4);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({
      where: { id: 501 },
      data: expect.objectContaining({ priority: 4 }),
    });
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenCalledWith({
      where: { id: 3101 },
      data: expect.objectContaining({
        priorityWritebackStatus: 'synced',
        priorityWritebackError: null,
        priorityWrittenAt: expect.any(Date),
      }),
    });
  });

  test('records priority writeback failure without throwing into assignment sync flow', async () => {
    const client = {
      updateTicketPriority: jest.fn().mockRejectedValue(new Error('FreshService priority rejected')),
    };
    freshserviceModule.createFreshServiceClient.mockReturnValue(client);
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(priorityRun());

    const result = await freshServiceActionService.executePriorityWriteback(3101, 1, false);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: 'FreshService priority rejected',
    }));
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenCalledWith({
      where: { id: 3101 },
      data: expect.objectContaining({
        priorityWritebackStatus: 'failed',
        priorityWritebackError: 'FreshService priority rejected',
      }),
    });
  });

  test('skips priority writeback when FreshService marks a ticket read-only', async () => {
    const readOnlyError = new Error('PUT method is not allowed. It should be one of these method(s): GET');
    readOnlyError.response = {
      status: 405,
      data: { message: 'PUT method is not allowed. It should be one of these method(s): GET' },
    };
    const client = {
      updateTicketPriority: jest.fn().mockRejectedValue(readOnlyError),
    };
    freshserviceModule.createFreshServiceClient.mockReturnValue(client);
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(priorityRun());

    const result = await freshServiceActionService.executePriorityWriteback(3101, 1, false);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
    }));
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenCalledWith({
      where: { id: 3101 },
      data: expect.objectContaining({
        priorityWritebackStatus: 'skipped',
        priorityWritebackError: expect.stringContaining('read-only'),
      }),
    });
  });

  test('does not queue agent notifications for pending-review priority-only writeback', async () => {
    const client = {
      updateTicketPriority: jest.fn().mockResolvedValue({ id: 222999, priority: 4 }),
    };
    freshserviceModule.createFreshServiceClient.mockReturnValue(client);
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(priorityRun({
      decision: 'pending_review',
    }));

    const result = await freshServiceActionService.executePriorityWriteback(3101, 1, false);

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(notificationPreferenceServiceMock.queueNotificationsForAssignment).not.toHaveBeenCalled();
  });
});

describe('freshServiceActionService assignment notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.assignmentPipelineRun.update.mockResolvedValue({});
    prismaMock.ticket.update.mockResolvedValue({});
    prismaMock.technician.findUnique.mockResolvedValue({
      freshserviceId: 1001082570,
      name: 'Zoe Dio',
      email: 'zoe.dio@example.com',
    });
    prismaMock.technician.findFirst.mockResolvedValue(null);
    prismaMock.ticketAssignmentEpisode.findFirst.mockResolvedValue(null);
    settingsRepositoryMock.getServiceAccountNames.mockResolvedValue(['Ticket Pulse']);
    settingsRepositoryMock.getFreshServiceConfigForWorkspace.mockResolvedValue({
      domain: 'example.freshservice.com',
      apiKey: 'test-key',
    });
  });

  test('queues notifications only after a successful FreshService assignment sync', async () => {
    const client = {
      getTicket: jest.fn().mockResolvedValue({ responder_id: null, group_id: null }),
      assignTicket: jest.fn().mockResolvedValue({ id: 222999 }),
      addPrivateNote: jest.fn().mockResolvedValue({ id: 11 }),
    };
    freshserviceModule.createFreshServiceClient.mockReturnValue(client);
    const assignmentRun = run({
      id: 3201,
      ticketId: 501,
      workspaceId: 1,
      decision: 'auto_assigned',
      assignedTechId: 901,
      ticket: {
        id: 501,
        freshserviceTicketId: 222999,
        firstAssignedAt: null,
        subject: 'VPN down for project team',
        ticketCategory: 'IT',
        tpSkill: 'Network',
        tpSubskill: 'VPN',
        assessedPriority: 'High',
        assessedPriorityId: 3,
        priorityRationale: 'Project team cannot connect to VPN.',
        internalCategory: { name: 'Network' },
        internalSubcategory: { name: 'VPN' },
      },
      recommendation: {
        agentBriefingHtml: '<p>VPN access appears blocked for the project team.</p>',
        recommendations: [{ techId: 901, techName: 'Zoe Dio' }],
      },
    });
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(assignmentRun);
    prismaMock.workspace.findUnique.mockResolvedValue({
      tpSkillCustomField: 'lf_ticket_pulse_category',
      tpSubskillCustomField: 'lf_ticket_pulse_subcategory',
    });
    client.listCustomObjects = jest.fn().mockResolvedValue([]);
    client.updateTicketCustomFields = jest.fn().mockResolvedValue({});

    const result = await freshServiceActionService.execute(3201, 1, false, { force: true });

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(client.assignTicket).toHaveBeenCalledWith(222999, 1001082570);
    expect(notificationPreferenceServiceMock.queueNotificationsForAssignment).toHaveBeenCalledWith(
      assignmentRun,
      expect.objectContaining({
        type: 'assign',
        techId: 901,
        techEmail: 'zoe.dio@example.com',
      }),
    );
  });

  test('treats manually assigned FreshService tickets as handled and still writes category fields', async () => {
    const client = {
      getTicket: jest.fn().mockResolvedValue({ responder_id: 100200300, group_id: null }),
      updateTicketCustomFields: jest.fn().mockResolvedValue({ id: 222999 }),
      listCustomObjects: jest.fn().mockResolvedValue([]),
      assignTicket: jest.fn(),
      addPrivateNote: jest.fn(),
    };
    freshserviceModule.createFreshServiceClient.mockReturnValue(client);
    prismaMock.technician.findFirst.mockResolvedValue({ name: 'Andrew Fong' });
    prismaMock.workspace.findUnique.mockResolvedValue({
      tpSkillCustomField: 'lf_ticket_pulse_category',
      tpSubskillCustomField: 'lf_ticket_pulse_subcategory',
    });
    const assignmentRun = run({
      id: 3202,
      ticketId: 501,
      workspaceId: 1,
      decision: 'auto_assigned',
      assignedTechId: 901,
      ticket: {
        id: 501,
        freshserviceTicketId: 222999,
        firstAssignedAt: null,
        subject: 'BST update issue',
        ticketCategory: 'BST',
        tpSkill: null,
        tpSubskill: null,
        internalCategory: { name: 'Software & Apps' },
        internalSubcategory: { name: 'BST' },
      },
      recommendation: {
        agentBriefingHtml: '<p>BST update issue.</p>',
        recommendations: [{ techId: 901, techName: 'Zoe Dio' }],
      },
    });
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(assignmentRun);

    const result = await freshServiceActionService.execute(3202, 1, false);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      handledInFreshService: true,
    }));
    expect(client.updateTicketCustomFields).toHaveBeenCalledWith(222999, {
      lf_ticket_pulse_category: 'Software & Apps',
      lf_ticket_pulse_subcategory: 'BST',
    });
    expect(client.assignTicket).not.toHaveBeenCalled();
    expect(client.addPrivateNote).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenCalledWith({
      where: { id: 3202 },
      data: expect.objectContaining({
        decision: 'pending_review',
        syncStatus: 'skipped',
        syncError: expect.stringContaining('Handled in FreshService'),
        errorMessage: expect.stringContaining('Handled in FreshService'),
      }),
    });
  });
});

describe('freshServiceActionService group preflight remediation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.technician.findFirst.mockResolvedValue(null);
    prismaMock.ticketAssignmentEpisode.findFirst.mockResolvedValue(null);
  });

  test('moves narrowed groups to Everyone IT before assignment when the target is compatible there', async () => {
    const client = {
      getTicket: jest.fn().mockResolvedValue({ group_id: 1000009787 }),
      getGroup: jest.fn().mockResolvedValue({
        id: 1000009787,
        name: 'Advanced Troubleshooting team',
        members: [1001031584],
      }),
      listGroups: jest.fn().mockResolvedValue([
        { id: 1000205455, name: 'Everyone IT', members: [1000765712] },
      ]),
    };

    const result = await freshServiceActionService._preflightCheck(
      client,
      { id: 2368, ticket: { id: 24796 } },
      { ticketId: 222186, agentId: 1000765712 },
      { workspaceId: '2' },
    );

    expect(result).toEqual({
      code: 'incompatible_group',
      reason: 'Target agent is not a member of group "Advanced Troubleshooting team"',
      details: { groupId: 1000009787, groupName: 'Advanced Troubleshooting team' },
      remediation: {
        type: 'update_group',
        ticketId: 222186,
        groupId: 1000205455,
        groupName: 'Everyone IT',
        previousGroupId: 1000009787,
        previousGroupName: 'Advanced Troubleshooting team',
      },
    });
  });

  test('keeps prior rejection as a hard stop before group remediation', async () => {
    prismaMock.ticketAssignmentEpisode.findFirst.mockResolvedValue({
      endedAt: new Date('2026-05-12T17:36:01.000Z'),
      technician: { name: 'Reza Zaim' },
    });
    const client = {
      getTicket: jest.fn().mockResolvedValue({ group_id: 1000009787 }),
      getGroup: jest.fn(),
      listGroups: jest.fn(),
    };

    const result = await freshServiceActionService._preflightCheck(
      client,
      { id: 2368, ticket: { id: 24796 } },
      { ticketId: 222186, agentId: 1000765712 },
      { workspaceId: '2' },
    );

    expect(result.code).toBe('already_rejected_by_this_agent');
    expect(client.getGroup).not.toHaveBeenCalled();
    expect(client.listGroups).not.toHaveBeenCalled();
  });
});

import { jest } from '@jest/globals';

// Pin the FS-taxonomy-sync set for this suite: only ws1 mirrors categories to
// FreshService, so ws2 exercises the "no write-back" path. Without this the
// suite inherits whatever backend/.env sets (e.g. 1,2) once src/config's
// dotenv runs — flag resolution is lazy since the Phase PA flag split.
process.env.FS_TAXONOMY_SYNC_WORKSPACE_IDS = '1';

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
  // Per-workspace type registry (ticket-types plan).
  ticketTypeDefinition: {
    findMany: jest.fn(),
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
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({ priorityWritebackEnabled: true });
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

  test('marks priority writeback skipped when disabled for the workspace', async () => {
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({ priorityWritebackEnabled: false });
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(priorityRun());

    const result = await freshServiceActionService.executePriorityWriteback(3101, 1, false);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      error: 'priority_writeback_disabled',
    }));
    expect(freshserviceModule.createFreshServiceClient).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenCalledWith({
      where: { id: 3101 },
      data: expect.objectContaining({
        priorityWritebackStatus: 'skipped',
        priorityWritebackError: 'priority_writeback_disabled',
        priorityWritebackPayload: expect.objectContaining({
          skippedReason: 'priority_writeback_disabled',
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

describe('freshServiceActionService ticket type writeback', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    prismaMock.assignmentPipelineRun.update.mockResolvedValue({});
    prismaMock.ticket.update.mockResolvedValue({});
    // Write-back is gated per workspace (Settings → AI & Routing).
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({ typeWritebackEnabled: true });
    prismaMock.ticketTypeDefinition.findMany.mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Incident', aliases: ['incident'], isActive: true, aiAssignable: true, fsTypeValue: 'Incident', sortOrder: 0 },
      { id: 2, workspaceId: 1, name: 'Service Request', aliases: ['sr'], isActive: true, aiAssignable: true, fsTypeValue: 'Service Request', sortOrder: 1 },
    ]);
    const { invalidateTicketTypeCache } = await import('../src/services/ticketTypeService.js');
    invalidateTicketTypeCache();
    settingsRepositoryMock.getFreshServiceConfigForWorkspace.mockResolvedValue({
      domain: 'example.freshservice.com',
      apiKey: 'test-key',
    });
  });

  const ticketTypeRun = (overrides = {}) => ({
    id: 4101,
    ticketId: 601,
    workspaceId: 1,
    recommendation: { ticketType: 'Incident' },
    ticket: {
      id: 601,
      freshserviceTicketId: 228773,
      ticketType: 'Service Request',
      assessedTicketType: 'Incident',
      ticketTypeRationale: 'The request describes a broken service.',
    },
    ...overrides,
  });

  test('builds native ticket type writeback actions with preview text', async () => {
    const result = await freshServiceActionService.buildTicketTypeWritebackAction(ticketTypeRun());

    expect(result.error).toBeNull();
    expect(result.preview).toBe('Update ticket #228773 type to Incident');
    expect(result.actions).toEqual([expect.objectContaining({
      type: 'update_ticket_type',
      ticketId: 228773,
      ticketType: 'Incident',
    })]);
  });

  test('mirrors successful ticket type writeback back to the local ticket', async () => {
    const client = {
      updateTicketType: jest.fn().mockResolvedValue({ id: 228773, type: 'Incident' }),
    };
    freshserviceModule.createFreshServiceClient.mockReturnValue(client);
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(ticketTypeRun());

    const result = await freshServiceActionService.executeTicketTypeWriteback(4101, 1, false);

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(client.updateTicketType).toHaveBeenCalledWith(228773, 'Incident');
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({
      where: { id: 601 },
      data: expect.objectContaining({ ticketType: 'Incident' }),
    });
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenCalledWith({
      where: { id: 4101 },
      data: expect.objectContaining({
        ticketTypeWritebackStatus: 'synced',
        ticketTypeWritebackError: null,
        ticketTypeWrittenAt: expect.any(Date),
      }),
    });
  });

  test('skips ticket type writeback when the workspace setting is off', async () => {
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({ typeWritebackEnabled: false });
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(ticketTypeRun({ workspaceId: 2 }));

    const result = await freshServiceActionService.executeTicketTypeWriteback(4101, 2, false);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      skipped: true,
      error: 'ticket_type_writeback_not_enabled_for_workspace',
    }));
    expect(freshserviceModule.createFreshServiceClient).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenCalledWith({
      where: { id: 4101 },
      data: expect.objectContaining({
        ticketTypeWritebackStatus: 'skipped',
        ticketTypeWritebackError: 'ticket_type_writeback_not_enabled_for_workspace',
      }),
    });
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

describe('freshServiceActionService category writeback (auto-categorize)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.assignmentPipelineRun.update.mockResolvedValue({});
    prismaMock.ticket.update.mockResolvedValue({});
    prismaMock.workspace.findUnique.mockResolvedValue({
      tpSkillCustomField: 'lf_ticket_pulse_category',
      tpSubskillCustomField: 'lf_ticket_pulse_subcategory',
    });
    settingsRepositoryMock.getFreshServiceConfigForWorkspace.mockResolvedValue({
      domain: 'example.freshservice.com',
      apiKey: 'test-key',
      workspaceId: 4,
      tpSkillCustomField: 'lf_ticket_pulse_category',
      tpSubskillCustomField: 'lf_ticket_pulse_subcategory',
    });
  });

  const categoryRun = (ticketOverrides = {}) => ({
    id: 4201,
    ticketId: 901,
    workspaceId: 1,
    ticket: {
      id: 901,
      freshserviceTicketId: 232281,
      origin: 'freshservice',
      tpSkill: null,
      tpSubskill: null,
      internalCategory: { name: 'Remittances' },
      internalSubcategory: null,
      ...ticketOverrides,
    },
  });

  test('dry-run records the intended category without calling FreshService', async () => {
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(categoryRun());

    const result = await freshServiceActionService.executeCategoryWriteback(4201, 1, true);

    expect(result).toEqual(expect.objectContaining({ success: true, dryRun: true }));
    expect(freshserviceModule.createFreshServiceClient).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenCalledWith({
      where: { id: 4201 },
      data: expect.objectContaining({
        categoryWritebackStatus: 'dry_run',
        categoryWritebackPayload: expect.objectContaining({
          preview: 'Set Ticket Pulse category on #232281 to "Remittances"',
        }),
      }),
    });
  });

  test('skips with no_category when the run persisted nothing (observe-only groups)', async () => {
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(categoryRun({ internalCategory: null }));

    const result = await freshServiceActionService.executeCategoryWriteback(4201, 1, false);

    expect(result).toEqual(expect.objectContaining({ success: true, skipped: true, error: 'no_category' }));
    expect(freshserviceModule.createFreshServiceClient).not.toHaveBeenCalled();
  });

  test('skips with already_current when FreshService already carries the category', async () => {
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(categoryRun({ tpSkill: 'Remittances' }));

    const result = await freshServiceActionService.executeCategoryWriteback(4201, 1, false);

    expect(result).toEqual(expect.objectContaining({ success: true, skipped: true, error: 'already_current' }));
    expect(freshserviceModule.createFreshServiceClient).not.toHaveBeenCalled();
  });

  test('resolves lookup display ids, writes custom fields, and mirrors locally', async () => {
    const client = {
      listCustomObjects: jest.fn().mockResolvedValue([
        { id: 11, title: 'Ticket Pulse Skills' },
        { id: 12, title: 'Ticket Pulse Subskills' },
      ]),
      listCustomObjectRecords: jest.fn((objectId) => Promise.resolve(
        objectId === 11 ? [{ data: { name: 'Remittances', bo_display_id: 30 } }] : [],
      )),
      updateTicketCustomFields: jest.fn().mockResolvedValue({ id: 232281 }),
    };
    freshserviceModule.createFreshServiceClient.mockReturnValue(client);
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(categoryRun());

    const result = await freshServiceActionService.executeCategoryWriteback(4201, 1, false);

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(client.updateTicketCustomFields).toHaveBeenCalledWith(232281, expect.objectContaining({
      lf_ticket_pulse_category: 30,
    }));
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({
      where: { id: 901 },
      data: { tpSkill: 'Remittances', tpSubskill: null },
    });
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenCalledWith({
      where: { id: 4201 },
      data: expect.objectContaining({
        categoryWritebackStatus: 'synced',
        categoryWrittenAt: expect.any(Date),
      }),
    });
  });
});

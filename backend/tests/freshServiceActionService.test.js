import { jest } from '@jest/globals';

const prismaMock = {
  technician: {
    findUnique: jest.fn(),
  },
  workspace: {
    findUnique: jest.fn(),
  },
  ticket: {
    findUnique: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: jest.fn(),
}));

jest.unstable_mockModule('../src/services/assignmentFlowGuards.js', () => ({
  shouldCloseNoiseDismissedRun: jest.fn(() => true),
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { default: freshServiceActionService } = await import('../src/services/freshServiceActionService.js');

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
});

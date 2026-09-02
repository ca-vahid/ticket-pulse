import { jest } from '@jest/globals';

// Mega 08-31 Phase PA — ticketResubmissionService.applyResubmission: the
// in-place update a re-POSTed Power Apps / API payload performs on the ticket
// it already created. Everything below ticketService is mocked so the tests
// pin the CONTRACT: diff table, customFields merge+provision, description
// append-not-replace, lastRealActivityAt bump, classification-only re-triage
// gating, status/assignee never touched, terminal handling.

const prismaMock = {
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn().mockResolvedValue({}) },
  ticketActivity: { findMany: jest.fn().mockResolvedValue([]) },
};
const ticketServiceMock = {
  changeStatus: jest.fn().mockResolvedValue({ changed: true }),
  updateTicketFields: jest.fn().mockResolvedValue({ changed: true }),
  addPrivateNote: jest.fn().mockResolvedValue({ id: 77 }),
  _audit: jest.fn().mockResolvedValue({ id: 4242 }),
  _emitFieldsUpdated: jest.fn().mockResolvedValue({ status: 'completed' }),
  _startAiTriage: jest.fn().mockResolvedValue({ queued: true, mode: 'classify' }),
  getTicket: jest.fn(),
};
const customFieldServiceMock = {
  setValuesAtCreate: jest.fn(),
  setValues: jest.fn().mockResolvedValue({ customFields: {}, changes: {} }),
};
const statusServiceMock = {
  baseStatusOf: jest.fn(async (_ws, name) => ({ Open: 'Open', Pending: 'Pending', Resolved: 'Resolved', Closed: 'Closed' }[name] ?? null)),
  statusNamesForBase: jest.fn(async (_ws, bases) => {
    const list = Array.isArray(bases) ? bases : [bases];
    return ['Open', 'Pending', 'Resolved', 'Closed'].filter((s) => list.includes(s));
  }),
};
const ticketTypeServiceMock = { normalizeTypeName: jest.fn(async (_ws, v) => String(v)) };
const requesterRepositoryMock = { findByEmail: jest.fn() };
const resolveCategoryNamesMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/customFieldService.js', () => ({
  default: customFieldServiceMock,
  normalizeFieldKey: (raw) => String(raw ?? '').trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s\-.]+/g, '_').toLowerCase(),
}));
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: statusServiceMock }));
jest.unstable_mockModule('../src/services/ticketTypeService.js', () => ({ default: ticketTypeServiceMock }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: requesterRepositoryMock }));
jest.unstable_mockModule('../src/services/categoryNameResolver.js', () => ({
  resolveCategoryNames: resolveCategoryNamesMock,
  default: { resolveCategoryNames: resolveCategoryNamesMock },
}));

const {
  default: service, normalizeExternalRef, customFieldValueForKey, derivedRef, renderDiffNoteHtml,
} = await import('../src/services/ticketResubmissionService.js');

const WS = 5;
const actor = { email: 'apikey:tp_live_x', name: 'Coreshack intake', role: 'api', technicianId: null };
const ctx = { workspaceId: WS, actor, apiKeyName: 'Coreshack intake', matchedBy: 'external_ref', externalRef: 'sp-projectrequests-1260' };

function ticket(overrides = {}) {
  return {
    id: 501, workspaceId: WS, origin: 'ticketpulse', nativeNumber: 1042, status: 'Open',
    subject: 'Coyote Landslide', description: '<p>Created from Power Automate</p>', descriptionText: 'Created from Power Automate',
    priority: 2, ticketType: 'Case', requesterId: 40, assignedTechId: null,
    internalCategoryId: 11, internalSubcategoryId: 21, internalCategoryFit: 'strong',
    internalCategory: { id: 11, name: 'Project Setup' }, internalSubcategory: { id: 21, name: 'Quebec' },
    groupId: null, internalGroupId: null, group: null, internalGroup: null,
    ccEmails: [], customFields: { power_app_record_id: '1260', client_location: 'Quebec' },
    externalRef: 'sp-projectrequests-1260', resolvedAt: null, closedAt: null,
    ...overrides,
  };
}

const baseBody = {
  subject: 'Coyote Landslide', description: 'Created from Power Automate', priority: 2,
  requesterEmail: 'jdoe@bgcengineering.ca', externalRef: 'sp-projectrequests-1260',
  customFields: { powerAppRecordId: '1260', clientLocation: 'Quebec' },
};

beforeEach(() => {
  jest.clearAllMocks();
  ticketServiceMock.getTicket.mockImplementation(async (id) => ({ ...ticket({ id }), displayRef: 'TP-1042' }));
  customFieldServiceMock.setValuesAtCreate.mockImplementation(async (_ws, values) => ({
    values: Object.fromEntries(Object.entries(values).map(([k, v]) => [
      k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(), v,
    ])),
    provisioned: [],
    rejected: [],
  }));
});

describe('helpers', () => {
  test('normalizeExternalRef trims, rejects >200 chars and non-strings, maps empty to null', () => {
    expect(normalizeExternalRef('  sp-1 ')).toBe('sp-1');
    expect(normalizeExternalRef(1260)).toBe('1260');
    expect(normalizeExternalRef('')).toBeNull();
    expect(normalizeExternalRef(undefined)).toBeNull();
    expect(() => normalizeExternalRef('x'.repeat(201))).toThrow(/200 characters/);
    expect(() => normalizeExternalRef({ a: 1 })).toThrow(/string/);
  });

  test('customFieldValueForKey accepts camelCase or snake_case spellings; derivedRef namespaces with pa-', () => {
    expect(customFieldValueForKey({ powerAppRecordId: ' 1260 ' }, 'power_app_record_id')).toBe('1260');
    expect(customFieldValueForKey({ power_app_record_id: 1260 }, 'powerAppRecordId')).toBe('1260');
    expect(customFieldValueForKey({ other: '1' }, 'power_app_record_id')).toBeNull();
    expect(customFieldValueForKey({ powerAppRecordId: '' }, 'power_app_record_id')).toBeNull();
    expect(derivedRef('1260')).toBe('pa-1260');
  });
});

describe('applyResubmission — changed body', () => {
  test('replaces changed scalars, appends the description (never replaces), merges custom fields, notes + audits + bumps activity', async () => {
    const t = ticket();
    const body = {
      ...baseBody, priority: 3, description: 'Client moved the start date to October.',
      customFields: { powerAppRecordId: '1260', clientLocation: 'Montreal' },
    };
    const result = await service.applyResubmission(t, body, ctx);

    expect(result.createNew).toBeUndefined();
    expect(result.changedFields).toEqual(['priority', 'description', 'customFields']);
    expect(result.reopened).toBe(false);

    // updateTicketFields got ONLY the changed fields — status/assignee never appear.
    expect(ticketServiceMock.updateTicketFields).toHaveBeenCalledTimes(1);
    const [, , fields] = ticketServiceMock.updateTicketFields.mock.calls[0];
    expect(Object.keys(fields).sort()).toEqual(['description', 'priority']);
    expect(fields.priority).toBe(3);
    expect(fields).not.toHaveProperty('status');
    expect(fields).not.toHaveProperty('assignedTechId');
    // Append, not replace: previous HTML kept, dated revision block under it.
    expect(fields.description.startsWith('<p>Created from Power Automate</p>')).toBe(true);
    expect(fields.description).toMatch(/<hr><p><strong>— Resubmitted .* via API key &quot;Coreshack intake&quot; —<\/strong><\/p><div>Client moved the start date to October\.<\/div>/);
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();

    // customFields: intake with auto-provision, then merge of the CHANGED keys only.
    expect(customFieldServiceMock.setValuesAtCreate).toHaveBeenCalledWith(WS, body.customFields, expect.objectContaining({ autoProvision: true }));
    expect(customFieldServiceMock.setValues).toHaveBeenCalledWith(501, WS, { client_location: 'Montreal' }, actor, { emitEvent: false });
    // TU-5: the per-call events are silenced and ONE aggregated
    // ticket.fields_updated carries the whole diff (actorKind api rides on the actor).
    const [, , updateOptions] = ticketServiceMock.updateTicketFields.mock.calls[0].slice(2);
    expect(updateOptions).toEqual({ emitEvent: false });
    expect(ticketServiceMock._emitFieldsUpdated).toHaveBeenCalledTimes(1);
    expect(ticketServiceMock._emitFieldsUpdated).toHaveBeenCalledWith(expect.objectContaining({
      actor, source: 'api:resubmission', reopened: false, auditRowId: 4242,
      changes: expect.objectContaining({
        priority: { from: 2, to: 3 },
        'customFields.client_location': { from: 'Quebec', to: 'Montreal' },
      }),
    }));
    expect(ticketServiceMock._emitFieldsUpdated.mock.calls[0][0].changes).not.toHaveProperty('status');

    // Private note (never a reply) with before/after rows; audit row; activity bump.
    expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledTimes(1);
    const [, , note, , noteFiles, noteOptions] = ticketServiceMock.addPrivateNote.mock.calls[0];
    // TU-3g: the diff note is machine-written — authorType 'system' + event.systemNote.
    expect(noteFiles).toEqual([]);
    expect(noteOptions).toEqual({ systemNote: true });
    expect(note.bodyHtml).toContain('<td><strong>Priority</strong></td><td>Medium (2)</td><td>High (3)</td>');
    expect(note.bodyHtml).toContain('<td><strong>Custom field: client_location</strong></td><td>Quebec</td><td>Montreal</td>');
    expect(note.bodyHtml).toContain('matched by externalRef');
    expect(note.bodyText).toContain('Priority: Medium (2) → High (3)');
    expect(ticketServiceMock._audit).toHaveBeenCalledWith(501, 'resubmitted', actor, expect.objectContaining({
      changedFields: ['priority', 'description', 'customFields'], matchedBy: 'external_ref', externalRef: 'sp-projectrequests-1260', reopened: false,
    }));
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({ where: { id: 501 }, data: { lastRealActivityAt: expect.any(Date) } });
  });

  test('resubmitStrategy:"replace" hands the raw new description to updateTicketFields', async () => {
    const body = { ...baseBody, description: 'Brand new text', resubmitStrategy: 'replace' };
    await service.applyResubmission(ticket(), body, ctx);
    const [, , fields] = ticketServiceMock.updateTicketFields.mock.calls[0];
    expect(fields.description).toBe('Brand new text');
  });

  test('a description that already appears in the ticket is not appended again', async () => {
    const t = ticket({
      description: '<p>Created from Power Automate</p>\n<hr><p><strong>— Resubmitted x —</strong></p><div>Client moved the start date to October.</div>',
      descriptionText: 'Created from Power Automate\n— Resubmitted x —\nClient moved the start date to October.',
    });
    const result = await service.applyResubmission(t, { ...baseBody, description: 'Client moved the start date to October.' }, ctx);
    expect(result.changedFields).toEqual([]);
    expect(ticketServiceMock.updateTicketFields).not.toHaveBeenCalled();
  });

  test('diff table escapes values (no HTML injection through subjects)', () => {
    const html = renderDiffNoteHtml({
      ctx, changedFields: ['subject'], reopened: false,
      diff: { subject: { from: 'old', to: '<script>alert(1)</script>' } },
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('applyResubmission — unchanged body', () => {
  test('changedFields [] — no note, no audit, no field write, no triage', async () => {
    const result = await service.applyResubmission(ticket(), baseBody, ctx);
    expect(result.changedFields).toEqual([]);
    expect(result.noteId).toBeNull();
    expect(ticketServiceMock.updateTicketFields).not.toHaveBeenCalled();
    expect(ticketServiceMock.addPrivateNote).not.toHaveBeenCalled();
    expect(ticketServiceMock._audit).not.toHaveBeenCalled();
    expect(ticketServiceMock._emitFieldsUpdated).not.toHaveBeenCalled();
    expect(ticketServiceMock._startAiTriage).not.toHaveBeenCalled();
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });
});

describe('applyResubmission — AI re-triage gating', () => {
  test('unassigned + description changed → classification_only (never the full pipeline)', async () => {
    const result = await service.applyResubmission(ticket({ assignedTechId: null }), { ...baseBody, description: 'New details' }, ctx);
    expect(ticketServiceMock._startAiTriage).toHaveBeenCalledWith(501, WS, 'classification_only');
    expect(result.aiRetriage).toEqual({ queued: true, mode: 'classify' });
  });

  test('assigned + human-set category → triage skipped even though content changed', async () => {
    await service.applyResubmission(ticket({ assignedTechId: 7, internalCategoryFit: null }), { ...baseBody, description: 'New details' }, ctx);
    expect(ticketServiceMock._startAiTriage).not.toHaveBeenCalled();
  });

  test('assigned but AI-set category → classification_only still runs; runAiTriage:false always skips', async () => {
    await service.applyResubmission(ticket({ assignedTechId: 7, internalCategoryFit: 'weak' }), { ...baseBody, description: 'New details' }, ctx);
    expect(ticketServiceMock._startAiTriage).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();
    await service.applyResubmission(ticket({ assignedTechId: null }), { ...baseBody, description: 'Newer', runAiTriage: false }, ctx);
    expect(ticketServiceMock._startAiTriage).not.toHaveBeenCalled();
  });

  test('only priority changed (no content change) → no triage', async () => {
    await service.applyResubmission(ticket(), { ...baseBody, priority: 4 }, ctx);
    expect(ticketServiceMock._startAiTriage).not.toHaveBeenCalled();
  });
});

describe('applyResubmission — terminal handling', () => {
  test('Resolved + default reopen → changeStatus to the workspace Open status, reopened:true, status in the diff', async () => {
    const result = await service.applyResubmission(ticket({ status: 'Resolved', resolvedAt: new Date() }), { ...baseBody, priority: 3 }, ctx);
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(501, WS, 'Open', actor);
    expect(result.reopened).toBe(true);
    expect(result.changedFields).toEqual(['status', 'priority']);
    expect(ticketServiceMock._audit).toHaveBeenCalledWith(501, 'resubmitted', actor, expect.objectContaining({ reopened: true }));
    // The reopen rides on the aggregated event; status itself stays out of the diff.
    expect(ticketServiceMock._emitFieldsUpdated).toHaveBeenCalledTimes(1);
    expect(ticketServiceMock._emitFieldsUpdated).toHaveBeenCalledWith(expect.objectContaining({ reopened: true, source: 'api:resubmission' }));
    expect(ticketServiceMock._emitFieldsUpdated.mock.calls[0][0].changes).not.toHaveProperty('status');
  });

  test('Resolved + reopenOnResubmit:false → createNew with the prior ticket, nothing written', async () => {
    const result = await service.applyResubmission(ticket({ status: 'Resolved' }), { ...baseBody, reopenOnResubmit: false }, ctx);
    expect(result).toEqual({ createNew: true, priorTicket: expect.objectContaining({ id: 501 }), reason: 'reopen_declined' });
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
    expect(ticketServiceMock.updateTicketFields).not.toHaveBeenCalled();
  });

  test('Closed → createNew (never silently reopened), even with a changed body', async () => {
    const result = await service.applyResubmission(ticket({ status: 'Closed', closedAt: new Date() }), { ...baseBody, priority: 4 }, ctx);
    expect(result).toMatchObject({ createNew: true, reason: 'closed' });
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
    expect(ticketServiceMock.updateTicketFields).not.toHaveBeenCalled();
  });

  test('FreshService-owned match → createNew (read-mostly rows are never edited here)', async () => {
    const result = await service.applyResubmission(ticket({ origin: 'freshservice' }), baseBody, ctx);
    expect(result).toMatchObject({ createNew: true, reason: 'freshservice_owned' });
  });
});

describe('applyResubmission — category / cc / type diffs', () => {
  test('category by name resolves and only a real change is applied; cc replace-if-changed; type normalized', async () => {
    resolveCategoryNamesMock.mockResolvedValue({ categoryId: 12, subcategoryId: null, categoryName: 'Proposal Setup', subcategoryName: null });
    await service.applyResubmission(ticket(), {
      ...baseBody, category: 'Proposal Setup', ccEmails: ['Manager@Example.com', 'manager@example.com'], ticketType: 'Case',
    }, ctx);
    const [, , fields] = ticketServiceMock.updateTicketFields.mock.calls[0];
    expect(fields).toEqual({ internalCategoryId: 12, internalSubcategoryId: null, ccEmails: ['manager@example.com'] });
    // Same type as before → not in the patch.
    expect(fields).not.toHaveProperty('ticketType');
  });

  test('identical category/cc/type → nothing to update', async () => {
    resolveCategoryNamesMock.mockResolvedValue({ categoryId: 11, subcategoryId: 21, categoryName: 'Project Setup', subcategoryName: 'Quebec' });
    const result = await service.applyResubmission(ticket(), { ...baseBody, category: 'Project Setup', subcategory: 'Quebec', ccEmails: [], ticketType: 'Case' }, ctx);
    expect(result.changedFields).toEqual([]);
    expect(ticketServiceMock.updateTicketFields).not.toHaveBeenCalled();
  });
});

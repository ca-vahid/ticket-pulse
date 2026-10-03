import { jest } from '@jest/globals';

/**
 * QA 10-01 #3 — Autofill from the Teams bot: picture extraction from Teams
 * activity shapes, commands still win, the card, Create as the agent,
 * native-ticketing-off, the prefill token lifecycle and password stripping.
 */

process.env.PUBLIC_APP_URL = 'https://tp.example.com';

// ---- in-memory draft table
const drafts = new Map();
let nextDraftId = 1;
const draftTable = {
  create: jest.fn(async ({ data }) => {
    const row = { id: nextDraftId++, createdAt: new Date(), updatedAt: new Date(), intakeRunId: null, ticketId: null, error: null, data: null, ...data };
    drafts.set(row.id, row);
    return { ...row };
  }),
  update: jest.fn(async ({ where, data }) => {
    const row = drafts.get(where.id);
    Object.assign(row, data, { updatedAt: new Date() });
    return { ...row };
  }),
  findUnique: jest.fn(async ({ where }) => {
    if (where.id) return drafts.has(where.id) ? { ...drafts.get(where.id) } : null;
    const hit = [...drafts.values()].find((d) => d.tokenHash === where.tokenHash);
    return hit ? { ...hit } : null;
  }),
  deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
};

const ADRIAN = { id: 7, name: 'Adrian Lo', email: 'adrian@x.io', workspaceId: 1 };
const prismaMock = {
  teamsAutofillDraft: draftTable,
  teamsDelivery: { create: jest.fn().mockResolvedValue({}) },
  teamsConversation: { findFirst: jest.fn().mockResolvedValue({ email: 'adrian@x.io' }), findUnique: jest.fn() },
  technician: { findMany: jest.fn(), findFirst: jest.fn() },
  workspace: { findMany: jest.fn(), findUnique: jest.fn() },
  ticket: { findFirst: jest.fn().mockResolvedValue(null) },
  ticketIntakeRun: { findFirst: jest.fn().mockResolvedValue({ ticketId: null }) },
};
const botMock = {
  isTeamsConfigured: jest.fn(() => true),
  teamsConfig: jest.fn(() => ({ appId: 'app', tenantId: 'tenant' })),
  cardActivity: jest.fn((card, o = {}) => ({ type: 'message', card, ...o })),
  replyToActivity: jest.fn().mockResolvedValue({ id: 'reply-1' }),
  updateActivity: jest.fn().mockResolvedValue(),
  sendToConversation: jest.fn().mockResolvedValue('act-9'),
  downloadAttachment: jest.fn(),
  findUser: jest.fn(),
  describeError: (e) => e.message,
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

const EXTRACTED = {
  subject: 'Outlook keeps crashing on start',
  description: { request: 'Rita needs Outlook working', details: ['Crashes on start'], nextStep: 'Repair Office', discussedWith: [] },
  descriptionHtml: '<p><strong>Request:</strong> Rita needs Outlook working</p>',
  descriptionText: 'Request: Rita needs Outlook working\n\n- Crashes on start',
  requesterNameOrEmail: 'Rita Moreno',
  requesterMatch: { status: 'matched', candidate: { requesterId: 41, email: 'rita@x.io', name: 'Rita Moreno', source: 'requester' }, candidates: [] },
  assigneeMatch: { status: 'none', technician: null, candidates: [] },
  categoryHint: 'Software > Outlook',
  categoryLevel: 'leaf',
  priorityHint: 3,
  typeHint: 'Incident',
  technicianNotes: null,
};
const extract = jest.fn();
const recordRun = jest.fn().mockResolvedValue(555);
const createTicket = jest.fn();
const upload = jest.fn();
const enqueueAttachment = jest.fn().mockResolvedValue();
const formConfig = { getResolvedForm: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/teamsBotClient.js', () => ({ default: botMock }));
jest.unstable_mockModule('../src/services/ticketIntakeExtractService.js', () => ({ default: { extract } }));
jest.unstable_mockModule('../src/services/ticketIntakeRunService.js', () => ({ default: { record: recordRun } }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { createTicket, assignTicket: jest.fn(), addPrivateNote: jest.fn(), addReply: jest.fn() } }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: { upload } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: { enqueueAttachment } }));
jest.unstable_mockModule('../src/services/ticketFormConfigService.js', () => ({ default: formConfig }));
jest.unstable_mockModule('../src/services/customFieldService.js', () => ({ default: { listDefinitions: jest.fn().mockResolvedValue([]) } }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: { getAccessRole: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/ticketApprovalService.js', () => ({ default: { decideInApp: jest.fn() } }));

const intakeModule = await import('../src/services/teamsIntakeService.js');
const {
  default: intake, collectImageRefs, extractMessageText, stripSecrets, isBotCommand, wantsAutofill, sniffImageType, hashToken, DRAFT_TTL_MS,
} = intakeModule;
const { default: notifications } = await import('../src/services/teamsNotificationService.js');
const { autofillCard } = await import('../src/services/teamsCards.js');

const SMBA = 'https://smba.trafficmanager.net/amer/v3/attachments/0-abc/views/original';
const message = (over = {}) => ({
  type: 'message',
  id: `m-${Math.random()}`,
  serviceUrl: 'https://smba.trafficmanager.net/amer/',
  conversation: { id: 'conv-1', conversationType: 'personal' },
  from: { aadObjectId: 'aad-7' },
  text: '',
  attachments: [],
  ...over,
});
const allText = (card) => JSON.stringify(card);
const findAction = (card, verb) => card.actions.find((a) => a.verb === verb);
const lastCard = () => {
  const calls = botMock.updateActivity.mock.calls;
  return calls.length ? calls[calls.length - 1][1].card : null;
};

beforeEach(() => {
  drafts.clear();
  jest.clearAllMocks();
  intake.hits.clear();
  intake.seenActivities.clear();
  prismaMock.technician.findMany.mockResolvedValue([ADRIAN]);
  prismaMock.technician.findFirst.mockResolvedValue(ADRIAN);
  prismaMock.workspace.findMany.mockResolvedValue([{ id: 1, name: 'IT', nativeTicketingEnabled: true }]);
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', nativeTicketingEnabled: true });
  prismaMock.teamsConversation.findFirst.mockResolvedValue({ email: 'adrian@x.io' });
  prismaMock.ticketIntakeRun.findFirst.mockResolvedValue({ ticketId: null });
  botMock.replyToActivity.mockResolvedValue({ id: 'reply-1' });
  botMock.downloadAttachment.mockResolvedValue({ buffer: PNG, contentType: 'image/png' });
  formConfig.getResolvedForm.mockResolvedValue({ fields: [], defaultGroup: null });
  extract.mockResolvedValue({ data: { ...EXTRACTED }, meta: { provider: 'anthropic', model: 'm', imageCount: 1 } });
  createTicket.mockResolvedValue({ id: 900, nativeNumber: 1234, origin: 'ticketpulse', subject: EXTRACTED.subject });
  upload.mockImplementation(async ({ fileName }) => ({ id: 70, fileName }));
});

describe('reading Teams activities', () => {
  test('pasted picture: image/* attachment and the same <img> in text/html count once; emoji skipped', () => {
    const act = message({
      attachments: [
        { contentType: 'image/*', contentUrl: SMBA },
        { contentType: 'text/html', content: `<div><img src="${SMBA.replace(/&/g, '&amp;')}" alt="image"><img itemtype="http://schema.skype.com/Emoji" src="https://statics.teams.cdn.office.net/evergreen-assets/emoji.png"></div>` },
      ],
    });
    const { refs, ignored } = collectImageRefs(act);
    expect(refs).toEqual([{ url: SMBA, name: null, kind: 'image' }]);
    expect(ignored).toBe(0);
  });

  // 2 Oct 2026: the <img> copy lives on the media service under the same
  // object id and refuses the bot (401) — it must not count as a 2nd picture.
  test('pasted picture: the media-service <img> copy of the attachment counts once, either order', () => {
    const id = SMBA.match(/attachments\/([^/]+)\/views/)[1];
    const asm = `https://us-api.asm.skype.com/v1/objects/${id}/views/imgo`;
    const img = { contentType: 'text/html', content: `<div><img src="${asm}" alt="image"></div>` };
    const att = { contentType: 'image/*', contentUrl: SMBA };
    expect(collectImageRefs(message({ attachments: [att, img] })).refs).toEqual([{ url: SMBA, name: null, kind: 'image' }]);
    expect(collectImageRefs(message({ attachments: [img, att] })).refs).toEqual([{ url: SMBA, name: null, kind: 'image' }]);
  });

  test('two different pictures stay two', () => {
    const other = SMBA.replace(/attachments\/[^/]+/, 'attachments/0-xyz');
    const { refs } = collectImageRefs(message({ attachments: [
      { contentType: 'image/*', contentUrl: SMBA },
      { contentType: 'image/*', contentUrl: other },
    ] }));
    expect(refs).toHaveLength(2);
  });

  test('inline picture only in the HTML (Graph hosted content) is found', () => {
    const url = 'https://graph.microsoft.com/v1.0/chats/19:x/messages/1/hostedContents/aGk=/$value';
    const { refs } = collectImageRefs(message({ attachments: [{ contentType: 'text/html', content: `<p>see</p><img src="${url}" width="300">` }] }));
    expect(refs).toEqual([{ url, name: null, kind: 'inline' }]);
  });

  test('a file sent with the paperclip: pictures kept, other files ignored', () => {
    const { refs, ignored } = collectImageRefs(message({
      attachments: [
        { contentType: 'application/vnd.microsoft.teams.file.download.info', name: 'error.PNG', content: { downloadUrl: 'https://x.sharepoint.com/dl/1', fileType: 'png' } },
        { contentType: 'application/vnd.microsoft.teams.file.download.info', name: 'log.pdf', content: { downloadUrl: 'https://x.sharepoint.com/dl/2', fileType: 'pdf' } },
        { contentType: 'application/pdf', contentUrl: 'https://x/y.pdf' },
      ],
    }));
    expect(refs).toEqual([{ url: 'https://x.sharepoint.com/dl/1', name: 'error.PNG', kind: 'file' }]);
    expect(ignored).toBe(2);
  });

  test('text comes from activity.text, else the HTML attachment, mentions removed', () => {
    expect(extractMessageText(message({ text: '<at>Ticket Pulse</at> Printer on 3rd floor<br>is jammed &amp; beeping' }))).toBe('Printer on 3rd floor\nis jammed & beeping');
    expect(extractMessageText(message({ attachments: [{ contentType: 'text/html', content: '<p>Line one</p><p>Line two</p>' }] }))).toBe('Line one\nLine two');
  });

  test('picture types are sniffed from the bytes (Teams says image/*)', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('RIFF0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('%PDF-1.7'))).toBeNull();
  });
});

describe('commands still win', () => {
  test('short commands are commands; a long dump or a picture is Autofill', () => {
    expect(isBotCommand('my tickets')).toBe(true);
    expect(isBotCommand('Settings')).toBe(true);
    expect(isBotCommand('help')).toBe(true);
    expect(wantsAutofill(message({ text: 'my tickets', attachments: [{ contentType: 'image/*', contentUrl: SMBA }] }))).toBe(false);
    expect(wantsAutofill(message({ text: 'hello' }))).toBe(false);
    expect(wantsAutofill(message({ attachments: [{ contentType: 'image/*', contentUrl: SMBA }] }))).toBe(true);
    expect(wantsAutofill(message({ text: 'Rita says her Outlook settings reset every morning and she cannot see the shared calendar anymore' }))).toBe(true);
    expect(wantsAutofill(message({ conversation: { id: 'c', conversationType: 'groupChat' }, attachments: [{ contentType: 'image/*', contentUrl: SMBA }] }))).toBe(false);
  });

  test('"my tickets" goes to the digest, not to Autofill', async () => {
    const spy = jest.spyOn(intake, 'handleMessage');
    prismaMock.technician.findMany.mockResolvedValue([]);
    await notifications.handleActivity(message({ text: 'my tickets' }));
    expect(spy).not.toHaveBeenCalled();
    expect(botMock.replyToActivity).toHaveBeenCalledTimes(1);
    expect(allText(botMock.replyToActivity.mock.calls[0][1].card)).toContain('No open tickets found for you');
    spy.mockRestore();
  });

  test('a screenshot is handed to Autofill by the bot endpoint', async () => {
    const spy = jest.spyOn(intake, 'handleMessage').mockResolvedValue();
    await notifications.handleActivity(message({ attachments: [{ contentType: 'image/*', contentUrl: SMBA }] }));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: 'message' }), 'adrian@x.io');
    spy.mockRestore();
  });
});

describe('passwords never reach the model', () => {
  test('lines that hand over a password are removed; problem descriptions stay', () => {
    const { text, removed } = stripSecrets([
      'New starter Sam Lee, laptop needed Monday',
      'Initial password: Summer2026!',
      'temporary password is Wint3r#99',
      'pwd = hunter2',
      'My new password is not working',
      'Password reset needed',
    ].join('\n'));
    expect(removed).toBe(3);
    expect(text).not.toMatch(/Summer2026|Wint3r|hunter2/);
    expect(text).toContain('My new password is not working');
    expect(text).toContain('Password reset needed');
  });

  test('the stripped text is what extraction and the draft see', async () => {
    await intake.handleMessage(message({ text: 'Please set up Sam Lee, starts Monday in Calgary office\nInitial password: Summer2026!' }), 'adrian@x.io');
    expect(extract.mock.calls[0][0].text).not.toContain('Summer2026');
    const draft = [...drafts.values()][0];
    expect(draft.sourceText).not.toContain('Summer2026');
    expect(allText(lastCard())).toContain('looked like a password was removed');
  });
});

describe('the Autofill card', () => {
  test('a screenshot → reading card, then the proposal with Create / Open / Discard', async () => {
    await intake.handleMessage(message({ attachments: [{ contentType: 'image/*', contentUrl: SMBA }] }), 'adrian@x.io');

    expect(botMock.replyToActivity.mock.calls[0][1].card.body[0].items[0].columns[0].items[0].text).toContain('Reading your message');
    expect(botMock.downloadAttachment).toHaveBeenCalledWith(SMBA, expect.objectContaining({ serviceUrl: 'https://smba.trafficmanager.net/amer/' }));
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 1, actorEmail: 'adrian@x.io', actorTechnicianId: 7, images: [expect.objectContaining({ mimeType: 'image/png' })] }));
    expect(recordRun).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 1, actor: { email: 'adrian@x.io', name: 'Adrian Lo' } }));

    const [where, activity] = botMock.updateActivity.mock.calls[0];
    expect(where).toEqual({ serviceUrl: 'https://smba.trafficmanager.net/amer/', conversationId: 'conv-1', activityId: 'reply-1' });
    const card = activity.card;
    const s = allText(card);
    expect(s).toContain('Outlook keeps crashing on start');
    expect(s).toContain('Rita Moreno');
    expect(s).toContain('Software');
    expect(s).toContain('Outlook');
    expect(s).toContain('High');
    expect(s).toContain('Rita needs Outlook working');
    expect(s).toContain('1 picture will be attached');
    expect(findAction(card, 'autofill.create')).toBeTruthy();
    expect(findAction(card, 'autofill.discard')).toBeTruthy();
    const open = card.actions.find((a) => a.title === 'Open in Ticket Pulse');
    expect(open.url).toMatch(/^https:\/\/tp\.example\.com\/tickets\/new\?autofill=[A-Za-z0-9_-]+&ws=1$/);
    const draft = [...drafts.values()][0];
    expect(draft).toMatchObject({ status: 'ready', intakeRunId: 555, workspaceId: 1, technicianId: 7 });
    expect(draft.images).toHaveLength(1);
    expect(draft.tokenHash).toBe(hashToken(decodeURIComponent(open.url.match(/autofill=([^&]+)/)[1])));
    expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventKey: 'autofill', status: 'sent', email: 'adrian@x.io' }) });
  });

  test('missing requester is called out and the e-mail input is empty', () => {
    const card = autofillCard({ draftId: 1, t: 'tok', canCreate: true, subject: 'X', missing: ['Requester'], requesterEmail: null, openUrl: 'https://tp/x' }, 'ready');
    const s = allText(card);
    expect(s).toContain('Still needed:** Requester');
    expect(card.body.find((b) => b.id === 'requesterEmail').value).toBe('');
  });

  test('AI unavailable → plain words on the card', async () => {
    extract.mockRejectedValue(Object.assign(new Error('No AI provider is configured'), { name: 'ServiceBusyError', statusCode: 503 }));
    await intake.handleMessage(message({ attachments: [{ contentType: 'image/*', contentUrl: SMBA }] }), 'adrian@x.io');
    const s = allText(lastCard());
    expect(s).toContain('The AI is not available right now');
    expect(s).not.toContain('No AI provider');
    expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'failed', reason: 'ai_unavailable' }) });
  });

  test('nothing readable (picture refused, no text) → says so, no AI call', async () => {
    botMock.downloadAttachment.mockRejectedValue(new Error('This file is not on a Microsoft Teams host'));
    await intake.handleMessage(message({ attachments: [{ contentType: 'image/*', contentUrl: 'https://evil.example/x.png' }] }), 'adrian@x.io');
    expect(extract).not.toHaveBeenCalled();
    expect(allText(lastCard())).toContain('could not read anything');
  });

  test('native ticketing off → says so, offers only the web link, no AI call', async () => {
    prismaMock.workspace.findMany.mockResolvedValue([{ id: 1, name: 'IT', nativeTicketingEnabled: false }]);
    await intake.handleMessage(message({ attachments: [{ contentType: 'image/*', contentUrl: SMBA }] }), 'adrian@x.io');
    expect(extract).not.toHaveBeenCalled();
    expect(drafts.size).toBe(0);
    const card = botMock.replyToActivity.mock.calls[0][1].card;
    expect(allText(card)).toContain('Native ticketing is off in IT');
    expect(card.actions.map((a) => a.type)).toEqual(['Action.OpenUrl']);
    expect(card.actions[0].url).toBe('https://tp.example.com/tickets');
    expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'skipped', reason: 'native_ticketing_off' }) });
  });

  test('not an agent anywhere → plain refusal', async () => {
    prismaMock.technician.findMany.mockResolvedValue([]);
    await intake.handleMessage(message({ attachments: [{ contentType: 'image/*', contentUrl: SMBA }] }), 'stranger@x.io');
    expect(allText(botMock.replyToActivity.mock.calls[0][1].card)).toContain('not an active agent');
  });
});

async function readyDraft() {
  await intake.handleMessage(message({ text: 'Rita: Outlook crashes every time I open it since this morning, can you help?', attachments: [{ contentType: 'image/*', contentUrl: SMBA }] }), 'adrian@x.io');
  const card = lastCard();
  const create = findAction(card, 'autofill.create');
  return { card, data: create.data, draft: [...drafts.values()][0] };
}

describe('Create ticket from the card', () => {
  test('creates a TP-born ticket as the agent, attaches the pictures, updates the card', async () => {
    const { data } = await readyDraft();
    const out = await intake.handleAction('autofill.create', { ...data, subject: 'Outlook crashes on start', requesterEmail: 'rita@x.io', priority: '4', assign: 'me' }, 'adrian@x.io');

    expect(createTicket).toHaveBeenCalledTimes(1);
    const [wsId, body, actor, opts] = createTicket.mock.calls[0];
    expect(wsId).toBe(1);
    expect(body).toMatchObject({
      subject: 'Outlook crashes on start', priority: 4, requesterEmail: 'rita@x.io', requesterId: 41, requesterName: 'Rita Moreno',
      category: 'Software', subcategory: 'Outlook', ticketType: 'Incident', source: 102, assignedTechId: 7, runAiTriage: false, aiClassifyOnly: false,
    });
    expect(body.description).toContain('Rita needs Outlook working');
    expect(body.description).toContain('Source material (sent in Teams)');
    expect(actor).toMatchObject({ email: 'adrian@x.io', name: 'Adrian Lo', technicianId: 7, via: 'teams' });
    expect(opts).toMatchObject({ enforceRequired: true, allowAssignableOnly: true, intakeRunId: 555 });
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 1, ticketId: 900, contentType: 'image/png', uploadedBy: 'adrian@x.io' }));
    expect(enqueueAttachment).toHaveBeenCalledWith(1, 900, 70);

    const s = allText(out);
    expect(s).toContain('Created TP-1234');
    expect(out.actions[0]).toMatchObject({ type: 'Action.OpenUrl', title: 'Open', url: 'https://tp.example.com/tickets/900' });
    const draft = [...drafts.values()][0];
    expect(draft).toMatchObject({ status: 'created', ticketId: 900, images: [] });
    expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventKey: 'autofill_created', ticketId: 900 }) });

    // Pressing Create again shows the result, never a second ticket.
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 900, nativeNumber: 1234, origin: 'ticketpulse', subject: 'Outlook crashes on start' });
    const again = await intake.handleAction('autofill.create', { ...data, requesterEmail: 'rita@x.io' }, 'adrian@x.io');
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(allText(again)).toContain('Created TP-1234');
  });

  test('"Let AI route it" and no category → AI decides; no requester → asks for it', async () => {
    extract.mockResolvedValue({ data: { ...EXTRACTED, categoryHint: null, requesterMatch: { status: 'none', candidate: null, candidates: [] }, requesterNameOrEmail: null }, meta: {} });
    const { data } = await readyDraft();
    const ask = await intake.handleAction('autofill.create', { ...data, requesterEmail: '', assign: 'ai' }, 'adrian@x.io');
    expect(createTicket).not.toHaveBeenCalled();
    expect(allText(ask)).toContain('Add the requester');
    await intake.handleAction('autofill.create', { ...data, requesterEmail: 'new.person@x.io', assign: 'ai' }, 'adrian@x.io');
    const body = createTicket.mock.calls[0][1];
    expect(body).toMatchObject({ requesterEmail: 'new.person@x.io', runAiTriage: true, aiClassifyOnly: false });
    expect(body.assignedTechId).toBeUndefined();
    expect(body.category).toBeUndefined();
  });

  test('a validation refusal from ticket creation shows on the card', async () => {
    createTicket.mockRejectedValue(Object.assign(new Error('Required by this workspace\'s ticket form: Group'), { statusCode: 400 }));
    const { data } = await readyDraft();
    const out = await intake.handleAction('autofill.create', { ...data, requesterEmail: 'rita@x.io' }, 'adrian@x.io');
    expect(allText(out)).toContain('Required by this workspace');
    expect([...drafts.values()][0].status).toBe('ready');
  });

  test('someone else pressing the button (or a forged token) gets nothing', async () => {
    const { data } = await readyDraft();
    const other = await intake.handleAction('autofill.create', { ...data, requesterEmail: 'rita@x.io' }, 'mallory@x.io');
    expect(allText(other)).toContain('expired');
    const forged = await intake.handleAction('autofill.create', { draftId: data.draftId, t: 'not-the-token', requesterEmail: 'rita@x.io' }, 'adrian@x.io');
    expect(allText(forged)).toContain('expired');
    expect(createTicket).not.toHaveBeenCalled();
  });

  test('Discard wipes the pictures; the card says so', async () => {
    const { data } = await readyDraft();
    const out = await intake.handleAction('autofill.discard', data, 'adrian@x.io');
    expect(allText(out)).toContain('Discarded');
    expect([...drafts.values()][0]).toMatchObject({ status: 'discarded', images: [] });
  });

  test('the bot endpoint routes autofill.* invokes to the intake service', async () => {
    const { data } = await readyDraft();
    const res = await notifications.handleActivity({ type: 'invoke', name: 'adaptiveCard/action', from: { aadObjectId: 'aad-7' }, value: { action: { verb: 'autofill.discard', data } } });
    expect(res.type).toBe('application/vnd.microsoft.card.adaptive');
    expect(allText(res.value)).toContain('Discarded');
  });
});

describe('prefill token for /tickets/new?autofill=', () => {
  test('the sender reads the draft (pictures included); anyone else gets a 404', async () => {
    const { card } = await readyDraft();
    const token = decodeURIComponent(card.actions.find((a) => a.title === 'Open in Ticket Pulse').url.match(/autofill=([^&]+)/)[1]);
    const out = await intake.getPrefill(token, 'ADRIAN@x.io');
    expect(out).toMatchObject({ status: 'ready', workspace: { id: 1, name: 'IT' }, runId: 555 });
    expect(out.data.subject).toBe(EXTRACTED.subject);
    expect(out.images).toEqual([{ fileName: 'teams-picture-1.png', mimeType: 'image/png', base64: PNG.toString('base64') }]);
    await expect(intake.getPrefill(token, 'mallory@x.io')).rejects.toMatchObject({ statusCode: 404 });
    await expect(intake.getPrefill('x'.repeat(32), 'adrian@x.io')).rejects.toMatchObject({ statusCode: 404 });
    await expect(intake.getPrefill('../../etc', 'adrian@x.io')).rejects.toMatchObject({ statusCode: 404 });
  });

  test('expires after 30 minutes; a created draft points at its ticket', async () => {
    const { card, draft } = await readyDraft();
    const token = decodeURIComponent(card.actions.find((a) => a.title === 'Open in Ticket Pulse').url.match(/autofill=([^&]+)/)[1]);
    expect(draft.expiresAt.getTime() - Date.now()).toBeGreaterThan(DRAFT_TTL_MS - 60_000);
    drafts.get(draft.id).expiresAt = new Date(Date.now() - 1000);
    await expect(intake.getPrefill(token, 'adrian@x.io')).rejects.toMatchObject({ statusCode: 410 });
    const expiredCard = await intake.handleAction('autofill.create', { draftId: draft.id, t: token, requesterEmail: 'rita@x.io' }, 'adrian@x.io');
    expect(allText(expiredCard)).toContain('expired');
    expect(createTicket).not.toHaveBeenCalled();

    drafts.get(draft.id).status = 'created';
    drafts.get(draft.id).ticketId = 900;
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 900, nativeNumber: 1234, origin: 'ticketpulse' });
    await expect(intake.getPrefill(token, 'adrian@x.io')).resolves.toMatchObject({ status: 'created', ticketId: 900, ticketRef: 'TP-1234' });
  });

  test('already created from the web with the same run → no second ticket from Teams', async () => {
    const { data } = await readyDraft();
    prismaMock.ticketIntakeRun.findFirst.mockResolvedValue({ ticketId: 901 });
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 901, nativeNumber: 1300, origin: 'ticketpulse', subject: 'x' });
    const out = await intake.handleAction('autofill.create', { ...data, requesterEmail: 'rita@x.io' }, 'adrian@x.io');
    expect(createTicket).not.toHaveBeenCalled();
    expect(allText(out)).toContain('Created TP-1300');
    expect(allText(out)).toContain('already created from Ticket Pulse');
  });
});

// 2 Oct 2026 (Vahid): Assign to = Let AI decide, Me, Leave unassigned, then
// every agent A-Z, type-to-search.
describe('Assign to list on the Autofill card', () => {
  test('AI, Me, Unassigned first, then the workspace agents (not me)', async () => {
    const base = prismaMock.technician.findMany.getMockImplementation();
    prismaMock.technician.findMany.mockImplementation((args) => (args?.where?.id?.not === 7
      ? Promise.resolve([{ id: 21, name: 'Bea Brown' }, { id: 22, name: 'Cal Chen' }])
      : (base ? base(args) : Promise.resolve([ADRIAN]))));
    const { card } = await readyDraft();
    const assign = JSON.parse(allText(card).match(/\{"type":"Input\.ChoiceSet","id":"assign"[^\]]*\][^}]*\}/)[0]);
    expect(assign.style).toBe('filtered');
    expect(assign.choices.map((c) => c.value)).toEqual(['ai', 'me', 'none', 'tech:21', 'tech:22']);
    expect(assign.choices[0].title).toBe('Let AI decide');
    expect(assign.value).toBe('me');
  });

  test('picking an agent from the list assigns the new ticket to them', async () => {
    const { data } = await readyDraft();
    await intake.handleAction('autofill.create', { ...data, subject: 'Outlook crashes on start', requesterEmail: 'rita@x.io', assign: 'tech:21' }, 'adrian@x.io');
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket.mock.calls[0][1]).toMatchObject({ assignedTechId: 21, runAiTriage: false });
  });
});

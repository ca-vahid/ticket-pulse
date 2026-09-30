import { jest } from '@jest/globals';

// 30 Sep 2026: Knowledge → Settings → Prompts (versioned guidance), the
// Auto-help e-mail signature, and "Send to me" on a run.

const prismaMock = {
  autoHelpPromptVersion: {
    findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn(),
  },
  autoHelpSettings: { findUnique: jest.fn(), upsert: jest.fn() },
  autoHelpRun: { findFirst: jest.fn() },
  autoHelpPlaybook: { findFirst: jest.fn() },
  workspace: { findUnique: jest.fn(async () => ({ name: 'IT' })) },
  ticket: { findFirst: jest.fn() },
  $transaction: jest.fn(async (ops) => Promise.all(ops)),
};
const sendTransactionalEmail = jest.fn(async () => ({ sent: true, via: 'graph' }));
const getEnabledSignatureForSend = jest.fn(async () => null);
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail }));
jest.unstable_mockModule('../src/services/userSignatureService.js', () => ({
  getEnabledSignatureForSend,
  appendSignatureToEmail: (email, sig) => ({ html: `${email.html}<br>${sig.html}`, text: `${email.text}\n\n-- \n${sig.text}` }),
}));

const { default: prompts, PROMPT_DEFAULTS, _resetPromptCache } = await import('../src/services/autoHelpPromptService.js');
const { systemPromptFor, routeSystemPrompt, promptPreview, buildPreview, guidanceLines } = await import('../src/services/autoHelpRunner.js');
const { default: playbooks, autoHelpSignature } = await import('../src/services/autoHelpPlaybookService.js');
const { default: delivery } = await import('../src/services/autoHelpDeliveryService.js');
const { ValidationError } = await import('../src/utils/errors.js');

beforeEach(() => {
  jest.clearAllMocks();
  _resetPromptCache();
});

describe('prompt versions', () => {
  test('no published row: every prompt uses its built-in default', async () => {
    prismaMock.autoHelpPromptVersion.findMany.mockResolvedValueOnce([]);
    const { bodies, versions } = await prompts.getActive(1);
    expect(bodies).toEqual(PROMPT_DEFAULTS);
    expect(versions).toEqual({ answer: null, route: null, check: null });
  });

  test('a published version replaces its default; cached until the next publish', async () => {
    prismaMock.autoHelpPromptVersion.findMany.mockResolvedValue([{ key: 'answer', version: 3, status: 'published', body: 'Be friendly and brief.' }]);
    const first = await prompts.getActive(1);
    await prompts.getActive(1);
    expect(first.bodies.answer).toBe('Be friendly and brief.');
    expect(first.versions.answer).toBe(3);
    expect(prismaMock.autoHelpPromptVersion.findMany).toHaveBeenCalledTimes(1);
  });

  test('a draft gets the next version number; empty or unknown prompts are refused', async () => {
    prismaMock.autoHelpPromptVersion.findFirst.mockResolvedValueOnce({ version: 4 });
    prismaMock.autoHelpPromptVersion.create.mockImplementationOnce(async ({ data }) => ({ id: 9, createdAt: new Date(), ...data }));
    const draft = await prompts.createDraft(1, { key: 'route', body: '  Be picky.  ', notes: 'tighter' }, { email: 'v@x.io' });
    expect(draft).toMatchObject({ version: 5, status: 'draft', body: 'Be picky.', systemPrompt: 'Be picky.', notes: 'tighter', createdBy: 'v@x.io' });
    await expect(prompts.createDraft(1, { key: 'route', body: '   ' })).rejects.toThrow(ValidationError);
    await expect(prompts.createDraft(1, { key: 'tone', body: 'x' })).rejects.toThrow(/one of/);
  });

  test('publishing archives the key\'s previous live version', async () => {
    prismaMock.autoHelpPromptVersion.findFirst.mockResolvedValueOnce({ id: 9, key: 'check', version: 2 });
    prismaMock.autoHelpPromptVersion.update.mockResolvedValueOnce({ id: 9, key: 'check', version: 2, status: 'published', body: 'x', createdAt: new Date() });
    await prompts.publish(1, 9, { email: 'v@x.io' });
    expect(prismaMock.autoHelpPromptVersion.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 1, key: 'check', status: 'published', NOT: { id: 9 } }, data: { status: 'archived' },
    });
  });

  test('the live version cannot be deleted', async () => {
    prismaMock.autoHelpPromptVersion.findFirst.mockResolvedValueOnce({ id: 9, key: 'answer', version: 1, status: 'published', body: 'x', createdAt: new Date() });
    await expect(prompts.remove(1, 9)).rejects.toThrow(/cannot be deleted/);
    expect(prismaMock.autoHelpPromptVersion.delete).not.toHaveBeenCalled();
  });
});

describe('guidance inside the prompts', () => {
  const playbook = { id: 3, name: 'Software', instructions: 'Use Company Portal.', match: {} };

  test('answer: the guidance replaces the default style line; the fixed rules stay', () => {
    const prompt = systemPromptFor({ playbook, workspaceName: 'IT', playbookIsSource: false, guidance: 'Sound like a helpful colleague.\n- Keep it under 120 words.' });
    expect(prompt).toContain('- Sound like a helpful colleague.');
    expect(prompt).toContain('- Keep it under 120 words.');
    expect(prompt).not.toContain('short, warm, plain words');
    expect(prompt).toContain('Untrusted data');
    expect(prompt).toContain('Call submit_auto_help_reply exactly once');
    expect(guidanceLines('• one\ntwo')).toEqual(['- one', '- two']);
  });

  test('playbook choice and the preview carry the guidance', () => {
    const route = routeSystemPrompt('Only pick a playbook for how-to questions.');
    expect(route).toContain('Only pick a playbook for how-to questions.');
    expect(route).toContain('Call submit_route exactly once');
    expect(promptPreview('check', 'Be very strict.')).toContain('Be very strict.');
    expect(promptPreview('answer', 'Friendly.')).toContain('(the playbook the AI chose)');
  });
});

describe('Auto-help e-mail signature', () => {
  const settings = { signatureEnabled: true, signatureHtml: '<p>IT Service Desk</p><p style="color:red;margin:9px">BGC</p>', signatureText: '', signatureSpacing: 'normal' };

  test('off or empty → nothing; on → the spacing is applied, other styles kept', () => {
    expect(autoHelpSignature({ ...settings, signatureEnabled: false })).toBeNull();
    expect(autoHelpSignature({ signatureEnabled: true, signatureHtml: '' })).toBeNull();
    const sig = autoHelpSignature(settings);
    expect(sig.html).toBe('<p style="margin: 0 0 4px">IT Service Desk</p><p style="margin: 0 0 4px; color:red">BGC</p>');
    expect(sig.text).toBe('IT Service Desk\nBGC');
  });

  test('the answer e-mail ends with the signature, after the follow-up line', () => {
    const mail = buildPreview({ subject: 'Re: x', html: '<p>Do this.</p>', text: 'Do this.', settings: { ...settings, disclosureEnabled: false }, workspaceName: 'IT', followUp: null });
    expect(mail.signature).toBe(true);
    expect(mail.html.indexOf('Did this sort it out?')).toBeLessThan(mail.html.indexOf('IT Service Desk'));
    expect(mail.text).toMatch(/-- \nIT Service Desk\nBGC$/);
  });

  test('settings: the pasted HTML is cleaned; spacing and the agent rule are checked', async () => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue(null);
    await playbooks.updateSettings(1, { signatureEnabled: true, signatureHtml: '<p>Hi</p><script>alert(1)</script>', signatureSpacing: 'relaxed', signatureWith: 'both' }, { email: 'v@x.io' });
    const data = prismaMock.autoHelpSettings.upsert.mock.calls[0][0].update;
    expect(data).toMatchObject({ signatureEnabled: true, signatureSpacing: 'relaxed', signatureWith: 'both' });
    expect(data.signatureHtml).toContain('<p>Hi</p>');
    expect(data.signatureHtml).not.toContain('script');
    await expect(playbooks.updateSettings(1, { signatureSpacing: 'huge' })).rejects.toThrow(ValidationError);
    await expect(playbooks.updateSettings(1, { signatureWith: 'never' })).rejects.toThrow(ValidationError);
  });
});

describe('Send to me', () => {
  const RUN = {
    id: 108, workspaceId: 1, ticketId: 55, playbookId: 1, draftSubject: 'Getting Bluebeam',
    transcript: { body: { html: '<ol><li>Request it.</li></ol>', text: '1. Request it.' } },
  };
  beforeEach(() => {
    prismaMock.autoHelpRun.findFirst.mockResolvedValue(RUN);
    prismaMock.autoHelpPlaybook.findFirst.mockResolvedValue({ id: 1, name: 'Software', followUp: null });
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 55, subject: 'Bluebeam', origin: 'freshservice', freshserviceTicketId: BigInt(244642) });
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, disclosureEnabled: true, signatureEnabled: false });
  });

  test('e-mails the asker what the requester would get, under a "Preview only" band', async () => {
    getEnabledSignatureForSend.mockResolvedValueOnce({ html: '<p>Vahid</p>', text: 'Vahid' });
    const out = await delivery.sendPreviewToMe(1, 108, { email: 'Vahid@BGC.ca' });
    expect(out).toEqual({ sent: true, to: 'vahid@bgc.ca', via: 'graph' });
    const mail = sendTransactionalEmail.mock.calls[0][0];
    expect(mail).toMatchObject({ workspaceId: 1, to: ['vahid@bgc.ca'], subject: '[Preview] Getting Bluebeam', label: 'auto-help-preview' });
    expect(mail.html).toMatch(/^<table[\s\S]*Preview only\.[\s\S]*#244642[\s\S]*Nothing was sent to them/);
    expect(mail.html).toContain('Request it.');
    expect(mail.html).toContain('Did this sort it out?');
    expect(mail.html).toContain('<p>Vahid</p>');
  });

  test('with the Auto-help signature set to replace, the asker\'s own signature is left off', async () => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, signatureEnabled: true, signatureHtml: '<p>IT Desk</p>', signatureWith: 'replace' });
    await delivery.sendPreviewToMe(1, 108, { email: 'v@bgc.ca' });
    expect(getEnabledSignatureForSend).not.toHaveBeenCalled();
    expect(sendTransactionalEmail.mock.calls[0][0].html).toContain('IT Desk');
  });

  test('a run without an answer, or a user without an e-mail, is refused', async () => {
    prismaMock.autoHelpRun.findFirst.mockResolvedValueOnce({ ...RUN, transcript: {} });
    await expect(delivery.sendPreviewToMe(1, 108, { email: 'v@bgc.ca' })).rejects.toThrow(/no answer to preview/);
    await expect(delivery.sendPreviewToMe(1, 108, { name: 'No mail' })).rejects.toThrow(/no e-mail address/);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });
});

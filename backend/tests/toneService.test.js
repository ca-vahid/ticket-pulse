import { jest } from '@jest/globals';

/** Tone of voice (QA 09-25 #5): workspace settings, Straight-Talk List, resolution. */

const prismaMock = {
  toneSettings: { findUnique: jest.fn(), upsert: jest.fn() },
  toneOverrideContact: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  requester: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: toneService, DEFAULT_SERIOUS_TONE_TEXT } = await import('../src/services/toneService.js');

beforeEach(() => {
  jest.clearAllMocks();
  toneService._clearCache();
  prismaMock.toneSettings.findUnique.mockResolvedValue(null);
  prismaMock.toneOverrideContact.findMany.mockResolvedValue([]);
});

describe('toneService', () => {
  test('defaults when nothing is stored', async () => {
    const settings = await toneService.getSettings(3);
    expect(settings).toEqual(expect.objectContaining({
      defaultVoice: 'friendly',
      seriousToneText: DEFAULT_SERIOUS_TONE_TEXT,
      seriousWhenFrustrated: true,
    }));
  });

  test('a listed person gets the override with the workspace text (case-insensitive)', async () => {
    prismaMock.toneSettings.findUnique.mockResolvedValue({ defaultVoice: 'friendly', seriousToneText: 'Keep it formal.', seriousWhenFrustrated: true });
    prismaMock.toneOverrideContact.findMany.mockResolvedValue([{ email: 'pat@example.com' }]);
    const tone = await toneService.resolveToneForTicket({ workspaceId: 3, requesterEmail: 'Pat@Example.com' });
    expect(tone).toEqual({ voice: 'friendly', override: { reason: 'straight_talk_list', text: 'Keep it formal.' }, onStraightTalkList: true });
  });

  test('frustrated requesters switch only while the toggle is on', async () => {
    const on = await toneService.resolveToneForTicket({ workspaceId: 3, requesterEmail: 'x@example.com', sentiment: 'frustrated' });
    expect(on.override).toEqual({ reason: 'frustrated', text: DEFAULT_SERIOUS_TONE_TEXT });

    toneService._clearCache();
    prismaMock.toneSettings.findUnique.mockResolvedValue({ defaultVoice: 'friendly', seriousToneText: null, seriousWhenFrustrated: false });
    const off = await toneService.resolveToneForTicket({ workspaceId: 3, requesterEmail: 'x@example.com', sentiment: 'frustrated' });
    expect(off.override).toBeNull();
  });

  test('a missing table / partial mock degrades to defaults', async () => {
    const { toneSettings, toneOverrideContact } = prismaMock;
    delete prismaMock.toneSettings;
    delete prismaMock.toneOverrideContact;
    try {
      const tone = await toneService.resolveToneForTicket({ workspaceId: 9, requesterEmail: 'a@b.co', sentiment: 'neutral' });
      expect(tone).toEqual({ voice: 'friendly', override: null, onStraightTalkList: false });
    } finally {
      prismaMock.toneSettings = toneSettings;
      prismaMock.toneOverrideContact = toneOverrideContact;
    }
  });

  test('results are cached for a minute and writes invalidate the cache', async () => {
    await toneService.getSettings(3);
    await toneService.getSettings(3);
    expect(prismaMock.toneSettings.findUnique).toHaveBeenCalledTimes(1);
    prismaMock.toneOverrideContact.upsert.mockResolvedValue({ id: 1, email: 'pat@example.com' });
    prismaMock.requester.findFirst.mockResolvedValue(null);
    await toneService.addContact(3, { email: 'pat@example.com' });
    await toneService.getSettings(3);
    expect(prismaMock.toneSettings.findUnique).toHaveBeenCalledTimes(2);
  });

  test('addContact normalizes the address and resolves the requester', async () => {
    prismaMock.requester.findFirst.mockResolvedValue({ id: 40, name: 'Pat Doe' });
    prismaMock.toneOverrideContact.upsert.mockImplementation(({ create }) => Promise.resolve({ id: 1, ...create }));
    const row = await toneService.addContact(3, { email: '  PAT@Example.com ', note: 'asked for it' }, 'admin@example.com');
    expect(row).toEqual(expect.objectContaining({ email: 'pat@example.com', name: 'Pat Doe', requesterId: 40, note: 'asked for it', addedBy: 'admin@example.com' }));
    expect(prismaMock.toneOverrideContact.upsert.mock.calls[0][0].where).toEqual({ workspaceId_email: { workspaceId: 3, email: 'pat@example.com' } });
  });

  test('addContact rejects a bad address; removeContact is workspace-scoped', async () => {
    await expect(toneService.addContact(3, { email: 'nope' })).rejects.toThrow(/valid e-mail/);
    prismaMock.toneOverrideContact.deleteMany.mockResolvedValue({ count: 0 });
    await expect(toneService.removeContact(3, 77)).rejects.toThrow('Contact not found');
    expect(prismaMock.toneOverrideContact.deleteMany).toHaveBeenCalledWith({ where: { id: 77, workspaceId: 3 } });
  });

  test('updateSettings stores the default text as null and validates the voice', async () => {
    prismaMock.toneSettings.upsert.mockImplementation(({ create }) => Promise.resolve(create));
    const saved = await toneService.updateSettings(3, { defaultVoice: 'professional', seriousToneText: DEFAULT_SERIOUS_TONE_TEXT }, 'a@b.co');
    expect(prismaMock.toneSettings.upsert.mock.calls[0][0].create).toEqual(expect.objectContaining({ defaultVoice: 'professional', seriousToneText: null, updatedBy: 'a@b.co' }));
    expect(saved.seriousToneTextIsDefault).toBe(true);
    await expect(toneService.updateSettings(3, { defaultVoice: 'sarcastic' })).rejects.toThrow(/friendly or professional/);
  });
});

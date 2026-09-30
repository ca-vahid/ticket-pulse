import { jest } from '@jest/globals';

/**
 * "Stay quiet when" (26 Sep 2026), the data side: the playbook list and the
 * workspace list round-trip through create / update / settings, are cleaned
 * (one condition per line, bullets dropped, duplicates removed, capped), bump
 * the playbook version, and the workspace list is seeded with the defaults
 * until someone edits it. Plus "Preview answer": the newest drafted test run,
 * or a labelled sample built without a model call.
 */
const prismaMock = {
  autoHelpPlaybook: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  autoHelpRun: { groupBy: jest.fn(), findMany: jest.fn(async () => []), findFirst: jest.fn() },
  autoHelpSettings: { findUnique: jest.fn(), upsert: jest.fn() },
  workspace: { findUnique: jest.fn() },
  ticket: { findMany: jest.fn(async () => []) },
};
const searchMock = jest.fn();
const decorateMock = jest.fn(async (_ws, rows) => rows.map((r) => ({ ...r, ticketRef: 'TP-12', playbookName: 'Installs' })));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/knowledgeArticleService.js', () => ({ default: { search: searchMock } }));
jest.unstable_mockModule('../src/services/autoHelpRunner.js', () => ({
  default: { _decorate: decorateMock },
  buildPreview: ({ subject, html, settings, workspaceName }) => ({
    subject,
    html: `<p>${String(settings.disclosureText).replace('{{workspace}}', workspaceName)}</p>${html}<p>Did this sort it out?</p>`,
  }),
}));

const {
  default: service, cleanStayQuiet, normalizePlaybookInput, DEFAULT_ALWAYS_STAY_QUIET, MAX_STAY_QUIET,
} = await import('../src/services/autoHelpPlaybookService.js');
const { default: preview, sectionTextToHtml } = await import('../src/services/autoHelpPreviewService.js');

const ROW = {
  id: 3, workspaceId: 1, name: 'Installs', enabled: false, mode: 'shadow', categoryId: 10, subcategoryIds: [101],
  match: { keywords: ['install', 'company portal'] }, instructions: 'x', allowedTools: [], kbScope: null, minConfidence: 0.8,
  followUp: null, onHelp: 'assign_normally', priority: 100, version: 2, stayQuietWhen: ['The app is not in Company Portal'],
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.autoHelpPlaybook.findFirst.mockResolvedValue(ROW);
  prismaMock.autoHelpPlaybook.create.mockImplementation(async ({ data }) => ({ id: 9, ...data }));
  prismaMock.autoHelpPlaybook.update.mockImplementation(async ({ data }) => ({ ...ROW, ...data }));
  prismaMock.autoHelpSettings.findUnique.mockResolvedValue(null);
  prismaMock.autoHelpSettings.upsert.mockResolvedValue({});
  prismaMock.workspace.findUnique.mockResolvedValue({ name: 'IT' });
});

describe('cleanStayQuiet', () => {
  test('one per line or array item; bullets and numbers dropped; duplicates and blanks removed; capped', () => {
    expect(cleanStayQuiet('- Security incident\n2) HR   matters\n• hr matters\n\n  ')).toEqual(['Security incident', 'HR matters']);
    expect(cleanStayQuiet(['a', 'A ', null, 'b'])).toEqual(['a', 'b']);
    expect(cleanStayQuiet(Array.from({ length: 40 }, (_, i) => `c${i}`))).toHaveLength(MAX_STAY_QUIET);
    expect(cleanStayQuiet(['x'.repeat(500)])[0]).toHaveLength(300);
  });
});

describe('playbook CRUD round-trips stayQuietWhen', () => {
  test('create stores the cleaned list; a full create without it stores []', async () => {
    const created = await service.create(1, { name: 'P', stayQuietWhen: ['- Travel plan changes', 'travel plan changes'] });
    expect(prismaMock.autoHelpPlaybook.create.mock.calls[0][0].data.stayQuietWhen).toEqual(['Travel plan changes']);
    expect(created.stayQuietWhen).toEqual(['Travel plan changes']);
    expect(normalizePlaybookInput({ name: 'P' }).stayQuietWhen).toEqual([]);
  });

  test('a partial update without the field leaves it alone; a change bumps the version', async () => {
    await service.update(1, 3, { name: 'Installs' });
    expect(prismaMock.autoHelpPlaybook.update.mock.calls[0][0].data).not.toHaveProperty('stayQuietWhen');
    const next = await service.update(1, 3, { stayQuietWhen: ['The app is not in Company Portal', 'It needs a licence'] });
    const data = prismaMock.autoHelpPlaybook.update.mock.calls[1][0].data;
    expect(data.stayQuietWhen).toEqual(['The app is not in Company Portal', 'It needs a licence']);
    expect(data.version).toBe(3);
    expect(next.stayQuietWhen).toHaveLength(2);
  });

  test('a row written before the column existed reads as []', async () => {
    prismaMock.autoHelpPlaybook.findFirst.mockResolvedValueOnce({ ...ROW, stayQuietWhen: undefined });
    expect((await service.get(1, 3)).stayQuietWhen).toEqual([]);
  });
});

describe('workspace "Always stay quiet when"', () => {
  test('no settings row yet: the three seeded defaults', async () => {
    const s = await service.getSettings(1);
    expect(s.alwaysStayQuietWhen).toEqual([...DEFAULT_ALWAYS_STAY_QUIET]);
    expect(DEFAULT_ALWAYS_STAY_QUIET).toHaveLength(3);
    expect(DEFAULT_ALWAYS_STAY_QUIET[0]).toMatch(/security incident/);
  });

  test('update cleans and saves the list; an emptied list stays empty', async () => {
    await service.updateSettings(1, { alwaysStayQuietWhen: ['HR, legal, or personal matters', ' hr, legal, or personal matters ', ''] });
    expect(prismaMock.autoHelpSettings.upsert.mock.calls[0][0].update.alwaysStayQuietWhen).toEqual(['HR, legal, or personal matters']);
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, alwaysStayQuietWhen: [] });
    expect((await service.getSettings(1)).alwaysStayQuietWhen).toEqual([]);
  });

  test('settings updates that do not mention it leave it alone', async () => {
    await service.updateSettings(1, { enabled: true });
    expect(prismaMock.autoHelpSettings.upsert.mock.calls[0][0].update).not.toHaveProperty('alwaysStayQuietWhen');
  });
});

describe('"Preview answer"', () => {
  test('the newest drafted test run wins, flagged when the playbook changed since', async () => {
    prismaMock.autoHelpRun.findMany.mockResolvedValueOnce([{ id: 77, playbookId: 3, playbookVersion: 1, trigger: 'test', status: 'drafted', draftHtml: '<p>x</p>' }]);
    const out = await preview.forPlaybook(1, 3);
    expect(prismaMock.autoHelpRun.findMany.mock.calls[0][0].where).toMatchObject({ playbookId: 3, trigger: 'test', status: { in: ['drafted', 'not_answerable'] } });
    expect(out.latest).toMatchObject({ id: 77, ticketRef: 'TP-12', outdated: true, verdict: null });
    expect(out.sample).toBeNull();
    expect(searchMock).not.toHaveBeenCalled();
  });

  // QA 09-29 #3: three full OpenGround drafts were hidden behind the article
  // sample because the answer check had called them "not answerable".
  test('a not-answerable test that wrote a draft is shown (with its verdict), not the sample', async () => {
    prismaMock.autoHelpRun.findMany.mockResolvedValueOnce([
      { id: 88, playbookId: 3, playbookVersion: 2, trigger: 'test', status: 'not_answerable', gateDecision: 'insufficient_context', draftHtml: null, draftSubject: null, transcript: { body: { html: '<ol><li>Open Company Portal.</li></ol>', text: '1. Open Company Portal.' } } },
    ]);
    const out = await preview.forPlaybook(1, 3);
    expect(out.sample).toBeNull();
    expect(out.latest.verdict).toEqual({ status: 'not_answerable', gateDecision: 'insufficient_context' });
    expect(out.latest.draftHtml).toContain('Open Company Portal.');
    expect(searchMock).not.toHaveBeenCalled();
  });

  test('not-answerable runs with no draft at all → the sample as before', async () => {
    prismaMock.autoHelpRun.findMany.mockResolvedValueOnce([{ id: 51, status: 'not_answerable', gateDecision: 'no_sources', draftHtml: null, transcript: {} }]);
    searchMock.mockResolvedValue([]);
    expect(await preview.forPlaybook(1, 3)).toEqual({ latest: null, sample: null });
  });

  test('no test yet: a sample from the best-matching article, keyword-only, wrapped like a real answer', async () => {
    prismaMock.autoHelpRun.findFirst.mockResolvedValue(null);
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, disclosureEnabled: true, disclosureText: 'Automated answer from {{workspace}}.' });
    searchMock.mockResolvedValue([{ id: 12, title: 'Company Portal installs', section: { heading: 'Install an app', text: 'Open Company Portal.\n1. Search for the app\n2. Choose Install' } }]);
    const out = await preview.forPlaybook(1, 3);
    const [, query, opts] = searchMock.mock.calls[0];
    expect(query).toBe('Installs install company portal');
    expect(opts).toMatchObject({ limit: 1, categoryId: 10, subcategoryId: 101, queryVector: null });
    expect(out.latest).toBeNull();
    expect(out.sample.article).toMatchObject({ id: 12, title: 'Company Portal installs', section: 'Install an app' });
    expect(out.sample.html).toContain('Automated answer from IT.');
    expect(out.sample.html).toContain('<ol><li>Search for the app</li><li>Choose Install</li></ol>');
    expect(out.sample.sources[0]).toMatchObject({ sourceId: 'article:12', cited: true });
  });

  test('no article to build from: no sample (the UI says so)', async () => {
    prismaMock.autoHelpRun.findFirst.mockResolvedValue(null);
    searchMock.mockResolvedValue([]);
    expect(await preview.forPlaybook(1, 3)).toEqual({ latest: null, sample: null });
  });

  test('sectionTextToHtml escapes and groups lists', () => {
    expect(sectionTextToHtml('<b>hi</b>\n- a\n- b\nend')).toBe('<p>&lt;b&gt;hi&lt;/b&gt;</p><ul><li>a</li><li>b</li></ul><p>end</p>');
  });
});

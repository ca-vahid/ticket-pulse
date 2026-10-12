import { jest } from '@jest/globals';

/**
 * Knowledge → Activity (12 Oct 2026): the run list takes a search, a
 * category, how sure, judged or not, live or test, and pages; a run carries
 * what the requester asked. The Auto-help signature can go out exactly as
 * pasted, and its logo is never lifted out as a "pasted picture".
 */
const prismaMock = {
  ticket: { findFirst: jest.fn(), findMany: jest.fn() },
  technician: { findFirst: jest.fn() },
  autoHelpRun: { findFirst: jest.fn(), count: jest.fn(), groupBy: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
  autoHelpPlaybook: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: { runToolTurn: jest.fn(), sendJson: jest.fn() } }));

const { default: runner, buildPreview } = await import('../src/services/autoHelpRunner.js');
const { autoHelpSignature, SIGNATURE_SPACINGS } = await import('../src/services/autoHelpPlaybookService.js');
const { extractInlineImages } = await import('../src/services/ticketService.js');

const RUN = {
  id: 9, ticketId: 55, playbookId: 40, status: 'drafted', trigger: 'categorized', mode: 'shadow', createdAt: new Date('2026-10-09T21:06:00Z'),
  categoryId: 74, subcategoryId: 101, confidenceBand: 'medium', evidence: { misses: [{ key: 'partial', label: 'The knowledge covers only part of the request' }] },
};

beforeEach(() => {
  jest.clearAllMocks();
  runner._maybeSweep = jest.fn();
  prismaMock.autoHelpRun.findMany.mockResolvedValue([RUN]);
  prismaMock.autoHelpRun.count.mockResolvedValue(1);
  prismaMock.autoHelpRun.groupBy.mockResolvedValue([{ status: 'drafted', _count: { _all: 1 } }]);
  prismaMock.ticket.findMany.mockResolvedValue([{ id: 55, subject: 'Software Download', origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 246501n, status: 'Open', requester: { name: 'Pat Requester' } }]);
  prismaMock.autoHelpPlaybook.findMany.mockResolvedValue([{ id: 40, name: 'Knowledge answers', minConfidence: 0.85 }]);
  prismaMock.competencyCategory.findMany.mockResolvedValue([{ id: 74, name: 'Software & Apps' }, { id: 101, name: 'Installation' }]);
});

describe('listRuns: filters and pages', () => {
  test('category, sureness, "to review", live only and the page reach the query; rows carry requester and category names', async () => {
    const out = await runner.listRuns(1, { categoryId: '74', band: 'medium', review: 'needs', trigger: 'live', limit: 25, offset: 50 });
    const args = prismaMock.autoHelpRun.findMany.mock.calls[0][0];
    expect(args.take).toBe(25);
    expect(args.skip).toBe(50);
    expect(args.where.confidenceBand).toBe('medium');
    expect(args.where.trigger).toEqual({ notIn: ['test', 'backtest'] });
    expect(args.where.AND).toEqual([
      { OR: [{ categoryId: 74 }, { subcategoryId: 74 }] },
      expect.objectContaining({ reviewVerdict: null, status: { in: ['drafted', 'staged', 'sent'] } }),
    ]);
    expect(out).toMatchObject({ total: 1, needsReview: 1, limit: 25, offset: 50, statusCounts: { drafted: 1 } });
    expect(out.items[0]).toMatchObject({ ticketRef: '#246501', requesterName: 'Pat Requester', categoryName: 'Software & Apps', subcategoryName: 'Installation' });
  });

  test('a search by number or words is resolved to tickets first; unknown filter values are ignored', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([{ id: 55 }]);
    await runner.listRuns(1, { q: '#246501', band: 'certain', review: 'maybe', trigger: 'whatever' });
    const search = prismaMock.ticket.findMany.mock.calls[0][0];
    expect(search.where.workspaceId).toBe(1);
    expect(search.where.OR).toEqual(expect.arrayContaining([{ nativeNumber: 246501 }, { freshserviceTicketId: 246501n }]));
    const where = prismaMock.autoHelpRun.findMany.mock.calls[0][0].where;
    expect(where.ticketId).toEqual({ in: [55] });
    expect(where.confidenceBand).toBeUndefined();
    expect(where.trigger).toBeUndefined();
    expect(where.AND).toBeUndefined();
  });

  test('"reviewed" and the page size cap', async () => {
    await runner.listRuns(1, { review: 'done', limit: 5000 });
    const args = prismaMock.autoHelpRun.findMany.mock.calls[0][0];
    expect(args.where.reviewVerdict).toEqual({ not: null });
    expect(args.take).toBe(200);
  });
});

describe('getRun: what was asked', () => {
  test('the request comes with the run: requester, text without the blank lines, category and assignee', async () => {
    prismaMock.autoHelpRun.findFirst.mockResolvedValue(RUN);
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
    prismaMock.ticket.findFirst.mockResolvedValue({
      subject: 'Software Download', description: null, descriptionText: 'Hello,\n\n\nI need DT Logger Host.\n   \nThanks', createdAt: new Date('2026-10-09T21:00:00Z'), priority: 2,
      category: 'Software', subCategory: 'Install', status: 'Open',
      requester: { name: 'Pat Requester', email: 'pat@example.com', jobTitle: 'Engineer', department: 'Geotech' }, assignedTech: { name: 'Sam Agent' },
    });
    const run = await runner.getRun(1, 9);
    expect(run.request).toMatchObject({
      text: 'Hello,\nI need DT Logger Host.\nThanks', priority: 2, category: 'Software', assigneeName: 'Sam Agent',
      requester: { name: 'Pat Requester', jobTitle: 'Engineer', department: 'Geotech' },
    });
  });
});

describe('the Auto-help signature, exactly as pasted', () => {
  const SIG = '<p style="margin-top:25px;color:#555">Regards,<br><strong style="color:#0c1975">IT Helpdesk Team</strong></p>'
    + '<table style="width:400pt"><tbody><tr><td><img alt="Logo" width="100" height="100" src="data:image/png;base64,iVBORw0KGgo="></td>'
    + '<td><p style="margin-top:0pt;margin-bottom:0pt;font-size:12pt">IT Helpdesk</p></td></tr></tbody></table>';

  test('"exact" leaves every margin alone; "tight" still rewrites them', () => {
    expect(SIGNATURE_SPACINGS).toContain('exact');
    expect(autoHelpSignature({ signatureEnabled: true, signatureHtml: SIG, signatureSpacing: 'exact' }).html).toBe(SIG);
    expect(autoHelpSignature({ signatureEnabled: true, signatureHtml: SIG, signatureSpacing: 'tight' }).html).not.toContain('margin-top:25px');
  });

  test('the logo stays in the signature when the answer is sent; a picture pasted into the answer is still lifted', () => {
    const settings = { signatureEnabled: true, signatureHtml: SIG, signatureSpacing: 'exact', disclosureEnabled: false };
    const mail = buildPreview({ subject: 'Re: x', html: '<p>Steps</p><img src="data:image/png;base64,AAAA">', text: 'Steps', settings, workspaceName: 'IT', followUp: null });
    const out = extractInlineImages(mail.html);
    expect(out.files).toHaveLength(1);
    expect(out.html).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(out.html.match(/Pasted image attached/g)).toHaveLength(1);
    expect(out.html).toContain('margin-top:25px');
    // Only a signature picture: nothing is lifted and the body is untouched.
    const plain = buildPreview({ subject: 'Re: x', html: '<p>Steps</p>', text: 'Steps', settings, workspaceName: 'IT', followUp: null });
    expect(extractInlineImages(plain.html)).toEqual({ html: plain.html, files: [] });
  });
});

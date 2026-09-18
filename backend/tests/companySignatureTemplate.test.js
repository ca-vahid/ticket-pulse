import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * 18 Sep 2026 — Vahid: "the default signature has a different color scheme
 * than the one that we have … pay attention to the spacing, formatting and
 * color codedness … the number and whatnot is different for each office."
 *
 * The company signature is transcribed from the Outlook ReplySignature file:
 * Calibri, a 12pt bold navy (#0c1975) name, 10pt title/company, a blank line,
 * T:/M:/E: with navy labels and a #0563c1 link, the website, zero margins, and
 * no sign-off. T and M are each person's own numbers from the GAL.
 */

const prismaMock = {
  technician: { findMany: jest.fn(), findFirst: jest.fn() },
  userEmailSignature: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn() },
};
const azureAdServiceMock = { isConfigured: jest.fn(), getUserProfile: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: azureAdServiceMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  COMPANY_SIGNATURE_TEMPLATE,
  applySignatureTemplate,
  appendSignatureToEmail,
  formatSignaturePhone,
  trimTrailingBlankHtml,
  closeLastParagraphTight,
  massApplySignatureTemplate,
  listWorkspaceSignatures,
} = await import('../src/services/userSignatureService.js');

const ANTON = { name: 'Anton Kuzmychev', title: 'Senior IT Specialist', email: 'akuzmychev@bgcengineering.ca', phone: '613-683-0460', mobile: '416-821-9412' };

beforeEach(() => {
  jest.clearAllMocks();
  azureAdServiceMock.isConfigured.mockReturnValue(true);
  prismaMock.userEmailSignature.findUnique.mockResolvedValue(null);
  prismaMock.userEmailSignature.upsert.mockImplementation(({ create }) => Promise.resolve({ id: 1, ...create }));
});

describe('formatSignaturePhone — the GAL is not consistent, the signature is', () => {
  test.each([
    ['1-604-256-1414', '604-256-1414'],
    ['+1 6048308980', '604-830-8980'],
    ['6042567718', '604-256-7718'],
    ['+15873235325', '587-323-5325'],
    ['604-373-5379', '604-373-5379'],
    ['(604) 373 5379', '604-373-5379'],
  ])('%s → %s', (input, expected) => expect(formatSignaturePhone(input)).toBe(expected));

  test.each(['604-373-5379 x12', '+44 20 7946 0958', '12345'])('%s is left as the directory has it', (input) => {
    expect(formatSignaturePhone(input)).toBe(input);
  });

  test('nothing in, nothing out', () => {
    expect(formatSignaturePhone(null)).toBe('');
    expect(formatSignaturePhone('  ')).toBe('');
  });
});

describe('the template itself', () => {
  const html = applySignatureTemplate(COMPANY_SIGNATURE_TEMPLATE, ANTON);

  test('colour scheme: navy name and labels, blue links, stated on the spans', () => {
    expect(html).toContain('<strong><span style="color:#0c1975;">Anton Kuzmychev</span></strong>');
    for (const label of ['T:', 'M:', 'E:']) expect(html).toContain(`<span style="color:#0c1975;">${label}</span>`);
    expect(html.match(/color:#0563c1;/g)).toHaveLength(2);
  });

  test('type: Calibri, 12pt name, 10pt everything else, zero paragraph margins', () => {
    const paragraphs = html.match(/<p [^>]*>/g);
    expect(paragraphs).toHaveLength(6);
    for (const p of paragraphs) {
      expect(p).toContain('font-family:Calibri');
      expect(p).toContain('margin-top:0pt; margin-bottom:0pt;');
    }
    expect(paragraphs[0]).toContain('font-size:12pt');
    for (const p of paragraphs.slice(1)) expect(p).toContain('font-size:10pt');
  });

  test('layout: name / title / company / blank line / contact line / website — and no sign-off', () => {
    const text = html.replace(/<\/p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
    expect(text.split('\n').map((l) => l.trim())).toEqual([
      'Anton Kuzmychev', 'Senior IT Specialist', 'BGC Engineering', '',
      'T: 613-683-0460  M: 416-821-9412  E: akuzmychev@bgcengineering.ca', 'www.bgcengineering.ca', '',
    ]);
    expect(text).not.toMatch(/regards|thanks|sincerely/i);
  });

  test('links: mailto for the address, https for the site', () => {
    expect(html).toContain('href="mailto:akuzmychev@bgcengineering.ca"');
    expect(html).toContain('href="https://www.bgcengineering.ca"');
  });

  test('a person with no direct line gets no dangling "T:" (Calgary, Halifax)', () => {
    const out = applySignatureTemplate(COMPANY_SIGNATURE_TEMPLATE, { ...ANTON, phone: '' });
    expect(out).not.toContain('T:');
    expect(out).toContain('M:');
  });

  test('no title in Entra → no empty title line', () => {
    const out = applySignatureTemplate(COMPANY_SIGNATURE_TEMPLATE, { ...ANTON, title: '' });
    expect(out.match(/<p /g)).toHaveLength(5);
  });

  test('directory values are text, not markup', () => {
    const out = applySignatureTemplate(COMPANY_SIGNATURE_TEMPLATE, { ...ANTON, name: 'A <script>x</script> & B' });
    expect(out).not.toContain('<script>');
    expect(out).toContain('A &lt;script&gt;x&lt;/script&gt; &amp; B');
  });

  test('it survives the send path: sanitised, spaced "tight", every colour still there', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ id: 7, name: ANTON.name, email: ANTON.email }]);
    azureAdServiceMock.getUserProfile.mockResolvedValue({ jobTitle: ANTON.title, businessPhone: '6136830460', mobilePhone: '4168219412' });
    const preview = await massApplySignatureTemplate(1, { useCompanyTemplate: true, technicianIds: [7], preview: true });
    const sent = appendSignatureToEmail({ html: '<p>Hello</p>', text: 'Hello' }, { html: preview.results[0].html, spacing: 'tight' });
    expect(sent.html).toContain('color:#0c1975');
    expect(sent.html).toContain('color:#0563c1');
    expect(sent.html).toContain('font-family:Calibri');
    expect(sent.html).toContain('font-size:12pt');
    expect(sent.html).toContain('613-683-0460');
    expect(sent.html).toContain('416-821-9412');
    // The signature's own margin-top/bottom:0pt are replaced by the explicit "margin: 0".
    expect(sent.html.split('<br>')[1]).not.toMatch(/margin-(top|bottom)/);
    // The non-breaking spaces survive into the text part; that is fine.
    expect(sent.text.replace(/ /g, ' ')).toContain('T: 613-683-0460');
  });
});

describe('mass apply with the company template', () => {
  test('ignores whatever the editor sent, writes ENABLED + tight, numbers from each person’s own profile', async () => {
    prismaMock.technician.findMany.mockResolvedValue([
      { id: 1, name: 'Vancouver Person', email: 'van@bgcengineering.ca' },
      { id: 2, name: 'Halifax Person', email: 'hfx@bgcengineering.ca' },
    ]);
    azureAdServiceMock.getUserProfile.mockImplementation((email) => Promise.resolve(email.startsWith('van')
      ? { jobTitle: 'IT Specialist', businessPhone: '1-604-256-7500', mobilePhone: '+1 6043968461' }
      : { jobTitle: 'Analyst', businessPhone: null, mobilePhone: '9024019310' }));

    const result = await massApplySignatureTemplate(1, { useCompanyTemplate: true, template: '<p>ignored</p>', technicianIds: [1, 2] }, { email: 'admin@bgcengineering.ca' });
    expect(result.applied).toBe(2);
    const [van, hfx] = prismaMock.userEmailSignature.upsert.mock.calls.map((c) => c[0].create);
    expect(van).toMatchObject({ enabled: true, spacing: 'tight', updatedBy: 'admin@bgcengineering.ca' });
    expect(van.html).toContain('604-256-7500');
    expect(van.html).toContain('604-396-8461');
    expect(van.html).not.toContain('ignored');
    expect(hfx.html).toContain('902-401-9310');
    expect(hfx.html).not.toContain('T:');
  });

  test('Entra not configured → still a valid signature, just without numbers or title', async () => {
    azureAdServiceMock.isConfigured.mockReturnValue(false);
    prismaMock.technician.findMany.mockResolvedValue([{ id: 1, name: 'Ana Agent', email: 'ana@bgcengineering.ca' }]);
    const result = await massApplySignatureTemplate(1, { useCompanyTemplate: true, technicianIds: [1], preview: true });
    expect(result.results[0].html).toContain('Ana Agent');
    expect(result.results[0].html).not.toMatch(/T:|M:/);
    expect(result.results[0].html).toContain('E:');
  });

  test('Settings receives the template so it can show a sample', async () => {
    prismaMock.technician.findMany.mockResolvedValue([]);
    prismaMock.userEmailSignature.findMany.mockResolvedValue([]);
    const out = await listWorkspaceSignatures(1);
    expect(out.companyTemplate).toBe(COMPANY_SIGNATURE_TEMPLATE);
  });
});

describe('one blank line between the message and the signature', () => {
  const sig = { html: '<p>Anton</p>', spacing: 'tight' };

  test.each([
    ['<p>Thank you,</p>'],
    ['<p>Thank you,<br/></p>'],
    ['<p>Thank you,<br><br></p>'],
    ['<p>Thank you,</p><p><br></p>'],
    ['<p>Thank you,</p><p>&nbsp;</p><div><br></div>'],
    ['<p>Thank you,</p><br><br>'],
  ])('%s', (body) => {
    const out = appendSignatureToEmail({ html: body, text: 'Thank you,' }, sig);
    expect(out.html).toBe('<p style="margin-bottom:0">Thank you,</p><br><p style="margin: 0">Anton</p>');
  });

  test('blank lines INSIDE the message are the author’s and stay', () => {
    expect(trimTrailingBlankHtml('<p>One</p><p><br></p><p>Two</p>')).toBe('<p>One</p><p><br></p><p>Two</p>');
  });

  test('a message that is only blank is left alone rather than erased', () => {
    expect(trimTrailingBlankHtml('<p><br></p>')).toBe('<p><br></p>');
  });

  test('an image or a table at the end is content, not blank space', () => {
    expect(trimTrailingBlankHtml('<p>See</p><p><img src="cid:x"></p>')).toBe('<p>See</p><p><img src="cid:x"></p>');
  });

  test('only the LAST paragraph loses its bottom margin, and its other styles stay', () => {
    expect(closeLastParagraphTight('<p>One</p><p style="color:red; margin-bottom: 12px">Two</p>'))
      .toBe('<p>One</p><p style="color:red; margin-bottom:0">Two</p>');
  });

  test('a message ending in a list, table or <pre> is left alone', () => {
    for (const html of ['<p>See:</p><ul><li>a</li></ul>', '<p>x</p><pre>code</pre>', '<table><tr><td>1</td></tr></table>']) {
      expect(closeLastParagraphTight(html)).toBe(html);
    }
  });
});

import { describe, expect, test } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  MERGE_LIMIT_BYTES, PAGE_SIZES, buildMergedPdf, defaultPageSize, fitImage, mergeBlocker, mergeKind, mergedFileName, normalisePdfName, sniffKind,
} from './attachmentMerge';

import { encryptedPdf, tinyJpg, tinyPdf, tinyPng } from './attachmentMerge.testUtils';

const pdfFile = (id, fileName = `doc-${id}.pdf`, sizeBytes = 1000) => ({ id, fileName, contentType: 'application/pdf', sizeBytes });

describe('mergeKind / sniffKind', () => {
  test('reads the declared type, then the bytes', () => {
    expect(mergeKind({ fileName: 'a.PDF' })).toBe('pdf');
    expect(mergeKind({ fileName: 'x', contentType: 'image/jpeg' })).toBe('jpg');
    expect(mergeKind({ fileName: 'scan.png' })).toBe('png');
    expect(mergeKind({ fileName: 'anim.gif', contentType: 'image/gif' })).toBe('image');
    expect(mergeKind({ fileName: 'report.docx' })).toBeNull();
    expect(sniffKind(new TextEncoder().encode('%PDF-1.7 …'))).toBe('pdf');
    expect(sniffKind(tinyPng())).toBe('png');
    expect(sniffKind(tinyJpg())).toBe('jpg');
    expect(sniffKind(new TextEncoder().encode('PK zip'))).toBeNull();
  });
});

describe('mergeBlocker', () => {
  test('Word and Excel files are refused in plain words', () => {
    const msg = mergeBlocker([pdfFile(1), { id: 2, fileName: 'notes.docx' }, { id: 3, fileName: 'budget.xlsx' }]);
    expect(msg).toBe('Only PDFs and images can be merged. Take out notes.docx, budget.xlsx.');
  });
  test('pictures that are not JPG or PNG are named', () => {
    expect(mergeBlocker([pdfFile(1), { id: 2, fileName: 'anim.gif', contentType: 'image/gif' }])).toBe('Pictures must be JPG or PNG. Take out anim.gif.');
  });
  test('over 40 MB in all is refused', () => {
    const msg = mergeBlocker([pdfFile(1, 'a.pdf', 25 * 1024 * 1024), pdfFile(2, 'b.pdf', 20 * 1024 * 1024)]);
    expect(msg).toBe('These files add up to 45 MB. Merging is limited to 40 MB in all, so take a file or two out.');
  });
  test('a fine selection has no blocker', () => {
    expect(mergeBlocker([pdfFile(1), { id: 2, fileName: 'photo.jpg' }])).toBeNull();
  });
});

describe('names', () => {
  test('"Merged - <first file>.pdf"', () => {
    expect(mergedFileName('invoice 1042.pdf')).toBe('Merged - invoice 1042.pdf');
    expect(mergedFileName('receipt.JPG')).toBe('Merged - receipt.pdf');
    expect(mergedFileName('')).toBe('Merged - attachments.pdf');
  });
  test('typed names are cleaned and end in .pdf', () => {
    expect(normalisePdfName('  Q3: receipts / all ')).toBe('Q3 receipts all.pdf');
    expect(normalisePdfName('bundle.PDF')).toBe('bundle.pdf');
    expect(normalisePdfName('   ')).toBe('');
    expect(normalisePdfName('.pdf')).toBe('');
  });
  test('page size follows the locale', () => {
    expect(defaultPageSize('en-CA')).toBe('letter');
    expect(defaultPageSize('en-US')).toBe('letter');
    expect(defaultPageSize('en-GB')).toBe('a4');
  });
});

describe('fitImage', () => {
  test('a big landscape photo is shrunk onto a landscape page, centred', () => {
    const fit = fitImage(4000, 3000, PAGE_SIZES.letter);
    expect([fit.pageW, fit.pageH]).toEqual([792, 612]);
    expect(fit.width).toBeLessThanOrEqual(792 - 72);
    expect(fit.height).toBeLessThanOrEqual(612 - 72);
    expect(fit.x).toBeCloseTo((792 - fit.width) / 2);
  });
  test('a small picture is not blown up', () => {
    const fit = fitImage(100, 50, PAGE_SIZES.a4);
    expect([fit.width, fit.height]).toEqual([100, 50]);
  });
});

describe('buildMergedPdf (real pdf-lib, tiny generated files)', () => {
  const run = (items, byId, opts = {}) => buildMergedPdf(items, { fetchBytes: (a) => Promise.resolve(byId[a.id]()), ...opts });

  test('PDFs page by page, pictures a page each, in the given order', async () => {
    const two = await tinyPdf(2, 210);
    const one = await tinyPdf(1, 220);
    const progress = [];
    const { bytes, pageCount } = await run(
      [pdfFile(1), { id: 2, fileName: 'photo.jpg', contentType: 'image/jpeg' }, pdfFile(3), { id: 4, fileName: 'scan.png' }],
      { 1: () => two, 2: tinyJpg, 3: () => one, 4: tinyPng },
      { onProgress: (d, t) => progress.push(`${d}/${t}`), pageSize: 'a4' },
    );
    expect(pageCount).toBe(5);
    expect(progress).toEqual(['1/4', '2/4', '3/4', '4/4']);
    const doc = await PDFDocument.load(bytes);
    const widths = doc.getPages().map((p) => Math.round(p.getWidth()));
    // 2 pages of the first PDF, the landscape JPG on landscape A4, the second PDF, the portrait PNG on A4.
    expect(widths).toEqual([210, 210, 842, 220, 595]);
  });

  test('a password-protected PDF is named and stops the merge', async () => {
    await expect(run([pdfFile(1, 'contract.pdf'), pdfFile(2, 'locked.pdf')], { 1: () => tinyPdf(1), 2: encryptedPdf }))
      .rejects.toThrow('“locked.pdf” is password-protected, so it can\'t be merged.');
  });

  test('a damaged PDF is named', async () => {
    const junk = () => new TextEncoder().encode('this is not a pdf at all').buffer;
    await expect(run([pdfFile(1), pdfFile(2, 'broken.pdf')], { 1: () => tinyPdf(1), 2: junk }))
      .rejects.toThrow('“broken.pdf” looks damaged');
  });

  test('a download failure says which file and why', async () => {
    const items = [pdfFile(1), pdfFile(2, 'gone.pdf')];
    const fetchBytes = (a) => (a.id === 2 ? Promise.reject(Object.assign(new Error('x'), { response: { status: 404 } })) : tinyPdf(1));
    await expect(buildMergedPdf(items, { fetchBytes })).rejects.toThrow('“gone.pdf” could not be downloaded (server error 404)');
  });

  test('files bigger than their listed size still respect the 40 MB limit', async () => {
    const big = () => new ArrayBuffer(MERGE_LIMIT_BYTES / 2 + 10);
    await expect(run([pdfFile(1, 'a.pdf', 10), pdfFile(2, 'b.pdf', 10)], { 1: big, 2: big }))
      .rejects.toThrow('the limit for one merge');
  });
});

import { describe, expect, test } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import {
  MISSING_FILES_NAME, buildAttachmentsZip, compressionLevel, sanitizeFileName, uniqueZipNames, zipFileName,
} from './attachmentZip';

const enc = (s) => new TextEncoder().encode(s);
async function unzipBlob(blob) {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

describe('attachment zip names', () => {
  test('duplicates get " (2)", " (3)" before the extension, case-insensitively', () => {
    expect(uniqueZipNames(['report.pdf', 'Report.pdf', 'report.pdf', 'notes', 'notes']))
      .toEqual(['report.pdf', 'Report (2).pdf', 'report (3).pdf', 'notes', 'notes (2)']);
  });

  test('never hands out missing-files.txt and fills empty names', () => {
    expect(uniqueZipNames([MISSING_FILES_NAME, '', '  '])).toEqual(['missing-files (2).txt', 'attachment-2', 'attachment-3']);
  });

  test('strips characters Windows refuses and path separators', () => {
    expect(sanitizeFileName('a/b\\c:d*e?"f<g>h|i.txt')).toBe('a b c d e f g h i.txt');
    expect(sanitizeFileName('../secret.txt')).toBe('secret.txt');
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt');
  });

  test('zip is named after the ticket ref and subject, capped', () => {
    expect(zipFileName('TP-11375', 'QA TEST - Macros Testing')).toBe('TP-11375 QA TEST - Macros Testing - attachments.zip');
    expect(zipFileName('TP-9', 'Re: printer "jam"? / 3rd floor')).toBe('TP-9 Re printer jam 3rd floor - attachments.zip');
    expect(zipFileName('TP-1', 'x'.repeat(400)).length).toBeLessThanOrEqual(120 + ' - attachments.zip'.length);
    expect(zipFileName('', '')).toBe('attachments.zip');
  });

  test('already-compressed formats are stored, text is deflated', () => {
    expect(compressionLevel('scan.PDF')).toBe(0);
    expect(compressionLevel('budget.xlsx')).toBe(0);
    expect(compressionLevel('photo', 'image/jpeg')).toBe(0);
    expect(compressionLevel('log.txt', 'text/plain')).toBe(6);
    expect(compressionLevel('drawing.bmp', 'image/bmp')).toBe(6);
  });
});

describe('buildAttachmentsZip', () => {
  const files = [
    { id: 1, fileName: 'a.txt' }, { id: 2, fileName: 'b.txt' }, { id: 3, fileName: 'c.txt' },
    { id: 4, fileName: 'd.txt' }, { id: 5, fileName: 'e.txt' },
  ];

  test('fetches at most three at a time and reports progress', async () => {
    let inFlight = 0;
    let peak = 0;
    const progress = [];
    const fetchBytes = async (a) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return enc(`file ${a.id}`).buffer;
    };
    const { blob, included, missing } = await buildAttachmentsZip(files, { fetchBytes, onProgress: (d, t) => progress.push(`${d}/${t}`) });
    expect(peak).toBe(3);
    expect(progress[0]).toBe('0/5');
    expect(progress.at(-1)).toBe('5/5');
    expect(included).toHaveLength(5);
    expect(missing).toEqual([]);
    const out = await unzipBlob(blob);
    expect(Object.keys(out).sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
    expect(strFromU8(out['c.txt'])).toBe('file 3');
  });

  test('nothing fetched means no zip', async () => {
    const res = await buildAttachmentsZip(files.slice(0, 2), { fetchBytes: () => Promise.reject(new Error('offline')) });
    expect(res.blob).toBeNull();
    expect(res.missing.map((m) => m.reason)).toEqual(['offline', 'offline']);
  });

  test('cancel stops the run and rejects with AbortError', async () => {
    const ctrl = new AbortController();
    const fetchBytes = (a, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
      if (a.id === 1) setTimeout(() => ctrl.abort(), 0);
    });
    await expect(buildAttachmentsZip(files, { fetchBytes, signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

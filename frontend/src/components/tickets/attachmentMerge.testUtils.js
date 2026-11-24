import { PDFDocument } from 'pdf-lib';

// Tiny real files for the merge tests, made on the fly (no fixtures, no real data).

export async function tinyPdf(pageCount = 1, width = 200) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([width, 300]);
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
export const tinyPng = () => Uint8Array.from(atob(PNG_1PX), (c) => c.charCodeAt(0)).buffer;

// SOI + a baseline SOF0 header (1200 x 800, 3 channels) + EOI: enough for pdf-lib to embed.
export const tinyJpg = () => new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x04, 0xb0, 0x03,
  0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]).buffer;

export const encryptedPdf = () => new TextEncoder().encode([
  '%PDF-1.4',
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >> endobj',
  '4 0 obj << /Filter /Standard /V 1 /R 2 /O (owner) /U (user) /P -4 >> endobj',
  'trailer << /Root 1 0 R /Size 5 /Encrypt 4 0 R >>',
  '%%EOF',
].join('\n')).buffer;

/**
 * pdf.js entry for the attachment preview. Only ever reached through a
 * dynamic import (PdfViewer), so pdf.js and its worker stay out of the main
 * bundle and load the first time someone opens a PDF.
 */
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Open a PDF from bytes. The bytes are transferred to the worker (pass a copy). */
export function openPdf(bytes) {
  return getDocument({
    data: bytes,
    isEvalSupported: false, // no font-program eval for attachments from strangers
    enableXfa: false,
  });
}

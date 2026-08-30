import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, File as FileIcon, Loader2, Maximize2, Minus, Plus, X } from 'lucide-react';
import DOMPurify from 'dompurify';
import { ticketsAPI } from '../../services/api';
import { formatBytes } from './ticketUi';

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const ZOOM_STEP = 0.35;
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024; // beyond this, offer download only
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const ext = (name) => {
  const idx = String(name || '').lastIndexOf('.');
  return idx >= 0 ? String(name).slice(idx + 1).toLowerCase() : '';
};

const TEXT_EXTENSIONS = new Set(['txt', 'log', 'md', 'json', 'xml', 'yml', 'yaml', 'ini', 'conf', 'ics', 'sql', 'py', 'ts', 'tsx', 'jsx', 'css', 'html', 'htm', 'sh', 'eml']);
const SHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'csv', 'tsv', 'ods']);

/**
 * Preview kind for an attachment (QA 07-08: preview common types, not just
 * images). 'none' renders the download card.
 */
export function previewKind(a) {
  const type = String(a?.contentType || a?.mimeType || '').toLowerCase();
  const e = ext(a?.fileName);
  if (/^image\//.test(type) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'avif'].includes(e)) return 'image';
  if (type === 'application/pdf' || e === 'pdf') return 'pdf';
  if (/^audio\//.test(type) || ['mp3', 'wav', 'm4a', 'ogg'].includes(e)) return 'audio';
  if (/^video\//.test(type) || ['mp4', 'webm', 'mov'].includes(e)) return 'video';
  if (e === 'docx') return 'docx';
  if (SHEET_EXTENSIONS.has(e)) return 'sheet';
  if (/^text\//.test(type) || TEXT_EXTENSIONS.has(e)) return 'text';
  return 'none';
}

/**
 * Universal attachment preview. Images keep the zoom/pan lightbox; PDFs render
 * in the browser's native viewer; Word docs via mammoth and spreadsheets via
 * SheetJS (both lazy-loaded); plain text in a scrollable pane; audio/video in
 * native players. Anything else gets a friendly download card. The download
 * button is always present.
 */
export default function AttachmentPreviewModal({ ticketId, attachment, onClose }) {
  const kind = previewKind(attachment);
  const [url, setUrl] = useState(null);
  const [rich, setRich] = useState(null); // { html } for docx/sheet, { text } for text
  const [error, setError] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);

  useEffect(() => {
    let alive = true;
    let objUrl = null;
    setUrl(null); setRich(null); setError(null);
    if (kind === 'none') return undefined;
    ticketsAPI.attachmentObjectUrl(ticketId, attachment.id)
      .then(async (res) => {
        if (!alive) { URL.revokeObjectURL(res.url); return; }
        objUrl = res.url;
        if (kind === 'text') {
          if ((attachment.sizeBytes || 0) > MAX_TEXT_PREVIEW_BYTES) throw new Error('File is too large to preview — download it instead');
          const text = await (await fetch(res.url)).text();
          if (alive) setRich({ text });
        } else if (kind === 'docx') {
          const [{ default: mammoth }, buf] = await Promise.all([
            import('mammoth/mammoth.browser'),
            fetch(res.url).then((r) => r.arrayBuffer()),
          ]);
          const converted = await mammoth.convertToHtml({ arrayBuffer: buf });
          if (alive) setRich({ html: DOMPurify.sanitize(converted.value) });
        } else if (kind === 'sheet') {
          const [XLSX, buf] = await Promise.all([
            import('xlsx'),
            fetch(res.url).then((r) => r.arrayBuffer()),
          ]);
          const wb = XLSX.read(buf, { type: 'array' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          // Cap huge sheets so the DOM stays responsive.
          const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
          range.e.r = Math.min(range.e.r, 500);
          const html = XLSX.utils.sheet_to_html(sheet, { header: '', footer: '' });
          if (alive) setRich({ html: DOMPurify.sanitize(html), sheetName: wb.SheetNames[0], sheetCount: wb.SheetNames.length });
        }
        if (alive) setUrl(res.url);
      })
      .catch((err) => { if (alive) setError(err.response?.data?.message || err.message || 'Could not load the file'); });
    return () => { alive = false; if (objUrl) setTimeout(() => URL.revokeObjectURL(objUrl), 300); };
  }, [ticketId, attachment.id, attachment.sizeBytes, kind]);

  const resetView = useCallback(() => { setZoom(1); setOffset({ x: 0, y: 0 }); }, []);
  useEffect(() => { resetView(); }, [attachment.id, resetView]);

  const zoomBy = useCallback((delta) => {
    setZoom((z) => {
      const next = clamp(Number((z + delta).toFixed(2)), MIN_ZOOM, MAX_ZOOM);
      if (next === MIN_ZOOM) setOffset({ x: 0, y: 0 });
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (kind === 'image' && (e.key === '+' || e.key === '=')) zoomBy(ZOOM_STEP);
      else if (kind === 'image' && (e.key === '-' || e.key === '_')) zoomBy(-ZOOM_STEP);
      else if (kind === 'image' && e.key === '0') resetView();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, zoomBy, resetView, kind]);

  const onWheel = (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  };
  const onPointerDown = (e) => {
    if (zoom <= 1) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: offset.x, oy: offset.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!dragRef.current) return;
    setOffset({
      x: dragRef.current.ox + (e.clientX - dragRef.current.startX),
      y: dragRef.current.oy + (e.clientY - dragRef.current.startY),
    });
  };
  const onPointerUp = () => { dragRef.current = null; };

  const zoomed = zoom > 1;
  const wide = kind === 'pdf' || kind === 'docx' || kind === 'sheet' || kind === 'text';
  const download = () => ticketsAPI.downloadAttachment(ticketId, attachment.id, attachment.fileName);
  const ready = kind === 'none' || Boolean(error) || (url && (kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video' || rich));

  const body = () => {
    if (kind === 'none' || error) {
      return (
        <div className="flex flex-col items-center gap-3 py-10 px-8 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
            <FileIcon className="w-8 h-8 text-muted-foreground/75" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">{attachment.fileName}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {error || 'No inline preview for this file type yet'}
              {attachment.sizeBytes ? ` · ${formatBytes(attachment.sizeBytes)}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={download}
            className="tp-focus-ring inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-subtle hover:bg-blue-700"
          >
            <Download className="w-4 h-4" aria-hidden="true" /> Download file
          </button>
        </div>
      );
    }
    if (!ready) return <Loader2 className="w-6 h-6 animate-spin text-muted-foreground/75" aria-hidden="true" />;
    if (kind === 'pdf') {
      return <iframe src={url} title={attachment.fileName} className="h-[78vh] w-[min(92vw,960px)] rounded-lg bg-card shadow-subtle" />;
    }
    if (kind === 'audio') return <audio controls src={url} className="w-[min(80vw,480px)]" aria-label={attachment.fileName} />;
    if (kind === 'video') return <video controls src={url} className="max-h-[74vh] max-w-full rounded-lg shadow-subtle" aria-label={attachment.fileName} />;
    if (kind === 'text') {
      return (
        <pre className="settings-scrollbar h-[72vh] w-[min(92vw,880px)] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-card p-4 text-xs leading-relaxed text-foreground/85 shadow-subtle">
          {rich.text}
        </pre>
      );
    }
    if (kind === 'docx') {
      return (
        <div
          className="tp-doc-preview settings-scrollbar h-[76vh] w-[min(92vw,820px)] overflow-auto rounded-lg px-8 py-6 text-sm leading-relaxed shadow-subtle"
          dangerouslySetInnerHTML={{ __html: rich.html }}
        />
      );
    }
    if (kind === 'sheet') {
      return (
        <div className="flex h-[76vh] w-[min(92vw,960px)] flex-col overflow-hidden rounded-lg bg-card shadow-subtle">
          {rich.sheetCount > 1 && (
            <p className="border-b border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
              Showing sheet “{rich.sheetName}” (1 of {rich.sheetCount}) — download for the full workbook
            </p>
          )}
          <div
            className="tp-sheet-preview settings-scrollbar flex-1 overflow-auto p-2 text-xs text-foreground/85"
            dangerouslySetInnerHTML={{ __html: rich.html }}
          />
        </div>
      );
    }
    // image
    return (
      <img
        src={url}
        alt={attachment.fileName}
        draggable={false}
        onDoubleClick={() => (zoomed ? resetView() : zoomBy(ZOOM_STEP * 3))}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          cursor: zoomed ? (dragRef.current ? 'grabbing' : 'grab') : 'zoom-in',
          transition: dragRef.current ? 'none' : 'transform 0.12s ease-out',
          touchAction: 'none',
        }}
        className="max-w-full max-h-[74vh] rounded-lg shadow-subtle bg-card object-contain select-none"
      />
    );
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-label={`Preview ${attachment.fileName}`}>
      <div className="absolute inset-0 bg-slate-900/70 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <div className={`relative tp-card rounded-2xl shadow-soft ${wide ? 'max-w-5xl' : 'max-w-4xl'} max-h-[92vh] flex flex-col animate-scaleIn`}>
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border/60">
          <span className="min-w-0 text-sm font-semibold text-foreground truncate">
            <FileText className="mr-1.5 inline h-4 w-4 align-[-2px] text-muted-foreground/75" aria-hidden="true" />
            {attachment.fileName}
            {attachment.sizeBytes ? <span className="ml-2 text-xs font-normal text-muted-foreground/75">{formatBytes(attachment.sizeBytes)}</span> : null}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            {kind === 'image' && (
              <div className="flex items-center gap-0.5 mr-1 rounded-lg border border-border bg-muted/50 p-0.5">
                <button
                  type="button"
                  onClick={() => zoomBy(-ZOOM_STEP)}
                  disabled={zoom <= MIN_ZOOM}
                  aria-label="Zoom out"
                  title="Zoom out (−)"
                  className="tp-focus-ring p-1.5 rounded-md text-muted-foreground hover:text-blue-700 dark:hover:text-blue-200 hover:bg-card disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <Minus className="w-4 h-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={resetView}
                  aria-label="Reset zoom"
                  title="Reset (0)"
                  className="tp-focus-ring px-1.5 py-1 rounded-md text-[11px] font-semibold tabular-nums text-muted-foreground hover:text-blue-700 dark:hover:text-blue-200 hover:bg-card min-w-[42px]"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  onClick={() => zoomBy(ZOOM_STEP)}
                  disabled={zoom >= MAX_ZOOM}
                  aria-label="Zoom in"
                  title="Zoom in (+)"
                  className="tp-focus-ring p-1.5 rounded-md text-muted-foreground hover:text-blue-700 dark:hover:text-blue-200 hover:bg-card disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <Plus className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={download}
              title="Download"
              aria-label="Download"
              className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:border-blue-300 dark:hover:border-blue-500/40 hover:text-blue-700 dark:hover:text-blue-200"
            >
              <Download className="w-4 h-4" aria-hidden="true" /> <span className="hidden sm:inline">Download</span>
            </button>
            <button type="button" onClick={onClose} aria-label="Close preview" className="tp-focus-ring p-1.5 rounded-lg text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted">
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div
          className="relative flex-1 overflow-hidden settings-scrollbar bg-muted/70 flex items-center justify-center p-4 min-h-[240px] min-w-[320px]"
          onWheel={kind === 'image' && url ? onWheel : undefined}
        >
          {body()}
          {kind === 'image' && url && !error && (
            <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-slate-900/55 px-2.5 py-1 text-[10px] font-medium text-white/90 dark:bg-slate-950/75 dark:ring-1 dark:ring-white/10">
              <Maximize2 className="w-3 h-3" aria-hidden="true" />
              Scroll or +/− to zoom · double-click to {zoomed ? 'reset' : 'zoom'}{zoomed ? ' · drag to pan' : ''}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

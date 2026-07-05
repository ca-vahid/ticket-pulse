import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, Maximize2, Minus, Plus, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { formatBytes } from './ticketUi';

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const ZOOM_STEP = 0.35;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Lightbox preview for an image attachment. Fetches the (authenticated) blob as
 * an object URL and shows it, with zoom (buttons + scroll wheel + double-click)
 * and drag-to-pan when zoomed in. A download button falls back to saving. Used
 * when clicking an inline "[Image: name]" reference or an image attachment chip.
 */
export default function AttachmentPreviewModal({ ticketId, attachment, onClose }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);

  useEffect(() => {
    let alive = true;
    let objUrl = null;
    setUrl(null); setError(null);
    ticketsAPI.attachmentObjectUrl(ticketId, attachment.id)
      .then((res) => { if (alive) { objUrl = res.url; setUrl(res.url); } else { URL.revokeObjectURL(res.url); } })
      .catch((err) => { if (alive) setError(err.response?.data?.message || err.message || 'Could not load image'); });
    return () => { alive = false; if (objUrl) setTimeout(() => URL.revokeObjectURL(objUrl), 300); };
  }, [ticketId, attachment.id]);

  const resetView = useCallback(() => { setZoom(1); setOffset({ x: 0, y: 0 }); }, []);
  // Reset zoom/pan whenever a different attachment loads.
  useEffect(() => { resetView(); }, [attachment.id, resetView]);

  const zoomBy = useCallback((delta) => {
    setZoom((z) => {
      const next = clamp(Number((z + delta).toFixed(2)), MIN_ZOOM, MAX_ZOOM);
      if (next === MIN_ZOOM) setOffset({ x: 0, y: 0 }); // recenter at 100%
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP);
      else if (e.key === '-' || e.key === '_') zoomBy(-ZOOM_STEP);
      else if (e.key === '0') resetView();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, zoomBy, resetView]);

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

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-label={`Preview ${attachment.fileName}`}>
      <div className="absolute inset-0 bg-slate-900/70 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <div className="relative tp-card rounded-2xl shadow-soft max-w-4xl max-h-[92vh] flex flex-col animate-scaleIn">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-slate-100">
          <span className="min-w-0 text-sm font-semibold text-slate-800 truncate">
            {attachment.fileName}
            {attachment.sizeBytes ? <span className="ml-2 text-xs font-normal text-slate-400">{formatBytes(attachment.sizeBytes)}</span> : null}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <div className="flex items-center gap-0.5 mr-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              <button
                type="button"
                onClick={() => zoomBy(-ZOOM_STEP)}
                disabled={zoom <= MIN_ZOOM}
                aria-label="Zoom out"
                title="Zoom out (−)"
                className="tp-focus-ring p-1.5 rounded-md text-slate-500 hover:text-blue-700 hover:bg-white disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Minus className="w-4 h-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={resetView}
                aria-label="Reset zoom"
                title="Reset (0)"
                className="tp-focus-ring px-1.5 py-1 rounded-md text-[11px] font-semibold tabular-nums text-slate-600 hover:text-blue-700 hover:bg-white min-w-[42px]"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => zoomBy(ZOOM_STEP)}
                disabled={zoom >= MAX_ZOOM}
                aria-label="Zoom in"
                title="Zoom in (+)"
                className="tp-focus-ring p-1.5 rounded-md text-slate-500 hover:text-blue-700 hover:bg-white disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => ticketsAPI.downloadAttachment(ticketId, attachment.id, attachment.fileName)}
              title="Download"
              aria-label="Download"
              className="tp-focus-ring p-1.5 rounded-lg text-slate-400 hover:text-blue-700 hover:bg-blue-50"
            >
              <Download className="w-4 h-4" aria-hidden="true" />
            </button>
            <button type="button" onClick={onClose} aria-label="Close preview" className="tp-focus-ring p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100">
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div
          className="relative flex-1 overflow-hidden settings-scrollbar bg-slate-100/70 flex items-center justify-center p-4 min-h-[240px] min-w-[320px]"
          onWheel={url ? onWheel : undefined}
        >
          {error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : !url ? (
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" aria-hidden="true" />
          ) : (
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
              className="max-w-full max-h-[74vh] rounded-lg shadow-subtle bg-white object-contain select-none"
            />
          )}
          {url && !error && (
            <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-slate-900/55 px-2.5 py-1 text-[10px] font-medium text-white/90">
              <Maximize2 className="w-3 h-3" aria-hidden="true" />
              Scroll or +/− to zoom · double-click to {zoomed ? 'reset' : 'zoom'}{zoomed ? ' · drag to pan' : ''}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

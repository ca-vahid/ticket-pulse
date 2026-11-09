import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, MoveHorizontal, PanelLeftClose, PanelLeftOpen, ZoomIn, ZoomOut } from 'lucide-react';

/**
 * PDF attachment viewer (QA 11-06 #3): pdf.js renders the pages to canvas, so
 * the server's content type no longer matters (FS labels some PDFs
 * application/octet-stream) and there is a per-page thumbnail rail like
 * FreshService's viewer. pdf.js is a lazy chunk (./pdfjsLoader).
 *
 * Pages are laid out from their sizes alone; only the pages near the
 * viewport (and the thumbnails near the rail's viewport) hold a canvas, so a
 * 100-page file stays light. Canvases render at devicePixelRatio for crisp
 * text. If pdf.js can't open the file (password, damage) the browser's own
 * viewer takes over with a short note.
 */

const CSS_UNITS = 96 / 72; // PDF points → CSS pixels at 100 %
const PAD = 16;
const GAP = 12;
const THUMB_W = 96;
const THUMB_CHROME = 28; // button padding + page number line under each thumbnail
const THUMB_GAP = 4;
const RAIL_PAD = 8;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEPS = [0.25, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isTyping = (t) => Boolean(t?.closest?.('input, textarea, select, [contenteditable="true"]'));

/** Index of the last item whose start is at or above `y` (binary search). */
function indexAt(starts, y) {
  let lo = 0;
  let hi = starts.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= y) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** One page (or thumbnail) drawn to a canvas at `scale` CSS px per PDF point. */
function PageCanvas({ doc, pageNumber, scale, maxDpr = 3 }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !doc) return undefined;
    let cancelled = false;
    let task = null;
    doc.getPage(pageNumber)
      .then((page) => {
        if (cancelled) return undefined;
        const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
        const base = page.getViewport({ scale: 1 });
        const capped = Math.min(scale * dpr, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, base.width * base.height)));
        const viewport = page.getViewport({ scale: capped });
        // Render off-screen, then swap: the old bitmap stays up (stretched)
        // while a zoom re-renders, instead of flashing blank.
        const off = document.createElement('canvas');
        off.width = Math.max(1, Math.floor(viewport.width));
        off.height = Math.max(1, Math.floor(viewport.height));
        const ctx = off.getContext?.('2d');
        if (!ctx) return undefined;
        task = page.render({ canvasContext: ctx, viewport });
        return task.promise.then(() => {
          if (cancelled) return;
          canvas.width = off.width;
          canvas.height = off.height;
          canvas.getContext?.('2d')?.drawImage(off, 0, 0);
          off.width = 0; // free the scratch bitmap now
        });
      })
      .catch(() => { /* cancelled render or one bad page — the paper stays blank */ });
    return () => { cancelled = true; task?.cancel?.(); };
  }, [doc, pageNumber, scale, maxDpr]);
  return <canvas ref={ref} className="block h-full w-full" aria-hidden="true" />;
}

function ToolButton({ label, onClick, disabled = false, pressed, className = '', children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={`tp-focus-ring inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground ${pressed ? 'text-primary' : ''} ${className}`}
    >
      {children}
    </button>
  );
}

export default function PdfViewer({ data, fileName, railOpen = true, onToggleRail = null }) {
  const [doc, setDoc] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [failure, setFailure] = useState(null);
  const [fallbackUrl, setFallbackUrl] = useState(null);
  const [sizes, setSizes] = useState([]); // [{ w, h }] in PDF points
  const [zoomMode, setZoomMode] = useState('fit'); // 'fit' | number
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [rail, setRail] = useState({ top: 0, height: 0 });
  const [current, setCurrent] = useState(1);
  const [draft, setDraft] = useState('1');
  const scrollerRef = useRef(null);
  const railRef = useRef(null);
  const programmaticRef = useRef(null);
  const prevLayoutRef = useRef(null);
  const frameRef = useRef(0);
  const numPages = sizes.length;

  // Load the document from the bytes (a copy: pdf.js transfers its input).
  useEffect(() => {
    let alive = true;
    let task = null;
    setStatus('loading'); setDoc(null); setSizes([]); setFailure(null);
    setCurrent(1); setDraft('1'); setZoomMode('fit'); setScrollTop(0);
    import('./pdfjsLoader')
      .then(async ({ openPdf }) => {
        task = openPdf(new Uint8Array(data.slice(0)));
        const pdf = await task.promise;
        const first = await pdf.getPage(1);
        if (!alive) return;
        const vp = first.getViewport({ scale: 1 });
        const base = { w: vp.width, h: vp.height };
        setSizes(Array.from({ length: pdf.numPages }, () => base));
        setDoc(pdf);
        setStatus('ready');
        if (pdf.numPages < 2) return;
        // The rest of the page sizes, in the background; most files are uniform.
        try {
          const rest = await Promise.all(Array.from({ length: pdf.numPages - 1 }, (_, i) => pdf.getPage(i + 2).then((p) => {
            const v = p.getViewport({ scale: 1 });
            return { w: v.width, h: v.height };
          })));
          if (alive && rest.some((s) => s.w !== base.w || s.h !== base.h)) setSizes([base, ...rest]);
        } catch { /* keep the uniform guess */ }
      })
      .catch((err) => {
        if (!alive) return;
        setFailure(err?.name === 'PasswordException' ? 'password' : 'unreadable');
        setStatus('error');
      });
    return () => { alive = false; task?.destroy?.(); };
  }, [data]);

  // Fallback: the browser's own viewer, from a blob typed as a PDF.
  useEffect(() => {
    if (status !== 'error') return undefined;
    const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
    setFallbackUrl(url);
    return () => { URL.revokeObjectURL(url); setFallbackUrl(null); };
  }, [status, data]);

  // Measure the page area (fit-width follows it, e.g. on Maximize).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [status]);

  const maxPageW = useMemo(() => sizes.reduce((m, s) => Math.max(m, s.w), 0) || 612, [sizes]);
  const fitZoom = clamp(((box.width || 800) - 2 * PAD) / (maxPageW * CSS_UNITS), MIN_ZOOM, MAX_ZOOM);
  const zoom = zoomMode === 'fit' ? fitZoom : zoomMode;
  const scale = zoom * CSS_UNITS;

  const layout = useMemo(() => {
    const tops = new Array(sizes.length);
    const heights = new Array(sizes.length);
    const widths = new Array(sizes.length);
    let y = PAD;
    let maxW = 0;
    sizes.forEach((s, i) => {
      widths[i] = s.w * scale;
      heights[i] = s.h * scale;
      tops[i] = y;
      y += heights[i] + GAP;
      maxW = Math.max(maxW, widths[i]);
    });
    return { tops, heights, widths, total: y - GAP + PAD, contentW: maxW + 2 * PAD };
  }, [sizes, scale]);

  const thumbs = useMemo(() => {
    const tops = new Array(sizes.length);
    const heights = new Array(sizes.length);
    let y = RAIL_PAD;
    sizes.forEach((s, i) => {
      heights[i] = Math.round((THUMB_W * s.h) / s.w);
      tops[i] = y;
      y += heights[i] + THUMB_CHROME + THUMB_GAP;
    });
    return { tops, heights, total: y + RAIL_PAD };
  }, [sizes]);

  const pageFromScroll = useCallback((top, height, lay) => {
    if (!lay.tops.length) return 1;
    if (top > 0 && top + height >= lay.total - 4) return lay.tops.length;
    return indexAt(lay.tops, top + (height ? height * 0.35 : 1)) + 1;
  }, []);

  // Zoom / resize / late page sizes: keep the page you were reading in place.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const prev = prevLayoutRef.current;
    prevLayoutRef.current = layout;
    if (!el || !prev || prev === layout || !prev.tops.length || !layout.tops.length) return;
    const i = Math.min(indexAt(prev.tops, el.scrollTop), layout.tops.length - 1);
    const frac = prev.heights[i] ? (el.scrollTop - prev.tops[i]) / prev.heights[i] : 0;
    el.scrollTop = Math.max(0, layout.tops[i] + frac * layout.heights[i]);
    el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
    programmaticRef.current = el.scrollTop;
    setScrollTop(el.scrollTop);
  }, [layout]);

  const onScroll = () => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const el = scrollerRef.current;
      if (!el) return;
      setScrollTop(el.scrollTop);
      if (programmaticRef.current !== null && Math.abs(el.scrollTop - programmaticRef.current) < 2) return;
      programmaticRef.current = null;
      const page = pageFromScroll(el.scrollTop, el.clientHeight, layout);
      setCurrent(page);
      setDraft(String(page));
    });
  };
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const goToPage = useCallback((n) => {
    if (!numPages) return;
    const page = clamp(Math.round(Number(n)) || 1, 1, numPages);
    const el = scrollerRef.current;
    if (el) {
      el.scrollTop = Math.max(0, layout.tops[page - 1] - GAP / 2);
      programmaticRef.current = el.scrollTop;
      setScrollTop(el.scrollTop);
    }
    setCurrent(page);
    setDraft(String(page));
  }, [numPages, layout]);

  const zoomStep = useCallback((dir) => {
    setZoomMode(() => {
      const next = dir > 0
        ? ZOOM_STEPS.find((s) => s > zoom + 0.005) ?? MAX_ZOOM
        : [...ZOOM_STEPS].reverse().find((s) => s < zoom - 0.005) ?? MIN_ZOOM;
      return clamp(next, MIN_ZOOM, MAX_ZOOM);
    });
  }, [zoom]);

  // Keys: PageUp/PageDown and ↑/↓ move a page; Home/End; +/−/0 zoom. ←/→ stay
  // with the modal (previous/next FILE).
  useEffect(() => {
    if (status !== 'ready') return undefined;
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      let handled = true;
      if (e.key === 'PageDown' || e.key === 'ArrowDown') goToPage(current + 1);
      else if (e.key === 'PageUp' || e.key === 'ArrowUp') goToPage(current - 1);
      else if (e.key === 'Home') goToPage(1);
      else if (e.key === 'End') goToPage(numPages);
      else if (e.key === '+' || e.key === '=') zoomStep(1);
      else if (e.key === '-' || e.key === '_') zoomStep(-1);
      else if (e.key === '0') setZoomMode('fit');
      else handled = false;
      if (handled) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [status, current, numPages, goToPage, zoomStep]);

  // Ctrl/⌘ + wheel zooms the pages instead of the whole browser tab.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomStep(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomStep, status]);

  // The rail follows the page you are on.
  useEffect(() => {
    const el = railRef.current;
    if (!el || !thumbs.tops.length) return;
    const top = thumbs.tops[current - 1];
    if (top === undefined) return;
    const slot = thumbs.heights[current - 1] + THUMB_CHROME;
    if (top < el.scrollTop || top + slot > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - (el.clientHeight - slot) / 2);
      setRail({ top: el.scrollTop, height: el.clientHeight });
    }
  }, [current, thumbs, railOpen]);

  const onRailScroll = () => {
    const el = railRef.current;
    if (el) setRail({ top: el.scrollTop, height: el.clientHeight });
  };
  useEffect(() => { onRailScroll(); }, [railOpen, status]);

  // Which pages / thumbnails hold a canvas: one screen above, two below, and
  // always the current page's neighbours.
  const rendered = useMemo(() => {
    const set = new Set();
    if (!numPages) return set;
    const h = box.height || 1000;
    const lo = scrollTop - h;
    const hi = scrollTop + h * 2;
    for (let i = indexAt(layout.tops, Math.max(0, lo)); i < numPages && layout.tops[i] < hi; i += 1) set.add(i);
    for (let i = current - 2; i <= current; i += 1) if (i >= 0 && i < numPages) set.add(i);
    return set;
  }, [numPages, box.height, scrollTop, layout, current]);

  const renderedThumbs = useMemo(() => {
    const set = new Set();
    if (!numPages) return set;
    const h = rail.height || 800;
    for (let i = indexAt(thumbs.tops, Math.max(0, rail.top - h / 2)); i < numPages && thumbs.tops[i] < rail.top + h * 1.5; i += 1) set.add(i);
    return set;
  }, [numPages, rail, thumbs]);

  const commitDraft = () => {
    const n = parseInt(draft, 10);
    if (Number.isFinite(n)) goToPage(n); else setDraft(String(current));
  };

  if (status === 'error') {
    return (
      <div className="flex h-full w-full flex-col bg-card">
        <p role="status" className="border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
          {failure === 'password'
            ? 'This PDF is password-protected, so it opens in the browser’s own viewer.'
            : 'This PDF couldn’t be read by the page viewer (it may be damaged), so it opens in the browser’s own viewer.'}
        </p>
        {fallbackUrl && <iframe src={fallbackUrl} title={fileName} className="min-h-0 w-full flex-1 bg-card" />}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-card" data-testid="pdf-viewer">
      <div role="toolbar" aria-label="PDF controls" className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-2">
        <div className="flex min-w-0 items-center gap-0.5">
          {onToggleRail && (
            <ToolButton
              label={railOpen ? 'Hide page thumbnails' : 'Show page thumbnails'}
              pressed={railOpen}
              onClick={onToggleRail}
              className="mr-1 hidden sm:inline-flex"
            >
              {railOpen ? <PanelLeftClose className="h-4 w-4" aria-hidden="true" /> : <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />}
            </ToolButton>
          )}
          <ToolButton label="Previous page" onClick={() => goToPage(current - 1)} disabled={status !== 'ready' || current <= 1}>
            <ChevronUp className="h-4 w-4" aria-hidden="true" />
          </ToolButton>
          <label className="flex items-center gap-1.5 whitespace-nowrap px-1 text-xs text-muted-foreground">
            <span className="hidden sm:inline">Page</span>
            <input
              type="text"
              inputMode="numeric"
              aria-label="Page number"
              value={draft}
              disabled={status !== 'ready'}
              onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitDraft(); e.currentTarget.select(); }
                else if (e.key === 'Escape') { setDraft(String(current)); }
              }}
              onFocus={(e) => e.currentTarget.select()}
              className="tp-focus-ring h-7 w-10 rounded-md border border-input bg-card text-center text-xs tabular-nums text-foreground"
            />
            <span className="tabular-nums">of {numPages || '…'}</span>
          </label>
          <ToolButton label="Next page" onClick={() => goToPage(current + 1)} disabled={status !== 'ready' || current >= numPages}>
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </ToolButton>
        </div>
        <div className="flex items-center gap-0.5">
          <ToolButton label="Zoom out" onClick={() => zoomStep(-1)} disabled={status !== 'ready' || zoom <= MIN_ZOOM + 0.001}>
            <ZoomOut className="h-4 w-4" aria-hidden="true" />
          </ToolButton>
          <span className="min-w-[2.75rem] text-center text-xs tabular-nums text-muted-foreground" aria-label={`Zoom ${Math.round(zoom * 100)} percent`}>
            {Math.round(zoom * 100)}%
          </span>
          <ToolButton label="Zoom in" onClick={() => zoomStep(1)} disabled={status !== 'ready' || zoom >= MAX_ZOOM - 0.001}>
            <ZoomIn className="h-4 w-4" aria-hidden="true" />
          </ToolButton>
          <ToolButton label="Fit to width" pressed={zoomMode === 'fit'} onClick={() => setZoomMode('fit')} disabled={status !== 'ready'}>
            <MoveHorizontal className="h-4 w-4" aria-hidden="true" />
          </ToolButton>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {railOpen && status === 'ready' && (
          <nav aria-label="Pages" className="hidden w-36 shrink-0 border-r border-border/60 bg-card sm:block">
            <div ref={railRef} onScroll={onRailScroll} data-preview-scroll className="settings-scrollbar h-full overflow-y-auto overscroll-contain">
              <ol className="relative" style={{ height: thumbs.total }}>
                {sizes.map((s, i) => {
                  const isCurrent = i + 1 === current;
                  return (
                    <li key={i} className="absolute inset-x-0 flex justify-center" style={{ top: thumbs.tops[i] }}>
                      <button
                        type="button"
                        onClick={() => goToPage(i + 1)}
                        aria-label={`Page ${i + 1}`}
                        aria-current={isCurrent ? 'page' : undefined}
                        className="tp-focus-ring flex flex-col items-center gap-1 rounded-md px-2 py-1 hover:bg-muted"
                      >
                        <span
                          className={`tp-doc-preview block overflow-hidden rounded-sm ${isCurrent ? 'ring-2 ring-primary' : 'ring-1 ring-border'}`}
                          style={{ width: THUMB_W, height: thumbs.heights[i] }}
                        >
                          {renderedThumbs.has(i) && <PageCanvas doc={doc} pageNumber={i + 1} scale={THUMB_W / s.w} maxDpr={2} />}
                        </span>
                        <span className={`text-[11px] leading-4 tabular-nums ${isCurrent ? 'font-semibold text-primary' : 'text-muted-foreground'}`} aria-hidden="true">
                          {i + 1}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          </nav>
        )}

        <div
          ref={scrollerRef}
          onScroll={onScroll}
          data-preview-scroll
          tabIndex={0}
          role="region"
          aria-label={`${fileName || 'PDF'} pages`}
          className="tp-focus-ring settings-scrollbar relative min-w-0 flex-1 overflow-auto overscroll-contain bg-muted/70"
        >
          {status === 'loading' ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/75" aria-hidden="true" />
              <span className="sr-only">Loading PDF</span>
            </div>
          ) : (
            <div className="relative" style={{ height: layout.total, width: layout.contentW, minWidth: '100%' }}>
              {sizes.map((_, i) => (
                <div
                  key={i}
                  role="img"
                  aria-label={`Page ${i + 1} of ${numPages}`}
                  className="tp-doc-preview absolute left-1/2 overflow-hidden shadow-subtle"
                  style={{ top: layout.tops[i], width: layout.widths[i], height: layout.heights[i], marginLeft: -layout.widths[i] / 2 }}
                >
                  {rendered.has(i) && <PageCanvas doc={doc} pageNumber={i + 1} scale={scale} />}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

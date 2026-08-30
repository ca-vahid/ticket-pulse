import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight, Check, Crop, Loader2, Minus, MousePointer2, Pencil,
  RotateCw, Square, Type, Undo2, X,
} from 'lucide-react';

const MAX_DIM = 6000;       // only downscale genuinely enormous images
const MAX_DISPLAY_W = 980;  // CSS layout cap — the canvas BACKING STORE stays full-res
const MAX_DISPLAY_H = 620;
const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#2563eb', '#7c3aed', '#0f172a', '#ffffff'];
const WIDTHS = [3, 6, 12];

/**
 * Self-contained canvas image editor (no external deps) for marking up a staged
 * screenshot: crop, freehand pen, rectangle, arrow, and text, plus rotate. Undo
 * is snapshot-based (a stack of the working canvas before each committed op).
 *
 * The on-screen canvas keeps a FULL-RESOLUTION backing store (matching the
 * working image) and is only shrunk visually via CSS — so pasted text stays
 * crisp in the preview and nothing is re-rasterised at a lower resolution. On
 * save it composites everything to a fresh File that replaces the staged one.
 */
export default function ImageMarkupModal({ file, onCancel, onSave }) {
  const workingRef = useRef(null);   // offscreen full-resolution canvas (source of truth)
  const displayRef = useRef(null);   // on-screen canvas — backing store == working res
  const cssScaleRef = useRef(1);     // CSS px per working px (layout + pointer mapping only)
  const dragRef = useRef(null);      // in-progress gesture
  const undoStackRef = useRef([]);

  const [tool, setTool] = useState('pen'); // pen | rect | arrow | text | crop
  const [color, setColor] = useState('#ef4444');
  const [width, setWidth] = useState(6);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [cropRect, setCropRect] = useState(null); // working-coord {x,y,w,h}
  const [textPrompt, setTextPrompt] = useState(null); // {x,y,value} working coords
  const [backing, setBacking] = useState({ w: 0, h: 0 }); // canvas backing store (working res)
  const [cssSize, setCssSize] = useState({ w: 0, h: 0 });  // CSS layout size

  // ---- redraw the on-screen canvas (backing store == working res, so 1:1) ----
  const paint = useCallback((preview) => {
    const disp = displayRef.current;
    const work = workingRef.current;
    if (!disp || !work) return;
    const ctx = disp.getContext('2d');
    // Keep the overlay stroke ~2 CSS px thick regardless of zoom.
    const hair = 2 / (cssScaleRef.current || 1);
    ctx.clearRect(0, 0, disp.width, disp.height);
    ctx.drawImage(work, 0, 0);

    if (preview) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const { kind, x0, y0, x1, y1, points } = preview;
      if (kind === 'pen' && points) {
        ctx.beginPath();
        points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
      } else if (kind === 'rect') {
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      } else if (kind === 'arrow') {
        drawArrow(ctx, x0, y0, x1, y1, width);
      }
      ctx.restore();
    }
    if (cropRect) {
      ctx.save();
      ctx.fillStyle = 'rgba(15,23,42,0.45)';
      ctx.fillRect(0, 0, disp.width, disp.height);
      ctx.clearRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      ctx.drawImage(work, cropRect.x, cropRect.y, cropRect.w, cropRect.h, cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = hair;
      ctx.setLineDash([6 * hair, 4 * hair]);
      ctx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      ctx.restore();
    }
  }, [color, width, cropRect]);

  const fitDisplay = useCallback(() => {
    const work = workingRef.current;
    if (!work) return;
    const cssScale = Math.min(MAX_DISPLAY_W / work.width, MAX_DISPLAY_H / work.height, 1);
    cssScaleRef.current = cssScale;
    setBacking({ w: work.width, h: work.height });
    setCssSize({ w: Math.round(work.width * cssScale), h: Math.round(work.height * cssScale) });
    requestAnimationFrame(() => paint());
  }, [paint]);

  // ---- load the image into the working canvas ----
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      const cap = Math.min(1, MAX_DIM / Math.max(w, h));
      w = Math.round(w * cap); h = Math.round(h * cap);
      const work = document.createElement('canvas');
      work.width = w; work.height = h;
      work.getContext('2d').drawImage(img, 0, 0, w, h);
      workingRef.current = work;
      undoStackRef.current = [];
      setCanUndo(false);
      fitDisplay();
      setReady(true);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { setReady(true); URL.revokeObjectURL(url); };
    img.src = url;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  useEffect(() => { paint(); }, [paint, backing]);

  const pushUndo = () => {
    const work = workingRef.current;
    if (!work) return;
    const snap = document.createElement('canvas');
    snap.width = work.width; snap.height = work.height;
    snap.getContext('2d').drawImage(work, 0, 0);
    undoStackRef.current.push(snap);
    if (undoStackRef.current.length > 25) undoStackRef.current.shift();
    setCanUndo(true);
  };

  const undo = () => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    const work = workingRef.current;
    work.width = prev.width; work.height = prev.height;
    work.getContext('2d').drawImage(prev, 0, 0);
    setCanUndo(undoStackRef.current.length > 0);
    setCropRect(null);
    fitDisplay();
  };

  // ---- pointer (CSS px) → working coordinates ----
  const toWork = (e) => {
    const canvas = displayRef.current;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  };

  const onPointerDown = (e) => {
    if (!ready || textPrompt) return;
    displayRef.current.setPointerCapture?.(e.pointerId);
    const p = toWork(e);
    if (tool === 'text') { setTextPrompt({ x: p.x, y: p.y, value: '' }); return; }
    dragRef.current = tool === 'pen'
      ? { kind: 'pen', points: [p] }
      : { kind: tool === 'crop' ? 'crop' : tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    if (tool === 'crop') setCropRect(null);
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const p = toWork(e);
    if (d.kind === 'pen') { d.points.push(p); paint(d); }
    else { d.x1 = p.x; d.y1 = p.y; if (d.kind === 'crop') updateCropPreview(d); else paint(d); }
  };

  const updateCropPreview = (d) => {
    const disp = displayRef.current; const work = workingRef.current;
    const x = Math.max(0, Math.min(d.x0, d.x1));
    const y = Math.max(0, Math.min(d.y0, d.y1));
    const w = Math.min(work.width - x, Math.abs(d.x1 - d.x0));
    const h = Math.min(work.height - y, Math.abs(d.y1 - d.y0));
    const hair = 2 / (cssScaleRef.current || 1);
    const ctx = disp.getContext('2d');
    ctx.clearRect(0, 0, disp.width, disp.height);
    ctx.drawImage(work, 0, 0);
    ctx.save();
    ctx.fillStyle = 'rgba(15,23,42,0.45)';
    ctx.fillRect(0, 0, disp.width, disp.height);
    ctx.clearRect(x, y, w, h);
    ctx.drawImage(work, x, y, w, h, x, y, w, h);
    ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = hair; ctx.setLineDash([6 * hair, 4 * hair]);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  };

  const commitShape = (d) => {
    const ctx = workingRef.current.getContext('2d');
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (d.kind === 'pen') {
      ctx.beginPath();
      d.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    } else if (d.kind === 'rect') {
      ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    } else if (d.kind === 'arrow') {
      drawArrow(ctx, d.x0, d.y0, d.x1, d.y1, width);
    }
    ctx.restore();
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.kind === 'crop') {
      const work = workingRef.current;
      const x = Math.max(0, Math.min(d.x0, d.x1));
      const y = Math.max(0, Math.min(d.y0, d.y1));
      const w = Math.min(work.width - x, Math.abs(d.x1 - d.x0));
      const h = Math.min(work.height - y, Math.abs(d.y1 - d.y0));
      if (w > 8 && h > 8) setCropRect({ x, y, w, h }); else paint();
      return;
    }
    const moved = d.kind === 'pen' ? d.points.length > 1 : (Math.abs(d.x1 - d.x0) > 2 || Math.abs(d.y1 - d.y0) > 2);
    if (moved) { pushUndo(); commitShape(d); }
    paint();
  };

  const applyCrop = () => {
    if (!cropRect) return;
    pushUndo();
    const work = workingRef.current;
    const out = document.createElement('canvas');
    out.width = Math.round(cropRect.w); out.height = Math.round(cropRect.h);
    out.getContext('2d').drawImage(work, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, out.width, out.height);
    workingRef.current = out;
    setCropRect(null);
    fitDisplay();
  };

  const rotate = () => {
    pushUndo();
    const work = workingRef.current;
    const out = document.createElement('canvas');
    out.width = work.height; out.height = work.width;
    const ctx = out.getContext('2d');
    ctx.translate(out.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(work, 0, 0);
    workingRef.current = out;
    setCropRect(null);
    fitDisplay();
  };

  const commitText = () => {
    const t = textPrompt;
    setTextPrompt(null);
    if (!t || !t.value.trim()) return;
    pushUndo();
    const ctx = workingRef.current.getContext('2d');
    const fontPx = Math.max(16, width * 4);
    ctx.save();
    ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.textBaseline = 'top';
    ctx.fillText(t.value, t.x, t.y);
    ctx.restore();
    paint();
  };

  const save = () => {
    const work = workingRef.current;
    if (!work) return;
    setSaving(true);
    const type = /png/i.test(file.type) || !file.type ? 'image/png' : file.type;
    work.toBlob((blob) => {
      if (!blob) { setSaving(false); return; }
      const base = (file.name || 'image').replace(/\.[^.]+$/, '');
      const ext = type === 'image/png' ? 'png' : (type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const edited = new File([blob], `${base}.${ext}`, { type });
      onSave(edited);
    }, type, 0.98); // PNG ignores quality (lossless); JPEG stays near-original
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { if (textPrompt) setTextPrompt(null); else onCancel(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textPrompt]);

  const tools = [
    { key: 'crop', icon: Crop, label: 'Crop' },
    { key: 'pen', icon: Pencil, label: 'Pen' },
    { key: 'rect', icon: Square, label: 'Rectangle' },
    { key: 'arrow', icon: ArrowUpRight, label: 'Arrow' },
    { key: 'text', icon: Type, label: 'Text' },
  ];
  const cssScale = cssScaleRef.current;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-label="Edit image">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-[2px]" onClick={onCancel} aria-hidden="true" />
      <div className="relative tp-card rounded-2xl shadow-soft w-full max-w-5xl max-h-[94vh] flex flex-col animate-scaleIn">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
          <h2 className="text-sm font-bold text-foreground flex items-center gap-2"><Pencil className="w-4 h-4 text-blue-600 dark:text-blue-300" aria-hidden="true" /> Edit image</h2>
          <button onClick={onCancel} aria-label="Close editor" className="tp-focus-ring p-1.5 rounded-lg text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-border/60 bg-muted/30">
          <div className="flex items-center gap-0.5 bg-card rounded-lg border border-border p-0.5">
            {tools.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => { setTool(t.key); if (t.key !== 'crop') setCropRect(null); }}
                aria-pressed={tool === t.key}
                title={t.label}
                className={`tp-focus-ring p-1.5 rounded-md transition-colors ${tool === t.key ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:bg-muted'}`}
              >
                <t.icon className="w-4 h-4" aria-hidden="true" />
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Colour ${c}`}
                className={`tp-focus-ring h-5 w-5 rounded-full border border-black/10 transition-transform dark:border-white/20 ${color === c ? 'ring-2 ring-offset-1 ring-offset-card ring-blue-500 scale-110' : ''}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>

          <div className="flex items-center gap-0.5 bg-card rounded-lg border border-border p-0.5" role="group" aria-label="Stroke width">
            {WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWidth(w)}
                aria-pressed={width === w}
                title={`${w}px`}
                className={`tp-focus-ring px-1.5 py-1 rounded-md ${width === w ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}
              >
                <Minus className="w-4 h-4" style={{ strokeWidth: w / 2 }} aria-hidden="true" />
              </button>
            ))}
          </div>

          <button type="button" onClick={rotate} title="Rotate 90°" className="tp-focus-ring p-1.5 rounded-lg text-muted-foreground bg-card border border-border hover:bg-muted">
            <RotateCw className="w-4 h-4" aria-hidden="true" />
          </button>
          <button type="button" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" className="tp-focus-ring p-1.5 rounded-lg text-muted-foreground bg-card border border-border hover:bg-muted disabled:opacity-40">
            <Undo2 className="w-4 h-4" aria-hidden="true" />
          </button>
          {cropRect && (
            <button type="button" onClick={applyCrop} className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700">
              <Check className="w-3.5 h-3.5" aria-hidden="true" /> Apply crop
            </button>
          )}
        </div>

        {/* Canvas stage */}
        <div className="flex-1 overflow-auto settings-scrollbar bg-muted/70 flex items-center justify-center p-4">
          {!ready ? (
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground/75" aria-hidden="true" />
          ) : (
            <div className="relative" style={{ width: cssSize.w, height: cssSize.h }}>
              <canvas
                ref={displayRef}
                width={backing.w}
                height={backing.h}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                className="rounded-lg shadow-subtle bg-card touch-none"
                style={{ cursor: tool === 'text' ? 'text' : 'crosshair', width: cssSize.w, height: cssSize.h, imageRendering: 'auto' }}
              />
              {textPrompt && (
                <input
                  autoFocus
                  value={textPrompt.value}
                  onChange={(e) => setTextPrompt((t) => ({ ...t, value: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitText(); }}
                  onBlur={commitText}
                  placeholder="Type, then Enter"
                  className="absolute text-sm px-1.5 py-0.5 rounded border-2 border-blue-500 bg-card/95 shadow-soft outline-none"
                  style={{ left: textPrompt.x * cssScale, top: textPrompt.y * cssScale, color, minWidth: 120 }}
                />
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border/60 bg-muted/30">
          <p className="text-[11px] text-muted-foreground/75 flex items-center gap-1"><MousePointer2 className="w-3.5 h-3.5" aria-hidden="true" /> Drag on the image to {tool === 'crop' ? 'select a crop area' : tool === 'text' ? 'place text' : `draw a ${tool}`}.</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onCancel} className="tp-focus-ring px-3 py-2 text-sm font-medium text-muted-foreground bg-card border border-border rounded-lg hover:bg-muted/50">Cancel</button>
            <button type="button" onClick={save} disabled={saving || !ready} className="tp-focus-ring inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-blue-700 disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Check className="w-4 h-4" aria-hidden="true" />}
              Save changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Draw a line with a filled triangular arrowhead at (x1,y1). */
function drawArrow(ctx, x0, y0, x1, y1, w) {
  const head = Math.max(10, w * 2.4);
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const bx = x1 - head * Math.cos(angle);
  const by = y1 - head * Math.sin(angle);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(bx - head * 0.5 * Math.sin(angle), by + head * 0.5 * Math.cos(angle));
  ctx.lineTo(bx + head * 0.5 * Math.sin(angle), by - head * 0.5 * Math.cos(angle));
  ctx.closePath();
  ctx.fill();
}

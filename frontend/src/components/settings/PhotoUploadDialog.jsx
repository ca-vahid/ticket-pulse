import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, RotateCcw, X } from 'lucide-react';

const OUTPUT_PX = 256;
const OUTPUT_QUALITY = 0.86;

/**
 * Reads an image file, centre-crops it to a square and resizes it to a
 * 256 px JPEG data URL — small enough to store beside the Entra photos
 * (which arrive the same way) and to send in a JSON body.
 */
export function fileToSquareJpeg(file, { size = OUTPUT_PX, quality = OUTPUT_QUALITY } = {}) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type || '')) {
      reject(new Error('Choose an image file (JPEG, PNG or WebP).'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image the browser can open.'));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = Math.round((img.width - side) / 2);
        const sy = Math.round((img.height - side) / 2);
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Profile photo dialog (QA 09-22 #7) — shared by the profile page (own photo)
 * and the Members panel (an admin setting someone's photo).
 */
export default function PhotoUploadDialog({ title = 'Profile photo', initialPhotoUrl = null, canRevert = true, busy = false, onSave, onRevert, onClose }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = async (file) => {
    setError(null);
    try {
      setPreview(await fileToSquareJpeg(file));
    } catch (err) {
      setPreview(null);
      setError(err.message);
    }
  };

  const shown = preview || initialPhotoUrl;

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px] animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-labelledby="photo-dialog-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="tp-card w-full max-w-md rounded-2xl p-5 shadow-soft animate-scaleIn">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="photo-dialog-title" className="text-base font-bold text-foreground">{title}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Square, 256 px, saved with the profile. It replaces the directory photo everywhere in Ticket Pulse.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="tp-focus-ring rounded-md p-1 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-5">
          <div className="flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted ring-4 ring-border">
            {shown
              ? <img src={shown} alt="" className="h-full w-full object-cover" />
              : <Camera className="h-8 w-8 text-muted-foreground/60" aria-hidden="true" />}
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="sr-only"
              aria-label="Choose a photo"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ''; }}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
            >
              <Camera className="h-4 w-4" aria-hidden="true" /> {shown ? 'Choose another' : 'Choose a photo'}
            </button>
            {canRevert && initialPhotoUrl && onRevert && (
              <button
                type="button"
                onClick={onRevert}
                disabled={busy}
                className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-60"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Use the directory photo instead
              </button>
            )}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="tp-focus-ring rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            disabled={!preview || busy}
            onClick={() => onSave?.(preview)}
            className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
            Save photo
          </button>
        </div>
      </div>
    </div>
  );
}
